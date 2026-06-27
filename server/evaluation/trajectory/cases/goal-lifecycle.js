import { createJobOrchestrator } from "../../../rag/job-orchestrator.js";
import {
  AGENT_TASK_ACTIONS,
  AGENT_TASK_RUNNER_ID,
  createAgentTaskRunner,
  createAgentTaskService,
} from "../../../rag/agent-tasks.js";
import {
  CAPABILITY_IDS,
} from "../../../rag/capabilities/index.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_STATUSES,
} from "../../../rag/tasks.js";
import { createEvalTelemetry } from "../../agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  buildTrajectoryCheck as buildCheck,
  finishTrajectoryCase as finishCase,
} from "../checks.js";

const getCompletionCheck = (completion = {}, id) =>
  (completion.checks ?? []).find((check) => check.id === id) ?? null;

const createGoalLifecycleCapabilityRegistry = () => {
  const calls = [];

  return {
    calls,
    describe: (capabilityId) => ({
      id: capabilityId,
      version: "1.0.0",
      label: capabilityId,
      approvalPolicy: {
        writesWorkspace: true,
      },
      privacyPolicy: {
        externalCall: false,
        storesResult: true,
      },
    }),
    execute: async (capabilityId, payload = {}) => {
      calls.push({
        capabilityId,
        payload,
      });

      if (capabilityId === CAPABILITY_IDS.reportExport) {
        return {
          report: {
            fileName: "trajectory-risk-report.md",
            format: "markdown",
            mimeType: "text/markdown",
          },
          stored: false,
          text: "Report export created.",
        };
      }

      if (capabilityId === CAPABILITY_IDS.summaryCreate) {
        return {
          summary: {
            docIds: payload.input.docIds,
            title: payload.input.title,
          },
          task: {
            id: "agent_action:trajectory-summary",
            status: TASK_STATUSES.completed,
            summary: "Summary saved.",
            type: "agent_action",
          },
          text: "Summary saved.",
        };
      }

      if (capabilityId === CAPABILITY_IDS.taskCreate) {
        return {
          task: {
            id: "agent_action:trajectory-follow-up",
            status: TASK_STATUSES.completed,
            summary: payload.input.description,
            type: "agent_action",
          },
          text: "Follow-up task created.",
        };
      }

      throw new Error(`Unexpected capability in goal lifecycle eval: ${capabilityId}`);
    },
  };
};

export const createGoalLifecycleCase = () => ({
  id: "agent_goal_lifecycle_completion",
  label: "Agent goal lifecycle completion",
  description:
    "An agent goal should remain incomplete while approval is pending, then pass goal-completion checks after approved deliverables are created.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const capabilityRegistry = createGoalLifecycleCapabilityRegistry();
    const taskService = createTaskService({
      taskStore: createInMemoryTaskStore(),
    });
    const runner = createAgentTaskRunner({
      capabilityRegistry,
      runAgentTask: async ({ question }) => ({
        body: {
          agentAnswer:
            "Risk report ready. The selected policy has a cited renewal risk and a follow-up review action.",
          agentMode: "document",
          agentRunId: "trajectory-goal-run",
          agentWorkingMemory: {
            checkedQueries: [question],
            resolvedGaps: [
              {
                type: "supported_claim",
              },
            ],
            unsupportedClaims: [],
            unresolvedGaps: [],
          },
          ragSources: [
            {
              docId: "policy-1",
              fileName: "policy.pdf",
              pageNumber: 2,
              title: "Policy",
            },
          ],
        },
        status: 200,
      }),
    });
    const orchestrator = createJobOrchestrator({
      runners: {
        [runner.id]: runner,
      },
      taskService,
    });
    const agentTaskService = createAgentTaskService({
      createTaskId: () => "trajectory-goal",
      jobOrchestrator: null,
      taskService,
    });

    await agentTaskService.createTask({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: ["policy-1"],
      maxIterations: 2,
      question: "Generate a risk report with saved summary and follow-up task.",
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
    });

    await orchestrator.runTask({
      accessScope: DEFAULT_ACCESS_SCOPE,
      taskId: "agent_goal:trajectory-goal",
    });

    const pendingTask = await taskService.getTask({
      accessScope: DEFAULT_ACCESS_SCOPE,
      taskId: "agent_goal:trajectory-goal",
    });
    const pendingCompletion = pendingTask.result.goalCompletion;

    await orchestrator.resumeTask({
      accessScope: DEFAULT_ACCESS_SCOPE,
      action: AGENT_TASK_ACTIONS.approveDeliverables,
      payload: {
        approval: {
          approved: true,
          decision: "approved",
          source: "trajectory_eval",
        },
      },
      runImmediately: false,
      taskId: "agent_goal:trajectory-goal",
    });

    await orchestrator.runTask({
      accessScope: DEFAULT_ACCESS_SCOPE,
      taskId: "agent_goal:trajectory-goal",
    });

    const completedTask = await taskService.getTask({
      accessScope: DEFAULT_ACCESS_SCOPE,
      taskId: "agent_goal:trajectory-goal",
    });
    const completion = completedTask.result.goalCompletion;
    const deliverableCheck = getCompletionCheck(
      completion,
      "deliverables_created"
    );

    return finishCase({
      id: "agent_goal_lifecycle_completion",
      label: "Agent goal lifecycle completion",
      description:
        "An agent goal should remain incomplete while approval is pending, then pass goal-completion checks after approved deliverables are created.",
      response: {
        status: 200,
        body: {
          agentAnswer: completedTask.result.answer,
          agentMode: "agent_goal",
          agentTrace: [],
        },
      },
      telemetry,
      checks: [
        buildCheck({
          id: "pending_approval_blocks_goal_completion",
          label: "Pending deliverable approval blocks goal completion",
          category: "goal_lifecycle",
          passed:
            pendingTask.status === TASK_STATUSES.waitingForUser &&
            pendingTask.requiredUserAction ===
              AGENT_TASK_ACTIONS.approveDeliverables &&
            pendingCompletion.status === "pending" &&
            getCompletionCheck(pendingCompletion, "no_pending_user_action")
              ?.passed === false,
          detail: {
            completionStatus: pendingCompletion.status,
            requiredUserAction: pendingTask.requiredUserAction,
            taskStatus: pendingTask.status,
          },
        }),
        buildCheck({
          id: "goal_completion_passes_after_delivery",
          label: "Goal completion passes after deliverables are created",
          category: "goal_lifecycle",
          passed:
            completedTask.status === TASK_STATUSES.completed &&
            completion.status === "completed" &&
            completion.checks.every((check) => check.passed),
          detail: completion,
        }),
        buildCheck({
          id: "goal_lifecycle_plan_completed",
          label: "Lifecycle check verifies public plan steps completed",
          category: "goal_lifecycle",
          passed:
            getCompletionCheck(completion, "plan_steps_completed")?.passed ===
            true,
          detail: getCompletionCheck(completion, "plan_steps_completed"),
        }),
        buildCheck({
          id: "goal_lifecycle_no_unresolved_gaps",
          label: "Lifecycle check verifies unresolved gaps are clear",
          category: "goal_lifecycle",
          passed:
            getCompletionCheck(completion, "evidence_gaps_resolved")?.passed ===
            true,
          detail: getCompletionCheck(completion, "evidence_gaps_resolved"),
        }),
        buildCheck({
          id: "goal_lifecycle_deliverables_created",
          label: "Lifecycle check verifies deliverables were created",
          category: "goal_lifecycle",
          passed:
            deliverableCheck?.passed === true &&
            deliverableCheck.detail.planned === 3 &&
            capabilityRegistry.calls.length === 3,
          detail: {
            capabilityIds: capabilityRegistry.calls.map(
              (call) => call.capabilityId
            ),
            deliverableCheck,
          },
        }),
        buildCheck({
          id: "goal_lifecycle_no_pending_approval",
          label: "Lifecycle check verifies no approval remains pending",
          category: "goal_lifecycle",
          passed:
            getCompletionCheck(completion, "no_pending_user_action")?.passed ===
              true && completedTask.requiredUserAction === "",
          detail: {
            check: getCompletionCheck(completion, "no_pending_user_action"),
            requiredUserAction: completedTask.requiredUserAction,
          },
        }),
      ],
    });
  },
});
