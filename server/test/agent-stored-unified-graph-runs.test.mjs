import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resumeAgentExecutionGraphRun, runAgentRag } from "../rag/agent.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import {
  buildAgentRunRecoveryState,
  createAgentRunRecoveryActionService,
} from "../rag/agent-run-recovery-actions.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import { AGENT_TASK_ACTIONS, createAgentTaskRunner } from "../rag/agent-tasks.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import { createDefaultSkillRegistry } from "../rag/skills/registry.js";
import { createInMemoryTaskStore, createTaskService } from "../rag/tasks.js";

// What the runtime does with a run the v3 unified graph stored
// (AGENT_UNIFIED_GRAPH_ROLLOUT=guarded). That graph was removed in ADR 0001
// phase 10 (rag/agent-removed-unified-graph.js is what is left of it); a
// deployment that ran it may still hold its runs. The stored runs are data:
// run-store records written by the v3 code, one per state such a deployment
// can still hold (test/fixtures/stored-unified-graph-runs.json; its
// `provenance` says how they were written). Every expectation below is a
// literal. The file was written before the removal, against the default
// configuration (the graph switched off), so its diff in the removal's commit
// is what changed for such a run.

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/stored-unified-graph-runs.json", import.meta.url), "utf8")
);
const accessScope = fixture.accessScope;
const STATES = Object.keys(fixture.runs);
const runIdOf = (state) => fixture.runs[state].runId;
const parkedGate = fixture.runs.parked_at_approval_gate.approvalGates[0];

const DOC_ID = "vendor-msa";
const QUESTION = "What notice period does the vendor require before renewal?";

const ENV = Object.freeze({
  AGENT_PLANNER_ROLLOUT: "deterministic",
  AGENT_UNIFIED_GRAPH_CAPABILITIES: undefined,
  AGENT_UNIFIED_GRAPH_ROLLOUT: undefined,
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

const withEnv = async (callback) => {
  const previous = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// A document service that answers every question with one supported sentence.
const createRagService = () => {
  const calls = [];
  const inScope = (scope) =>
    scope?.userId === accessScope.userId && scope?.workspaceId === accessScope.workspaceId;

  return {
    calls,
    chat: async (docIds, question) => {
      calls.push({ docIds, question });

      return {
        abstained: false,
        citations: [
          {
            docId: DOC_ID,
            excerpt: "The vendor requires 30 days written notice before renewal.",
            fileName: "vendor-msa.pdf",
            pageNumber: 2,
          },
        ],
        text: "The vendor requires 30 days written notice before renewal. [Source 1]",
      };
    },
    getDocument: (docId, scope) =>
      inScope(scope) && docId === DOC_ID ? { docId, fileName: "vendor-msa.pdf" } : null,
    listDocuments: (scope) =>
      inScope(scope) ? [{ docId: DOC_ID, fileName: "vendor-msa.pdf" }] : [],
  };
};

// A run store that holds the named stored runs, put in as the store's own
// records.
const seed = async (...states) => {
  const store = createInMemoryAgentRunStore();

  for (const state of states) {
    await store.create({ accessScope, run: structuredClone(fixture.runs[state]) });
  }

  return { agentRunService: createAgentRunService({ agentRunStore: store }), store };
};

const readStored = (store, state) => store.get({ accessScope, runId: runIdOf(state) });

// The services, wired as app-services.js wires them.
const createStepExecutor = ({ agentRunService }) => createAgentRunStepExecutor({ agentRunService });

const recoverOnStartup = ({ agentRunService, ragService, resumed }) =>
  createAgentRunRecoveryService({
    agentRunService,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: (args) => {
      resumed.push(args.runId);

      return resumeAgentExecutionGraphRun({
        ...args,
        agentRunService,
        ragService,
        skillRegistry: createDefaultSkillRegistry(),
      });
    },
  }).recoverOnStartup({ mode: "auto" });

const reenter = ({ agentRunService, capabilityApprovals, ragService, state }) =>
  runAgentRag({
    accessScope,
    agentRunId: runIdOf(state),
    agentRunService,
    ...(capabilityApprovals ? { capabilityApprovals } : {}),
    docIds: [DOC_ID],
    question: QUESTION,
    ragService,
    sessionId: "stored-run-session",
    userId: accessScope.userId,
  });

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error.code, message: error.message, status: error.status };
  }

  return null;
};

// How every attempt to continue an unfinished stored run is refused.
const REMOVED = Object.freeze({
  code: "unified_graph_removed",
  message: "This run belongs to the v3 unified graph, which was removed; an operator must resolve it.",
  status: 409,
});

const describeStored = (run) => {
  const checkpoint = run.result.__skillGraphCheckpoint;

  return {
    checkpoint: `${checkpoint.version}/${checkpoint.phase}`,
    finalization: checkpoint.finalization !== undefined,
    gates: run.approvalGates.map((gate) => `${gate.type}:${gate.status}`),
    graph: checkpoint.graph.version,
    graphNodeSteps: run.steps
      .filter((step) => step.type === "graph_node")
      .map((step) => step.status),
    status: run.status,
  };
};

const describeAfter = (run) => ({
  gates: run.approvalGates.map((gate) => gate.status),
  recovery: run.result.recovery
    ? `${run.result.recovery.mode}:${run.result.recovery.reason}`
    : null,
  status: run.status,
});

test("the stored runs: eight states of a v3 graph, as the run store holds them", async () => {
  const { store } = await seed(...STATES);
  const stored = {};

  for (const state of STATES) {
    const run = await readStored(store, state);

    assert.deepEqual(run, fixture.runs[state], state);
    stored[state] = describeStored(run);
  }

  assert.deepEqual(stored, {
    parked_at_approval_gate: {
      checkpoint: "v2/awaiting_approval",
      finalization: false,
      gates: ["graph_capability_approval:pending"],
      graph: "v3",
      graphNodeSteps: ["completed", "completed"],
      status: "waiting_for_user",
    },
    approved_before_capability_step: {
      checkpoint: "v2/running",
      finalization: false,
      gates: ["graph_capability_approval:approved"],
      graph: "v3",
      graphNodeSteps: ["completed", "completed"],
      status: "running",
    },
    capability_step_in_flight: {
      checkpoint: "v2/running",
      finalization: false,
      gates: ["graph_capability_approval:approved"],
      graph: "v3",
      graphNodeSteps: ["completed", "completed", "running"],
      status: "running",
    },
    interrupted_at_node_boundary: {
      checkpoint: "v2/running",
      finalization: false,
      gates: [],
      graph: "v3",
      graphNodeSteps: ["completed"],
      status: "running",
    },
    receipt_written_run_not_completed: {
      checkpoint: "v2/completed",
      finalization: true,
      gates: [],
      graph: "v3",
      graphNodeSteps: ["completed", "completed"],
      status: "running",
    },
    finalized_as_clarification: {
      checkpoint: "v2/completed",
      finalization: true,
      gates: ["clarification_gate:needs_input"],
      graph: "v3",
      graphNodeSteps: ["completed", "completed"],
      status: "waiting_for_user",
    },
    completed: {
      checkpoint: "v2/completed",
      finalization: true,
      gates: [],
      graph: "v3",
      graphNodeSteps: ["completed", "completed"],
      status: "completed",
    },
    failed_partial: {
      checkpoint: "v2/partial",
      finalization: false,
      gates: [],
      graph: "v3",
      graphNodeSteps: ["completed", "completed", "failed"],
      status: "failed",
    },
  });
});

test("startup recovery hands every unfinished stored graph to an operator and runs none", async () => {
  const { agentRunService, store } = await seed(...STATES);
  const ragService = createRagService();
  const resumed = [];
  const outcome = await withEnv(() => recoverOnStartup({ agentRunService, ragService, resumed }));
  const after = {};

  for (const state of STATES) {
    after[state] = describeAfter(await readStored(store, state));
  }

  assert.deepEqual(
    {
      autoRecoveredCount: outcome.autoRecoveredCount,
      failedCount: outcome.failedCount,
      manualRecoveredCount: outcome.manualRecoveredCount,
      skippedCount: outcome.skippedCount,
    },
    { autoRecoveredCount: 0, failedCount: 0, manualRecoveredCount: 5, skippedCount: 1 }
  );
  assert.deepEqual(resumed, []);
  assert.equal(ragService.calls.length, 0);
  assert.deepEqual(after, {
    // Still waiting, now listed for an operator; its gate stays pending.
    parked_at_approval_gate: {
      gates: ["pending"],
      recovery: "manual:unified_graph_removed",
      status: "waiting_for_user",
    },
    // Approved, never run: the Capability is not started.
    approved_before_capability_step: {
      gates: ["approved"],
      recovery: "manual:unified_graph_removed",
      status: "waiting_for_user",
    },
    // The Capability's step was running: its outcome is unknown.
    capability_step_in_flight: {
      gates: ["approved"],
      recovery: "manual:unknown_in_flight_node",
      status: "waiting_for_user",
    },
    interrupted_at_node_boundary: {
      gates: [],
      recovery: "manual:unified_graph_removed",
      status: "waiting_for_user",
    },
    // Its sealed answer is not delivered.
    receipt_written_run_not_completed: {
      gates: [],
      recovery: "manual:unified_graph_removed",
      status: "waiting_for_user",
    },
    // Settled: nothing crashed, nothing is touched.
    finalized_as_clarification: { gates: ["needs_input"], recovery: null, status: "waiting_for_user" },
    completed: { gates: [], recovery: null, status: "completed" },
    failed_partial: { gates: [], recovery: null, status: "failed" },
  });

  // A second startup changes nothing more.
  const again = await withEnv(() => recoverOnStartup({ agentRunService, ragService, resumed }));

  assert.equal(again.manualRecoveredCount + again.autoRecoveredCount, 0);
  assert.deepEqual(resumed, []);
});

test("an operator can only cancel a stored graph run", async () => {
  const { agentRunService, store } = await seed(...STATES);
  const ragService = createRagService();
  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    recordRecoveryTrace: async () => {},
  });

  await withEnv(() => recoverOnStartup({ agentRunService, ragService, resumed: [] }));

  const offered = {};

  for (const state of STATES) {
    const recoveryState = buildAgentRunRecoveryState({
      run: await agentRunService.getRun({ accessScope, runId: runIdOf(state) }),
    });

    offered[state] = recoveryState.required
      ? recoveryState.actions.map((action) => action.type)
      : null;
  }

  assert.deepEqual(offered, {
    parked_at_approval_gate: ["cancel"],
    approved_before_capability_step: ["cancel"],
    capability_step_in_flight: ["cancel"],
    interrupted_at_node_boundary: ["cancel"],
    receipt_written_run_not_completed: ["cancel"],
    finalized_as_clarification: null,
    completed: null,
    failed_partial: null,
  });

  for (const state of STATES.filter((name) => offered[name])) {
    const canceled = await actionService.applyRecoveryAction({
      accessScope,
      action: "cancel",
      runId: runIdOf(state),
    });

    assert.equal(canceled.run.status, "canceled", state);
    assert.equal((await readStored(store, state)).status, "canceled", state);
  }
});

test("the approval endpoint refuses a decision of a stored graph gate and lists the run for an operator", async () => {
  for (const action of ["approve", "deny"]) {
    const { agentRunService, store } = await seed("parked_at_approval_gate");
    const ragService = createRagService();
    const refused = await withEnv(() =>
      refusal(
        createStepExecutor({ agentRunService }).applyApprovalAction({
          accessScope,
          action,
          gateId: parkedGate.id,
          payload: { approvalObjectHash: parkedGate.approvalObjectHash },
          runId: runIdOf("parked_at_approval_gate"),
        })
      )
    );

    assert.deepEqual(refused, REMOVED, action);
    assert.deepEqual(
      describeAfter(await readStored(store, "parked_at_approval_gate")),
      {
        gates: ["pending"],
        recovery: "manual:unified_graph_removed",
        status: "waiting_for_user",
      },
      action
    );
    assert.equal(ragService.calls.length, 0, action);
  }
});

test("a request that re-enters a graph parked at its gate is refused and the run is listed for an operator", async () => {
  const binding = { approvalObjectHash: parkedGate.approvalObjectHash, gateId: parkedGate.id };
  const attempt = async (capabilityApprovals) => {
    const { agentRunService, store } = await seed("parked_at_approval_gate");
    const ragService = createRagService();
    let response = null;
    const refused = await withEnv(() =>
      refusal(
        reenter({
          agentRunService,
          capabilityApprovals,
          ragService,
          state: "parked_at_approval_gate",
        }).then((value) => {
          response = value;
        })
      )
    );
    const run = await readStored(store, "parked_at_approval_gate");

    return {
      after: describeAfter(run),
      ragCalls: ragService.calls.length,
      refused,
      response: response
        ? {
            clarification: response.body.clarification?.reason ?? null,
            gateIds: (response.body.approvalGates ?? []).map((gate) => gate.id),
            runId: response.body.agentRunId,
            status: response.status,
          }
        : null,
      stored: (await store.list({ accessScope })).length,
      unchanged: JSON.stringify(run) === JSON.stringify(fixture.runs.parked_at_approval_gate),
    };
  };
  const refusedAndHandedOver = {
    after: {
      gates: ["pending"],
      recovery: "manual:unified_graph_removed",
      status: "waiting_for_user",
    },
    ragCalls: 0,
    refused: REMOVED,
    response: null,
    stored: 1,
    unchanged: false,
  };

  // Whatever the request carries, it cannot continue the graph: without a
  // decision (a background task's `continue`), with the gate's approval or
  // denial (a background task's decision), or with a decision of some other
  // gate. Nothing is decided; the run is listed for an operator.
  for (const capabilityApprovals of [
    undefined,
    { [parkedGate.capabilityId]: { ...binding, approved: true } },
    { [parkedGate.capabilityId]: { ...binding, approved: false, decision: "deny" } },
    { [parkedGate.capabilityId]: { ...binding, approved: true, gateId: "another-gate" } },
  ]) {
    assert.deepEqual(await attempt(capabilityApprovals), refusedAndHandedOver);
  }
});

test("a request that re-enters an interrupted stored graph is fenced and changes nothing", async () => {
  for (const state of [
    "approved_before_capability_step",
    "capability_step_in_flight",
    "interrupted_at_node_boundary",
    "receipt_written_run_not_completed",
  ]) {
    const { agentRunService, store } = await seed(state);
    const ragService = createRagService();
    const refused = await withEnv(() => refusal(reenter({ agentRunService, ragService, state })));

    assert.deepEqual(
      refused,
      {
        code: "AGENT_GRAPH_EXECUTION_FENCED",
        message: "Agent run re-entry requires the dedicated graph recovery path.",
        status: 409,
      },
      state
    );
    assert.deepEqual(await readStored(store, state), fixture.runs[state], state);
    assert.equal((await store.list({ accessScope })).length, 1, state);
    assert.equal(ragService.calls.length, 0, state);
  }
});

test("a request that continues a settled stored graph run is answered as a new run", async () => {
  for (const state of ["finalized_as_clarification", "completed", "failed_partial"]) {
    const { agentRunService, store } = await seed(state);
    const ragService = createRagService();
    const response = await withEnv(() => reenter({ agentRunService, ragService, state }));
    const newRun = await agentRunService.getRun({ accessScope, runId: response.body.agentRunId });

    assert.equal(response.status, 200, state);
    assert.equal(response.body.agentMode, "document", state);
    assert.notEqual(response.body.agentRunId, runIdOf(state), state);
    assert.equal(newRun.status, "completed", state);
    assert.deepEqual(
      newRun.events.filter((event) => event.type === "run_continued").map((event) => event.payload),
      [{ previousRunId: runIdOf(state), reason: "settled_unified_graph_run" }],
      state
    );
    // The answer came from the outer execution plan, not from a graph.
    assert.equal(newRun.events.some((event) => event.type === "execution_planned"), true, state);
    assert.equal(newRun.steps.some((step) => step.type === "graph_node"), false, state);
    assert.equal(ragService.calls.length, 1, state);
    // The settled run is left as it was.
    assert.deepEqual(await readStored(store, state), fixture.runs[state], state);
  }
});

test("a stored graph node step is never retried on its own", async () => {
  const { agentRunService, store } = await seed("failed_partial");
  const failedStep = fixture.runs.failed_partial.steps.find((step) => step.status === "failed");
  const recoveryState = buildAgentRunRecoveryState({
    run: await agentRunService.getRun({ accessScope, runId: runIdOf("failed_partial") }),
  });
  const expected = {
    code: "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY",
    message:
      "Guarded ExecutionGraph runs cannot be replayed as standalone steps; use whole-graph recovery.",
    status: 409,
  };

  assert.equal(failedStep.type, "graph_node");
  assert.equal(recoveryState.required, false);
  assert.deepEqual(recoveryState.actions, []);
  assert.deepEqual(
    await refusal(
      createStepExecutor({ agentRunService }).retryStep({
        accessScope,
        runId: runIdOf("failed_partial"),
        stepId: failedStep.id,
      })
    ),
    expected
  );
  assert.deepEqual(
    await refusal(
      agentRunService.retryStep({
        accessScope,
        runId: runIdOf("failed_partial"),
        stepId: failedStep.id,
      })
    ),
    expected
  );
  assert.deepEqual(await readStored(store, "failed_partial"), fixture.runs.failed_partial);
});

test("a background task parked at a stored graph gate fails, whatever its action", async () => {
  const act = async (action) => {
    const { agentRunService, store } = await seed("parked_at_approval_gate");
    const ragService = createRagService();
    const taskService = createTaskService({ taskStore: createInMemoryTaskStore() });
    const runner = createAgentTaskRunner({
      goalDeliverableService: {
        execute: async () => {
          throw new Error("no goal deliverable is requested");
        },
        prepare: async () => ({ specs: [], status: "not_requested" }),
      },
      runAgentTask: (request) => withEnv(() => runAgentRag({ ...request, agentRunService, ragService })),
    });
    const orchestrator = createJobOrchestrator({ runners: { [runner.id]: runner }, taskService });
    const taskId = fixture.task.id;

    await taskService.upsertTask({ accessScope, task: structuredClone(fixture.task) });
    assert.deepEqual(await taskService.getInternalTask({ accessScope, taskId }), fixture.task);

    await orchestrator.resumeTask({
      accessScope,
      action,
      payload:
        action === AGENT_TASK_ACTIONS.continue
          ? { answer: "Use the renewal clause." }
          : { approvalObjectHash: parkedGate.approvalObjectHash, gateId: parkedGate.id },
      runImmediately: false,
      taskId,
    });
    await orchestrator.runTask({ accessScope, taskId });

    const task = await taskService.getInternalTask({ accessScope, taskId });

    return {
      ragCalls: ragService.calls.length,
      run: describeAfter(await readStored(store, "parked_at_approval_gate")),
      task: {
        error: task.error ?? null,
        pendingGates: (task.payload.pending?.approvalGates ?? []).map((gate) => gate.id),
        requiredUserAction: task.requiredUserAction,
        status: task.status,
      },
    };
  };
  const failed = {
    ragCalls: 0,
    run: {
      gates: ["pending"],
      recovery: "manual:unified_graph_removed",
      status: "waiting_for_user",
    },
    task: {
      error: REMOVED.message,
      pendingGates: [],
      requiredUserAction: "",
      status: "failed",
    },
  };

  assert.equal(fixture.task.payload.agentRunId, runIdOf("parked_at_approval_gate"));
  assert.equal(fixture.task.status, "waiting_for_user");
  assert.equal(fixture.task.requiredUserAction, "approve_capability");

  // Whatever the user does with the task, it fails with the reason and its
  // run is handed to an operator.
  assert.deepEqual(await act(AGENT_TASK_ACTIONS.continue), failed);
  assert.deepEqual(await act(AGENT_TASK_ACTIONS.approve), failed);
  assert.deepEqual(await act(AGENT_TASK_ACTIONS.deny), failed);
});
