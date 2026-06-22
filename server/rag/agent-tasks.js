import { randomUUID } from "node:crypto";

import { createTaskService, TASK_STATUSES } from "./tasks.js";

export const AGENT_TASK_TYPE = "agent_goal";
export const AGENT_TASK_RUNNER_ID = "agent_goal_runner";

export const AGENT_TASK_ACTIONS = Object.freeze({
  approve: "approve",
  continue: "continue",
});

const DEFAULT_MAX_ITERATIONS = 3;

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeDocIds = (docIds) =>
  toArray(docIds).map(normalizeText).filter(Boolean);

const normalizeMaxIterations = (value) => {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_MAX_ITERATIONS;
  }

  return Math.max(1, Math.min(10, Math.trunc(parsedValue)));
};

const buildAgentTaskId = (id) => {
  const normalizedId = normalizeText(id) || randomUUID();

  return normalizedId.startsWith(`${AGENT_TASK_TYPE}:`)
    ? normalizedId
    : `${AGENT_TASK_TYPE}:${normalizedId}`;
};

const buildTaskError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const buildPublicInput = ({
  docIds = [],
  maxIterations = DEFAULT_MAX_ITERATIONS,
  question = "",
  sessionId = "",
  userId = "",
} = {}) => ({
  docIds: normalizeDocIds(docIds),
  maxIterations: normalizeMaxIterations(maxIterations),
  question: normalizeText(question),
  sessionId: normalizeText(sessionId),
  userId: normalizeText(userId),
});

const buildInitialPayload = (input = {}) => ({
  ...input,
  agentRunId: null,
  capabilityApprovals: {},
  iterations: [],
  pending: null,
});

const normalizePayload = (task = {}) => {
  const input = buildPublicInput(task.input);
  const payload = normalizeRecord(task.payload);

  return {
    ...input,
    ...payload,
    capabilityApprovals: normalizeRecord(payload.capabilityApprovals),
    docIds: normalizeDocIds(payload.docIds ?? input.docIds),
    iterations: toArray(payload.iterations),
    maxIterations: normalizeMaxIterations(payload.maxIterations ?? input.maxIterations),
    question: normalizeText(payload.question || input.question),
    sessionId: normalizeText(payload.sessionId || input.sessionId),
    userId: normalizeText(payload.userId || input.userId),
  };
};

const getAgentTaskControl = (body = {}) => normalizeRecord(body.agentTask, null);

const shouldContinueFromBody = (body = {}) =>
  getAgentTaskControl(body)?.continue === true &&
  Boolean(normalizeText(getAgentTaskControl(body)?.nextQuestion));

const getNextQuestion = (body = {}) =>
  normalizeText(getAgentTaskControl(body)?.nextQuestion);

const getAgentRunId = ({ body = {}, payload = {} } = {}) =>
  normalizeText(body.agentRunId) || normalizeText(payload.agentRunId) || null;

const isClarificationResponse = (body = {}) =>
  body.clarification?.needed === true || body.agentMode === "clarification";

const getPendingApprovalGates = (body = {}) => {
  const detailGates = body.clarification?.detail?.approvalGates;
  const gates = toArray(body.approvalGates).length > 0
    ? body.approvalGates
    : detailGates;

  return toArray(gates).filter((gate) => normalizeText(gate.status) !== "approved");
};

const getRequiredUserAction = (body = {}) =>
  body.clarification?.reason === "capability_approval_required" ||
  getPendingApprovalGates(body).length > 0
    ? "approve_capability"
    : "answer_clarification";

const buildIterationRecord = ({
  body = {},
  index,
  question,
  responseStatus,
} = {}) => ({
  agentMode: normalizeText(body.agentMode),
  agentRunId: normalizeText(body.agentRunId),
  answer: normalizeText(body.agentAnswer),
  clarificationNeeded: body.clarification?.needed === true,
  clarificationReason: normalizeText(body.clarification?.reason),
  index,
  question: normalizeText(question),
  responseStatus,
});

const getUniqueAgentRunCount = (iterations = []) =>
  new Set(
    toArray(iterations)
      .map((iteration) => normalizeText(iteration.agentRunId))
      .filter(Boolean)
  ).size;

const buildCounts = ({ iterations = [], maxIterations }) => ({
  agentRuns: getUniqueAgentRunCount(iterations),
  iterations: iterations.length,
  maxIterations: normalizeMaxIterations(maxIterations),
});

const buildResult = ({
  body = {},
  payload = {},
  responseStatus,
  stoppedReason,
} = {}) => ({
  agentMode: normalizeText(body.agentMode),
  agentRunId: getAgentRunId({ body, payload }),
  answer: normalizeText(body.agentAnswer),
  approvalGates: getPendingApprovalGates(body),
  clarification: body.clarification ?? null,
  responseStatus,
  stoppedReason,
});

const buildProgressPatch = ({
  body = {},
  payload = {},
  responseStatus,
  stoppedReason,
} = {}) => ({
  counts: buildCounts({
    iterations: payload.iterations,
    maxIterations: payload.maxIterations,
  }),
  payload,
  result: buildResult({
    body,
    payload,
    responseStatus,
    stoppedReason,
  }),
});

const buildApprovalMap = ({ payload = {}, task = {} } = {}) => {
  const capabilityId =
    normalizeText(payload.capabilityId) ||
    normalizeText(task.payload?.pending?.approvalGates?.[0]?.capabilityId);

  if (!capabilityId) {
    throw buildTaskError("capabilityId is required for approval.", 400);
  }

  return {
    [capabilityId]: {
      approved: true,
      decision: "approved",
      source: "task_action",
      ...normalizeRecord(payload.approval),
    },
  };
};

const getResumeMaxIterations = ({ payload = {}, taskPayload = {} } = {}) => {
  if (payload.maxIterations !== undefined) {
    return normalizeMaxIterations(payload.maxIterations);
  }

  return taskPayload.pending?.reason === "iteration_budget_exhausted"
    ? normalizeMaxIterations(taskPayload.maxIterations + DEFAULT_MAX_ITERATIONS)
    : taskPayload.maxIterations;
};

export const createAgentTaskService = ({
  createTaskId = randomUUID,
  jobOrchestrator,
  taskService = createTaskService(),
} = {}) => ({
  async createTask({
    accessScope = {},
    docIds = [],
    maxIterations = DEFAULT_MAX_ITERATIONS,
    question,
    sessionId = "",
    userId = "",
  } = {}) {
    const input = buildPublicInput({
      docIds,
      maxIterations,
      question,
      sessionId,
      userId,
    });

    if (!input.question) {
      throw buildTaskError("Question is required.", 400);
    }

    const taskId = buildAgentTaskId(createTaskId());
    const task = await taskService.upsertTask({
      accessScope,
      task: {
        id: taskId,
        input,
        label: "Agent task",
        payload: buildInitialPayload(input),
        requiredUserAction: "",
        runnerId: AGENT_TASK_RUNNER_ID,
        status: TASK_STATUSES.queued,
        summary: "Agent task queued.",
        type: AGENT_TASK_TYPE,
        counts: {
          agentRuns: 0,
          iterations: 0,
          maxIterations: input.maxIterations,
        },
      },
    });

    jobOrchestrator?.scheduleTaskRun?.({
      accessScope,
      taskId,
    });

    return task;
  },
});

export const createAgentTaskRunner = ({
  runAgentTask = async () => {
    throw buildTaskError("Agent task runner is not configured.", 500);
  },
} = {}) => {
  const run = async ({ accessScope = {}, patchTask = async () => {}, task = {} } = {}) => {
    let payload = normalizePayload(task);
    let question = normalizeText(payload.nextQuestion) || payload.question;
    let lastBody = {};
    let lastStatus = 200;

    while (payload.iterations.length < payload.maxIterations) {
      const response = await runAgentTask({
        accessScope,
        agentRunId: payload.agentRunId,
        capabilityApprovals: payload.capabilityApprovals,
        docIds: payload.docIds,
        question,
        sessionId: payload.sessionId,
        userId: payload.userId,
      });
      const body = normalizeRecord(response?.body);
      const responseStatus = Number(response?.status ?? 200);
      const agentRunId = getAgentRunId({
        body,
        payload,
      });
      const iterations = [
        ...payload.iterations,
        buildIterationRecord({
          body,
          index: payload.iterations.length + 1,
          question,
          responseStatus,
        }),
      ];

      lastBody = body;
      lastStatus = responseStatus;
      payload = {
        ...payload,
        agentRunId,
        capabilityApprovals: {},
        iterations,
        lastQuestion: question,
        nextQuestion: "",
        pending: null,
      };

      await patchTask({
        ...buildProgressPatch({
          body,
          payload,
          responseStatus,
          stoppedReason: "running",
        }),
        status: TASK_STATUSES.running,
        summary: `Agent task completed ${iterations.length} iteration(s).`,
      });

      if (responseStatus >= 400) {
        return {
          ...buildProgressPatch({
            body,
            payload,
            responseStatus,
            stoppedReason: "failed",
          }),
          error: body.error ?? "Agent task failed.",
          status: TASK_STATUSES.failed,
          summary: "Agent task failed.",
        };
      }

      if (isClarificationResponse(body)) {
        const approvalGates = getPendingApprovalGates(body);
        const requiredUserAction = getRequiredUserAction(body);

        payload = {
          ...payload,
          pending: {
            agentRunId,
            approvalGates,
            question: normalizeText(body.clarification?.question),
            reason: normalizeText(body.clarification?.reason),
          },
        };

        return {
          ...buildProgressPatch({
            body,
            payload,
            responseStatus,
            stoppedReason: "waiting_for_user",
          }),
          requiredUserAction,
          status: TASK_STATUSES.waitingForUser,
          summary:
            requiredUserAction === "approve_capability"
              ? "Agent task is waiting for capability approval."
              : "Agent task is waiting for clarification.",
        };
      }

      if (!shouldContinueFromBody(body)) {
        return {
          ...buildProgressPatch({
            body,
            payload,
            responseStatus,
            stoppedReason: "completed",
          }),
          requiredUserAction: "",
          status: TASK_STATUSES.completed,
          summary: "Agent task completed.",
        };
      }

      question = getNextQuestion(body);
      payload = {
        ...payload,
        nextQuestion: question,
      };
    }

    payload = {
      ...payload,
      pending: {
        agentRunId: payload.agentRunId,
        question,
        reason: "iteration_budget_exhausted",
      },
    };

    return {
      ...buildProgressPatch({
        body: lastBody,
        payload,
        responseStatus: lastStatus,
        stoppedReason: "iteration_budget_exhausted",
      }),
      requiredUserAction: "continue_task",
      status: TASK_STATUSES.waitingForUser,
      summary: "Agent task reached the iteration limit.",
    };
  };

  const resume = async ({ action, payload = {}, task = {} } = {}) => {
    const normalizedAction = normalizeText(action);
    const taskPayload = normalizePayload(task);
    const nextPayload = {
      ...taskPayload,
      pending: null,
    };

    if (normalizedAction === AGENT_TASK_ACTIONS.approve) {
      return {
        payload: {
          ...nextPayload,
          capabilityApprovals: buildApprovalMap({
            payload,
            task,
          }),
        },
        status: TASK_STATUSES.queued,
        summary: "Agent task queued after approval.",
      };
    }

    if (normalizedAction === AGENT_TASK_ACTIONS.continue) {
      const nextQuestion =
        normalizeText(payload.question) ||
        normalizeText(payload.answer) ||
        normalizeText(payload.userInput) ||
        normalizeText(taskPayload.nextQuestion) ||
        normalizeText(taskPayload.pending?.question) ||
        taskPayload.question;
      const maxIterations = getResumeMaxIterations({
        payload,
        taskPayload,
      });
      const docIds = payload.docIds ? normalizeDocIds(payload.docIds) : taskPayload.docIds;

      return {
        counts: buildCounts({
          iterations: taskPayload.iterations,
          maxIterations,
        }),
        input: {
          ...task.input,
          docIds,
          maxIterations,
          question: nextQuestion,
        },
        payload: {
          ...nextPayload,
          capabilityApprovals: {},
          docIds,
          maxIterations,
          nextQuestion,
          question: nextQuestion,
        },
        status: TASK_STATUSES.queued,
        summary: "Agent task queued with user clarification.",
      };
    }

    throw buildTaskError(`Unsupported agent task action: ${normalizedAction}.`, 400);
  };

  return {
    id: AGENT_TASK_RUNNER_ID,
    resume,
    run,
  };
};
