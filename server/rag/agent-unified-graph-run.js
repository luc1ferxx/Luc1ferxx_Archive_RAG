import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { normalizeText } from "../lib/normalize-text.js";
import { createAgentSession } from "./agent-bootstrap.js";
import {
  EXECUTION_GRAPH_CHECKPOINT_VERSIONS,
  updateExecutionGraphCheckpoint,
} from "./agent-execution-graph-checkpoint.js";
import { EXECUTION_GRAPH_VERSIONS } from "./agent-execution-graph.js";
import { finalizeAgentRun } from "./agent-finalization-flow.js";
import { createAgentRunStepLifecycle } from "./agent-run-step-lifecycle.js";
import { createAgentRunCursor } from "./agent-runs.js";
import { assessUnifiedGraphAdmission } from "./agent-unified-graph-admission.js";
import { createUnifiedAgentExecutionGraphResult } from "./agent-unified-dag-planner.js";
import { applyUnifiedGraphDocumentLoop } from "./agent-unified-graph-document-loop.js";
import { projectUnifiedGraphRun } from "./agent-unified-graph-projection.js";
import { runUnifiedGraphStage } from "./agent-unified-graph-stage.js";
import { buildAgentExperienceMemoryObservability } from "./agent-experience-memory.js";
import { createDefaultCapabilityRegistry } from "./capabilities/index.js";

// The guarded v3 path of one /chat or background-task request, and its
// cross-process continuation.
//
// One request takes exactly one path. Planning, validation, and admission are
// pure and happen before anything durable: a refused graph records why (a run
// event plus a trace step) and hands the untouched request to V1. An admitted
// graph records that it was selected, then runs on the existing run store,
// validator/scheduler, budget reservation, and replay matrix
// (agent-unified-graph-stage.js).
//
// The stage rebuilds the catalog from live scoped services and validates the
// graph again. A refusal there is still before any durable graph write (the
// stage marks it `preExecution`): the run records a refusal that supersedes
// the selection and V1 answers, exactly as for a refusal at planning or
// admission. From the stage's first checkpoint write on there is no V1
// fallback.
//
// The graph's typed node results are projected onto the legacy execution
// state and finalized by the same finalizeAgentRun (self-check, finalizer,
// citation projection) V1 uses. The caller's `prepareResponse` then attaches
// what completion adds (run id, task continuation, the experience-memory
// write), and only that prepared response is sealed into the private graph
// checkpoint as a finalization receipt, before the run is completed. A process
// that stops after that write is recovered by completing the run with the
// stored response, never by computing a second answer; one that stops earlier
// recomputes it from the same persisted node outputs and prepares it again
// (the experience-memory write is an upsert under a deterministic key).

export const UNIFIED_GRAPH_RUN_EVENTS = Object.freeze({
  executed: "unified_graph_executed",
  planned: "unified_graph_planned",
});

export const UNIFIED_GRAPH_FALLBACK_REASON_CODES = Object.freeze({
  approvalContinuationFrozen: "approval_continuation_frozen",
  durableRuntimeUnavailable: "durable_runtime_unavailable",
  stageRefusedBeforeExecution: "stage_refused_before_execution",
});

const FINALIZATION_RECEIPT_VERSION = "v1";

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const jsonCopy = (value) => JSON.parse(JSON.stringify(value));

const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
};

const recoveryError = (reason) => {
  const error = new Error(`Unified graph run cannot be resumed: ${reason}.`);
  error.code = "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY";
  error.status = 409;
  return error;
};

/**
 * The answer-bearing part of a finalized response. Two responses with the
 * same digest give the user the same answer, mode, sources, and clarification.
 */
export const digestUnifiedGraphFinalizedAnswer = (response = {}) => {
  const body = response?.body ?? {};

  return `v1:sha256:${createHash("sha256")
    .update("agent-unified-graph-finalized-answer:v1\0")
    .update(JSON.stringify(canonicalize({
      agentAnswer: body.agentAnswer ?? null,
      agentMode: body.agentMode ?? null,
      clarification: body.clarification ?? null,
      ragAbstained: body.ragAbstained ?? null,
      ragSources: body.ragSources ?? [],
      status: response?.status ?? null,
    })))
    .digest("hex")}`;
};

export const buildUnifiedGraphFinalizationReceipt = (response) => {
  const stored = jsonCopy(response);

  return {
    answerDigest: digestUnifiedGraphFinalizedAnswer(stored),
    response: stored,
    version: FINALIZATION_RECEIPT_VERSION,
  };
};

export const verifyUnifiedGraphFinalizationReceipt = (receipt) =>
  isRecord(receipt) &&
  receipt.version === FINALIZATION_RECEIPT_VERSION &&
  isRecord(receipt.response) &&
  Number.isInteger(receipt.response.status) &&
  isRecord(receipt.response.body) &&
  receipt.answerDigest === digestUnifiedGraphFinalizedAnswer(receipt.response);

const describeGraph = (graph) =>
  graph
    ? {
        nodeCount: graph.nodes.length,
        nodeIds: graph.nodes.map((node) => node.nodeId),
        skillIds: graph.nodes.map((node) => node.skillId),
        version: graph.version,
      }
    : null;

const findLatestPlannedEvent = (run = {}) =>
  (Array.isArray(run?.events) ? run.events : []).findLast(
    (event) => event.type === UNIFIED_GRAPH_RUN_EVENTS.planned
  ) ?? null;

/**
 * True when the run's durable events show that this request took the guarded
 * v3 path (and never the V1 outer plan). Recovery uses it to route a v2
 * checkpoint to the dedicated v3 continuation. The latest planning event
 * decides: a stage refusal after `selected` supersedes it.
 */
export const hasUnifiedGuardedGraphPath = (run = {}) => {
  const events = Array.isArray(run?.events) ? run.events : [];
  const latest = findLatestPlannedEvent(run);

  return latest?.payload?.mode === "guarded" &&
    latest.payload.status === "selected" &&
    latest.payload.fallback === null &&
    !events.some((event) => event.type === "execution_planned");
};

// Session observability the recovered session cannot recompute: which intent
// planner answered and what experience memory planning read. Sanitized
// descriptors only (no hint text, no prompt).
const buildUnifiedGraphRequestContext = ({ experienceMemory, intentPlanner }) => {
  const read = experienceMemory
    ? buildAgentExperienceMemoryObservability(experienceMemory)
    : null;

  return {
    experienceMemory: read
      ? {
          enabled: read.enabled,
          error: read.error,
          hitCount: read.hitCount,
          memoryApplied: read.applied,
          planningHints: read.hints,
          reason: read.reason,
          status: read.status,
        }
      : null,
    intentPlanner: intentPlanner ? jsonCopy(intentPlanner) : null,
  };
};

const persistFinalizationReceipt = async ({
  accessScope,
  agentRunService,
  checkpoint,
  response,
  runCursor,
  runId,
}) => {
  const next = updateExecutionGraphCheckpoint(checkpoint, {
    finalization: buildUnifiedGraphFinalizationReceipt(response),
  });
  const saved = await agentRunService.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint: next,
    ...(runCursor ? { runCursor } : {}),
    runId,
  });

  if (saved?.digest !== next.digest || saved?.sequence !== next.sequence) {
    const error = new Error("The unified graph finalization receipt was not durably acknowledged.");
    error.code = "AGENT_UNIFIED_GRAPH_CHECKPOINT_UNCONFIRMED";
    error.status = 409;
    throw error;
  }

  return saved;
};

/**
 * Project a completed graph onto the legacy state and finalize it with the
 * same finalizer V1 uses. Deterministic in the persisted node outputs.
 */
const finalizeUnifiedGraph = async ({
  docIds,
  plan,
  question,
  session,
  stageResult,
}) => {
  const { collected, graphRegistry, run } = stageResult;
  const graph = stageResult.checkpoint.graph;

  for (const entry of collected.entries) {
    if (entry.status !== "skipped") {
      session.markSkillSelected(graphRegistry.get(entry.skillId));
    }
  }

  const state = projectUnifiedGraphRun({
    graph,
    plan,
    registry: graphRegistry,
    run,
  });
  const loop = applyUnifiedGraphDocumentLoop({
    addTraceStep: session.addTraceStep,
    collected,
    docIds,
    executionLoop: session.executionLoop,
    graph,
    plan,
    recordExecutionGaps: session.recordExecutionGaps,
    recordWorkingMemoryClaimSupport: session.recordWorkingMemoryClaimSupport,
    recordWorkingMemoryGaps: session.recordWorkingMemoryGaps,
    registry: graphRegistry,
    resolveWorkingMemoryGaps: session.resolveWorkingMemoryGaps,
  });

  // As in V1, unresolved document evidence asks the user unless a Web node
  // already supplied the context the request needed.
  if (loop.documentEvidenceClarification && !loop.webAnswered) {
    return session.returnClarification(loop.documentEvidenceClarification);
  }

  return finalizeAgentRun({
    actionAnswer: null,
    addTraceStep: session.addTraceStep,
    arxivImportAnswer: null,
    buildAgentObservability: session.buildAgentObservability,
    customSkillGraphExecuted: state.customSkillGraphExecuted,
    customSkillResults: state.customSkillResults,
    customSkills: state.customSkills,
    discoveryAnswer: state.discoveryAnswer,
    docIds,
    documentRagSkill: state.documentRagSkill,
    getAgentSkills: session.getAgentSkills,
    getBudgetSnapshot: session.getBudgetSnapshot,
    inventoryAnswer: state.inventoryAnswer,
    plan,
    question,
    ragResult: state.ragResult,
    recordAgentTrace: session.recordAgentTrace,
    recordWorkingMemoryClaimSupport: session.recordWorkingMemoryClaimSupport,
    recordWorkingMemoryGaps: session.recordWorkingMemoryGaps,
    researchBrief: null,
    shouldRunWeb: state.shouldRunWeb,
    skippedWebBecauseBudget: false,
    trace: session.trace,
    webResult: state.webResult,
    workingMemory: session.workingMemory,
  });
};

const setUnifiedExecutionPlanner = (session, { graph, planner }) =>
  session.setExecutionPlanner?.({
    fallback: false,
    fallbackReason: null,
    requestedPlannerId: planner?.requestedPlannerId ?? null,
    selectedPlannerId: planner?.requestedPlannerId ?? null,
    status: "selected",
    stepIds: [],
    unifiedGraph: {
      nodeIds: graph.nodes.map((node) => node.nodeId),
      version: graph.version,
    },
  });

const identity = async (response) => response;

/**
 * The guarded v3 path of a fresh request. Returns `{ response }` when the
 * graph answered the request, or `{ fallback }` when it was refused before any
 * node ran and V1 must answer instead. Any error once the stage has written
 * its first checkpoint propagates: a graph that started never falls back.
 * `response` is the prepared response the finalization receipt sealed.
 */
export const runGuardedUnifiedAgentGraph = async ({
  accessScope,
  agentRunId,
  agentRunService,
  allowedCapabilityIds = [],
  baseCapabilityRegistry,
  capabilityApprovals = {},
  capabilityRegistry = baseCapabilityRegistry,
  docIds = [],
  experienceMemory = null,
  intentPlanner = null,
  plan,
  plannerAdapter = null,
  prepareResponse = identity,
  question,
  ragService,
  registry,
  reentry = false,
  retrievalPlan,
  runCursor = null,
  session,
  sessionId,
  stepLifecycle,
  taskMemory = null,
  userId,
} = {}) => {
  const recordEvent = (type, payload) =>
    agentRunService?.appendRunEvent?.({
      accessScope,
      runId: agentRunId,
      type,
      payload,
    });
  const fallback = async ({
    blockedNodeIds = [],
    errorCodes,
    graph = null,
    planner = null,
    supersedesSelection = false,
  }) => {
    const event = {
      blockedNodeIds,
      errorCodes,
      executed: false,
      fallback: "v1",
      graph: describeGraph(graph),
      mode: "guarded",
      planner,
      status: "rejected",
      ...(supersedesSelection ? { supersedes: "selected" } : {}),
    };

    session.addTraceStep({
      type: "unified_graph_fallback",
      label: "Unified Graph Fallback",
      status: "skipped",
      summary: `The unified graph was refused before any node ran (${errorCodes.join(", ") || "rejected"}); the V1 path answers this request.`,
      detail: {
        blockedNodeIds,
        errorCodes,
        fallback: "v1",
        mode: "guarded",
      },
    });
    await recordEvent(UNIFIED_GRAPH_RUN_EVENTS.planned, event);

    return { fallback: event, response: null };
  };

  // Re-entering an existing run is how an approved V1 pause continues. That
  // run already has a V1 path; approval continuation inside a graph is
  // frozen, so a re-entry never starts a graph.
  if (reentry) {
    return fallback({
      errorCodes: [UNIFIED_GRAPH_FALLBACK_REASON_CODES.approvalContinuationFrozen],
    });
  }

  if (
    !agentRunId ||
    typeof agentRunService?.getExecutionGraphCheckpoint !== "function" ||
    typeof agentRunService?.saveExecutionGraphCheckpoint !== "function" ||
    typeof agentRunService?.recordRunStep !== "function"
  ) {
    return fallback({
      errorCodes: [UNIFIED_GRAPH_FALLBACK_REASON_CODES.durableRuntimeUnavailable],
    });
  }

  const planned = await createUnifiedAgentExecutionGraphResult({
    accessScope,
    allowedCapabilityIds,
    budgetState: session.budgetState,
    capabilityRegistry: baseCapabilityRegistry,
    docIds,
    plan,
    plannerAdapter,
    question,
    ragService,
    registry,
    taskMemory,
  });

  if (!planned.graph) {
    return fallback({
      errorCodes: planned.errors.map((error) => error.code),
      planner: planned.planner,
    });
  }

  const admission = assessUnifiedGraphAdmission({
    accessScope,
    capabilityApprovals,
    capabilityRegistry: baseCapabilityRegistry,
    docIds,
    graph: planned.graph,
    plan,
    registry: planned.graphRegistry,
  });

  if (!admission.admitted) {
    return fallback({
      blockedNodeIds: admission.blockedNodeIds,
      errorCodes: admission.reasonCodes,
      graph: planned.graph,
      planner: planned.planner,
    });
  }

  // The graph takes the request unless the stage refuses it before its first
  // checkpoint write (see the header); from that write on it owns it.
  await recordEvent(UNIFIED_GRAPH_RUN_EVENTS.planned, {
    blockedNodeIds: [],
    errorCodes: [],
    executed: false,
    fallback: null,
    graph: describeGraph(planned.graph),
    mode: "guarded",
    planner: planned.planner,
    requestContext: buildUnifiedGraphRequestContext({ experienceMemory, intentPlanner }),
    status: "selected",
  });
  setUnifiedExecutionPlanner(session, {
    graph: planned.graph,
    planner: planned.planner,
  });

  let stageResult;

  try {
    stageResult = await runGuardedStageInvocation({
      accessScope,
      agentRunId,
      agentRunService,
      allowedCapabilityIds,
      baseCapabilityRegistry,
      capabilityApprovals,
      capabilityRegistry,
      docIds,
      graph: planned.graph,
      plan,
      question,
      ragService,
      recordEvent,
      registry,
      retrievalPlan,
      runCursor,
      session,
      sessionId,
      stepLifecycle,
      taskMemory,
      userId,
    });
  } catch (error) {
    if (error?.preExecution !== true) {
      throw error;
    }

    return fallback({
      errorCodes: [
        UNIFIED_GRAPH_FALLBACK_REASON_CODES.stageRefusedBeforeExecution,
        ...(Array.isArray(error.reasonCodes) ? error.reasonCodes : []),
      ],
      graph: planned.graph,
      planner: planned.planner,
      supersedesSelection: true,
    });
  }

  const response = await prepareResponse(await finalizeUnifiedGraph({
    docIds,
    plan,
    question,
    session,
    stageResult,
  }));

  await persistFinalizationReceipt({
    accessScope,
    agentRunService,
    checkpoint: stageResult.checkpoint,
    response,
    runCursor,
    runId: agentRunId,
  });

  return { fallback: null, response };
};

const runGuardedStageInvocation = ({
  accessScope,
  agentRunId,
  agentRunService,
  allowedCapabilityIds,
  baseCapabilityRegistry,
  capabilityApprovals,
  capabilityRegistry,
  docIds,
  graph,
  plan,
  question,
  ragService,
  recordEvent,
  registry,
  retrievalPlan,
  runCursor,
  session,
  sessionId,
  stepLifecycle,
  taskMemory,
  userId,
}) =>
  runUnifiedGraphStage({
    accessScope,
    addBudgetLimitTrace: session.addBudgetLimitTrace,
    addTraceStep: session.addTraceStep,
    agentRunId,
    allowedCapabilityIds,
    baseCapabilityRegistry,
    budgetState: session.budgetState,
    buildSkillTraceDetail: session.buildSkillTraceDetail,
    capabilityApprovals,
    capabilityRegistry,
    docIds,
    executeObservedSkill: session.executeObservedSkill,
    loadExecutionGraphCheckpoint: () =>
      agentRunService.getExecutionGraphCheckpoint({
        accessScope,
        ...(runCursor ? { runCursor } : {}),
        runId: agentRunId,
      }),
    plan,
    planned: { graph },
    question,
    ragService,
    recordExecutionGraph: (event) =>
      recordEvent(UNIFIED_GRAPH_RUN_EVENTS.executed, event),
    recordSkillResult: session.recordSkillResult,
    recordSkippedSkill: session.recordSkippedSkill,
    registry,
    retrievalPlan,
    saveExecutionGraphCheckpoint: (checkpoint) =>
      agentRunService.saveExecutionGraphCheckpoint({
        accessScope,
        checkpoint,
        ...(runCursor ? { runCursor } : {}),
        runId: agentRunId,
      }),
    sessionId,
    stepLifecycle,
    taskMemory,
    userId,
  });

const selectedSkillIdentity = (skills = []) =>
  skills.map((skill) => ({
    skillId: skill.skillId ?? skill.id,
    skillVersion: skill.skillVersion ?? skill.version,
  }));

/**
 * Continue a claimed v3 graph in a new process. Never re-plans: the stored
 * graph, owner, and receipts are the only inputs, and the live registry,
 * scope, and budget are rebuilt by trusted code and reconciled against them.
 *   * A finalization receipt completes the run with the stored response.
 *   * A completed graph without a receipt is finalized from its reused nodes.
 *   * A running graph resumes at its last node boundary; completed nodes are
 *     reused only when their typed-output digests reconcile, and unknown
 *     in-flight work or a pending node that would need an approval stays with
 *     an operator (the stage throws AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY).
 * A stored receipt needs no live Skill, so it is replayed before the live
 * catalog is compared: a deploy that bumps a Skill version cannot strand a
 * run whose answer is already sealed. A recomputed answer is prepared with
 * `prepareResponse` exactly as the uninterrupted request prepared it, and
 * sealed, before `complete` persists it under the recovery claim (agent.js
 * owns run completion).
 */
export const resumeUnifiedAgentGraphRun = async ({
  accessScope,
  agentRunService,
  capabilityRegistry = null,
  checkpoint,
  complete,
  prepareResponse = identity,
  ragService,
  run,
  runId,
  skillRegistry,
  webChatService,
} = {}) => {
  const owner = checkpoint?.owner;
  const plan = owner?.intentPlan;
  const claimId = checkpoint?.resumeClaim?.claimId;
  const runCursor = createAgentRunCursor();
  const currentRun = await agentRunService?.getRun?.({
    accessScope,
    runCursor,
    runId,
  }) ?? run;
  const docIds = currentRun?.input?.docIds;
  const question = normalizeText(currentRun?.goal);

  if (
    checkpoint?.version !== EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2 ||
    checkpoint?.graph?.version !== EXECUTION_GRAPH_VERSIONS.v3 ||
    !isRecord(owner) ||
    !isRecord(plan) ||
    !claimId ||
    typeof complete !== "function" ||
    !Array.isArray(docIds) ||
    !isRecord(currentRun?.plan) ||
    !Array.isArray(currentRun.plan.selectedSkills) ||
    !hasUnifiedGuardedGraphPath(currentRun) ||
    question !== owner.question ||
    !isDeepStrictEqual(docIds, owner.docIds) ||
    normalizeText(currentRun.plan.mode) !== normalizeText(plan.mode)
  ) {
    throw recoveryError("stored request, owner, or guarded graph path changed");
  }

  const loaded = await agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runCursor,
    runId,
  });

  if (loaded?.checkpoint?.digest !== checkpoint.digest) {
    throw recoveryError("checkpoint claim changed");
  }

  if (checkpoint.finalization !== undefined) {
    if (
      checkpoint.phase !== "completed" ||
      !verifyUnifiedGraphFinalizationReceipt(checkpoint.finalization)
    ) {
      throw recoveryError("finalization receipt is invalid");
    }

    await agentRunService.appendRunEvent?.({
      accessScope,
      runId,
      type: "unified_graph_finalization_replayed",
      payload: { answerDigest: checkpoint.finalization.answerDigest },
    });

    return complete({
      claimId,
      question,
      response: jsonCopy(checkpoint.finalization.response),
      runCursor,
      taskMemory: owner.taskMemory,
    });
  }

  const requestContext = findLatestPlannedEvent(currentRun)?.payload?.requestContext ?? {};
  const session = createAgentSession({
    agentBudget: owner.budget?.limits,
    docIds,
    experienceMemory: isRecord(requestContext.experienceMemory)
      ? requestContext.experienceMemory
      : null,
    intentPlanner: isRecord(requestContext.intentPlanner)
      ? requestContext.intentPlanner
      : undefined,
    plan,
    question,
    skillRegistry,
    taskMemory: owner.taskMemory,
  });

  if (
    !isDeepStrictEqual(
      selectedSkillIdentity(session.selectedSkills),
      selectedSkillIdentity(currentRun.plan.selectedSkills)
    )
  ) {
    throw recoveryError("intent-selected Skill catalog changed");
  }

  session.setAgentRetrievalPlan(owner.retrievalPlan);
  const graphSteps = (loaded.steps ?? []).filter(
    (step) => step.type === "graph_node" && step.status === "completed"
  );

  // A reused node is not traced or observed again by the scheduler. Put its
  // persisted receipt into this response's trace and its retrieval queries
  // into working memory before the pending nodes run, so the rebuilt state
  // matches an uninterrupted run.
  for (const step of graphSteps) {
    const skill = session.registry.get(step.input?.skillId);

    if (skill && step.input?.retrievalPlan) {
      session.recordWorkingMemoryQueries({
        phase: "primary",
        retrievalPlan: step.input.retrievalPlan,
        skill,
      });
    }

    const { id, type, label, status, summary, detail, input, output } = step;
    session.trace.push({ id, type, label, status, summary, detail, input, output });
  }

  const baseCapabilityRegistry =
    capabilityRegistry ??
    createDefaultCapabilityRegistry({ ragService, webChatService });
  const stepLifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService,
    runCursor,
    runId,
  });
  const stageResult = await runUnifiedGraphStage({
    accessScope,
    addBudgetLimitTrace: session.addBudgetLimitTrace,
    addTraceStep: session.addTraceStep,
    agentRunId: runId,
    allowFinalizationReplay: true,
    baseCapabilityRegistry,
    budgetState: session.budgetState,
    buildSkillTraceDetail: session.buildSkillTraceDetail,
    // Recovery cannot re-establish a request's standing approvals.
    capabilityApprovals: {},
    capabilityRegistry: baseCapabilityRegistry,
    docIds,
    executeObservedSkill: session.executeObservedSkill,
    expectedGraphResumeClaimId: claimId,
    loadExecutionGraphCheckpoint: () =>
      agentRunService.getExecutionGraphCheckpoint({ accessScope, runCursor, runId }),
    plan,
    question,
    ragService,
    recordExecutionGraph: (event) =>
      agentRunService.appendRunEvent?.({
        accessScope,
        runId,
        type: UNIFIED_GRAPH_RUN_EVENTS.executed,
        payload: event,
      }),
    recordSkillResult: session.recordSkillResult,
    recordSkippedSkill: session.recordSkippedSkill,
    registry: session.registry,
    resumeRun: currentRun,
    retrievalPlan: owner.retrievalPlan,
    saveExecutionGraphCheckpoint: (next) =>
      agentRunService.saveExecutionGraphCheckpoint({
        accessScope,
        checkpoint: next,
        runCursor,
        runId,
      }),
    sessionId: owner.sessionId,
    stepLifecycle,
    taskMemory: owner.taskMemory,
    userId: owner.userId,
  });

  for (const nodeRun of stageResult.run.nodeRuns) {
    if (nodeRun.status === "reused" && nodeRun.result) {
      session.recordSkillResult(nodeRun.result);
    }
  }

  setUnifiedExecutionPlanner(session, {
    graph: stageResult.checkpoint.graph,
    planner: {
      requestedPlannerId:
        findLatestPlannedEvent(currentRun)?.payload?.planner?.requestedPlannerId ?? null,
    },
  });

  const response = await prepareResponse(await finalizeUnifiedGraph({
    docIds,
    plan,
    question,
    session,
    stageResult,
  }), {
    question,
    taskMemory: owner.taskMemory,
    userId: owner.userId,
  });

  await persistFinalizationReceipt({
    accessScope,
    agentRunService,
    checkpoint: stageResult.checkpoint,
    response,
    runCursor,
    runId,
  });

  return complete({
    claimId,
    question,
    response,
    runCursor,
    taskMemory: owner.taskMemory,
  });
};
