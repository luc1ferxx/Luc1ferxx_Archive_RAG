import React from "react";
import { Button } from "antd";
import { formatTaskStatus } from "./workbenchFormatters";

const toArray = (value) => (Array.isArray(value) ? value : []);

const getGoalPlan = (task = {}) =>
  task.result && typeof task.result === "object" ? task.result.goalPlan : null;

const getPlanItems = (task = {}) => toArray(task.items);

const getDeliverables = (task = {}) =>
  toArray(getGoalPlan(task)?.deliverables?.items);

const getResearchTask = (task = {}) => getGoalPlan(task)?.researchTask ?? null;

const getGoalCompletion = (task = {}) =>
  getGoalPlan(task)?.goalCompletion ?? task.result?.goalCompletion ?? null;

const getApprovalGate = (task = {}) =>
  toArray(task.result?.approvalGates).find((gate) => gate?.capabilityId) ?? null;

const getPrimaryAction = (task = {}) => {
  if (task.type !== "agent_goal") {
    return null;
  }

  if (task.requiredUserAction === "approve_capability") {
    const gate = getApprovalGate(task);

    return {
      action: "approve",
      disabled: !gate?.capabilityId,
      label: "Approve",
      payload: {
        approval: {
          approved: true,
          decision: "approved",
          source: "agent_run_center",
        },
        capabilityId: gate?.capabilityId,
      },
    };
  }

  if (task.requiredUserAction === "approve_deliverables") {
    return {
      action: "approve_deliverables",
      disabled: false,
      label: "Approve deliverables",
      payload: {
        approval: {
          approved: true,
          decision: "approved",
          source: "agent_run_center",
        },
      },
    };
  }

  if (task.requiredUserAction === "continue_task") {
    return {
      action: "continue",
      disabled: false,
      label: "Continue",
      payload: {},
    };
  }

  return null;
};

const renderPlanMeta = (task = {}) => {
  const goalPlan = getGoalPlan(task);
  const counts = goalPlan?.counts ?? {};

  if (!goalPlan) {
    return null;
  }

  return (
    <div className="archive-agent-task-meta" aria-label="Goal plan progress">
      <span>{formatTaskStatus(goalPlan.status)}</span>
      <span>
        {counts.completed ?? 0}/{counts.total ?? 0} done
      </span>
      {goalPlan.maxIterations ? (
        <span>{goalPlan.completedIterations ?? 0}/{goalPlan.maxIterations} runs</span>
      ) : null}
    </div>
  );
};

const AgentTaskPlan = ({ task }) => {
  const planItems = getPlanItems(task);

  if (planItems.length === 0) {
    return (
      <div className="archive-agent-plan-empty">
        No public plan steps have been reported.
      </div>
    );
  }

  return (
    <div className="archive-agent-plan-list">
      {planItems.map((item, index) => (
        <div
          className={`archive-agent-plan-step is-${item.status ?? "pending"}`}
          key={item.id ?? `${task.id}-step-${index}`}
        >
          <span>{index + 1}</span>
          <div>
            <strong>{item.label || `Step ${index + 1}`}</strong>
            <p>{item.summary || "No step summary reported."}</p>
          </div>
          <em>{formatTaskStatus(item.status)}</em>
        </div>
      ))}
    </div>
  );
};

const AgentTaskResearchFlow = ({ task }) => {
  const researchTask = getResearchTask(task);
  const phases = toArray(researchTask?.phases);

  if (phases.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-research-flow" aria-label="Research task flow">
      {phases.map((phase, index) => (
        <div
          className={`archive-agent-research-phase is-${
            phase.status ?? "pending"
          }`}
          key={phase.id ?? `${task.id}-research-phase-${index}`}
        >
          <span>{index + 1}</span>
          <div>
            <strong>{phase.label || `Research phase ${index + 1}`}</strong>
            <p>{phase.summary || phase.expectedSkill || phase.expectedCapability}</p>
          </div>
          <em>{formatTaskStatus(phase.status)}</em>
        </div>
      ))}
    </div>
  );
};

const getDeliverableOutputText = (deliverable = {}) => {
  const output = deliverable.output ?? {};

  if (output.fileName) {
    return output.fileName;
  }

  if (output.task?.taskId) {
    return output.task.taskId;
  }

  if (Number.isFinite(Number(output.documentCount))) {
    return `${output.documentCount} documents`;
  }

  return deliverable.title || deliverable.capabilityId || "";
};

const AgentTaskDeliverables = ({ task }) => {
  const deliverables = getDeliverables(task);

  if (deliverables.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-deliverables" aria-label="Goal deliverables">
      {deliverables.map((deliverable, index) => (
        <div
          className={`archive-agent-deliverable is-${
            deliverable.status ?? "pending"
          }`}
          key={deliverable.id ?? `${task.id}-deliverable-${index}`}
        >
          <div>
            <strong>{deliverable.label || `Deliverable ${index + 1}`}</strong>
            <p>{deliverable.summary || getDeliverableOutputText(deliverable)}</p>
          </div>
          <span>{formatTaskStatus(deliverable.status)}</span>
        </div>
      ))}
    </div>
  );
};

const AgentTaskGoalCompletion = ({ task }) => {
  const completion = getGoalCompletion(task);
  const checks = toArray(completion?.checks);

  if (!completion || checks.length === 0) {
    return null;
  }

  return (
    <div
      className={`archive-agent-goal-completion is-${
        completion.status ?? "pending"
      }`}
      aria-label="Goal completion checks"
    >
      <div className="archive-agent-goal-completion-head">
        <strong>Goal completion</strong>
        <span>{formatTaskStatus(completion.status)}</span>
      </div>
      <p>{completion.summary || "Goal completion checks reported."}</p>
      <div className="archive-agent-goal-checks">
        {checks.map((check) => (
          <span
            className={check.passed ? "is-passed" : "is-blocked"}
            key={check.id}
          >
            {check.label}
          </span>
        ))}
      </div>
    </div>
  );
};

const AgentTaskCard = ({ onTaskAction, task }) => {
  const primaryAction = getPrimaryAction(task);
  const goalPlan = getGoalPlan(task);

  return (
    <article className={`archive-agent-task is-${task.status ?? "pending"}`}>
      <header>
        <div>
          <span>{formatTaskStatus(task.status)}</span>
          <strong>{task.label || "Agent task"}</strong>
          <p>{goalPlan?.goal || task.summary || "No task summary reported."}</p>
        </div>
        {renderPlanMeta(task)}
      </header>

      <AgentTaskPlan task={task} />

      <AgentTaskResearchFlow task={task} />

      <AgentTaskDeliverables task={task} />

      <AgentTaskGoalCompletion task={task} />

      {goalPlan && task.summary ? (
        <p className="archive-agent-task-summary">{task.summary}</p>
      ) : null}

      {primaryAction ? (
        <div className="archive-agent-task-actions">
          <Button
            disabled={primaryAction.disabled}
            onClick={() =>
              onTaskAction?.(task, primaryAction.action, primaryAction.payload)
            }
            size="small"
            type="primary"
          >
            {primaryAction.label}
          </Button>
        </div>
      ) : null}
    </article>
  );
};

const AgentRunCenter = ({ isLoading = false, onTaskAction, tasks = [] }) => (
  <div className="archive-view-panel archive-tasks-view">
    <div className="archive-view-panel-head">
      <span>Agent Run Center</span>
      <strong>{isLoading ? "loading" : `${tasks.length} active`}</strong>
    </div>
    <div className="archive-agent-task-list">
      {tasks.map((task, index) => (
        <AgentTaskCard
          key={task.id ?? `${task.label}-${index}`}
          onTaskAction={onTaskAction}
          task={task}
        />
      ))}
    </div>
  </div>
);

export default AgentRunCenter;
