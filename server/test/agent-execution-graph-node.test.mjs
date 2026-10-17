import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  createExecutionGraph,
} from "../rag/agent-execution-graph.js";
import {
  EXECUTION_GRAPH_NODE_OUTCOMES,
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_RUN_STATUSES,
  EXECUTION_GRAPH_SCHEDULE_DECISIONS,
  EXECUTION_GRAPH_SKIP_REASONS,
  buildExecutionGraphNodeRun,
  buildExecutionGraphRunResult,
  buildRejectedExecutionGraphRun,
  createExecutionGraphNodeContext,
  createExecutionGraphNodeStates,
  createExecutionGraphRunControl,
  createExecutionGraphStepLifecycle,
  decideExecutionGraphNode,
  isExecutionGraphNodeConditionMet,
  isExecutionGraphNodeSettledOk,
  prepareExecutionGraphNodeLaunch,
  runExecutionGraphNode,
} from "../rag/agent-execution-graph-node.js";
import * as runnerModule from "../rag/agent-execution-graph-runner.js";
import { AGENT_INTERRUPT_TYPES, AgentRunInterruptError } from "../rag/agent-interrupts.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { CUSTOM_RAG_SKILL_CONTRACT } from "../rag/skills/custom/custom-skill-contract.js";

// The per-node half of a graph run, exercised directly. The scheduler
// (LangGraph, runExecutionGraphOnLangGraph) drives nodes through exactly these
// functions, so what they promise on their own -- which flag is raised when,
// which status a node is in while its checkpoint is written, what a launch
// returns -- is the contract it builds on. The scheduler's own behaviour is
// pinned by agent-execution-graph-runner.test.mjs.
//
// Timing is asserted with deferred promises, never with elapsed milliseconds.

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createSkill = ({
  budgetKey = "customSkillCalls",
  execute = async () => ({ abstained: false, citations: [], text: "Answer" }),
  id,
  kind = "custom",
  parallelSafe,
}) => ({
  ...CUSTOM_RAG_SKILL_CONTRACT,
  budgetKey,
  execute,
  id,
  kind,
  label: `Skill ${id}`,
  match: () => true,
  requiresAccessScope: true,
  version: "1.0.0",
  ...(parallelSafe === undefined ? {} : { parallelSafe }),
});

const createRegistry = (skills) => {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return { get: (skillId) => byId.get(skillId) ?? null };
};

const requestField = (field) => ({ field, source: "request" });

const node = ({
  dependsOn = [],
  failurePolicy = EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
  nodeId,
  scope,
  skillId = nodeId,
  when,
}) => ({
  dependsOn,
  failurePolicy,
  inputBindings: { docIds: requestField("docIds"), question: requestField("question") },
  nodeId,
  rationale: `Run ${nodeId}.`,
  skillId,
  ...(scope === undefined ? {} : { scope }),
  ...(when === undefined ? {} : { when }),
});

// One graph, its node states and a context wired to recording hooks.
const createNodeRun = ({
  budgetState = createAgentBudget(),
  docIds = ["doc-1"],
  graph,
  onNodeSettled,
  preflightNode,
  skills,
  stepLifecycle,
}) => {
  const calls = [];
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const registry = createRegistry(skills);
  const { nodeOutputs, states, statesByNodeId } = createExecutionGraphNodeStates({
    graph,
    registry,
  });
  const context = createExecutionGraphNodeContext({
    accessScope: { userId: "alice", workspaceId: "acme" },
    addBudgetLimitTrace: (step) => calls.push(["budgetLimit", step.tool]),
    addTraceStep: (step) => calls.push(["trace", step.id, step.status]),
    authorizedDocIds: docIds,
    budgetState,
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    docIds,
    executeObservedSkill: tracker.executeObservedSkill,
    graph,
    onNodeSettled,
    preflightNode,
    question: "Review the contract.",
    recordSkillResult: (result) => calls.push(["result", result.skillId, result.ok]),
    recordSkippedSkill: (entry) => calls.push(["skipped", entry.skill.id, entry.budget?.ok ?? null]),
    stepLifecycle: stepLifecycle ?? {
      completeStep: async (step) => calls.push(["complete", step.id]),
      failStep: async (step) => calls.push(["fail", step.id]),
      pauseStep: async (step) => calls.push(["pause", step.id]),
      startStep: async (step) => calls.push(["start", step.id]),
    },
    userId: "alice",
  });

  return {
    budgetState,
    calls,
    context,
    control: createExecutionGraphRunControl(),
    nodeOutputs,
    states,
    statesByNodeId,
  };
};

test("the runner re-exports the node module's status vocabularies unchanged", () => {
  assert.equal(runnerModule.EXECUTION_GRAPH_NODE_STATUSES, EXECUTION_GRAPH_NODE_STATUSES);
  assert.equal(runnerModule.EXECUTION_GRAPH_SKIP_REASONS, EXECUTION_GRAPH_SKIP_REASONS);
  assert.equal(runnerModule.EXECUTION_GRAPH_RUN_STATUSES, EXECUTION_GRAPH_RUN_STATUSES);
});

test("decideExecutionGraphNode applies the scheduler's precedence of skip reasons", () => {
  const { completed, failed, pending, reused, running, skipped } = EXECUTION_GRAPH_NODE_STATUSES;
  const { hold, launch, skip, wait } = EXECUTION_GRAPH_SCHEDULE_DECISIONS;
  const conditional = node({
    dependsOn: ["check"],
    nodeId: "follow-up",
    when: { equals: true, nodeId: "check", output: "retryRecommended" },
  });
  const decide = (overrides) =>
    decideExecutionGraphNode({
      dependencyStatuses: [],
      graphVersion: "v2",
      node: node({ nodeId: "n" }),
      nodeOutputs: new Map(),
      ...overrides,
    });

  // A failed dependency wins over a skipped one, both over waiting.
  assert.deepEqual(decide({ dependencyStatuses: [skipped, failed, running] }), {
    decision: skip,
    reason: EXECUTION_GRAPH_SKIP_REASONS.dependencyFailed,
  });
  assert.deepEqual(decide({ dependencyStatuses: [running, skipped] }), {
    decision: skip,
    reason: EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped,
  });

  // Anything not completed/reused waits, an unknown dependency included.
  for (const status of [pending, running, EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval, undefined]) {
    assert.deepEqual(decide({ dependencyStatuses: [completed, status] }), { decision: wait, reason: null });
  }

  // Waiting is decided before an abort: a node behind running work is not
  // skipped until that work settles.
  assert.equal(decide({ aborted: true, dependencyStatuses: [running] }).decision, wait);

  // A pending interrupt holds a v3 node at a clean boundary and skips a v2 one.
  assert.deepEqual(decide({ dependencyStatuses: [reused], graphVersion: "v3", interrupted: true }), {
    decision: hold,
    reason: null,
  });
  assert.deepEqual(decide({ dependencyStatuses: [reused], interrupted: true }), {
    decision: skip,
    reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure,
  });
  assert.deepEqual(decide({ aborted: true, graphVersion: "v3" }), {
    decision: skip,
    reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure,
  });

  // The condition reads the dependency's validated output, strictly.
  const decideWhen = (output) =>
    decide({
      dependencyStatuses: [completed],
      node: conditional,
      nodeOutputs: new Map(output === undefined ? [] : [["check", output]]),
    });
  assert.deepEqual(decideWhen({ retryRecommended: false }), {
    decision: skip,
    reason: EXECUTION_GRAPH_SKIP_REASONS.conditionNotMet,
  });
  assert.equal(decideWhen({ retryRecommended: "true" }).decision, skip);
  assert.equal(decideWhen(undefined).decision, skip);
  assert.deepEqual(decideWhen({ retryRecommended: true }), { decision: launch, reason: null });
  assert.equal(isExecutionGraphNodeConditionMet({ node: node({ nodeId: "n" }), nodeOutputs: new Map() }), true);

  assert.equal(isExecutionGraphNodeSettledOk(completed), true);
  assert.equal(isExecutionGraphNodeSettledOk(reused), true);
  assert.equal(isExecutionGraphNodeSettledOk(skipped), false);
});

test("createExecutionGraphNodeStates keeps declaration order and the v1/v3 step identities", () => {
  const skills = [createSkill({ id: "a" }), createSkill({ id: "b" })];
  const registry = createRegistry(skills);

  for (const [version, stepIdOf, stepType] of [
    ["v2", (nodeId) => `custom_skill:${nodeId}`, "custom_skill"],
    ["v3", (nodeId) => `agent_graph_node:${Buffer.from(nodeId).toString("base64url")}`, "graph_node"],
  ]) {
    const graph = createExecutionGraph({
      nodes: [node({ nodeId: "b:second", skillId: "b" }), node({ nodeId: "a", skillId: "a" })],
      version,
    });
    const { nodeOutputs, states, statesByNodeId } = createExecutionGraphNodeStates({ graph, registry });

    assert.deepEqual(
      states.map(({ contract, node: graphNode, reason, result, skill, status, stepId, stepType: type }) => ({
        contractId: contract.id,
        nodeId: graphNode.nodeId,
        reason,
        result,
        skill: skill.id,
        status,
        stepId,
        type,
      })),
      [
        { contractId: "b", nodeId: "b:second", reason: null, result: null, skill: "b", status: "pending", stepId: stepIdOf("b:second"), type: stepType },
        { contractId: "a", nodeId: "a", reason: null, result: null, skill: "a", status: "pending", stepId: stepIdOf("a"), type: stepType },
      ]
    );
    assert.equal(statesByNodeId.get("a"), states[1]);
    assert.equal(nodeOutputs.size, 0);
  }
});

test("createExecutionGraphNodeStates reuses a checkpointed run and fails closed on a tampered one", async () => {
  const graph = createExecutionGraph({ nodes: [node({ nodeId: "a" }), node({ nodeId: "b", dependsOn: ["a"] })] });
  const first = createNodeRun({ graph, onNodeSettled: async () => {}, skills: [createSkill({ id: "a" }), createSkill({ id: "b" })] });
  await runExecutionGraphNode({ ...first, state: first.states[0] });
  const completedRun = buildExecutionGraphNodeRun(first.states[0]);
  const registry = createRegistry([createSkill({ id: "a" }), createSkill({ id: "b" })]);

  const { nodeOutputs, states } = createExecutionGraphNodeStates({
    completedNodeRuns: [completedRun, { ...completedRun, nodeId: "retired" }],
    graph,
    registry,
  });
  assert.equal(states[0].status, EXECUTION_GRAPH_NODE_STATUSES.reused);
  assert.equal(states[0].result, completedRun.result);
  assert.deepEqual(nodeOutputs.get("a"), completedRun.result.graphOutput);
  assert.equal(states[1].status, EXECUTION_GRAPH_NODE_STATUSES.pending);

  for (const tampered of [
    { ...completedRun, result: { ...completedRun.result, text: "Another answer" } },
    { ...completedRun, status: EXECUTION_GRAPH_NODE_STATUSES.failed },
    { ...completedRun, skillVersion: "2.0.0" },
  ]) {
    assert.throws(
      () => createExecutionGraphNodeStates({ completedNodeRuns: [tampered], graph, registry }),
      (error) => error.code === "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" && error.status === 409
    );
  }
});

test("createExecutionGraphNodeStates settles a denied node and refuses one that is unknown or settled", async () => {
  const graph = createExecutionGraph({ nodes: [node({ nodeId: "a" }), node({ nodeId: "b" })], version: "v3" });
  const registry = createRegistry([createSkill({ id: "a" }), createSkill({ id: "b" })]);
  const { states } = createExecutionGraphNodeStates({ deniedNodeIds: ["b"], graph, registry });

  assert.deepEqual(
    states.map(({ reason, status }) => ({ reason, status })),
    [
      { reason: null, status: "pending" },
      { reason: EXECUTION_GRAPH_SKIP_REASONS.approvalDenied, status: "skipped" },
    ]
  );

  const first = createNodeRun({ graph, onNodeSettled: async () => {}, skills: [createSkill({ id: "a" }), createSkill({ id: "b" })] });
  await runExecutionGraphNode({ ...first, state: first.states[0] });

  for (const options of [
    { deniedNodeIds: ["missing"] },
    { completedNodeRuns: [buildExecutionGraphNodeRun(first.states[0])], deniedNodeIds: ["a"] },
  ]) {
    assert.throws(
      () => createExecutionGraphNodeStates({ ...options, graph, registry }),
      (error) => error.code === "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY"
    );
  }
});

test("prepareExecutionGraphNodeLaunch marks the node running and gates a narrowed-away scope", () => {
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "a", scope: { docIds: ["doc-1"] } })],
    version: "v2",
  });
  const run = createNodeRun({
    docIds: ["doc-2"],
    graph,
    skills: [createSkill({ id: "a" })],
  });
  const [state] = run.states;
  const launch = prepareExecutionGraphNodeLaunch({ context: run.context, nodeOutputs: run.nodeOutputs, state });

  assert.equal(state.status, EXECUTION_GRAPH_NODE_STATUSES.running);
  assert.deepEqual(launch.nodeDocIds, []);
  assert.equal(launch.inputValidation.ok, false);
  assert.ok(launch.inputValidation.errors.includes("scoped docIds must contain at least one document"));
  assert.deepEqual(launch.persistedInput, {
    boundInputs: { docIds: ["doc-2"], question: "Review the contract." },
    docIds: [],
    effects: "read_only",
    graphVersion: "v2",
    idempotency: "read_only_rag",
    nodeId: "a",
    question: "Review the contract.",
    replaySafe: true,
    retrievalPlan: undefined,
    sessionId: null,
    skillId: "a",
    skillVersion: "1.0.0",
    userId: "alice",
  });
  assert.equal(run.calls.length, 0, "preparing a launch calls no hook");
});

test("a settled node writes its checkpoint while still running, then publishes its output", async () => {
  const graph = createExecutionGraph({ nodes: [node({ nodeId: "a" })] });
  const seen = [];
  const run = createNodeRun({
    graph,
    onNodeSettled: async ({ nodeRun }) => {
      seen.push({ nodeRun: nodeRun.status, state: run.states[0].status });
    },
    skills: [createSkill({ id: "a" })],
  });

  const outcome = await runExecutionGraphNode({ ...run, state: run.states[0] });

  assert.equal(outcome, EXECUTION_GRAPH_NODE_OUTCOMES.settled);
  assert.deepEqual(seen, [{ nodeRun: "completed", state: "running" }]);
  assert.equal(run.states[0].status, EXECUTION_GRAPH_NODE_STATUSES.completed);
  assert.deepEqual(run.nodeOutputs.get("a"), run.states[0].result.graphOutput);
  assert.deepEqual(run.calls, [
    ["start", "custom_skill:a"],
    ["complete", "custom_skill:a"],
    ["result", "a", true],
    ["trace", "custom_skill:a", "completed"],
  ]);
  assert.equal(run.budgetState.used.customSkillCalls, 1);
  assert.deepEqual(run.control, { aborted: false, fatalError: null, interrupt: null });
});

test("a fail_fast failure raises control.aborted before its checkpoint write resolves", async () => {
  const graph = createExecutionGraph({ nodes: [node({ nodeId: "a" })] });
  const settle = createDeferred();
  const entered = createDeferred();
  const run = createNodeRun({
    graph,
    onNodeSettled: async () => {
      entered.resolve();
      await settle.promise;
    },
    skills: [createSkill({ execute: async () => { throw new Error("broken"); }, id: "a" })],
  });

  const launched = runExecutionGraphNode({ ...run, state: run.states[0] });
  await entered.promise;

  // A sibling that settles now wakes the scheduler, which must already skip
  // the rest; the failed node itself still looks running.
  assert.equal(run.control.aborted, true);
  assert.equal(run.states[0].status, EXECUTION_GRAPH_NODE_STATUSES.running);
  assert.equal(run.nodeOutputs.has("a"), false);

  settle.resolve();
  assert.equal(await launched, EXECUTION_GRAPH_NODE_OUTCOMES.settled);
  assert.equal(run.states[0].status, EXECUTION_GRAPH_NODE_STATUSES.failed);
});

test("an AgentRunInterruptError returns the node to pending, hands back its budget and lands on control", async () => {
  const graph = createExecutionGraph({ nodes: [node({ nodeId: "a" })] });
  const interrupt = new AgentRunInterruptError({ type: AGENT_INTERRUPT_TYPES.capabilityApprovalRequired });
  let settled = 0;
  const run = createNodeRun({
    graph,
    onNodeSettled: async () => { settled += 1; },
    skills: [createSkill({ execute: async () => { throw interrupt; }, id: "a" })],
  });

  const outcome = await runExecutionGraphNode({ ...run, state: run.states[0] });

  assert.equal(outcome, EXECUTION_GRAPH_NODE_OUTCOMES.interrupted);
  assert.equal(run.control.interrupt, interrupt);
  assert.equal(run.control.aborted, false);
  assert.equal(run.states[0].status, EXECUTION_GRAPH_NODE_STATUSES.pending);
  assert.equal(run.states[0].result, null);
  assert.equal(run.budgetState.used.customSkillCalls, 0);
  assert.equal(settled, 0);
  assert.deepEqual(run.calls, [["start", "custom_skill:a"], ["pause", "custom_skill:a"]]);
});

test("an exhausted budget skips the node before any lifecycle step", async () => {
  const graph = createExecutionGraph({ nodes: [node({ nodeId: "a" })] });
  const run = createNodeRun({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 0 }),
    graph,
    skills: [createSkill({ id: "a" })],
  });

  const outcome = await runExecutionGraphNode({ ...run, state: run.states[0] });

  assert.equal(outcome, EXECUTION_GRAPH_NODE_OUTCOMES.skipped);
  assert.deepEqual(
    { reason: run.states[0].reason, status: run.states[0].status },
    { reason: EXECUTION_GRAPH_SKIP_REASONS.budgetExhausted, status: "skipped" }
  );
  assert.deepEqual(run.calls, [["skipped", "a", false], ["budgetLimit", "Skill a"]]);
});

test("a preflight park holds no step, no budget and no output", async () => {
  const graph = createExecutionGraph({ nodes: [node({ nodeId: "write" })], version: "v3" });
  const run = createNodeRun({
    graph,
    preflightNode: async () => ({ awaitingApproval: true }),
    skills: [createSkill({ id: "write", kind: "capability", parallelSafe: false })],
  });

  const outcome = await runExecutionGraphNode({ ...run, state: run.states[0] });

  assert.equal(outcome, EXECUTION_GRAPH_NODE_OUTCOMES.awaitingApproval);
  assert.equal(run.states[0].status, EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval);
  assert.deepEqual(run.states[0].awaiting.boundInputs, { docIds: ["doc-1"], question: "Review the contract." });
  assert.deepEqual(run.calls, []);
  assert.equal(run.budgetState.used.customSkillCalls, 0);
});

test("a lifecycle error leaves the node pending and rejects without touching control", async () => {
  const graph = createExecutionGraph({ nodes: [node({ nodeId: "a" })] });
  const run = createNodeRun({
    graph,
    skills: [createSkill({ id: "a" })],
    stepLifecycle: {
      startStep: async () => {
        throw Object.assign(new Error("fenced"), { code: "AGENT_GRAPH_EXECUTION_FENCED" });
      },
    },
  });

  await assert.rejects(
    runExecutionGraphNode({ ...run, state: run.states[0] }),
    (error) => error.code === "AGENT_GRAPH_EXECUTION_FENCED"
  );
  assert.equal(run.states[0].status, EXECUTION_GRAPH_NODE_STATUSES.pending);
  assert.deepEqual(run.control, { aborted: false, fatalError: null, interrupt: null });
});

test("runExecutionGraphNode turns a throw in the synchronous half into a rejection", async () => {
  const graph = createExecutionGraph({ nodes: [{ ...node({ nodeId: "a" }), inputBindings: { question: null } }] });
  const run = createNodeRun({ graph, skills: [createSkill({ id: "a" })] });

  await assert.rejects(runExecutionGraphNode({ ...run, state: run.states[0] }), TypeError);
  assert.equal(run.states[0].status, EXECUTION_GRAPH_NODE_STATUSES.pending);
  assert.deepEqual(run.calls, []);
});

test("createExecutionGraphStepLifecycle fences every transition only under a resume claim", async () => {
  const transitions = [];
  const stepLifecycle = {
    completeGraphStep: async (step) => (transitions.push(["completeGraphStep", step]), true),
    failGraphStep: async () => null,
    startGraphStep: async (step) => (transitions.push(["startGraphStep", step]), true),
    startStep: async () => true,
  };

  assert.equal(createExecutionGraphStepLifecycle({ stepLifecycle }), stepLifecycle);

  for (const claim of ["claim-1", null]) {
    transitions.length = 0;
    const fenced = createExecutionGraphStepLifecycle({ graphResumeClaimId: claim, stepLifecycle });

    assert.equal(await fenced.startStep({ id: "s" }), true);
    assert.equal(await fenced.completeStep({ id: "s" }), true);
    assert.deepEqual(transitions, [
      ["startGraphStep", { expectedResumeClaimId: claim, id: "s" }],
      ["completeGraphStep", { expectedResumeClaimId: claim, id: "s" }],
    ]);
    // An unrecorded transition and a missing fenced method both stop the node.
    await assert.rejects(fenced.failStep({ id: "s" }), (error) =>
      error.code === "AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE" && error.status === 409
    );
    await assert.rejects(fenced.pauseStep({ id: "s" }), (error) =>
      error.code === "AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE" && error.status === 409
    );
  }
});

test("createExecutionGraphNodeContext applies the scheduler's defaults and is frozen", () => {
  const context = createExecutionGraphNodeContext({
    authorizedDocIds: ["doc-1", "doc-2"],
    docIds: ["doc-1"],
    graph: createExecutionGraph({ nodes: [] }),
    question: "Q",
    retrievalPlan: null,
    stepLifecycle: {},
  });

  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual([...context.authorizedDocIdSet], ["doc-1", "doc-2"]);
  assert.deepEqual([...context.requestedDocIdSet], ["doc-1"]);
  assert.deepEqual(context.requestValues, { docIds: ["doc-1"], question: "Q", retrievalPlan: undefined });
  assert.equal(context.preflightNode, null);
  assert.equal(context.graphResumeClaimId, undefined);
  assert.deepEqual(
    context.buildSkillTraceDetail({ skillId: "s", skillVersion: "1" }, { nodeId: "n" }),
    { nodeId: "n", skillId: "s", skillVersion: "1" }
  );
  for (const hook of ["addBudgetLimitTrace", "addTraceStep", "onNodeSettled", "recordSkillResult", "recordSkippedSkill"]) {
    assert.equal(context[hook](), undefined);
  }
  // Without authorizedDocIds the request itself is the authorized scope.
  assert.deepEqual(
    [...createExecutionGraphNodeContext({ docIds: ["doc-9"], graph: { version: "v2" } }).authorizedDocIdSet],
    ["doc-9"]
  );
});

test("buildExecutionGraphRunResult completes over benign skips and is partial otherwise", async () => {
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "a" }),
      node({ dependsOn: ["a"], nodeId: "b", when: { equals: true, nodeId: "a", output: "abstained" } }),
      node({ dependsOn: ["b"], nodeId: "c" }),
    ],
    version: "v2",
  });
  const run = createNodeRun({
    graph,
    skills: ["a", "b", "c"].map((id) => createSkill({ id })),
  });
  await runExecutionGraphNode({ ...run, state: run.states[0] });
  run.states[1].status = EXECUTION_GRAPH_NODE_STATUSES.skipped;
  run.states[1].reason = EXECUTION_GRAPH_SKIP_REASONS.conditionNotMet;
  run.states[2].status = EXECUTION_GRAPH_NODE_STATUSES.skipped;
  run.states[2].reason = EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped;

  const completed = buildExecutionGraphRunResult({ graph, ...run });
  assert.deepEqual(
    { ...completed, nodeRuns: completed.nodeRuns.map(({ nodeId, status }) => [nodeId, status]) },
    {
      errors: [],
      graphVersion: "v2",
      nodeRuns: [["a", "completed"], ["b", "skipped"], ["c", "skipped"]],
      ok: true,
      results: [run.states[0].result],
      status: EXECUTION_GRAPH_RUN_STATUSES.completed,
    }
  );
  assert.deepEqual(Object.keys(completed), ["errors", "graphVersion", "nodeRuns", "ok", "results", "status"]);

  run.states[1].reason = EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure;
  const partial = buildExecutionGraphRunResult({ graph, ...run });
  assert.equal(partial.status, EXECUTION_GRAPH_RUN_STATUSES.partial);
  assert.equal(partial.ok, false);

  assert.deepEqual(buildRejectedExecutionGraphRun({ errors: [{ code: "x" }], graph: undefined }), {
    errors: [{ code: "x" }],
    graphVersion: null,
    nodeRuns: [],
    ok: false,
    results: [],
    status: EXECUTION_GRAPH_RUN_STATUSES.rejected,
  });
});
