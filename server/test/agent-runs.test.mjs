import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";

test("agent run service records scoped runs, events, and completion snapshots", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-14T00:00:00.000Z",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "What changed in the policy?",
    input: {
      docIds: ["doc-1"],
    },
    plan: {
      mode: "document",
    },
    runId: "run-1",
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId: "run-1",
    type: "tool_observation",
    payload: {
      skillId: "document_rag",
    },
  });
  await agentRunService.completeRun({
    accessScope,
    decisions: [
      {
        type: "agent_mode",
        value: "document",
      },
    ],
    observations: [
      {
        skillId: "document_rag",
        status: "completed",
      },
    ],
    result: {
      answer: "The policy changed.",
      status: 200,
    },
    runId: "run-1",
    steps: [
      {
        type: "plan",
        status: "completed",
      },
    ],
  });

  const run = await agentRunService.getRun({
    accessScope,
    runId: "run-1",
  });

  assert.equal(run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(run.goal, "What changed in the policy?");
  assert.deepEqual(run.input.docIds, ["doc-1"]);
  assert.equal(run.result.answer, "The policy changed.");
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "tool_observation", "run_completed"]
  );
  assert.equal(run.accessScope, undefined);
  assert.equal(run.scopeKey, undefined);

  assert.equal(
    (
      await agentRunService.listRuns({
        accessScope,
      })
    ).runs.length,
    1
  );
  assert.deepEqual(
    await agentRunService.listRuns({
      accessScope: {
        userId: "bob",
        workspaceId: "workspace-a",
      },
    }),
    {
      runs: [],
    }
  );
});

test("agent run service exposes recoverable running runs", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  await agentRunService.createRun({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    goal: "Pending run",
    runId: "run-running",
  });

  const recoverableRuns = await agentRunService.listRecoverableRuns();

  assert.equal(recoverableRuns.runs.length, 1);
  assert.equal(recoverableRuns.runs[0].runId, "run-running");
});
