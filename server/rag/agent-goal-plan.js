import { TASK_STATUSES } from "./tasks.js";
import {
  AGENT_GOAL_DELIVERABLE_STATUSES,
  compactAgentGoalDeliverables,
  getDeliverableTaskStatus,
} from "./agent-goal-deliverables.js";
import {
  buildAgentGoalCompletion,
  compactAgentGoalCompletion,
} from "./agent-goal-completion.js";
import { compactResearchTaskFlow } from "./agent-research-task.js";

export const AGENT_GOAL_PLAN_VERSION = "1.0.0";

const MAX_TEXT_LENGTH = 220;

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const buildPlanItem = ({
  error = null,
  id,
  label,
  result = {},
  status = TASK_STATUSES.pending,
  summary = "",
} = {}) => ({
  id: normalizeText(id, 80),
  status,
  label: normalizeText(label, 120),
  summary: normalizeText(summary),
  result: normalizeRecord(result),
  error,
});

const getIterationStatus = (iteration = {}) => {
  const responseStatus = Number(iteration.responseStatus ?? 200);

  if (responseStatus >= 400) {
    return TASK_STATUSES.failed;
  }

  if (iteration.clarificationNeeded) {
    return TASK_STATUSES.waitingForUser;
  }

  return TASK_STATUSES.completed;
};

const buildIterationSummary = (iteration = {}) => {
  if (iteration.clarificationNeeded) {
    return (
      normalizeText(iteration.clarificationReason) ||
      "Waiting for user input before continuing."
    );
  }

  return normalizeText(iteration.answer) || "Agent step completed.";
};

const buildIterationItems = (iterations = []) =>
  toArray(iterations).map((iteration, index) => {
    const phase = normalizeRecord(iteration.researchTaskPhase, null);

    return buildPlanItem({
      id: `iteration-${index + 1}`,
      label: phase?.label || `Agent step ${index + 1}`,
      result: {
        agentMode: normalizeText(iteration.agentMode, 80),
        agentRunId: normalizeText(iteration.agentRunId, 120),
        citationCount: toArray(iteration.citations).length,
        question: normalizeText(iteration.question),
        researchTaskPhase: phase
          ? {
              expectedCapability: normalizeText(phase.expectedCapability, 120),
              expectedSkill: normalizeText(phase.expectedSkill, 120),
              id: normalizeText(phase.id, 80),
              label: normalizeText(phase.label, 120),
            }
          : null,
        responseStatus: Number.isFinite(Number(iteration.responseStatus))
          ? Number(iteration.responseStatus)
          : null,
      },
      status: getIterationStatus(iteration),
      summary: buildIterationSummary(iteration),
    });
  });

const getPendingSummary = (pending = {}) =>
  normalizeText(pending.question) ||
  normalizeText(pending.reason) ||
  "Waiting for user input.";

const buildPendingItem = ({ pending = {}, requiredUserAction = "" } = {}) => {
  if (!pending || Object.keys(pending).length === 0) {
    return null;
  }

  return buildPlanItem({
    id: "user-input",
    label:
      requiredUserAction === "approve_capability"
        ? "Approval required"
        : requiredUserAction === "approve_deliverables"
          ? "Deliverable approval required"
        : "User input required",
    result: {
      agentRunId: normalizeText(pending.agentRunId, 120),
      approvalGateCount: toArray(pending.approvalGates).length,
      deliverableCount: toArray(pending.deliverables).length,
      reason: normalizeText(pending.reason, 120),
      requiredUserAction: normalizeText(requiredUserAction, 80),
    },
    status: TASK_STATUSES.waitingForUser,
    summary: getPendingSummary(pending),
  });
};

const buildNextItem = ({ nextQuestion = "", status = TASK_STATUSES.pending } = {}) => {
  const summary = normalizeText(nextQuestion);

  if (!summary) {
    return null;
  }

  return buildPlanItem({
    id: "next-step",
    label: "Next planned step",
    result: {
      question: summary,
    },
    status,
    summary,
  });
};

const buildAgentLoopItem = ({
  question = "",
  taskStatus = TASK_STATUSES.pending,
} = {}) => {
  if (![TASK_STATUSES.queued, TASK_STATUSES.running].includes(taskStatus)) {
    return null;
  }

  return buildPlanItem({
    id: "agent-loop",
    label: "Run agent step",
    result: {
      question: normalizeText(question),
    },
    status: taskStatus,
    summary: normalizeText(question) || "Run the first agent step.",
  });
};

const getDeliverableStatus = ({
  deliverables = {},
  stoppedReason = "",
  taskStatus = "",
} = {}) => {
  const deliverableStatus = getDeliverableTaskStatus(deliverables);

  if (deliverableStatus !== TASK_STATUSES.pending) {
    return deliverableStatus;
  }

  if (stoppedReason === "completed" || taskStatus === TASK_STATUSES.completed) {
    return TASK_STATUSES.completed;
  }

  if (stoppedReason === "failed" || taskStatus === TASK_STATUSES.failed) {
    return TASK_STATUSES.failed;
  }

  if (
    stoppedReason === "waiting_for_user" ||
    stoppedReason === "iteration_budget_exhausted" ||
    taskStatus === TASK_STATUSES.waitingForUser
  ) {
    return TASK_STATUSES.waitingForUser;
  }

  return TASK_STATUSES.pending;
};

const buildDeliverableItem = ({
  body = {},
  deliverables = {},
  stoppedReason = "",
  taskStatus = TASK_STATUSES.pending,
} = {}) => {
  const compactDeliverables = compactAgentGoalDeliverables(deliverables);
  const status = getDeliverableStatus({
    deliverables,
    stoppedReason,
    taskStatus,
  });
  const answer = normalizeText(body.agentAnswer);
  const deliverableCount = compactDeliverables.counts.planned ?? 0;
  const summary = (() => {
    if (
      compactDeliverables.status ===
      AGENT_GOAL_DELIVERABLE_STATUSES.waitingForApproval
    ) {
      return `Waiting for approval to create ${deliverableCount} deliverable${
        deliverableCount === 1 ? "" : "s"
      }.`;
    }

    if (
      compactDeliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.running ||
      compactDeliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.approved
    ) {
      return "Creating approved goal deliverables.";
    }

    if (compactDeliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.completed) {
      return `Created ${compactDeliverables.counts.completed} deliverable${
        compactDeliverables.counts.completed === 1 ? "" : "s"
      }.`;
    }

    if (compactDeliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.failed) {
      return `Created ${compactDeliverables.counts.completed} deliverable${
        compactDeliverables.counts.completed === 1 ? "" : "s"
      }; ${compactDeliverables.counts.failed} failed.`;
    }

    if (status === TASK_STATUSES.completed) {
      return answer || "Final result is ready.";
    }

    if (status === TASK_STATUSES.failed) {
      return normalizeText(body.error) || "Goal failed before completion.";
    }

    if (status === TASK_STATUSES.waitingForUser) {
      return "Delivery is paused until the required user action is resolved.";
    }

    return "Waiting for the agent to finish the goal.";
  })();

  return buildPlanItem({
    id: "deliverable",
    label: "Deliver result",
    result: {
      agentMode: normalizeText(body.agentMode, 80),
      agentRunId: normalizeText(body.agentRunId, 120),
      deliverables: compactDeliverables,
    },
    status,
    summary,
  });
};

const countItems = (items = []) => ({
  completed: items.filter((item) => item.status === TASK_STATUSES.completed).length,
  failed: items.filter((item) => item.status === TASK_STATUSES.failed).length,
  total: items.length,
  waiting: items.filter((item) => item.status === TASK_STATUSES.waitingForUser)
    .length,
});

const getCurrentStepId = (items = []) =>
  items.find((item) =>
    [
      TASK_STATUSES.running,
      TASK_STATUSES.waitingForUser,
      TASK_STATUSES.failed,
      TASK_STATUSES.queued,
      TASK_STATUSES.pending,
    ].includes(item.status)
  )?.id ?? null;

const buildGoalItem = ({ goal = "", taskStatus = TASK_STATUSES.pending } = {}) =>
  buildPlanItem({
    id: "goal",
    label: "Goal",
    result: {
      goal: normalizeText(goal),
    },
    status: normalizeText(goal) ? TASK_STATUSES.completed : taskStatus,
    summary: normalizeText(goal) || "No goal was provided.",
  });

const getRequiredUserAction = ({
  body = {},
  payload = {},
  stoppedReason = "",
  taskStatus = TASK_STATUSES.pending,
} = {}) => {
  if (taskStatus !== TASK_STATUSES.waitingForUser) {
    return "";
  }

  if (
    payload.deliverables?.status ===
    AGENT_GOAL_DELIVERABLE_STATUSES.waitingForApproval
  ) {
    return "approve_deliverables";
  }

  if (
    body?.clarification?.reason === "capability_approval_required" ||
    toArray(payload.pending?.approvalGates).length > 0
  ) {
    return "approve_capability";
  }

  if (stoppedReason === "iteration_budget_exhausted") {
    return "continue_task";
  }

  return "answer_clarification";
};

export const buildAgentGoalPlan = ({
  body = {},
  payload = {},
  responseStatus = 200,
  stoppedReason = "",
  taskStatus = TASK_STATUSES.pending,
} = {}) => {
  const normalizedPayload = normalizeRecord(payload);
  const goal = normalizeText(
    normalizedPayload.taskMemory?.goal ||
      normalizedPayload.question ||
      normalizedPayload.lastQuestion
  );
  const requiredUserAction = getRequiredUserAction({
    body,
    payload: normalizedPayload,
    stoppedReason,
    taskStatus,
  });
  const iterationItems = buildIterationItems(normalizedPayload.iterations);
  const pendingItem = buildPendingItem({
    pending: normalizedPayload.pending,
    requiredUserAction,
  });
  const nextItem =
    !pendingItem && taskStatus !== TASK_STATUSES.completed
      ? buildNextItem({
          nextQuestion: normalizedPayload.nextQuestion,
          status:
            taskStatus === TASK_STATUSES.running
              ? TASK_STATUSES.queued
              : TASK_STATUSES.pending,
        })
      : null;
  const agentLoopItem =
    iterationItems.length === 0 && !pendingItem && !nextItem
      ? buildAgentLoopItem({
          question: normalizedPayload.nextQuestion || normalizedPayload.question,
          taskStatus,
        })
      : null;
  const items = [
    buildGoalItem({
      goal,
      taskStatus,
    }),
    agentLoopItem,
    ...iterationItems,
    pendingItem,
    nextItem,
    buildDeliverableItem({
      body: {
        ...body,
        responseStatus,
      },
      deliverables: normalizedPayload.deliverables,
      stoppedReason,
      taskStatus,
    }),
  ].filter(Boolean);
  const counts = countItems(items);
  const goalCompletion = buildAgentGoalCompletion({
    body,
    goalPlan: {
      deliverables: normalizedPayload.deliverables,
      items,
      requiredUserAction,
      researchTask: normalizedPayload.researchTask,
    },
    items,
    payload: normalizedPayload,
    requiredUserAction,
    stoppedReason,
    taskStatus,
  });

  return {
    version: AGENT_GOAL_PLAN_VERSION,
    goal,
    status: taskStatus,
    stoppedReason: normalizeText(stoppedReason, 80),
    currentStepId: getCurrentStepId(items),
    counts,
    completedIterations: iterationItems.length,
    deliverables: normalizedPayload.deliverables,
    goalCompletion,
    maxIterations: Number.isFinite(Number(normalizedPayload.maxIterations))
      ? Number(normalizedPayload.maxIterations)
      : null,
    requiredUserAction,
    researchTask: compactResearchTaskFlow(normalizedPayload.researchTask),
    items,
  };
};

export const compactAgentGoalPlan = (plan = {}) => ({
  version: plan.version ?? AGENT_GOAL_PLAN_VERSION,
  goal: normalizeText(plan.goal),
  status: normalizeText(plan.status, 80),
  stoppedReason: normalizeText(plan.stoppedReason, 80),
  currentStepId: normalizeText(plan.currentStepId, 80) || null,
  counts: normalizeRecord(plan.counts),
  completedIterations: Number.isFinite(Number(plan.completedIterations))
    ? Number(plan.completedIterations)
    : 0,
  deliverables: compactAgentGoalDeliverables(plan.deliverables),
  goalCompletion: compactAgentGoalCompletion(plan.goalCompletion),
  maxIterations: Number.isFinite(Number(plan.maxIterations))
    ? Number(plan.maxIterations)
    : null,
  requiredUserAction: normalizeText(plan.requiredUserAction, 80),
  researchTask: compactResearchTaskFlow(plan.researchTask),
});

export const buildAgentGoalPlanTaskFields = (options = {}) => {
  const plan = buildAgentGoalPlan(options);
  const compactPlan = compactAgentGoalPlan(plan);

  return {
    items: plan.items,
    result: {
      goalCompletion: compactPlan.goalCompletion,
      goalPlan: compactPlan,
    },
  };
};
