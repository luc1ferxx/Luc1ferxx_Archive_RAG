import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import { runAgentRag } from "../rag/agent.js";
import {
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import { createDocumentRagStepExecutor } from "../rag/agent-run-step-handlers/document-steps.js";
import { createResearchQuestionStepExecutor } from "../rag/agent-run-step-handlers/research-steps.js";
import {
  AGENT_TASK_ACTIONS,
  createAgentTaskIterationRunner,
  createAgentTaskRunner,
  createAgentTaskService,
} from "../rag/agent-tasks.js";
import { createAgentRunService, createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { createApprovalExecutionSnapshot } from "../rag/capabilities/approval-execution-snapshot.js";
import { createDefaultCapabilityRegistry } from "../rag/capabilities/index.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import { throwIfRequestCancelled } from "../rag/request-deadline.js";
import { createInMemoryTaskStore, createTaskService } from "../rag/tasks.js";

// A background task that a Capability approval gate paused, approved through
// the task (POST /tasks/:taskId/actions/approve; the Approve button of the
// task card), end to end through the real agent and the real step executor,
// wired as app-services.js wires them (createAgentTaskIterationRunner). The
// task's approval decides the gate on the paused run through the chat page's
// approval path: nothing is planned again. The other task-approval tests stub
// the agent.

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const DOCS = ["doc-a", "doc-b"];
const WEB_QUESTION = "Search the web for the current launch date";

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

const createRagService = () => {
  const calls = [];

  return {
    calls,
    chat: async (docIds, question) => {
      calls.push(question);
      return {
        abstained: false,
        citations: [{ docId: docIds[0], excerpt: "The vendor requires 30 days written notice before renewal.", fileName: `${docIds[0]}.pdf`, pageNumber: 2 }],
        text: "The vendor requires 30 days written notice before renewal. [Source 1]",
      };
    },
    getDocument: (docId) => (DOCS.includes(docId) ? { docId, fileName: `${docId}.pdf` } : null),
    listDocuments: () => DOCS.map((docId) => ({ docId, fileName: `${docId}.pdf` })),
  };
};

const createHarness = ({ wrapRunService = (service) => service } = {}) => {
  const agentRunService = wrapRunService(
    createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() })
  );
  const webCalls = [];
  const ragService = createRagService();
  const webChatService = async (question) => {
    webCalls.push(question);
    return { citations: [], text: `Launch date found on the web for: ${question}` };
  };
  const capabilityRegistry = createDefaultCapabilityRegistry({ ragService, webChatService });
  const stepExecutor = createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry,
    executeDocumentRagStep: createDocumentRagStepExecutor({ ragService }),
    executeResearchQuestionStep: createResearchQuestionStepExecutor({ ragService }),
  });
  const runAgentTask = createAgentTaskIterationRunner({
    approveRunGate: (options) => stepExecutor.applyApprovalAction(options),
    runAgentRequest: (request) =>
      runAgentRag({ ...request, agentRunService, capabilityRegistry, ragService, webChatService }),
  });
  const taskService = createTaskService({ taskStore: createInMemoryTaskStore() });
  const runner = createAgentTaskRunner({
    capabilityRegistry,
    goalDeliverableService: {
      execute: async () => {
        throw new Error("no goal deliverable is requested");
      },
      prepare: async () => ({ specs: [], status: "not_requested" }),
    },
    runAgentTask,
  });
  const orchestrator = createJobOrchestrator({ runners: { [runner.id]: runner }, taskService });
  const agentTaskService = createAgentTaskService({
    createTaskId: () => "approval",
    jobOrchestrator: { scheduleTaskRun: () => {} },
    taskService,
  });

  return { agentRunService, agentTaskService, orchestrator, ragService, runAgentTask, taskService, webCalls };
};

const startPausedTask = async (harness, { docIds = [], question = WEB_QUESTION } = {}) => {
  const created = await harness.agentTaskService.createTask({
    accessScope,
    docIds,
    question,
    userId: accessScope.userId,
  });

  await harness.orchestrator.runTask({ accessScope, taskId: created.id });

  return harness.taskService.getInternalTask({ accessScope, taskId: created.id });
};

const approveTask = async (harness, task, gate) => {
  await harness.orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.approve,
    payload: { approvalObjectHash: gate.approvalObjectHash, gateId: gate.id },
    runImmediately: false,
    taskId: task.id,
  });
  await harness.orchestrator.runTask({ accessScope, taskId: task.id });

  return harness.taskService.getInternalTask({ accessScope, taskId: task.id });
};

const stepStatuses = (run) =>
  Object.fromEntries(run.steps.map((step) => [step.id, step.status]));

for (const { docIds, label, question } of [
  { docIds: [], label: "a Web-only question", question: WEB_QUESTION },
  // The document answer completes before the run stops at the Web gate. A
  // task's approval used to plan the run again, which tried to restart that
  // completed step (409 "Invalid agent run step status transition") and
  // failed the task.
  { docIds: DOCS, label: "a document answer and then a Web gate", question: "What is the latest notice period for renewal?" },
]) {
  test(`a task's approval after ${label} runs the Capability once and completes the task and its run`, async () => {
    await withEnv(async () => {
      const harness = createHarness();
      const paused = await startPausedTask(harness, { docIds, question });
      const gate = paused.payload.pending?.approvalGates?.[0];
      const runId = paused.payload.agentRunId;

      assert.equal(paused.status, "waiting_for_user");
      assert.equal(paused.requiredUserAction, "approve_capability");
      assert.equal(gate?.capabilityId, "web.search");
      assert.equal(harness.webCalls.length, 0);
      const documentCalls = harness.ragService.calls.length;

      const task = await approveTask(harness, paused, gate);
      const run = await harness.agentRunService.getRun({ accessScope, runId });

      assert.deepEqual(
        { error: task.error ?? null, status: task.status },
        { error: null, status: "completed" }
      );
      assert.equal(task.result.agentRunId, runId);
      assert.match(task.result.answer, /Launch date found on the web/);
      assert.equal(harness.webCalls.length, 1);
      // Nothing was planned again: no further document call.
      assert.equal(harness.ragService.calls.length, documentCalls);
      assert.equal(run.status, "completed");
      assert.deepEqual(run.approvalGates.map((entry) => entry.status), ["approved"]);
      assert.equal(
        Object.values(stepStatuses(run)).some((status) => status === "paused" || status === "running"),
        false
      );
      assert.equal(run.events.filter((event) => event.type === "approval_gate_approved").length, 1);
    });
  });
}

// The approval must be the gate's own: a stale or forged binding is refused
// before the Capability runs, and the run keeps waiting at its gate.
test("a task's approval whose binding does not match the run's pending gate is refused before anything runs", async () => {
  await withEnv(async () => {
    const harness = createHarness();
    const paused = await startPausedTask(harness);
    const gate = paused.payload.pending.approvalGates[0];
    const runId = paused.payload.agentRunId;
    const before = await harness.agentRunService.getRun({ accessScope, runId });

    await assert.rejects(
      harness.runAgentTask({
        accessScope,
        agentRunId: runId,
        capabilityApprovals: {
          [gate.capabilityId]: {
            approvalObjectHash: `sha256:${"0".repeat(64)}`,
            approved: true,
            decision: "approved",
            gateId: gate.id,
            source: "task_action",
          },
        },
      }),
      (error) => error.status === 409
    );
    assert.equal(harness.webCalls.length, 0);
    assert.deepEqual(await harness.agentRunService.getRun({ accessScope, runId }), before);
  });
});

// A gate that is no longer waiting cannot be decided: a run that ended (here
// canceled) refuses the approval, nothing runs, and the task fails with that
// reason rather than starting the action again in a new run.
test("a task's approval of a gate on a run that has ended is refused and nothing runs", async () => {
  await withEnv(async () => {
    const harness = createHarness();
    const paused = await startPausedTask(harness);
    const gate = paused.payload.pending.approvalGates[0];
    const runId = paused.payload.agentRunId;

    await harness.agentRunService.failRun({
      accessScope,
      error: new Error("Canceled by the user."),
      runId,
      status: "canceled",
    });

    const task = await approveTask(harness, paused, gate);

    assert.equal(task.status, "failed");
    assert.equal(task.error, "Agent run is not waiting for user input.");
    assert.equal(harness.webCalls.length, 0);
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "canceled");
  });
});

// A run whose custom-Skill graph completed before the plan stopped at a later
// gate holds a graph checkpoint. A task's approval used to re-enter it (409
// AGENT_GRAPH_EXECUTION_FENCED); it now decides the gate as the chat page
// does, which the replay guard allows for a gate created after the graph's
// terminal event.
test("a task's approval of a gate after a completed custom-Skill graph runs the Capability and completes the run", async () => {
  await withEnv(async () => {
    const harness = createHarness();
    const runId = "graph-then-web-gate";
    const goal = "Review the contract and search the web for the launch date.";
    const snapshot = createApprovalExecutionSnapshot({
      accessScope,
      capabilityId: "web.search",
      capabilityVersion: "1.0.0",
      executionInput: { question: goal },
      inputPreview: { question: goal },
    });
    const gate = {
      approvalObjectHash: snapshot.approvalObjectHash,
      capabilityId: "web.search",
      capabilityLabel: "Web Search",
      capabilityVersion: "1.0.0",
      id: `approval:web.search:1.0.0:${snapshot.approvalObjectHash.slice("sha256:".length)}`,
      inputPreview: { question: goal },
      snapshotVersion: snapshot.snapshotVersion,
      status: "pending",
      stepId: "3-capability_approval_gate",
    };
    const checkpoint = updateExecutionGraphCheckpoint(
      createExecutionGraphCheckpoint({
        graph: { nodes: [{ nodeId: "risk", skillId: "risk_review" }], revision: 0, version: "v1" },
        owner: buildExecutionGraphCheckpointOwner({
          accessScope,
          budgetState: createAgentBudget(),
          docIds: ["doc-a"],
          question: goal,
          selectedSkills: [],
        }),
      }),
      { phase: "completed" }
    );

    await harness.agentRunService.createRun({ accessScope, goal, runId, status: "running" });
    await harness.agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });
    await harness.agentRunService.appendRunEvent({
      accessScope,
      payload: {
        executed: true,
        fallback: null,
        graph: { nodeIds: ["risk"], version: "v1" },
        mode: "guarded",
        status: "completed",
      },
      runId,
      type: "skill_graph_planned",
    });
    await harness.agentRunService.completeRun({
      accessScope,
      approvalGates: [gate],
      approvalSnapshots: [{
        approvalObjectHash: snapshot.approvalObjectHash,
        capabilityId: "web.search",
        capabilityVersion: "1.0.0",
        executionInput: snapshot.privateSnapshot.executionInput,
        gateId: gate.id,
        snapshotVersion: snapshot.snapshotVersion,
      }],
      runId,
      status: "waiting_for_user",
      steps: [{
        approvalGateId: gate.id,
        capabilityId: "web.search",
        id: gate.stepId,
        kind: "approval_gate",
        label: "Capability Approval",
        status: "paused",
        type: "capability_approval_gate",
      }],
    });

    const response = await harness.runAgentTask({
      accessScope,
      agentRunId: runId,
      capabilityApprovals: {
        "web.search": {
          approvalObjectHash: gate.approvalObjectHash,
          approved: true,
          decision: "approved",
          gateId: gate.id,
          source: "task_action",
        },
      },
    });
    const run = await harness.agentRunService.getRun({ accessScope, runId });

    assert.equal(response.status, 200);
    assert.equal(response.body.agentRunId, runId);
    assert.match(response.body.agentAnswer, /Launch date found on the web/);
    assert.equal(harness.webCalls.length, 1);
    assert.equal(run.status, "completed");
    assert.deepEqual(run.approvalGates.map((entry) => entry.status), ["approved"]);
    // The graph checkpoint is left as it was.
    assert.deepEqual(
      (await harness.agentRunService.getExecutionGraphCheckpoint({ accessScope, runId })).checkpoint,
      checkpoint
    );
  });
});

// A run whose completion is refused must not stay `running`: the agent's
// failure path ends it.
test("a run whose completion is refused ends failed instead of staying running", async () => {
  await withEnv(async () => {
    const harness = createHarness({
      wrapRunService: (service) => ({
        ...service,
        completeRun: async () => {
          const error = new Error("Agent run cannot become completed with a concurrent active step.");
          error.code = "AGENT_RUN_ACTIVE_STEP_CONFLICT";
          error.status = 409;
          throw error;
        },
      }),
    });
    let runId = null;

    await assert.rejects(
      harness.runAgentTask({
        accessScope,
        docIds: DOCS,
        question: "What notice period does the vendor require before renewal?",
        userId: accessScope.userId,
      }).catch(async (error) => {
        runId = error.agentRunId ?? null;
        throw error;
      }),
      (error) => error.code === "AGENT_RUN_ACTIVE_STEP_CONFLICT"
    );

    const runs = await harness.agentRunService.listRuns?.({ accessScope });
    const stored = runId
      ? await harness.agentRunService.getRun({ accessScope, runId })
      : (runs?.runs ?? runs ?? [])[0];

    assert.equal(stored?.status, "failed");
  });
});

// Cancelling a task stops the run it drives, as a client leaving /chat does:
// the run ends canceled at its next safe point and the rest of its plan is
// never called. It used to run every remaining research question and end
// completed under the canceled task.
test("cancelling a task mid-run ends its run canceled and calls none of its later steps", async () => {
  await withEnv(async () => {
    const harness = createHarness();
    const { chat } = harness.ragService;
    let taskId = null;

    harness.ragService.chat = async (...args) => {
      if (harness.ragService.calls.length === 0) {
        await harness.orchestrator.resumeTask({ accessScope, action: "cancel", taskId });
      }
      return chat(...args);
    };
    ({ id: taskId } = await harness.agentTaskService.createTask({
      accessScope,
      docIds: DOCS,
      question: "Write a research brief on the key risks in these contracts.",
      userId: accessScope.userId,
    }));

    const task = await harness.orchestrator.runTask({ accessScope, taskId });
    const { runs } = await harness.agentRunService.listRuns({ accessScope });

    assert.equal(task.status, "canceled");
    assert.equal(harness.ragService.calls.length, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "canceled");
    assert.equal(runs[0].error.code, "AGENT_CLIENT_CANCELLED");
    assert.ok(runs[0].steps.every((step) => step.status !== "running"));
  });
});

// A claim lost mid-run (not a cancel) stops the run too, and the iteration
// rejects with the task's reason: the orchestrator then leaves the task for
// recovery, as before, instead of failing it as "the client disconnected".
test("an iteration whose task aborts mid-run rejects with the task's own reason", async () => {
  const task = new AbortController();
  const claimLost = Object.assign(new Error("Task execution claim is no longer active."), { code: "TASK_CLAIM_LOST" });
  const runAgentTask = createAgentTaskIterationRunner({
    runAgentRequest: async () => {
      task.abort(claimLost);
      throwIfRequestCancelled();
      return { body: {}, status: 200 };
    },
  });

  await assert.rejects(runAgentTask({ signal: task.signal }), (error) => error === claimLost);
});
