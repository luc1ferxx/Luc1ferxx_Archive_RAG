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
import { assessUnifiedGraphRecoveryEligibility } from "./agent-unified-graph-recovery-eligibility.js";
import { collectUnifiedGraphResults } from "./agent-unified-graph-results.js";
import { deriveUnifiedGraphAnswer } from "./agent-unified-graph-answer.js";
import {
  preflightCapabilityGraphApproval,
  verifyCapabilityGraphApproval,
} from "./capabilities/graph-approval-preflight.js";
import { CAPABILITY_POLICY_DECISIONS } from "./capabilities/policy-enforcer.js";
import { buildAuthorizedUnifiedGraphCatalog } from "./skills/unified-graph-catalog.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";

const noop = () => {};
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const fail = (reason, code = "AGENT_UNIFIED_GRAPH_STAGE_INVALID") => {
  const error = new Error(`Unified graph cannot execute: ${reason}.`);
  error.code = code;
  error.status = 409;
  throw error;
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
    fail("a durable run, observed executor, checkpoint store, and fenced graph lifecycle are required");
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
 * run. It never invokes the planner again. The approval continuation is
 * handled at the same clean node boundary as an initial approval request.
 */
export const runUnifiedGraphStage = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  agentRunId,
  allowedCapabilityIds = [],
  baseCapabilityRegistry,
  budgetState,
  buildSkillTraceDetail,
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
    fail("a runtime-owned budget is required");
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

  if (stored) {
    if (
      stored.version !== EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2 ||
      stored.graph?.version !== EXECUTION_GRAPH_VERSIONS.v3 ||
      stored.phase !== "running" ||
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

    // The pure recovery assessor expects an unclaimed checkpoint. Remove only
    // that field from a freshly sealed in-memory copy after checking the real
    // claim above; the original durable checkpoint is never rewritten here.
    const assessmentCheckpoint = sealExecutionGraphCheckpoint({
      ...stored,
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
    completedNodeRuns = stored.nodeRuns;
  } else {
    if (expectedGraphResumeClaimId || resumeRun) {
      fail("a claimed continuation has no graph checkpoint", "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    }
    graph = planned?.graph;
    if (graph?.version !== EXECUTION_GRAPH_VERSIONS.v3) {
      fail("the validated planner did not return a v3 graph", "AGENT_UNIFIED_GRAPH_REJECTED");
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
      fail(validation.errors.map((error) => error.code).join(", "), "AGENT_UNIFIED_GRAPH_REJECTED");
    }
    graph = validation.graph;

    // Legacy built-in wrappers still interrupt inside their execute path.
    // That would leave a running graph receipt. Only graph-aware Capability
    // adapters have a pre-execution approval boundary at present.
    if (graph.nodes.some((node) => [
      AGENT_SKILL_IDS.webSearch,
      AGENT_SKILL_IDS.documentDiscovery,
    ].includes(node.skillId))) {
      fail("this graph contains a built-in approval path without a graph-bound preflight", "AGENT_UNIFIED_GRAPH_APPROVAL_UNSUPPORTED");
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
    checkpointQueue = checkpointQueue.then(async () => {
      const next = updateExecutionGraphCheckpoint(checkpoint, patch(checkpoint));
      const saved = await saveExecutionGraphCheckpoint(next);
      assertStoredCheckpoint(saved, next);
      checkpoint = saved;
    });
    return checkpointQueue;
  };

  const preflightNode = async ({ boundInputs, node, skill }) => {
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
    capabilityRegistry: baseCapabilityRegistry,
    completedNodeRuns,
    docIds,
    executeObservedSkill,
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
    preflightNode,
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
  const answer = deriveUnifiedGraphAnswer({ collected });
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
    status: run.status,
  });

  return { answer, checkpoint, collected, run };
};
