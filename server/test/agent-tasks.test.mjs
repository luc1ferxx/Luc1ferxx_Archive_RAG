import assert from "node:assert/strict";
import test from "node:test";

import { runAgentRag } from "../rag/agent.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
} from "../rag/agent-runs.js";
import {
  AGENT_RUN_STEP_STATUSES,
} from "../rag/agent-run-steps.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import {
  AGENT_TASK_ACTIONS,
  AGENT_TASK_RUNNER_ID,
  AGENT_TASK_TYPE,
  createAgentTaskRunner,
  createAgentTaskService,
} from "../rag/agent-tasks.js";
import {
  CAPABILITY_IDS,
} from "../rag/capabilities/index.js";
import {
  buildAgentTaskPlanningContext,
} from "../rag/agent-task-memory.js";
import {
  RESEARCH_DOSSIER_WORKFLOW_ID,
} from "../rag/agent-workflows/built-ins/research-dossier.js";
import { createPostgresAgentRunStore } from "../rag/postgres-agent-run-store.js";
import { createPostgresTaskStore } from "../rag/postgres-task-store.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_STATUSES,
} from "../rag/tasks.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const parseJson = (value, fallback = null) =>
  value === null || value === undefined ? fallback : JSON.parse(value);

const buildFakeTaskRow = (values, existingRow = null) => ({
  user_id: values[0],
  workspace_id: values[1],
  task_id: values[2],
  type: values[3],
  status: values[4],
  label: values[5],
  summary: values[6],
  provider: parseJson(values[7]),
  subject: parseJson(values[8]),
  runner_id: values[9],
  action: values[10],
  counts: parseJson(values[11], {}),
  input: parseJson(values[12], {}),
  items: parseJson(values[13], []),
  result: parseJson(values[14], {}),
  error: parseJson(values[15]),
  payload: parseJson(values[16]),
  required_user_action: values[17],
  created_at: values[18] || existingRow?.created_at || values[20],
  updated_at: values[19] || values[20],
  attempt_count: existingRow?.attempt_count ?? 0,
  next_run_at: existingRow?.next_run_at ?? null,
  claimed_by: existingRow?.claimed_by ?? "",
  claimed_at: existingRow?.claimed_at ?? null,
});

const createFakePostgresTaskHarness = () => {
  const rows = new Map();
  const events = [];
  const tableName = "rag_tasks_agent_task_restart";
  const eventsTableName = "rag_task_events_agent_task_restart";
  const buildKey = ({ taskId, userId, workspaceId }) =>
    `${userId}\u0000${workspaceId}\u0000${taskId}`;
  const query = async (queryText, values = []) => {
    if (queryText.includes(`INSERT INTO ${tableName}`)) {
      const key = buildKey({
        taskId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = buildFakeTaskRow(values, rows.get(key));

      rows.set(key, row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (queryText.includes(`INSERT INTO ${eventsTableName}`)) {
      events.push({
        eventPayload: parseJson(values[4], {}),
        eventType: values[3],
        taskId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      return {
        rowCount: 1,
        rows: [],
      };
    }

    if (
      queryText.includes("status = ANY") &&
      queryText.includes(`FROM ${tableName}`)
    ) {
      const statuses = new Set(values[0]);

      return {
        rowCount: 0,
        rows: [...rows.values()].filter((row) => statuses.has(row.status)),
      };
    }

    if (
      queryText.includes("task_id = $3") &&
      queryText.includes(`FROM ${tableName}`)
    ) {
      const key = buildKey({
        taskId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = rows.get(key);

      return {
        rowCount: row ? 1 : 0,
        rows: row ? [row] : [],
      };
    }

    if (queryText.includes(`FROM ${tableName}`)) {
      const [userId, workspaceId, type] = values;

      return {
        rowCount: 0,
        rows: [...rows.values()].filter(
          (row) =>
            row.user_id === userId &&
            row.workspace_id === workspaceId &&
            (!type || row.type === type)
        ),
      };
    }

    throw new Error(`Unexpected query: ${queryText}`);
  };

  return {
    createService({ now = () => "2026-06-23T00:00:00.000Z" } = {}) {
      return createTaskService({
        taskStore: createPostgresTaskStore({
          eventsTableName,
          now,
          query,
          runMigrations: async () => ({
            appliedMigrations: [],
            status: "ok",
          }),
          tableName,
        }),
      });
    },
    events,
    rows,
  };
};

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
  const tableName = "rag_agent_runs_agent_task_restart";
  const eventsTableName = "rag_agent_run_events_agent_task_restart";
  const buildKey = ({ runId, userId, workspaceId }) =>
    `${userId}\u0000${workspaceId}\u0000${runId}`;
  const query = async (queryText, values = []) => {
    if (queryText.includes(`INSERT INTO ${tableName}`)) {
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

    if (queryText.includes(`INSERT INTO ${eventsTableName}`)) {
      const row = {
        created_at: "2026-06-23T00:00:00.000Z",
        event_id: events.length + 1,
        event_payload: parseJson(values[4], {}),
        event_type: values[3],
        run_id: values[2],
        user_id: values[0],
        workspace_id: values[1],
      };

      events.push(row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes(`UPDATE ${tableName}`) &&
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

    if (queryText.includes(`FROM ${eventsTableName}`)) {
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
      queryText.includes(`FROM ${tableName}`)
    ) {
      const statuses = new Set(values[0]);

      return {
        rowCount: 0,
        rows: [...rows.values()].filter((row) => statuses.has(row.status)),
      };
    }

    if (
      queryText.includes("run_id = $3") &&
      queryText.includes(`FROM ${tableName}`)
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

    if (queryText.includes(`FROM ${tableName}`)) {
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

  return {
    createService({ now = () => "2026-06-23T00:00:00.000Z" } = {}) {
      return createAgentRunService({
        agentRunStore: createPostgresAgentRunStore({
          eventsTableName,
          now,
          query,
          runMigrations: async () => ({
            appliedMigrations: [],
            status: "ok",
          }),
          tableName,
        }),
      });
    },
    events,
    rows,
  };
};

const createSequentialRagService = ({ calls = [], responses = [] } = {}) => {
  let responseIndex = 0;

  return {
    chat: async (docIds, question, options = {}) => {
      calls.push({
        docIds,
        options,
        question,
      });

      const response = responses[responseIndex++];

      if (response instanceof Error) {
        throw response;
      }

      return response;
    },
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "contract.pdf",
      },
    ],
  };
};

const createRealAgentTaskRunner = ({ agentRunService, ragService } = {}) =>
  createAgentTaskRunner({
    runAgentTask: (request) =>
      runAgentRag({
        accessScope: request.accessScope ?? accessScope,
        agentBudget: {
          maxWebSearchCalls: 0,
        },
        agentRunId: request.agentRunId,
        agentRunService,
        capabilityApprovals: request.capabilityApprovals,
        docIds: request.docIds,
        intentPlannerAdapter: {
          id: "test_document",
          selectIntentPlan: async () => ({
            reason: "Exercise document RAG persistence in the task restart test.",
            selectedIntentId: "document",
          }),
        },
        question: request.question,
        ragService,
        sessionId: request.sessionId,
        taskMemory: request.taskMemory,
        userId: request.userId,
        webChatService: async () => {
          throw new Error("Web search should not run in this task restart test.");
        },
      }),
  });

const createDeliverableCapabilityRegistry = () => {
  const calls = [];
  const labels = {
    [CAPABILITY_IDS.documentOrganize]: "Organize Documents",
    [CAPABILITY_IDS.reportExport]: "Report Export",
    [CAPABILITY_IDS.summaryCreate]: "Create Summary",
    [CAPABILITY_IDS.taskCreate]: "Create Task",
  };
  const buildTask = ({ id, summary, type = "agent_action" }) => ({
    id,
    status: TASK_STATUSES.completed,
    summary,
    type,
  });

  return {
    calls,
    describe: (capabilityId) => ({
      id: capabilityId,
      version: "1.0.0",
      label: labels[capabilityId] ?? capabilityId,
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

      if (capabilityId === CAPABILITY_IDS.documentOrganize) {
        return {
          organization: {
            documentCount: payload.input.docIds.length,
            groups: [
              {
                label: "papers",
              },
            ],
          },
          task: buildTask({
            id: "agent_action:organize",
            summary: "Organized documents.",
          }),
          text: "Document organization recorded.",
        };
      }

      if (capabilityId === CAPABILITY_IDS.reportExport) {
        return {
          report: {
            fileName: "risk-report.md",
            format: "markdown",
            mimeType: "text/markdown",
          },
          stored: false,
          text: "Prepared report export risk-report.md.",
        };
      }

      if (capabilityId === CAPABILITY_IDS.summaryCreate) {
        return {
          summary: {
            docIds: payload.input.docIds,
            title: payload.input.title,
          },
          task: buildTask({
            id: "agent_action:summary",
            summary: "Saved summary.",
          }),
          text: "Summary recorded.",
        };
      }

      if (capabilityId === CAPABILITY_IDS.taskCreate) {
        return {
          task: buildTask({
            id: "agent_action:follow-up",
            summary: payload.input.description,
          }),
          text: "Task recorded.",
        };
      }

      throw new Error(`Unexpected capability: ${capabilityId}`);
    },
  };
};

test("agent task service creates queued durable goal tasks without leaking internal payload", async () => {
  const scheduledRuns = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const agentTaskService = createAgentTaskService({
    createTaskId: () => "task-1",
    jobOrchestrator: {
      scheduleTaskRun: (run) => scheduledRuns.push(run),
    },
    taskService,
  });

  const task = await agentTaskService.createTask({
    accessScope,
    docIds: ["doc-1"],
    maxIterations: 2,
    question: "Summarize the renewal terms.",
    sessionId: "session-1",
    userPreferences: ["Use concise bullets."],
    userId: "alice",
  });

  assert.equal(task.id, "agent_goal:task-1");
  assert.equal(task.type, AGENT_TASK_TYPE);
  assert.equal(task.runnerId, AGENT_TASK_RUNNER_ID);
  assert.equal(task.status, TASK_STATUSES.queued);
  assert.equal(task.payload, undefined);
  assert.deepEqual(
    task.items.map((item) => [item.id, item.status]),
    [
      ["goal", TASK_STATUSES.completed],
      ["agent-loop", TASK_STATUSES.queued],
      ["deliverable", TASK_STATUSES.pending],
    ]
  );
  assert.equal(task.result.goalPlan.goal, "Summarize the renewal terms.");
  assert.equal(task.result.goalPlan.status, TASK_STATUSES.queued);
  assert.equal(task.result.goalPlan.currentStepId, "agent-loop");
  assert.equal(task.result.goalCompletion.status, "running");
  assert.deepEqual(task.input, {
    docIds: ["doc-1"],
    maxIterations: 2,
    question: "Summarize the renewal terms.",
    sessionId: "session-1",
    userPreferences: ["Use concise bullets."],
    userId: "alice",
  });
  assert.deepEqual(scheduledRuns, [
    {
      accessScope,
      taskId: "agent_goal:task-1",
    },
  ]);

  const internalTask = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  assert.deepEqual(internalTask.payload.iterations, []);
  assert.equal(internalTask.payload.question, "Summarize the renewal terms.");
  assert.deepEqual(internalTask.payload.taskMemory, {
    completedSteps: [],
    evidencePolicy: "planning_context_only",
    failedReasons: [],
    goal: "Summarize the renewal terms.",
    nextCandidates: [],
    userPreferences: ["Use concise bullets."],
  });
});

test("agent task creates approved goal deliverables through existing capabilities", async () => {
  const capabilityRegistry = createDeliverableCapabilityRegistry();
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const runner = createAgentTaskRunner({
    capabilityRegistry,
    runAgentTask: async () => ({
      body: {
        agentAnswer:
          "Risk review completed. Main risk is evidence drift across papers.",
        agentMode: "document",
        agentRunId: "run-risk",
        ragSources: [
          {
            docId: "doc-1",
            title: "Paper A",
          },
        ],
      },
      status: 200,
    }),
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [AGENT_TASK_RUNNER_ID]: runner,
    },
    taskService,
  });
  const agentTaskService = createAgentTaskService({
    createTaskId: () => "risk-report",
    jobOrchestrator: null,
    taskService,
  });

  await agentTaskService.createTask({
    accessScope,
    docIds: ["doc-1", "doc-2"],
    maxIterations: 2,
    question: "整理这些论文并生成风险报告",
    sessionId: "session-risk",
    userId: "alice",
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:risk-report",
  });

  let task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:risk-report",
  });

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.requiredUserAction, AGENT_TASK_ACTIONS.approveDeliverables);
  assert.equal(task.payload.deliverables.status, "waiting_for_approval");
  assert.deepEqual(
    task.payload.deliverables.specs.map((spec) => spec.capabilityId),
    [
      CAPABILITY_IDS.documentOrganize,
      CAPABILITY_IDS.reportExport,
      CAPABILITY_IDS.summaryCreate,
      CAPABILITY_IDS.taskCreate,
    ]
  );
  assert.equal(task.result.goalPlan.requiredUserAction, "approve_deliverables");
  assert.equal(task.result.goalPlan.currentStepId, "user-input");
  assert.equal(task.result.goalPlan.deliverables.status, "waiting_for_approval");
  assert.equal(task.result.goalPlan.deliverables.counts.planned, 4);
  assert.equal(task.result.goalCompletion.status, "pending");
  assert.equal(
    task.result.goalCompletion.checks.find(
      (check) => check.id === "deliverables_created"
    )?.passed,
    false
  );
  assert.equal(
    task.result.goalCompletion.checks.find(
      (check) => check.id === "no_pending_user_action"
    )?.passed,
    false
  );
  assert.equal(capabilityRegistry.calls.length, 0);

  await orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.approveDeliverables,
    payload: {
      approval: {
        approved: true,
        decision: "approved",
        source: "test",
      },
    },
    runImmediately: false,
    taskId: "agent_goal:risk-report",
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:risk-report",
  });

  task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:risk-report",
  });

  assert.equal(task.status, TASK_STATUSES.completed);
  assert.equal(
    task.result.answer,
    "Risk review completed. Main risk is evidence drift across papers."
  );
  assert.deepEqual(
    capabilityRegistry.calls.map((call) => call.capabilityId),
    [
      CAPABILITY_IDS.documentOrganize,
      CAPABILITY_IDS.reportExport,
      CAPABILITY_IDS.summaryCreate,
      CAPABILITY_IDS.taskCreate,
    ]
  );
  assert.ok(
    capabilityRegistry.calls.every(
      (call) =>
        call.payload.approval.approved === true &&
        call.payload.approval.source === "test"
    )
  );
  assert.equal(task.payload.deliverables.status, "completed");
  assert.equal(task.result.goalPlan.status, TASK_STATUSES.completed);
  assert.equal(task.result.goalCompletion.status, "completed");
  assert.ok(
    task.result.goalCompletion.checks.every((check) => check.passed),
    JSON.stringify(task.result.goalCompletion.checks)
  );
  assert.equal(task.result.goalPlan.deliverables.status, "completed");
  assert.equal(task.result.goalPlan.deliverables.counts.completed, 4);
  assert.equal(
    task.result.goalPlan.deliverables.items.find(
      (item) => item.capabilityId === CAPABILITY_IDS.reportExport
    )?.output.fileName,
    "risk-report.md"
  );
  assert.equal(task.items.at(-1).id, "deliverable");
  assert.equal(task.items.at(-1).status, TASK_STATUSES.completed);
});

test("agent task runs a staged research dossier flow before report delivery", async () => {
  const questions = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const runner = createAgentTaskRunner({
    runAgentTask: async ({ question }) => {
      questions.push(question);

      return {
        body: {
          agentAnswer: `Answer for research phase ${questions.length}.`,
          agentMode: "document",
          agentRunId: `run-research-${questions.length}`,
          ragSources: [
            {
              docId: `doc-${questions.length}`,
              title: `Source ${questions.length}`,
            },
          ],
        },
        status: 200,
      };
    },
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [AGENT_TASK_RUNNER_ID]: runner,
    },
    taskService,
  });
  const agentTaskService = createAgentTaskService({
    createTaskId: () => "research-dossier",
    jobOrchestrator: null,
    taskService,
  });

  await agentTaskService.createTask({
    accessScope,
    docIds: ["doc-a", "doc-b"],
    question: "research_task: 整理这些论文并生成 dossier 风险报告",
    sessionId: "session-research",
    userId: "alice",
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:research-dossier",
  });

  const task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:research-dossier",
  });
  const reportSpec = task.payload.deliverables.specs.find(
    (spec) => spec.capabilityId === CAPABILITY_IDS.reportExport
  );

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.input.researchTask, undefined);
  assert.equal(task.input.maxIterations, 10);
  assert.equal(task.requiredUserAction, AGENT_TASK_ACTIONS.approveDeliverables);
  assert.deepEqual(
    task.payload.researchTask.phases.map((phase) => [phase.id, phase.status]),
    [
      ["local_research", "completed"],
      ["web_supplement", "completed"],
      ["arxiv_supplement", "completed"],
      ["compare_risk_review", "completed"],
      ["citation_self_check", "completed"],
      ["final_dossier", "completed"],
    ]
  );
  assert.equal(task.result.researchTask.counts.completed, 6);
  assert.equal(task.result.goalPlan.researchTask.counts.completed, 6);
  assert.equal(task.result.goalPlan.researchTask.counts.total, 6);
  assert.equal(
    task.result.goalPlan.researchTask.workflow.id,
    RESEARCH_DOSSIER_WORKFLOW_ID
  );
  assert.equal(task.result.goalPlan.researchTask.workflow.version, "1.0.0");
  assert.equal(task.result.goalPlan.researchTask.workflow.currentPhaseId, null);
  assert.equal(task.result.goalPlan.researchTask.workflow.counts.completed, 6);
  assert.ok(
    task.result.goalPlan.researchTask.workflow.completionChecks.includes(
      "research_phases_completed"
    )
  );
  assert.deepEqual(
    task.result.goalPlan.researchTask.workflow.deliverables.map(
      (deliverable) => deliverable.capabilityId
    ),
    [
      CAPABILITY_IDS.documentOrganize,
      CAPABILITY_IDS.reportExport,
      CAPABILITY_IDS.summaryCreate,
      CAPABILITY_IDS.taskCreate,
    ]
  );
  assert.equal(task.result.goalCompletion.status, "pending");
  assert.equal(
    task.result.goalCompletion.checks.find(
      (check) => check.id === "research_phases_completed"
    )?.passed,
    true
  );
  assert.equal(
    task.result.goalCompletion.checks.find(
      (check) => check.id === "workflow_lifecycle_recorded"
    )?.passed,
    true
  );
  assert.deepEqual(
    task.payload.iterations.map((iteration) => iteration.researchTaskPhase.id),
    [
      "local_research",
      "web_supplement",
      "arxiv_supplement",
      "compare_risk_review",
      "citation_self_check",
      "final_dossier",
    ]
  );
  assert.match(questions[0], /document-grounded research brief/);
  assert.match(questions[1], /Search the web/);
  assert.match(questions[2], /Search arXiv/);
  assert.match(questions[3], /Compare the selected documents/);
  assert.match(questions[4], /citation self-check/);
  assert.match(questions[5], /final research dossier/);
  assert.match(reportSpec.input.content, /## Research Flow/);
  assert.match(reportSpec.input.content, /### Local document research/);
  assert.match(reportSpec.input.content, /### Web supplement/);
  assert.match(reportSpec.input.content, /### arXiv supplement/);
  assert.equal(reportSpec.input.citations.length, 6);
});

test("agent task goal completion reports unresolved evidence gaps", async () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const runner = createAgentTaskRunner({
    runAgentTask: async () => ({
      body: {
        agentAnswer: "The answer still has an unresolved evidence gap.",
        agentMode: "document",
        agentRunId: "run-gap",
        agentWorkingMemory: {
          checkedQueries: ["Check unsupported claim."],
          resolvedGaps: [],
          unsupportedClaims: [
            {
              claim: "Unsupported market claim.",
            },
          ],
          unresolvedGaps: [
            {
              question: "Find source for the market claim.",
            },
          ],
        },
      },
      status: 200,
    }),
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [AGENT_TASK_RUNNER_ID]: runner,
    },
    taskService,
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "agent_goal:gaps",
      input: {
        docIds: ["doc-1"],
        maxIterations: 1,
        question: "Summarize unresolved evidence.",
        sessionId: "session-gap",
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: ["doc-1"],
        iterations: [],
        maxIterations: 1,
        question: "Summarize unresolved evidence.",
        sessionId: "session-gap",
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:gaps",
  });

  const task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:gaps",
  });
  const evidenceCheck = task.result.goalCompletion.checks.find(
    (check) => check.id === "evidence_gaps_resolved"
  );

  assert.equal(task.status, TASK_STATUSES.completed);
  assert.equal(task.result.goalCompletion.status, "blocked");
  assert.equal(evidenceCheck?.passed, false);
  assert.equal(evidenceCheck?.detail.unresolvedGapCount, 1);
  assert.equal(evidenceCheck?.detail.unsupportedClaimCount, 1);
  assert.deepEqual(task.payload.iterations[0].workingMemory, {
    checkedQueryCount: 1,
    resolvedGapCount: 0,
    unsupportedClaimCount: 1,
    unresolvedGapCount: 1,
  });
});

test("postgres-backed agent task recovery resumes the next planned question after restart", async () => {
  const calls = [];
  const harness = createFakePostgresTaskHarness();
  const firstService = harness.createService();
  const taskId = "agent_goal:restart";
  const firstRunner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      return {
        status: 200,
        body: {
          agentAnswer: "Renewal terms found.",
          agentMode: "document",
          agentRunId: "run-restart",
          agentTask: {
            continue: true,
            nextCandidates: ["Check renewal risk."],
            nextQuestion: "Check renewal risk.",
          },
          clarification: {
            needed: false,
          },
        },
      };
    },
  });

  await firstService.upsertTask({
    accessScope,
    task: {
      id: taskId,
      input: {
        docIds: ["doc-1"],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: ["doc-1"],
        iterations: [],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.running,
      type: AGENT_TASK_TYPE,
    },
  });

  const taskBeforeRestart = await firstService.getInternalTask({
    accessScope,
    taskId,
  });

  await assert.rejects(
    firstRunner.run({
      accessScope,
      patchTask: async (patch) => {
        await firstService.patchTask({
          accessScope,
          patch,
          taskId,
        });

        if (patch.payload?.iterations?.length === 1) {
          throw new Error("Simulated process restart after first iteration.");
        }
      },
      task: taskBeforeRestart,
    }),
    /Simulated process restart/
  );

  const persistedBeforeRecovery = await firstService.getInternalTask({
    accessScope,
    taskId,
  });

  assert.equal(persistedBeforeRecovery.status, TASK_STATUSES.running);
  assert.equal(persistedBeforeRecovery.payload.iterations.length, 1);
  assert.equal(persistedBeforeRecovery.payload.nextQuestion, "Check renewal risk.");

  const restartedService = harness.createService({
    now: () => "2026-06-23T00:05:00.000Z",
  });
  const restartedRunner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      return {
        status: 200,
        body: {
          agentAnswer: "Renewal risk checked.",
          agentMode: "document",
          agentRunId: "run-restart",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const scheduledRuns = [];
  const orchestrator = createJobOrchestrator({
    runners: {
      [restartedRunner.id]: restartedRunner,
    },
    schedule: (work) => scheduledRuns.push(work),
    taskService: restartedService,
  });

  const recovery = await orchestrator.recoverRunnableTasks();

  assert.equal(recovery.scheduledCount, 1);
  assert.equal(scheduledRuns.length, 1);

  await scheduledRuns[0]();

  const recoveredTask = await restartedService.getInternalTask({
    accessScope,
    taskId,
  });

  assert.equal(recoveredTask.status, TASK_STATUSES.completed);
  assert.equal(recoveredTask.counts.iterations, 2);
  assert.deepEqual(
    calls.map((call) => call.question),
    ["Summarize renewal terms.", "Check renewal risk."]
  );
  assert.deepEqual(
    recoveredTask.payload.iterations.map((iteration) => iteration.question),
    ["Summarize renewal terms.", "Check renewal risk."]
  );
  assert.equal(recoveredTask.result.answer, "Renewal risk checked.");
  assert.equal(recoveredTask.result.taskMemory.evidencePolicy, "planning_context_only");
});

test("postgres-backed real agent task restart continues with persisted run steps and planning-only task memory", async () => {
  const taskHarness = createFakePostgresTaskHarness();
  const runHarness = createFakePostgresAgentRunHarness();
  const firstTaskService = taskHarness.createService();
  const firstAgentRunService = runHarness.createService();
  const taskId = "agent_goal:real-run-restart";
  const ragCalls = [];
  const ragService = createSequentialRagService({
    calls: ragCalls,
    responses: [
      {
        abstained: false,
        citations: [
          {
            docId: "doc-1",
            excerpt:
              "The renewal term is twelve months. Secret renewal evidence should stay out of task memory.",
            fileName: "contract.pdf",
            pageNumber: 3,
          },
        ],
        memoryApplied: false,
        resolvedQuery: "What does the selected document say about the renewal term?",
        text: "The renewal term is twelve months. [Source 1]",
      },
      {
        abstained: false,
        citations: [
          {
            docId: "doc-1",
            excerpt:
              "Auto-renewal requires notice before the deadline. Secret risk evidence should stay out of task memory.",
            fileName: "contract.pdf",
            pageNumber: 4,
          },
        ],
        memoryApplied: false,
        resolvedQuery: "What renewal risk does the selected document describe?",
        text: "Renewal risk is low because auto-renewal requires notice. [Source 1]",
      },
    ],
  });
  const firstRunner = createRealAgentTaskRunner({
    agentRunService: firstAgentRunService,
    ragService,
  });

  await firstTaskService.upsertTask({
    accessScope,
    task: {
      id: taskId,
      input: {
        docIds: ["doc-1"],
        maxIterations: 3,
        question: "What does the selected document say about the renewal term?",
        sessionId: "session-1",
        userPreferences: ["Use concise bullets."],
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: ["doc-1"],
        iterations: [],
        maxIterations: 3,
        question: "What does the selected document say about the renewal term?",
        sessionId: "session-1",
        taskMemory: buildAgentTaskPlanningContext({
          goal: "What does the selected document say about the renewal term?",
          nextCandidates: [
            "What renewal risk does the selected document describe?",
          ],
          userPreferences: ["Use concise bullets."],
        }),
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.running,
      type: AGENT_TASK_TYPE,
    },
  });

  const taskBeforeRestart = await firstTaskService.getInternalTask({
    accessScope,
    taskId,
  });

  await assert.rejects(
    firstRunner.run({
      accessScope,
      patchTask: async (patch) => {
        await firstTaskService.patchTask({
          accessScope,
          patch,
          taskId,
        });

        if (patch.payload?.iterations?.length === 1) {
          throw new Error("Simulated process restart after persisted real run.");
        }
      },
      task: taskBeforeRestart,
    }),
    /Simulated process restart/
  );

  const persistedTask = await firstTaskService.getInternalTask({
    accessScope,
    taskId,
  });
  const firstRunId = persistedTask.payload.iterations[0]?.agentRunId;
  const firstRunBeforeRecovery = await firstAgentRunService.getRun({
    accessScope,
    runId: firstRunId,
  });
  const firstDocumentStep = firstRunBeforeRecovery.steps.find(
    (step) => step.id === "document_rag:primary"
  );

  assert.equal(persistedTask.status, TASK_STATUSES.running);
  assert.equal(
    persistedTask.payload.nextQuestion,
    "What renewal risk does the selected document describe?"
  );
  assert.equal(persistedTask.payload.taskMemory.evidencePolicy, "planning_context_only");
  assert.doesNotMatch(
    JSON.stringify(persistedTask.payload.taskMemory),
    /Secret renewal evidence|Secret risk evidence/
  );
  assert.equal(firstRunBeforeRecovery.status, AGENT_RUN_STATUSES.completed);
  assert.equal(firstDocumentStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(
    firstDocumentStep.input.question,
    "What does the selected document say about the renewal term?"
  );

  const restartedTaskService = taskHarness.createService({
    now: () => "2026-06-23T00:20:00.000Z",
  });
  const restartedAgentRunService = runHarness.createService({
    now: () => "2026-06-23T00:20:00.000Z",
  });
  const restartedRunner = createRealAgentTaskRunner({
    agentRunService: restartedAgentRunService,
    ragService,
  });
  const scheduledRuns = [];
  const restartedOrchestrator = createJobOrchestrator({
    runners: {
      [restartedRunner.id]: restartedRunner,
    },
    schedule: (work) => scheduledRuns.push(work),
    taskService: restartedTaskService,
  });

  const recovery = await restartedOrchestrator.recoverRunnableTasks();

  assert.equal(recovery.scheduledCount, 1);
  assert.equal(scheduledRuns.length, 1);

  await scheduledRuns[0]();

  const recoveredTask = await restartedTaskService.getInternalTask({
    accessScope,
    taskId,
  });
  const iterationRunIds = recoveredTask.payload.iterations.map(
    (iteration) => iteration.agentRunId
  );
  const firstRunAfterRecovery = await restartedAgentRunService.getRun({
    accessScope,
    runId: iterationRunIds[0],
  });
  const secondRun = await restartedAgentRunService.getRun({
    accessScope,
    runId: iterationRunIds[1],
  });

  assert.equal(recoveredTask.status, TASK_STATUSES.completed);
  assert.equal(recoveredTask.counts.iterations, 2);
  assert.equal(recoveredTask.counts.agentRuns, 2);
  assert.equal(new Set(iterationRunIds).size, 2);
  assert.deepEqual(
    recoveredTask.payload.iterations.map((iteration) => iteration.question),
    [
      "What does the selected document say about the renewal term?",
      "What renewal risk does the selected document describe?",
    ]
  );
  assert.deepEqual(
    ragCalls.map((call) => call.question),
    [
      "What does the selected document say about the renewal term?",
      "What renewal risk does the selected document describe?",
    ]
  );
  assert.equal(
    firstRunAfterRecovery.steps.filter((step) => step.id === "document_rag:primary")
      .length,
    1
  );
  assert.equal(
    firstRunAfterRecovery.steps.find((step) => step.id === "document_rag:primary")
      .input.question,
    "What does the selected document say about the renewal term?"
  );
  assert.equal(
    secondRun.steps.find((step) => step.id === "document_rag:primary").input.question,
    "What renewal risk does the selected document describe?"
  );
  assert.equal(secondRun.status, AGENT_RUN_STATUSES.completed);
  assert.equal(recoveredTask.result.taskMemory.evidencePolicy, "planning_context_only");
  assert.doesNotMatch(
    JSON.stringify(recoveredTask.result.taskMemory),
    /Secret renewal evidence|Secret risk evidence/
  );
});

test("postgres-backed agent task approval resumes the paused question after restart", async () => {
  const calls = [];
  const harness = createFakePostgresTaskHarness();
  const firstService = harness.createService();
  const taskId = "agent_goal:approval-restart";
  const firstRunner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          status: 200,
          body: {
            agentAnswer: "Need an approved web lookup.",
            agentMode: "planner",
            agentRunId: "run-approval-restart",
            agentTask: {
              continue: true,
              nextQuestion: "Search the web for renewal updates.",
            },
            clarification: {
              needed: false,
            },
          },
        };
      }

      return {
        status: 200,
        body: {
          agentAnswer: "Approve Web Search?",
          agentMode: "clarification",
          agentRunId: "run-approval-restart",
          approvalGates: [
            {
              capabilityId: "web.search",
              id: "approval:web.search:1.0.0",
              status: "pending",
            },
          ],
          clarification: {
            detail: {
              approvalGates: [
                {
                  capabilityId: "web.search",
                  id: "approval:web.search:1.0.0",
                  status: "pending",
                },
              ],
            },
            needed: true,
            question: "Approve Web Search?",
            reason: "capability_approval_required",
          },
        },
      };
    },
  });
  const firstOrchestrator = createJobOrchestrator({
    runners: {
      [firstRunner.id]: firstRunner,
    },
    taskService: firstService,
  });

  await firstService.upsertTask({
    accessScope,
    task: {
      id: taskId,
      input: {
        docIds: ["doc-1"],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: ["doc-1"],
        iterations: [],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });

  await firstOrchestrator.runTask({
    accessScope,
    taskId,
  });

  const waitingTask = await firstService.getInternalTask({
    accessScope,
    taskId,
  });

  assert.equal(waitingTask.status, TASK_STATUSES.waitingForUser);
  assert.equal(waitingTask.requiredUserAction, "approve_capability");
  assert.equal(waitingTask.payload.agentRunId, "run-approval-restart");
  assert.equal(waitingTask.payload.lastQuestion, "Search the web for renewal updates.");
  assert.equal(waitingTask.payload.pending.approvalGates[0].id, "approval:web.search:1.0.0");

  const restartedService = harness.createService({
    now: () => "2026-06-23T00:10:00.000Z",
  });
  const restartedRunner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      return {
        status: 200,
        body: {
          agentAnswer: "Renewal answer with approved web evidence.",
          agentMode: "web",
          agentRunId: "run-approval-restart",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const restartedOrchestrator = createJobOrchestrator({
    runners: {
      [restartedRunner.id]: restartedRunner,
    },
    taskService: restartedService,
  });

  await restartedOrchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.approve,
    payload: {
      approval: {
        approved: true,
        decision: "approved",
        source: "task_action",
      },
      capabilityId: "web.search",
    },
    runImmediately: false,
    taskId,
  });
  await restartedOrchestrator.runTask({
    accessScope,
    taskId,
  });

  const approvedTask = await restartedService.getInternalTask({
    accessScope,
    taskId,
  });

  assert.equal(approvedTask.status, TASK_STATUSES.completed);
  assert.equal(approvedTask.result.agentRunId, "run-approval-restart");
  assert.deepEqual(
    calls.map((call) => call.question),
    [
      "Summarize renewal terms.",
      "Search the web for renewal updates.",
      "Search the web for renewal updates.",
    ]
  );
  assert.equal(calls[2].agentRunId, "run-approval-restart");
  assert.deepEqual(calls[2].capabilityApprovals, {
    "web.search": {
      approved: true,
      decision: "approved",
      source: "task_action",
    },
  });
  assert.deepEqual(
    approvedTask.payload.iterations.map((iteration) => iteration.question),
    [
      "Summarize renewal terms.",
      "Search the web for renewal updates.",
      "Search the web for renewal updates.",
    ]
  );
});

test("postgres-backed agent task retry resumes the failed question after restart", async () => {
  const calls = [];
  const harness = createFakePostgresTaskHarness();
  const firstService = harness.createService();
  const taskId = "agent_goal:failed-restart";
  const firstRunner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          status: 200,
          body: {
            agentAnswer: "Renewal terms found.",
            agentMode: "document",
            agentRunId: "run-failed-restart",
            agentTask: {
              continue: true,
              nextQuestion: "Check renewal risk.",
            },
            clarification: {
              needed: false,
            },
          },
        };
      }

      return {
        status: 502,
        body: {
          agentMode: "document",
          agentRunId: "run-failed-restart",
          error: "Transient risk check failure.",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const firstOrchestrator = createJobOrchestrator({
    runners: {
      [firstRunner.id]: firstRunner,
    },
    taskService: firstService,
  });

  await firstService.upsertTask({
    accessScope,
    task: {
      id: taskId,
      input: {
        docIds: ["doc-1"],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: ["doc-1"],
        iterations: [],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });

  await firstOrchestrator.runTask({
    accessScope,
    taskId,
  });

  const failedTask = await firstService.getInternalTask({
    accessScope,
    taskId,
  });

  assert.equal(failedTask.status, TASK_STATUSES.failed);
  assert.equal(failedTask.payload.agentRunId, "run-failed-restart");
  assert.equal(failedTask.payload.lastQuestion, "Check renewal risk.");
  assert.deepEqual(
    failedTask.payload.iterations.map((iteration) => iteration.question),
    ["Summarize renewal terms.", "Check renewal risk."]
  );

  const restartedService = harness.createService({
    now: () => "2026-06-23T00:15:00.000Z",
  });
  const restartedRunner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      return {
        status: 200,
        body: {
          agentAnswer: "Renewal risk checked after retry.",
          agentMode: "document",
          agentRunId: "run-failed-restart",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const restartedOrchestrator = createJobOrchestrator({
    runners: {
      [restartedRunner.id]: restartedRunner,
    },
    taskService: restartedService,
  });

  await restartedOrchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.continue,
    payload: {},
    runImmediately: false,
    taskId,
  });
  await restartedOrchestrator.runTask({
    accessScope,
    taskId,
  });

  const retriedTask = await restartedService.getInternalTask({
    accessScope,
    taskId,
  });

  assert.equal(retriedTask.status, TASK_STATUSES.completed);
  assert.equal(retriedTask.result.agentRunId, "run-failed-restart");
  assert.deepEqual(
    calls.map((call) => call.question),
    [
      "Summarize renewal terms.",
      "Check renewal risk.",
      "Check renewal risk.",
    ]
  );
  assert.deepEqual(
    retriedTask.payload.iterations.map((iteration) => iteration.question),
    [
      "Summarize renewal terms.",
      "Check renewal risk.",
      "Check renewal risk.",
    ]
  );
  assert.equal(retriedTask.result.answer, "Renewal risk checked after retry.");
});

test("agent task runner continues until blocked and resumes with preserved run context", async () => {
  const calls = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const runner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          status: 200,
          body: {
            agentAnswer: "Need an approved web lookup.",
            agentMode: "planner",
            agentRunId: "run-1",
            agentTask: {
              continue: true,
              nextQuestion: "Search the web for renewal updates.",
            },
            clarification: {
              needed: false,
            },
          },
        };
      }

      if (calls.length === 2) {
        return {
          status: 200,
          body: {
            agentAnswer: "Approve Web Search?",
            agentMode: "clarification",
            agentRunId: "run-1",
            approvalGates: [
              {
                capabilityId: "web.search",
                id: "approval:web.search:1.0.0",
                status: "pending",
              },
            ],
            clarification: {
              detail: {
                approvalGates: [
                  {
                    capabilityId: "web.search",
                    id: "approval:web.search:1.0.0",
                    status: "pending",
                  },
                ],
              },
              needed: true,
              question: "Approve Web Search?",
              reason: "capability_approval_required",
            },
          },
        };
      }

      return {
        status: 200,
        body: {
          agentAnswer: "Renewal answer with approved web evidence.",
          agentMode: "web",
          agentRunId: "run-1",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [runner.id]: runner,
    },
    taskService,
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "agent_goal:task-1",
      input: {
        docIds: ["doc-1"],
        maxIterations: 3,
        question: "Summarize the renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: ["doc-1"],
        iterations: [],
        maxIterations: 3,
        question: "Summarize the renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  let task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.requiredUserAction, "approve_capability");
  assert.equal(task.payload.agentRunId, "run-1");
  assert.equal(task.payload.iterations.length, 2);
  assert.deepEqual(
    task.items.map((item) => [item.id, item.status]),
    [
      ["goal", TASK_STATUSES.completed],
      ["iteration-1", TASK_STATUSES.completed],
      ["iteration-2", TASK_STATUSES.waitingForUser],
      ["user-input", TASK_STATUSES.waitingForUser],
      ["deliverable", TASK_STATUSES.waitingForUser],
    ]
  );
  assert.equal(task.result.goalPlan.requiredUserAction, "approve_capability");
  assert.deepEqual(
    calls.map((call) => call.question),
    [
      "Summarize the renewal terms.",
      "Search the web for renewal updates.",
    ]
  );

  await orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.approve,
    payload: {
      approval: {
        approved: true,
        decision: "approved",
        source: "task_action",
      },
      capabilityId: "web.search",
    },
    runImmediately: false,
    taskId: "agent_goal:task-1",
  });
  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  assert.equal(task.status, TASK_STATUSES.completed);
  assert.equal(task.counts.iterations, 3);
  assert.equal(task.result.answer, "Renewal answer with approved web evidence.");
  assert.equal(task.result.agentRunId, "run-1");
  assert.equal(task.result.goalPlan.status, TASK_STATUSES.completed);
  assert.equal(task.items.at(-1).id, "deliverable");
  assert.equal(task.items.at(-1).status, TASK_STATUSES.completed);
  assert.equal(calls[2].agentRunId, "run-1");
  assert.deepEqual(calls[2].capabilityApprovals, {
    "web.search": {
      approved: true,
      decision: "approved",
      source: "task_action",
    },
  });
});

test("agent task runner persists task memory as planning-only context", async () => {
  const calls = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const runner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          status: 200,
          body: {
            agentAnswer: "Renewal terms found.",
            agentMode: "document",
            agentRunId: "run-memory",
            agentTask: {
              continue: true,
              nextCandidates: ["Check renewal risk."],
              nextQuestion: "Check renewal risk.",
              userPreferences: ["Keep risk notes short."],
            },
            clarification: {
              needed: false,
            },
            ragSources: [
              {
                docId: "doc-1",
                excerpt: "Secret evidence should not be copied into task memory.",
              },
            ],
          },
        };
      }

      return {
        status: 200,
        body: {
          agentAnswer: "No renewal risk found.",
          agentMode: "document",
          agentRunId: "run-memory",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [runner.id]: runner,
    },
    taskService,
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "agent_goal:memory",
      input: {
        docIds: ["doc-1"],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        userPreferences: ["Use concise bullets."],
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: ["doc-1"],
        iterations: [],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        taskMemory: buildAgentTaskPlanningContext({
          goal: "Summarize renewal terms.",
          userPreferences: ["Use concise bullets."],
        }),
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:memory",
  });

  const task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:memory",
  });

  assert.equal(task.status, TASK_STATUSES.completed);
  assert.equal(calls[0].taskMemory.goal, "Summarize renewal terms.");
  assert.equal(calls[0].taskMemory.evidencePolicy, "planning_context_only");
  assert.deepEqual(calls[0].taskMemory.userPreferences, ["Use concise bullets."]);
  assert.equal(calls[1].taskMemory.completedSteps[0].question, "Summarize renewal terms.");
  assert.equal(calls[1].taskMemory.completedSteps[0].agentMode, "document");
  assert.equal(calls[1].taskMemory.completedSteps[0].answer, "Renewal terms found.");
  assert.deepEqual(calls[1].taskMemory.nextCandidates, ["Check renewal risk."]);
  assert.deepEqual(calls[1].taskMemory.userPreferences, [
    "Use concise bullets.",
    "Keep risk notes short.",
  ]);
  assert.doesNotMatch(
    JSON.stringify(task.payload.taskMemory),
    /Secret evidence should not be copied/
  );
  assert.equal(task.result.taskMemory.evidencePolicy, "planning_context_only");
});

test("agent task runner can continue after iteration budget is exhausted", async () => {
  const calls = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const runner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          status: 200,
          body: {
            agentAnswer: "Need one more iteration.",
            agentMode: "planner",
            agentRunId: "run-budget",
            agentTask: {
              continue: true,
              nextQuestion: "Finish the second step.",
            },
            clarification: {
              needed: false,
            },
          },
        };
      }

      return {
        status: 200,
        body: {
          agentAnswer: "Finished after user continuation.",
          agentMode: "document",
          agentRunId: "run-budget",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [runner.id]: runner,
    },
    taskService,
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "agent_goal:budget",
      input: {
        docIds: [],
        maxIterations: 1,
        question: "Run two steps.",
        sessionId: "session-1",
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: [],
        iterations: [],
        maxIterations: 1,
        question: "Run two steps.",
        sessionId: "session-1",
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:budget",
  });

  let task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:budget",
  });

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.requiredUserAction, "continue_task");
  assert.equal(task.payload.pending.reason, "iteration_budget_exhausted");

  await orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.continue,
    payload: {},
    runImmediately: false,
    taskId: "agent_goal:budget",
  });
  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:budget",
  });

  task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:budget",
  });

  assert.equal(task.status, TASK_STATUSES.completed);
  assert.equal(task.result.answer, "Finished after user continuation.");
  assert.deepEqual(
    calls.map((call) => call.question),
    ["Run two steps.", "Finish the second step."]
  );
});
