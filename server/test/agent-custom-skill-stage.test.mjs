import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget, getRemainingBudget } from "../rag/agent-budget.js";
import {
  AGENT_SKILL_GRAPH_REJECTED_CODE,
  CUSTOM_SKILL_GRAPH_MODE,
  runCustomSkillStage,
} from "../rag/agent-custom-skill-stage.js";
import {
  AGENT_INTERRUPT_TYPES,
  AgentRunInterruptError,
} from "../rag/agent-interrupts.js";
import { DAG_PLANNER_IDS } from "../rag/agent-dag-planner-adapter.js";
import { EXECUTION_GRAPH_REASON_CODES } from "../rag/agent-execution-graph.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { REPLAN_DECISIONS, REPLAN_REASON_CODES } from "../rag/agent-replanner.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { CUSTOM_RAG_SKILL_CONTRACT } from "../rag/skills/custom/custom-skill-contract.js";
import { AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE } from "../rag/config.js";
import { createSkillRegistry } from "../rag/skills/registry.js";

// The custom_skills stage plans a typed DAG and has LangGraph run it; nothing
// else runs a custom Skill (the V1 sequential chain and the
// AGENT_SKILL_GRAPH_ROLLOUT values that selected it were deleted in ADR 0001
// phase 8). These tests are about what the rest of the run depends on: the
// step type, the step id shape, the flat result array, the rule that a skill
// runs once per request, how a node receives its inputs (typed bindings, never
// a concatenated question), and what the stage does when a graph cannot simply
// run every selected Skill: the budget covers only some, or the graph is
// rejected before any node ran.

// ---------------------------------------------------------------------------
// Harness
//
// Concurrency is asserted with a barrier, never with elapsed milliseconds: a
// timing assertion would pass on an idle machine and flake on a busy one, and
// it would not prove that two nodes were actually in flight together.
// ---------------------------------------------------------------------------

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const createBarrier = (size) => {
  const arrivals = [];
  const opened = createDeferred();

  return {
    arrivals,
    arrive: (nodeId) => {
      arrivals.push(nodeId);

      if (arrivals.length >= size) {
        opened.resolve(arrivals);
      }

      return opened.promise;
    },
  };
};

const createTestSkill = ({
  effects,
  execute,
  id,
  label = id,
  parallelSafe,
}) => ({
  ...CUSTOM_RAG_SKILL_CONTRACT,
  budgetKey: "customSkillCalls",
  execute,
  id,
  kind: "custom",
  label,
  match: () => true,
  requiresAccessScope: true,
  version: "1.0.0",
  ...(effects === undefined ? {} : { effects }),
  ...(parallelSafe === undefined ? {} : { parallelSafe }),
});

/**
 * A skill that records every context it was handed and answers with one
 * citation. The recorded calls are how these tests tell a typed binding from a
 * concatenated question, and how they count executions across a fallback or a
 * replan.
 */
const createRecordingSkill = ({ id, label = id, respond }) => {
  const calls = [];
  const skill = createTestSkill({
    execute: async (context) => {
      calls.push(context);

      return respond
        ? respond(context, calls.length)
        : {
            abstained: false,
            citations: [{ docId: context.docIds?.[0] ?? "doc-1", page: 1 }],
            text: `${label} answered.`,
          };
    },
    id,
    label,
  });

  return { calls, skill };
};

const createHarness = ({ budget = {}, skills } = {}) => {
  const budgetState = createAgentBudget(budget);
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const trace = [];
  const budgetNotes = [];
  const graphRecords = [];
  const skillList = skills.map(({ skill }) => skill);

  return {
    budgetNotes,
    budgetState,
    graphRecords,
    options: {
      accessScope: {
        authProvider: "local",
        authenticated: true,
        userId: "alice",
        workspaceId: "workspace-a",
      },
      addBudgetLimitTrace: (note) => budgetNotes.push(note),
      addTraceStep: (step) => trace.push(step),
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      customSkills: skillList,
      docIds: ["doc-1", "doc-2"],
      executeObservedSkill: tracker.executeObservedSkill,
      plan: { mode: SKILL_CHAIN_MODE },
      question: "Compare these contracts and flag the risks.",
      ragService: {},
      recordExecutionGraph: (record) => graphRecords.push(record),
      recordSkillResult: tracker.recordSkillResult,
      recordSkippedSkill: tracker.recordSkippedSkill,
      registry: createSkillRegistry(skillList),
      retrievalPlan: { retrievalQueries: [{ id: "primary", query: "risks" }] },
      sessionId: "session-1",
      stepLifecycle: undefined,
      userId: "alice",
    },
    trace,
    tracker,
  };
};

/** A planner adapter that proposes a fixed node list, V2-style. */
const stubPlanner = (nodes, id = "test_dag") => ({
  createExecutionGraph: () => ({ nodes }),
  id,
});

const requestField = (field) => ({ field, source: "request" });
const nodeOutput = (nodeId, output) => ({ nodeId, output, source: "node" });

const readOnlyNode = ({ dependsOn = [], inputBindings, nodeId, skillId }) => ({
  dependsOn,
  failurePolicy: "continue",
  inputBindings: inputBindings ?? {
    docIds: requestField("docIds"),
    question: requestField("question"),
  },
  nodeId,
  rationale: `Run ${nodeId}.`,
  skillId,
});

const stepIds = (trace) => trace.map((step) => step.id);

// Runs `work` with AGENT_SKILL_GRAPH_ROLLOUT set to `value` (undefined: unset).
const withRolloutVariable = async (value, work) => {
  const previous = process.env.AGENT_SKILL_GRAPH_ROLLOUT;

  if (value === undefined) {
    delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  } else {
    process.env.AGENT_SKILL_GRAPH_ROLLOUT = value;
  }

  try {
    return await work();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = previous;
    }
  }
};

// ---------------------------------------------------------------------------
// One executor: the graph
// ---------------------------------------------------------------------------

// AGENT_SKILL_GRAPH_ROLLOUT selects nothing any more. Unset and the one value
// left (`guarded`) run the same graph and record the same event.
test("the stage runs the graph with the rollout variable unset or set to guarded", async () => {
  for (const value of [undefined, "guarded", " Guarded "]) {
    const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
    const harness = createHarness({ skills: [compare] });

    const results = await withRolloutVariable(value, () =>
      runCustomSkillStage({
        ...harness.options,
        plannerAdapter: stubPlanner([
          readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
        ]),
      })
    );

    assert.equal(results.length, 1, String(value));
    assert.equal(harness.graphRecords.length, 1, String(value));
    assert.equal(harness.graphRecords[0].mode, "guarded", String(value));
    assert.equal(CUSTOM_SKILL_GRAPH_MODE, "guarded");
    assert.equal(harness.graphRecords[0].executed, true, String(value));
    assert.equal(harness.graphRecords[0].fallback, null, String(value));
    assert.deepEqual(stepIds(harness.trace), ["custom_skill:compare"], String(value));
  }
});

// `off` and `shadow` selected the sequential chain. The stage does not quietly
// run the graph for an operator who asked for the chain: it refuses before the
// executor is loaded, before a checkpoint is read or written, and before any
// Skill runs. (A typo used to resolve to `off`; it refuses too.)
test("the stage refuses a removed rollout value before anything durable exists", async () => {
  for (const value of ["off", "shadow", " OFF ", "gaurded"]) {
    const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
    const harness = createHarness({ skills: [compare] });
    const touched = [];

    await assert.rejects(
      withRolloutVariable(value, () =>
        runCustomSkillStage({
          ...harness.options,
          loadExecutionGraphCheckpoint: async () => {
            touched.push("load");
            return null;
          },
          saveExecutionGraphCheckpoint: async () => {
            touched.push("save");
          },
        })
      ),
      (error) => {
        assert.equal(error.code, AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE, value);
        assert.match(error.message, /Unset AGENT_SKILL_GRAPH_ROLLOUT or set it to guarded\.$/u, value);
        return true;
      }
    );

    assert.deepEqual(touched, [], value);
    assert.equal(compare.calls.length, 0, value);
    assert.deepEqual(harness.graphRecords, [], value);
    assert.deepEqual(harness.trace, [], value);
  }
});

// With no planner adapter the stage plans the deterministic graph: the
// selected Skills in their order, each handing its findings to the next as a
// typed input. It is what the deleted sequential chain did, minus the
// rewritten question.
test("without a planner the selected Skills run in order as the deterministic graph", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage(harness.options);

  assert.deepEqual(
    results.map((result) => [result.skillId, result.ok]),
    [
      ["compare_documents", true],
      ["risk_review", true],
    ]
  );
  // The chain's step ids: with one node per Skill the node id is the skill id.
  assert.deepEqual(stepIds(harness.trace), [
    "custom_skill:compare_documents",
    "custom_skill:risk_review",
  ]);
  assert.deepEqual(
    harness.trace.map((step) => step.type),
    ["custom_skill", "custom_skill"]
  );
  assert.equal(risk.calls[0].question, harness.options.question);
  assert.equal(risk.calls[0].priorFindings, "Compare answered.");
  assert.doesNotMatch(risk.calls[0].question, /Previous skill outputs/i);

  const [record] = harness.graphRecords;
  assert.equal(record.executed, true);
  assert.equal(record.status, "completed");
  assert.equal(record.planner.selectedPlannerId, DAG_PLANNER_IDS.deterministic);
  assert.equal(record.planner.fallback, false);
  assert.deepEqual(record.graph.nodeIds, ["compare_documents", "risk_review"]);
});

// A model's proposal the validator refuses is replaced whole by the
// deterministic graph, never repaired and never run in part.
test("a refused proposal is replaced by the deterministic graph, and the refusal is recorded", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });

  const results = await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "unknown", skillId: "not_a_registered_skill" }),
    ]),
  });

  assert.equal(compare.calls.length, 1);
  assert.equal(results.length, 1);
  assert.deepEqual(stepIds(harness.trace), ["custom_skill:compare_documents"]);

  const [record] = harness.graphRecords;
  assert.equal(record.executed, true);
  assert.equal(record.planner.fallback, true);
  assert.equal(record.planner.selectedPlannerId, DAG_PLANNER_IDS.deterministic);
  assert.ok(
    record.planner.fallbackReasonCodes.includes(
      EXECUTION_GRAPH_REASON_CODES.unregisteredCapability
    )
  );
});

test("a planner that throws is replaced by the deterministic graph, and its error is recorded", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: {
      createExecutionGraph: () => {
        throw new Error("planner exploded");
      },
      id: "exploding_planner",
    },
  });

  assert.equal(results.length, 2);
  assert.equal(
    results.every((result) => result.ok),
    true
  );

  const [record] = harness.graphRecords;
  assert.equal(record.executed, true);
  assert.equal(record.planner.fallback, true);
  assert.match(record.planner.fallbackReason, /planner exploded/);
});

// ---------------------------------------------------------------------------
// The graph executes
// ---------------------------------------------------------------------------

test("a dependent node reads its upstream output as a typed input, not as a rewritten question", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk_delta",
        skillId: "risk_review",
      }),
    ]),
  });

  assert.equal(results.length, 2);
  assert.deepEqual(stepIds(harness.trace), [
    "custom_skill:compare",
    "custom_skill:risk_delta",
  ]);
  assert.deepEqual(
    harness.trace.map((step) => step.type),
    ["custom_skill", "custom_skill"]
  );
  // The downstream node reads the goal, not a concatenation of earlier answers.
  assert.equal(risk.calls[0].question, harness.options.question);
  assert.equal(risk.calls[0].priorFindings, "Compare answered.");
  assert.equal(compare.calls[0].accessScope.userId, "alice");
  assert.equal(harness.graphRecords[0].executed, true);
  assert.equal(harness.graphRecords[0].status, "completed");
});

test("independent nodes run concurrently", async () => {
  const barrier = createBarrier(2);
  const riskA = createRecordingSkill({
    id: "risk_review",
    label: "Risk A",
    respond: async (context) => {
      await barrier.arrive("risk_a");

      return { abstained: false, citations: [{ docId: context.docIds[0] }], text: "A" };
    },
  });
  const riskB = createRecordingSkill({
    id: "extract_timeline",
    label: "Risk B",
    respond: async (context) => {
      await barrier.arrive("risk_b");

      return { abstained: false, citations: [{ docId: context.docIds[0] }], text: "B" };
    },
  });
  const harness = createHarness({ skills: [riskA, riskB] });

  const results = await runCustomSkillStage({
    ...harness.options,
    maxConcurrency: 2,
    plannerAdapter: stubPlanner([
      readOnlyNode({
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
        },
        nodeId: "risk_a",
        skillId: "risk_review",
      }),
      readOnlyNode({
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
        },
        nodeId: "risk_b",
        skillId: "extract_timeline",
      }),
    ]),
  });

  // If the stage had serialized these, the first arrival would never be
  // released and this test would time out rather than fail an assertion.
  assert.deepEqual(barrier.arrivals.sort(), ["risk_a", "risk_b"]);
  assert.equal(results.length, 2);
});

test("per-document citations stay attributed to their own node", async () => {
  const riskA = createRecordingSkill({
    id: "risk_review",
    label: "Risk A",
    respond: async (context) => ({
      abstained: false,
      citations: context.docIds.map((docId) => ({ docId, page: 1 })),
      text: `Risks in ${context.docIds.join(",")}.`,
    }),
  });
  const riskB = createRecordingSkill({
    id: "extract_timeline",
    label: "Risk B",
    respond: async (context) => ({
      abstained: false,
      citations: context.docIds.map((docId) => ({ docId, page: 2 })),
      text: `Timeline in ${context.docIds.join(",")}.`,
    }),
  });
  const harness = createHarness({ skills: [riskA, riskB] });

  const results = await runCustomSkillStage({
    ...harness.options,
    maxConcurrency: 2,
    plannerAdapter: stubPlanner([
      {
        ...readOnlyNode({ nodeId: "risk_a", skillId: "risk_review" }),
        scope: { docIds: ["doc-1"] },
      },
      {
        ...readOnlyNode({ nodeId: "risk_b", skillId: "extract_timeline" }),
        scope: { docIds: ["doc-2"] },
      },
    ]),
  });

  const bySkill = new Map(results.map((result) => [result.skillId, result]));
  assert.deepEqual(
    bySkill.get("risk_review").citations.map((citation) => citation.docId),
    ["doc-1"]
  );
  assert.deepEqual(
    bySkill.get("extract_timeline").citations.map((citation) => citation.docId),
    ["doc-2"]
  );
});

// ---------------------------------------------------------------------------
// A budget that does not cover every selected Skill
// ---------------------------------------------------------------------------

const describeRecord = (record) => ({
  errorCodes: record.errorCodes,
  executed: record.executed,
  fallback: record.fallback,
  nodeRuns: record.nodeRuns.map((nodeRun) => `${nodeRun.nodeId}:${nodeRun.status}`),
  plannerFallback: record.planner.fallback,
  plannerFallbackReasonCodes: record.planner.fallbackReasonCodes,
  plannerStatus: record.planner.status,
  selectedPlannerId: record.planner.selectedPlannerId,
  status: record.status,
});

// The model asked for two calls with one left, so its graph is rejected whole
// (running whichever node the budget reaches is not what it proposed). The
// deterministic graph replaces it and is not rejected for the budget: the
// executor reserves one call per node at launch, so the first selected Skill
// runs and the second is skipped. The sequential chain did the same thing
// per Skill, and used to be what answered here.
test("one call for two selected Skills: the deterministic graph runs the first and skips the second at launch", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({
    budget: { maxCustomSkillCalls: 1 },
    skills: [compare, risk],
  });

  const results = await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
    ]),
  });

  assert.equal(compare.calls.length, 1);
  assert.equal(risk.calls.length, 0);
  // A node skipped at launch has no result: the array holds what ran. (The
  // chain returned a failed result for the Skill it could not pay for.) The
  // skip is in the budget note, the node run and the Skill's observation.
  assert.deepEqual(
    results.map((result) => [result.skillId, result.ok]),
    [["compare_documents", true]]
  );
  assert.deepEqual(stepIds(harness.trace), ["custom_skill:compare_documents"]);
  assert.deepEqual(
    harness.tracker
      .getSkillObservations()
      .map((observation) => [observation.skillId, observation.status]),
    [
      ["compare_documents", "completed"],
      ["risk_review", "skipped"],
    ]
  );
  assert.deepEqual(harness.budgetNotes, [
    { reason: "custom skill budget exhausted (1/1, needed 1).", tool: "Risk" },
  ]);
  assert.equal(getRemainingBudget(harness.budgetState).customSkillCalls, 0);
  assert.deepEqual(harness.graphRecords.map(describeRecord), [
    {
      errorCodes: [],
      executed: true,
      fallback: null,
      nodeRuns: ["compare_documents:completed", "risk_review:skipped"],
      plannerFallback: true,
      plannerFallbackReasonCodes: [EXECUTION_GRAPH_REASON_CODES.budgetExceeded],
      plannerStatus: "fallback",
      selectedPlannerId: DAG_PLANNER_IDS.deterministic,
      status: "partial",
    },
  ]);
});

// The same budget with a graph that fits it: a model's one-node graph is
// accepted as proposed, and the selected Skill it left out is simply not part
// of the run.
test("one call and a one-node proposal: the proposal runs as planned", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({
    budget: { maxCustomSkillCalls: 1 },
    skills: [compare, risk],
  });

  const results = await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([readOnlyNode({ nodeId: "risk", skillId: "risk_review" })]),
  });

  assert.equal(compare.calls.length, 0);
  assert.equal(risk.calls.length, 1);
  assert.deepEqual(
    results.map((result) => [result.skillId, result.ok]),
    [["risk_review", true]]
  );
  assert.deepEqual(harness.budgetNotes, []);
  assert.deepEqual(harness.graphRecords.map(describeRecord), [
    {
      errorCodes: [],
      executed: true,
      fallback: null,
      nodeRuns: ["risk:completed"],
      plannerFallback: false,
      plannerFallbackReasonCodes: [],
      plannerStatus: "selected",
      selectedPlannerId: "test_dag",
      status: "completed",
    },
  ]);
});

// With no call left the deterministic graph still plans, and no node can
// launch: the first is skipped for the budget, the second because the node it
// depends on did not run. No Skill is called and no step is written.
test("no call left: the deterministic graph launches nothing and the stage returns no result", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({
    budget: { maxCustomSkillCalls: 0 },
    skills: [compare, risk],
  });

  const results = await runCustomSkillStage(harness.options);

  assert.equal(compare.calls.length, 0);
  assert.equal(risk.calls.length, 0);
  assert.deepEqual(results, []);
  assert.deepEqual(harness.trace, []);
  assert.deepEqual(
    harness.tracker
      .getSkillObservations()
      .map((observation) => [observation.skillId, observation.status]),
    [
      ["compare_documents", "skipped"],
      ["risk_review", "skipped"],
    ]
  );
  assert.deepEqual(harness.budgetNotes, [
    { reason: "custom skill budget exhausted (0/0, needed 1).", tool: "Compare" },
  ]);
  assert.deepEqual(harness.graphRecords.map(describeRecord), [
    {
      errorCodes: [],
      executed: true,
      fallback: null,
      nodeRuns: ["compare_documents:skipped", "risk_review:skipped"],
      plannerFallback: false,
      plannerFallbackReasonCodes: [],
      plannerStatus: "selected",
      selectedPlannerId: DAG_PLANNER_IDS.deterministic,
      status: "partial",
    },
  ]);
});

// ---------------------------------------------------------------------------
// A graph rejected before any node ran
// ---------------------------------------------------------------------------

// The runtime authorized no Skill for this request (in a run: the selected
// documents could not be verified for the caller), so the deterministic graph
// names Skills the validator does not accept and there is no legal graph.
// Nothing runs in its place. The sequential chain used to run the selected
// Skills here anyway.
test("selected Skills the runtime did not authorize: nothing runs, each is reported as not run", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });
  const touched = [];

  const results = await runCustomSkillStage({
    ...harness.options,
    authorizedCustomSkills: [],
    saveExecutionGraphCheckpoint: async () => {
      touched.push("save");
    },
  });

  assert.equal(compare.calls.length, 0);
  assert.equal(risk.calls.length, 0);
  assert.deepEqual(touched, []);
  assert.deepEqual(
    results.map((result) => ({
      code: result.error.code,
      message: result.error.message,
      ok: result.ok,
      skillId: result.skillId,
    })),
    [
      {
        code: AGENT_SKILL_GRAPH_REJECTED_CODE,
        message: "Compare was not run: no legal execution graph (unregistered_capability).",
        ok: false,
        skillId: "compare_documents",
      },
      {
        code: AGENT_SKILL_GRAPH_REJECTED_CODE,
        message: "Risk was not run: no legal execution graph (unregistered_capability).",
        ok: false,
        skillId: "risk_review",
      },
    ]
  );
  // One step for the stage, and no custom_skill step: nothing was started.
  assert.deepEqual(harness.trace, [
    {
      detail: {
        reasonCodes: ["unregistered_capability"],
        skillIds: ["compare_documents", "risk_review"],
      },
      label: "Skill graph rejected",
      status: "skipped",
      summary: "Skipped Compare, Risk: no legal execution graph (unregistered_capability).",
      type: "skill_graph_rejected",
    },
  ]);
  assert.deepEqual(harness.budgetNotes, []);
  assert.equal(getRemainingBudget(harness.budgetState).customSkillCalls, 2);
  assert.deepEqual(
    harness.tracker
      .getSkillObservations()
      .map((observation) => [observation.skillId, observation.status]),
    [
      ["compare_documents", "skipped"],
      ["risk_review", "skipped"],
    ]
  );
  assert.deepEqual(harness.graphRecords.map(describeRecord), [
    {
      errorCodes: ["unregistered_capability", "unregistered_capability"],
      executed: false,
      fallback: null,
      nodeRuns: [],
      plannerFallback: true,
      plannerFallbackReasonCodes: ["unregistered_capability", "unregistered_capability"],
      plannerStatus: "rejected",
      selectedPlannerId: DAG_PLANNER_IDS.deterministic,
      status: "rejected",
    },
  ]);
});

test("more selected Skills than a graph may hold: nothing runs, each is reported as not run", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage({
    ...harness.options,
    limits: { maxNodes: 1 },
  });

  assert.equal(compare.calls.length, 0);
  assert.equal(risk.calls.length, 0);
  assert.deepEqual(
    results.map((result) => [result.skillId, result.ok, result.error.message]),
    [
      ["compare_documents", false, "Compare was not run: no legal execution graph (max_nodes_exceeded)."],
      ["risk_review", false, "Risk was not run: no legal execution graph (max_nodes_exceeded)."],
    ]
  );
  assert.deepEqual(
    harness.trace.map((step) => [step.type, step.status]),
    [["skill_graph_rejected", "skipped"]]
  );
  assert.equal(harness.graphRecords[0].executed, false);
  assert.equal(harness.graphRecords[0].status, "rejected");
  assert.equal(harness.graphRecords[0].fallback, null);
});

// The outer plan can ask for custom analysis when the intent selected no
// custom Skill. If the model's graph over the authorized Skills is unusable,
// the deterministic graph is empty and there is nothing to run or to report:
// the stage never runs the whole authorized catalog as a substitute.
test("no Skill selected and no usable proposal: an empty result and a rejected graph event", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });

  const results = await runCustomSkillStage({
    ...harness.options,
    authorizedCustomSkills: [compare.skill],
    customSkills: [],
    plannerAdapter: {
      createExecutionGraph: () => {
        throw new Error("planner unavailable");
      },
      id: "unavailable_dag",
    },
  });

  assert.deepEqual(results, []);
  assert.equal(compare.calls.length, 0);
  assert.deepEqual(harness.trace, []);
  assert.deepEqual(harness.graphRecords.map(describeRecord), [
    {
      errorCodes: [],
      executed: false,
      fallback: null,
      nodeRuns: [],
      plannerFallback: true,
      plannerFallbackReasonCodes: [],
      plannerStatus: "rejected",
      selectedPlannerId: DAG_PLANNER_IDS.deterministic,
      status: "rejected",
    },
  ]);
});

// With nothing selected and nothing authorized the stage plans nothing at all.
test("no Skill selected and none authorized: the stage returns without planning", async () => {
  const harness = createHarness({ skills: [] });

  const results = await runCustomSkillStage({
    ...harness.options,
    authorizedCustomSkills: [],
    plannerAdapter: {
      createExecutionGraph: () => {
        throw new Error("The stage must not plan without Skills.");
      },
      id: "should_not_run",
    },
  });

  assert.deepEqual(results, []);
  assert.deepEqual(harness.graphRecords, []);
  assert.deepEqual(harness.trace, []);
});

// ---------------------------------------------------------------------------
// After a node has run
// ---------------------------------------------------------------------------

test("a node that failed leaves a partial graph: nothing is run a second time", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({
    id: "risk_review",
    label: "Risk",
    respond: async () => {
      throw new Error("risk skill failed");
    },
  });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
    ]),
  });

  // Running the Skills again under another plan would execute compare a
  // second time and charge the budget for it twice, so a partial run keeps
  // its partial answer.
  assert.equal(compare.calls.length, 1);
  assert.equal(risk.calls.length, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, false]
  );
  assert.equal(harness.graphRecords[0].executed, true);
  assert.equal(harness.graphRecords[0].status, "partial");
  assert.equal(harness.graphRecords[0].fallback, null);
});

test("each node is charged once", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({
    budget: { maxCustomSkillCalls: 4 },
    skills: [compare, risk],
  });

  await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
    ]),
  });

  assert.equal(getRemainingBudget(harness.budgetState).customSkillCalls, 2);
});

test("the stage waits for the graph event to persist before returning results", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });
  const recordStarted = createDeferred();
  const recordPersisted = createDeferred();
  const order = [];

  const stage = runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
    ]),
    recordExecutionGraph: async (event) => {
      order.push("record_started");
      recordStarted.resolve(event);
      await recordPersisted.promise;
      order.push("record_persisted");
    },
  }).then((results) => {
    order.push("stage_returned");
    return results;
  });

  const event = await recordStarted.promise;
  assert.equal(event.status, "completed");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["record_started"]);

  recordPersisted.resolve();
  const results = await stage;
  assert.equal(results.length, 1);
  assert.deepEqual(order, ["record_started", "record_persisted", "stage_returned"]);
});

test("an approval interrupt leaves the stage as it is: nothing is restarted", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({
    id: "risk_review",
    label: "Risk",
    respond: async () => {
      throw new AgentRunInterruptError({
        detail: { skillId: "risk_review" },
        type: AGENT_INTERRUPT_TYPES.capabilityApprovalRequired,
      });
    },
  });
  const harness = createHarness({ skills: [compare, risk] });

  await assert.rejects(
    runCustomSkillStage({
      ...harness.options,
        plannerAdapter: stubPlanner([
        readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
        readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
      ]),
    }),
    (error) => error.type === AGENT_INTERRUPT_TYPES.capabilityApprovalRequired
  );

  // Swallowing the interrupt into a restart would re-run compare and ask for
  // approval against an input the user never saw.
  assert.equal(compare.calls.length, 1);
  assert.equal(risk.calls.length, 1);
});

// ---------------------------------------------------------------------------
// One bounded replan
// ---------------------------------------------------------------------------

test("the stage records that it considered replanning and declined", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });
  let patchCalls = 0;

  await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
    ]),
    replanAdapter: {
      createPatch: () => {
        patchCalls += 1;

        return { addNodes: [] };
      },
      id: "test_replanner",
    },
  });

  assert.equal(patchCalls, 0);
  assert.deepEqual(
    harness.graphRecords[0].replans.map((replan) => replan.reasonCode),
    [REPLAN_REASON_CODES.notTriggered]
  );
});

test("at most one replan is applied, and the nodes that already ran are reused", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({
    id: "risk_review",
    label: "Risk",
    respond: async () => ({ abstained: true, citations: [], text: "" }),
  });
  const timeline = createRecordingSkill({
    id: "extract_timeline",
    label: "Timeline",
    respond: async () => ({ abstained: true, citations: [], text: "" }),
  });
  const harness = createHarness({
    budget: { maxCustomSkillCalls: 6 },
    skills: [compare, risk, timeline],
  });
  let patchCalls = 0;

  const results = await runCustomSkillStage({
    ...harness.options,
    customSkills: [compare.skill, risk.skill, timeline.skill],
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
    ]),
    replanAdapter: {
      createPatch: () => {
        patchCalls += 1;

        return {
          addNodes: [
            readOnlyNode({ nodeId: "timeline", skillId: "extract_timeline" }),
          ],
        };
      },
      id: "test_replanner",
    },
  });

  assert.equal(patchCalls, 1);
  assert.equal(compare.calls.length, 1);
  assert.equal(risk.calls.length, 1);
  assert.equal(timeline.calls.length, 1);
  assert.equal(results.length, 3);
  // Three nodes ran once each; the reused nodes were not charged again.
  assert.equal(getRemainingBudget(harness.budgetState).customSkillCalls, 3);

  const [record] = harness.graphRecords;
  assert.deepEqual(
    record.replans.map((replan) => replan.decision),
    [REPLAN_DECISIONS.applied, REPLAN_DECISIONS.abstain]
  );
  assert.equal(record.replans[1].reasonCode, REPLAN_REASON_CODES.limitReached);
  assert.deepEqual(record.graph.nodeIds, ["compare", "risk", "timeline"]);
  assert.deepEqual(stepIds(harness.trace), [
    "custom_skill:compare",
    "custom_skill:risk",
    "custom_skill:timeline",
  ]);
});

test("a failed write Skill is not executed again by bounded replanning", async () => {
  let writeCalls = 0;
  let patchCalls = 0;
  const publish = {
    skill: {
      ...createTestSkill({
        effects: "external_write",
        execute: async () => {
          writeCalls += 1;
          throw new Error("write may have landed before acknowledgement failed");
        },
        id: "publish_report",
      }),
      idempotency: "nondeterministic",
      replaySafe: false,
      retryable: false,
    },
  };
  const timeline = createRecordingSkill({ id: "extract_timeline" });
  const harness = createHarness({ skills: [publish, timeline] });

  await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "publish", skillId: "publish_report" }),
    ]),
    replanAdapter: {
      createPatch: () => {
        patchCalls += 1;
        return {
          addNodes: [readOnlyNode({ nodeId: "timeline", skillId: "extract_timeline" })],
        };
      },
      id: "test_replanner",
    },
  });

  assert.equal(writeCalls, 1);
  assert.equal(patchCalls, 0);
  assert.equal(timeline.calls.length, 0);
  assert.equal(harness.graphRecords[0].replans[0].decision, REPLAN_DECISIONS.abstain);
  assert.equal(
    harness.graphRecords[0].replans[0].reasonCode,
    REPLAN_REASON_CODES.sideEffectNodeFailed
  );
});

test("a replan that widens document scope is rejected and the run keeps its first answer", async () => {
  const compare = createRecordingSkill({
    id: "compare_documents",
    label: "Compare",
    respond: async () => ({ abstained: true, citations: [], text: "" }),
  });
  const harness = createHarness({ skills: [compare] });

  const results = await runCustomSkillStage({
    ...harness.options,
    docIds: ["doc-1"],
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
    ]),
    replanAdapter: {
      createPatch: () => ({
        addNodes: [
          {
            ...readOnlyNode({ nodeId: "compare_wider", skillId: "compare_documents" }),
            scope: { docIds: ["doc-9"] },
          },
        ],
      }),
      id: "scope_widening_replanner",
    },
  });

  assert.equal(compare.calls.length, 1);
  assert.deepEqual(compare.calls[0].docIds, ["doc-1"]);
  assert.equal(results.length, 1);

  const [record] = harness.graphRecords;
  assert.equal(record.replans[0].decision, REPLAN_DECISIONS.abstain);
  assert.equal(record.replans[0].reasonCode, REPLAN_REASON_CODES.invalidPatch);
  assert.deepEqual(record.graph.nodeIds, ["compare"]);
});

// ---------------------------------------------------------------------------
// The contract the rest of the run depends on
// ---------------------------------------------------------------------------

// The sequential chain and the shadow mode returned this same shape; the
// commit before their deletion compared the three and wrote the shape out.
test("the stage returns a flat skill-result array", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });
  const results = await runCustomSkillStage({
    ...harness.options,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare_documents", skillId: "compare_documents" }),
    ]),
  });

  assert.deepEqual(
    results.map((result) => ({
      citationCount: result.citations?.length ?? 0,
      ok: result.ok,
      skillId: result.skillId,
      skillVersion: result.skillVersion,
    })),
    [{ citationCount: 1, ok: true, skillId: "compare_documents", skillVersion: "1.0.0" }]
  );
});
