import { randomUUID } from "node:crypto";

import {
  buildAgentTaskPlanningContext,
  updateAgentTaskMemory,
} from "./agent-task-memory.js";
import {
  advanceResearchTaskFlow,
  compactResearchTaskFlow,
  createResearchTaskFlow,
  getResearchTaskIterationPhase,
  getResearchTaskQuestion,
  normalizeResearchTaskFlow,
  shouldContinueResearchTask,
} from "./agent-research-task.js";
import {
  AGENT_GOAL_DELIVERABLE_STATUSES,
  executeAgentGoalDeliverables,
  prepareAgentGoalDeliverables,
} from "./agent-goal-deliverables.js";
import { compactAgentGoalWorkingMemory } from "./agent-goal-completion.js";
import { buildAgentGoalPlanTaskFields } from "./agent-goal-plan.js";
import { createTaskService, TASK_STATUSES } from "./tasks.js";

export const AGENT_TASK_TYPE = "agent_goal";
export const AGENT_TASK_RUNNER_ID = "agent_goal_runner";

export const AGENT_TASK_ACTIONS = Object.freeze({
  approve: "approve",
  approveDeliverables: "approve_deliverables",
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
  userPreferences = [],
  userId = "",
} = {}) => ({
  docIds: normalizeDocIds(docIds),
  maxIterations: normalizeMaxIterations(maxIterations),
  question: normalizeText(question),
  sessionId: normalizeText(sessionId),
  userPreferences: toArray(userPreferences).map(normalizeText).filter(Boolean),
  userId: normalizeText(userId),
});

const buildInitialPayload = (input = {}, { researchTask = null } = {}) => ({
  ...input,
  agentRunId: null,
  capabilityApprovals: {},
  iterations: [],
  nextQuestion: getResearchTaskQuestion(researchTask),
  pending: null,
  researchTask,
  taskMemory: buildAgentTaskPlanningContext({
    goal: input.question,
    userPreferences: input.userPreferences,
  }),
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
    researchTask: normalizeResearchTaskFlow(payload.researchTask),
    sessionId: normalizeText(payload.sessionId || input.sessionId),
    taskMemory: buildAgentTaskPlanningContext(
      payload.taskMemory ?? {
        goal: payload.question || input.question,
        userPreferences: payload.userPreferences ?? input.userPreferences,
      }
    ),
    userPreferences: toArray(payload.userPreferences ?? input.userPreferences)
      .map(normalizeText)
      .filter(Boolean),
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
  researchTaskPhase = null,
  responseStatus,
} = {}) => ({
  agentMode: normalizeText(body.agentMode),
  agentRunId: normalizeText(body.agentRunId),
  answer: normalizeText(body.agentAnswer),
  citations: toArray(body.ragSources ?? body.citations)
    .map((citation) => normalizeRecord(citation))
    .slice(0, 20),
  clarificationNeeded: body.clarification?.needed === true,
  clarificationReason: normalizeText(body.clarification?.reason),
  index,
  question: normalizeText(question),
  researchTaskPhase: normalizeRecord(researchTaskPhase, null),
  responseStatus,
  workingMemory: compactAgentGoalWorkingMemory(body),
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
  researchTask: compactResearchTaskFlow(payload.researchTask),
  stoppedReason,
  taskMemory: buildAgentTaskPlanningContext(payload.taskMemory),
});

const getLastIteration = (payload = {}) => toArray(payload.iterations).at(-1) ?? {};

const getLastResponseStatus = (payload = {}) => {
  const responseStatus = Number(getLastIteration(payload).responseStatus ?? 200);

  return Number.isFinite(responseStatus) ? responseStatus : 200;
};

const buildBodyFromPayload = (payload = {}, overrides = {}) => {
  const lastIteration = getLastIteration(payload);

  return {
    agentAnswer: normalizeText(lastIteration.answer),
    agentMode: normalizeText(lastIteration.agentMode),
    agentRunId:
      normalizeText(lastIteration.agentRunId) ||
      normalizeText(payload.agentRunId),
    ...overrides,
  };
};

const buildProgressPatch = ({
  body = {},
  payload = {},
  responseStatus,
  stoppedReason,
  taskStatus = TASK_STATUSES.running,
} = {}) => {
  const planFields = buildAgentGoalPlanTaskFields({
    body,
    payload,
    responseStatus,
    stoppedReason,
    taskStatus,
  });

  return {
    counts: buildCounts({
      iterations: payload.iterations,
      maxIterations: payload.maxIterations,
    }),
    items: planFields.items,
    payload,
    result: {
      ...buildResult({
        body,
        payload,
        responseStatus,
        stoppedReason,
      }),
      ...planFields.result,
    },
  };
};

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

const isDeliverableApprovalPending = (deliverables = {}) =>
  deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.waitingForApproval;

const isDeliverableExecutionApproved = (deliverables = {}) =>
  deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.approved;

const buildDeliverableApprovalQuestion = (deliverables = {}) => {
  const labels = toArray(deliverables.specs)
    .map((spec) => normalizeText(spec.label))
    .filter(Boolean);

  return `Approve creation of ${labels.length} goal deliverable${
    labels.length === 1 ? "" : "s"
  }${labels.length > 0 ? `: ${labels.join(", ")}` : ""}.`;
};

const buildDeliverableApproval = (payload = {}) => ({
  approved: true,
  decision: "approved",
  source: "task_action",
  ...normalizeRecord(payload.approval),
});

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
    userPreferences = [],
    userId = "",
  } = {}) {
    let input = buildPublicInput({
      docIds,
      maxIterations,
      question,
      sessionId,
      userPreferences,
      userId,
    });

    if (!input.question) {
      throw buildTaskError("Question is required.", 400);
    }

    const researchTask = createResearchTaskFlow({
      docIds: input.docIds,
      question: input.question,
    });

    if (researchTask) {
      input = {
        ...input,
        maxIterations: Math.max(input.maxIterations, researchTask.maxIterations),
      };
    }

    const taskId = buildAgentTaskId(createTaskId());
    const payload = buildInitialPayload(input, {
      researchTask,
    });
    const planFields = buildAgentGoalPlanTaskFields({
      payload,
      stoppedReason: "queued",
      taskStatus: TASK_STATUSES.queued,
    });
    const task = await taskService.upsertTask({
      accessScope,
      task: {
        id: taskId,
        input,
        items: planFields.items,
        label: "Agent task",
        payload,
        requiredUserAction: "",
        result: planFields.result,
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
  capabilityRegistry,
  goalDeliverableService,
  runAgentTask = async () => {
    throw buildTaskError("Agent task runner is not configured.", 500);
  },
} = {}) => {
  const deliverableService = goalDeliverableService ?? {
    execute: (options) =>
      executeAgentGoalDeliverables({
        capabilityRegistry,
        ...options,
      }),
    prepare: (options) =>
      prepareAgentGoalDeliverables({
        capabilityRegistry,
        ...options,
      }),
  };

  const runApprovedDeliverables = async ({
    accessScope = {},
    patchTask = async () => {},
    payload = {},
  } = {}) => {
    const body = buildBodyFromPayload(payload);
    const responseStatus = getLastResponseStatus(payload);
    let nextPayload = {
      ...payload,
      deliverables: {
        ...payload.deliverables,
        results: [],
        status: AGENT_GOAL_DELIVERABLE_STATUSES.running,
      },
      pending: null,
    };

    await patchTask({
      ...buildProgressPatch({
        body,
        payload: nextPayload,
        responseStatus,
        stoppedReason: "creating_deliverables",
        taskStatus: TASK_STATUSES.running,
      }),
      status: TASK_STATUSES.running,
      summary: "Agent task is creating approved deliverables.",
    });

    const deliverables = await deliverableService.execute({
      accessScope,
      approval: nextPayload.deliverables.approval,
      deliverables: nextPayload.deliverables,
    });
    const taskStatus =
      deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.failed
        ? TASK_STATUSES.failed
        : TASK_STATUSES.completed;

    nextPayload = {
      ...nextPayload,
      deliverables,
    };

    return {
      ...buildProgressPatch({
        body,
        payload: nextPayload,
        responseStatus,
        stoppedReason:
          taskStatus === TASK_STATUSES.failed ? "failed" : "completed",
        taskStatus,
      }),
      error:
        taskStatus === TASK_STATUSES.failed
          ? "One or more goal deliverables failed."
          : null,
      requiredUserAction: "",
      status: taskStatus,
      summary:
        taskStatus === TASK_STATUSES.failed
          ? "Agent task completed, but one or more deliverables failed."
          : "Agent task completed with deliverables.",
    };
  };

  const run = async ({ accessScope = {}, patchTask = async () => {}, task = {} } = {}) => {
    let payload = normalizePayload(task);
    let question =
      getResearchTaskQuestion(payload.researchTask) ||
      normalizeText(payload.nextQuestion) ||
      payload.question;
    let lastBody = {};
    let lastStatus = 200;

    if (isDeliverableExecutionApproved(payload.deliverables)) {
      return runApprovedDeliverables({
        accessScope,
        patchTask,
        payload,
      });
    }

    while (payload.iterations.length < payload.maxIterations) {
      const researchTaskPhase = getResearchTaskIterationPhase(payload.researchTask);
      const requestedAgentRunId =
        payload.resumeAgentRunId === true
          ? normalizeText(payload.agentRunId) || undefined
          : undefined;
      const response = await runAgentTask({
        accessScope,
        agentRunId: requestedAgentRunId,
        capabilityApprovals: payload.capabilityApprovals,
        docIds: payload.docIds,
        question,
        sessionId: payload.sessionId,
        taskMemory: buildAgentTaskPlanningContext(payload.taskMemory),
        userId: payload.userId,
      });
      const body = normalizeRecord(response?.body);
      const responseStatus = Number(response?.status ?? 200);
      const agentRunId = getAgentRunId({
        body,
        payload,
      });
      const nextResearchTask = advanceResearchTaskFlow({
        body,
        flow: payload.researchTask,
        responseStatus,
      });
      const researchTaskQuestion = getResearchTaskQuestion(nextResearchTask);
      const shouldContinue =
        shouldContinueResearchTask(nextResearchTask) ||
        (!researchTaskQuestion && shouldContinueFromBody(body));
      const nextQuestion = researchTaskQuestion || (shouldContinue ? getNextQuestion(body) : "");
      const iterations = [
        ...payload.iterations,
        buildIterationRecord({
          body,
          index: payload.iterations.length + 1,
          question,
          researchTaskPhase,
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
        nextQuestion,
        pending: null,
        researchTask: nextResearchTask,
        resumeAgentRunId: false,
        taskMemory: updateAgentTaskMemory({
          body,
          memory: payload.taskMemory,
          question,
          responseStatus,
        }),
      };

      await patchTask({
        ...buildProgressPatch({
          body,
          payload,
          responseStatus,
          stoppedReason: "running",
          taskStatus: TASK_STATUSES.running,
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
            taskStatus: TASK_STATUSES.failed,
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
            taskStatus: TASK_STATUSES.waitingForUser,
          }),
          requiredUserAction,
          status: TASK_STATUSES.waitingForUser,
          summary:
            requiredUserAction === "approve_capability"
              ? "Agent task is waiting for capability approval."
              : "Agent task is waiting for clarification.",
        };
      }

      if (!shouldContinue) {
        const deliverables = await deliverableService.prepare({
          body,
          payload,
        });

        if (isDeliverableApprovalPending(deliverables)) {
          payload = {
            ...payload,
            deliverables,
            pending: {
              agentRunId,
              approvalGates: deliverables.approvalGates,
              deliverables: deliverables.specs,
              question: buildDeliverableApprovalQuestion(deliverables),
              reason: "deliverable_approval_required",
            },
          };

          return {
            ...buildProgressPatch({
              body,
              payload,
              responseStatus,
              stoppedReason: "waiting_for_deliverable_approval",
              taskStatus: TASK_STATUSES.waitingForUser,
            }),
            requiredUserAction: AGENT_TASK_ACTIONS.approveDeliverables,
            status: TASK_STATUSES.waitingForUser,
            summary: "Agent task is waiting for deliverable approval.",
          };
        }

        payload = {
          ...payload,
          deliverables,
        };

        return {
          ...buildProgressPatch({
            body,
            payload,
            responseStatus,
            stoppedReason: "completed",
            taskStatus: TASK_STATUSES.completed,
          }),
          requiredUserAction: "",
          status: TASK_STATUSES.completed,
          summary: "Agent task completed.",
        };
      }

      question = nextQuestion;
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
        taskStatus: TASK_STATUSES.waitingForUser,
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
      const nextQuestion =
        normalizeText(taskPayload.lastQuestion) ||
        normalizeText(taskPayload.nextQuestion) ||
        normalizeText(taskPayload.pending?.question) ||
        taskPayload.question;
      const resumedPayload = {
        ...nextPayload,
        capabilityApprovals: buildApprovalMap({
          payload,
          task,
        }),
        nextQuestion,
        resumeAgentRunId: true,
      };
      const planFields = buildAgentGoalPlanTaskFields({
        payload: resumedPayload,
        stoppedReason: "queued_after_approval",
        taskStatus: TASK_STATUSES.queued,
      });

      return {
        items: planFields.items,
        payload: resumedPayload,
        result: planFields.result,
        status: TASK_STATUSES.queued,
        summary: "Agent task queued after approval.",
      };
    }

    if (normalizedAction === AGENT_TASK_ACTIONS.approveDeliverables) {
      const deliverables = normalizeRecord(taskPayload.deliverables, null);

      if (!deliverables || !toArray(deliverables.specs).length) {
        throw buildTaskError("No goal deliverables are waiting for approval.", 409);
      }

      if (!isDeliverableApprovalPending(deliverables)) {
        throw buildTaskError("Goal deliverables are not waiting for approval.", 409);
      }

      const resumedPayload = {
        ...nextPayload,
        deliverables: {
          ...deliverables,
          approval: buildDeliverableApproval(payload),
          status: AGENT_GOAL_DELIVERABLE_STATUSES.approved,
        },
        nextQuestion: "",
        resumeAgentRunId: false,
      };
      const planFields = buildAgentGoalPlanTaskFields({
        body: buildBodyFromPayload(resumedPayload),
        payload: resumedPayload,
        responseStatus: getLastResponseStatus(resumedPayload),
        stoppedReason: "queued_after_deliverable_approval",
        taskStatus: TASK_STATUSES.queued,
      });

      return {
        items: planFields.items,
        payload: resumedPayload,
        result: planFields.result,
        status: TASK_STATUSES.queued,
        summary: "Agent task queued to create approved deliverables.",
      };
    }

    if (normalizedAction === AGENT_TASK_ACTIONS.continue) {
      const nextQuestion =
        normalizeText(payload.question) ||
        normalizeText(payload.answer) ||
        normalizeText(payload.userInput) ||
        normalizeText(taskPayload.nextQuestion) ||
        normalizeText(taskPayload.pending?.question) ||
        normalizeText(taskPayload.lastQuestion) ||
        taskPayload.question;
      const maxIterations = getResumeMaxIterations({
        payload,
        taskPayload,
      });
      const docIds = payload.docIds ? normalizeDocIds(payload.docIds) : taskPayload.docIds;
      const resumedPayload = {
        ...nextPayload,
        capabilityApprovals: {},
        docIds,
        maxIterations,
        nextQuestion,
        question: nextQuestion,
        resumeAgentRunId:
          task.status === TASK_STATUSES.failed ||
          Boolean(taskPayload.pending?.agentRunId),
        taskMemory: buildAgentTaskPlanningContext({
          ...nextPayload.taskMemory,
          goal: nextPayload.taskMemory?.goal || nextPayload.question,
          userPreferences: [
            ...(nextPayload.taskMemory?.userPreferences ?? []),
            ...toArray(payload.userPreferences),
          ],
        }),
        userPreferences: [
          ...taskPayload.userPreferences,
          ...toArray(payload.userPreferences).map(normalizeText).filter(Boolean),
        ],
      };
      const planFields = buildAgentGoalPlanTaskFields({
        payload: resumedPayload,
        stoppedReason: "queued_after_continue",
        taskStatus: TASK_STATUSES.queued,
      });

      return {
        counts: buildCounts({
          iterations: taskPayload.iterations,
          maxIterations,
        }),
        items: planFields.items,
        input: {
          ...task.input,
          docIds,
          maxIterations,
          question: nextQuestion,
        },
        payload: resumedPayload,
        result: planFields.result,
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
