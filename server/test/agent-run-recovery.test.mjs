import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createDocumentRagStepExecutor,
} from "../rag/agent-run-step-handlers/index.js";
import {
  AGENT_RUN_STEP_STATUSES,
} from "../rag/agent-run-steps.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";

test("agent run recovery marks startup running runs for manual recovery", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-18T00:00:00.000Z",
    }),
  });
  const recordedRecoveryEvents = [];
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    now: () => "2026-06-18T00:01:00.000Z",
    recordRecoveryTrace: async (event) => recordedRecoveryEvents.push(event),
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Recover this run",
    runId: "run-recoverable",
  });
  await agentRunService.createRun({
    accessScope,
    goal: "Completed run",
    runId: "run-completed",
  });
  await agentRunService.completeRun({
    accessScope,
    runId: "run-completed",
  });

  const result = await recoveryService.recoverOnStartup();

  assert.equal(result.mode, "manual");
  assert.equal(result.recoveredCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.runs[0].runId, "run-recoverable");
  assert.equal(result.runs[0].status, AGENT_RUN_STATUSES.waitingForUser);
  assert.deepEqual(
    {
      autoReplayAttemptCount: recordedRecoveryEvents[0].autoReplayAttemptCount,
      eventType: recordedRecoveryEvents[0].eventType,
      manualRecoveryCount: recordedRecoveryEvents[0].manualRecoveryCount,
      recoverableRunCount: recordedRecoveryEvents[0].recoverableRunCount,
      traceType: recordedRecoveryEvents[0].traceType,
    },
    {
      autoReplayAttemptCount: 0,
      eventType: "startup_recovery_completed",
      manualRecoveryCount: 1,
      recoverableRunCount: 1,
      traceType: "agent_run_recovery",
    }
  );

  const recoveredRun = await agentRunService.getRun({
    accessScope,
    runId: "run-recoverable",
  });

  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.deepEqual(recoveredRun.result.recovery, {
    mode: "manual",
    originalStatus: AGENT_RUN_STATUSES.running,
    reason: "server_startup_recovery",
    recoveredAt: "2026-06-18T00:01:00.000Z",
  });
  assert.ok(
    recoveredRun.events.some(
      (event) => event.type === "manual_recovery_required"
    )
  );

  const secondResult = await recoveryService.recoverOnStartup();

  assert.equal(secondResult.recoveredCount, 0);
  assert.equal(secondResult.skippedCount, 1);
});

test("agent run recovery auto resumes a safe persisted document step", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-18T00:00:00.000Z",
    }),
  });
  const ragCalls = [];
  const agentRunStepExecutor = createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async (docIds, question, options) => {
          ragCalls.push({
            docIds,
            options,
            question,
          });

          return {
            citations: [
              {
                docId: "doc-1",
                title: "Policy",
              },
            ],
            text: "Recovered document answer.",
          };
        },
      },
    }),
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    agentRunStepExecutor,
    now: () => "2026-06-18T00:01:00.000Z",
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Recover document step",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-auto-document",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "run-auto-document",
    patch: {
      steps: [
        {
          id: "document-step",
          input: {
            docIds: ["doc-1"],
            question: "What changed?",
          },
          kind: "tool_call",
          status: AGENT_RUN_STEP_STATUSES.pending,
          type: "document_rag",
        },
      ],
    },
  });

  const result = await recoveryService.recoverOnStartup({
    mode: "auto",
  });
  const recoveredRun = await agentRunService.getRun({
    accessScope,
    runId: "run-auto-document",
  });

  assert.equal(result.mode, "auto");
  assert.equal(result.autoRecoveredCount, 1);
  assert.equal(result.manualRecoveredCount, 0);
  assert.equal(result.recoveredCount, 1);
  assert.equal(ragCalls.length, 1);
  assert.deepEqual(ragCalls[0].docIds, ["doc-1"]);
  assert.equal(ragCalls[0].question, "What changed?");
  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.completed);
  assert.equal(recoveredRun.result.recovery.mode, "auto");
  assert.equal(recoveredRun.result.recovery.stepId, "document-step");
  assert.equal(recoveredRun.result.answer, "Recovered document answer.");
  assert.equal(
    recoveredRun.steps[0].status,
    AGENT_RUN_STEP_STATUSES.completed
  );
  assert.deepEqual(
    recoveredRun.events.map((event) => event.type),
    [
      "run_created",
      "auto_recovery_started",
      "step_started",
      "step_completed",
      "run_completed",
      "auto_recovery_completed",
    ]
  );
});

test("agent run recovery falls back to manual when auto finds an approval gate", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    agentRunStepExecutor: {
      resumeStep: async () => {
        throw new Error("Approval recovery should stay manual.");
      },
    },
    now: () => "2026-06-18T00:01:00.000Z",
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
          capabilityId: "web.search",
          id: "gate-web",
          status: "pending",
        },
      ],
      steps: [
        {
          approvalGateId: "gate-web",
          id: "approval-step",
          kind: "approval_gate",
          status: AGENT_RUN_STEP_STATUSES.paused,
          type: "capability_approval_gate",
        },
      ],
    },
  });

  const result = await recoveryService.recoverOnStartup({
    mode: "auto",
  });
  const recoveredRun = await agentRunService.getRun({
    accessScope,
    runId: "run-approval",
  });

  assert.equal(result.autoRecoveredCount, 0);
  assert.equal(result.manualRecoveredCount, 1);
  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.deepEqual(recoveredRun.result.recovery, {
    mode: "manual",
    originalStatus: AGENT_RUN_STATUSES.waitingForUser,
    reason: "pending_approval_gate",
    recoveredAt: "2026-06-18T00:01:00.000Z",
    requestedMode: "auto",
  });
  assert.ok(
    recoveredRun.events.some(
      (event) => event.type === "manual_recovery_required"
    )
  );
});

test("agent run recovery can be disabled on startup", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Leave this run untouched",
    runId: "run-off",
  });

  const result = await recoveryService.recoverOnStartup({
    mode: "off",
  });
  const run = await agentRunService.getRun({
    accessScope,
    runId: "run-off",
  });

  assert.equal(result.mode, "off");
  assert.equal(result.recoveredCount, 0);
  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(run.result.recovery, undefined);
});
