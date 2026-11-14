// Writes test/fixtures/stored-unified-graph-runs.json: agent runs exactly as
// the v3 unified graph (AGENT_UNIFIED_GRAPH_ROLLOUT=guarded) left them in the
// run store, one per state a deployment that ever ran `guarded` can still
// hold. Every provider is a mock; nothing here calls a model.
//
//   cd server && node test/fixtures/stored-unified-graph-runs.generate.mjs
//
// The rows are the in-memory run store's own records (run row, private graph
// checkpoint and LangGraph thread record under `result`, events), read with
// the store's `get`, so a test can put them back with the store's `create`
// and exercise the code that meets such a run. The private approval snapshot
// of the parked gate is not part of the fixture: the paths that meet these
// runs decide nothing about the gate before they refuse.
//
// This script needs the v3 code it describes. It is deleted together with
// that code (ADR 0001 phase 10); the JSON it wrote stays, and
// test/agent-stored-unified-graph-runs.test.mjs reads it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { continueAgentExecutionGraphApproval, runAgentRag } from "../../rag/agent.js";
import { EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY } from "../../rag/agent-execution-graph-checkpoint.js";
import { createAgentRunStepExecutor } from "../../rag/agent-run-step-executor.js";
import {
  AGENT_TASK_RUNNER_ID,
  AGENT_TASK_TYPE,
  createAgentTaskRunner,
} from "../../rag/agent-tasks.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../../rag/agent-runs.js";
import { createJobOrchestrator } from "../../rag/job-orchestrator.js";
import {
  TASK_STATUSES,
  createInMemoryTaskStore,
  createTaskService,
} from "../../rag/tasks.js";
import {
  APPROVAL_TASK_QUESTION,
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE as accessScope,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  createApprovalGatedTaskProposal,
  createCrashingRunService,
  createDocumentLoopProposal,
  createDocumentLoopRagService,
  createProposalAdapter,
  createTaskCapabilityRegistry,
  createWebChatService,
} from "./unified-graph-run-fixtures.mjs";

const OUTPUT = fileURLToPath(new URL("./stored-unified-graph-runs.json", import.meta.url));

const ENV = Object.freeze({
  AGENT_PLANNER_ROLLOUT: "deterministic",
  AGENT_UNIFIED_GRAPH_CAPABILITIES: "task.create",
  AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

Object.assign(process.env, ENV);

const isSimulatedExit = (error) => error.code === "SIMULATED_PROCESS_EXIT";

const newStore = () => {
  const store = createInMemoryAgentRunStore();

  return { service: createAgentRunService({ agentRunStore: store }), store };
};

// The only run of a store, as the store holds it.
const readOnlyRun = async (store) => {
  const listed = await store.list({ accessScope });
  const runs = listed?.runs ?? listed ?? [];

  assert.equal(runs.length, 1);

  return structuredClone(await store.get({ accessScope, runId: runs[0].runId }));
};

// --- a document answer and its evidence check ------------------------------

// The first two nodes of the document loop: the primary answer and its check.
// A supported answer finalizes with it; an unsupported one, whose check
// recommends a follow-up this graph does not have, finalizes as a question
// for the user.
const createDocumentProposal = () => ({
  nodes: createDocumentLoopProposal().nodes.filter((node) =>
    ["primary", "primary_check"].includes(node.nodeId)
  ),
});

const askDocument = ({ agentRunService, primary }) =>
  runAgentRag({
    accessScope,
    agentRunService,
    docIds: [UNIFIED_DOC_ID],
    question: DOCUMENT_LOOP_QUESTION,
    ragService: createDocumentLoopRagService({ primary }),
    sessionId: UNIFIED_SESSION_ID,
    unifiedGraphPlannerAdapter: createProposalAdapter(createDocumentProposal),
    userId: accessScope.userId,
    webChatService: createWebChatService(),
  });

const crashedDocument = async ({ crashAfter, crashBefore, primary = "supported" }) => {
  const { service, store } = newStore();
  const crashing = createCrashingRunService(service, { crashAfter, crashBefore });

  await assert.rejects(askDocument({ agentRunService: crashing.service, primary }), isSimulatedExit);

  return readOnlyRun(store);
};

const settledDocument = async ({ primary }) => {
  const { service, store } = newStore();
  const response = await askDocument({ agentRunService: service, primary });

  return { response, run: await readOnlyRun(store) };
};

// --- a task.create node behind an approval gate ---------------------------

const setupApproval = async ({ proposal = createApprovalGatedTaskProposal } = {}) => {
  const { service, store } = newStore();
  const ragService = createDocumentLoopRagService({ primary: "supported" });
  const { registry, writes } = await createTaskCapabilityRegistry({ ragService });

  return { agentRunService: service, proposal, ragService, registry, store, writes };
};

const askApproval = ({ agentRunService, proposal, ragService, registry }) =>
  runAgentRag({
    accessScope,
    agentRunService,
    capabilityRegistry: registry,
    docIds: [UNIFIED_DOC_ID],
    question: APPROVAL_TASK_QUESTION,
    ragService,
    sessionId: UNIFIED_SESSION_ID,
    unifiedGraphAllowedCapabilityIds: ["task.create"],
    unifiedGraphPlannerAdapter: createProposalAdapter(proposal),
    userId: accessScope.userId,
  });

// The approval endpoint's handler, wired as app-services wires it.
const decide = ({ action, agentRunService, gate, ragService, registry, runId }) =>
  createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry: registry,
    continueExecutionGraphApproval: (args) =>
      continueAgentExecutionGraphApproval({
        ...args,
        agentRunService,
        capabilityRegistry: registry,
        ragService,
      }),
  }).applyApprovalAction({
    accessScope,
    action,
    gateId: gate.id,
    payload: { approvalObjectHash: gate.approvalObjectHash },
    runId,
  });

const pausedAtGate = async () => {
  const context = await setupApproval();
  const paused = await askApproval(context);

  assert.equal(paused.body.clarification.reason, "capability_approval_required");

  return { context, paused, run: await readOnlyRun(context.store) };
};

const approvedBeforeCapabilityStep = async () => {
  const { context, paused } = await pausedAtGate();
  const crashing = createCrashingRunService(context.agentRunService, {
    crashBefore: (method, args) => method === "recordRunStep" && args.input?.nodeId === "task",
  });

  await assert.rejects(
    decide({
      ...context,
      action: "approve",
      agentRunService: crashing.service,
      gate: paused.body.approvalGates[0],
      runId: paused.body.agentRunId,
    }),
    isSimulatedExit
  );
  assert.equal(context.writes.length, 0);

  return readOnlyRun(context.store);
};

const capabilityStepInFlight = async () => {
  const { context, paused } = await pausedAtGate();
  const crashing = createCrashingRunService(context.agentRunService);
  const { registry, writes } = await createTaskCapabilityRegistry({
    onWrite: async () => {
      crashing.state.crashed = true;
    },
    ragService: context.ragService,
  });

  await assert.rejects(
    decide({
      ...context,
      action: "approve",
      agentRunService: crashing.service,
      gate: paused.body.approvalGates[0],
      registry,
      runId: paused.body.agentRunId,
    }),
    isSimulatedExit
  );
  assert.equal(writes.length, 1);

  return readOnlyRun(context.store);
};

// The task description bound to an empty upstream output: task.create's
// policy refuses it, the node fails, the graph ends partial and the run fails.
const failedPartial = async () => {
  const context = await setupApproval({
    proposal: () => {
      const proposal = createApprovalGatedTaskProposal();
      const task = proposal.nodes.find((node) => node.nodeId === "task");

      task.inputBindings.description = {
        nodeId: "evidence_check",
        output: "followUpQuestion",
        source: "node",
      };

      return proposal;
    },
  });

  await assert.rejects(
    askApproval(context),
    (error) => error.code === "AGENT_UNIFIED_GRAPH_PARTIAL"
  );

  return readOnlyRun(context.store);
};

// --- a background task parked at the same kind of gate --------------------

const taskParkedAtGate = async () => {
  const context = await setupApproval();
  const taskId = "agent_goal:stored-unified-graph-gate";
  const taskStore = createInMemoryTaskStore();
  const taskService = createTaskService({ taskStore });
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
        agentRunService: context.agentRunService,
        capabilityRegistry: context.registry,
        ragService: context.ragService,
        unifiedGraphAllowedCapabilityIds: ["task.create"],
        unifiedGraphPlannerAdapter: createProposalAdapter(createApprovalGatedTaskProposal),
      }),
  });
  const orchestrator = createJobOrchestrator({ runners: { [runner.id]: runner }, taskService });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: taskId,
      input: {
        docIds: [UNIFIED_DOC_ID],
        maxIterations: 3,
        question: APPROVAL_TASK_QUESTION,
        sessionId: UNIFIED_SESSION_ID,
        userId: accessScope.userId,
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: [UNIFIED_DOC_ID],
        iterations: [],
        maxIterations: 3,
        question: APPROVAL_TASK_QUESTION,
        sessionId: UNIFIED_SESSION_ID,
        userId: accessScope.userId,
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });
  await orchestrator.runTask({ accessScope, taskId });

  const task = await taskService.getInternalTask({ accessScope, taskId });

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.requiredUserAction, "approve_capability");

  return { run: await readOnlyRun(context.store), task: structuredClone(task) };
};

// --------------------------------------------------------------------------

const describeRun = (run) => {
  const checkpoint = run.result?.[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY] ?? null;

  return {
    checkpointPhase: checkpoint?.phase ?? null,
    checkpointVersion: checkpoint?.version ?? null,
    graphVersion: checkpoint?.graph?.version ?? null,
    hasFinalization: checkpoint ? checkpoint.finalization !== undefined : null,
    hasLangGraphRecord: Boolean(run.result?.__langGraphCheckpoint),
    pendingGates: (run.approvalGates ?? []).filter((gate) => gate.status === "pending").length,
    status: run.status,
    stepStatuses: (run.steps ?? []).map((step) => `${step.type}:${step.status}`),
  };
};

const clarification = await settledDocument({ primary: "unsupported" });
const completed = await settledDocument({ primary: "supported" });
const parkedTask = await taskParkedAtGate();

assert.equal(clarification.response.body.agentMode, "clarification");
assert.equal(completed.response.body.agentMode, "document");

const runs = {
  // The graph parked at its approval gate; the run waits for the decision.
  // It is the run of the background task below.
  parked_at_approval_gate: parkedTask.run,
  // The gate was approved, the process died before the Capability's step.
  approved_before_capability_step: await approvedBeforeCapabilityStep(),
  // The approved Capability wrote, the process died before its receipt.
  capability_step_in_flight: await capabilityStepInFlight(),
  // The process died between two nodes (the answer settled, its check did not run).
  interrupted_at_node_boundary: await crashedDocument({
    crashAfter: (method, args) =>
      method === "saveExecutionGraphCheckpoint" &&
      (args.checkpoint?.nodeRuns ?? []).some((nodeRun) => nodeRun.nodeId === "primary") &&
      !(args.checkpoint?.nodeRuns ?? []).some((nodeRun) => nodeRun.nodeId === "primary_check"),
  }),
  // The finalization receipt was written; the process died before the run completed.
  receipt_written_run_not_completed: await crashedDocument({
    crashAfter: (method, args) =>
      method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
  }),
  // Finalized as a question for the user: settled, the run waits for an answer.
  finalized_as_clarification: clarification.run,
  // Finalized with an answer.
  completed: completed.run,
  // A node failed: the graph ended partial and the run failed.
  failed_partial: await failedPartial(),
};

// What the store gives back for a record put in with `create` is that record.
for (const [name, run] of Object.entries(runs)) {
  const store = createInMemoryAgentRunStore();

  await store.create({ accessScope, run: structuredClone(run) });
  assert.deepEqual(await store.get({ accessScope, runId: run.runId }), run, name);
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const fixture = {
  provenance: {
    // The commit whose v3 code wrote these records.
    codeAtCommit: commit,
    note:
      "Run-store records written by the v3 unified graph under AGENT_UNIFIED_GRAPH_ROLLOUT=guarded " +
      "(mock providers), read back with the in-memory store's get(). The script that wrote them, " +
      "test/fixtures/stored-unified-graph-runs.generate.mjs, exists only in the commit that added " +
      "this file: it needs the v3 code and was deleted with it (ADR 0001 phase 10).",
  },
  accessScope,
  runs,
  task: parkedTask.task,
};

// One record per line: the records are data, not prose, and are read by name.
const line = (value) => JSON.stringify(value);

writeFileSync(
  OUTPUT,
  [
    "{",
    `  "provenance": ${JSON.stringify(fixture.provenance, null, 2).replaceAll("\n", "\n  ")},`,
    `  "accessScope": ${line(fixture.accessScope)},`,
    '  "runs": {',
    Object.entries(fixture.runs)
      .map(([name, run]) => `    ${line(name)}: ${line(run)}`)
      .join(",\n"),
    "  },",
    `  "task": ${line(fixture.task)}`,
    "}",
    "",
  ].join("\n")
);
assert.deepEqual(JSON.parse(readFileSync(OUTPUT, "utf8")), JSON.parse(JSON.stringify(fixture)));

for (const [name, run] of Object.entries(runs)) {
  console.log(name, JSON.stringify(describeRun(run)));
}
console.log("task", parkedTask.task.status, parkedTask.task.requiredUserAction);
console.log("wrote", OUTPUT);
