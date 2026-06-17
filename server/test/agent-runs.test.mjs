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

test("agent run service records approval gate actions", async () => {
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
    goal: "Search the web.",
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [
      {
        id: "approval:web.search:1.0.0",
        capabilityId: "web.search",
        status: "pending",
      },
    ],
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });

  const approvedRun = await agentRunService.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: "approval:web.search:1.0.0",
    runId: "run-approval",
  });

  assert.equal(approvedRun.status, AGENT_RUN_STATUSES.running);
  assert.equal(approvedRun.approvalGates[0].status, "approved");
  assert.equal(approvedRun.steps[0].kind, "capability_call");
  assert.equal(approvedRun.steps[0].status, "pending");
  assert.equal(approvedRun.steps[0].capabilityId, "web.search");
  assert.deepEqual(
    approvedRun.events.map((event) => event.type),
    [
      "run_created",
      "run_completed",
      "approval_gate_approved",
    ]
  );
});

test("agent run service queues a retry for a single persisted step", async () => {
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
    goal: "Retry failed capability.",
    runId: "run-retry",
  });
  await agentRunService.completeRun({
    accessScope,
    runId: "run-retry",
    status: AGENT_RUN_STATUSES.failed,
    steps: [
      {
        id: "capability:web.search:approval:web.search:1.0.0",
        type: "capability_call",
        kind: "capability_call",
        label: "Web Search",
        status: "failed",
      },
    ],
  });

  const retriedRun = await agentRunService.retryStep({
    accessScope,
    runId: "run-retry",
    stepId: "capability:web.search:approval:web.search:1.0.0",
  });

  assert.equal(retriedRun.status, AGENT_RUN_STATUSES.running);
  assert.equal(retriedRun.steps.length, 2);
  assert.equal(retriedRun.steps[1].status, "pending");
  assert.equal(
    retriedRun.steps[1].retryOfStepId,
    "capability:web.search:approval:web.search:1.0.0"
  );
  assert.deepEqual(
    retriedRun.events.map((event) => event.type),
    ["run_created", "run_failed", "step_retry_queued"]
  );
});

test("agent run service rejects invalid run status transitions", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await assert.rejects(
    () =>
      agentRunService.createRun({
        accessScope,
        goal: "Already done",
        runId: "invalid-initial-run",
        status: AGENT_RUN_STATUSES.completed,
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /Invalid initial agent run status: completed/);
      return true;
    }
  );

  await agentRunService.createRun({
    accessScope,
    goal: "Terminal run",
    runId: "terminal-run",
  });
  await agentRunService.completeRun({
    accessScope,
    runId: "terminal-run",
  });

  await assert.rejects(
    () =>
      agentRunService.completeRun({
        accessScope,
        runId: "terminal-run",
        status: AGENT_RUN_STATUSES.waitingForUser,
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run status transition: completed -> waiting_for_user/
      );
      return true;
    }
  );

  await assert.rejects(
    () =>
      agentRunService.updateRun({
        accessScope,
        runId: "terminal-run",
        patch: {
          status: AGENT_RUN_STATUSES.running,
        },
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run status transition: completed -> running/
      );
      return true;
    }
  );

  await assert.rejects(
    () =>
      agentRunService.failRun({
        accessScope,
        error: new Error("Late failure"),
        runId: "terminal-run",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run status transition: completed -> failed/
      );
      return true;
    }
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId: "terminal-run",
  });

  assert.equal(run.status, AGENT_RUN_STATUSES.completed);
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "run_completed"]
  );
});

test("agent run service retries steps only from terminal runs", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "Running run",
    runId: "running-run",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "running-run",
    patch: {
      steps: [
        {
          id: "document-step",
          type: "document_rag",
          kind: "tool_call",
          label: "Document RAG",
          status: "completed",
        },
      ],
    },
  });

  await assert.rejects(
    () =>
      agentRunService.retryStep({
        accessScope,
        runId: "running-run",
        stepId: "document-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /only be retried from completed or failed runs/);
      return true;
    }
  );
});

test("agent run service rejects invalid step status transitions", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "Step transition run",
    runId: "step-transition-run",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "step-transition-run",
    patch: {
      steps: [
        {
          id: "document-step",
          type: "document_rag",
          kind: "tool_call",
          label: "Document RAG",
          status: "completed",
        },
      ],
    },
  });

  await assert.rejects(
    () =>
      agentRunService.updateRunStep({
        accessScope,
        runId: "step-transition-run",
        status: "running",
        stepId: "document-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run step status transition: completed -> running/
      );
      return true;
    }
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId: "step-transition-run",
  });

  assert.equal(run.steps[0].status, "completed");
  assert.deepEqual(run.events.map((event) => event.type), ["run_created"]);
});
