import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import { runAgentRag } from "../rag/agent.js";
import {
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { AGENT_TASK_ACTIONS, AGENT_TASK_RUNNER_ID, AGENT_TASK_TYPE, createAgentTaskRunner } from "../rag/agent-tasks.js";
import {
  AGENT_RUN_SETTLED_GRAPH_REENTRY_CODE,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import { TASK_STATUSES, createInMemoryTaskStore, createTaskService } from "../rag/tasks.js";

// A request that continues a run that is settled (it ended, or its
// custom-Skill graph was finalized as a question for the user) gets a new
// run: the run state machine never reopens an ended run, and a run that holds
// a graph checkpoint is otherwise fenced. The user chose this on 2026-11-16
// ("A: new run"). Before it, every such continuation failed: an ended run with
// 409 "Invalid agent run status transition", one holding a custom-Skill
// checkpoint with 409 AGENT_GRAPH_EXECUTION_FENCED. A background task's
// `continue` after its iteration budget always continues the run its last
// iteration ended, so the task card's Continue failed for every task.

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const DOCS = ["doc-a", "doc-b"];
const CHAIN_QUESTION = "Review the contract risks and compare the two documents";

const ENV = Object.freeze({
  AGENT_PLANNER_ROLLOUT: "deterministic",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

const withEnv = async (callback) => {
  const previous = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));

  Object.assign(process.env, ENV);

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const createRagService = () => ({
  chat: async (docIds) => ({
    abstained: false,
    citations: [{ docId: docIds[0], excerpt: "Clause 4 caps liability at fees paid.", fileName: `${docIds[0]}.pdf`, pageNumber: 1 }],
    text: "Clause 4 caps liability at fees paid. [Source 1]",
  }),
  getDocument: (docId) => (DOCS.includes(docId) ? { docId, fileName: `${docId}.pdf` } : null),
  listDocuments: () => DOCS.map((docId) => ({ docId, fileName: `${docId}.pdf` })),
});

const createHarness = () => {
  const store = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore: store });
  const webCalls = [];
  const ragService = createRagService();
  const taskService = createTaskService({ taskStore: createInMemoryTaskStore() });
  const runner = createAgentTaskRunner({
    goalDeliverableService: {
      execute: async () => {
        throw new Error("no goal deliverable is requested");
      },
      prepare: async () => ({ specs: [], status: "not_requested" }),
    },
    runAgentTask: (request) =>
      runAgentRag({
        ...request,
        agentRunService,
        ragService,
        webChatService: async (question) => {
          webCalls.push(question);
          return { citations: [], text: `Web answer for: ${question}` };
        },
      }),
  });
  const orchestrator = createJobOrchestrator({ runners: { [runner.id]: runner }, taskService });

  return { agentRunService, orchestrator, ragService, store, taskService, webCalls };
};

// A task with an iteration budget of one and a next step left: its first
// iteration ends a run and the task stops at the budget, waiting for Continue.
const runTaskToItsBudget = async (harness, { docIds, question }) => {
  const taskId = "agent_goal:budget";

  await harness.taskService.upsertTask({
    accessScope,
    task: {
      id: taskId,
      input: { docIds, maxIterations: 1, question, sessionId: "budget-session", userId: accessScope.userId },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds,
        iterations: [],
        maxIterations: 1,
        question,
        sessionId: "budget-session",
        taskMemory: { goal: question, nextCandidates: ["Summarize what is still open"] },
        userId: accessScope.userId,
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });
  await harness.orchestrator.runTask({ accessScope, taskId });

  return harness.taskService.getInternalTask({ accessScope, taskId });
};

const continueTask = async (harness, taskId) => {
  await harness.orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.continue,
    payload: {},
    runImmediately: false,
    taskId,
  });
  await harness.orchestrator.runTask({ accessScope, taskId });

  return harness.taskService.getInternalTask({ accessScope, taskId });
};

for (const { docIds, label, question } of [
  { docIds: [], label: "a plain run", question: "List the uploaded documents" },
  { docIds: DOCS, label: "a run whose custom-Skill graph completed", question: CHAIN_QUESTION },
]) {
  test(`Continue after the iteration budget starts a new run after ${label}`, async () => {
    await withEnv(async () => {
      const harness = createHarness();
      const stopped = await runTaskToItsBudget(harness, { docIds, question });
      const firstRunId = stopped.payload.agentRunId;
      const firstRun = await harness.store.get({ accessScope, runId: firstRunId });

      assert.equal(stopped.status, TASK_STATUSES.waitingForUser);
      assert.equal(stopped.payload.pending?.reason, "iteration_budget_exhausted");
      assert.equal(firstRun.status, "completed");
      assert.equal(Boolean(firstRun.result?.__skillGraphCheckpoint), docIds.length > 0);

      const continued = await continueTask(harness, stopped.id);
      const runs = await harness.store.list({ accessScope });
      const newRun = runs.find((run) => run.runId !== firstRunId);

      assert.equal(continued.error ?? null, null);
      assert.notEqual(continued.status, TASK_STATUSES.failed);
      assert.equal(runs.length, 2);
      assert.equal(continued.payload.agentRunId, newRun.runId);
      assert.deepEqual(
        newRun.events.filter((event) => event.type === "run_continued").map((event) => event.payload),
        [{ previousRunId: firstRunId, reason: "run_ended" }]
      );
      // The ended run is left as it was.
      assert.deepEqual(await harness.store.get({ accessScope, runId: firstRunId }), firstRun);
    });
  });
}

// What each stored state gets, decided by the run store in the same CAS as the
// fence (updateRun with graphReentryGuard).
test("the run store continues a settled run as a new run and keeps fencing an open graph", async () => {
  const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const goal = "Compare the two documents.";
  const graphCheckpoint = (phase) =>
    updateExecutionGraphCheckpoint(
      createExecutionGraphCheckpoint({
        graph: { nodes: [{ nodeId: "compare", skillId: "compare_documents" }], revision: 0, version: "v1" },
        owner: buildExecutionGraphCheckpointOwner({
          accessScope,
          budgetState: createAgentBudget(),
          docIds: DOCS,
          question: goal,
          selectedSkills: [],
        }),
      }),
      { phase }
    );
  const pendingGate = {
    approvalObjectHash: `sha256:${"a".repeat(64)}`,
    capabilityId: "web.search",
    id: "approval:web.search:1.0.0:a",
    status: "pending",
  };
  let counter = 0;
  const seed = async ({ approvalGates = [], checkpoint = null, recovery = null, status }) => {
    counter += 1;
    const runId = `settled-${counter}`;

    await agentRunService.createRun({ accessScope, goal, runId, status: "running" });
    if (checkpoint) {
      await agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });
    }
    await agentRunService.updateRun({
      accessScope,
      patch: {
        approvalGates,
        status,
        ...(recovery ? { result: { recovery } } : {}),
      },
      runId,
    });
    return runId;
  };
  const reenter = async (runId) => {
    const before = await agentRunService.getRun({ accessScope, runId });

    try {
      await agentRunService.updateRun({
        accessScope,
        graphReentryGuard: true,
        patch: { goal, status: "running" },
        runId,
      });
    } catch (error) {
      assert.deepEqual(await agentRunService.getRun({ accessScope, runId }), before, runId);
      return error.code === AGENT_RUN_SETTLED_GRAPH_REENTRY_CODE
        ? `new run: ${error.reentryReason}`
        : `refused: ${error.code ?? error.message}`;
    }

    return "re-entered";
  };

  const outcomes = {};
  for (const status of ["completed", "failed", "canceled"]) {
    outcomes[`${status}, no graph`] = await reenter(await seed({ status }));
    outcomes[`${status}, settled graph`] = await reenter(
      await seed({ checkpoint: graphCheckpoint("completed"), status })
    );
  }
  outcomes["waiting, no graph"] = await reenter(await seed({ status: "waiting_for_user" }));
  outcomes["waiting, graph completed, nothing open"] = await reenter(
    await seed({ checkpoint: graphCheckpoint("completed"), status: "waiting_for_user" })
  );
  outcomes["waiting, graph partial, nothing open"] = await reenter(
    await seed({ checkpoint: graphCheckpoint("partial"), status: "waiting_for_user" })
  );
  outcomes["waiting, graph completed, listed for an operator while waiting"] = await reenter(
    await seed({
      checkpoint: graphCheckpoint("completed"),
      recovery: { mode: "manual", originalStatus: "waiting_for_user", reason: "graph_finalization_requires_recovery" },
      status: "waiting_for_user",
    })
  );
  outcomes["waiting, graph completed, handed over from running"] = await reenter(
    await seed({
      checkpoint: graphCheckpoint("completed"),
      recovery: { mode: "manual", originalStatus: "running", reason: "graph_finalization_requires_recovery" },
      status: "waiting_for_user",
    })
  );
  outcomes["waiting, graph completed, at an approval gate"] = await reenter(
    await seed({ approvalGates: [pendingGate], checkpoint: graphCheckpoint("completed"), status: "waiting_for_user" })
  );
  outcomes["running, graph running"] = await reenter(
    await seed({ checkpoint: graphCheckpoint("running"), status: "running" })
  );
  outcomes["running, graph completed"] = await reenter(
    await seed({ checkpoint: graphCheckpoint("completed"), status: "running" })
  );

  assert.deepEqual(outcomes, {
    "completed, no graph": "new run: run_ended",
    "completed, settled graph": "new run: run_ended",
    "failed, no graph": "new run: run_ended",
    "failed, settled graph": "new run: run_ended",
    "canceled, no graph": "new run: run_ended",
    "canceled, settled graph": "new run: run_ended",
    "waiting, no graph": "re-entered",
    "waiting, graph completed, nothing open": "new run: graph_finalized_as_question",
    "waiting, graph partial, nothing open": "new run: graph_finalized_as_question",
    "waiting, graph completed, listed for an operator while waiting": "new run: graph_finalized_as_question",
    "waiting, graph completed, handed over from running": "refused: AGENT_GRAPH_EXECUTION_FENCED",
    "waiting, graph completed, at an approval gate": "refused: AGENT_GRAPH_EXECUTION_FENCED",
    "running, graph running": "refused: AGENT_GRAPH_EXECUTION_FENCED",
    "running, graph completed": "refused: AGENT_GRAPH_EXECUTION_FENCED",
  });
});

// A request carries no approvals. One that continues a run that has ended
// starts a new run, and the new run asks at its own gate. (A task's approval
// of a run that has ended goes through the run's approval path and is refused
// there: agent-task-approval-reentry.test.mjs.)
test("a request that continues a run that has ended starts a new run, which asks at its own gate", async () => {
  await withEnv(async () => {
    const harness = createHarness();
    const question = "Search the web for the current launch date";
    const paused = await runAgentRag({
      accessScope,
      agentRunService: harness.agentRunService,
      docIds: [],
      question,
      ragService: harness.ragService,
      userId: accessScope.userId,
      webChatService: async () => {
        throw new Error("the Capability must not run before approval");
      },
    });
    const runId = paused.body.agentRunId;

    await harness.agentRunService.failRun({
      accessScope,
      error: new Error("Canceled by the user."),
      runId,
      status: "canceled",
    });

    const continued = await runAgentRag({
      accessScope,
      agentRunId: runId,
      agentRunService: harness.agentRunService,
      docIds: [],
      question,
      ragService: harness.ragService,
      userId: accessScope.userId,
      webChatService: async () => {
        throw new Error("the Capability must not run before its new gate is decided");
      },
    });
    const newRun = await harness.agentRunService.getRun({ accessScope, runId: continued.body.agentRunId });

    assert.notEqual(continued.body.agentRunId, runId);
    assert.equal(continued.body.clarification?.reason, "capability_approval_required");
    assert.equal(newRun.status, "waiting_for_user");
    assert.deepEqual(newRun.approvalGates.map((entry) => entry.status), ["pending"]);
    assert.deepEqual(
      newRun.events.filter((event) => event.type === "run_continued").map((event) => event.payload),
      [{ previousRunId: runId, reason: "run_ended" }]
    );
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "canceled");
  });
});
