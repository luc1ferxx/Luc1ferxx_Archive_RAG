import { isDeepStrictEqual } from "node:util";

import { releaseBudget, reserveBudget } from "./agent-budget.js";
import {
  EXECUTION_GRAPH_CHECKPOINT_VERSIONS,
  buildExecutionGraphNodeStepId,
  digestExecutionGraphTypedOutput,
} from "./agent-execution-graph-checkpoint.js";
import {
  EXECUTION_GRAPH_BINDING_SOURCES,
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_VERSIONS,
} from "./agent-execution-graph.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { toDependencyOutageError } from "./dependency-outage.js";
import { throwIfRequestCancelled } from "./request-deadline.js";
import { runLifecycleStep } from "./agent-step-lifecycle-runner.js";
import { AGENT_SKILL_IDS, buildFailedSkillResult } from "./skills/registry.js";
import { hasConsistentDocumentRagGraphResult } from "./skills/document-rag-graph-result.js";
import {
  EXECUTION_REQUEST_FIELD_TYPES,
  createSkillInputContractError,
  createSkillOutputContractError,
  describeSkillReplayContract,
  getSkillContract,
  validateSkillValues,
} from "./skills/skill-contract.js";

// What one node of a validated ExecutionGraph does, apart from when it runs.
//
// The scheduler in agent-execution-graph-runner.js decides order, the
// concurrency cap and side-effect exclusivity. Everything a node does once it
// is chosen lives here: which inputs it may read, the input and output gates,
// the safe point, the approval park, the budget reservation, the fenced step
// lifecycle and the settle order (trace, then the durable checkpoint, then the
// status a dependant can see). A second scheduler (LangGraph, behind
// AGENT_RUNTIME) calls these same functions, so the two runtimes cannot drift
// apart on what a node is allowed to do, only on when it does it.
//
// Nothing here keeps state between calls. A run's mutable state is handed in
// explicitly: the node states and the map of validated outputs
// (createExecutionGraphNodeStates), the run-wide inputs and hooks
// (createExecutionGraphNodeContext), and the flags a node raises for its
// scheduler (createExecutionGraphRunControl). The flags are written at the
// same moment a closure variable used to be written, because a scheduler that
// another node wakes in between must already see them.
//
// v1/v2 retain the `custom_skill` lifecycle identity. v3 uses a distinct
// graph-node identity so heterogeneous stages cannot be mistaken for V1
// custom-Skill steps by replay or recovery code.

const noop = () => {};

export const EXECUTION_GRAPH_NODE_STATUSES = Object.freeze({
  // A node whose preflight needs a user decision. It holds no lifecycle step
  // and no budget; its dependants wait, independent nodes keep running.
  awaitingApproval: "awaiting_approval",
  completed: "completed",
  failed: "failed",
  pending: "pending",
  reused: "reused",
  running: "running",
  skipped: "skipped",
});

export const EXECUTION_GRAPH_SKIP_REASONS = Object.freeze({
  abortedAfterFailure: "aborted_after_failure",
  // The user rejected the node's approval gate: it never ran and never will.
  approvalDenied: "approval_denied",
  budgetExhausted: "budget_exhausted",
  conditionNotMet: "condition_not_met",
  dependencyFailed: "dependency_failed",
  dependencySkipped: "dependency_skipped",
});

export const EXECUTION_GRAPH_RUN_STATUSES = Object.freeze({
  completed: "completed",
  partial: "partial",
  rejected: "rejected",
});

// What a scheduler does with a pending node on one pass. `wait` and `hold`
// both leave the node pending; they differ only in why, which a scheduler
// that cannot simply look again on the next pass needs to know.
export const EXECUTION_GRAPH_SCHEDULE_DECISIONS = Object.freeze({
  // Every dependency settled, but a v3 graph has a pending approval interrupt:
  // the node stays a clean pending boundary for the continuation.
  hold: "hold",
  launch: "launch",
  // Settle the node as skipped with the decision's reason.
  skip: "skip",
  // A dependency has not settled yet.
  wait: "wait",
});

// How one launch of a node ended. A launch that throws ends no other way: the
// node is pending again and the error is fatal to the graph, except an outage
// of the primary document answer, which throws after the node settled.
export const EXECUTION_GRAPH_NODE_OUTCOMES = Object.freeze({
  // Parked by its preflight: no step, no budget, no output.
  awaitingApproval: "awaiting_approval",
  // An AgentRunInterruptError from inside the node: the node is pending again,
  // its reservation is back, and the error is on control.interrupt.
  interrupted: "interrupted",
  // Completed or failed, with its step, trace and checkpoint written.
  settled: "settled",
  // Skipped at launch (budget exhausted): no step was opened.
  skipped: "skipped",
});

const SETTLED_OK = new Set([
  EXECUTION_GRAPH_NODE_STATUSES.completed,
  EXECUTION_GRAPH_NODE_STATUSES.reused,
]);

export const isExecutionGraphNodeSettledOk = (status) => SETTLED_OK.has(status);

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

const buildSkillStepError = (result = {}) =>
  result.ok
    ? null
    : {
        message: serializeError(result.error, "Unable to run custom skill."),
        name: result.error?.name ?? "Error",
      };

const isQuestionBoundToNodeOutput = (node) =>
  node?.inputBindings?.question?.source ===
  EXECUTION_GRAPH_BINDING_SOURCES.node;

const graphNodeIdentity = (graph, nodeId) => {
  const heterogeneous = graph.version === EXECUTION_GRAPH_VERSIONS.v3;

  return {
    stepId: buildExecutionGraphNodeStepId({
      checkpointVersion: heterogeneous
        ? EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2
        : EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v1,
      nodeId,
    }),
    stepType: heterogeneous ? "graph_node" : "custom_skill",
  };
};

/**
 * Resolves a node's declared bindings into concrete values.
 *
 * Only two sources exist: validated request fields and structured outputs of
 * nodes this node declared a dependency on. There is no third source, which is
 * what stops the V1 habit of splicing the last few skill answers into the next
 * skill's question string.
 */
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

// A node may narrow the request's document scope but never widen it. The
// caller checks each bound id against the original request before this helper
// intersects the plan's optional narrowing scope.
const resolveNodeDocIds = ({ boundDocIds, node }) => {
  const requested = Array.isArray(boundDocIds) ? boundDocIds : [];
  const scoped = node.scope?.docIds;

  if (!Array.isArray(scoped)) {
    return requested;
  }

  const allowed = new Set(scoped);

  return requested.filter((docId) => allowed.has(docId));
};

/**
 * The persisted shape of one node: what onNodeSettled checkpoints, what an
 * interrupt carries as executionGraphNodeRuns, and what a graph run returns.
 */
export const buildExecutionGraphNodeRun = (state) => ({
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

// A persisted node run is only reusable when it is unambiguously the same work:
// same node, same skill, and a result that actually succeeded. A matching node
// with an invalid persisted result must fail closed, not be executed again:
// its effect may already have happened even if its output can no longer be
// decoded under the current contract.
//
// A run the previous replan already reused counts as finished work too. Taking
// only `completed` forward would mean a second replan re-ran what the first one
// correctly skipped -- wasted budget for a read, a repeated write otherwise.
const REUSABLE_NODE_RUN_STATUSES = new Set([
  EXECUTION_GRAPH_NODE_STATUSES.completed,
  EXECUTION_GRAPH_NODE_STATUSES.reused,
]);

const invalidCompletedRun = (nodeId) => {
  const error = new Error(
    `Completed graph node ${nodeId} cannot be safely reused; manual recovery is required.`
  );
  error.code = "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY";
  error.status = 409;
  return error;
};

/**
 * Validates persisted node runs against the live node states.
 *
 * Returns a Map nodeId -> { output, result } of the runs that may stand in for
 * their node, and throws AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY (409) for a
 * retained node whose run cannot. Runs of node ids the graph no longer has are
 * ignored.
 */
export const buildReusableExecutionGraphRuns = ({ completedNodeRuns, statesByNodeId }) => {
  const reusable = new Map();

  for (const completed of completedNodeRuns) {
    const state = statesByNodeId.get(completed?.nodeId);

    // A bounded replan can retire a node from the next graph. Historical runs
    // for retired node IDs are irrelevant; runs for retained IDs are not.
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

    // Checkpoint data is not an authorization or type boundary. An older run
    // may lack graphOutput, but it must still contain every required field in
    // the live skill's contract before it can feed a dependent node.
    const validation = validateSkillValues({
      allowNestedValue: result.graphOutput === undefined,
      output: result.graphOutput ?? result,
      schema: state.contract.outputSchema,
    });

    if (!validation.ok) {
      throw invalidCompletedRun(completed.nodeId);
    }

    // A stored typed envelope may be structurally valid but disagree with the
    // saved answer/evidence receipt. Never feed the alternative value to a
    // dependent or silently rerun the node that already produced an effect.
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

const settleSkip = (state, reason) => {
  state.reason = reason;
  state.status = EXECUTION_GRAPH_NODE_STATUSES.skipped;
};

/**
 * Builds the per-node state of one graph run, in declaration order.
 *
 * Each state is { contract, node, reason, result, skill, status, stepId,
 * stepType } (plus `awaiting` once a preflight parks it). Reusable completed
 * runs become `reused` with their validated output in `nodeOutputs`; denied
 * nodes become `skipped/approval_denied`. Throws
 * AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY for a run that cannot be reused or
 * a denied node that is unknown or no longer pending. The graph must already
 * have compiled against `registry`.
 */
export const createExecutionGraphNodeStates = ({
  completedNodeRuns = [],
  deniedNodeIds = [],
  graph,
  registry,
} = {}) => {
  const states = graph.nodes.map((node) => ({
    contract: getSkillContract(registry.get(node.skillId)),
    node,
    reason: null,
    result: null,
    skill: registry.get(node.skillId),
    status: EXECUTION_GRAPH_NODE_STATUSES.pending,
    ...graphNodeIdentity(graph, node.nodeId),
  }));
  const statesByNodeId = new Map(states.map((state) => [state.node.nodeId, state]));
  const nodeOutputs = new Map();

  for (const [nodeId, { output, result }] of buildReusableExecutionGraphRuns({
    completedNodeRuns,
    statesByNodeId,
  })) {
    const state = statesByNodeId.get(nodeId);
    state.result = result;
    state.status = EXECUTION_GRAPH_NODE_STATUSES.reused;
    nodeOutputs.set(nodeId, output);
  }

  // A rejected approval gate settles its node before scheduling starts: it
  // spends nothing, starts no lifecycle step, and its dependants are skipped
  // with it. Only a node that never ran can be denied.
  for (const nodeId of Array.isArray(deniedNodeIds) ? deniedNodeIds : []) {
    const state = statesByNodeId.get(nodeId);

    if (!state || state.status !== EXECUTION_GRAPH_NODE_STATUSES.pending) {
      throw invalidCompletedRun(nodeId);
    }

    settleSkip(state, EXECUTION_GRAPH_SKIP_REASONS.approvalDenied);
  }

  return { nodeOutputs, states, statesByNodeId };
};

/**
 * Whether a node's `when` condition holds. A node without one always runs.
 *
 * A v2 condition is a validated boolean dependency output. Its source node has
 * finished and its checkpoint has settled before this state is eligible; a
 * false branch spends no budget and starts no lifecycle step.
 */
export const isExecutionGraphNodeConditionMet = ({ node, nodeOutputs }) => {
  const when = node.when;

  return !(when && nodeOutputs.get(when.nodeId)?.[when.output] !== when.equals);
};

/**
 * The pure part of scheduling one pending node: skip it, leave it pending, or
 * let it launch. The caller still applies the concurrency cap and exclusivity
 * before launching.
 *
 * `dependencyStatuses` are the statuses of `node.dependsOn` in order (undefined
 * for an unknown id, which never counts as settled). `interrupted` is whether
 * an AgentRunInterruptError is pending in this run. Returns
 * { decision, reason }, `reason` set only for `skip`.
 */
export const decideExecutionGraphNode = ({
  aborted = false,
  dependencyStatuses,
  graphVersion,
  interrupted = false,
  node,
  nodeOutputs,
}) => {
  if (
    dependencyStatuses.some(
      (status) => status === EXECUTION_GRAPH_NODE_STATUSES.failed
    )
  ) {
    return {
      decision: EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip,
      reason: EXECUTION_GRAPH_SKIP_REASONS.dependencyFailed,
    };
  }

  if (
    dependencyStatuses.some(
      (status) => status === EXECUTION_GRAPH_NODE_STATUSES.skipped
    )
  ) {
    return {
      decision: EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip,
      reason: EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped,
    };
  }

  if (!dependencyStatuses.every((status) => SETTLED_OK.has(status))) {
    return { decision: EXECUTION_GRAPH_SCHEDULE_DECISIONS.wait, reason: null };
  }

  if (interrupted && graphVersion === EXECUTION_GRAPH_VERSIONS.v3) {
    // A pre-execution approval gate leaves the heterogeneous graph at a
    // clean pending node boundary. Do not fabricate skipped receipts for
    // work that must remain eligible after the dedicated continuation.
    return { decision: EXECUTION_GRAPH_SCHEDULE_DECISIONS.hold, reason: null };
  }

  if (aborted || interrupted) {
    return {
      decision: EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip,
      reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure,
    };
  }

  if (!isExecutionGraphNodeConditionMet({ node, nodeOutputs })) {
    return {
      decision: EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip,
      reason: EXECUTION_GRAPH_SKIP_REASONS.conditionNotMet,
    };
  }

  return { decision: EXECUTION_GRAPH_SCHEDULE_DECISIONS.launch, reason: null };
};

/**
 * The step lifecycle a graph node runs under.
 *
 * Without a resume claim (`graphResumeClaimId === undefined`) it is the plain
 * lifecycle. With one, every transition goes through the fenced *GraphStep
 * method with `expectedResumeClaimId`, and a missing method or an unrecorded
 * transition throws AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE (409) instead of
 * letting the node continue.
 */
export const createExecutionGraphStepLifecycle = ({
  graphResumeClaimId = undefined,
  stepLifecycle,
} = {}) => {
  const persistFencedGraphStep = async (method, step) => {
    if (typeof stepLifecycle?.[method] !== "function") {
      const error = new Error(
        "Durable graph execution requires a fenced step lifecycle."
      );
      error.code = "AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE";
      error.status = 409;
      throw error;
    }

    const persisted = await stepLifecycle[method]({
      ...step,
      expectedResumeClaimId: graphResumeClaimId,
    });

    if (!persisted) {
      const error = new Error(
        "Durable graph step transition was not recorded before continuing."
      );
      error.code = "AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE";
      error.status = 409;
      throw error;
    }

    return persisted;
  };

  return graphResumeClaimId === undefined
    ? stepLifecycle
    : {
        ...stepLifecycle,
        completeStep: (step) => persistFencedGraphStep("completeGraphStep", step),
        failStep: (step) => persistFencedGraphStep("failGraphStep", step),
        pauseStep: (step) => persistFencedGraphStep("pauseGraphStep", step),
        startStep: (step) => persistFencedGraphStep("startGraphStep", step),
      };
};

/**
 * The run-wide inputs every node of one graph run reads. It takes the same
 * options as runExecutionGraph (the scheduler-only ones are ignored) and
 * applies the same defaults. `docIds` must already be checked against the
 * authorized scope; runExecutionGraph does that before it compiles the graph.
 */
export const createExecutionGraphNodeContext = ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  authorizedDocIds,
  budgetState,
  buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result?.skillId,
    skillVersion: result?.skillVersion,
    ...detail,
  }),
  capabilityRegistry,
  docIds = [],
  executeObservedSkill,
  graph,
  graphResumeClaimId = undefined,
  onNodeSettled = noop,
  preflightNode = null,
  question,
  ragService,
  recordSkillResult = noop,
  recordSkippedSkill = noop,
  retrievalPlan,
  services,
  sessionId,
  stepLifecycle,
  userId,
} = {}) => {
  const scopedDocIds = authorizedDocIds ?? docIds;

  return Object.freeze({
    accessScope,
    addBudgetLimitTrace,
    addTraceStep,
    authorizedDocIdSet: new Set(Array.isArray(scopedDocIds) ? scopedDocIds : []),
    budgetState,
    buildSkillTraceDetail,
    capabilityRegistry,
    docIds,
    executeObservedSkill,
    graph,
    graphResumeClaimId,
    onNodeSettled,
    preflightNode,
    question,
    ragService,
    recordSkillResult,
    recordSkippedSkill,
    requestedDocIdSet: new Set(docIds),
    requestValues: {
      docIds,
      question,
      // Null optional request values mean "not supplied", not a concrete value
      // of the declared object/string type.
      retrievalPlan: retrievalPlan ?? undefined,
    },
    retrievalPlan,
    services,
    sessionId,
    stepLifecycle: createExecutionGraphStepLifecycle({
      graphResumeClaimId,
      stepLifecycle,
    }),
    userId,
  });
};

/**
 * The flags a node raises for its scheduler. `aborted` is set when a
 * fail_fast node fails, `interrupt` holds the last AgentRunInterruptError a
 * node returned (its node is pending again), and `fatalError` is the
 * scheduler's own record of the first error that stops the graph (nodes never
 * write it).
 */
export const createExecutionGraphRunControl = () =>
  Object.seal({ aborted: false, fatalError: null, interrupt: null });

/**
 * Settles a node as skipped and reports it to recordSkippedSkill as a failed
 * primary result. No lifecycle step, no checkpoint write.
 */
export const recordExecutionGraphNodeSkip = ({ budget = null, context, reason, state }) => {
  const result = buildFailedSkillResult(
    state.skill,
    new Error(budget?.reason ?? `Node ${state.node.nodeId} skipped: ${reason}.`)
  );

  settleSkip(state, reason);
  context.recordSkippedSkill({ budget, phase: "primary", result, skill: state.skill });
};

/**
 * The synchronous half of a launch: resolves the node's inputs from the
 * request and its dependencies' validated outputs, checks the document scope,
 * runs the input schema gate and builds the input persisted on its step. It
 * then marks the node `running`, so a scheduler pass that runs before the node
 * settles never launches it twice.
 *
 * Returns { inputValidation, nodeDocIds, nodeQuestion, nodeRetrievalPlan,
 * persistedInput, resolvedInputs } for executeExecutionGraphNodeLaunch.
 */
export const prepareExecutionGraphNodeLaunch = ({ context, nodeOutputs, state }) => {
  const { contract, node } = state;
  const {
    authorizedDocIdSet: authorized,
    docIds,
    graph,
    question,
    requestValues,
    requestedDocIdSet: requestedDocIds,
    retrievalPlan,
    sessionId,
    userId,
  } = context;
  const resolvedInputs = resolveNodeInputs({ node, nodeOutputs, requestValues });
  const boundDocIds = resolvedInputs.docIds ?? docIds;
  const nodeDocIds = resolveNodeDocIds({
    boundDocIds,
    node,
  });
  const scopedDocInput = contract.inputSchema.docIds?.scoped === true;
  const inputErrors = [];

  // An upstream typed string[] is not an authorization grant. It may be a
  // well-formed value while containing a different user's document id.
  if (
    scopedDocInput &&
    Array.isArray(boundDocIds) &&
    boundDocIds.some((docId) =>
      !requestedDocIds.has(docId) || !authorized.has(docId)
    )
  ) {
    inputErrors.push("docIds must remain within the authorized request");
  }

  // Some document adapters interpret [] as "all workspace documents".
  // An empty narrowed scope must never turn a selected-doc operation into
  // a workspace-wide read after the graph validator has accepted it.
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
    ? {
        errors: [...schemaValidation.errors, ...inputErrors],
        ok: false,
        output: null,
      }
    : schemaValidation;
  const nodeQuestion = resolvedInputs.question ?? question;
  const nodeRetrievalPlan = resolvedInputs.retrievalPlan ?? retrievalPlan;
  const persistedInput = {
    // Store the exact validated binding values for a cross-process replay.
    // Access scope and approvals never enter this map; they remain runtime-
    // owned inputs supplied afresh by the recovery handler.
    boundInputs: resolvedInputs,
    docIds: nodeDocIds,
    nodeId: node.nodeId,
    graphVersion: graph.version,
    question: nodeQuestion,
    retrievalPlan: nodeRetrievalPlan,
    sessionId: sessionId ?? null,
    skillId: contract.id,
    skillVersion: contract.version,
    userId: userId ?? null,
    // A dependent node's upstream text is part of its input, not of its
    // question, so a retry that only replays the question would silently run
    // the node on different data than the original. Persist the bound value
    // alongside the request fields the recovery handler already replays.
    ...(resolvedInputs.priorFindings === undefined
      ? {}
      : { priorFindings: resolvedInputs.priorFindings }),
    // The node run carries this for the trace, but recovery is handed the
    // persisted step and nothing else. Without the contract here, a node that
    // writes is indistinguishable from a RAG read and auto-replay would
    // re-run it unattended.
    ...describeSkillReplayContract(state.skill),
  };

  state.status = EXECUTION_GRAPH_NODE_STATUSES.running;

  return {
    inputValidation,
    nodeDocIds,
    nodeQuestion,
    nodeRetrievalPlan,
    persistedInput,
    resolvedInputs,
  };
};

/**
 * The asynchronous half of a launch, from the safe point to the settled
 * status. It writes `state` (status, result, reason, awaiting), adds the
 * node's validated output to `nodeOutputs` once it completed, and raises
 * control.aborted (a fail_fast failure) and control.interrupt (an
 * AgentRunInterruptError) at the moment they happen.
 *
 * Resolves to an EXECUTION_GRAPH_NODE_OUTCOMES value. Rejects with the error
 * that stops the graph: a cancelled request, a fence or checkpoint failure, a
 * non-interrupt error from the lifecycle (the node is pending again), or the
 * outage of the primary document answer (the node settled first).
 */
export const executeExecutionGraphNodeLaunch = async ({
  context,
  control,
  launch,
  nodeOutputs,
  state,
}) => {
  const { contract, node, skill, stepId, stepType } = state;
  const {
    inputValidation,
    nodeDocIds,
    nodeQuestion,
    nodeRetrievalPlan,
    persistedInput,
    resolvedInputs,
  } = launch;
  const {
    accessScope,
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildSkillTraceDetail,
    capabilityRegistry,
    executeObservedSkill,
    graph,
    graphResumeClaimId,
    onNodeSettled,
    preflightNode,
    ragService,
    recordSkillResult,
    recordSkippedSkill,
    services,
    sessionId,
    stepLifecycle: graphStepLifecycle,
    userId,
  } = context;
  let result;
  let budget = null;
  let nodeRuntime = null;
  // A preflight that refuses the resolved input (a Capability policy
  // block, an out-of-scope value) fails this node like an invalid
  // binding: a failed lifecycle step, no budget, no execution.
  let preflightRejection = null;

  try {
    // A node boundary is a safe point: a cancelled request
    // (request-deadline.js) launches nothing more -- no preflight, no
    // approval gate, no budget, no lifecycle step. The node stays pending
    // and the cancellation stops the graph like any fatal error.
    throwIfRequestCancelled();

    // An approval-required Capability must be checked at a clean node
    // boundary: no lifecycle step or budget attempt may exist yet. The
    // injected preflight may persist a graph-bound gate and interrupt;
    // ordinary Skills leave this hook unused.
    if (inputValidation.ok && typeof preflightNode === "function") {
      nodeRuntime = await preflightNode({
        accessScope,
        boundInputs: inputValidation.output,
        graph,
        graphResumeClaimId,
        node,
        nodeDocIds,
        persistedInput,
        skill,
      });

      if (
        nodeRuntime != null &&
        (typeof nodeRuntime !== "object" || Array.isArray(nodeRuntime) ||
          skill.kind !== "capability")
      ) {
        throw new Error("Only a trusted Capability preflight may provide node runtime grants.");
      }

      // The node needs a user decision. It is parked at a clean boundary:
      // no lifecycle step, no budget, no output. Its dependants wait with
      // it while independent nodes keep running; the pause itself is
      // persisted only once nothing else can run (see pauseForApproval).
      if (nodeRuntime?.awaitingApproval === true) {
        state.awaiting = {
          boundInputs: inputValidation.output,
          nodeDocIds,
          persistedInput,
        };
        state.status = EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval;
        return EXECUTION_GRAPH_NODE_OUTCOMES.awaitingApproval;
      }

      if (nodeRuntime?.rejectedInput instanceof Error) {
        preflightRejection = nodeRuntime.rejectedInput;
        nodeRuntime = null;
      }
    }

    // A malformed binding must not execute the skill or consume call
    // budget. The node still enters the lifecycle and fails under its
    // declared failure policy.
    budget = inputValidation.ok && !preflightRejection && contract.budgetKey
      ? reserveBudget(budgetState, contract.budgetKey, 1)
      : null;

    if (budget && !budget.ok) {
      recordExecutionGraphNodeSkip({
        budget,
        context,
        reason: EXECUTION_GRAPH_SKIP_REASONS.budgetExhausted,
        state,
      });
      addBudgetLimitTrace({ reason: budget.reason, tool: skill.label });
      return EXECUTION_GRAPH_NODE_OUTCOMES.skipped;
    }

    result = await runLifecycleStep({
      buildError: buildSkillStepError,
      buildOutput: buildSkillStepOutput,
      execute: async () => {
        // Enforce the input gate in the scheduler itself. Observability
        // adapters may be injected or replaced; none may receive an
        // invalid bound input or invoke the real Skill with it.
        if (!inputValidation.ok || preflightRejection) {
          const invalidResult = buildFailedSkillResult(
            skill,
            preflightRejection ?? createSkillInputContractError(inputValidation.errors)
          );

          // Preserve the per-Skill failure observation without treating a
          // preflight rejection as an executed or budgeted call.
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
            ...(nodeRuntime?.capabilityApproval
              ? { approval: nodeRuntime.capabilityApproval }
              : {}),
            capabilityRegistry,
            docIds: nodeDocIds,
            priorFindings: resolvedInputs.priorFindings,
            question: nodeQuestion,
            ragService,
            retrievalPlan: nodeRetrievalPlan,
            services: nodeRuntime?.services ?? services,
            sessionId,
            userId,
            // A node whose question is bound to an upstream output (the
            // unified graph's follow-up reads its check's followUpQuestion)
            // asks agent text, so it must not write conversation memory.
            ...(isQuestionBoundToNodeOutput(node)
              ? { memoryWrites: false }
              : {}),
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

        // The regular tracker validates the raw skill return. This
        // second check protects the runner when an injected observer or
        // an older adapter does not implement that optional hook.
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
          // Keep the typed envelope identical to the normalized result
          // that answer synthesis and traces consume.
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
    // An interrupt means the node never consumed its call: the run pauses
    // and this node executes again on resume, so hand the reservation back
    // rather than charging the user twice for one approval gate.
    if (isAgentRunInterrupt(error) && contract.budgetKey && budget?.ok) {
      releaseBudget(budgetState, contract.budgetKey, budget.reserved);
    }

    state.status = EXECUTION_GRAPH_NODE_STATUSES.pending;

    if (isAgentRunInterrupt(error)) {
      control.interrupt = error;

      return EXECUTION_GRAPH_NODE_OUTCOMES.interrupted;
    }

    throw error;
  }

  state.result = result;
  const settledStatus = result.ok
    ? EXECUTION_GRAPH_NODE_STATUSES.completed
    : EXECUTION_GRAPH_NODE_STATUSES.failed;
  recordSkillResult(result);

  if (result.ok) {
    nodeOutputs.set(node.nodeId, result.graphOutput);
  } else if (node.failurePolicy === EXECUTION_GRAPH_FAILURE_POLICIES.failFast) {
    // Raised now, not when this node returns: a sibling that settles while
    // this node's checkpoint is still being written wakes the scheduler, and
    // that pass must already skip the rest.
    control.aborted = true;
  }

  addTraceStep({
    detail: buildSkillTraceDetail(result, {
      dependsOn: [...(node.dependsOn ?? [])],
      graphVersion: graph.version,
      nodeId: node.nodeId,
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

  // A durable checkpoint must settle before any dependent node is
  // eligible to run. This hook is deliberately after the ordinary step
  // lifecycle and trace, but still inside the in-flight node promise.
  // Keep the scheduler-visible status `running` until the write resolves:
  // an unrelated parallel node may finish and wake the scheduling loop.
  await onNodeSettled({
    graph,
    nodeRun: buildExecutionGraphNodeRun({ ...state, status: settledStatus }),
  });
  state.status = settledStatus;

  // The primary document answer (the unconditional, dependency-free
  // document_rag node) failed because a dependency is down: the graph
  // stops and the run answers with the outage (dependency-outage.js)
  // rather than finalizing around the missing answer. The node itself
  // settled and checkpointed as failed above.
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

  return EXECUTION_GRAPH_NODE_OUTCOMES.settled;
};

/**
 * One whole launch: prepareExecutionGraphNodeLaunch, then
 * executeExecutionGraphNodeLaunch. For a scheduler that has no reason to run
 * code between the two; a throw from the synchronous half becomes a rejection.
 */
export const runExecutionGraphNode = async ({ context, control, nodeOutputs, state }) =>
  executeExecutionGraphNodeLaunch({
    context,
    control,
    launch: prepareExecutionGraphNodeLaunch({ context, nodeOutputs, state }),
    nodeOutputs,
    state,
  });

/**
 * The result of a graph rejected before any node ran: nothing ran, nothing
 * was persisted, and the caller may still fall back.
 */
export const buildRejectedExecutionGraphRun = ({ errors, graph }) => ({
  errors,
  graphVersion: graph?.version ?? null,
  nodeRuns: [],
  ok: false,
  results: [],
  status: EXECUTION_GRAPH_RUN_STATUSES.rejected,
});

/**
 * The result of a graph whose every node reached a terminal status: node runs
 * and results in declaration order, `completed` when every node is benign
 * terminal (ok, a false condition, a denied approval, or skipped only behind
 * such a node), otherwise `partial`.
 */
export const buildExecutionGraphRunResult = ({ graph, states, statesByNodeId }) => {
  const nodeRuns = states.map(buildExecutionGraphNodeRun);
  const results = states
    .filter((state) => state.result)
    .map((state) => state.result);
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

    // A false condition and a rejected approval are decisions, not failures:
    // the graph completes without that node.
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

  return {
    errors: [],
    graphVersion: graph.version,
    nodeRuns,
    ok: status === EXECUTION_GRAPH_RUN_STATUSES.completed,
    results,
    status,
  };
};
