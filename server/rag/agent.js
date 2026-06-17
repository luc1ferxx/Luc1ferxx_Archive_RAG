import { createAgentSession } from "./agent-bootstrap.js";
import {
  createAgentExecutionPlanResult,
  deterministicPlannerAdapter,
} from "./agent-execution-plan.js";
import { runAgentExecutionPlan } from "./agent-execution-plan-runner.js";
import { finalizeAgentRun } from "./agent-finalization-flow.js";
import { prepareAgentRun } from "./agent-preparation-flow.js";
import { AGENT_RUN_STATUSES } from "./agent-runs.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import {
  buildCapabilityApprovalClarification,
  createDefaultCapabilityRegistry,
} from "./capabilities/index.js";
import {
  attachApprovalGateStepIds,
  buildAgentRunStepsFromTrace,
} from "./agent-run-steps.js";

const getSkillDescriptor = (skill = {}) => ({
  skillId: skill.id,
  skillVersion: skill.version,
  label: skill.label,
  budgetKey: skill.budgetKey ?? null,
});

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

const buildRunCompletionPayload = (response = {}, existingRun = {}) => {
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
    runId,
    ...buildRunCompletionPayload(response, existingRun ?? {}),
  });
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

export const runAgentRag = async ({
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
  executionPlannerAdapter,
  skillRegistry,
}) => {
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
    question,
    skillRegistry,
  });
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

      const completedRun = await completeRecordedRun({
        accessScope,
        agentRunService,
        response,
        runId: agentRunId,
      });

      return attachAgentRunSnapshot(response, completedRun);
    }

    const agentRetrievalPlan = preparationResult.agentRetrievalPlan;
    const executionPlanResult = await createAgentExecutionPlanResult({
      accessScope,
      fallbackPlannerAdapter: deterministicPlannerAdapter,
      plannerAdapter: executionPlannerAdapter ?? deterministicPlannerAdapter,
      plannerContext: {
        docIds,
        plan,
        question,
        selectedSkills,
      },
      registry,
      selectedSkills,
    });
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
      budgetState,
      arxivImportService,
      buildSkillTraceDetail,
      capabilityRegistry: effectiveCapabilityRegistry,
      docIds,
      executeObservedSkill,
      executionLoop,
      executionPlan: executionPlanResult.executionPlan,
      getSelectedSkill,
      plan,
      question,
      ragService,
      recordExecutionGaps,
      recordSkippedSkill,
      recordSkillResult,
      recordWorkingMemoryClaimSupport,
      recordWorkingMemoryGaps,
      registry,
      resolveWorkingMemoryGaps,
      retrievalPlan: agentRetrievalPlan,
      returnClarification,
      selectedSkills,
      sessionId,
      userId,
      webChatService,
    });

    if (executionResult.response) {
      const response = attachAgentRunId(executionResult.response, agentRunId);

      const completedRun = await completeRecordedRun({
        accessScope,
        agentRunService,
        response,
        runId: agentRunId,
      });

      return attachAgentRunSnapshot(response, completedRun);
    }

    const response = attachAgentRunId(
      await finalizeAgentRun({
        addTraceStep,
        arxivImportAnswer: executionResult.arxivImportAnswer,
        buildAgentObservability,
        customSkillResults: executionResult.customSkillResults,
        customSkills: executionResult.customSkills,
        discoveryAnswer: executionResult.discoveryAnswer,
        documentRagSkill: executionResult.documentRagSkill,
        getAgentSkills,
        getBudgetSnapshot,
        inventoryAnswer: executionResult.inventoryAnswer,
        plan,
        question,
        ragResult: executionResult.ragResult,
        recordAgentTrace,
        recordWorkingMemoryClaimSupport,
        researchBrief: executionResult.researchBrief,
        shouldRunWeb: executionResult.shouldRunWeb,
        skippedWebBecauseBudget: executionResult.skippedWebBecauseBudget,
        trace,
        webResult: executionResult.webResult,
        workingMemory,
      }),
      agentRunId
    );

    const completedRun = await completeRecordedRun({
      accessScope,
      agentRunService,
      response,
      runId: agentRunId,
    });

    return attachAgentRunSnapshot(response, completedRun);
  } catch (error) {
    if (isAgentRunInterrupt(error)) {
      const clarification = buildCapabilityApprovalClarification(error);

      await agentRunService?.appendRunEvent?.({
        accessScope,
        runId: agentRunId,
        type: "approval_gate_created",
        payload: {
          approvalGate: clarification.detail?.approvalGate ?? null,
          interruptType: error.type,
        },
      });

      const response = attachAgentRunId(
        await returnClarification(clarification, {
          ragResult: error.agentExecutionState?.ragResult,
        }),
        agentRunId
      );

      const completedRun = await completeRecordedRun({
        accessScope,
        agentRunService,
        response,
        runId: agentRunId,
      });

      return attachAgentRunSnapshot(response, completedRun);
    }

    await agentRunService?.failRun?.({
      accessScope,
      error,
      runId: agentRunId,
    });
    throw error;
  }
};
