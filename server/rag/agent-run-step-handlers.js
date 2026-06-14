import { AGENT_RUN_STATUSES } from "./agent-runs.js";
import {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
} from "./agent-run-steps.js";
import { CAPABILITY_IDS } from "./capabilities/index.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

const fail = (message, status = 409) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};

const toTraceStatus = (status) => (status === "paused" ? "needs_input" : status);

const getStepType = (step = {}) => normalizeText(step.type).toLowerCase();

const getCapabilityAgentMode = (capabilityId, fallback = "capability") => {
  if (capabilityId === CAPABILITY_IDS.webSearch) {
    return "web";
  }

  if (capabilityId === CAPABILITY_IDS.arxivImportTopic) {
    return "arxiv_import";
  }

  if (capabilityId === CAPABILITY_IDS.documentDiscovery) {
    return "document_discovery";
  }

  return fallback;
};

export const getCapabilityResultText = (result = {}, gate = {}) =>
  normalizeText(result.text) ||
  normalizeText(result.value?.text) ||
  `${gate.capabilityLabel ?? gate.capabilityId ?? "Capability"} completed.`;

export const getCapabilityResultCitations = (result = {}) =>
  Array.isArray(result.citations)
    ? result.citations
    : Array.isArray(result.value?.citations)
      ? result.value.citations
      : [];

export const buildCapabilityResumeResponse = ({
  capabilityId,
  capabilityResult,
  gate,
  run,
  step,
} = {}) => {
  const effectiveCapabilityId =
    capabilityId || gate?.capabilityId || step?.capabilityId;
  const answer = getCapabilityResultText(capabilityResult, {
    capabilityId: effectiveCapabilityId,
    capabilityLabel: gate?.capabilityLabel ?? step?.label,
  });
  const citations = getCapabilityResultCitations(capabilityResult);
  const agentMode = getCapabilityAgentMode(effectiveCapabilityId);
  const steps = run?.steps ?? [];
  const agentTrace = steps.map((runStep) => ({
    id: runStep.traceStepId || runStep.id,
    type: runStep.type,
    label: runStep.label,
    status: toTraceStatus(runStep.status),
    summary: runStep.summary,
    detail: {
      ...(runStep.detail ?? {}),
      attempt: runStep.attempt,
      kind: runStep.kind,
      retryOfStepId: runStep.retryOfStepId || null,
    },
  }));

  return {
    agentAnswer: answer,
    agentMode,
    agentRunId: run?.runId ?? null,
    agentRunStatus: run?.status ?? null,
    agentRunSteps: steps,
    agentSkills: [],
    agentTrace,
    agentObservability: {
      agentMode,
      approvalGates: run?.approvalGates ?? [],
      steps,
    },
    agentWorkingMemory: {},
    approvalGates: run?.approvalGates ?? [],
    clarification: {
      needed: false,
      reason: null,
      question: null,
      detail: null,
    },
    errors: {
      mcp: null,
      rag: null,
    },
    mcpAnswer: agentMode === "web" ? answer : "Web search not used.",
    ragAbstained: Boolean(
      capabilityResult.abstained ?? capabilityResult.value?.abstained
    ),
    ragAnswer: answer,
    ragEvidenceSummary: null,
    ragGapPlan: null,
    ragMemoryApplied: false,
    ragResolvedQuestion: run?.goal ?? "",
    ragSources: citations,
    researchBrief: null,
  };
};

const getStepInput = (step = {}) => {
  const detail = normalizeRecord(step.detail, {});

  return (
    normalizeRecord(step.input, null) ??
    normalizeRecord(detail.input, null) ??
    normalizeRecord(detail.capabilityInput, null) ??
    null
  );
};

const getWebSearchInput = ({ run = {}, step = {} } = {}) => {
  const stepInput = getStepInput(step);

  if (stepInput?.question) {
    return stepInput;
  }

  const detail = normalizeRecord(step.detail, {});
  const question =
    normalizeText(detail.question) ||
    normalizeText(detail.query) ||
    normalizeText(run.goal);

  return question ? { question } : null;
};

const getArxivImportInput = ({ step = {} } = {}) => {
  const stepInput = getStepInput(step);

  if (stepInput?.topic) {
    return stepInput;
  }

  const detail = normalizeRecord(step.detail, {});
  const topic = normalizeText(detail.topic);

  return topic
    ? {
        maxResults: detail.requestedMaxResults,
        topic,
      }
    : null;
};

const executeCapabilityBackedStep = async ({
  accessScope = {},
  agentRunService,
  approval = {},
  capabilityId,
  capabilityRegistry,
  gate = {},
  input = {},
  run,
  step,
} = {}) => {
  if (!capabilityRegistry?.execute) {
    fail("Capability registry is not available.", 500);
  }

  if (!capabilityId) {
    fail("Agent run step is missing capabilityId.");
  }

  if (!step?.id) {
    fail("Agent run step is missing a resumable step id.");
  }

  await agentRunService.updateRunStep({
    accessScope,
    eventType: "step_started",
    runId: run.runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: step.id,
  });

  let capabilityResult;

  try {
    capabilityResult = await capabilityRegistry.execute(capabilityId, {
      accessScope,
      approval,
      input,
    });
  } catch (error) {
    await agentRunService.updateRunStep({
      accessScope,
      eventType: "step_failed",
      patch: {
        error: {
          message: serializeError(error, "Capability execution failed."),
          name: error.name ?? "Error",
        },
      },
      runId: run.runId,
      status: AGENT_RUN_STEP_STATUSES.failed,
      stepId: step.id,
    });
    throw error;
  }

  const runAfterStep = await agentRunService.updateRunStep({
    accessScope,
    eventType: "step_completed",
    patch: {
      output: {
        citationCount: getCapabilityResultCitations(capabilityResult).length,
        text: getCapabilityResultText(capabilityResult, {
          capabilityId,
          capabilityLabel: gate?.capabilityLabel ?? step.label,
        }),
      },
    },
    runId: run.runId,
    status: AGENT_RUN_STEP_STATUSES.completed,
    stepId: step.id,
  });
  const responseBody = buildCapabilityResumeResponse({
    capabilityId,
    capabilityResult,
    gate,
    run: runAfterStep,
    step,
  });
  const completedRun = await agentRunService.completeRun({
    accessScope,
    approvalGates: runAfterStep.approvalGates ?? [],
    decisions: runAfterStep.decisions ?? [],
    observations: [
      ...(runAfterStep.observations ?? []),
      {
        capabilityId,
        status: AGENT_RUN_STEP_STATUSES.completed,
        stepId: step.id,
      },
    ],
    result: {
      agentMode: responseBody.agentMode,
      answer: responseBody.agentAnswer,
      citationCount: responseBody.ragSources?.length ?? 0,
      ragAbstained: Boolean(responseBody.ragAbstained),
      status: 200,
    },
    runId: run.runId,
    status: AGENT_RUN_STATUSES.completed,
    steps: runAfterStep.steps ?? [],
  });

  return {
    response: {
      ...responseBody,
      agentRunStatus: completedRun.status,
      agentRunSteps: completedRun.steps ?? [],
    },
    run: completedRun,
  };
};

export const createCapabilityCallStepHandler = () => ({
  id: "capability_call",
  label: "Capability Call",
  canHandle: ({ step } = {}) =>
    step?.kind === AGENT_RUN_STEP_KINDS.capabilityCall ||
    getStepType(step) === "capability_call",
  prepareRetry({ run = {}, step = {} } = {}) {
    const gate = (run.approvalGates ?? []).find(
      (approvalGate) =>
        approvalGate.id === step.approvalGateId &&
        approvalGate.status === "approved"
    );

    if (!gate) {
      fail("Retry requires an approved capability gate.");
    }

    return {
      gate,
    };
  },
  async execute({
    accessScope = {},
    agentRunService,
    capabilityRegistry,
    gate,
    run,
    step,
  } = {}) {
    if (!gate?.capabilityId) {
      fail("Approved capability gate is missing capabilityId.");
    }

    return executeCapabilityBackedStep({
      accessScope,
      agentRunService,
      approval: {
        approved: true,
        decision: "approved",
        gateId: gate.id,
        source: "agent_run_action",
      },
      capabilityId: gate.capabilityId,
      capabilityRegistry,
      gate,
      input: gate.inputPreview ?? getStepInput(step) ?? {},
      run,
      step,
    });
  },
});

export const createWebSearchStepHandler = () => ({
  id: "web_search",
  label: "Web Search",
  canHandle: ({ step } = {}) => getStepType(step) === "web_search",
  prepareRetry({ run = {}, step = {} } = {}) {
    const input = getWebSearchInput({
      run,
      step,
    });

    if (!input?.question) {
      fail("web_search retry requires a question input.");
    }

    return {
      input,
    };
  },
  async execute({
    accessScope = {},
    agentRunService,
    capabilityRegistry,
    run,
    step,
  } = {}) {
    const input = getWebSearchInput({
      run,
      step,
    });

    if (!input?.question) {
      fail("web_search retry requires a question input.");
    }

    return executeCapabilityBackedStep({
      accessScope,
      agentRunService,
      approval: {
        approved: true,
        decision: "approved",
        source: "agent_run_step_retry",
      },
      capabilityId: CAPABILITY_IDS.webSearch,
      capabilityRegistry,
      input,
      run,
      step,
    });
  },
});

export const createArxivImportStepHandler = () => ({
  id: "arxiv_import",
  label: "arXiv Import",
  canHandle: ({ step } = {}) => getStepType(step) === "arxiv_import",
  prepareRetry({ step = {} } = {}) {
    const input = getArxivImportInput({
      step,
    });

    if (!input?.topic) {
      fail("arxiv_import retry requires a sanitized topic input.");
    }

    return {
      input,
    };
  },
  async execute({
    accessScope = {},
    agentRunService,
    capabilityRegistry,
    run,
    step,
  } = {}) {
    const input = getArxivImportInput({
      step,
    });

    if (!input?.topic) {
      fail("arxiv_import retry requires a sanitized topic input.");
    }

    return executeCapabilityBackedStep({
      accessScope,
      agentRunService,
      approval: {
        approved: true,
        decision: "approved",
        source: "agent_run_step_retry",
      },
      capabilityId: CAPABILITY_IDS.arxivImportTopic,
      capabilityRegistry,
      input,
      run,
      step,
    });
  },
});

export const createDocumentRagStepHandler = ({
  executeDocumentRagStep,
} = {}) => ({
  id: "document_rag",
  label: "Document RAG",
  canHandle: ({ step } = {}) => getStepType(step) === "document_rag",
  prepareRetry({ run = {}, step = {} } = {}) {
    if (typeof executeDocumentRagStep !== "function") {
      fail(
        "document_rag retry is not wired yet. Provide a document RAG step handler before retrying this step."
      );
    }

    const retryCount = toArray(run.steps).filter(
      (runStep) => runStep.retryOfStepId === step.id
    ).length;

    if (retryCount >= 1) {
      fail("document_rag steps can only be retried once.");
    }

    return {};
  },
  async execute(context = {}) {
    if (typeof executeDocumentRagStep !== "function") {
      fail(
        "document_rag retry is not wired yet. Provide a document RAG step handler before retrying this step."
      );
    }

    return executeDocumentRagStep(context);
  },
});

export const createAgentRunStepHandlerRegistry = (handlers = []) => {
  const normalizedHandlers = toArray(handlers).filter(
    (handler) =>
      handler &&
      typeof handler.canHandle === "function" &&
      typeof handler.execute === "function"
  );

  return {
    list: () =>
      normalizedHandlers.map((handler) => ({
        id: handler.id,
        label: handler.label ?? handler.id,
      })),
    resolve: (context = {}) =>
      normalizedHandlers.find((handler) => handler.canHandle(context)) ?? null,
  };
};

export const createDefaultAgentRunStepHandlerRegistry = ({
  executeDocumentRagStep,
  extraHandlers = [],
} = {}) =>
  createAgentRunStepHandlerRegistry([
    ...toArray(extraHandlers),
    createCapabilityCallStepHandler(),
    createWebSearchStepHandler(),
    createArxivImportStepHandler(),
    createDocumentRagStepHandler({
      executeDocumentRagStep,
    }),
  ]);
