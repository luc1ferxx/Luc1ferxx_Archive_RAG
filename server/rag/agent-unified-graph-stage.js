import { isDeepStrictEqual } from "node:util";

import { getRemainingBudget } from "./agent-budget.js";
import {
  EXECUTION_GRAPH_CHECKPOINT_VERSIONS,
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  sealExecutionGraphCheckpoint,
  snapshotExecutionGraphNodeRun,
  updateExecutionGraphCheckpoint,
  verifyExecutionGraphCheckpoint,
} from "./agent-execution-graph-checkpoint.js";
import {
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_VERSIONS,
  validateExecutionGraph,
} from "./agent-execution-graph.js";
import { runExecutionGraph } from "./agent-execution-graph-runner.js";
import { AGENT_INTERRUPT_TYPES, AgentRunInterruptError } from "./agent-interrupts.js";
import {
  assessUnifiedGraphAdmission,
  assessUnifiedGraphNodeApproval,
} from "./agent-unified-graph-admission.js";
import { assessUnifiedGraphRecoveryEligibility } from "./agent-unified-graph-recovery-eligibility.js";
import { collectUnifiedGraphResults } from "./agent-unified-graph-results.js";
import {
  preflightCapabilityGraphApproval,
  verifyCapabilityGraphApproval,
} from "./capabilities/graph-approval-preflight.js";
import { CAPABILITY_POLICY_DECISIONS } from "./capabilities/policy-enforcer.js";
import { buildAuthorizedUnifiedGraphCatalog } from "./skills/unified-graph-catalog.js";

const noop = () => {};
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const fail = (
  reason,
  code = "AGENT_UNIFIED_GRAPH_STAGE_INVALID",
  { preExecution = false, reasonCodes = null } = {}
) => {
  const error = new Error(`Unified graph cannot execute: ${reason}.`);
  error.code = code;
  error.status = 409;
  // Only an error raised before the first checkpoint write may hand the
  // request back to the V1 path: nothing durable exists and no node ran.
  error.preExecution = preExecution;
  if (Array.isArray(reasonCodes)) {
    error.reasonCodes = reasonCodes;
  }
  throw error;
};

const COMPLETED_RECEIPTS = new Set(["completed", "reused"]);

const replayGuardError = () => {
  const error = new Error(
    "A completed unified graph checkpoint would execute a node during finalization replay."
  );
  error.code = "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY";
  error.status = 409;
  return error;
};

const assertDurableRuntime = ({
  agentRunId,
  executeObservedSkill,
  loadExecutionGraphCheckpoint,
  saveExecutionGraphCheckpoint,
  stepLifecycle,
}) => {
  if (
    !agentRunId ||
    typeof executeObservedSkill !== "function" ||
    typeof loadExecutionGraphCheckpoint !== "function" ||
    typeof saveExecutionGraphCheckpoint !== "function" ||
    ["startGraphStep", "completeGraphStep", "failGraphStep", "pauseGraphStep"]
      .some((name) => typeof stepLifecycle?.[name] !== "function")
  ) {
    fail(
      "a durable run, observed executor, checkpoint store, and fenced graph lifecycle are required",
      "AGENT_UNIFIED_GRAPH_STAGE_INVALID",
      { preExecution: true }
    );
  }
};

const assertStoredCheckpoint = (saved, expected) => {
  if (
    !isRecord(saved) ||
    saved.digest !== expected.digest ||
    saved.sequence !== expected.sequence ||
    saved.version !== EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2
  ) {
    fail("the graph checkpoint was not durably acknowledged", "AGENT_UNIFIED_GRAPH_CHECKPOINT_UNCONFIRMED");
  }
};

/**
 * Node ids a recovery boundary can never start, derived exactly as the
 * scheduler will: a node whose `when` reads a reused output that does not
 * equal the expected value is skipped (condition_not_met), and every node
 * depending on a skipped node is skipped too (dependency_skipped). Only a
 * reused typed output decides a condition; anything else stays pending.
 */
export const listUnifiedGraphNodesThatCannotRun = ({ completedNodeRuns = [], graph } = {}) => {
  const outputs = new Map(
    completedNodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.result?.graphOutput])
  );
  const skipped = new Set();
  let changed = true;

  while (changed) {
    changed = false;

    for (const node of graph?.nodes ?? []) {
      if (outputs.has(node.nodeId) || skipped.has(node.nodeId)) {
        continue;
      }

      const output = node.when ? outputs.get(node.when.nodeId) : undefined;
      const conditionFalse =
        Boolean(node.when) &&
        isRecord(output) &&
        Object.hasOwn(output, node.when.output) &&
        output[node.when.output] !== node.when.equals;

      if (conditionFalse || (node.dependsOn ?? []).some((id) => skipped.has(id))) {
        skipped.add(node.nodeId);
        changed = true;
      }
    }
  }

  return skipped;
};

const approvalBoundaryMatches = (boundary, gate) =>
  isRecord(boundary) &&
  isRecord(gate) &&
  boundary.gateId === gate.id &&
  boundary.approvalObjectHash === gate.approvalObjectHash &&
  boundary.capabilityId === gate.capabilityId &&
  boundary.capabilityVersion === gate.capabilityVersion &&
  boundary.nodeId === gate.nodeId &&
  boundary.graphDigest === gate.graphDigest &&
  boundary.graphRevision === gate.graphRevision;

/**
 * Execute one v3 all-stage proposal on the existing agent-run store. The
 * catalog is rebuilt from live scoped services; neither the planner response
 * nor a stored checkpoint is allowed to supply an executable registry.
 *
 * A recovered invocation must carry a run-store claim and the current stored
 * run. It never invokes the planner again. Under the guarded rollout an
 * approval-gated node never reaches this far (admission refuses the graph),
 * so the graph-bound approval continuation below stays unused and frozen.
 *
 * `capabilityRegistry` executes built-in wrappers (it may carry the request's
 * standing approvals, exactly as on the V1 path); `baseCapabilityRegistry`
 * builds the catalog and backs direct Capability adapters, whose approvals are
 * graph-bound. `allowFinalizationReplay` lets a claimed recovery rebuild the
 * node receipts of a graph that already completed, without executing a node,
 * so the run can be finalized from the same persisted outputs.
 */
export const runUnifiedGraphStage = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  agentRunId,
  allowFinalizationReplay = false,
  allowedCapabilityIds = [],
  baseCapabilityRegistry,
  budgetState,
  buildSkillTraceDetail,
  capabilityApprovals = {},
  capabilityRegistry = baseCapabilityRegistry,
  docIds = [],
  executeObservedSkill,
  expectedGraphResumeClaimId = null,
  getExecutionGraphApproval = null,
  limits = EXECUTION_GRAPH_LIMITS,
  loadExecutionGraphCheckpoint,
  maxConcurrency,
  pauseExecutionGraphForApproval = null,
  plan,
  planned = null,
  question,
  ragService,
  recordExecutionGraph = noop,
  recordSkillResult = noop,
  recordSkippedSkill = noop,
  registry,
  resumeRun = null,
  retrievalPlan,
  saveExecutionGraphCheckpoint,
  services,
  sessionId,
  stepLifecycle,
  taskMemory = null,
  userId,
} = {}) => {
  assertDurableRuntime({
    agentRunId,
    executeObservedSkill,
    loadExecutionGraphCheckpoint,
    saveExecutionGraphCheckpoint,
    stepLifecycle,
  });
  if (!isRecord(budgetState?.limits) || !isRecord(budgetState?.used)) {
    fail("a runtime-owned budget is required", "AGENT_UNIFIED_GRAPH_STAGE_INVALID", {
      preExecution: true,
    });
  }

  const effectiveLimits = { ...EXECUTION_GRAPH_LIMITS, ...limits };
  const catalog = buildAuthorizedUnifiedGraphCatalog({
    accessScope,
    allowedCapabilityIds,
    capabilityRegistry: baseCapabilityRegistry,
    docIds,
    ragService,
    registry,
  });
  const graphRegistry = catalog.graphRegistry;
  const authorizedSkillIds = catalog.skills.map((skill) => skill.id);
  const authorizedAdapterIds = catalog.skills
    .filter((skill) => skill.kind === "capability")
    .map((skill) => skill.id);
  const loaded = await loadExecutionGraphCheckpoint();
  const stored = loaded?.checkpoint ?? null;
  let checkpoint;
  let graph;
  let completedNodeRuns = [];
  let approvedNode = null;
  let finalizationReplay = false;

  if (stored) {
    finalizationReplay = allowFinalizationReplay && stored.phase === "completed";

    if (
      stored.version !== EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2 ||
      stored.graph?.version !== EXECUTION_GRAPH_VERSIONS.v3 ||
      (stored.phase !== "running" && !finalizationReplay) ||
      stored.finalization !== undefined ||
      !expectedGraphResumeClaimId ||
      stored.resumeClaim?.claimId !== expectedGraphResumeClaimId ||
      !isRecord(resumeRun) ||
      !Array.isArray(loaded?.steps)
    ) {
      fail("an existing graph requires a claimed, running v3 recovery boundary", "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    }

    const verified = verifyExecutionGraphCheckpoint({
      accessScope,
      budgetState,
      checkpoint: stored,
      docIds,
      plan,
      question,
      retrievalPlan,
      selectedSkills: catalog.skills,
      sessionId,
      taskMemory,
      userId,
    });
    if (!verified.ok) {
      fail(verified.reason, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    }
    if (planned?.graph && !isDeepStrictEqual(planned.graph, stored.graph)) {
      fail("the proposed graph differs from the claimed checkpoint", "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    }

    // The pure recovery assessor expects an unclaimed running checkpoint.
    // Remove only the claim from a freshly sealed in-memory copy after the real
    // claim was checked above; the durable checkpoint is never rewritten here.
    // A completed graph is assessed at the equivalent running boundary: its
    // skip receipts carry no step, output, or budget, and the scheduler below
    // re-derives each skip from the reused outputs alone.
    const assessmentCheckpoint = sealExecutionGraphCheckpoint({
      ...stored,
      ...(finalizationReplay
        ? {
            nodeRuns: stored.nodeRuns.filter((nodeRun) =>
              COMPLETED_RECEIPTS.has(nodeRun.status)
            ),
            phase: "running",
          }
        : {}),
      resumeClaim: undefined,
    });
    let assessmentRun = resumeRun;

    if (stored.approvalBoundary) {
      if (typeof getExecutionGraphApproval !== "function") {
        fail("an approved graph node has no private approval reader", "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
      }
      const approval = await getExecutionGraphApproval({ accessScope, runId: agentRunId });
      if (
        approval?.checkpoint?.digest !== stored.digest ||
        !approvalBoundaryMatches(stored.approvalBoundary, approval?.gate) ||
        !isRecord(approval.approvalSnapshot) ||
        !Array.isArray(resumeRun.approvalGates) ||
        resumeRun.approvalGates.length !== 1 ||
        resumeRun.approvalGates[0]?.id !== approval.gate.id ||
        resumeRun.approvalGates[0]?.status !== "approved"
      ) {
        fail("approved graph node does not match the claimed run", "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
      }
      approvedNode = approval;
      assessmentRun = { ...resumeRun, approvalGates: [] };
    }

    const assessment = assessUnifiedGraphRecoveryEligibility({
      accessScope,
      authorizedDocIds: docIds,
      authorizedSkills: catalog.skills,
      budgetState,
      checkpoint: assessmentCheckpoint,
      docIds,
      limits: effectiveLimits,
      plan,
      question,
      registry: graphRegistry,
      retrievalPlan,
      run: assessmentRun,
      sessionId,
      taskMemory,
      userId,
    });
    if (!assessment.eligible) {
      fail(assessment.reason, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    }

    for (const [key, used] of Object.entries(assessment.usedBudgetAtResume)) {
      const current = budgetState.used[key] ?? 0;
      if (!Number.isSafeInteger(current) || current < 0) {
        fail("the live budget has an invalid usage count", "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
      }
      budgetState.used[key] = Math.max(current, used);
    }

    checkpoint = stored;
    graph = stored.graph;
    completedNodeRuns = stored.nodeRuns.filter((nodeRun) =>
      COMPLETED_RECEIPTS.has(nodeRun.status)
    );

    // Recovery cannot re-establish an approval the original request carried,
    // so a node still to run must be admissible without one; otherwise the
    // run stays with an operator. Completed nodes are reused, never re-run,
    // and a node the reused outputs already skip (a Web fallback whose
    // evidence check passed, and its dependents) will not run either. A
    // finalization replay runs no node at all: the replay guard refuses any.
    const settled = new Set(completedNodeRuns.map((nodeRun) => nodeRun.nodeId));
    const cannotRun = listUnifiedGraphNodesThatCannotRun({ completedNodeRuns, graph });
    const pendingAdmission = assessUnifiedGraphAdmission({
      accessScope,
      capabilityApprovals,
      capabilityRegistry: baseCapabilityRegistry,
      docIds,
      graph,
      nodeIds: finalizationReplay
        ? []
        : graph.nodes
            .map((node) => node.nodeId)
            .filter((nodeId) => !settled.has(nodeId) && !cannotRun.has(nodeId)),
      plan,
      registry: graphRegistry,
    });
    if (!pendingAdmission.admitted) {
      fail(
        `a pending node is not admissible at recovery (${pendingAdmission.reasonCodes.join(", ")})`,
        "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY"
      );
    }
  } else {
    if (expectedGraphResumeClaimId || resumeRun) {
      fail("a claimed continuation has no graph checkpoint", "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    }
    graph = planned?.graph;
    if (graph?.version !== EXECUTION_GRAPH_VERSIONS.v3) {
      fail("the validated planner did not return a v3 graph", "AGENT_UNIFIED_GRAPH_REJECTED", {
        preExecution: true,
      });
    }
    const validation = validateExecutionGraph({
      authorizedDocIds: docIds,
      authorizedSkillIds,
      budgetRemaining: getRemainingBudget(budgetState),
      graph,
      limits: effectiveLimits,
      registry: graphRegistry,
    });
    if (!validation.ok) {
      const reasonCodes = validation.errors.map((error) => error.code);
      fail(reasonCodes.join(", "), "AGENT_UNIFIED_GRAPH_REJECTED", {
        preExecution: true,
        reasonCodes,
      });
    }
    graph = validation.graph;

    // Legacy built-in wrappers interrupt inside their execute path, which
    // would leave a running graph receipt behind a pause that cannot fall
    // back. Such a node is admissible only with a standing, input-independent
    // grant; approval-gated Capability adapters and graphs the legacy
    // finalizer cannot represent are refused whole, before any durable write.
    const admission = assessUnifiedGraphAdmission({
      accessScope,
      capabilityApprovals,
      capabilityRegistry: baseCapabilityRegistry,
      docIds,
      graph,
      plan,
      registry: graphRegistry,
    });
    if (!admission.admitted) {
      fail(
        `the graph is not admissible (${admission.reasonCodes.join(", ")})`,
        "AGENT_UNIFIED_GRAPH_APPROVAL_UNSUPPORTED",
        { preExecution: true, reasonCodes: admission.reasonCodes }
      );
    }

    checkpoint = createExecutionGraphCheckpoint({
      graph,
      owner: buildExecutionGraphCheckpointOwner({
        accessScope,
        budgetState,
        docIds,
        plan,
        question,
        retrievalPlan,
        selectedSkills: catalog.skills,
        sessionId,
        taskMemory,
        userId,
      }),
      version: EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2,
    });
    const saved = await saveExecutionGraphCheckpoint(checkpoint);
    assertStoredCheckpoint(saved, checkpoint);
  }

  // A checkpoint write for one parallel branch may race another settlement.
  // Serialize updates and retain the acknowledged version as the next CAS
  // input. The runner awaits this hook before making a dependent ready.
  let checkpointQueue = Promise.resolve();
  const persistCheckpoint = (patch) => {
    if (finalizationReplay) {
      // A completed checkpoint is final: a replay never advances it.
      return checkpointQueue;
    }

    checkpointQueue = checkpointQueue.then(async () => {
      const next = updateExecutionGraphCheckpoint(checkpoint, patch(checkpoint));
      const saved = await saveExecutionGraphCheckpoint(next);
      assertStoredCheckpoint(saved, next);
      checkpoint = saved;
    });
    return checkpointQueue;
  };

  const preflightNode = async ({ boundInputs, node, skill }) => {
    // At a recovery boundary the request's standing approvals are gone. The
    // admission above already refused a pending node that needs one; this
    // re-check at the moment a node would start, before its step or budget
    // exists, keeps that true even if the scheduler reaches a node the
    // admission considered skipped.
    if (
      stored &&
      approvedNode?.gate?.nodeId !== node.nodeId &&
      assessUnifiedGraphNodeApproval({
        accessScope,
        capabilityApprovals,
        capabilityRegistry: baseCapabilityRegistry,
        docIds,
        skill,
      })
    ) {
      fail(
        `node ${node.nodeId} needs an approval recovery cannot re-establish`,
        "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY"
      );
    }

    if (skill.kind !== "capability") {
      return null;
    }
    await checkpointQueue;

    const args = {
      accessScope,
      adapter: skill,
      authorizedAdapterIds,
      authorizedDocIds: docIds,
      capabilityRegistry: baseCapabilityRegistry,
      graphDigest: approvedNode?.gate?.nodeId === node.nodeId
        ? checkpoint.approvalBoundary.graphDigest
        : checkpoint.digest,
      graphRevision: graph.revision,
      input: boundInputs,
      nodeId: node.nodeId,
      runId: agentRunId,
    };

    if (approvedNode?.gate?.nodeId === node.nodeId) {
      const verifiedApproval = verifyCapabilityGraphApproval({
        ...args,
        approval: {
          approved: true,
          approvalObjectHash: approvedNode.gate.approvalObjectHash,
          gateId: approvedNode.gate.id,
        },
        approvalGate: approvedNode.gate,
        approvalSnapshot: approvedNode.approvalSnapshot,
      });
      if (!isDeepStrictEqual(verifiedApproval.input, boundInputs)) {
        fail("approved capability input changed after the gate", "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
      }
      approvedNode = null;
      return { capabilityApproval: verifiedApproval.capabilityApproval };
    }

    const decision = preflightCapabilityGraphApproval(args);
    if (decision.decision === CAPABILITY_POLICY_DECISIONS.allowed) {
      return null;
    }
    if (
      decision.decision !== CAPABILITY_POLICY_DECISIONS.needsApproval ||
      !decision.approvalGate ||
      !decision.approvalSnapshot ||
      typeof pauseExecutionGraphForApproval !== "function"
    ) {
      fail("approval-required node has no atomic graph gate", "AGENT_UNIFIED_GRAPH_APPROVAL_UNAVAILABLE");
    }

    const paused = await pauseExecutionGraphForApproval({
      accessScope,
      approvalGate: decision.approvalGate,
      approvalSnapshot: decision.approvalSnapshot,
      checkpoint,
      graphResumeClaimId: expectedGraphResumeClaimId,
      runId: agentRunId,
    });
    if (paused?.paused !== true || paused.checkpoint?.phase !== "awaiting_approval") {
      fail("the approval gate was not durably persisted", "AGENT_UNIFIED_GRAPH_APPROVAL_UNAVAILABLE");
    }
    checkpoint = paused.checkpoint;
    const interrupt = new AgentRunInterruptError({
      detail: { approvalGate: decision.approvalGate },
      message: "Unified graph node requires approval.",
      publicMessage: "请确认是否允许继续执行此操作。",
      type: AGENT_INTERRUPT_TYPES.capabilityApprovalRequired,
    });
    interrupt.unifiedGraphApprovalPersisted = true;
    throw interrupt;
  };

  const run = await runExecutionGraph({
    accessScope,
    addBudgetLimitTrace,
    addTraceStep,
    authorizedDocIds: docIds,
    authorizedSkillIds,
    budgetState,
    buildSkillTraceDetail,
    capabilityRegistry,
    completedNodeRuns,
    docIds,
    executeObservedSkill: finalizationReplay
      ? async () => { throw replayGuardError(); }
      : executeObservedSkill,
    graph,
    graphResumeClaimId: expectedGraphResumeClaimId,
    limits: effectiveLimits,
    maxConcurrency,
    onNodeSettled: ({ nodeRun }) =>
      persistCheckpoint((current) => ({
        nodeRuns: [
          ...current.nodeRuns.filter((saved) => saved.nodeId !== nodeRun.nodeId),
          snapshotExecutionGraphNodeRun(nodeRun),
        ],
      })),
    preflightNode: finalizationReplay
      ? async () => { throw replayGuardError(); }
      : preflightNode,
    question,
    ragService,
    recordSkillResult,
    recordSkippedSkill,
    registry: graphRegistry,
    retrievalPlan,
    services,
    sessionId,
    stepLifecycle,
    userId,
  });

  if (run.status === "rejected") {
    fail("the graph was rejected at execution", "AGENT_UNIFIED_GRAPH_REJECTED");
  }
  if (
    finalizationReplay &&
    run.nodeRuns.some((nodeRun) => ["completed", "failed"].includes(nodeRun.status))
  ) {
    throw replayGuardError();
  }
  if (!run.ok || run.status !== "completed") {
    await persistCheckpoint((current) => ({
      nodeRuns: [
        ...current.nodeRuns.filter((saved) =>
          !run.nodeRuns.some((item) => item.nodeId === saved.nodeId)
        ),
        ...run.nodeRuns.map(snapshotExecutionGraphNodeRun),
      ],
      phase: "partial",
    }));
    fail("one or more graph nodes failed", "AGENT_UNIFIED_GRAPH_PARTIAL");
  }

  const collected = collectUnifiedGraphResults({
    authorizedDocIds: docIds,
    graph,
    registry: graphRegistry,
    run,
  });
  await persistCheckpoint((current) => ({
    nodeRuns: [
      ...current.nodeRuns.filter((saved) =>
        !run.nodeRuns.some((item) => item.nodeId === saved.nodeId)
      ),
      ...run.nodeRuns.map(snapshotExecutionGraphNodeRun),
    ],
    phase: "completed",
  }));
  await recordExecutionGraph({
    executed: true,
    graph: { version: graph.version, nodeCount: graph.nodes.length },
    mode: "guarded",
    nodeRuns: run.nodeRuns.map(({ result, ...nodeRun }) => ({
      ...nodeRun,
      ok: Boolean(result?.ok),
    })),
    ...(finalizationReplay ? { replayed: true } : {}),
    status: run.status,
  });

  return {
    catalog,
    checkpoint,
    collected,
    finalizationReplay,
    graphRegistry,
    run,
  };
};
