import React from "react";
import { Button } from "antd";
import { createTranslator } from "../archiveI18n";
import ApprovalGatePreviewList from "./ApprovalGatePreviewList";
import { formatStatusLabel, formatStepLabel } from "./workbenchFormatters";

// English unless the app hands in its translator.
const defaultT = createTranslator("en");

const toArray = (value) => (Array.isArray(value) ? value : []);

// A finished task (the server's canceled, completed and failed; skipped for a
// trace step) is not active: the header counts what still needs the agent or
// the user, while the list below shows every task.
const FINISHED_STATUSES = new Set(["canceled", "completed", "failed", "skipped"]);

const getGoalPlan = (task = {}) =>
  task.result && typeof task.result === "object" ? task.result.goalPlan : null;

const getPlanItems = (task = {}) => toArray(task.items);

const getDeliverables = (task = {}) =>
  toArray(getGoalPlan(task)?.deliverables?.items);

const getResearchTask = (task = {}) => getGoalPlan(task)?.researchTask ?? null;

const getGoalCompletion = (task = {}) =>
  getGoalPlan(task)?.goalCompletion ?? task.result?.goalCompletion ?? null;

const getApprovalGate = (task = {}) =>
  toArray(task.result?.approvalGates).find(
    (gate) => gate?.status === "pending"
  ) ?? null;

const getApprovalGates = (task = {}) =>
  toArray(task.result?.approvalGates).filter(
    (gate) => gate?.status === "pending"
  );

const normalizeApprovalBinding = (value) =>
  typeof value === "string" ? value.trim() : "";

const getPrimaryAction = (task = {}, t) => {
  if (task.type !== "agent_goal") {
    return null;
  }

  if (task.requiredUserAction === "approve_capability") {
    const gate = getApprovalGate(task);
    const approvalObjectHash = normalizeApprovalBinding(
      gate?.approvalObjectHash
    );
    const gateId = normalizeApprovalBinding(gate?.id);

    return {
      action: "approve",
      disabled: !gateId || !approvalObjectHash,
      label: t("run.approve"),
      payload: {
        approval: {
          approved: true,
          decision: "approved",
          source: "agent_run_center",
        },
        approvalObjectHash,
        gateId,
      },
    };
  }

  if (task.requiredUserAction === "approve_deliverables") {
    const approvalBindings = getApprovalGates(task).map((gate) => ({
      approvalObjectHash: normalizeApprovalBinding(
        gate?.approvalObjectHash
      ),
      gateId: normalizeApprovalBinding(gate?.id),
    }));

    return {
      action: "approve_deliverables",
      disabled:
        approvalBindings.length === 0 ||
        approvalBindings.some(
          (binding) => !binding.gateId || !binding.approvalObjectHash
        ),
      label: t("tasks.approveDeliverables"),
      payload: {
        approvalBindings,
      },
    };
  }

  if (task.requiredUserAction === "continue_task") {
    return {
      action: "continue",
      disabled: false,
      label: t("tasks.continue"),
      payload: {},
    };
  }

  return null;
};

const renderPlanMeta = (task = {}, t) => {
  const goalPlan = getGoalPlan(task);
  const counts = goalPlan?.counts ?? {};
  // Runs past the budget, which only an approved gate allows (server/rag/agent-goal-plan.js).
  // A plan stored before the server counted them has no field: they are the
  // runs past maxIterations.
  const overBudget =
    goalPlan?.overBudgetIterations ??
    Math.max(0, (goalPlan?.completedIterations ?? 0) - (goalPlan?.maxIterations ?? Infinity));

  if (!goalPlan) {
    return null;
  }

  return (
    <div className="archive-agent-task-meta" aria-label={t("tasks.goalPlanProgress")}>
      <span>{formatStatusLabel(goalPlan.status, t)}</span>
      <span>
        {t("tasks.doneCount", {
          done: counts.completed ?? 0,
          total: counts.total ?? 0,
        })}
      </span>
      {goalPlan.maxIterations ? (
        <span>
          {t("tasks.runCount", {
            max: goalPlan.maxIterations,
            used: (goalPlan.completedIterations ?? 0) - overBudget,
          })}
          {overBudget
            ? ` · ${t("tasks.afterApproval", { count: overBudget })}`
            : null}
        </span>
      ) : null}
    </div>
  );
};

// An arXiv recommendation paper's summary is its status code
// (server/rag/recommendation-task-builders.js): read as a label, and left out
// where it only repeats the item's own status.
const getPlanItemSummary = (item, t) => {
  if (!item.summary) {
    return t("tasks.noStepSummary");
  }

  if (item.summary === item.status) {
    return null;
  }

  return /^[a-z]+(?:_[a-z]+)*$/.test(item.summary)
    ? formatStatusLabel(item.summary, t)
    : item.summary;
};

const AgentTaskPlan = ({ t, task }) => {
  const planItems = getPlanItems(task);

  if (planItems.length === 0) {
    return (
      <div className="archive-agent-plan-empty">{t("tasks.noPlanSteps")}</div>
    );
  }

  return (
    <div className="archive-agent-plan-list">
      {planItems.map((item, index) => {
        const summary = getPlanItemSummary(item, t);

        return (
          <div
            className={`archive-agent-plan-step is-${item.status ?? "pending"}`}
            key={item.id ?? `${task.id}-step-${index}`}
          >
            <span>{index + 1}</span>
            <div>
              <strong>{item.label || t("tasks.step", { number: index + 1 })}</strong>
              {summary ? <p>{summary}</p> : null}
            </div>
            <em>{formatStatusLabel(item.status, t)}</em>
          </div>
        );
      })}
    </div>
  );
};

const AgentTaskResearchFlow = ({ t, task }) => {
  const researchTask = getResearchTask(task);
  const phases = toArray(researchTask?.phases);

  if (phases.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-research-flow" aria-label={t("tasks.researchFlow")}>
      {phases.map((phase, index) => (
        <div
          className={`archive-agent-research-phase is-${
            phase.status ?? "pending"
          }`}
          key={phase.id ?? `${task.id}-research-phase-${index}`}
        >
          <span>{index + 1}</span>
          <div>
            <strong>
              {phase.label || t("tasks.researchPhase", { number: index + 1 })}
            </strong>
            <p>{phase.summary || phase.expectedSkill || phase.expectedCapability}</p>
          </div>
          <em>{formatStatusLabel(phase.status, t)}</em>
        </div>
      ))}
    </div>
  );
};

const getDeliverableOutputText = (deliverable = {}, t) => {
  const output = deliverable.output ?? {};

  if (output.fileName) {
    return output.fileName;
  }

  if (output.task?.taskId) {
    return output.task.taskId;
  }

  if (Number.isFinite(Number(output.documentCount))) {
    return t("common.documentCount", { count: Number(output.documentCount) });
  }

  return deliverable.title || deliverable.capabilityId || "";
};

const AgentTaskDeliverables = ({ t, task }) => {
  const deliverables = getDeliverables(task);

  if (deliverables.length === 0) {
    return null;
  }

  return (
    <div className="archive-agent-deliverables" aria-label={t("tasks.deliverables")}>
      {deliverables.map((deliverable, index) => (
        <div
          className={`archive-agent-deliverable is-${
            deliverable.status ?? "pending"
          }`}
          key={deliverable.id ?? `${task.id}-deliverable-${index}`}
        >
          <div>
            <strong>
              {deliverable.label || t("tasks.deliverable", { number: index + 1 })}
            </strong>
            <p>{deliverable.summary || getDeliverableOutputText(deliverable, t)}</p>
          </div>
          <span>{formatStatusLabel(deliverable.status, t)}</span>
        </div>
      ))}
    </div>
  );
};

const AgentTaskGoalCompletion = ({ t, task }) => {
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
      aria-label={t("tasks.goalChecks")}
    >
      <div className="archive-agent-goal-completion-head">
        <strong>{t("tasks.goalCompletion")}</strong>
        <span>{formatStatusLabel(completion.status, t)}</span>
      </div>
      <p>{completion.summary || t("tasks.goalChecksReported")}</p>
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

const AgentTaskCard = ({ onTaskAction, t, task }) => {
  const primaryAction = getPrimaryAction(task, t);
  const goalPlan = getGoalPlan(task);
  const pendingApprovalGates = getApprovalGates(task);
  const showsApprovalAction =
    primaryAction?.action === "approve" ||
    primaryAction?.action === "approve_deliverables";
  const displayedApprovalGates =
    primaryAction?.action === "approve_deliverables"
      ? pendingApprovalGates
      : pendingApprovalGates.slice(0, 1);

  return (
    <article className={`archive-agent-task is-${task.status ?? "pending"}`}>
      <header>
        <div>
          <span>{formatStatusLabel(task.status, t)}</span>
          <strong>
            {formatStepLabel({ label: task.label || t("tasks.agentTask"), type: task.type }, t)}
          </strong>
          <p>{goalPlan?.goal || task.summary || t("tasks.noTaskSummary")}</p>
        </div>
        {renderPlanMeta(task, t)}
      </header>

      <AgentTaskPlan t={t} task={task} />

      <AgentTaskResearchFlow t={t} task={task} />

      <AgentTaskDeliverables t={t} task={task} />

      <AgentTaskGoalCompletion t={t} task={task} />

      {goalPlan && task.summary ? (
        <p className="archive-agent-task-summary">{task.summary}</p>
      ) : null}

      {showsApprovalAction ? (
        <ApprovalGatePreviewList
          ariaLabel={t(
            primaryAction.action === "approve_deliverables"
              ? "tasks.pendingDeliverableApprovals"
              : "tasks.pendingCapabilityApprovals"
          )}
          gates={displayedApprovalGates}
          t={t}
        />
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

const AgentRunCenter = ({
  isLoading = false,
  onTaskAction,
  t = defaultT,
  tasks = [],
}) => {
  // With no task yet, a placeholder card says how to start one; the header
  // counts real tasks only.
  const shownTasks =
    tasks.length > 0
      ? tasks
      : [
          {
            id: "idle-task",
            label: t("tasks.idle.label"),
            status: "pending",
            summary: t("tasks.idle.summary"),
          },
        ];

  return (
    <div className="archive-view-panel archive-tasks-view">
      <div className="archive-view-panel-head">
        <span>{t("tasks.runCenter")}</span>
        <strong>
          {isLoading
            ? t("tasks.loading")
            : t("tasks.active", {
                count: tasks.filter((task) => !FINISHED_STATUSES.has(task.status)).length,
              })}
        </strong>
      </div>
      <div className="archive-agent-task-list">
        {shownTasks.map((task, index) => (
          <AgentTaskCard
            key={task.id ?? `${task.label}-${index}`}
            onTaskAction={onTaskAction}
            t={t}
            task={task}
          />
        ))}
      </div>
    </div>
  );
};

export default React.memo(AgentRunCenter);
