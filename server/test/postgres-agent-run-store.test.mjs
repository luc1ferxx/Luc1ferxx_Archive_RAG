import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STEP_STATUSES,
} from "../rag/agent-run-steps.js";
import {
  createApprovalExecutionSnapshot,
} from "../rag/capabilities/approval-execution-snapshot.js";
import { createAgentRunRecoveryActionService } from "../rag/agent-run-recovery-actions.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createDocumentRagStepExecutor,
} from "../rag/agent-run-step-handlers/index.js";
import {
  STEP_REPLAY_SAFETY_REASON_CODES,
} from "../rag/agent-run-step-replay-safety.js";
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
  revision: existingRow?.revision ?? 0,
  created_at: values[13] || existingRow?.created_at || values[15],
  updated_at: values[14] || values[15],
});

const createFakePostgresAgentRunHarness = () => {
  const rows = new Map();
  const approvalSnapshots = new Map();
  const events = [];
  const queries = [];
  let failNextAtomicEvent = false;
  let failNextAtomicSnapshot = false;
  let migrationRuns = 0;
  const buildKey = ({ runId, userId, workspaceId }) =>
    `${userId}\u0000${workspaceId}\u0000${runId}`;
  const buildApprovalSnapshotKey = ({
    gateId,
    runId,
    userId,
    workspaceId,
  }) => `${buildKey({ runId, userId, workspaceId })}\u0000${gateId}`;
  const buildEventRow = ({
    eventPayload,
    eventType,
    runId,
    userId,
    workspaceId,
  }) => ({
    event_id: events.length + 1,
    user_id: userId,
    workspace_id: workspaceId,
    run_id: runId,
    event_type: eventType,
    event_payload: parseJson(eventPayload, {}),
    created_at: "2026-06-14T00:00:00.000Z",
  });
  const query = async (queryText, values = []) => {
    queries.push({
      queryText,
      values,
    });

    if (
      queryText.includes("WITH inserted_run AS") &&
      queryText.includes("recorded_event AS")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });

      if (rows.has(key)) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      const row = buildFakeRunRow(values);
      const event = buildEventRow({
        eventPayload: values[17],
        eventType: values[16],
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });

      if (failNextAtomicEvent) {
        failNextAtomicEvent = false;
        throw new Error("Simulated atomic event insert failure.");
      }

      rows.set(key, row);
      events.push(event);

      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes("INSERT INTO rag_agent_runs_test") &&
      !queryText.includes("INSERT INTO rag_agent_runs_test_approval_snapshots")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });

      if (rows.has(key)) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      const row = buildFakeRunRow(values);

      rows.set(key, row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes("WITH requested_approval_snapshots AS") &&
      queryText.includes("inserted_approval_snapshots AS") &&
      queryText.includes("recorded_event AS")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const existingRow = rows.get(key);

      if (!existingRow || existingRow.revision !== values[3]) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      const requestedSnapshots = parseJson(values[17], []);
      const snapshotRows = requestedSnapshots.map((snapshot) => ({
        user_id: values[0],
        workspace_id: values[1],
        run_id: values[2],
        gate_id: snapshot.gateId,
        capability_id: snapshot.capabilityId,
        capability_version: snapshot.capabilityVersion,
        approval_object_hash: snapshot.approvalObjectHash,
        snapshot_version: snapshot.snapshotVersion,
        execution_input: snapshot.executionInput,
      }));
      const hasConflict = snapshotRows.some((snapshotRow) => {
        const existingSnapshot = approvalSnapshots.get(
          buildApprovalSnapshotKey({
            gateId: snapshotRow.gate_id,
            runId: snapshotRow.run_id,
            userId: snapshotRow.user_id,
            workspaceId: snapshotRow.workspace_id,
          })
        );

        return (
          existingSnapshot &&
          JSON.stringify(existingSnapshot) !== JSON.stringify(snapshotRow)
        );
      });

      if (hasConflict) {
        const error = new Error(
          "division by zero from approval snapshot rollback guard"
        );
        error.code = "22012";
        throw error;
      }

      if (failNextAtomicSnapshot) {
        failNextAtomicSnapshot = false;
        throw new Error(
          "Simulated atomic approval snapshot insert failure."
        );
      }

      const row = {
        ...existingRow,
        status: values[4],
        goal: values[5],
        input: parseJson(values[6], {}),
        plan: parseJson(values[7], {}),
        steps: parseJson(values[8], []),
        observations: parseJson(values[9], []),
        decisions: parseJson(values[10], []),
        approval_gates: parseJson(values[11], []),
        result: parseJson(values[12], {}),
        error: parseJson(values[13]),
        revision: existingRow.revision + 1,
        updated_at: values[14],
      };
      const event = buildEventRow({
        eventPayload: values[16],
        eventType: values[15],
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });

      if (failNextAtomicEvent) {
        failNextAtomicEvent = false;
        throw new Error("Simulated atomic event insert failure.");
      }

      rows.set(key, row);
      for (const snapshotRow of snapshotRows) {
        approvalSnapshots.set(
          buildApprovalSnapshotKey({
            gateId: snapshotRow.gate_id,
            runId: snapshotRow.run_id,
            userId: snapshotRow.user_id,
            workspaceId: snapshotRow.workspace_id,
          }),
          snapshotRow
        );
      }
      events.push(event);

      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes("WITH updated_run AS") &&
      queryText.includes("recorded_event AS")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const existingRow = rows.get(key);

      if (!existingRow || existingRow.revision !== values[3]) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      const row = {
        ...existingRow,
        status: values[4],
        goal: values[5],
        input: parseJson(values[6], {}),
        plan: parseJson(values[7], {}),
        steps: parseJson(values[8], []),
        observations: parseJson(values[9], []),
        decisions: parseJson(values[10], []),
        approval_gates: parseJson(values[11], []),
        result: parseJson(values[12], {}),
        error: parseJson(values[13]),
        revision: existingRow.revision + 1,
        updated_at: values[14],
      };
      const event = buildEventRow({
        eventPayload: values[16],
        eventType: values[15],
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });

      if (failNextAtomicEvent) {
        failNextAtomicEvent = false;
        throw new Error("Simulated atomic event insert failure.");
      }

      rows.set(key, row);
      events.push(event);

      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes("UPDATE rag_agent_runs_test") &&
      queryText.includes("revision = revision + 1")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const existingRow = rows.get(key);

      if (!existingRow || existingRow.revision !== values[3]) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      const row = {
        ...existingRow,
        status: values[4],
        goal: values[5],
        input: parseJson(values[6], {}),
        plan: parseJson(values[7], {}),
        steps: parseJson(values[8], []),
        observations: parseJson(values[9], []),
        decisions: parseJson(values[10], []),
        approval_gates: parseJson(values[11], []),
        result: parseJson(values[12], {}),
        error: parseJson(values[13]),
        revision: existingRow.revision + 1,
        updated_at: values[14],
      };

      rows.set(key, row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes("WITH touched_run AS") &&
      queryText.includes("recorded_event AS")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const existingRow = rows.get(key);

      if (!existingRow) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      const event = buildEventRow({
        eventPayload: values[4],
        eventType: values[3],
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });

      if (failNextAtomicEvent) {
        failNextAtomicEvent = false;
        throw new Error("Simulated atomic event insert failure.");
      }

      rows.set(key, {
        ...existingRow,
        updated_at: "2026-06-14T00:00:00.000Z",
      });
      events.push(event);

      return {
        rowCount: 1,
        rows: [event],
      };
    }

    if (queryText.includes("INSERT INTO rag_agent_run_events_test")) {
      const row = buildEventRow({
        eventPayload: values[4],
        eventType: values[3],
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });

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

    if (queryText.includes("FROM rag_agent_runs_test_approval_snapshots")) {
      const [userId, workspaceId, runId, gateId] = values;
      const row = approvalSnapshots.get(
        buildApprovalSnapshotKey({
          gateId,
          runId,
          userId,
          workspaceId,
        })
      );

      return {
        rowCount: row ? 1 : 0,
        rows: row ? [row] : [],
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
      const [userId, workspaceId, status, limit, offset] = values;
      const filtered = [...rows.values()].filter(
        (row) =>
          row.user_id === userId &&
          row.workspace_id === workspaceId &&
          (!status || row.status === status)
      );

      if (limit !== undefined && offset !== undefined) {
        const start = Number(offset) || 0;

        return {
          rowCount: 0,
          // LIMIT NULL means no limit in PostgreSQL.
          rows:
            limit === null
              ? filtered.slice(start)
              : filtered.slice(start, start + Number(limit)),
        };
      }

      return {
        rowCount: 0,
        rows: filtered,
      };
    }

    throw new Error(`Unexpected query: ${queryText}`);
  };
  const createStore = ({
    now = () => "2026-06-14T00:00:00.000Z",
  } = {}) =>
    createPostgresAgentRunStore({
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
      });
  const createService = (options = {}) =>
    createAgentRunService({
      agentRunStore: createStore(options),
    });

  return {
    approvalSnapshots,
    createService,
    createStore,
    events,
    failNextAtomicEvent() {
      failNextAtomicEvent = true;
    },
    failNextAtomicSnapshot() {
      failNextAtomicSnapshot = true;
    },
    get migrationRuns() {
      return migrationRuns;
    },
    queries,
    rows,
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
  calls = [],
  text = "Recovered from Postgres.",
} = {}) =>
  createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async (docIds, question, options) => {
          calls.push({
            docIds,
            options,
            question,
          });

          return {
            citations,
            text,
          };
        },
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
  const capabilityId = "web.search";
  const capabilityVersion = "1.0.0";
  const executionInput = {
    question: "latest policy",
  };
  const inputPreview = {
    question: "latest policy",
  };
  const snapshotBinding = createApprovalExecutionSnapshot({
    accessScope,
    capabilityId,
    capabilityVersion,
    executionInput,
    inputPreview,
  });

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
        capabilityId,
        capabilityLabel: "Web Search",
        capabilityVersion,
        approvalObjectHash: snapshotBinding.approvalObjectHash,
        snapshotVersion: snapshotBinding.snapshotVersion,
        inputPreview,
        status: "pending",
      },
    ],
    approvalSnapshots: [
      {
        gateId: "gate-web",
        capabilityId,
        capabilityVersion,
        approvalObjectHash: snapshotBinding.approvalObjectHash,
        snapshotVersion: snapshotBinding.snapshotVersion,
        executionInput: snapshotBinding.privateSnapshot.executionInput,
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
    payload: {
      approvalObjectHash: snapshotBinding.approvalObjectHash,
    },
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
        payload: {
          approvalObjectHash: snapshotBinding.approvalObjectHash,
        },
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

test("postgres agent run recovery auto resumes a safe running primary document step after restart", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await firstService.createRun({
    accessScope,
    goal: "Recover running document run",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-running-auto-recovery",
  });
  await firstService.updateRun({
    accessScope,
    runId: "run-running-auto-recovery",
    patch: {
      steps: [
        {
          id: "document-step",
          input: {
            docIds: ["doc-1"],
            question: "What changed while the server restarted?",
            retrievalPlan: {
              queries: ["policy change"],
            },
          },
          status: AGENT_RUN_STEP_STATUSES.running,
          type: "document_rag",
        },
      ],
    },
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  const ragCalls = [];
  const agentRunStepExecutor = createPostgresDocumentStepExecutor({
    agentRunService: restartedService,
    calls: ragCalls,
    text: "Recovered running primary step.",
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
    runId: "run-running-auto-recovery",
  });

  assert.equal(recovery.autoRecoveredCount, 1);
  assert.equal(recovery.manualRecoveredCount, 0);
  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.completed);
  assert.deepEqual(
    {
      mode: recoveredRun.result.recovery.mode,
      stepId: recoveredRun.result.recovery.stepId,
      stepType: recoveredRun.result.recovery.stepType,
    },
    {
      mode: "auto",
      stepId: "document-step",
      stepType: "document_rag",
    }
  );
  assert.equal(ragCalls.length, 1);
  assert.deepEqual(ragCalls[0].docIds, ["doc-1"]);
  assert.equal(
    ragCalls[0].question,
    "What changed while the server restarted?"
  );
  assert.deepEqual(ragCalls[0].options.retrievalPlan, {
    queries: ["policy change"],
  });
  assert.equal(recoveredRun.result.answer, "Recovered running primary step.");
  assert.equal(
    recoveredRun.steps[0].status,
    AGENT_RUN_STEP_STATUSES.completed
  );
  assert.ok(
    recoveredRun.events.some(
      (event) => event.type === "auto_recovery_completed"
    )
  );
});

test("postgres agent run recovery resumes the next safe step after restart without replaying completed work", async () => {
  for (const nextStepStatus of [
    AGENT_RUN_STEP_STATUSES.pending,
    AGENT_RUN_STEP_STATUSES.running,
  ]) {
    const harness = createFakePostgresAgentRunHarness();
    const firstService = harness.createService();
    const runId = `run-next-step-${nextStepStatus}`;

    await firstService.createRun({
      accessScope,
      goal: "Recover the next document step",
      input: {
        docIds: ["doc-1"],
      },
      runId,
    });
    await firstService.updateRun({
      accessScope,
      runId,
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
            id: "step-next",
            input: {
              docIds: ["doc-2"],
              question: `What changed next from ${nextStepStatus}?`,
            },
            status: nextStepStatus,
            type: "document_rag",
          },
        ],
      },
    });

    const restartedService = harness.createService({
      now: () => "2026-06-14T00:05:00.000Z",
    });
    const ragCalls = [];
    const recoveryService = createAgentRunRecoveryService({
      agentRunService: restartedService,
      agentRunStepExecutor: createPostgresDocumentStepExecutor({
        agentRunService: restartedService,
        calls: ragCalls,
        text: `Recovered ${nextStepStatus} second step.`,
      }),
      now: () => "2026-06-14T00:06:00.000Z",
    });

    const recovery = await recoveryService.recoverOnStartup({
      mode: "auto",
    });
    const recoveredRun = await restartedService.getRun({
      accessScope,
      runId,
    });
    const completedStep = recoveredRun.steps.find(
      (step) => step.id === "step-completed"
    );
    const resumedStep = recoveredRun.steps.find(
      (step) => step.id === "step-next"
    );
    assert.equal(recovery.autoRecoveredCount, 1);
    assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.completed);
    assert.equal(recoveredRun.result.recovery.stepId, "step-next");
    assert.equal(ragCalls.length, 1);
    assert.deepEqual(ragCalls[0].docIds, ["doc-2"]);
    assert.equal(
      ragCalls[0].question,
      `What changed next from ${nextStepStatus}?`
    );
    assert.equal(completedStep.status, AGENT_RUN_STEP_STATUSES.completed);
    assert.equal(completedStep.output.text, "Completed before restart.");
    assert.equal(resumedStep.status, AGENT_RUN_STEP_STATUSES.completed);
    assert.equal(
      resumedStep.output.text,
      `Recovered ${nextStepStatus} second step.`
    );
  }
});

test("postgres agent run recovery does not auto replay a running unsafe external write step after restart", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const firstService = harness.createService();

  await firstService.createRun({
    accessScope,
    goal: "Recover unsafe external write",
    runId: "run-unsafe-write",
  });
  await firstService.updateRun({
    accessScope,
    runId: "run-unsafe-write",
    patch: {
      steps: [
        {
          id: "arxiv-import-step",
          input: {
            topic: "agent recovery",
          },
          status: AGENT_RUN_STEP_STATUSES.running,
          type: "arxiv_import",
        },
      ],
    },
  });

  const restartedService = harness.createService({
    now: () => "2026-06-14T00:05:00.000Z",
  });
  let resumeAttemptCount = 0;
  const recoveryService = createAgentRunRecoveryService({
    agentRunService: restartedService,
    agentRunStepExecutor: {
      resumeStep: async () => {
        resumeAttemptCount += 1;
        throw new Error("Unsafe write steps must not auto replay.");
      },
    },
    now: () => "2026-06-14T00:06:00.000Z",
  });

  const recovery = await recoveryService.recoverOnStartup({
    mode: "auto",
  });
  const actionService = createAgentRunRecoveryActionService({
    agentRunService: restartedService,
  });
  const recoveryRuns = await actionService.listRecoveryRuns({
    accessScope,
  });
  const recoveredRun = await restartedService.getRun({
    accessScope,
    runId: "run-unsafe-write",
  });
  const listedRun = recoveryRuns.runs.find(
    (run) => run.runId === "run-unsafe-write"
  );
  const unsafeStepSafety = listedRun.recovery.replaySafety.steps.find(
    (step) => step.stepId === "arxiv-import-step"
  );

  assert.equal(resumeAttemptCount, 0);
  assert.equal(recovery.autoRecoveredCount, 0);
  assert.equal(recovery.manualRecoveredCount, 1);
  assert.equal(recovery.recoveredCount, 1);
  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.deepEqual(
    {
      mode: recoveredRun.result.recovery.mode,
      reason: recoveredRun.result.recovery.reason,
      requestedMode: recoveredRun.result.recovery.requestedMode,
    },
    {
      mode: "manual",
      reason: STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval,
      requestedMode: "auto",
    }
  );
  assert.equal(unsafeStepSafety.canAutoReplay, false);
  assert.ok(
    unsafeStepSafety.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.externalWrite
    )
  );
  assert.ok(
    unsafeStepSafety.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval
    )
  );
  assert.deepEqual(
    listedRun.recovery.actions.map((action) => action.type),
    ["cancel"]
  );
  assert.equal(
    recoveredRun.events.some(
      (event) => event.type === "auto_recovery_started"
    ),
    false
  );
  assert.ok(
    recoveredRun.events.some(
      (event) => event.type === "manual_recovery_required"
    )
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

test("postgres agent run store list() appends parameterized LIMIT and OFFSET", async () => {
  const capturedQueries = [];
  const query = async (queryText, values = []) => {
    capturedQueries.push({ queryText, values });

    if (queryText.includes("INSERT INTO rag_agent_runs_test")) {
      const row = buildFakeRunRow(values);
      return { rowCount: 1, rows: [row] };
    }

    if (queryText.includes("INSERT INTO rag_agent_run_events_test")) {
      return {
        rowCount: 1,
        rows: [{
          event_id: 1,
          event_type: values[3],
          event_payload: parseJson(values[4], {}),
          created_at: "2026-06-14T00:00:00.000Z",
        }],
      };
    }

    if (queryText.includes("UPDATE rag_agent_runs_test")) {
      return { rowCount: 1, rows: [] };
    }

    if (queryText.includes("FROM rag_agent_run_events_test")) {
      return { rowCount: 0, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  };
  const store = createPostgresAgentRunStore({
    eventsTableName: "rag_agent_run_events_test",
    now: () => "2026-06-14T00:00:00.000Z",
    query,
    runMigrations: async () => ({ appliedMigrations: [], status: "ok" }),
    tableName: "rag_agent_runs_test",
  });

  await store.list({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
  });

  const defaultQuery = capturedQueries.find(
    (q) => q.queryText.includes("LIMIT") && q.queryText.includes("OFFSET")
  );

  assert.ok(defaultQuery, "list query should contain LIMIT and OFFSET");
  assert.equal(defaultQuery.values[3], 200, "default limit should be 200");
  assert.equal(defaultQuery.values[4], 0, "default offset should be 0");

  capturedQueries.length = 0;
  await store.list({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
    limit: 10,
    offset: 20,
  });

  const explicitQuery = capturedQueries.find(
    (q) => q.queryText.includes("LIMIT")
  );

  assert.equal(explicitQuery.values[3], 10, "explicit limit should be 10");
  assert.equal(explicitQuery.values[4], 20, "explicit offset should be 20");

  capturedQueries.length = 0;
  await store.list({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
    limit: 5000,
  });

  const clampedQuery = capturedQueries.find(
    (q) => q.queryText.includes("LIMIT")
  );

  assert.equal(clampedQuery.values[3], 1000, "limit above 1000 should clamp to 1000");

  capturedQueries.length = 0;
  await store.list({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
    limit: -5,
    offset: -10,
  });

  const invalidQuery = capturedQueries.find(
    (q) => q.queryText.includes("LIMIT")
  );

  assert.equal(invalidQuery.values[3], 200, "invalid limit should fall back to 200");
  assert.equal(invalidQuery.values[4], 0, "invalid offset should fall back to 0");

  capturedQueries.length = 0;
  await store.list({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
    limit: "abc",
    offset: null,
  });

  const nonNumericQuery = capturedQueries.find(
    (q) => q.queryText.includes("LIMIT")
  );

  assert.equal(nonNumericQuery.values[3], 200, "non-numeric limit should fall back to 200");
  assert.equal(nonNumericQuery.values[4], 0, "non-numeric offset should fall back to 0");

  capturedQueries.length = 0;
  await store.list({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
    limit: "all",
  });

  const unboundedQuery = capturedQueries.find(
    (q) => q.queryText.includes("LIMIT")
  );

  assert.equal(
    unboundedQuery.values[3],
    null,
    'limit "all" should pass NULL (LIMIT NULL = no limit in PostgreSQL)'
  );
  assert.equal(unboundedQuery.values[4], 0, 'limit "all" keeps offset 0 by default');
});

test("postgres agent run store list() uses parameterized LIMIT/OFFSET (never interpolated)", async () => {
  const capturedQueries = [];
  const query = async (queryText, values = []) => {
    capturedQueries.push({ queryText, values });
    return { rowCount: 0, rows: [] };
  };
  const store = createPostgresAgentRunStore({
    eventsTableName: "rag_agent_run_events_test",
    now: () => "2026-06-14T00:00:00.000Z",
    query,
    runMigrations: async () => ({ appliedMigrations: [], status: "ok" }),
    tableName: "rag_agent_runs_test",
  });

  await store.list({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
    limit: 50,
    offset: 25,
  });

  const listQuery = capturedQueries.find(
    (q) => q.queryText.includes("LIMIT $4 OFFSET $5")
  );

  assert.ok(listQuery, "LIMIT and OFFSET should use parameterized placeholders $4 and $5");
  assert.equal(listQuery.values.length, 5);
  assert.equal(listQuery.values[3], 50);
  assert.equal(listQuery.values[4], 25);
});

test("postgres agent run creates are insert-only and reject duplicate run ids", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();

  await store.create({
    accessScope,
    run: {
      goal: "Preserve the first run",
      result: {
        marker: "first",
      },
      runId: "run-insert-only",
      status: AGENT_RUN_STATUSES.running,
    },
  });

  await assert.rejects(
    () =>
      store.create({
        accessScope,
        run: {
          goal: "Overwrite the first run",
          result: {
            marker: "second",
          },
          runId: "run-insert-only",
          status: AGENT_RUN_STATUSES.completed,
        },
      }),
    (error) => {
      assert.equal(error.code, "AGENT_RUN_ALREADY_EXISTS");
      assert.equal(error.status, 409);
      return true;
    }
  );

  const persistedRun = await store.get({
    accessScope,
    runId: "run-insert-only",
  });
  const createQuery = harness.queries.find(
    ({ queryText }) =>
      queryText.includes("INSERT INTO rag_agent_runs_test") &&
      !queryText.includes("WITH inserted_run AS")
  );

  assert.equal(persistedRun.goal, "Preserve the first run");
  assert.equal(persistedRun.result.marker, "first");
  assert.equal(persistedRun.revision, 0);
  assert.match(createQuery.queryText, /ON CONFLICT[\s\S]*DO NOTHING/);
  assert.doesNotMatch(createQuery.queryText, /DO UPDATE/);
});

test("postgres agent run createWithEvent commits the run and event atomically", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();
  const run = {
    goal: "Create an observable run",
    runId: "run-create-with-event",
    status: AGENT_RUN_STATUSES.running,
  };
  const event = {
    payload: {
      source: "test",
    },
    type: "run_created",
  };

  harness.failNextAtomicEvent();
  await assert.rejects(
    () =>
      store.createWithEvent({
        accessScope,
        event,
        run,
      }),
    /Simulated atomic event insert failure/
  );
  assert.equal(
    await store.get({
      accessScope,
      runId: run.runId,
    }),
    null
  );
  assert.equal(harness.events.length, 0);

  const createdRun = await store.createWithEvent({
    accessScope,
    event,
    run,
  });

  assert.equal(createdRun.revision, 0);
  assert.deepEqual(
    createdRun.events.map(({ type }) => type),
    ["run_created"]
  );
  assert.equal(createdRun.events[0].payload.source, "test");

  await assert.rejects(
    () =>
      store.createWithEvent({
        accessScope,
        event: {
          type: "duplicate_run_created",
        },
        run,
      }),
    (error) => {
      assert.equal(error.code, "AGENT_RUN_ALREADY_EXISTS");
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.equal(harness.events.length, 1);

  const atomicCreateQuery = harness.queries.find(({ queryText }) =>
    queryText.includes("WITH inserted_run AS")
  );

  assert.match(atomicCreateQuery.queryText, /recorded_event AS/);
  assert.match(atomicCreateQuery.queryText, /FROM inserted_run/);
  assert.match(atomicCreateQuery.queryText, /DO NOTHING/);
  assert.doesNotMatch(atomicCreateQuery.queryText, /DO UPDATE/);
});

test("postgres agent run updateWithEvent binds revision CAS and event insertion", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();

  await store.create({
    accessScope,
    run: {
      goal: "Commit state with its event",
      runId: "run-update-with-event",
      status: AGENT_RUN_STATUSES.running,
    },
  });

  const updatedRun = await store.updateWithEvent({
    accessScope,
    event: {
      payload: {
        phase: "first",
      },
      type: "step_completed",
    },
    expectedRevision: 0,
    patch: {
      result: {
        phase: "first",
      },
    },
    runId: "run-update-with-event",
  });

  assert.equal(updatedRun.revision, 1);
  assert.equal(updatedRun.result.phase, "first");
  assert.deepEqual(
    updatedRun.events.map(({ type }) => type),
    ["step_completed"]
  );

  await assert.rejects(
    () =>
      store.updateWithEvent({
        accessScope,
        event: {
          type: "stale_step_completed",
        },
        expectedRevision: 0,
        patch: {
          result: {
            phase: "stale",
          },
        },
        runId: "run-update-with-event",
      }),
    (error) => {
      assert.equal(error.code, "AGENT_RUN_REVISION_CONFLICT");
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.equal(harness.events.length, 1);

  harness.failNextAtomicEvent();
  await assert.rejects(
    () =>
      store.updateWithEvent({
        accessScope,
        event: {
          type: "failed_event_insert",
        },
        expectedRevision: 1,
        patch: {
          result: {
            phase: "must-not-commit",
          },
        },
        runId: "run-update-with-event",
      }),
    /Simulated atomic event insert failure/
  );

  const persistedRun = await store.get({
    accessScope,
    runId: "run-update-with-event",
  });
  const atomicUpdateQuery = harness.queries.find(({ queryText }) =>
    queryText.includes("WITH updated_run AS")
  );

  assert.equal(persistedRun.revision, 1);
  assert.equal(persistedRun.result.phase, "first");
  assert.deepEqual(
    persistedRun.events.map(({ type }) => type),
    ["step_completed"]
  );
  assert.match(atomicUpdateQuery.queryText, /AND revision = \$4/);
  assert.match(atomicUpdateQuery.queryText, /recorded_event AS/);
  assert.match(atomicUpdateQuery.queryText, /FROM updated_run/);
  assert.match(
    atomicUpdateQuery.queryText,
    /INSERT INTO rag_agent_run_events_test\s*\(\s*user_id,\s*workspace_id,\s*run_id,\s*event_type,\s*event_payload\s*\)\s*SELECT \$1, \$2, \$3, \$16, \$17::jsonb/s
  );
});

test("postgres agent run appendEvent cannot create orphan events or partially touch a run", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();

  const missingRunEvent = await store.appendEvent({
    accessScope,
    event: {
      type: "orphan_event",
    },
    runId: "missing-run",
  });

  assert.equal(missingRunEvent, null);
  assert.equal(harness.events.length, 0);

  await store.create({
    accessScope,
    run: {
      goal: "Append a bound event",
      runId: "run-append-event",
      status: AGENT_RUN_STATUSES.running,
    },
  });
  const beforeFailure = await store.get({
    accessScope,
    runId: "run-append-event",
  });

  harness.failNextAtomicEvent();
  await assert.rejects(
    () =>
      store.appendEvent({
        accessScope,
        event: {
          type: "failed_append",
        },
        runId: "run-append-event",
      }),
    /Simulated atomic event insert failure/
  );

  const afterFailure = await store.get({
    accessScope,
    runId: "run-append-event",
  });

  assert.equal(afterFailure.updatedAt, beforeFailure.updatedAt);
  assert.deepEqual(afterFailure.events, []);

  const appendedEvent = await store.appendEvent({
    accessScope,
    event: {
      payload: {
        phase: "committed",
      },
      type: "run_observed",
    },
    runId: "run-append-event",
  });
  const appendQuery = harness.queries.find(({ queryText }) =>
    queryText.includes("WITH touched_run AS")
  );

  assert.equal(appendedEvent.type, "run_observed");
  assert.equal(appendedEvent.payload.phase, "committed");
  assert.equal(harness.events.length, 1);
  assert.match(appendQuery.queryText, /recorded_event AS/);
  assert.match(appendQuery.queryText, /FROM touched_run/);
});

test("postgres agent run updates use revision CAS and keep revision internal", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();

  await store.create({
    accessScope,
    run: {
      goal: "Verify revision CAS",
      runId: "run-revision-cas",
      status: AGENT_RUN_STATUSES.running,
    },
  });
  const firstUpdate = await store.update({
    accessScope,
    expectedRevision: 0,
    patch: {
      result: {
        phase: "first",
      },
    },
    runId: "run-revision-cas",
  });

  assert.equal(firstUpdate.revision, 1);
  await assert.rejects(
    () =>
      store.update({
        accessScope,
        expectedRevision: 0,
        patch: {
          result: {
            phase: "stale",
          },
        },
        runId: "run-revision-cas",
      }),
    (error) => {
      assert.equal(error.code, "AGENT_RUN_REVISION_CONFLICT");
      assert.equal(error.status, 409);
      return true;
    }
  );

  const casQuery = harness.queries.find(({ queryText }) =>
    queryText.includes("revision = revision + 1")
  );

  assert.ok(casQuery);
  assert.match(casQuery.queryText, /AND revision = \$4/);
  assert.equal(casQuery.values[3], 0);

  const service = harness.createService();
  const publicRun = await service.getRun({
    accessScope,
    runId: "run-revision-cas",
  });

  assert.equal("revision" in publicRun, false);
  assert.equal(publicRun.result.phase, "first");
});

test("postgres agent run store scopes private approval snapshot reads by run and gate", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();

  const snapshot = await store.getApprovalSnapshot({
    accessScope,
    gateId: "gate-missing",
    runId: "run-missing",
  });

  assert.equal(snapshot, null);
  const readQuery = harness.queries.find(({ queryText }) =>
    queryText.includes("FROM rag_agent_runs_test_approval_snapshots")
  );

  assert.ok(readQuery);
  assert.match(readQuery.queryText, /user_id = \$1/);
  assert.match(readQuery.queryText, /workspace_id = \$2/);
  assert.match(readQuery.queryText, /run_id = \$3/);
  assert.match(readQuery.queryText, /gate_id = \$4/);
  assert.deepEqual(readQuery.values, [
    accessScope.userId,
    accessScope.workspaceId,
    "run-missing",
    "gate-missing",
  ]);
});

test("postgres agent run store rejects a derived approval snapshot identifier that PostgreSQL would truncate", () => {
  assert.throws(
    () =>
      createPostgresAgentRunStore({
        eventsTableName: "rag_agent_run_events_test",
        tableName: "a".repeat(50),
      }),
    /derived agent run approval snapshots table.*63 bytes/i
  );
});

test("postgres agent run updateWithEvent atomically persists a full private approval snapshot", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();
  const runId = "run-private-approval";
  const snapshot = {
    gateId: "gate-private",
    capabilityId: "report.export",
    capabilityVersion: "1.0.0",
    approvalObjectHash: "sha256:approval-object",
    snapshotVersion: 1,
    executionInput: {
      content: "x".repeat(300),
      citations: Array.from({ length: 12 }, (_, index) => ({
        id: `citation-${index + 1}`,
      })),
      metadata: {
        nested: {
          preserved: true,
        },
      },
    },
  };

  await store.create({
    accessScope,
    run: {
      goal: "Persist exact approved report input",
      runId,
      status: AGENT_RUN_STATUSES.running,
    },
  });

  const updatedRun = await store.updateWithEvent({
    accessScope,
    approvalSnapshots: [snapshot],
    event: {
      type: "approval_gate_created",
    },
    expectedRevision: 0,
    patch: {
      status: AGENT_RUN_STATUSES.waitingForUser,
    },
    runId,
  });
  const persistedSnapshot = await store.getApprovalSnapshot({
    accessScope,
    gateId: snapshot.gateId,
    runId,
  });
  const publicRunSnapshot = await store.get({
    accessScope,
    runId,
  });

  assert.equal(updatedRun.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.equal(updatedRun.revision, 1);
  assert.deepEqual(persistedSnapshot, snapshot);
  assert.equal("approvalSnapshots" in publicRunSnapshot, false);
  assert.doesNotMatch(
    JSON.stringify(publicRunSnapshot),
    /\"nested\":\{\"preserved\":true\}/
  );
  assert.equal(
    await store.getApprovalSnapshot({
      accessScope: {
        ...accessScope,
        workspaceId: "workspace-b",
      },
      gateId: snapshot.gateId,
      runId,
    }),
    null
  );
  const atomicQuery = harness.queries.find(
    ({ queryText }) =>
      queryText.includes("WITH requested_approval_snapshots AS") &&
      queryText.includes("updated_run AS") &&
      queryText.includes("inserted_approval_snapshots AS")
  );

  assert.ok(atomicQuery);
  assert.match(
    atomicQuery.queryText,
    /approval_snapshot_write_guard AS/
  );
  assert.match(
    atomicQuery.queryText,
    /WHEN NOT run_updated THEN TRUE/
  );
  assert.match(atomicQuery.queryText, /recorded_event AS/);
});

test("postgres agent run approval snapshots reject a different hash without partially updating the run or event", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();
  const runId = "run-approval-hash-conflict";
  const originalSnapshot = {
    gateId: "gate-conflict",
    capabilityId: "report.export",
    capabilityVersion: "1.0.0",
    approvalObjectHash: "sha256:original",
    snapshotVersion: 1,
    executionInput: {
      content: "Approved content",
    },
  };

  await store.create({
    accessScope,
    run: {
      goal: "Reject approval snapshot replacement",
      runId,
      status: AGENT_RUN_STATUSES.running,
    },
  });
  await store.updateWithEvent({
    accessScope,
    approvalSnapshots: [originalSnapshot],
    event: {
      type: "approval_gate_created",
    },
    expectedRevision: 0,
    patch: {
      result: {
        phase: "original",
      },
      status: AGENT_RUN_STATUSES.waitingForUser,
    },
    runId,
  });

  await assert.rejects(
    () =>
      store.updateWithEvent({
        accessScope,
        approvalSnapshots: [
          {
            ...originalSnapshot,
            approvalObjectHash: "sha256:replacement",
            executionInput: {
              content: "Replacement content",
            },
          },
        ],
        event: {
          type: "approval_gate_replaced",
        },
        expectedRevision: 1,
        patch: {
          result: {
            phase: "replacement",
          },
        },
        runId,
      }),
    (error) => {
      assert.equal(error.code, "AGENT_RUN_APPROVAL_SNAPSHOT_CONFLICT");
      assert.equal(error.status, 409);
      return true;
    }
  );

  const persistedRun = await store.get({
    accessScope,
    runId,
  });
  const persistedSnapshot = await store.getApprovalSnapshot({
    accessScope,
    gateId: originalSnapshot.gateId,
    runId,
  });

  assert.equal(persistedRun.revision, 1);
  assert.equal(persistedRun.result.phase, "original");
  assert.deepEqual(
    persistedRun.events.map((event) => event.type),
    ["approval_gate_created"]
  );
  assert.deepEqual(persistedSnapshot, originalSnapshot);
});

test("postgres agent run approval snapshot writes preserve stale revision conflict semantics", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();
  const runId = "run-approval-stale-revision";
  const snapshot = {
    gateId: "gate-stale",
    capabilityId: "web.search",
    capabilityVersion: "1.0.0",
    approvalObjectHash: "sha256:stale",
    snapshotVersion: 1,
    executionInput: {
      question: "Do not persist this stale snapshot",
    },
  };

  await store.create({
    accessScope,
    run: {
      goal: "Keep revision CAS authoritative",
      runId,
      status: AGENT_RUN_STATUSES.running,
    },
  });
  await store.updateWithEvent({
    accessScope,
    event: {
      type: "run_advanced",
    },
    expectedRevision: 0,
    patch: {
      result: {
        phase: "current",
      },
    },
    runId,
  });

  await assert.rejects(
    () =>
      store.updateWithEvent({
        accessScope,
        approvalSnapshots: [snapshot],
        event: {
          type: "approval_gate_created",
        },
        expectedRevision: 0,
        patch: {
          result: {
            phase: "stale",
          },
        },
        runId,
      }),
    (error) => {
      assert.equal(error.code, "AGENT_RUN_REVISION_CONFLICT");
      assert.equal(error.status, 409);
      return true;
    }
  );

  const persistedRun = await store.get({
    accessScope,
    runId,
  });

  assert.equal(persistedRun.revision, 1);
  assert.equal(persistedRun.result.phase, "current");
  assert.deepEqual(
    persistedRun.events.map((event) => event.type),
    ["run_advanced"]
  );
  assert.equal(
    await store.getApprovalSnapshot({
      accessScope,
      gateId: snapshot.gateId,
      runId,
    }),
    null
  );
});

test("postgres agent run approval snapshot update rolls back snapshot and run when its event insert fails", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();
  const runId = "run-approval-event-failure";
  const snapshot = {
    gateId: "gate-event-failure",
    capabilityId: "report.export",
    capabilityVersion: "1.0.0",
    approvalObjectHash: "sha256:event-failure",
    snapshotVersion: 1,
    executionInput: {
      content: "Must roll back with the event.",
    },
  };

  await store.create({
    accessScope,
    run: {
      goal: "Keep approval persistence atomic",
      runId,
      status: AGENT_RUN_STATUSES.running,
    },
  });
  harness.failNextAtomicEvent();

  await assert.rejects(
    () =>
      store.updateWithEvent({
        accessScope,
        approvalSnapshots: [snapshot],
        event: {
          type: "approval_gate_created",
        },
        expectedRevision: 0,
        patch: {
          status: AGENT_RUN_STATUSES.waitingForUser,
        },
        runId,
      }),
    /Simulated atomic event insert failure/
  );

  const persistedRun = await store.get({
    accessScope,
    runId,
  });

  assert.equal(persistedRun.revision, 0);
  assert.equal(persistedRun.status, AGENT_RUN_STATUSES.running);
  assert.deepEqual(persistedRun.events, []);
  assert.equal(
    await store.getApprovalSnapshot({
      accessScope,
      gateId: snapshot.gateId,
      runId,
    }),
    null
  );
});

test("postgres agent run approval snapshot insert failure cannot partially update the run or event", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();
  const runId = "run-approval-snapshot-failure";
  const snapshot = {
    gateId: "gate-snapshot-failure",
    capabilityId: "report.export",
    capabilityVersion: "1.0.0",
    approvalObjectHash: "sha256:snapshot-failure",
    snapshotVersion: 1,
    executionInput: {
      content: "The failing snapshot must not leave partial state.",
    },
  };

  await store.create({
    accessScope,
    run: {
      goal: "Roll back a failed private snapshot insert",
      runId,
      status: AGENT_RUN_STATUSES.running,
    },
  });
  harness.failNextAtomicSnapshot();

  await assert.rejects(
    () =>
      store.updateWithEvent({
        accessScope,
        approvalSnapshots: [snapshot],
        event: {
          type: "approval_gate_created",
        },
        expectedRevision: 0,
        patch: {
          result: {
            phase: "must-not-commit",
          },
          status: AGENT_RUN_STATUSES.waitingForUser,
        },
        runId,
      }),
    /Simulated atomic approval snapshot insert failure/
  );

  const persistedRun = await store.get({
    accessScope,
    runId,
  });

  assert.equal(persistedRun.revision, 0);
  assert.equal(persistedRun.status, AGENT_RUN_STATUSES.running);
  assert.equal(persistedRun.result.phase, undefined);
  assert.deepEqual(persistedRun.events, []);
  assert.equal(
    await store.getApprovalSnapshot({
      accessScope,
      gateId: snapshot.gateId,
      runId,
    }),
    null
  );
});

test("postgres agent run approval snapshots cannot be written without a bound event", async () => {
  const harness = createFakePostgresAgentRunHarness();
  const store = harness.createStore();
  const runId = "run-approval-without-event";

  await store.create({
    accessScope,
    run: {
      goal: "Require an event for private approval state",
      runId,
      status: AGENT_RUN_STATUSES.running,
    },
  });

  await assert.rejects(
    () =>
      store.updateWithEvent({
        accessScope,
        approvalSnapshots: [
          {
            gateId: "gate-without-event",
            capabilityId: "report.export",
            capabilityVersion: "1.0.0",
            approvalObjectHash: "sha256:without-event",
            snapshotVersion: 1,
            executionInput: {
              content: "Must not persist without an event.",
            },
          },
        ],
        event: null,
        expectedRevision: 0,
        patch: {
          status: AGENT_RUN_STATUSES.waitingForUser,
        },
        runId,
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /event/i);
      return true;
    }
  );

  const persistedRun = await store.get({
    accessScope,
    runId,
  });

  assert.equal(persistedRun.revision, 0);
  assert.equal(persistedRun.status, AGENT_RUN_STATUSES.running);
});
