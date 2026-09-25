import { createAgentSession } from "./agent-bootstrap.js";
import { isDeepStrictEqual } from "node:util";
import {
  createAgentExecutionPlanResult,
  deterministicPlannerAdapter,
} from "./agent-execution-plan.js";
import { runAgentExecutionPlan } from "./agent-execution-plan-runner.js";
import { createAgentRunStepLifecycle } from "./agent-run-step-lifecycle.js";
import {
  buildAgentExperienceMemoryWriteObservability,
  createAgentExperienceMemoryUnavailableContext,
  createAgentExperienceMemoryWriteErrorResult,
  getAgentExperienceMemoryContext,
  recordAgentExperienceFromRun,
} from "./agent-experience-memory.js";
import { finalizeAgentRun } from "./agent-finalization-flow.js";
import {
  createAgentIntentPlanResult,
  deterministicIntentPlannerAdapter,
} from "./agent-intent-planner.js";
import { prepareAgentRun } from "./agent-preparation-flow.js";
import { AGENT_RUN_STATUSES } from "./agent-runs.js";
import {
  getAgentRunInterruptPrivateDetail,
  isAgentRunInterrupt,
} from "./agent-interrupts.js";
import {
  buildCapabilityApprovalClarification,
  createDefaultCapabilityRegistry,
} from "./capabilities/index.js";
import {
  buildAgentTaskPlanningContext,
} from "./agent-task-memory.js";
import {
  attachApprovalGateStepIds,
  buildAgentRunStepsFromTrace,
} from "./agent-run-steps.js";
import { normalizeText } from "../lib/normalize-text.js";
import {
  getAgentSkillGraphRollout,
  getAgentUnifiedGraphRollout,
} from "./config.js";
import { listAuthorizedAtomicCustomSkills } from "./skills/authorized-catalog.js";
import { runCustomSkillStage } from "./agent-custom-skill-stage.js";
import {
  createRunUsage,
  resolveRunUsageLimits,
  runWithRunUsage,
} from "./run-usage.js";
import {
  GEN_AI_ATTRIBUTES,
  GEN_AI_OPERATIONS,
  markSpanFailed,
  setActiveSpanAttributes,
  setSpanAttributes,
  withSpan,
} from "./tracing.js";
import { observeUnifiedAgentGraphShadow } from "./agent-unified-graph-shadow.js";

const getSkillDescriptor = (skill = {}) => ({
  skillId: skill.id,
  skillVersion: skill.version,
  label: skill.label,
  budgetKey: skill.budgetKey ?? null,
});

const getTaskContinuationCandidates = ({ question = "", taskMemory = null } = {}) => {
  const currentQuestion = normalizeText(question).toLowerCase();

  return (taskMemory?.nextCandidates ?? [])
    .map(normalizeText)
    .filter((candidate) => candidate && candidate.toLowerCase() !== currentQuestion);
};

const attachAgentTaskContinuation = ({
  question,
  response = {},
  taskMemory = null,
} = {}) => {
  const body = response.body ?? {};

  if (
    !taskMemory ||
    response.status >= 400 ||
    body.clarification?.needed === true ||
    body.agentTask?.continue !== undefined
  ) {
    return response;
  }

  const nextCandidates = getTaskContinuationCandidates({
    question,
    taskMemory,
  });
  const nextQuestion = nextCandidates[0] ?? "";

  if (!nextQuestion) {
    return response;
  }

  return {
    ...response,
    body: {
      ...body,
      agentTask: {
        continue: true,
        nextCandidates,
        nextQuestion,
      },
    },
  };
};

const extractApprovalGates = (trace = []) =>
  trace
    .filter(
      (step) =>
        step.status === "needs_input" ||
        String(step.type ?? "").includes("approval")
    )
    .map((step) => ({
      id: step.id,
      type: step.type,
      label: step.label,
      status: step.status,
      summary: step.summary,
      detail: step.detail ?? null,
    }));

const attachAgentRunId = (response, runId) =>
  runId
    ? {
        ...response,
        body: {
          ...response.body,
          agentRunId: runId,
        },
      }
    : response;

const attachAgentRunSnapshot = (response, run) =>
  run
    ? {
        ...response,
        body: {
          ...response.body,
          agentRunId: run.runId ?? response.body?.agentRunId,
          agentRunStatus: run.status,
          agentRunSteps: run.steps ?? [],
        },
      }
    : response;

const getGateKey = (gate = {}) => gate.id ?? `${gate.type}:${gate.capabilityId}`;

const mergeApprovalGates = (...gateLists) => {
  const gatesById = new Map();

  for (const gate of gateLists.flat()) {
    if (!gate || typeof gate !== "object") {
      continue;
    }

    gatesById.set(getGateKey(gate), {
      ...(gatesById.get(getGateKey(gate)) ?? {}),
      ...gate,
    });
  }

  return [...gatesById.values()];
};

const buildRunCompletionPayload = (
  response = {},
  existingRun = {},
  { approvalSnapshots = [] } = {}
) => {
  const body = response.body ?? {};
  const agentObservability = body.agentObservability ?? {};
  const steps = buildAgentRunStepsFromTrace({
    existingSteps: existingRun.steps ?? [],
    trace: body.agentTrace ?? [],
  });
  const status =
    response.status >= 400
      ? AGENT_RUN_STATUSES.failed
      : body.clarification?.needed
        ? AGENT_RUN_STATUSES.waitingForUser
        : AGENT_RUN_STATUSES.completed;

  return {
    approvalSnapshots,
    approvalGates: attachApprovalGateStepIds({
      gates: mergeApprovalGates(
        existingRun.approvalGates ?? [],
        (body.approvalGates ?? []).length > 0
          ? body.approvalGates
          : extractApprovalGates(body.agentTrace)
      ),
      steps,
    }),
    decisions: [
      {
        type: "agent_mode",
        value: body.agentMode,
      },
      {
        type: "execution_planner",
        value: agentObservability.executionPlanner ?? null,
      },
      {
        type: "intent_planner",
        value: agentObservability.intentPlanner ?? null,
      },
    ],
    observations: agentObservability.skills ?? [],
    result: {
      agentMode: body.agentMode,
      answer: body.agentAnswer,
      citationCount: body.ragSources?.length ?? 0,
      ragAbstained: Boolean(body.ragAbstained),
      status: response.status,
    },
    status,
    steps,
  };
};

const completeRecordedRun = async ({
  accessScope,
  agentRunService,
  approvalSnapshots = [],
  graphResumeClaimId = null,
  response,
  runId,
} = {}) => {
  if (!agentRunService || !runId) {
    return;
  }

  const existingRun = await agentRunService.getRun?.({
    accessScope,
    runId,
  });

  return agentRunService.completeRun({
    accessScope,
    graphResumeClaimId,
    runId,
    ...buildRunCompletionPayload(response, existingRun ?? {}, {
      approvalSnapshots,
    }),
  });
};

const loadAgentExperienceMemorySafely = async ({
  accessScope,
  docIds,
  question,
  userId,
} = {}) => {
  try {
    return await getAgentExperienceMemoryContext({
      accessScope,
      docIds,
      question,
      userId,
    });
  } catch (error) {
    console.error("Failed to load agent experience memory.", error);

    return createAgentExperienceMemoryUnavailableContext({
      error: error instanceof Error ? error.message : "load_failed",
      reason: "load_failed",
      status: "error",
    });
  }
};

const recordAgentExperienceSafely = async ({
  accessScope,
  question,
  response,
  userId,
} = {}) => {
  try {
    return await recordAgentExperienceFromRun({
      accessScope,
      question,
      response,
      userId,
    });
  } catch (error) {
    console.error("Failed to record agent experience memory.", error);
    return createAgentExperienceMemoryWriteErrorResult(error);
  }
};

const attachAgentExperienceMemoryWrite = (response = {}, writeResult = {}) => {
  const body = response.body ?? {};
  const agentObservability = body.agentObservability ?? {};
  const experienceMemory = agentObservability.experienceMemory ?? {};
  const write =
    writeResult.observability ??
    buildAgentExperienceMemoryWriteObservability(writeResult);

  return {
    ...response,
    body: {
      ...body,
      agentObservability: {
        ...agentObservability,
        experienceMemory: {
          ...experienceMemory,
          storedCount: write.storedCount,
          write,
          writeAttempted: write.writeAttempted,
          writeSkippedReason: write.skippedReason,
        },
      },
    },
  };
};

const completeRecordedRunAndExperience = async ({
  accessScope,
  agentRunService,
  approvalSnapshots = [],
  question,
  response,
  runId,
  taskMemory,
  userId,
} = {}) => {
  const responseWithTaskContinuation = attachAgentTaskContinuation({
    question,
    response,
    taskMemory,
  });
  const writeResult = await recordAgentExperienceSafely({
    accessScope,
    question,
    response: responseWithTaskContinuation,
    userId,
  });
  const responseWithExperienceMemory = attachAgentExperienceMemoryWrite(
    responseWithTaskContinuation,
    writeResult
  );

  const completedRun = await completeRecordedRun({
    accessScope,
    agentRunService,
    approvalSnapshots,
    graphResumeClaimId: null,
    response: responseWithExperienceMemory,
    runId,
  });

  return attachAgentRunSnapshot(responseWithExperienceMemory, completedRun);
};

const withCapabilityApprovals = (capabilityRegistry, approvals = {}) => {
  if (!capabilityRegistry || Object.keys(approvals).length === 0) {
    return capabilityRegistry;
  }

  return {
    ...capabilityRegistry,
    execute: (capabilityId, payload = {}) =>
      capabilityRegistry.execute(capabilityId, {
        ...payload,
        approval: payload.approval ?? approvals[capabilityId] ?? approvals["*"],
      }),
  };
};

const createGraphResumeError = (reason) => {
  const error = new Error(`Execution graph cannot be resumed: ${reason}.`);
  error.code = "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY";
  error.status = 409;
  return error;
};

/**
 * Continue only the persisted custom_skills stage. In particular this does
 * not call the Intent Planner, query planner, preparation flow, or outer
 * Execution Planner. A startup worker must first own the persisted CAS claim
 * and must never use the general runAgentRag re-entry path for this job.
 */
const resumeAgentExecutionGraphRunInScope = async ({
  accessScope,
  agentRunService,
  checkpoint,
  ragService,
  replanAdapter = null,
  run,
  runId,
  skillRegistry,
} = {}) => {
  const owner = checkpoint?.owner;
  const docIds = run?.input?.docIds;
  const question = normalizeText(run?.goal);
  const plan = owner?.intentPlan;
  const latestOuterPlan = (run?.events ?? [])
    .filter((event) => event.type === "execution_planned")
    .at(-1)?.payload?.planner;

  if (
    checkpoint?.version !== "v1" ||
    !["v1", "v2"].includes(checkpoint?.graph?.version) ||
    !owner ||
    !plan ||
    !Array.isArray(docIds) ||
    !run?.plan ||
    !Array.isArray(run.plan.selectedSkills) ||
    !isDeepStrictEqual(latestOuterPlan?.stepIds, ["custom_skills"]) ||
    question !== owner.question ||
    !isDeepStrictEqual(docIds, owner.docIds) ||
    normalizeText(run.plan.mode) !== normalizeText(plan.mode) ||
    normalizeText(run.plan.summary) !== normalizeText(plan.summary) ||
    !checkpoint.resumeClaim?.claimId
  ) {
    throw createGraphResumeError("stored request or outer plan changed");
  }

  const loaded = await agentRunService?.getExecutionGraphCheckpoint?.({
    accessScope,
    runId,
  });

  if (loaded?.checkpoint?.digest !== checkpoint.digest) {
    throw createGraphResumeError("checkpoint claim changed");
  }

  const session = createAgentSession({
    agentBudget: owner.budget?.limits,
    docIds,
    plan,
    question,
    skillRegistry,
    taskMemory: owner.taskMemory,
  });
  const selectedIdentity = session.selectedSkills.map((skill) => ({
    skillId: skill.id,
    skillVersion: skill.version,
  }));
  const storedIdentity = run.plan.selectedSkills.map((skill) => ({
    skillId: skill.skillId,
    skillVersion: skill.skillVersion,
  }));

  if (!isDeepStrictEqual(selectedIdentity, storedIdentity)) {
    throw createGraphResumeError("intent-selected Skill catalog changed");
  }

  const authorizedCustomSkills = listAuthorizedAtomicCustomSkills({
    accessScope,
    docIds,
    ragService,
    registry: session.registry,
  });

  if (authorizedCustomSkills.length === 0) {
    throw createGraphResumeError("document scope or atomic Skill catalog unavailable");
  }

  session.setExecutionPlanner(latestOuterPlan);
  session.setAgentRetrievalPlan(owner.retrievalPlan);
  const {
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildAgentObservability,
    buildSkillTraceDetail,
    executeObservedSkill,
    getAgentSkills,
    getBudgetSnapshot,
    markSkillSelected,
    recordAgentTrace,
    recordSkillResult,
    recordSkippedSkill,
    recordWorkingMemoryClaimSupport,
    recordWorkingMemoryGaps,
    trace,
    workingMemory,
  } = session;

  // A completed node is reused by the scheduler and is not traced again.
  // Include its persisted step once in the response trace while the run store
  // remains the lifecycle source of truth.
  trace.push(
    ...(run.steps ?? [])
      .filter(
        (step) =>
          step.type === "custom_skill" &&
          step.status === "completed" &&
          String(step.id).startsWith("custom_skill:")
      )
      .map(({ id, type, label, status, summary, detail, input, output }) => ({
        id,
        type,
        label,
        status,
        summary,
        detail,
        input,
        output,
      }))
  );

  let graphEvent = null;
  const results = await runCustomSkillStage({
    accessScope,
    addBudgetLimitTrace,
    addTraceStep,
    authorizedCustomSkills,
    authorizedDocIds: docIds,
    budgetState,
    buildSkillTraceDetail,
    customSkills: session.selectedSkills.filter((skill) => skill.kind === "custom"),
    docIds,
    executeObservedSkill,
    expectedGraphResumeClaimId: checkpoint.resumeClaim.claimId,
    loadExecutionGraphCheckpoint: () =>
      agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }),
    mode: "guarded",
    plan,
    question,
    ragService,
    recordExecutionGraph: (event) => { graphEvent = event; },
    recordSkillResult,
    recordSkippedSkill,
    registry: session.registry,
    replanAdapter,
    retrievalPlan: owner.retrievalPlan,
    saveExecutionGraphCheckpoint: (nextCheckpoint) =>
      agentRunService.saveExecutionGraphCheckpoint({
        accessScope,
        checkpoint: nextCheckpoint,
        runId,
      }),
    sessionId: owner.sessionId,
    stepLifecycle: createAgentRunStepLifecycle({
      accessScope,
      agentRunService,
      runId,
    }),
    taskMemory: owner.taskMemory,
    userId: owner.userId,
  });

  if (!graphEvent?.executed || graphEvent.mode !== "guarded") {
    throw createGraphResumeError("graph continuation did not execute");
  }

  for (const result of results) {
    markSkillSelected(session.registry.get(result.skillId));
    recordSkillResult(result);
  }

  await agentRunService.appendRunEvent?.({
    accessScope,
    runId,
    type: "skill_graph_planned",
    payload: graphEvent,
  });

  const response = attachAgentRunId(
    await finalizeAgentRun({
      addTraceStep,
      buildAgentObservability,
      customSkillResults: results,
      customSkillGraphExecuted: true,
      customSkills: session.selectedSkills.filter((skill) => skill.kind === "custom"),
      docIds,
      getAgentSkills,
      getBudgetSnapshot,
      plan,
      question,
      recordAgentTrace,
      recordWorkingMemoryClaimSupport,
      recordWorkingMemoryGaps,
      trace,
      workingMemory,
    }),
    runId
  );
  const responseWithContinuation = attachAgentTaskContinuation({
    question,
    response,
    taskMemory: owner.taskMemory,
  });
  const completedRun = await completeRecordedRun({
    accessScope,
    agentRunService,
    graphResumeClaimId: checkpoint.resumeClaim.claimId,
    response: responseWithContinuation,
    runId,
  });

  return attachAgentRunSnapshot(responseWithContinuation, completedRun);
};

// A planner span carries which planner answered and whether it fell back;
// never the question or the plan text.
const withPlannerSpan = (kind, plan) =>
  withSpan(`agent.plan ${kind}`, { "agent.planner.kind": kind }, async (span) => {
    const result = await plan();

    setSpanAttributes(span, {
      "agent.planner.fallback": Boolean(result?.planner?.fallback),
      "agent.planner.id": result?.planner?.selectedPlannerId,
    });

    return result;
  });

const withAgentRunSpan = (attributes, run) =>
  withSpan(
    `${GEN_AI_OPERATIONS.invokeAgent} archive_rag`,
    {
      ...attributes,
      [GEN_AI_ATTRIBUTES.agentName]: "archive_rag",
      [GEN_AI_ATTRIBUTES.operationName]: GEN_AI_OPERATIONS.invokeAgent,
    },
    async (span) => {
      const response = await run();
      const body = response?.body ?? {};
      const runUsage = body.agentObservability?.budget?.run;

      setSpanAttributes(span, {
        "agent.mode": body.agentMode,
        "agent.response.status": response?.status,
        "agent.run.id": body.agentRunId,
        "agent.usage.exhausted": runUsage?.exhausted,
        "agent.usage.model_calls": runUsage?.used?.modelCalls,
        "agent.usage.tokens": runUsage?.used?.tokens,
      });

      if (Number(response?.status) >= 500) {
        markSpanFailed(span, `agent run answered ${response.status}`);
      }

      return response;
    }
  );

const runAgentRagInScope = async ({
  agentBudget,
  agentRunService,
  arxivImportService,
  capabilityRegistry,
  ragService,
  webChatService,
  question,
  docIds,
  sessionId,
  userId,
  accessScope,
  agentRunId: requestedAgentRunId,
  capabilityApprovals = {},
  taskMemory = null,
  dagPlannerAdapter = null,
  executionPlannerAdapter,
  intentPlannerAdapter,
  replanAdapter = null,
  skillRegistry,
  unifiedGraphPlannerAdapter = null,
}) => {
  const taskMemoryContext = taskMemory
    ? buildAgentTaskPlanningContext(taskMemory)
    : null;
  const agentExperienceMemory = await loadAgentExperienceMemorySafely({
    accessScope,
    docIds,
    question,
    userId,
  });
  const intentPlanResult = await withPlannerSpan("intent", () =>
    createAgentIntentPlanResult({
      docIds,
      experienceMemory: agentExperienceMemory,
      fallbackPlannerAdapter: deterministicIntentPlannerAdapter,
      plannerAdapter: intentPlannerAdapter ?? deterministicIntentPlannerAdapter,
      question,
      taskMemory: taskMemoryContext,
    })
  );
  const {
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildAgentObservability,
    buildSkillTraceDetail,
    chainSkills,
    executeObservedSkill,
    executionLoop,
    getAgentSkills,
    getBudgetSnapshot,
    getSelectedSkill,
    markSkillSelected,
    plan,
    recordAgentTrace,
    recordExecutionGaps,
    recordSkillResult,
    recordSkippedSkill,
    recordWorkingMemoryClaimSupport,
    recordWorkingMemoryGaps,
    registry,
    resolveWorkingMemoryGaps,
    returnClarification,
    selectedSkills,
    setExecutionPlanner,
    setAgentRetrievalPlan,
    trace,
    workingMemory,
  } = createAgentSession({
    agentBudget,
    docIds,
    experienceMemory: agentExperienceMemory,
    intentPlanner: intentPlanResult.planner,
    plan: intentPlanResult.plan,
    question,
    skillRegistry,
    taskMemory: taskMemoryContext,
  });
  const skillGraphMode = getAgentSkillGraphRollout();
  const authorizedCustomSkills = skillGraphMode !== "off"
    ? listAuthorizedAtomicCustomSkills({
        accessScope,
        docIds,
        ragService,
        registry,
      })
    : [];
  const runSnapshot = {
    input: {
      docIds,
      sessionId,
      userId,
    },
    plan: {
      mode: plan.mode,
      summary: plan.summary,
      selectedSkills: selectedSkills.map(getSkillDescriptor),
    },
  };
  const agentRun = requestedAgentRunId
    ? await agentRunService?.updateRun?.({
        accessScope,
        graphReentryGuard: true,
        runId: requestedAgentRunId,
        patch: {
          ...runSnapshot,
          status: AGENT_RUN_STATUSES.running,
        },
      })
    : await agentRunService?.createRun?.({
        accessScope,
        goal: question,
        runId: requestedAgentRunId,
        ...runSnapshot,
      });
  const agentRunId = agentRun?.runId ?? requestedAgentRunId ?? null;
  // Tagged as soon as the run exists, so a run that later throws can still be
  // found from its trace.
  setActiveSpanAttributes({ "agent.run.id": agentRunId });
  const stepLifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService,
    runId: agentRunId,
  });
  const baseCapabilityRegistry =
    capabilityRegistry ??
    createDefaultCapabilityRegistry({
      arxivImportService,
      ragService,
      webChatService,
    });
  const effectiveCapabilityRegistry = withCapabilityApprovals(
    baseCapabilityRegistry,
    capabilityApprovals
  );

  if (requestedAgentRunId && agentRunId) {
    await agentRunService?.appendRunEvent?.({
      accessScope,
      runId: agentRunId,
      type: "run_resumed",
      payload: {
        approvedCapabilities: Object.keys(capabilityApprovals),
      },
    });
  }

  try {
    const preparationResult = await prepareAgentRun({
      addTraceStep,
      chainSkills,
      docIds,
      getBudgetSnapshot,
      plan,
      question,
      returnClarification,
      selectedSkills,
      setAgentRetrievalPlan,
    });

    await agentRunService?.appendRunEvent?.({
      accessScope,
      runId: agentRunId,
      type: "run_prepared",
      payload: {
        traceStepCount: trace.length,
      },
    });

    if (preparationResult.response) {
      const response = attachAgentRunId(preparationResult.response, agentRunId);

      return completeRecordedRunAndExperience({
        accessScope,
        agentRunService,
        question,
        response,
        runId: agentRunId,
        taskMemory: taskMemoryContext,
        userId,
      });
    }

    const agentRetrievalPlan = preparationResult.agentRetrievalPlan;
    if (getAgentUnifiedGraphRollout() === "shadow") {
      await observeUnifiedAgentGraphShadow({
        accessScope,
        addTraceStep,
        budgetState,
        capabilityRegistry: effectiveCapabilityRegistry,
        docIds,
        plan,
        plannerAdapter: unifiedGraphPlannerAdapter,
        question,
        ragService,
        record: (payload) => agentRunService?.appendRunEvent?.({
          accessScope,
          runId: agentRunId,
          type: "unified_graph_planned",
          payload,
        }),
        registry,
        taskMemory: taskMemoryContext,
      });
    }
    const executionPlanResult = await withPlannerSpan("execution", () =>
      createAgentExecutionPlanResult({
        accessScope,
        authorizedCustomSkills,
        fallbackPlannerAdapter: deterministicPlannerAdapter,
        plannerAdapter: executionPlannerAdapter ?? deterministicPlannerAdapter,
        plannerContext: {
          authorizedCustomSkills,
          docIds,
          plan,
          question,
          selectedSkills,
          taskMemory: taskMemoryContext,
        },
        registry,
        selectedSkills,
      })
    );
    setExecutionPlanner(executionPlanResult.planner);

    await agentRunService?.appendRunEvent?.({
      accessScope,
      runId: agentRunId,
      type: "execution_planned",
      payload: {
        planner: executionPlanResult.planner,
      },
    });

    const executionResult = await runAgentExecutionPlan({
      accessScope,
      addBudgetLimitTrace,
      addTraceStep,
      agentRunId,
      authorizedCustomSkills,
      budgetState,
      arxivImportService,
      buildSkillTraceDetail,
      capabilityRegistry: effectiveCapabilityRegistry,
      dagPlannerAdapter,
      docIds,
      executeObservedSkill,
      executionLoop,
      executionPlan: executionPlanResult.executionPlan,
      getSelectedSkill,
      loadExecutionGraphCheckpoint: agentRunId && agentRunService?.getExecutionGraphCheckpoint
        ? () => agentRunService.getExecutionGraphCheckpoint({ accessScope, runId: agentRunId })
        : null,
      plan,
      question,
      ragService,
      recordExecutionGaps,
      recordExecutionGraph: (executionGraph) => {
        if (executionGraph?.mode === "guarded" && executionGraph?.executed) {
          for (const nodeRun of executionGraph.nodeRuns ?? []) {
            if (["completed", "failed", "reused"].includes(nodeRun.status)) {
              markSkillSelected(registry.get(nodeRun.skillId));
            }
          }
        }

        return agentRunService?.appendRunEvent?.({
          accessScope,
          runId: agentRunId,
          type: "skill_graph_planned",
          payload: executionGraph,
        });
      },
      recordSkippedSkill,
      recordSkillResult,
      recordWorkingMemoryClaimSupport,
      recordWorkingMemoryGaps,
      registry,
      replanAdapter,
      resolveWorkingMemoryGaps,
      retrievalPlan: agentRetrievalPlan,
      returnClarification,
      saveExecutionGraphCheckpoint: agentRunId && agentRunService?.saveExecutionGraphCheckpoint
        ? (checkpoint) => agentRunService.saveExecutionGraphCheckpoint({
            accessScope,
            checkpoint,
            runId: agentRunId,
          })
        : null,
      selectedSkills,
      sessionId,
      skillGraphMode,
      stepLifecycle,
      taskMemory: taskMemoryContext,
      userId,
      webChatService,
    });

    if (executionResult.response) {
      const response = attachAgentRunId(executionResult.response, agentRunId);

      return completeRecordedRunAndExperience({
        accessScope,
        agentRunService,
        question,
        response,
        runId: agentRunId,
        taskMemory: taskMemoryContext,
        userId,
      });
    }

    const response = attachAgentRunId(
      await finalizeAgentRun({
        actionAnswer: executionResult.actionAnswer,
        addTraceStep,
        arxivImportAnswer: executionResult.arxivImportAnswer,
        buildAgentObservability,
        customSkillResults: executionResult.customSkillResults,
        customSkillGraphExecuted: executionResult.customSkillGraphExecuted,
        customSkills: executionResult.customSkills,
        discoveryAnswer: executionResult.discoveryAnswer,
        docIds,
        documentRagSkill: executionResult.documentRagSkill,
        getAgentSkills,
        getBudgetSnapshot,
        inventoryAnswer: executionResult.inventoryAnswer,
        plan,
        question,
        ragResult: executionResult.ragResult,
        recordAgentTrace,
        recordWorkingMemoryClaimSupport,
        recordWorkingMemoryGaps,
        researchBrief: executionResult.researchBrief,
        shouldRunWeb: executionResult.shouldRunWeb,
        skippedWebBecauseBudget: executionResult.skippedWebBecauseBudget,
        trace,
        webResult: executionResult.webResult,
        workingMemory,
      }),
      agentRunId
    );

    return completeRecordedRunAndExperience({
      accessScope,
      agentRunService,
      question,
      response,
      runId: agentRunId,
      taskMemory: taskMemoryContext,
      userId,
    });
  } catch (error) {
    if (error?.code === "AGENT_GRAPH_EXECUTION_FENCED") {
      // A startup worker now owns this same run. The old request must stop,
      // but marking the shared run failed here would race and cancel the
      // worker that won the persisted graph claim.
      throw error;
    }

    if (isAgentRunInterrupt(error)) {
      const clarification = buildCapabilityApprovalClarification(error);
      const privateInterruptDetail =
        getAgentRunInterruptPrivateDetail(error);

      const response = attachAgentRunId(
        await returnClarification(clarification, {
          ragResult: error.agentExecutionState?.ragResult,
        }),
        agentRunId
      );

      return completeRecordedRunAndExperience({
        accessScope,
        agentRunService,
        approvalSnapshots: privateInterruptDetail?.approvalSnapshot
          ? [privateInterruptDetail.approvalSnapshot]
          : [],
        question,
        response,
        runId: agentRunId,
        taskMemory: taskMemoryContext,
        userId,
      });
    }

    await agentRunService?.failRun?.({
      accessScope,
      error,
      graphResumeClaimId: null,
      runId: agentRunId,
    });
    throw error;
  }
};

// Every model call a run causes -- planners, document RAG, Skills, web -- is
// charged to that run's usage meter through AsyncLocalStorage, so the meter has
// to be active before the first of them. The run context picks the same meter
// up as its budget's `run` ceiling. Each invocation gets its own meter: an
// approval resume or graph recovery is a new invocation with a fresh clock,
// which is what a deadline should mean when a human approval may take hours.
//
// Each invocation is also one `invoke_agent` span: planners, tools, and every
// model call the run makes are its descendants in the trace.
export const runAgentRag = (options = {}) =>
  runWithRunUsage(
    createRunUsage({ limits: resolveRunUsageLimits(options.agentBudget) }),
    () =>
      withAgentRunSpan(
        {
          "agent.document_count": Array.isArray(options.docIds)
            ? options.docIds.length
            : undefined,
          "agent.run.resumed": Boolean(options.agentRunId),
          [GEN_AI_ATTRIBUTES.conversationId]: options.sessionId,
        },
        () => runAgentRagInScope(options)
      )
  );

export const resumeAgentExecutionGraphRun = (options = {}) =>
  runWithRunUsage(
    createRunUsage({
      limits: resolveRunUsageLimits(options.checkpoint?.owner?.budget?.limits),
    }),
    () =>
      withAgentRunSpan(
        {
          "agent.run.graph_resume": true,
          "agent.run.id": options.runId,
        },
        () => resumeAgentExecutionGraphRunInScope(options)
      )
  );
