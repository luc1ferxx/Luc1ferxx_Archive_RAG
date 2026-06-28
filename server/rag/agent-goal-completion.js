import {
  AGENT_GOAL_DELIVERABLE_STATUSES,
  compactAgentGoalDeliverables,
} from "./agent-goal-deliverables.js";
import { compactResearchTaskFlow } from "./agent-research-task.js";
import { TASK_STATUSES } from "./tasks.js";

export const AGENT_GOAL_COMPLETION_VERSION = "1.0.0";

export const AGENT_GOAL_COMPLETION_STATUSES = Object.freeze({
  blocked: "blocked",
  completed: "completed",
  failed: "failed",
  pending: "pending",
  running: "running",
});

const MAX_TEXT_LENGTH = 240;

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const countArray = (value) => toArray(value).length;

export const compactAgentGoalWorkingMemory = (value = {}) => {
  const workingMemory = normalizeRecord(
    value.agentWorkingMemory ?? value.agentObservability?.workingMemory ?? value,
    {}
  );

  return {
    checkedQueryCount: countArray(workingMemory.checkedQueries),
    resolvedGapCount: countArray(workingMemory.resolvedGaps),
    unsupportedClaimCount: countArray(workingMemory.unsupportedClaims),
    unresolvedGapCount: countArray(workingMemory.unresolvedGaps),
  };
};

const getLatestIteration = (payload = {}) => toArray(payload.iterations).at(-1) ?? {};

const getWorkingMemoryCounts = ({ body = {}, payload = {} } = {}) => {
  const bodyCounts = compactAgentGoalWorkingMemory(body);
  const iterationCounts = normalizeRecord(
    getLatestIteration(payload).workingMemory,
    null
  );

  if (
    bodyCounts.checkedQueryCount > 0 ||
    bodyCounts.resolvedGapCount > 0 ||
    bodyCounts.unsupportedClaimCount > 0 ||
    bodyCounts.unresolvedGapCount > 0
  ) {
    return bodyCounts;
  }

  return {
    checkedQueryCount: Number(iterationCounts?.checkedQueryCount ?? 0),
    resolvedGapCount: Number(iterationCounts?.resolvedGapCount ?? 0),
    unsupportedClaimCount: Number(iterationCounts?.unsupportedClaimCount ?? 0),
    unresolvedGapCount: Number(iterationCounts?.unresolvedGapCount ?? 0),
  };
};

const buildCheck = ({ detail = {}, id, label, passed }) => ({
  id,
  label,
  passed: Boolean(passed),
  detail,
});

const getPlanItems = ({ goalPlan = {}, items = [] } = {}) =>
  toArray(goalPlan.items).length > 0 ? toArray(goalPlan.items) : toArray(items);

const getIncompletePlanItems = (items = []) =>
  toArray(items).filter((item) => item.status !== TASK_STATUSES.completed);

const getResearchTask = ({ goalPlan = {}, payload = {} } = {}) =>
  normalizeRecord(payload.researchTask, null) ??
  normalizeRecord(goalPlan.researchTask, null);

const getResearchTaskCounts = (researchTask = null) => {
  if (!researchTask) {
    return {
      completed: 0,
      total: 0,
    };
  }

  if (researchTask.counts) {
    return {
      completed: Number(researchTask.counts.completed ?? 0),
      total: Number(researchTask.counts.total ?? 0),
    };
  }

  const phases = toArray(researchTask.phases);

  return {
    completed: phases.filter((phase) => phase.status === "completed").length,
    total: phases.length,
  };
};

const getResearchTaskWorkflowLifecycle = (researchTask = null) =>
  compactResearchTaskFlow(researchTask)?.workflow ?? null;

const hasWorkflowLifecycleContract = (workflow = null) => {
  const lifecycle = normalizeRecord(workflow, null);

  if (!lifecycle) {
    return false;
  }

  const completionChecks = toArray(lifecycle.completionChecks);
  const deliverables = toArray(lifecycle.deliverables);

  return (
    Boolean(normalizeText(lifecycle.id, 120)) &&
    Boolean(normalizeText(lifecycle.version, 40)) &&
    completionChecks.length > 0 &&
    completionChecks.every((checkId) => normalizeText(checkId, 120)) &&
    deliverables.length > 0 &&
    deliverables.every((deliverable) =>
      normalizeText(deliverable.capabilityId, 120)
    ) &&
    (Boolean(normalizeText(lifecycle.currentPhaseId, 80)) ||
      normalizeText(lifecycle.status, 80) === "completed")
  );
};

const compactWorkflowLifecycleDetail = (workflow = null) => {
  const lifecycle = normalizeRecord(workflow, {});

  return {
    completionCheckIds: toArray(lifecycle.completionChecks).map((checkId) =>
      normalizeText(checkId, 120)
    ),
    currentPhaseId: normalizeText(lifecycle.currentPhaseId, 80) || null,
    deliverableCapabilityIds: toArray(lifecycle.deliverables).map(
      (deliverable) => normalizeText(deliverable.capabilityId, 120)
    ),
    phaseCounts: normalizeRecord(lifecycle.counts),
    status: normalizeText(lifecycle.status, 80),
    workflowId: normalizeText(lifecycle.id, 120),
    workflowType: normalizeText(lifecycle.type, 80),
    workflowVersion: normalizeText(lifecycle.version, 40),
  };
};

const hasPendingUserAction = ({
  deliverables = {},
  payload = {},
  requiredUserAction = "",
} = {}) =>
  Boolean(normalizeText(requiredUserAction)) ||
  Boolean(normalizeRecord(payload.pending, null)) ||
  deliverables.approvalRequired === true ||
  deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.waitingForApproval;

const getCompletionStatus = ({ checks = [], taskStatus = "" } = {}) => {
  if (checks.every((check) => check.passed)) {
    return AGENT_GOAL_COMPLETION_STATUSES.completed;
  }

  if (taskStatus === TASK_STATUSES.failed) {
    return AGENT_GOAL_COMPLETION_STATUSES.failed;
  }

  if ([TASK_STATUSES.queued, TASK_STATUSES.running].includes(taskStatus)) {
    return AGENT_GOAL_COMPLETION_STATUSES.running;
  }

  if (taskStatus === TASK_STATUSES.waitingForUser) {
    return AGENT_GOAL_COMPLETION_STATUSES.pending;
  }

  return AGENT_GOAL_COMPLETION_STATUSES.blocked;
};

const buildSummary = ({ blockers = [], status }) => {
  if (status === AGENT_GOAL_COMPLETION_STATUSES.completed) {
    return "Goal completion checks passed.";
  }

  if (status === AGENT_GOAL_COMPLETION_STATUSES.running) {
    return "Goal completion checks are still running.";
  }

  if (status === AGENT_GOAL_COMPLETION_STATUSES.pending) {
    return "Goal completion checks are waiting for user action.";
  }

  if (status === AGENT_GOAL_COMPLETION_STATUSES.failed) {
    return "Goal completion checks failed.";
  }

  return `Goal completion is blocked by ${blockers.length} check${
    blockers.length === 1 ? "" : "s"
  }.`;
};

export const buildAgentGoalCompletion = ({
  body = {},
  goalPlan = {},
  items = [],
  payload = {},
  requiredUserAction = "",
  stoppedReason = "",
  taskStatus = TASK_STATUSES.pending,
} = {}) => {
  const planItems = getPlanItems({
    goalPlan,
    items,
  });
  const incompletePlanItems = getIncompletePlanItems(planItems);
  const deliverables = compactAgentGoalDeliverables(
    payload.deliverables ?? goalPlan.deliverables
  );
  const deliverablesRequested = (deliverables.counts.planned ?? 0) > 0;
  const workingMemory = getWorkingMemoryCounts({
    body,
    payload,
  });
  const researchTask = getResearchTask({
    goalPlan,
    payload,
  });
  const researchTaskCounts = getResearchTaskCounts(researchTask);
  const researchTaskWorkflow = getResearchTaskWorkflowLifecycle(researchTask);
  const normalizedRequiredUserAction =
    normalizeText(requiredUserAction) ||
    normalizeText(goalPlan.requiredUserAction);
  const pendingUserAction = hasPendingUserAction({
    deliverables,
    payload,
    requiredUserAction: normalizedRequiredUserAction,
  });
  const checks = [
    buildCheck({
      id: "terminal_status_completed",
      label: "Task reached a terminal completed state",
      passed:
        taskStatus === TASK_STATUSES.completed &&
        (!stoppedReason || stoppedReason === "completed"),
      detail: {
        stoppedReason: normalizeText(stoppedReason, 80),
        taskStatus: normalizeText(taskStatus, 80),
      },
    }),
    buildCheck({
      id: "plan_steps_completed",
      label: "All public plan steps completed",
      passed:
        planItems.length > 0 &&
        incompletePlanItems.length === 0 &&
        taskStatus === TASK_STATUSES.completed,
      detail: {
        incompleteStepIds: incompletePlanItems.map((item) =>
          normalizeText(item.id, 80)
        ),
        totalStepCount: planItems.length,
      },
    }),
    buildCheck({
      id: "evidence_gaps_resolved",
      label: "No unresolved evidence gaps remain",
      passed:
        workingMemory.unresolvedGapCount === 0 &&
        workingMemory.unsupportedClaimCount === 0,
      detail: workingMemory,
    }),
    buildCheck({
      id: "deliverables_created",
      label: "Requested goal deliverables were created",
      passed:
        !deliverablesRequested ||
        (deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.completed &&
          deliverables.counts.completed === deliverables.counts.planned &&
          deliverables.counts.failed === 0),
      detail: {
        completed: deliverables.counts.completed ?? 0,
        failed: deliverables.counts.failed ?? 0,
        planned: deliverables.counts.planned ?? 0,
        status: deliverables.status,
      },
    }),
    buildCheck({
      id: "no_pending_user_action",
      label: "No pending approval or user action remains",
      passed: !pendingUserAction,
      detail: {
        pendingReason: normalizeText(payload.pending?.reason, 120),
        requiredUserAction: normalizedRequiredUserAction,
      },
    }),
    buildCheck({
      id: "research_phases_completed",
      label: "Research task phases completed when requested",
      passed:
        !researchTask ||
        (researchTask.status === "completed" &&
          researchTaskCounts.total > 0 &&
          researchTaskCounts.completed === researchTaskCounts.total),
      detail: {
        completed: researchTaskCounts.completed,
        status: normalizeText(researchTask?.status, 80),
        total: researchTaskCounts.total,
        workflowId: normalizeText(researchTaskWorkflow?.id, 120),
        workflowVersion: normalizeText(researchTaskWorkflow?.version, 40),
      },
    }),
    buildCheck({
      id: "workflow_lifecycle_recorded",
      label: "Workflow lifecycle contract is recorded when requested",
      passed:
        !researchTask || hasWorkflowLifecycleContract(researchTaskWorkflow),
      detail: compactWorkflowLifecycleDetail(researchTaskWorkflow),
    }),
  ];
  const blockers = checks.filter((check) => !check.passed);
  const status = getCompletionStatus({
    checks,
    taskStatus,
  });

  return {
    version: AGENT_GOAL_COMPLETION_VERSION,
    status,
    summary: buildSummary({
      blockers,
      status,
    }),
    checks,
    blockers: blockers.map((blocker) => ({
      id: blocker.id,
      label: blocker.label,
      detail: blocker.detail,
    })),
  };
};

export const compactAgentGoalCompletion = (completion = {}) => ({
  version: normalizeText(completion.version, 40) || AGENT_GOAL_COMPLETION_VERSION,
  status:
    normalizeText(completion.status, 80) ||
    AGENT_GOAL_COMPLETION_STATUSES.pending,
  summary: normalizeText(completion.summary),
  checks: toArray(completion.checks).map((check) => ({
    detail: normalizeRecord(check.detail),
    id: normalizeText(check.id, 120),
    label: normalizeText(check.label, 160),
    passed: check.passed === true,
  })),
  blockers: toArray(completion.blockers).map((blocker) => ({
    detail: normalizeRecord(blocker.detail),
    id: normalizeText(blocker.id, 120),
    label: normalizeText(blocker.label, 160),
  })),
});
