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
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import {
  buildCapabilityApprovalClarification,
  createDefaultCapabilityRegistry,
} from "./capabilities/index.js";
import { createCapabilityGraphAdapter } from "./capabilities/graph-contract.js";
import {
  getAgentUnifiedGraphCapabilityIds,
  getAgentUnifiedGraphRollout,
} from "./config.js";

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
//
// An approval-gated Capability node parks the graph at its gate (the stage
// persists the gate, its private snapshot, and the paused checkpoint in one
// CAS) and the request returns V1's approval clarification without
// completing the run. The approval decision (the /agent-runs actions
// endpoint, or a background task's approval re-entry) continues the same
// graph through continueUnifiedAgentGraphAfterApproval and completes the run
// exactly like the uninterrupted request would have.

export const UNIFIED_GRAPH_RUN_EVENTS = Object.freeze({
  executed: "unified_graph_executed",
  planned: "unified_graph_planned",
});

export const UNIFIED_GRAPH_FALLBACK_REASON_CODES = Object.freeze({
  durableRuntimeUnavailable: "durable_runtime_unavailable",
  // A re-entry of a run that did not take the graph path (a V1 approval
  // pause resumed by a background task, for example) stays on V1. A paused
  // graph continues only through its own approval decision.
  reentryStaysOnV1: "reentry_stays_on_v1",
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
    actionAnswer: state.actionAnswer,
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
    fallback: planner?.fallback === true,
    fallbackReason: planner?.fallbackReason ?? null,
    requestedPlannerId: planner?.requestedPlannerId ?? null,
    selectedPlannerId: planner?.selectedPlannerId ?? planner?.requestedPlannerId ?? null,
    status: planner?.fallback === true ? "fallback" : "selected",
    stepIds: [],
    unifiedGraph: {
      nodeIds: graph.nodes.map((node) => node.nodeId),
      version: graph.version,
    },
  });

const identity = async (response) => response;

const isPersistedGraphApprovalPause = (error) =>
  isAgentRunInterrupt(error) && error.unifiedGraphApprovalPersisted === true;

// The same clarification V1 returns at a Capability approval gate, carrying
// the graph-bound gate (id and approval object hash) the approval endpoint
// takes.
const buildGraphApprovalPauseResponse = ({ error, session }) =>
  session.returnClarification(buildCapabilityApprovalClarification(error));

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
  // run already has a V1 path, so a re-entry never starts a graph. (A graph
  // paused at its own approval gate is continued by the approval decision,
  // continueUnifiedAgentGraphAfterApproval, and never reaches this point.)
  if (reentry) {
    return fallback({
      errorCodes: [UNIFIED_GRAPH_FALLBACK_REASON_CODES.reentryStaysOnV1],
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
    // The same pure admission the graph must pass below, so a planner with a
    // fallback (the model adapter) replaces an inadmissible proposal with the
    // deterministic graph before anything runs.
    assessGraph: ({ graph, graphRegistry }) =>
      assessUnifiedGraphAdmission({
        accessScope,
        capabilityApprovals,
        capabilityRegistry: baseCapabilityRegistry,
        docIds,
        graph,
        plan,
        registry: graphRegistry,
      }),
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
    if (isPersistedGraphApprovalPause(error)) {
      // The graph stopped at its approval gate: the gate, its private
      // snapshot, and the paused checkpoint are durable and the run waits
      // for the user. Nothing is finalized and no receipt is written.
      return {
        fallback: null,
        paused: true,
        response: await buildGraphApprovalPauseResponse({ error, session }),
        run: error.pausedRun ?? null,
      };
    }

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
    pauseExecutionGraphForApproval: bindGraphApprovalPause({ agentRunService, runCursor }),
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

// The run store's atomic pause (gate + private snapshot + paused checkpoint
// in one CAS), bound to the invocation's run cursor.
const bindGraphApprovalPause = ({ agentRunService, runCursor }) =>
  typeof agentRunService?.pauseExecutionGraphForApproval === "function"
    ? (args) =>
        agentRunService.pauseExecutionGraphForApproval({
          ...args,
          ...(runCursor ? { runCursor } : {}),
        })
    : null;

const selectedSkillIdentity = (skills = []) =>
  skills.map((skill) => ({
    skillId: skill.skillId ?? skill.id,
    skillVersion: skill.skillVersion ?? skill.version,
  }));

/**
 * Continue a stored v3 graph. Never re-plans: the stored graph, owner, and
 * receipts are the only inputs, and the live registry, scope, and budget are
 * rebuilt by trusted code and reconciled against them. Two callers:
 *   * a claimed startup recovery (`claimId`), after a crash;
 *   * the unclaimed worker an approval decision reopened
 *     (`approvalContinuation`), fenced exactly like a fresh request's worker.
 * Either may stop at the graph's approval gate again (a recovery that reaches
 * an approval-gated node not yet decided): the gate is persisted and the
 * approval clarification is returned without completing the run.
 */
const continueStoredUnifiedGraph = async ({
  accessScope,
  agentRunService,
  approvalContinuation = false,
  capabilityRegistry = null,
  checkpoint,
  claimId = null,
  complete,
  // The operator allowlist as configured now, not as sealed at planning.
  liveAllowedCapabilityIds = getAgentUnifiedGraphCapabilityIds(),
  prepareResponse = identity,
  ragService,
  run,
  runId,
  skillRegistry,
  webChatService,
} = {}) => {
  const owner = checkpoint?.owner;
  const plan = owner?.intentPlan;
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
    (approvalContinuation ? Boolean(claimId) : !claimId) ||
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
      approvalContinuation ||
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
  let stageResult;

  try {
    stageResult = await runUnifiedGraphStage({
      accessScope,
      addBudgetLimitTrace: session.addBudgetLimitTrace,
      addTraceStep: session.addTraceStep,
      agentRunId: runId,
      allowApprovalContinuation: approvalContinuation,
      allowFinalizationReplay: !approvalContinuation,
      // The Capability allowlist the graph was planned and sealed under (the
      // owner's catalog identity). Each adapter is still rebuilt from the live
      // Capability registry and must match the sealed version.
      allowedCapabilityIds: listOwnerCapabilityIds(owner),
      // What may still start is decided by the live operator allowlist: a
      // Capability revoked after planning (or after its gate was approved)
      // never runs, and the run goes to an operator.
      liveAllowedCapabilityIds,
      baseCapabilityRegistry,
      budgetState: session.budgetState,
      buildSkillTraceDetail: session.buildSkillTraceDetail,
      // Recovery cannot re-establish a request's standing approvals; a
      // graph-bound approval is read from the run store instead.
      capabilityApprovals: {},
      capabilityRegistry: baseCapabilityRegistry,
      docIds,
      executeObservedSkill: session.executeObservedSkill,
      expectedGraphResumeClaimId: claimId,
      getExecutionGraphApproval: (args) => agentRunService.getExecutionGraphApproval?.(args),
      loadExecutionGraphCheckpoint: () =>
        agentRunService.getExecutionGraphCheckpoint({ accessScope, runCursor, runId }),
      pauseExecutionGraphForApproval: bindGraphApprovalPause({ agentRunService, runCursor }),
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
  } catch (error) {
    if (!isPersistedGraphApprovalPause(error)) {
      throw error;
    }

    const response = await buildGraphApprovalPauseResponse({ error, session });

    return {
      ...response,
      body: {
        ...response.body,
        agentRunId: runId,
        agentRunStatus: error.pausedRun?.status ?? null,
        agentRunSteps: error.pausedRun?.steps ?? [],
      },
    };
  }

  for (const nodeRun of stageResult.run.nodeRuns) {
    if (nodeRun.status === "reused" && nodeRun.result) {
      session.recordSkillResult(nodeRun.result);
    }
  }

  setUnifiedExecutionPlanner(session, {
    graph: stageResult.checkpoint.graph,
    planner: findLatestPlannedEvent(currentRun)?.payload?.planner ?? null,
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

const listOwnerCapabilityIds = (owner) =>
  (Array.isArray(owner?.selectedSkills) ? owner.selectedSkills : [])
    .map((skill) => normalizeText(skill?.id))
    .filter((skillId) => skillId.startsWith("capability:"))
    .map((skillId) => skillId.slice("capability:".length));

/**
 * Continue a claimed v3 graph in a new process (startup recovery).
 *   * A finalization receipt completes the run with the stored response.
 *   * A completed graph without a receipt is finalized from its reused nodes.
 *   * A running graph resumes at its last node boundary; completed nodes are
 *     reused only when their typed-output digests reconcile, and unknown
 *     in-flight work or a pending node that would need a request-level grant
 *     stays with an operator (the stage throws
 *     AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY). An approved gate whose node
 *     has not started is read from the run store and runs once; a denied one
 *     is settled as skipped.
 * A stored receipt needs no live Skill, so it is replayed before the live
 * catalog is compared: a deploy that bumps a Skill version cannot strand a
 * run whose answer is already sealed. A recomputed answer is prepared with
 * `prepareResponse` exactly as the uninterrupted request prepared it, and
 * sealed, before `complete` persists it under the recovery claim (agent.js
 * owns run completion).
 */
export const resumeUnifiedAgentGraphRun = (options = {}) =>
  continueStoredUnifiedGraph({
    ...options,
    approvalContinuation: false,
    claimId: options.checkpoint?.resumeClaim?.claimId ?? null,
  });

export const UNIFIED_GRAPH_APPROVAL_ERROR_CODES = Object.freeze({
  capabilityNotAllowed: "graph_approval_capability_not_allowed",
  notAwaitingApproval: "graph_approval_not_pending",
  rolloutNotGuarded: "unified_graph_rollout_not_guarded",
  staleCapability: "graph_approval_stale",
});

// Manual-recovery reasons of a decision the current configuration forbids.
// The approval CAS refuses a run marked manual, so neither the user nor a
// later configuration change can reopen it behind the operator's back.
export const UNIFIED_GRAPH_APPROVAL_OPERATOR_REASONS = Object.freeze({
  capabilityNotAllowed: "unified_graph_capability_not_allowed",
  rolloutNotGuarded: "unified_graph_rollout_not_guarded",
});

const approvalError = (code, message, status = 409) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

/** A v3 graph checkpoint parked at its approval gate. */
export const isUnifiedGraphAwaitingApproval = (checkpoint) =>
  checkpoint?.version === EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2 &&
  checkpoint.graph?.version === EXECUTION_GRAPH_VERSIONS.v3 &&
  checkpoint.phase === "awaiting_approval" &&
  isRecord(checkpoint.approvalBoundary);

/**
 * A re-entry into a graph parked at its gate that decides nothing about that
 * gate (a background task's `continue`, whose new text cannot be answered
 * without the gate's decision) gets the same approval clarification again,
 * built from the stored pending gate. Nothing is written: the run keeps
 * waiting with its one pending gate, so the caller (a task) keeps its gate
 * and can still approve or deny it.
 */
export const restateUnifiedGraphApprovalPause = async ({
  accessScope,
  agentRunService,
  checkpoint,
  runId,
  skillRegistry,
} = {}) => {
  const run = await agentRunService?.getRun?.({ accessScope, runId });
  const owner = checkpoint?.owner;
  const pendingGates = (Array.isArray(run?.approvalGates) ? run.approvalGates : [])
    .filter((gate) => gate?.status === "pending");

  if (
    !isUnifiedGraphAwaitingApproval(checkpoint) ||
    run?.status !== "waiting_for_user" ||
    pendingGates.length !== 1 ||
    pendingGates[0].id !== checkpoint.approvalBoundary.gateId ||
    !isRecord(owner?.intentPlan)
  ) {
    throw approvalError(
      UNIFIED_GRAPH_APPROVAL_ERROR_CODES.notAwaitingApproval,
      "No pending graph approval matches this gate."
    );
  }

  const session = createAgentSession({
    agentBudget: owner.budget?.limits,
    docIds: Array.isArray(run.input?.docIds) ? run.input.docIds : [],
    plan: owner.intentPlan,
    question: normalizeText(run.goal),
    skillRegistry,
    taskMemory: owner.taskMemory,
  });
  const response = await buildGraphApprovalPauseResponse({
    error: { detail: { approvalGate: pendingGates[0] } },
    session,
  });

  return {
    ...response,
    body: {
      ...response.body,
      agentRunId: runId,
      agentRunStatus: run.status,
      agentRunSteps: run.steps ?? [],
    },
  };
};

/**
 * Decide a guarded v3 graph's approval gate and continue the same graph.
 *
 * Before anything is decided, the gate must be the graph's pending boundary,
 * the rollout must still be `guarded`, and for an approval the Capability
 * must still be on the live operator allowlist (AGENT_UNIFIED_GRAPH_CAPABILITIES,
 * not the list sealed at planning) and still be the version the user
 * approved. A rollback or a revoked Capability marks the run for manual
 * recovery (no claim; the run stays waiting and is listed for an operator)
 * before the request is refused, as startup recovery does. The decision itself
 * is one run-store CAS (applyExecutionGraphApprovalAction: approval object
 * hash, private snapshot, graph binding). The same graph then continues from
 * its checkpoint: approved, the node runs once with the approved input and
 * its dependants and the whole-run finalization follow; denied, the node is
 * settled as `approval_denied`, its dependants are skipped, and the request
 * is finalized without it. A continuation that fails after the decision
 * leaves no running work behind (the scheduler awaits every in-flight node):
 * a partial graph fails the run like a fresh request's; anything else hands
 * it to an operator. A process that dies inside the approved node leaves a
 * running step, which startup reconciliation never replays.
 */
export const continueUnifiedAgentGraphAfterApproval = async ({
  accessScope,
  action,
  agentRunService,
  capabilityRegistry = null,
  complete,
  gateId = "",
  liveAllowedCapabilityIds = getAgentUnifiedGraphCapabilityIds(),
  payload = {},
  prepareResponse = identity,
  ragService,
  runId,
  skillRegistry,
  webChatService,
} = {}) => {
  const normalizedAction = normalizeText(action).toLowerCase();
  const loaded = await agentRunService?.getExecutionGraphCheckpoint?.({ accessScope, runId });
  const checkpoint = loaded?.checkpoint;
  const normalizedGateId = normalizeText(gateId) || normalizeText(payload?.gateId);

  if (
    !isUnifiedGraphAwaitingApproval(checkpoint) ||
    checkpoint.approvalBoundary.gateId !== normalizedGateId
  ) {
    throw approvalError(
      UNIFIED_GRAPH_APPROVAL_ERROR_CODES.notAwaitingApproval,
      "No pending graph approval matches this gate."
    );
  }

  const handToOperator = (reason) =>
    agentRunService.markManualRecovery?.({
      accessScope,
      recovery: { reason, recoveredAt: new Date().toISOString() },
      runId,
    });

  if (getAgentUnifiedGraphRollout() !== "guarded") {
    await handToOperator(UNIFIED_GRAPH_APPROVAL_OPERATOR_REASONS.rolloutNotGuarded);
    throw approvalError(
      UNIFIED_GRAPH_APPROVAL_ERROR_CODES.rolloutNotGuarded,
      "The unified graph rollout is no longer guarded; an operator must resolve this run."
    );
  }

  if (
    normalizedAction === "approve" &&
    !(Array.isArray(liveAllowedCapabilityIds) ? liveAllowedCapabilityIds : [])
      .map((id) => normalizeText(id))
      .includes(checkpoint.approvalBoundary.capabilityId)
  ) {
    // The operator revoked this Capability after the gate was shown. A
    // denial still settles the graph without it; an approval must not run it.
    await handToOperator(UNIFIED_GRAPH_APPROVAL_OPERATOR_REASONS.capabilityNotAllowed);
    throw approvalError(
      UNIFIED_GRAPH_APPROVAL_ERROR_CODES.capabilityNotAllowed,
      "The approved Capability is no longer allowed for the unified graph; an operator must resolve this run."
    );
  }

  const baseCapabilityRegistry =
    capabilityRegistry ??
    createDefaultCapabilityRegistry({ ragService, webChatService });

  if (normalizedAction === "approve") {
    // The user approved one exact object: this Capability version on this
    // input. A deploy that changed the Capability since the gate was shown
    // makes that approval stale; refuse before deciding anything.
    const live = createCapabilityGraphAdapter({
      capabilityId: checkpoint.approvalBoundary.capabilityId,
      capabilityRegistry: baseCapabilityRegistry,
    });

    if (!live || live.version !== checkpoint.approvalBoundary.capabilityVersion) {
      throw approvalError(
        UNIFIED_GRAPH_APPROVAL_ERROR_CODES.staleCapability,
        "The approved Capability changed since the approval was requested."
      );
    }
  }

  const decided = await agentRunService.applyExecutionGraphApprovalAction({
    accessScope,
    action: normalizedAction,
    gateId: normalizedGateId,
    payload,
    runId,
  });

  try {
    return await continueStoredUnifiedGraph({
      accessScope,
      agentRunService,
      approvalContinuation: true,
      capabilityRegistry: baseCapabilityRegistry,
      checkpoint: decided.checkpoint,
      claimId: null,
      complete,
      liveAllowedCapabilityIds,
      prepareResponse,
      ragService,
      run: decided.run,
      runId,
      skillRegistry,
      webChatService,
    });
  } catch (error) {
    if (error?.code === "AGENT_GRAPH_EXECUTION_FENCED") {
      // Another worker owns the graph now; never race it.
      throw error;
    }

    if (error?.code === "AGENT_UNIFIED_GRAPH_PARTIAL") {
      await agentRunService.failRun?.({
        accessScope,
        error,
        graphResumeClaimId: null,
        runId,
      });
    } else {
      await agentRunService.markManualRecovery?.({
        accessScope,
        recovery: {
          reason: "graph_approval_continuation_failed",
          recoveredAt: new Date().toISOString(),
        },
        runId,
      });
    }

    throw error;
  }
};
