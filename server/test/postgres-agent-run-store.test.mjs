import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STEP_STATUSES,
} from "../rag/agent-run-steps.js";
import { createAgentRunRecoveryActionService } from "../rag/agent-run-recovery-actions.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createDocumentRagStepExecutor,
} from "../rag/agent-run-step-handlers/index.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
} from "../rag/agent-runs.js";
import { createPostgresAgentRunStore } from "../rag/postgres-agent-run-store.js";

const parseJson = (value, fallback = null) =>
  value === null || value === undefined ? fallback : JSON.parse(value);

const buildFakeRunRow = (values, existingRow = null) => ({
  user_id: values[0],
  workspace_id: values[1],
  run_id: values[2],
  status: values[3],
  goal: values[4],
  input: parseJson(values[5], {}),
  plan: parseJson(values[6], {}),
  steps: parseJson(values[7], []),
  observations: parseJson(values[8], []),
  decisions: parseJson(values[9], []),
  approval_gates: parseJson(values[10], []),
  result: parseJson(values[11], {}),
  error: parseJson(values[12]),
  created_at: values[13] || existingRow?.created_at || values[15],
  updated_at: values[14] || values[15],
});

const createFakePostgresAgentRunHarness = () => {
  const rows = new Map();
  const events = [];
  let migrationRuns = 0;
  const buildKey = ({ runId, userId, workspaceId }) =>
    `${userId}\u0000${workspaceId}\u0000${runId}`;
  const query = async (queryText, values = []) => {
    if (queryText.includes("INSERT INTO rag_agent_runs_test")) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = buildFakeRunRow(values, rows.get(key));

      rows.set(key, row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (queryText.includes("INSERT INTO rag_agent_run_events_test")) {
      const row = {
        event_id: events.length + 1,
        user_id: values[0],
        workspace_id: values[1],
        run_id: values[2],
        event_type: values[3],
        event_payload: parseJson(values[4], {}),
        created_at: "2026-06-14T00:00:00.000Z",
      };

      events.push(row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes("UPDATE rag_agent_runs_test") &&
      queryText.includes("SET updated_at")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = rows.get(key);

      if (row) {
        row.updated_at = values[3];
      }

      return {
        rowCount: row ? 1 : 0,
        rows: [],
      };
    }

    if (queryText.includes("FROM rag_agent_run_events_test")) {
      const [userId, workspaceId, runId] = values;

      return {
        rowCount: 0,
        rows: events.filter(
          (event) =>
            event.user_id === userId &&
            event.workspace_id === workspaceId &&
            event.run_id === runId
        ),
      };
    }

    if (
      queryText.includes("status = ANY") &&
      queryText.includes("FROM rag_agent_runs_test")
    ) {
      const statuses = new Set(values[0]);

      return {
        rowCount: 0,
        rows: [...rows.values()].filter((row) => statuses.has(row.status)),
      };
    }

    if (
      queryText.includes("run_id = $3") &&
      queryText.includes("FROM rag_agent_runs_test")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = rows.get(key);

      return {
        rowCount: row ? 1 : 0,
        rows: row ? [row] : [],
      };
    }

    if (queryText.includes("FROM rag_agent_runs_test")) {
      const [userId, workspaceId, status] = values;

      return {
        rowCount: 0,
        rows: [...rows.values()].filter(
          (row) =>
            row.user_id === userId &&
            row.workspace_id === workspaceId &&
            (!status || row.status === status)
        ),
      };
    }

    throw new Error(`Unexpected query: ${queryText}`);
  };
  const createService = ({ now = () => "2026-06-14T00:00:00.000Z" } = {}) =>
    createAgentRunService({
      agentRunStore: createPostgresAgentRunStore({
        eventsTableName: "rag_agent_run_events_test",
        now,
        query,
        runMigrations: async () => {
          migrationRuns += 1;
          return {
            appliedMigrations: [],
            status: "ok",
          };
        },
        tableName: "rag_agent_runs_test",
      }),
    });

  return {
    createService,
    get migrationRuns() {
      return migrationRuns;
    },
  };
};

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const createPostgresDocumentStepExecutor = ({
  agentRunService,
  citations = [
    {
      docId: "doc-1",
      title: "Policy",
    },
  ],
  text = "Recovered from Postgres.",
} = {}) =>
  createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async () => ({
          citations,
          text,
        }),
      },
    }),
  });

const createManualRecoveryRun = async ({
  agentRunService,
  runId = "run-manual-recovery",
  stepId = "document-step",
} = {}) => {
  await agentRunService.createRun({
    accessScope,
    goal: "Recover manual run",
    input: {
      docIds: ["doc-1"],
    },
    runId,
  });
  await agentRunService.updateRun({
    accessScope,
    runId,
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
          id: stepId,
          input: {
            docIds: ["doc-1"],
            question: "What changed?",
          },
          status: AGENT_RUN_STEP_STATUSES.paused,
          type: "document_rag",
        },
      ],
    },
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId,
    type: "manual_recovery_required",
    payload: {
      reason: "server_startup_recovery",
    },
  });
};

test("postgres agent run store persists scoped run snapshots and event records", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const agentRunService = harness.createService();

  await agentRunService.initialize();
  await agentRunService.initialize();

  assert.equal(harness.migrationRuns, 1);

  await agentRunService.createRun({
    accessScope,
    goal: "Summarize the policy",
    input: {
      docIds: ["doc-1"],
    },
    plan: {
      mode: "document",
    },
    runId: "run-1",
  });
  await agentRunService.completeRun({
    accessScope,
    result: {
      answer: "Done",
    },
    runId: "run-1",
    steps: [
      {
        type: "plan",
      },
    ],
  });

  const publicRun = await agentRunService.getRun({
    accessScope,
    runId: "run-1",
  });
  const scopedRuns = await agentRunService.listRuns({
    accessScope,
  });
  const recoverableRuns = await agentRunService.listRecoverableRuns({
    statuses: [AGENT_RUN_STATUSES.completed],
  });

  assert.equal(publicRun.status, AGENT_RUN_STATUSES.completed);
  assert.equal(publicRun.result.answer, "Done");
  assert.deepEqual(
    publicRun.events.map((event) => event.type),
    ["run_created", "run_completed"]
  );
  assert.equal(publicRun.accessScope, undefined);
  assert.equal(scopedRuns.runs.length, 1);
  assert.equal(recoverableRuns.runs[0].runId, "run-1");
});

test("postgres agent run service can approve a waiting run after restart", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await firstService.createRun({
    accessScope,
    goal: "Approve web search",
    runId: "run-approval",
  });
  await firstService.completeRun({
    accessScope,
    approvalGates: [
      {
        id: "gate-web",
        capabilityId: "web.search",
        capabilityLabel: "Web Search",
        inputPreview: {
          question: "latest policy",
        },
        status: "pending",
      },
    ],
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
    steps: [
      {
        id: "approval-web",
        type: "capability_approval_gate",
        status: AGENT_RUN_STEP_STATUSES.paused,
        approvalGateId: "gate-web",
        capabilityId: "web.search",
      },
    ],
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  const approvedRun = await restartedService.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: "gate-web",
    runId: "run-approval",
  });

  assert.equal(approvedRun.status, AGENT_RUN_STATUSES.running);
  assert.equal(approvedRun.approvalGates[0].status, "approved");
  assert.ok(
    approvedRun.steps.some(
      (step) =>
        step.kind === "capability_call" &&
        step.approvalGateId === "gate-web" &&
        step.status === AGENT_RUN_STEP_STATUSES.pending
    )
  );
  assert.ok(
    approvedRun.events.some(
      (event) => event.type === "approval_gate_approved"
    )
  );

  await assert.rejects(
    () =>
      restartedService.applyApprovalAction({
        accessScope,
        action: "approve",
        gateId: "gate-web",
        runId: "run-approval",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /not waiting for user input/);
      return true;
    }
  );

  const afterDuplicateApproval = await restartedService.getRun({
    accessScope,
    runId: "run-approval",
  });

  assert.equal(
    afterDuplicateApproval.events.filter(
      (event) => event.type === "approval_gate_approved"
    ).length,
    1
  );
});

test("postgres agent run service can queue retry after failed run restart", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await firstService.createRun({
    accessScope,
    goal: "Retry failed document step",
    runId: "run-retry",
  });
  await firstService.completeRun({
    accessScope,
    runId: "run-retry",
    status: AGENT_RUN_STATUSES.failed,
    steps: [
      {
        id: "document-step",
        type: "document_rag",
        status: AGENT_RUN_STEP_STATUSES.failed,
        input: {
          docIds: ["doc-1"],
          question: "What changed?",
        },
        error: {
          message: "backend timeout",
        },
      },
    ],
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  const retriedRun = await restartedService.retryStep({
    accessScope,
    runId: "run-retry",
    stepId: "document-step",
  });
  const retryStep = retriedRun.steps.find(
    (step) => step.retryOfStepId === "document-step"
  );

  assert.equal(retriedRun.status, AGENT_RUN_STATUSES.running);
  assert.equal(retryStep.status, AGENT_RUN_STEP_STATUSES.pending);
  assert.deepEqual(retryStep.input.docIds, ["doc-1"]);
  assert.equal(retryStep.error, null);
  assert.ok(
    retriedRun.events.some((event) => event.type === "step_retry_queued")
  );
});

test("postgres agent run recovery preserves completed steps after partial restart", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await firstService.createRun({
    accessScope,
    goal: "Recover partial run",
    runId: "run-partial",
  });
  await firstService.updateRun({
    accessScope,
    runId: "run-partial",
    patch: {
      steps: [
        {
          id: "step-1",
          type: "document_rag",
          status: AGENT_RUN_STEP_STATUSES.completed,
          input: {
            docIds: ["doc-1"],
            question: "What changed?",
          },
          output: {
            citationCount: 1,
            text: "Completed before restart.",
          },
        },
        {
          id: "step-2",
          type: "self_check",
          status: AGENT_RUN_STEP_STATUSES.running,
          input: {
            sourceStepId: "step-1",
          },
        },
      ],
    },
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService: restartedService,
    now: () => "2026-06-14T00:06:00.000Z",
  });
  const recovery = await recoveryService.recoverOnStartup();
  const recoveredRun = await restartedService.getRun({
    accessScope,
    runId: "run-partial",
  });

  assert.equal(recovery.recoveredCount, 1);
  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.equal(recoveredRun.result.recovery.mode, "manual");
  assert.equal(recoveredRun.steps[0].status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(recoveredRun.steps[0].output.citationCount, 1);
  assert.equal(recoveredRun.steps[1].status, AGENT_RUN_STEP_STATUSES.running);
  assert.ok(
    recoveredRun.events.some(
      (event) => event.type === "manual_recovery_required"
    )
  );
});

test("postgres agent run recovery auto resumes a safe pending step after restart", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await firstService.createRun({
    accessScope,
    goal: "Recover pending document run",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-auto-recovery",
  });
  await firstService.updateRun({
    accessScope,
    runId: "run-auto-recovery",
    patch: {
      steps: [
        {
          id: "document-step",
          input: {
            docIds: ["doc-1"],
            question: "What changed?",
          },
          status: AGENT_RUN_STEP_STATUSES.pending,
          type: "document_rag",
        },
      ],
    },
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  const agentRunStepExecutor = createPostgresDocumentStepExecutor({
    agentRunService: restartedService,
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService: restartedService,
    agentRunStepExecutor,
    now: () => "2026-06-14T00:06:00.000Z",
  });

  const recovery = await recoveryService.recoverOnStartup({
    mode: "auto",
  });
  const recoveredRun = await restartedService.getRun({
    accessScope,
    runId: "run-auto-recovery",
  });

  assert.equal(recovery.autoRecoveredCount, 1);
  assert.equal(recovery.manualRecoveredCount, 0);
  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.completed);
  assert.equal(recoveredRun.result.recovery.mode, "auto");
  assert.equal(recoveredRun.result.answer, "Recovered from Postgres.");
  assert.equal(
    recoveredRun.steps[0].status,
    AGENT_RUN_STEP_STATUSES.completed
  );
  assert.ok(
    recoveredRun.events.some(
      (event) => event.type === "auto_recovery_completed"
    )
  );
  assert.equal(
    recoveredRun.events.some(
      (event) => event.type === "manual_recovery_required"
    ),
    false
  );
});

test("postgres recovery actions resume a partial run after restart without replaying completed steps", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await firstService.createRun({
    accessScope,
    goal: "Resume partial document run",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-partial-resume",
  });
  await firstService.updateRun({
    accessScope,
    runId: "run-partial-resume",
    patch: {
      steps: [
        {
          id: "step-completed",
          input: {
            docIds: ["doc-1"],
            question: "What changed first?",
          },
          output: {
            citationCount: 1,
            text: "Completed before restart.",
          },
          status: AGENT_RUN_STEP_STATUSES.completed,
          type: "document_rag",
        },
        {
          id: "step-pending",
          input: {
            docIds: ["doc-1"],
            question: "What changed next?",
          },
          status: AGENT_RUN_STEP_STATUSES.pending,
          type: "document_rag",
        },
      ],
    },
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService: restartedService,
    now: () => "2026-06-14T00:06:00.000Z",
  });
  const manualRecovery = await recoveryService.recoverOnStartup();
  const actionService = createAgentRunRecoveryActionService({
    agentRunService: restartedService,
    agentRunStepExecutor: createPostgresDocumentStepExecutor({
      agentRunService: restartedService,
      text: "Resumed after partial restart.",
    }),
  });

  const result = await actionService.applyRecoveryAction({
    accessScope,
    action: "resume_from_step",
    runId: "run-partial-resume",
  });
  const completedStep = result.run.steps.find(
    (step) => step.id === "step-completed"
  );
  const resumedStep = result.run.steps.find((step) => step.id === "step-pending");

  assert.equal(manualRecovery.recoveredCount, 1);
  assert.equal(result.run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(completedStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(completedStep.output.text, "Completed before restart.");
  assert.equal(resumedStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(resumedStep.output.text, "Resumed after partial restart.");
  assert.equal(result.run.result.answer, "Resumed after partial restart.");
});

test("postgres recovery actions retry a failed step after restart through the step executor", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await firstService.createRun({
    accessScope,
    goal: "Retry failed document run",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-failed-retry",
  });
  await firstService.completeRun({
    accessScope,
    runId: "run-failed-retry",
    status: AGENT_RUN_STATUSES.failed,
    steps: [
      {
        error: {
          message: "Document RAG timeout.",
        },
        id: "failed-document-step",
        input: {
          docIds: ["doc-1"],
          question: "What changed?",
        },
        status: AGENT_RUN_STEP_STATUSES.failed,
        type: "document_rag",
      },
    ],
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  const actionService = createAgentRunRecoveryActionService({
    agentRunService: restartedService,
    agentRunStepExecutor: createPostgresDocumentStepExecutor({
      agentRunService: restartedService,
      text: "Retried after restart.",
    }),
  });

  const result = await actionService.applyRecoveryAction({
    accessScope,
    action: "retry_failed_step",
    runId: "run-failed-retry",
  });
  const retryStep = result.run.steps.find(
    (step) => step.retryOfStepId === "failed-document-step"
  );

  assert.equal(result.run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(retryStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(retryStep.input.question, "What changed?");
  assert.equal(retryStep.output.text, "Retried after restart.");
  assert.equal(result.run.result.answer, "Retried after restart.");
  assert.ok(
    result.run.events.some((event) => event.type === "step_retry_queued")
  );
});

test("postgres canceled manual recovery runs stay terminal across startup recovery", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await createManualRecoveryRun({
    agentRunService: firstService,
    runId: "run-cancel-terminal",
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  const actionService = createAgentRunRecoveryActionService({
    agentRunService: restartedService,
    agentRunStepExecutor: createPostgresDocumentStepExecutor({
      agentRunService: restartedService,
    }),
  });

  const canceled = await actionService.applyRecoveryAction({
    accessScope,
    action: "cancel",
    payload: {
      reason: "operator_cancel",
    },
    runId: "run-cancel-terminal",
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService: restartedService,
    agentRunStepExecutor: createPostgresDocumentStepExecutor({
      agentRunService: restartedService,
    }),
    now: () => "2026-06-14T00:06:00.000Z",
  });
  const startupRecovery = await recoveryService.recoverOnStartup({
    mode: "auto",
  });
  const listedRecoveryRuns = await actionService.listRecoveryRuns({
    accessScope,
  });

  assert.equal(canceled.run.status, AGENT_RUN_STATUSES.canceled);
  assert.equal(startupRecovery.recoveredCount, 0);
  assert.equal(startupRecovery.autoRecoveredCount, 0);
  assert.deepEqual(
    listedRecoveryRuns.runs.map((run) => run.runId),
    []
  );
  await assert.rejects(
    () =>
      restartedService.retryStep({
        accessScope,
        runId: "run-cancel-terminal",
        stepId: "document-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /only be retried from completed or failed/);
      return true;
    }
  );
  await assert.rejects(
    () =>
      restartedService.applyApprovalAction({
        accessScope,
        action: "approve",
        gateId: "gate-web",
        runId: "run-cancel-terminal",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /not waiting for user input/);
      return true;
    }
  );
});
