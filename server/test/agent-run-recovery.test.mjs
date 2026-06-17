import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
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
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    now: () => "2026-06-18T00:01:00.000Z",
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
