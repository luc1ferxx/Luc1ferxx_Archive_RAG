import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRunRecoveryActionService,
} from "../rag/agent-run-recovery-actions.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const createManualRecoveryRun = async (agentRunService) => {
  await agentRunService.createRun({
    accessScope,
    goal: "Resume document answer",
    runId: "run-manual",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "run-manual",
    patch: {
      result: {
        recovery: {
          mode: "manual",
          reason: "server_startup_recovery",
        },
      },
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps: [
        {
          id: "step-document",
          type: "document_rag",
          kind: "tool_call",
          label: "Document RAG",
          status: "paused",
        },
      ],
    },
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId: "run-manual",
    type: "manual_recovery_required",
    payload: {
      reason: "server_startup_recovery",
    },
  });
};

test("agent run recovery actions list safe resume and retry operations", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  await createManualRecoveryRun(agentRunService);
  await agentRunService.createRun({
    accessScope,
    goal: "Retry failed document answer",
    runId: "run-failed",
  });
  await agentRunService.completeRun({
    accessScope,
    runId: "run-failed",
    status: AGENT_RUN_STATUSES.failed,
    steps: [
      {
        id: "step-failed",
        type: "document_rag",
        kind: "tool_call",
        label: "Document RAG",
        status: "failed",
      },
    ],
  });

  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    agentRunStepExecutor: {},
  });
  const result = await actionService.listRecoveryRuns({
    accessScope,
  });

  assert.deepEqual(
    result.runs.map((run) => run.runId).sort(),
    ["run-failed", "run-manual"]
  );
  assert.deepEqual(
    result.runs
      .find((run) => run.runId === "run-manual")
      .recovery.actions.map((action) => action.type),
    ["resume_from_step", "cancel"]
  );
  assert.deepEqual(
    result.runs
      .find((run) => run.runId === "run-failed")
      .recovery.actions.map((action) => action.type),
    ["retry_failed_step"]
  );
});

test("agent run recovery actions execute through the step executor", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];

  await createManualRecoveryRun(agentRunService);

  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    agentRunStepExecutor: {
      resumeStep: async ({ runId, stepId }) => {
        calls.push({
          runId,
          stepId,
          type: "resume",
        });

        return {
          run: await agentRunService.getRun({
            accessScope,
            runId,
          }),
        };
      },
    },
  });
  const result = await actionService.applyRecoveryAction({
    accessScope,
    action: "resume_from_step",
    runId: "run-manual",
  });

  assert.equal(result.run.runId, "run-manual");
  assert.deepEqual(calls, [
    {
      runId: "run-manual",
      stepId: "step-document",
      type: "resume",
    },
  ]);
});

test("agent run recovery actions reject approval gate resume", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Approve web search",
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "run-approval",
    patch: {
      approvalGates: [
        {
          id: "approval:web.search",
          status: "pending",
        },
      ],
      result: {
        recovery: {
          mode: "manual",
          reason: "pending_approval_gate",
        },
      },
      steps: [
        {
          id: "approval-step",
          type: "capability_approval_gate",
          kind: "approval_gate",
          status: "paused",
        },
      ],
    },
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId: "run-approval",
    type: "manual_recovery_required",
  });

  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    agentRunStepExecutor: {
      resumeStep: async () => {
        throw new Error("approval gates must not resume directly");
      },
    },
  });

  await assert.rejects(
    () =>
      actionService.applyRecoveryAction({
        accessScope,
        action: "resume_from_step",
        runId: "run-approval",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /no safe step to resume/);
      return true;
    }
  );
});

test("agent run recovery actions cancel manual recovery runs", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  await createManualRecoveryRun(agentRunService);

  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    agentRunStepExecutor: {},
  });
  const result = await actionService.applyRecoveryAction({
    accessScope,
    action: "cancel",
    payload: {
      reason: "operator_cancel",
    },
    runId: "run-manual",
  });

  assert.equal(result.run.status, AGENT_RUN_STATUSES.canceled);
  assert.equal(result.run.result.canceled, true);
  assert.equal(result.run.result.cancelReason, "operator_cancel");
  assert.equal(
    result.run.events.at(-1).type,
    "run_canceled"
  );
});
