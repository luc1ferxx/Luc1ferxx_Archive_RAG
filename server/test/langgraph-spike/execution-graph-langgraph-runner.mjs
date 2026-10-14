// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langsmith-off.mjs";

import { isDeepStrictEqual } from "node:util";

import {
  BaseCheckpointSaver,
  Command,
  END,
  GraphDrained,
  START,
  StateGraph,
  Annotation,
  RunControl,
  interrupt,
  isGraphDrained,
  isGraphInterrupt,
} from "@langchain/langgraph";

import { getRemainingBudget, releaseBudget, reserveBudget } from "../../rag/agent-budget.js";
import {
  EXECUTION_GRAPH_CHECKPOINT_VERSIONS,
  buildExecutionGraphCheckpointOwner,
  buildExecutionGraphNodeStepId,
  createExecutionGraphCheckpoint,
  digestExecutionGraphTypedOutput,
  sealExecutionGraphCheckpoint,
  snapshotExecutionGraphNodeRun,
  updateExecutionGraphCheckpoint,
} from "../../rag/agent-execution-graph-checkpoint.js";
import {
  EXECUTION_GRAPH_BINDING_SOURCES,
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_VERSIONS,
  compileExecutionGraph,
  validateExecutionGraph,
} from "../../rag/agent-execution-graph.js";
import {
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_RUN_STATUSES,
  EXECUTION_GRAPH_SKIP_REASONS,
} from "../../rag/agent-execution-graph-runner.js";
import { isAgentRunInterrupt } from "../../rag/agent-interrupts.js";
import { serializeAgentError as serializeError } from "../../rag/agent-response-builder.js";
import { createAgentRunStepLifecycle } from "../../rag/agent-run-step-lifecycle.js";
import { runLifecycleStep } from "../../rag/agent-step-lifecycle-runner.js";
import {
  assessUnifiedGraphAdmission,
  assessUnifiedGraphNodeApproval,
} from "../../rag/agent-unified-graph-admission.js";
import { assessUnifiedGraphRecoveryEligibility } from "../../rag/agent-unified-graph-recovery-eligibility.js";
import { collectUnifiedGraphResults } from "../../rag/agent-unified-graph-results.js";
import { listUnifiedGraphNodesThatCannotRun } from "../../rag/agent-unified-graph-stage.js";
import { buildCapabilityArtifactIdempotencyKey } from "../../rag/capabilities/artifacts.js";
import {
  resolveAgentRunTermination,
  toDependencyOutageError,
} from "../../rag/dependency-outage.js";
import {
  getRequestSignal,
  isRequestCancelledError,
  throwIfRequestCancelled,
} from "../../rag/request-deadline.js";
import { hasConsistentDocumentRagGraphResult } from "../../rag/skills/document-rag-graph-result.js";
import { AGENT_SKILL_IDS, buildFailedSkillResult } from "../../rag/skills/registry.js";
import {
  EXECUTION_REQUEST_FIELD_TYPES,
  createSkillInputContractError,
  createSkillOutputContractError,
  describeSkillReplayContract,
  getSkillContract,
  validateSkillValues,
} from "../../rag/skills/skill-contract.js";

// Phase-0 spike: run a validated v3 ExecutionGraph on LangGraph.js while the
// runtime keeps every guarantee rag/agent-execution-graph-runner.js gives.
//
// LangGraph only schedules. It owns the superstep order, join barriers and the
// thread checkpoint that says which node returned a receipt. Everything the
// native runner owns stays here, in this process: budget reservation, the
// concurrency cap and side-effect serialization, the fenced step lifecycle,
// the typed-output bindings and the private v2 graph checkpoint in the agent
// run store. That checkpoint stays the authority: a node's typed output lives
// there (never in LangGraph state), a node already completed there is never
// executed again, and every resume rebuilds bindings from it, fail closed.
//
// LangGraph state therefore holds ids, statuses, skip reasons and digests
// (typed outputs, an approval gate's bound input) only. Anything LangGraph
// persists (channel values, interrupt values, resume values, the message of
// an error a node throws) can be read by whoever reads the thread checkpoint,
// so document text, answers, citations, prompts, approval input and client
// resume values never reach it.

const noop = () => {};

export const LANGGRAPH_RUNNER_CANCELLATION_MODES = Object.freeze({
  // Request cancellation becomes RunControl.requestDrain(): the superstep in
  // flight finishes and is checkpointed, no further superstep starts.
  drain: "drain",
  // Request cancellation is handed to LangGraph as its AbortSignal: invoke
  // rejects at once and the in-flight node's LangGraph writes are discarded.
  signal: "signal",
});

export const LANGGRAPH_RUNNER_ERROR_CODES = Object.freeze({
  approvalAlreadyUsed: "graph_approval_already_used",
  approvalMissing: "graph_approval_missing",
  approvalNotRequired: "graph_approval_not_required",
  approvalStale: "graph_approval_stale",
  approvalUnavailable: "AGENT_UNIFIED_GRAPH_APPROVAL_UNAVAILABLE",
  invalidApprovalDecision: "graph_approval_invalid_decision",
  preflightGrantRefused: "graph_preflight_grant_refused",
  invalidInterruptPayload: "LANGGRAPH_INTERRUPT_PAYLOAD_INVALID",
  invalidRuntime: "AGENT_LANGGRAPH_RUNTIME_INVALID",
  nodeNameUnsupported: "AGENT_LANGGRAPH_NODE_NAME_UNSUPPORTED",
  nodeStopped: "AGENT_LANGGRAPH_NODE_STOPPED",
  receiptMismatch: "AGENT_LANGGRAPH_RECEIPT_MISMATCH",
  resumeCommandInvalid: "AGENT_LANGGRAPH_RESUME_COMMAND_INVALID",
  threadNotEmpty: "AGENT_LANGGRAPH_THREAD_NOT_EMPTY",
});

// agent-unified-graph-stage.js:56
const CAPABILITY_SKILL_PREFIX = "capability:";

const SETTLED_OK = new Set([
  EXECUTION_GRAPH_NODE_STATUSES.completed,
  EXECUTION_GRAPH_NODE_STATUSES.reused,
]);

// The non-falsy, id-free value every resume hands back to interrupt(), and
// the only resume value LangGraph ever persists (as a __resume__ write). It is
// never read as a decision: falsy values are dropped by LangGraph's
// mapCommand (EmptyInputError), and the decision itself always comes from the
// caller's store through approval.readDecision. A client's own resume value
// is validated and then dropped, so no client text reaches the run row.
const RESUME_MARKER = Object.freeze({ approvalDecisionReady: true });

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const runtimeError = (message, code, { status = 409, preExecution = false, reasonCodes = null } = {}) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  // Mirrors agent-unified-graph-stage.js fail(): only an error raised before
  // the first durable write lets a caller fall back to V1.
  error.preExecution = preExecution;
  if (Array.isArray(reasonCodes)) {
    error.reasonCodes = reasonCodes;
  }
  return error;
};

const requiresRecovery = (message) =>
  runtimeError(message, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");

// --- Copies of private native helpers -------------------------------------
// Each is copied byte-for-byte in behaviour from the native runner; keep them
// in step with the lines named.

// agent-execution-graph-runner.js:79-96 (buildSkillStepOutput)
const buildSkillStepOutput = (result = {}) => {
  const hasOutput =
    result.ok ||
    Boolean(result.text) ||
    Boolean(result.citations?.length) ||
    Boolean(result.abstained);

  return hasOutput
    ? {
        abstained: Boolean(result.abstained),
        citationCount: result.citations?.length ?? 0,
        text: result.text ?? "",
        ...(result.ok
          ? { typedOutputDigest: digestExecutionGraphTypedOutput(result.graphOutput) }
          : {}),
      }
    : null;
};

// agent-execution-graph-runner.js:98-104 (buildSkillStepError)
const buildSkillStepError = (result = {}) =>
  result.ok
    ? null
    : {
        message: serializeError(result.error, "Unable to run custom skill."),
        name: result.error?.name ?? "Error",
      };

// agent-execution-graph-runner.js:106-108
const isQuestionBoundToNodeOutput = (node) =>
  node?.inputBindings?.question?.source === EXECUTION_GRAPH_BINDING_SOURCES.node;

// agent-execution-graph-runner.js:132-150 (resolveNodeInputs)
const resolveNodeInputs = ({ node, nodeOutputs, requestValues }) => {
  const resolved = {};

  for (const [field, binding] of Object.entries(node.inputBindings ?? {})) {
    if (binding.source === "request") {
      if (EXECUTION_REQUEST_FIELD_TYPES[binding.field] !== undefined) {
        resolved[field] = requestValues[binding.field];
      }

      continue;
    }

    if (binding.source === "node") {
      resolved[field] = nodeOutputs.get(binding.nodeId)?.[binding.output];
    }
  }

  return resolved;
};

// agent-execution-graph-runner.js:155-166 (resolveNodeDocIds)
const resolveNodeDocIds = ({ boundDocIds, node }) => {
  const requested = Array.isArray(boundDocIds) ? boundDocIds : [];
  const scoped = node.scope?.docIds;

  if (!Array.isArray(scoped)) {
    return requested;
  }

  const allowed = new Set(scoped);

  return requested.filter((docId) => allowed.has(docId));
};

// agent-execution-graph-runner.js:168-181 (buildNodeRun)
const buildNodeRun = (state) => ({
  citationCount: state.result?.citations?.length ?? 0,
  dependsOn: [...(state.node.dependsOn ?? [])],
  effects: state.contract.effects,
  idempotency: state.contract.idempotency,
  nodeId: state.node.nodeId,
  parallelSafe: state.contract.parallelSafe,
  reason: state.reason,
  result: state.result,
  skillId: state.contract.id,
  skillVersion: state.contract.version,
  status: state.status,
  stepId: state.stepId,
});

// agent-execution-graph-runner.js:192-271 (buildReusableRuns). A matching
// node with an invalid persisted result fails closed rather than running
// again: its effect may already have happened.
const REUSABLE_NODE_RUN_STATUSES = new Set([
  EXECUTION_GRAPH_NODE_STATUSES.completed,
  EXECUTION_GRAPH_NODE_STATUSES.reused,
]);

const invalidCompletedRun = (nodeId) =>
  requiresRecovery(
    `Completed graph node ${nodeId} cannot be safely reused; manual recovery is required.`
  );

const buildReusableRuns = ({ completedNodeRuns, statesByNodeId }) => {
  const reusable = new Map();

  for (const completed of completedNodeRuns) {
    const state = statesByNodeId.get(completed?.nodeId);

    if (!state) {
      continue;
    }

    const result = completed.result;

    if (
      reusable.has(completed.nodeId) ||
      !REUSABLE_NODE_RUN_STATUSES.has(completed.status) ||
      completed.skillId !== state.contract.id ||
      (completed.skillVersion !== undefined &&
        completed.skillVersion !== state.contract.version) ||
      !result?.ok ||
      result.skillId !== state.contract.id ||
      result.skillVersion !== state.contract.version
    ) {
      throw invalidCompletedRun(completed.nodeId);
    }

    const validation = validateSkillValues({
      allowNestedValue: result.graphOutput === undefined,
      output: result.graphOutput ?? result,
      schema: state.contract.outputSchema,
    });

    if (!validation.ok) {
      throw invalidCompletedRun(completed.nodeId);
    }

    if (
      result.graphOutput !== undefined &&
      ["text", "citations", "abstained"].some(
        (field) =>
          Object.hasOwn(validation.output, field) &&
          !isDeepStrictEqual(validation.output[field], result[field])
      )
    ) {
      throw invalidCompletedRun(completed.nodeId);
    }

    if (
      state.contract.id === AGENT_SKILL_IDS.documentRag &&
      !hasConsistentDocumentRagGraphResult(result)
    ) {
      throw invalidCompletedRun(completed.nodeId);
    }

    reusable.set(completed.nodeId, { output: validation.output, result });
  }

  return reusable;
};

// agent-unified-graph-stage.js:100-109 (assertStoredCheckpoint)
const assertStoredCheckpoint = (saved, expected) => {
  if (
    !isRecord(saved) ||
    saved.digest !== expected.digest ||
    saved.sequence !== expected.sequence ||
    saved.version !== EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2
  ) {
    throw runtimeError(
      "Unified graph cannot execute: the graph checkpoint was not durably acknowledged.",
      "AGENT_UNIFIED_GRAPH_CHECKPOINT_UNCONFIRMED"
    );
  }
};

// --- LangGraph-side pieces ---------------------------------------------------

// LangGraph refuses these node names (graph/state.js:350-354), and keys its
// own channels and storage by plain object properties, so a planner-authored
// id that collides with either is refused before any durable write rather
// than renamed: a second naming scheme would be one more mapping recovery has
// to trust.
const RESERVED_NODE_NAMES = new Set([
  START,
  END,
  "receipts",
  "__proto__",
  "constructor",
  "prototype",
]);

const isLangGraphNodeName = (nodeId) =>
  typeof nodeId === "string" &&
  nodeId.length > 0 &&
  !RESERVED_NODE_NAMES.has(nodeId) &&
  !nodeId.startsWith("__") &&
  !/[|:]/.test(nodeId);

// Receipts are keyed by graph nodeId, never by LangGraph task id or Send
// index: recovery reconciles on nodeId-derived step ids
// (agent-execution-graph-checkpoint.js:15-36). A plain own-property merge is
// enough because a node only ever writes its own key.
const mergeReceipts = (current = {}, update = {}) => ({ ...current, ...update });

const ReceiptState = Annotation.Root({
  receipts: Annotation({ default: () => ({}), reducer: mergeReceipts }),
});

const toReceipt = (status, reason = null, outputDigest = null) => ({
  outputDigest,
  reason,
  status,
});

// The native runner's scheduling gates (agent-execution-graph-runner.js:909-927),
// as a FIFO gate: at most `cap` nodes in flight, a node that is not
// parallelSafe starts only when nothing else runs and nothing starts beside
// it, and a ready node that cannot start blocks the ones queued behind it.
// LangGraph starts every task of a superstep at once (pregel/runner.js:136-146),
// and its own maxConcurrency is unsafe below a step's width (see the invoke
// config below), so the cap lives here.
// Exported for the spike's own unit test only.
export const createConcurrencyGate = (cap) => {
  const queue = [];
  let active = 0;
  let exclusiveActive = false;
  let maxActive = 0;

  const pump = () => {
    while (queue.length > 0) {
      const head = queue[0];

      if (active >= cap || exclusiveActive || (head.exclusive && active > 0)) {
        return;
      }

      queue.shift();
      active += 1;
      maxActive = Math.max(maxActive, active);
      exclusiveActive = head.exclusive;
      head.grant();

      if (head.exclusive) {
        return;
      }
    }
  };

  return {
    acquire({ exclusive }) {
      return new Promise((resolve) => {
        let released = false;
        const release = () => {
          if (released) {
            return;
          }
          released = true;
          active -= 1;
          if (exclusive) {
            exclusiveActive = false;
          }
          pump();
        };

        queue.push({ exclusive, grant: () => resolve(release) });
        pump();
      });
    },
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    get waiting() {
      return queue.length;
    },
  };
};

// What LangGraph is allowed to persist for a node that stopped the graph: its
// id and a stable code. The original error stays in this process and is the
// one the caller sees (pregel/runner.js _commit writes {message, name} of the
// thrown error into the thread checkpoint).
const createNodeStoppedError = (nodeId, cause) => {
  const rawCode = typeof cause?.code === "string" ? cause.code : cause?.name;
  const code = /^[A-Za-z0-9_.-]{1,80}$/.test(String(rawCode ?? ""))
    ? String(rawCode)
    : "error";
  const error = new Error(`Graph node ${nodeId} stopped (${code}).`);
  error.name = "GraphNodeStopped";
  error.code = LANGGRAPH_RUNNER_ERROR_CODES.nodeStopped;
  return error;
};

const isAbortLike = (error) =>
  error?.name === "AbortError" || error?.message === "Abort";

// The interrupt value is persisted as an __interrupt__ write and returned to
// the caller; only a flat record of ids and scalars may cross it.
const assertPublicInterruptPayload = (payload) => {
  if (
    !isRecord(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype ||
    Object.values(payload).some(
      (value) => value !== null && !["string", "number", "boolean"].includes(typeof value)
    )
  ) {
    throw runtimeError(
      "An approval interrupt payload must be a flat record of ids and scalars.",
      LANGGRAPH_RUNNER_ERROR_CODES.invalidInterruptPayload
    );
  }
};

// A caller-built resume (the Command an approval endpoint would hand in) may
// carry a flat resume value and nothing else. It only asks for the
// continuation: the value is never handed to LangGraph (the driver resumes
// with RESUME_MARKER), so no client string is persisted as a __resume__
// write, and the decision is still read from the caller's store. `update` and
// `goto` are refused because they write channels and route tasks directly
// (pregel/io.js mapCommand): an `update` could plant a receipt, and a `goto`
// could start a node out of order.
const isResumeOnlyCommand = (command) => {
  if (!(command instanceof Command)) {
    return false;
  }

  try {
    assertPublicInterruptPayload(command.resume);
  } catch {
    return false;
  }

  return (
    Object.keys(command.resume).length > 0 &&
    command.update === undefined &&
    command.graph === undefined &&
    (command.goto === undefined || (Array.isArray(command.goto) && command.goto.length === 0))
  );
};

// A recorded decision is a record the caller's store holds for the gate the
// thread showed: { decision: "approved" | "denied", gate, capabilityApproval? }.
// Its `gate` must deep-equal that gate, as native binds a decided gate to the
// boundary it was shown under (agent-unified-graph-stage.js:167-176,
// 346-389); a decision on another gate, node or input decides nothing here.
// An absent decision is null; any other shape is refused.
const normalizeDecision = (value, expectedGate) => {
  if (value === null || value === undefined) {
    return { capabilityApproval: null, decision: null };
  }

  if (
    !isRecord(value) ||
    !["approved", "denied"].includes(value.decision) ||
    !isRecord(expectedGate) ||
    !isDeepStrictEqual(value.gate, expectedGate) ||
    (value.capabilityApproval != null && !isRecord(value.capabilityApproval))
  ) {
    throw runtimeError(
      "An approval decision must approve or deny the gate this graph showed.",
      LANGGRAPH_RUNNER_ERROR_CODES.invalidApprovalDecision
    );
  }

  return {
    capabilityApproval:
      value.decision === "approved" ? value.capabilityApproval ?? null : null,
    decision: value.decision,
  };
};

// The gate a parked node shows: the hook's public payload, bound to the node
// and to a digest of the exact input the node would run with, as the native
// approval object hash binds the exact resolved input
// (graph-approval-preflight.js). Only the digest is persisted: the bound
// input carries the question and upstream text, and the gate is an interrupt
// value LangGraph writes into the thread. A resume recomputes it from the
// input bound then, so a changed upstream output or binding cannot reuse a
// decision taken on another input.
const buildApprovalGate = ({ boundInputs, nodeId, publicPayload }) => {
  const gate = {
    ...publicPayload,
    inputDigest: digestExecutionGraphTypedOutput({ boundInputs }),
    nodeId,
  };

  assertPublicInterruptPayload(gate);
  return gate;
};

// agent-execution-graph-runner.js:575-581: only a Capability's preflight may
// hand its node anything (a pause or a rejected input). A custom Skill or a
// built-in that "needs approval" here would run on a grant the graph cannot
// verify. Accepted: nothing (the node may start), { needsApproval: true,
// publicPayload }, or { rejectedInput: Error }; any other shape is refused
// before the node's budget or step exists.
const assertPreflightResult = (result, skill) => {
  if (result === null || result === undefined) {
    return null;
  }

  const refused = () =>
    runtimeError(
      "Only a trusted Capability preflight may provide node runtime grants.",
      LANGGRAPH_RUNNER_ERROR_CODES.preflightGrantRefused
    );

  if (!isRecord(result) || skill?.kind !== "capability") {
    throw refused();
  }

  if (result.needsApproval === true) {
    assertPublicInterruptPayload(result.publicPayload);
    return result;
  }

  if (result.rejectedInput instanceof Error && Object.keys(result).length === 1) {
    return result;
  }

  throw refused();
};

/**
 * Run one validated v3 ExecutionGraph on LangGraph with the native runner's
 * semantics, on the durable path of runUnifiedGraphStage.
 *
 * A fresh call (no v2 graph checkpoint on the run) validates and admits the
 * graph, refuses it whole before any write, then creates and saves the v2
 * checkpoint. A later call for the same run (a resume after a drain, an abort,
 * an approval pause, or in a new process) is a claimed continuation: it must
 * carry the claim agentRunService.claimExecutionGraphResume set on that
 * checkpoint, passes the exported recovery assessor and the pending-node
 * admission the stage applies, and rebuilds every reusable typed output from
 * the checkpoint; LangGraph continues from its own thread checkpoint, and a
 * node the v2 checkpoint already holds as completed is returned from there
 * without running again.
 *
 * Returns { run, checkpoint, collected, interrupted, threadId }. `run` has
 * runExecutionGraph's exact shape so collectUnifiedGraphResults and
 * projectUnifiedGraphRun accept it. A partial run writes phase "partial" and
 * throws AGENT_UNIFIED_GRAPH_PARTIAL like the stage. A refusal carries
 * `preExecution: true` (the stage's V1 fallback flag) only on a fresh call;
 * every refusal of a continuation is AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY.
 *
 * `approval` ({ preflight, readDecision }) is the graph approval seam. It is
 * required whenever the graph holds a Capability node, because a Capability
 * node is never started without its preflight (agent-unified-graph-stage.js
 * preflightNode). `preflight` may answer only for a Capability: nothing (the
 * node may start), { needsApproval: true, publicPayload } (park the node) or
 * { rejectedInput: Error } (fail it, no budget). `readDecision` is consulted
 * only for the node this thread parked, with the gate it showed.
 *
 * `resumeCommand` (optional) is the Command a client handed in to continue an
 * approval pause. Only a resume-only Command with a flat scalar value is
 * accepted, only for a thread that holds exactly one pending interrupt, and it
 * is refused before any write otherwise. Its value is never persisted and
 * never authorizes the node: LangGraph is resumed with the runner's marker.
 *
 * `drainThroughRunControl` (default true) is a spike test seam: false leaves
 * the node-entry safe point as the only drain stop, so each of the two stop
 * mechanisms can be pinned on its own.
 */
export const runExecutionGraphOnLangGraph = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  agentRunId,
  agentRunService,
  approval = null,
  authorizedDocIds,
  authorizedSkillIds = null,
  budgetState,
  buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result?.skillId,
    skillVersion: result?.skillVersion,
    ...detail,
  }),
  cancellation = LANGGRAPH_RUNNER_CANCELLATION_MODES.drain,
  capabilityApprovals = {},
  capabilityRegistry,
  checkpointer,
  docIds = [],
  drainThroughRunControl = true,
  executeObservedSkill,
  graph: proposedGraph,
  graphResumeClaimId = null,
  limits = EXECUTION_GRAPH_LIMITS,
  // A continuation's live operator allowlist of Capability ids (null on a
  // fresh request, as for the stage).
  liveAllowedCapabilityIds = null,
  maxConcurrency,
  onNodeEnter = null,
  onNodeEvent = null,
  plan,
  question,
  ragService,
  recordExecutionGraph = noop,
  recordSkillResult = noop,
  recordSkippedSkill = noop,
  registry,
  resumeCommand = null,
  retrievalPlan,
  runCursor = null,
  selectedSkills = [],
  services,
  sessionId,
  taskMemory = null,
  threadId,
  userId,
} = {}) => {
  if (
    !agentRunId ||
    typeof agentRunService?.getExecutionGraphCheckpoint !== "function" ||
    typeof agentRunService?.getRun !== "function" ||
    typeof agentRunService?.saveExecutionGraphCheckpoint !== "function" ||
    typeof agentRunService?.recordRunStep !== "function" ||
    typeof executeObservedSkill !== "function" ||
    !(checkpointer instanceof BaseCheckpointSaver) ||
    typeof threadId !== "string" ||
    threadId.trim() === "" ||
    !Object.values(LANGGRAPH_RUNNER_CANCELLATION_MODES).includes(cancellation) ||
    !isRecord(budgetState?.limits) ||
    !isRecord(budgetState?.used) ||
    typeof registry?.get !== "function" ||
    (approval !== null &&
      (typeof approval?.preflight !== "function" || typeof approval?.readDecision !== "function"))
  ) {
    throw runtimeError(
      "LangGraph execution requires a durable run, an observed executor, a checkpointer, a thread id, and a runtime-owned budget.",
      LANGGRAPH_RUNNER_ERROR_CODES.invalidRuntime,
      { preExecution: true }
    );
  }

  const refuseResumeCommand = (message) =>
    runtimeError(message, LANGGRAPH_RUNNER_ERROR_CODES.resumeCommandInvalid);

  if (resumeCommand !== null && !isResumeOnlyCommand(resumeCommand)) {
    throw refuseResumeCommand(
      "A resume must be a Command carrying only a flat resume value."
    );
  }

  const effectiveLimits = { ...EXECUTION_GRAPH_LIMITS, ...limits };
  const scopedDocIds = authorizedDocIds ?? docIds;
  const authorized = new Set(Array.isArray(scopedDocIds) ? scopedDocIds : []);
  const authorizedSkills = Array.isArray(selectedSkills) ? selectedSkills : [];
  const skillIds = Array.isArray(authorizedSkillIds)
    ? authorizedSkillIds
    : authorizedSkills.map((skill) => skill.id);

  // Read before any refusal: whether this call continues a sealed graph
  // decides what a refusal means. Only a refusal before the first durable
  // write may hand the request back to V1 (the stage's fail() and
  // agent-unified-graph-run.js's preExecution fallback); a run that already
  // has a v2 checkpoint, and maybe completed nodes, is an operator's call.
  const threadConfig = { configurable: { checkpoint_ns: "", thread_id: threadId } };
  const loaded = await agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runCursor,
    runId: agentRunId,
  });
  const stored = loaded?.checkpoint ?? null;
  const existingThread = await checkpointer.getTuple(threadConfig);
  const refuse = (reasonCodes, code = "AGENT_UNIFIED_GRAPH_REJECTED", reason = null) =>
    runtimeError(
      `Unified graph cannot execute: ${reason ?? reasonCodes.join(", ")}.`,
      stored ? "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" : code,
      { preExecution: stored === null, reasonCodes }
    );

  // agent-execution-graph-runner.js:316-333: the concrete request must sit
  // inside the authorized set before anything compiles or runs.
  if (
    !Array.isArray(docIds) ||
    !Array.isArray(scopedDocIds) ||
    docIds.some((docId) => !authorized.has(docId))
  ) {
    throw refuse(["out_of_scope_document"]);
  }

  if (proposedGraph?.version !== EXECUTION_GRAPH_VERSIONS.v3) {
    throw refuse(["invalid_graph_version"]);
  }

  // Checked before the fresh path's first durable write: a resume for a run
  // that never paused has nothing to answer.
  if (resumeCommand !== null && (!stored || !existingThread)) {
    throw refuseResumeCommand("A resume needs a paused graph to continue.");
  }

  let graph;
  let checkpoint;
  let completedNodeRuns = [];

  if (stored) {
    // A continuation must carry the claim claimExecutionGraphResume set on
    // this exact checkpoint (agent-unified-graph-stage.js:292-304). Natively
    // the only unclaimed continuation is the worker an approval decision
    // reopened, proven by the run store's decided gate against the
    // checkpoint's approvalBoundary; the spike persists no graph gate (its
    // decision lives in the caller's store), so it has no such proof and an
    // approval resume is claimed like any other. Without a claim nothing
    // tells this worker that the one before it has stopped.
    if (
      stored.version !== EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2 ||
      stored.graph?.version !== EXECUTION_GRAPH_VERSIONS.v3 ||
      stored.phase !== "running" ||
      stored.finalization !== undefined ||
      typeof graphResumeClaimId !== "string" ||
      graphResumeClaimId === "" ||
      stored.resumeClaim?.claimId !== graphResumeClaimId ||
      !Array.isArray(loaded?.steps)
    ) {
      throw requiresRecovery(
        "Unified graph cannot execute: an existing graph requires a claimed, running v3 recovery boundary."
      );
    }

    // The graph a caller hands back is still only a proposal: it must
    // validate exactly as it did and equal the sealed one.
    const revalidated = validateExecutionGraph({
      authorizedDocIds: scopedDocIds,
      authorizedSkillIds: skillIds,
      graph: proposedGraph,
      limits: effectiveLimits,
      registry,
    });
    if (!revalidated.ok || !isDeepStrictEqual(revalidated.graph, stored.graph)) {
      throw requiresRecovery(
        "Unified graph cannot execute: the proposed graph differs from the checkpoint."
      );
    }

    // agent-unified-graph-stage.js:326-421: the exported recovery assessor on
    // a freshly sealed copy with only the claim removed (the real claim was
    // checked above). It owns the owner check, the receipt reconciliation
    // (unknown in-flight work, a failed node, a completed step without its
    // checkpoint entry), the live registry contracts, the persisted step
    // inputs against the inputs the reused outputs bind, and the budget a
    // resume may restore.
    const resumeRun = await agentRunService.getRun({ accessScope, runId: agentRunId });
    const assessment = assessUnifiedGraphRecoveryEligibility({
      accessScope,
      authorizedDocIds: scopedDocIds,
      authorizedSkills,
      budgetState,
      checkpoint: sealExecutionGraphCheckpoint({ ...stored, resumeClaim: undefined }),
      docIds,
      limits: effectiveLimits,
      plan,
      question,
      registry,
      retrievalPlan,
      run: resumeRun,
      sessionId,
      taskMemory,
      userId,
    });
    if (!assessment.eligible) {
      throw requiresRecovery(`Unified graph cannot execute: ${assessment.reason}.`);
    }

    // agent-unified-graph-stage.js:415-421: a resume can never mint budget.
    for (const [key, used] of Object.entries(assessment.usedBudgetAtResume)) {
      const current = budgetState.used[key] ?? 0;
      if (!Number.isSafeInteger(current) || current < 0) {
        throw requiresRecovery("Unified graph cannot execute: the live budget has an invalid usage count.");
      }
      budgetState.used[key] = Math.max(current, used);
    }

    graph = stored.graph;
    checkpoint = stored;
    completedNodeRuns = stored.nodeRuns.filter((nodeRun) =>
      REUSABLE_NODE_RUN_STATUSES.has(nodeRun.status)
    );

    // agent-unified-graph-stage.js:429-482: a node still to run must be
    // admissible without the approvals the original request carried, and a
    // pending Capability must still be on the operator's live allowlist.
    const settled = new Set(completedNodeRuns.map((nodeRun) => nodeRun.nodeId));
    const cannotRun = listUnifiedGraphNodesThatCannotRun({ completedNodeRuns, graph });
    const pendingNodes = graph.nodes.filter(
      (node) => !settled.has(node.nodeId) && !cannotRun.has(node.nodeId)
    );
    const pendingAdmission = assessUnifiedGraphAdmission({
      accessScope,
      capabilityApprovals,
      capabilityRegistry,
      docIds,
      graph,
      nodeIds: pendingNodes.map((node) => node.nodeId),
      plan,
      registry,
    });
    if (!pendingAdmission.admitted) {
      throw requiresRecovery(
        `Unified graph cannot execute: a pending node is not admissible at recovery (${pendingAdmission.reasonCodes.join(", ")}).`
      );
    }

    if (Array.isArray(liveAllowedCapabilityIds)) {
      const live = new Set(liveAllowedCapabilityIds.map((id) => String(id ?? "").trim()));
      const revoked = pendingNodes
        .map((node) => node.skillId)
        .filter(
          (skillId) =>
            skillId.startsWith(CAPABILITY_SKILL_PREFIX) &&
            !live.has(skillId.slice(CAPABILITY_SKILL_PREFIX.length))
        );
      if (revoked.length > 0) {
        throw requiresRecovery(
          `Unified graph cannot execute: a pending Capability is no longer on the operator allowlist (${revoked.join(", ")}).`
        );
      }
    }
  } else {
    // A LangGraph thread with no v2 checkpoint behind it is someone else's
    // state or a leftover; nothing about it can be trusted to resume.
    if (existingThread) {
      throw runtimeError(
        "Unified graph cannot execute: the LangGraph thread already holds state for a run without a graph checkpoint.",
        LANGGRAPH_RUNNER_ERROR_CODES.threadNotEmpty,
        { preExecution: true }
      );
    }

    // agent-unified-graph-stage.js:493-530: validation, then admission,
    // both before the first durable write, so a refused graph leaves nothing.
    const validation = validateExecutionGraph({
      authorizedDocIds: scopedDocIds,
      authorizedSkillIds: skillIds,
      budgetRemaining: getRemainingBudget(budgetState),
      graph: proposedGraph,
      limits: effectiveLimits,
      registry,
    });
    if (!validation.ok) {
      throw refuse(validation.errors.map((error) => error.code));
    }
    graph = validation.graph;

    const admission = assessUnifiedGraphAdmission({
      accessScope,
      capabilityApprovals,
      capabilityRegistry,
      docIds,
      graph,
      plan,
      registry,
    });
    if (!admission.admitted) {
      throw refuse(admission.reasonCodes, "AGENT_UNIFIED_GRAPH_INADMISSIBLE");
    }
  }

  // A Capability node is never started without its graph preflight: natively
  // the stage always passes preflightNode, which parks a needs_approval
  // Capability at a clean boundary or refuses the graph when no pause exists
  // (agent-unified-graph-stage.js:584-679). Without the hooks such a node
  // would reach enforceCapabilityPolicy inside execute and leave a paused
  // step, which recovery can only hand to an operator.
  if (
    !approval &&
    graph.nodes.some((node) => registry.get(node.skillId)?.kind === "capability")
  ) {
    throw refuse(
      ["capability_without_graph_preflight"],
      LANGGRAPH_RUNNER_ERROR_CODES.approvalUnavailable,
      "a Capability node needs the graph approval preflight"
    );
  }

  const compiled = compileExecutionGraph({
    authorizedDocIds: scopedDocIds,
    authorizedSkillIds: skillIds,
    graph,
    limits: effectiveLimits,
    registry,
  });
  if (!compiled.ok) {
    throw refuse(compiled.errors.map((error) => error.code));
  }

  if (graph.nodes.some((node) => !isLangGraphNodeName(node.nodeId))) {
    throw refuse(
      ["node_name_unsupported"],
      LANGGRAPH_RUNNER_ERROR_CODES.nodeNameUnsupported,
      "a node id cannot be a LangGraph node name"
    );
  }

  const states = graph.nodes.map((node) => {
    const skill = registry.get(node.skillId);

    return {
      contract: getSkillContract(skill),
      node,
      reason: null,
      result: null,
      skill,
      status: EXECUTION_GRAPH_NODE_STATUSES.pending,
      // v3 graph-node identity (agent-execution-graph-runner.js:110-122).
      stepId: buildExecutionGraphNodeStepId({
        checkpointVersion: EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2,
        nodeId: node.nodeId,
      }),
      stepType: "graph_node",
    };
  });
  const statesByNodeId = new Map(states.map((state) => [state.node.nodeId, state]));
  const nodeOutputs = new Map();
  const reusable = buildReusableRuns({ completedNodeRuns, statesByNodeId });

  for (const [nodeId, { output, result }] of reusable) {
    const state = statesByNodeId.get(nodeId);
    state.result = result;
    state.status = EXECUTION_GRAPH_NODE_STATUSES.reused;
    nodeOutputs.set(nodeId, output);
  }

  if (!stored) {
    checkpoint = createExecutionGraphCheckpoint({
      graph,
      owner: buildExecutionGraphCheckpointOwner({
        accessScope,
        budgetState,
        docIds,
        plan,
        question,
        retrievalPlan,
        selectedSkills,
        sessionId,
        taskMemory,
        userId,
      }),
      version: EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2,
    });
    const saved = await agentRunService.saveExecutionGraphCheckpoint({
      accessScope,
      checkpoint,
      runCursor,
      runId: agentRunId,
    });
    assertStoredCheckpoint(saved, checkpoint);
    checkpoint = saved;
  }

  // agent-unified-graph-stage.js:552-569: one serialized save queue, the
  // acknowledged checkpoint is the next CAS input. Parallel nodes settle
  // through it, and a node only returns its receipt to LangGraph after its
  // write resolved.
  let checkpointQueue = Promise.resolve();
  const persistCheckpoint = (patch) => {
    checkpointQueue = checkpointQueue.then(async () => {
      const next = updateExecutionGraphCheckpoint(checkpoint, patch(checkpoint));
      const saved = await agentRunService.saveExecutionGraphCheckpoint({
        accessScope,
        checkpoint: next,
        runCursor,
        runId: agentRunId,
      });
      assertStoredCheckpoint(saved, next);
      checkpoint = saved;
    });
    return checkpointQueue;
  };

  const concurrencyCap = Math.max(
    1,
    Math.min(
      Number.isFinite(maxConcurrency) ? maxConcurrency : effectiveLimits.maxConcurrency,
      effectiveLimits.maxConcurrency
    )
  );
  const gate = createConcurrencyGate(concurrencyCap);
  const requestedDocIds = new Set(docIds);
  const requestValues = {
    docIds,
    question,
    retrievalPlan: retrievalPlan ?? undefined,
  };
  const stepLifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService,
    runCursor,
    runId: agentRunId,
  });

  // agent-execution-graph-runner.js:388-422: the fenced lifecycle. A falsy
  // transition is fatal, never "run anyway": the start fence (no existing step
  // for this node, matching claim) is what keeps a node LangGraph runs a
  // second time from executing twice.
  const persistFencedGraphStep = async (method, step) => {
    const persisted = await stepLifecycle[method]({
      ...step,
      expectedResumeClaimId: graphResumeClaimId,
    });

    if (!persisted) {
      throw runtimeError(
        "Durable graph step transition was not recorded before continuing.",
        "AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE"
      );
    }

    return persisted;
  };
  const graphStepLifecycle = {
    completeStep: (step) => persistFencedGraphStep("completeGraphStep", step),
    failStep: (step) => persistFencedGraphStep("failGraphStep", step),
    pauseStep: (step) => persistFencedGraphStep("pauseGraphStep", step),
    startStep: (step) => persistFencedGraphStep("startGraphStep", step),
  };

  let aborted = false;
  let fatalError = null;
  // Parked nodes the driver re-runs only to settle them as
  // aborted_after_failure (see the end of the driver).
  const abandonedNodeIds = new Set();
  // Nodes the thread holds a pending interrupt for when this call starts,
  // with the gate each one showed (the persisted interrupt value).
  const interruptedNodeIds = new Set();
  const interruptPayloads = new Map();
  // agent-unified-graph-stage.js:647 (`approvedNode = null`): an approved
  // decision admits one execution of its node per invocation.
  const consumedApprovals = new Set();
  const inFlight = new Set();
  const emit = (event) => onNodeEvent?.(event);

  // The safe point of agent-execution-graph-runner.js:553-557. Under drain a
  // cancelled request ends the graph at this boundary as a drain: a
  // GraphDrained thrown by a node leaves no error write and no receipt, so
  // LangGraph runs this node again on resume (pregel/runner.js _commit), and
  // the superstep's other tasks still finish and commit (pregel/runner.js
  // tick keeps a drain as a bubble-up, not a node error).
  const safePoint = () => {
    try {
      throwIfRequestCancelled();
    } catch (error) {
      if (
        cancellation === LANGGRAPH_RUNNER_CANCELLATION_MODES.drain &&
        isRequestCancelledError(error)
      ) {
        throw new GraphDrained(error.reason);
      }
      throw error;
    }
  };

  // The decision the caller's store holds for the gate `expectedGate`. The
  // hook gets everything a production reader binds a decision to (the node,
  // the gate as shown, the input bound now, the latest acknowledged graph
  // checkpoint and the claim); the runner still checks the binding itself.
  const readBoundDecision = async ({ boundInputs = null, expectedGate, nodeId, persistedInput = null }) =>
    normalizeDecision(
      await approval.readDecision({
        boundInputs,
        checkpoint: { digest: checkpoint.digest, sequence: checkpoint.sequence },
        gate: expectedGate,
        graphResumeClaimId,
        nodeId,
        persistedInput,
      }),
      expectedGate
    );

  const recordSkip = ({ budget = null, reason, state }) => {
    // agent-execution-graph-runner.js:452-460
    const result = buildFailedSkillResult(
      state.skill,
      new Error(budget?.reason ?? `Node ${state.node.nodeId} skipped: ${reason}.`)
    );

    state.reason = reason;
    state.status = EXECUTION_GRAPH_NODE_STATUSES.skipped;
    recordSkippedSkill({ budget, phase: "primary", result, skill: state.skill });
    emit({ nodeId: state.node.nodeId, phase: "skip", status: state.status });
    return { receipts: { [state.node.nodeId]: toReceipt(state.status, reason) } };
  };

  // agent-execution-graph-runner.js:439-450: a denied node never ran and
  // never will; no step, no budget, no skipped-skill record.
  const settleDenied = (state) => {
    state.reason = EXECUTION_GRAPH_SKIP_REASONS.approvalDenied;
    state.status = EXECUTION_GRAPH_NODE_STATUSES.skipped;
    emit({ nodeId: state.node.nodeId, phase: "skip", status: state.status });
    return {
      receipts: {
        [state.node.nodeId]: toReceipt(state.status, EXECUTION_GRAPH_SKIP_REASONS.approvalDenied),
      },
    };
  };

  const isFailFast = (nodeId) =>
    statesByNodeId.get(nodeId)?.node.failurePolicy === EXECUTION_GRAPH_FAILURE_POLICIES.failFast;

  const runNode = async (state, receipts) => {
    const { contract, node, skill } = state;
    const { nodeId } = node;

    // (0) Safe point at node entry.
    safePoint();

    // (1) Pure decisions. A node the v2 checkpoint holds as completed is
    // returned from there and never executed again, whatever LangGraph thinks:
    // LangGraph re-runs a node whose writes it lost (an abort, a crash between
    // the run-store write and its putWrites), and this is what keeps that at
    // most once.
    const reused = reusable.get(nodeId);
    if (reused) {
      emit({ nodeId, phase: "settle", status: EXECUTION_GRAPH_NODE_STATUSES.reused });
      return {
        receipts: {
          [nodeId]: toReceipt(
            EXECUTION_GRAPH_NODE_STATUSES.reused,
            null,
            digestExecutionGraphTypedOutput(reused.output)
          ),
        },
      };
    }

    if (
      state.status !== EXECUTION_GRAPH_NODE_STATUSES.pending &&
      state.status !== EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval
    ) {
      throw runtimeError(
        `Graph node ${nodeId} was scheduled after it settled.`,
        LANGGRAPH_RUNNER_ERROR_CODES.receiptMismatch
      );
    }

    const dependencyReceipts = (node.dependsOn ?? []).map((dependencyId) => [
      dependencyId,
      receipts?.[dependencyId],
    ]);

    if (dependencyReceipts.some(([, receipt]) => !isRecord(receipt))) {
      throw runtimeError(
        `Graph node ${nodeId} started before every dependency returned a receipt.`,
        LANGGRAPH_RUNNER_ERROR_CODES.receiptMismatch
      );
    }

    if (
      dependencyReceipts.some(
        ([, receipt]) => receipt.status === EXECUTION_GRAPH_NODE_STATUSES.failed
      )
    ) {
      return recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.dependencyFailed, state });
    }

    if (
      dependencyReceipts.some(
        ([, receipt]) => receipt.status === EXECUTION_GRAPH_NODE_STATUSES.skipped
      )
    ) {
      return recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped, state });
    }

    // Every input this node reads must be the output the run store holds for
    // that dependency. LangGraph's receipt only names a digest; a receipt the
    // v2 checkpoint cannot back is a tampered or divergent thread.
    for (const [dependencyId, receipt] of dependencyReceipts) {
      if (
        !SETTLED_OK.has(receipt.status) ||
        !nodeOutputs.has(dependencyId) ||
        digestExecutionGraphTypedOutput(nodeOutputs.get(dependencyId)) !== receipt.outputDigest
      ) {
        throw requiresRecovery(
          `Graph node ${nodeId} has a dependency receipt the graph checkpoint does not back.`
        );
      }
    }

    // The thread's own failed receipts (an earlier superstep) and this
    // process's flag (a sibling in this superstep) both mean fail_fast fired.
    const abortedByReceipts = Object.entries(receipts ?? {}).some(
      ([receiptNodeId, receipt]) =>
        receipt?.status === EXECUTION_GRAPH_NODE_STATUSES.failed && isFailFast(receiptNodeId)
    );

    if (aborted || abortedByReceipts || abandonedNodeIds.has(nodeId)) {
      return recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure, state });
    }

    const when = node.when;
    if (when && nodeOutputs.get(when.nodeId)?.[when.output] !== when.equals) {
      return recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.conditionNotMet, state });
    }

    // Everything above is synchronous, so the gate sees nodes in the order
    // LangGraph started them (declaration order within a superstep).
    let releaseSlot = await gate.acquire({ exclusive: !contract.parallelSafe });

    try {
      // A node waiting at the gate re-checks what may have changed while it
      // waited, as the native scheduling loop does on every pass: a fatal error
      // launches nothing more, a fail_fast failure skips the rest.
      if (fatalError) {
        throw createNodeStoppedError(nodeId, { code: "graph_stopped" });
      }
      if (aborted) {
        return recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure, state });
      }

      // (0') The safe point again, now that the cap admitted the node. The
      // native runner checks cancellation at launch, which comes after its
      // scheduling gates (agent-execution-graph-runner.js:557, 909-927); the
      // entry check above ran before this node queued, and a sibling in the
      // same superstep may have held the slot while the request was
      // cancelled. A node admitted after the cancellation launches nothing:
      // no preflight, no interrupt, no budget, no step.
      safePoint();

      emit({ nodeId, phase: "start", status: EXECUTION_GRAPH_NODE_STATUSES.running });

      // (2) Inputs, scope and the input schema gate: a copy of launchNode
      // (agent-execution-graph-runner.js:462-540). Pure, so re-running it on
      // a resume is harmless.
      const resolvedInputs = resolveNodeInputs({ node, nodeOutputs, requestValues });
      const boundDocIds = resolvedInputs.docIds ?? docIds;
      const nodeDocIds = resolveNodeDocIds({ boundDocIds, node });
      const scopedDocInput = contract.inputSchema.docIds?.scoped === true;
      const inputErrors = [];

      if (
        scopedDocInput &&
        Array.isArray(boundDocIds) &&
        boundDocIds.some((docId) => !requestedDocIds.has(docId) || !authorized.has(docId))
      ) {
        inputErrors.push("docIds must remain within the authorized request");
      }

      if (
        scopedDocInput &&
        (contract.inputSchema.docIds.required || resolvedInputs.docIds !== undefined) &&
        nodeDocIds.length === 0
      ) {
        inputErrors.push("scoped docIds must contain at least one document");
      }

      const schemaValidation = validateSkillValues({
        allowNestedValue: false,
        output: scopedDocInput && resolvedInputs.docIds !== undefined
          ? { ...resolvedInputs, docIds: nodeDocIds }
          : resolvedInputs,
        schema: contract.inputSchema,
      });
      const inputValidation = inputErrors.length > 0
        ? { errors: [...schemaValidation.errors, ...inputErrors], ok: false, output: null }
        : schemaValidation;
      const nodeQuestion = resolvedInputs.question ?? question;
      const nodeRetrievalPlan = resolvedInputs.retrievalPlan ?? retrievalPlan;
      const { stepId, stepType } = state;
      const persistedInput = {
        boundInputs: resolvedInputs,
        docIds: nodeDocIds,
        nodeId,
        graphVersion: graph.version,
        question: nodeQuestion,
        retrievalPlan: nodeRetrievalPlan,
        sessionId: sessionId ?? null,
        skillId: contract.id,
        skillVersion: contract.version,
        userId: userId ?? null,
        ...(resolvedInputs.priorFindings === undefined
          ? {}
          : { priorFindings: resolvedInputs.priorFindings }),
        ...describeSkillReplayContract(skill),
      };

      let nodeServices = services;
      let capabilityApproval = null;
      // A preflight that refuses the resolved input fails this node like an
      // invalid binding: a failed lifecycle step, no budget, no execution
      // (agent-execution-graph-runner.js:547-550, 597-600).
      let preflightRejection = null;

      if (inputValidation.ok) {
        // agent-unified-graph-stage.js:585-606: at a recovery boundary the
        // request's standing approvals are gone; a node that would need one
        // is refused right before it would start, before its step or budget.
        if (
          stored &&
          assessUnifiedGraphNodeApproval({
            accessScope,
            capabilityApprovals,
            capabilityRegistry,
            docIds,
            skill,
          })
        ) {
          throw requiresRecovery(
            `Unified graph cannot execute: node ${nodeId} needs an approval recovery cannot re-establish.`
          );
        }

        // A deterministic idempotency key per run and node, exactly as the
        // stage's preflight builds it (agent-unified-graph-stage.js:611-622).
        if (skill.kind === "capability") {
          await checkpointQueue;
          nodeServices = {
            artifactExecution: {
              idempotencyKey: buildCapabilityArtifactIdempotencyKey({
                parts: [agentRunId, nodeId, skill.id],
              }),
              sourceRunId: agentRunId,
            },
          };
        }
      }

      // (3)-(5) Approval. The preflight and the decision read are read-only.
      // interrupt() is the first effectful operation, so the re-run LangGraph
      // does on resume repeats only reads. The resume value decides nothing;
      // the decision is read back from the caller's store and must be bound
      // to the gate this thread showed.
      if (approval && inputValidation.ok) {
        const parked = interruptedNodeIds.has(nodeId);
        let parkedDecision = null;

        if (parked) {
          // A denial of the gate the user saw settles the node whatever the
          // live preflight says now: natively a denied gate becomes
          // deniedNodeIds before scheduling, with no preflight at all
          // (agent-unified-graph-stage.js:367-368).
          parkedDecision = await readBoundDecision({
            boundInputs: inputValidation.output,
            expectedGate: interruptPayloads.get(nodeId),
            nodeId,
            persistedInput,
          });

          if (parkedDecision.decision === "denied") {
            return settleDenied(state);
          }
        }

        const gateRequest = assertPreflightResult(
          await approval.preflight({
            boundInputs: inputValidation.output,
            node,
            persistedInput,
            skill,
          }),
          skill
        );

        if (gateRequest?.rejectedInput) {
          // A parked node whose live policy now refuses its input cannot run
          // on the decision taken for it: natively the approved path's
          // re-verification throws the same refusal (graph-approval-preflight
          // verifyCapabilityGraphApproval), fatal for the continuation.
          if (parked) {
            throw gateRequest.rejectedInput;
          }
          preflightRejection = gateRequest.rejectedInput;
        } else if (gateRequest?.needsApproval === true) {
          const approvalGate = buildApprovalGate({
            boundInputs: inputValidation.output,
            nodeId,
            publicPayload: gateRequest.publicPayload,
          });
          state.status = EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval;
          state.awaiting = { boundInputs: inputValidation.output, nodeDocIds, persistedInput };
          // A parked node holds no slot (agent-execution-graph-runner.js:587-595).
          releaseSlot();
          interrupt(approvalGate);

          // Only a resume reaches this line. Take the gate slot back before
          // anything effectful, so the cap still holds, and pass the safe
          // point again: the request may have been cancelled while this node
          // waited for its slot.
          releaseSlot = await gate.acquire({ exclusive: !contract.parallelSafe });
          state.status = EXECUTION_GRAPH_NODE_STATUSES.pending;
          safePoint();

          // The gate recomputed from the input bound now must be the gate the
          // user was shown: same gate id, node and input (native
          // verifyCapabilityGraphApproval recomputes it from the live node
          // and refuses a changed input or binding).
          const shownGate = interruptPayloads.get(nodeId) ?? approvalGate;
          if (!isDeepStrictEqual(approvalGate, shownGate)) {
            throw runtimeError(
              `Graph node ${nodeId} no longer matches the approval gate it showed.`,
              LANGGRAPH_RUNNER_ERROR_CODES.approvalStale
            );
          }

          const { capabilityApproval: granted, decision } =
            parkedDecision ??
            (await readBoundDecision({
              boundInputs: inputValidation.output,
              expectedGate: shownGate,
              nodeId,
              persistedInput,
            }));

          if (decision === null) {
            throw runtimeError(
              `Graph node ${nodeId} resumed without a recorded approval decision.`,
              LANGGRAPH_RUNNER_ERROR_CODES.approvalMissing
            );
          }

          if (decision === "denied") {
            return settleDenied(state);
          }

          if (consumedApprovals.has(nodeId)) {
            throw runtimeError(
              `Graph node ${nodeId} already ran on its approval.`,
              LANGGRAPH_RUNNER_ERROR_CODES.approvalAlreadyUsed
            );
          }
          consumedApprovals.add(nodeId);
          capabilityApproval = granted;
        } else if (parked) {
          // Parked for approval, not denied, and the live preflight no longer
          // asks: it must not run on the strength of an old decision, nor run
          // unapproved; the live preflight disagrees with the gate the user
          // saw (graph-approval-preflight.js:262-266 refuses the same way).
          throw runtimeError(
            `Graph node ${nodeId} was parked for approval, but its live preflight no longer asks for one.`,
            LANGGRAPH_RUNNER_ERROR_CODES.approvalNotRequired
          );
        }
      }

      // (6) Budget (agent-execution-graph-runner.js:606-614).
      const budget = inputValidation.ok && !preflightRejection && contract.budgetKey
        ? reserveBudget(budgetState, contract.budgetKey, 1)
        : null;

      if (budget && !budget.ok) {
        const skipped = recordSkip({
          budget,
          reason: EXECUTION_GRAPH_SKIP_REASONS.budgetExhausted,
          state,
        });
        addBudgetLimitTrace({ reason: budget.reason, tool: skill.label });
        return skipped;
      }

      // (7)-(9) Fenced start, execute and settle the lifecycle step.
      let result;
      try {
        result = await runLifecycleStep({
          buildError: buildSkillStepError,
          buildOutput: buildSkillStepOutput,
          execute: async () => {
            if (!inputValidation.ok || preflightRejection) {
              const invalidResult = buildFailedSkillResult(
                skill,
                preflightRejection ?? createSkillInputContractError(inputValidation.errors)
              );

              // agent-execution-graph-runner.js:623-640: the failure is
              // observed, but never as an executed or budgeted call.
              recordSkippedSkill({
                budget: null,
                phase: "primary",
                result: invalidResult,
                skill,
                status: "failed",
              });

              return invalidResult;
            }

            const observedResult = await executeObservedSkill(
              skill,
              {
                ...resolvedInputs,
                accessScope,
                ...(capabilityApproval ? { approval: capabilityApproval } : {}),
                capabilityRegistry,
                docIds: nodeDocIds,
                priorFindings: resolvedInputs.priorFindings,
                question: nodeQuestion,
                ragService,
                retrievalPlan: nodeRetrievalPlan,
                services: nodeServices,
                sessionId,
                userId,
                ...(isQuestionBoundToNodeOutput(node) ? { memoryWrites: false } : {}),
              },
              {
                budget,
                phase: "primary",
                validateInput: () => inputValidation,
                validateOutput: (output) =>
                  validateSkillValues({ output, schema: contract.outputSchema }),
              }
            );

            if (!observedResult?.ok) {
              return observedResult;
            }

            // agent-execution-graph-runner.js:682-722: the output gate and the
            // typed envelope rebuilt from the normalized result.
            const validation = validateSkillValues({
              allowNestedValue: observedResult.graphOutput === undefined,
              output: observedResult.graphOutput ?? observedResult,
              schema: contract.outputSchema,
            });

            if (!validation.ok) {
              return buildFailedSkillResult(
                skill,
                createSkillOutputContractError(validation.errors)
              );
            }

            observedResult.graphOutput = {
              ...validation.output,
              ...(Object.hasOwn(validation.output, "abstained")
                ? { abstained: observedResult.abstained }
                : {}),
              ...(Object.hasOwn(validation.output, "citations")
                ? { citations: observedResult.citations }
                : {}),
              ...(Object.hasOwn(validation.output, "text")
                ? { text: observedResult.text }
                : {}),
            };

            if (
              contract.id === AGENT_SKILL_IDS.documentRag &&
              !hasConsistentDocumentRagGraphResult(observedResult)
            ) {
              return buildFailedSkillResult(
                skill,
                createSkillOutputContractError([
                  "Document RAG graph evidence does not match its raw result",
                ])
              );
            }

            return observedResult;
          },
          id: stepId,
          input: persistedInput,
          label: skill.label,
          stepLifecycle: graphStepLifecycle,
          type: stepType,
        });
      } catch (error) {
        // agent-execution-graph-runner.js:730-747: only an interrupt hands
        // the reservation back; every other throw keeps it.
        if (isAgentRunInterrupt(error) && contract.budgetKey && budget?.ok) {
          releaseBudget(budgetState, contract.budgetKey, budget.reserved);
        }
        state.status = EXECUTION_GRAPH_NODE_STATUSES.pending;
        throw error;
      }

      // (10) Settle: the native order (agent-execution-graph-runner.js:749-796).
      state.result = result;
      const settledStatus = result.ok
        ? EXECUTION_GRAPH_NODE_STATUSES.completed
        : EXECUTION_GRAPH_NODE_STATUSES.failed;
      recordSkillResult(result);

      if (result.ok) {
        nodeOutputs.set(nodeId, result.graphOutput);
      } else if (node.failurePolicy === EXECUTION_GRAPH_FAILURE_POLICIES.failFast) {
        aborted = true;
      }

      addTraceStep({
        detail: buildSkillTraceDetail(result, {
          dependsOn: [...(node.dependsOn ?? [])],
          graphVersion: graph.version,
          nodeId,
          rationale: node.rationale ?? null,
          skillKind: skill.kind,
          ...(result.traceDetail ?? {}),
        }),
        error: buildSkillStepError(result),
        id: stepId,
        input: persistedInput,
        label: skill.label,
        output: buildSkillStepOutput(result),
        status: result.ok ? "completed" : "failed",
        summary: result.ok
          ? `${skill.label} completed with ${result.citations?.length ?? 0} citation${
              result.citations?.length === 1 ? "" : "s"
            }.`
          : `${skill.label} failed: ${serializeError(
              result.error,
              "Unable to run custom skill."
            )}`,
        type: stepType,
      });

      // The run-store checkpoint settles before LangGraph sees a receipt, so
      // no dependant can read an output the agent run does not hold.
      await persistCheckpoint((current) => ({
        nodeRuns: [
          ...current.nodeRuns.filter((saved) => saved.nodeId !== nodeId),
          snapshotExecutionGraphNodeRun(buildNodeRun({ ...state, status: settledStatus })),
        ],
      }));
      state.status = settledStatus;
      emit({ nodeId, phase: "settle", status: settledStatus });

      // agent-execution-graph-runner.js:803-814: the primary document answer
      // failed on an outage; the graph stops with the outage.
      if (
        !result.ok &&
        contract.id === AGENT_SKILL_IDS.documentRag &&
        (node.dependsOn ?? []).length === 0 &&
        !node.when
      ) {
        const outage = toDependencyOutageError(result.error);

        if (outage) {
          throw outage;
        }
      }

      return {
        receipts: {
          [nodeId]: toReceipt(
            settledStatus,
            null,
            result.ok ? digestExecutionGraphTypedOutput(result.graphOutput) : null
          ),
        },
      };
    } finally {
      releaseSlot();
    }
  };

  const builder = new StateGraph(ReceiptState);

  for (const state of states) {
    const { nodeId } = state.node;

    // No retryPolicy: a retried node would run its effect again before the
    // start fence could tell, and LangGraph's default retry handler retries a
    // RequestCancelledError (pregel/retry.js:6-24).
    builder.addNode(nodeId, async (langGraphState) => {
      // Before anything else, the safe point included: LangGraph scheduled
      // this node. Lets a test tell "never scheduled" (RunControl stopped the
      // loop between supersteps) from "entered and stopped at the safe point".
      onNodeEnter?.({ nodeId });

      const task = runNode(state, langGraphState?.receipts ?? {}).catch((error) => {
        // LangGraph's own control flow passes through untouched.
        if (isGraphInterrupt(error) || isGraphDrained(error)) {
          throw error;
        }

        // A node that refused to start because a sibling already stopped the
        // graph is not a cause of its own.
        if (error?.code === LANGGRAPH_RUNNER_ERROR_CODES.nodeStopped) {
          throw error;
        }

        fatalError ??= error;
        aborted = true;
        throw createNodeStoppedError(nodeId, error);
      });

      inFlight.add(task);
      try {
        return await task;
      } finally {
        inFlight.delete(task);
      }
    });
  }

  const dependants = new Set(graph.nodes.flatMap((node) => node.dependsOn ?? []));

  for (const node of graph.nodes) {
    const dependsOn = node.dependsOn ?? [];

    if (dependsOn.length === 0) {
      builder.addEdge(START, node.nodeId);
    } else if (dependsOn.length === 1) {
      builder.addEdge(dependsOn[0], node.nodeId);
    } else {
      // A join barrier: the node runs once, after every dependency returned
      // a receipt. Skipped dependencies return receipts too, so joins fire.
      builder.addEdge([...dependsOn], node.nodeId);
    }

    if (!dependants.has(node.nodeId)) {
      builder.addEdge(node.nodeId, END);
    }
  }

  const app = builder.compile({ checkpointer });
  const invokeConfig = {
    ...threadConfig,
    durability: "sync",
    // A bound no superstep can exceed (each node is at most one task of a
    // step), never the runtime cap. In LangGraph 1.5.0 a maxConcurrency below
    // a superstep's width loses tasks: at 1 the step ends after its first
    // task and invoke resolves as if finished; above 1, once a task throws,
    // every task not yet started is committed as __no_writes__ and a resume
    // never runs it (pregel/runner.js _executeTasksWithRetry, pregel/retry.js
    // `if (signal?.aborted) break;`; both pinned in
    // langgraph-spike-runner-mechanics.test.mjs). The cap lives in the gate.
    maxConcurrency: graph.nodes.length,
    // Each layer is one superstep; START is one more.
    recursionLimit: Math.max(25, compiled.depth + 10),
  };
  const requestSignal = getRequestSignal();
  let removeAbortListener = noop;

  if (cancellation === LANGGRAPH_RUNNER_CANCELLATION_MODES.drain && drainThroughRunControl) {
    // The primary drain stop: once the request is cancelled LangGraph starts
    // no further superstep (pregel/loop.js tick checks drainRequested after
    // preparing the next tasks), and the superstep in flight still commits.
    // The node safe points are the second, independent stop.
    const control = new RunControl();
    invokeConfig.control = control;

    if (requestSignal) {
      const requestDrain = () =>
        control.requestDrain(requestSignal.reason?.reason ?? "client_cancelled");

      if (requestSignal.aborted) {
        requestDrain();
      } else {
        requestSignal.addEventListener("abort", requestDrain, { once: true });
        removeAbortListener = () => requestSignal.removeEventListener("abort", requestDrain);
      }
    }
  } else if (cancellation === LANGGRAPH_RUNNER_CANCELLATION_MODES.signal && requestSignal) {
    invokeConfig.signal = requestSignal;
  }

  // Where to continue: a fresh thread gets the input, an interrupted one a
  // resume addressed to each pending interrupt id, a stopped one null, and a
  // finished one is only read back (its run-store write may still be due).
  let input = { receipts: {} };
  let finished = null;

  if (existingThread) {
    const snapshot = await app.getState(threadConfig);
    const pendingInterrupts = (snapshot.tasks ?? []).flatMap((task) =>
      (task.interrupts ?? []).map((pending) => {
        interruptedNodeIds.add(task.name);
        // The gate as shown: a decision is bound to this exact value.
        interruptPayloads.set(task.name, pending.value);
        return pending.id;
      })
    );

    // A parked node re-runs from its first line on resume. Without the
    // approval hooks it would never reach its interrupt() and would run on
    // nobody's decision.
    if (pendingInterrupts.length > 0 && !approval) {
      throw runtimeError(
        "A graph paused for approval cannot be resumed without its approval reader.",
        LANGGRAPH_RUNNER_ERROR_CODES.approvalMissing
      );
    }

    // A caller's Command names no interrupt id, so it is unambiguous only
    // with a single pause, which is all a graph ever leaves (one durable
    // approval pause per graph, see the end of the driver).
    if (resumeCommand !== null && pendingInterrupts.length !== 1) {
      throw refuseResumeCommand("A resume needs exactly one pending approval pause.");
    }

    if (pendingInterrupts.length > 0) {
      // Always the runner's own marker, addressed to each pending interrupt
      // id: a client's resumeCommand only asks for the continuation, and its
      // value is never handed to LangGraph, so it is never persisted.
      input = new Command({
        resume: Object.fromEntries(pendingInterrupts.map((id) => [id, RESUME_MARKER])),
      });
    } else if ((snapshot.next ?? []).length > 0) {
      input = null;
    } else {
      finished = snapshot.values;
    }
  }

  const invokeOnce = async (value) => {
    try {
      return await app.invoke(value, invokeConfig);
    } catch (error) {
      // Nothing started may be left running while the caller fails the run:
      // under "signal" LangGraph rejects at once and leaves the node promise
      // detached (pregel/runner.js:131-151).
      await Promise.allSettled([...inFlight]);
      await checkpointQueue.catch(noop);

      const original = fatalError ?? error;

      if (isAgentRunInterrupt(original)) {
        original.executionGraphNodeRuns = states.map(buildNodeRun);
        throw original;
      }

      if (
        isRequestCancelledError(original) ||
        isGraphDrained(original) ||
        isAbortLike(original)
      ) {
        const termination = resolveAgentRunTermination(original);

        if (isRequestCancelledError(termination)) {
          throw termination;
        }
      }

      throw original;
    }
  };

  const isInterrupted = (value) =>
    Array.isArray(value?.__interrupt__) && value.__interrupt__.length > 0;
  const listParkedTasks = async () =>
    ((await app.getState(threadConfig)).tasks ?? []).filter(
      (task) => (task.interrupts ?? []).length > 0
    );

  let output;
  try {
    output = finished ?? (await invokeOnce(input));

    // agent-execution-graph-runner.js:968-976: a graph that already failed a
    // node never asks the user to approve more work in it. Each parked node is
    // re-run once, sees itself abandoned before its interrupt(), and settles
    // as aborted_after_failure.
    if (
      isInterrupted(output) &&
      (aborted || states.some((state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.failed))
    ) {
      for (const task of await listParkedTasks()) {
        abandonedNodeIds.add(task.name);
      }
      output = await invokeOnce(
        new Command({
          resume: Object.fromEntries(output.__interrupt__.map((pending) => [pending.id, RESUME_MARKER])),
        })
      );
    }
  } finally {
    removeAbortListener();
  }

  await checkpointQueue;

  if (isInterrupted(output)) {
    const parked = await listParkedTasks();

    // agent-execution-graph-runner.js:978-985: exactly one durable approval
    // pause per graph.
    if (parked.length !== 1 || parked[0].interrupts.length !== 1) {
      throw runtimeError(
        "An approval-gated graph node has no single durable approval pause.",
        "AGENT_UNIFIED_GRAPH_APPROVAL_UNAVAILABLE"
      );
    }

    const nodeRuns = states.map(buildNodeRun);

    return {
      checkpoint,
      collected: null,
      interrupted: { nodeId: parked[0].name, payload: parked[0].interrupts[0].value },
      run: {
        errors: [],
        graphVersion: graph.version,
        nodeRuns,
        ok: false,
        results: states.filter((state) => state.result).map((state) => state.result),
        status: EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval,
      },
      threadId,
    };
  }

  // Bind the thread's receipts to this process's view and the run store. A
  // node settled by an earlier invocation is either reused from the v2
  // checkpoint or was skipped (skips carry no output and no write); anything
  // else LangGraph claims without the run store behind it fails closed.
  const receipts = isRecord(output?.receipts) ? output.receipts : {};

  // A skip receipt this invocation did not write (an earlier invocation's,
  // read back from the thread) is re-derived from what the run store holds,
  // never taken at its word: a skip carries no output to check, and the
  // thread lives in a run-row key generic run writes do not guard, so a
  // planted condition_not_met or approval_denied would otherwise change the
  // answer. Native recovery re-derives every skip from the reused outputs
  // (agent-unified-graph-stage.js:118-154, agent-execution-graph-runner.js
  // 858-907) and a denial from the run's decided gate. Dependencies come
  // first (compiled.order), so a dependency's skip is already settled here.
  const isEarlierSkipBacked = async (state, receipt) => {
    const dependencies = (state.node.dependsOn ?? []).map((dependencyId) =>
      statesByNodeId.get(dependencyId)
    );
    const status = (dependency) => dependency?.status;

    if (dependencies.some((dependency) => status(dependency) === EXECUTION_GRAPH_NODE_STATUSES.failed)) {
      return receipt.reason === EXECUTION_GRAPH_SKIP_REASONS.dependencyFailed;
    }

    if (dependencies.some((dependency) => status(dependency) === EXECUTION_GRAPH_NODE_STATUSES.skipped)) {
      return receipt.reason === EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped;
    }

    if (!dependencies.every((dependency) => SETTLED_OK.has(status(dependency)))) {
      return false;
    }

    if (receipt.reason === EXECUTION_GRAPH_SKIP_REASONS.conditionNotMet) {
      const when = state.node.when;
      return Boolean(when) &&
        nodeOutputs.has(when.nodeId) &&
        nodeOutputs.get(when.nodeId)?.[when.output] !== when.equals;
    }

    if (receipt.reason === EXECUTION_GRAPH_SKIP_REASONS.approvalDenied && approval) {
      // Only the caller's store can back a denial: it must hold a denied
      // decision on a gate of this very node.
      const recorded = await approval.readDecision({
        boundInputs: null,
        checkpoint: { digest: checkpoint.digest, sequence: checkpoint.sequence },
        gate: null,
        graphResumeClaimId,
        nodeId: state.node.nodeId,
        persistedInput: null,
      });
      return isRecord(recorded) &&
        recorded.decision === "denied" &&
        recorded.gate?.nodeId === state.node.nodeId;
    }

    // aborted_after_failure, budget_exhausted, or anything else: a fact of an
    // earlier invocation this one cannot re-establish.
    return false;
  };

  const bindingOrder = Array.isArray(compiled.order)
    ? compiled.order.map((nodeId) => statesByNodeId.get(nodeId))
    : states;

  for (const state of bindingOrder) {
    const { nodeId } = state.node;
    const receipt = receipts[nodeId];

    if (!isRecord(receipt)) {
      throw runtimeError(
        `Graph node ${nodeId} has no receipt in the LangGraph thread.`,
        LANGGRAPH_RUNNER_ERROR_CODES.receiptMismatch
      );
    }

    if (state.status === EXECUTION_GRAPH_NODE_STATUSES.pending) {
      if (receipt.status !== EXECUTION_GRAPH_NODE_STATUSES.skipped) {
        throw requiresRecovery(
          `Graph node ${nodeId} settled in the LangGraph thread but not in the graph checkpoint.`
        );
      }

      if (receipt.outputDigest != null || !(await isEarlierSkipBacked(state, receipt))) {
        throw requiresRecovery(
          `Graph node ${nodeId} has a LangGraph skip receipt the graph checkpoint does not back.`
        );
      }

      state.status = EXECUTION_GRAPH_NODE_STATUSES.skipped;
      state.reason = receipt.reason;
      continue;
    }

    const expectedDigest = SETTLED_OK.has(state.status)
      ? digestExecutionGraphTypedOutput(nodeOutputs.get(nodeId))
      : null;
    const receiptMatches =
      (SETTLED_OK.has(state.status)
        ? SETTLED_OK.has(receipt.status)
        : receipt.status === state.status) &&
      (receipt.reason ?? null) === (state.reason ?? null) &&
      (receipt.outputDigest ?? null) === expectedDigest;

    if (!receiptMatches) {
      throw requiresRecovery(
        `Graph node ${nodeId} has a LangGraph receipt that disagrees with the graph checkpoint.`
      );
    }
  }

  // agent-execution-graph-runner.js:1007-1054
  const nodeRuns = states.map(buildNodeRun);
  const results = states.filter((state) => state.result).map((state) => state.result);
  const benignTerminal = (state) => {
    if (!state) {
      return false;
    }

    if (SETTLED_OK.has(state.status)) {
      return true;
    }

    if (state.status !== EXECUTION_GRAPH_NODE_STATUSES.skipped) {
      return false;
    }

    if (
      state.reason === EXECUTION_GRAPH_SKIP_REASONS.conditionNotMet ||
      state.reason === EXECUTION_GRAPH_SKIP_REASONS.approvalDenied
    ) {
      return true;
    }

    const dependencies = (state.node.dependsOn ?? []).map((nodeId) =>
      statesByNodeId.get(nodeId)
    );

    return state.reason === EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped &&
      dependencies.some((dependency) =>
        dependency?.status === EXECUTION_GRAPH_NODE_STATUSES.skipped
      ) &&
      dependencies.every(benignTerminal);
  };
  const status = states.every(benignTerminal)
    ? EXECUTION_GRAPH_RUN_STATUSES.completed
    : EXECUTION_GRAPH_RUN_STATUSES.partial;
  const run = {
    errors: [],
    graphVersion: graph.version,
    nodeRuns,
    ok: status === EXECUTION_GRAPH_RUN_STATUSES.completed,
    results,
    status,
  };

  // agent-unified-graph-stage.js:775-802: the final phase write.
  const finalNodeRuns = (current) => [
    ...current.nodeRuns.filter((saved) => !nodeRuns.some((item) => item.nodeId === saved.nodeId)),
    ...nodeRuns.map(snapshotExecutionGraphNodeRun),
  ];

  if (!run.ok) {
    await persistCheckpoint((current) => ({ nodeRuns: finalNodeRuns(current), phase: "partial" }));
    const error = runtimeError(
      "Unified graph cannot execute: one or more graph nodes failed.",
      "AGENT_UNIFIED_GRAPH_PARTIAL"
    );
    error.run = run;
    error.checkpoint = checkpoint;
    throw error;
  }

  const collected = collectUnifiedGraphResults({
    authorizedDocIds: docIds,
    graph,
    registry,
    run,
  });
  await persistCheckpoint((current) => ({ nodeRuns: finalNodeRuns(current), phase: "completed" }));
  // agent-unified-graph-stage.js:803-813: the run's graph observability event
  // (agent-unified-graph-run.js wires it to a run event), same payload.
  await recordExecutionGraph({
    executed: true,
    graph: { version: graph.version, nodeCount: graph.nodes.length },
    mode: "guarded",
    nodeRuns: run.nodeRuns.map(({ result, ...nodeRun }) => ({
      ...nodeRun,
      ok: Boolean(result?.ok),
    })),
    status: run.status,
  });

  return { checkpoint, collected, interrupted: null, run, threadId };
};
