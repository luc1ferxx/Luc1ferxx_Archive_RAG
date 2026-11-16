import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import { runAgentRag } from "../rag/agent.js";
import {
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createApprovalExecutionSnapshot } from "../rag/capabilities/approval-execution-snapshot.js";
import { AGENT_TASK_ACTIONS, createAgentTaskRunner, createAgentTaskService } from "../rag/agent-tasks.js";
import { createAgentRunService, createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import { createInMemoryTaskStore, createTaskService } from "../rag/tasks.js";

// A background task that a Capability approval gate paused, approved through
// the task (POST /tasks/:taskId/actions/approve; the Approve button of the
// task card), end to end through the real agent: the task runner re-enters
// the paused run with the gate's binding. The other task-approval tests stub
// the agent; this one does not.

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const QUESTION = "Search the web for the current launch date";

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

const createHarness = ({ wrapRunService = (service) => service } = {}) => {
  const agentRunService = wrapRunService(
    createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() })
  );
  const webCalls = [];
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
        ragService: { getDocument: () => null, listDocuments: () => [] },
        webChatService: async (question) => {
          webCalls.push(question);
          return { citations: [], text: `Launch date found on the web for: ${question}` };
        },
      }),
  });
  const orchestrator = createJobOrchestrator({ runners: { [runner.id]: runner }, taskService });
  const agentTaskService = createAgentTaskService({
    createTaskId: () => "approval-reentry",
    jobOrchestrator: { scheduleTaskRun: () => {} },
    taskService,
  });

  return { agentRunService, agentTaskService, orchestrator, taskService, webCalls };
};

const startPausedTask = async (harness) => {
  const created = await harness.agentTaskService.createTask({
    accessScope,
    question: QUESTION,
    userId: accessScope.userId,
  });

  await harness.orchestrator.runTask({ accessScope, taskId: created.id });

  return harness.taskService.getInternalTask({ accessScope, taskId: created.id });
};

test("a task's approval of a Capability gate runs the Capability once and completes the task and its run", async () => {
  await withEnv(async () => {
    const harness = createHarness();
    const paused = await startPausedTask(harness);
    const gate = paused.payload.pending.approvalGates[0];
    const runId = paused.payload.agentRunId;

    assert.equal(paused.status, "waiting_for_user");
    assert.equal(paused.requiredUserAction, AGENT_TASK_ACTIONS.approve.concat("_capability"));
    assert.equal(harness.webCalls.length, 0);
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "waiting_for_user");

    await harness.orchestrator.resumeTask({
      accessScope,
      action: AGENT_TASK_ACTIONS.approve,
      payload: { approvalObjectHash: gate.approvalObjectHash, gateId: gate.id },
      runImmediately: false,
      taskId: paused.id,
    });
    await harness.orchestrator.runTask({ accessScope, taskId: paused.id });

    const task = await harness.taskService.getInternalTask({ accessScope, taskId: paused.id });
    const run = await harness.agentRunService.getRun({ accessScope, runId });

    assert.deepEqual(
      { error: task.error ?? null, status: task.status },
      { error: null, status: "completed" }
    );
    // The approved Web search ran once, in the run the gate paused.
    assert.equal(harness.webCalls.length, 1);
    assert.equal(task.result.agentRunId, runId);
    assert.equal(run.status, "completed");
    assert.deepEqual(run.approvalGates.map((entry) => entry.status), ["approved"]);
    assert.deepEqual(
      Object.fromEntries(
        run.steps
          .filter((step) => ["2-capability_approval_gate", "web_search:primary"].includes(step.id))
          .map((step) => [step.id, step.status])
      ),
      { "2-capability_approval_gate": "completed", "web_search:primary": "completed" }
    );
    assert.deepEqual(
      run.steps.filter((step) => step.status === "paused" || step.status === "running"),
      []
    );
    assert.deepEqual(
      run.events
        .filter((event) => event.type === "approval_gate_approved")
        .map((event) => ({ continuedByReentry: event.payload.continuedByReentry, gateId: event.payload.gateId })),
      [{ continuedByReentry: true, gateId: gate.id }]
    );
  });
});

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
      runAgentRag({
        accessScope,
        agentRunId: runId,
        agentRunService: harness.agentRunService,
        capabilityApprovals: {
          [gate.capabilityId]: {
            approvalObjectHash: `sha256:${"0".repeat(64)}`,
            approved: true,
            decision: "approved",
            gateId: gate.id,
            source: "task_action",
          },
        },
        docIds: [],
        question: QUESTION,
        ragService: { getDocument: () => null, listDocuments: () => [] },
        userId: accessScope.userId,
        webChatService: async () => {
          throw new Error("the Capability must not run");
        },
      }),
      (error) => error.status === 409
    );
    assert.deepEqual(await harness.agentRunService.getRun({ accessScope, runId }), before);
  });
});

// A run whose completion is refused must not stay `running`: the agent's
// failure path ends it.
test("a run whose completion is refused ends failed instead of staying running", async () => {
  await withEnv(async () => {
    let refuseCompletion = false;
    const harness = createHarness({
      wrapRunService: (service) => ({
        ...service,
        completeRun: async (options) => {
          if (refuseCompletion) {
            const error = new Error("Agent run cannot become completed with a concurrent active step.");
            error.code = "AGENT_RUN_ACTIVE_STEP_CONFLICT";
            error.status = 409;
            throw error;
          }

          return service.completeRun(options);
        },
      }),
    });
    const paused = await startPausedTask(harness);
    const gate = paused.payload.pending.approvalGates[0];
    const runId = paused.payload.agentRunId;

    refuseCompletion = true;
    await assert.rejects(
      runAgentRag({
        accessScope,
        agentRunId: runId,
        agentRunService: harness.agentRunService,
        capabilityApprovals: {
          [gate.capabilityId]: {
            approvalObjectHash: gate.approvalObjectHash,
            approved: true,
            decision: "approved",
            gateId: gate.id,
            source: "task_action",
          },
        },
        docIds: [],
        question: QUESTION,
        ragService: { getDocument: () => null, listDocuments: () => [] },
        userId: accessScope.userId,
        webChatService: async () => ({ citations: [], text: "Launch date." }),
      }),
      (error) => error.code === "AGENT_RUN_ACTIVE_STEP_CONFLICT"
    );
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "failed");
  });
});


// A run that holds a custom-Skill graph checkpoint is refused by the re-entry
// fence whatever the request carries (a separate, open question: ADR 0001
// phase 10's review). The task's approval must then write nothing, so the run
// still waits at its gate and the chat page's approval endpoint can decide it.
// Recording the approval before the fence left such a run running with its
// gate approved and the Capability never run.
test("a task's approval of a gate on a run that holds a graph checkpoint is fenced and writes nothing", async () => {
  await withEnv(async () => {
    const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
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
          docIds: ["doc-1"],
          question: goal,
          selectedSkills: [],
        }),
      }),
      { phase: "completed" }
    );

    await agentRunService.createRun({ accessScope, goal, runId, status: "running" });
    await agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });
    await agentRunService.completeRun({
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
    const before = await agentRunService.getRun({ accessScope, runId });

    await assert.rejects(
      runAgentRag({
        accessScope,
        agentRunId: runId,
        agentRunService,
        capabilityApprovals: {
          "web.search": {
            approvalObjectHash: gate.approvalObjectHash,
            approved: true,
            decision: "approved",
            gateId: gate.id,
            source: "task_action",
          },
        },
        docIds: [],
        question: goal,
        ragService: { getDocument: () => null, listDocuments: () => [] },
        userId: accessScope.userId,
        webChatService: async () => {
          throw new Error("the Capability must not run");
        },
      }),
      (error) => error.code === "AGENT_GRAPH_EXECUTION_FENCED" && error.status === 409
    );
    assert.deepEqual(await agentRunService.getRun({ accessScope, runId }), before);
  });
});
