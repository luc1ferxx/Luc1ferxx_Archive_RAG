import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRunRecoveryActionService,
} from "../rag/agent-run-recovery-actions.js";
import {
  STEP_REPLAY_SAFETY_REASON_CODES,
} from "../rag/agent-run-step-replay-safety.js";
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
          input: {
            docIds: ["doc-1"],
            question: "What changed?",
          },
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
  assert.equal(
    result.runs.find((run) => run.runId === "run-manual").recovery.actions[0]
      .safety.canAutoReplay,
    true
  );
  assert.deepEqual(
    result.runs.find((run) => run.runId === "run-manual").recovery.replaySafety
      .steps[0].reasonCodes,
    []
  );
  assert.deepEqual(
    result.runs
      .find((run) => run.runId === "run-failed")
      .recovery.actions.map((action) => action.type),
    ["retry_failed_step"]
  );
});

test("agent run recovery actions expose blocked replay safety reasons", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Recover web search",
    runId: "run-web-manual",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "run-web-manual",
    patch: {
      result: {
        recovery: {
          mode: "manual",
          reason: "requires_approval",
        },
      },
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps: [
        {
          id: "step-web",
          input: {
            question: "What changed online?",
          },
          kind: "tool_call",
          label: "Web Search",
          status: "paused",
          type: "web_search",
        },
      ],
    },
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId: "run-web-manual",
    type: "manual_recovery_required",
    payload: {
      reason: "requires_approval",
    },
  });
  await agentRunService.createRun({
    accessScope,
    goal: "Recover document with missing input",
    runId: "run-document-missing-input",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "run-document-missing-input",
    patch: {
      result: {
        recovery: {
          mode: "manual",
          reason: "missing_input",
        },
      },
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps: [
        {
          id: "step-document-missing",
          input: {
            docIds: ["doc-1"],
          },
          kind: "tool_call",
          label: "Document RAG",
          status: "paused",
          type: "document_rag",
        },
      ],
    },
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId: "run-document-missing-input",
    type: "manual_recovery_required",
    payload: {
      reason: "missing_input",
    },
  });

  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    agentRunStepExecutor: {},
  });
  const result = await actionService.listRecoveryRuns({
    accessScope,
  });
  const run = result.runs.find(
    (listedRun) => listedRun.runId === "run-web-manual"
  );
  const missingInputRun = result.runs.find(
    (listedRun) => listedRun.runId === "run-document-missing-input"
  );

  assert.deepEqual(
    run.recovery.actions.map((action) => action.type),
    ["cancel"]
  );
  assert.deepEqual(run.recovery.replaySafety.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval,
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);
  assert.deepEqual(run.recovery.replaySafety.steps[0].reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval,
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);
  assert.equal(run.recovery.replaySafety.steps[0].canAutoReplay, false);
  assert.deepEqual(
    missingInputRun.recovery.actions.map((action) => action.type),
    ["cancel"]
  );
  assert.deepEqual(missingInputRun.recovery.replaySafety.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.missingInput,
  ]);
  assert.deepEqual(missingInputRun.recovery.replaySafety.steps[0].missingInput, [
    "question",
  ]);
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

  const recordedRecoveryEvents = [];
  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    agentRunStepExecutor: {},
    recordRecoveryTrace: async (event) => recordedRecoveryEvents.push(event),
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
  assert.deepEqual(
    {
      action: recordedRecoveryEvents[0].action,
      eventType: recordedRecoveryEvents[0].eventType,
      runId: recordedRecoveryEvents[0].runId,
      status: recordedRecoveryEvents[0].status,
      traceType: recordedRecoveryEvents[0].traceType,
    },
    {
      action: "cancel",
      eventType: "manual_recovery_action",
      runId: "run-manual",
      status: "completed",
      traceType: "agent_run_recovery",
    }
  );
  assert.equal(
    result.run.events.at(-1).type,
    "run_canceled"
  );
});
