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
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import { TASK_STATUSES, createInMemoryTaskStore, createTaskService } from "../rag/tasks.js";

// A request that names a run (a background task's `continue`) gets a new run,
// whatever state the named run is in, and the named run is left as it is; the
// new run's run_continued event points at it. The user chose this for a
// settled run (it ended, or its custom-Skill graph was finalized as a question
// for the user) on 2026-11-16 ("A: new run"), and for every run on 2026-11-17.
// Before the first, every continuation of a settled run failed: an ended run
// with 409 "Invalid agent run status transition", one holding a custom-Skill
// checkpoint with 409 AGENT_GRAPH_EXECUTION_FENCED, so the task card's
// Continue after the iteration budget failed for every task. Before the
// second, any other run was re-entered in place, which failed once a step of
// it had completed (409 "Invalid agent run step status transition") or it
// held a graph checkpoint (409 AGENT_GRAPH_EXECUTION_FENCED).

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

// A task with an iteration budget of one (unless given another) and a next
// step left: its first iteration ends a run and the task stops at the budget,
// waiting for Continue, or earlier at a question for the user.
const runTaskToItsBudget = async (harness, { docIds, maxIterations = 1, question }) => {
  const taskId = "agent_goal:budget";

  await harness.taskService.upsertTask({
    accessScope,
    task: {
      id: taskId,
      input: { docIds, maxIterations, question, sessionId: "budget-session", userId: accessScope.userId },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds,
        iterations: [],
        maxIterations,
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

const continueTask = async (harness, taskId, payload = {}) => {
  await harness.orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.continue,
    payload,
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
        [{ previousRunId: firstRunId }]
      );
      // The ended run is left as it was.
      assert.deepEqual(await harness.store.get({ accessScope, runId: firstRunId }), firstRun);
    });
  });
}

// What a request that names a run gets, for each state the named run can be in.
test("a request that names a run starts a new run whatever that run's state, and leaves it as it was", async () => {
  const store = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore: store });
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
  const continueRun = async (runId) => {
    const before = await store.get({ accessScope, runId });
    const response = await withEnv(() =>
      runAgentRag({
        accessScope,
        agentRunId: runId,
        agentRunService,
        docIds: [],
        question: "List the uploaded documents",
        ragService: createRagService(),
        userId: accessScope.userId,
      })
    );
    const newRun = await store.get({ accessScope, runId: response.body.agentRunId });

    assert.deepEqual(await store.get({ accessScope, runId }), before, runId);
    assert.deepEqual(
      newRun.events.filter((event) => event.type === "run_continued").map((event) => event.payload),
      [{ previousRunId: runId }],
      runId
    );
    return newRun.runId === runId ? "re-entered" : `new run: ${newRun.status}`;
  };

  const outcomes = {};
  for (const status of ["completed", "failed", "canceled"]) {
    outcomes[`${status}, no graph`] = await continueRun(await seed({ status }));
    outcomes[`${status}, settled graph`] = await continueRun(
      await seed({ checkpoint: graphCheckpoint("completed"), status })
    );
  }
  outcomes["waiting, no graph"] = await continueRun(await seed({ status: "waiting_for_user" }));
  outcomes["waiting, graph completed, nothing open"] = await continueRun(
    await seed({ checkpoint: graphCheckpoint("completed"), status: "waiting_for_user" })
  );
  outcomes["waiting, graph partial, nothing open"] = await continueRun(
    await seed({ checkpoint: graphCheckpoint("partial"), status: "waiting_for_user" })
  );
  outcomes["waiting, graph completed, listed for an operator while waiting"] = await continueRun(
    await seed({
      checkpoint: graphCheckpoint("completed"),
      recovery: { mode: "manual", originalStatus: "waiting_for_user", reason: "graph_finalization_requires_recovery" },
      status: "waiting_for_user",
    })
  );
  outcomes["waiting, graph completed, handed over from running"] = await continueRun(
    await seed({
      checkpoint: graphCheckpoint("completed"),
      recovery: { mode: "manual", originalStatus: "running", reason: "graph_finalization_requires_recovery" },
      status: "waiting_for_user",
    })
  );
  outcomes["waiting, graph completed, at an approval gate"] = await continueRun(
    await seed({ approvalGates: [pendingGate], checkpoint: graphCheckpoint("completed"), status: "waiting_for_user" })
  );
  outcomes["running, graph running"] = await continueRun(
    await seed({ checkpoint: graphCheckpoint("running"), status: "running" })
  );
  outcomes["running, graph completed"] = await continueRun(
    await seed({ checkpoint: graphCheckpoint("completed"), status: "running" })
  );

  assert.deepEqual(outcomes, {
    "completed, no graph": "new run: completed",
    "completed, settled graph": "new run: completed",
    "failed, no graph": "new run: completed",
    "failed, settled graph": "new run: completed",
    "canceled, no graph": "new run: completed",
    "canceled, settled graph": "new run: completed",
    "waiting, no graph": "new run: completed",
    "waiting, graph completed, nothing open": "new run: completed",
    "waiting, graph partial, nothing open": "new run: completed",
    "waiting, graph completed, listed for an operator while waiting": "new run: completed",
    "waiting, graph completed, handed over from running": "new run: completed",
    "waiting, graph completed, at an approval gate": "new run: completed",
    "running, graph running": "new run: completed",
    "running, graph completed": "new run: completed",
  });
});

// A task whose run stopped at a Web gate after its document step completed.
// The user continues it with a new question instead of approving, and a new
// run answers it. The request used to re-enter the waiting run, start its
// completed document step again and fail the task with 409 "Invalid agent run
// step status transition: completed -> running."
test("Continue with a new question after a completed document step answers in a new run", async () => {
  await withEnv(async () => {
    const harness = createHarness();
    const paused = await runTaskToItsBudget(harness, {
      docIds: ["doc-a"],
      maxIterations: 3,
      question: "What is the latest notice period for renewal?",
    });
    const pausedRunId = paused.payload.agentRunId;
    const pausedRun = await harness.store.get({ accessScope, runId: pausedRunId });

    assert.equal(paused.requiredUserAction, "approve_capability");
    assert.equal(pausedRun.status, "waiting_for_user");
    assert.equal(pausedRun.steps.find((step) => step.id === "document_rag:primary")?.status, "completed");

    const continued = await continueTask(harness, paused.id, {
      question: "What does clause 4 say about liability?",
    });

    assert.deepEqual(
      { error: continued.error ?? null, status: continued.status },
      { error: null, status: TASK_STATUSES.completed }
    );

    // The second iteration answers the new question; a third takes the task's
    // next step in a run of its own.
    const answered = continued.payload.iterations[1];
    const newRun = await harness.store.get({ accessScope, runId: answered.agentRunId });

    assert.equal(answered.question, "What does clause 4 say about liability?");
    assert.equal(answered.answer, "Clause 4 caps liability at fees paid. [Source 1]");
    assert.notEqual(newRun.runId, pausedRunId);
    assert.equal(newRun.status, "completed");
    assert.deepEqual(
      newRun.events.filter((event) => event.type === "run_continued").map((event) => event.payload),
      [{ previousRunId: pausedRunId }]
    );
    // The waiting run is left as it was, still at its gate.
    assert.deepEqual(await harness.store.get({ accessScope, runId: pausedRunId }), pausedRun);
    assert.deepEqual(harness.webCalls, []);
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
      [{ previousRunId: runId }]
    );
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "canceled");
  });
});
