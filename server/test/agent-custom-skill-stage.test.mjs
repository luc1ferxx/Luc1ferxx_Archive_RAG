import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget, getRemainingBudget } from "../rag/agent-budget.js";
import {
  CUSTOM_SKILL_STAGE_MODES,
  runCustomSkillStage,
} from "../rag/agent-custom-skill-stage.js";
import {
  AGENT_INTERRUPT_TYPES,
  AgentRunInterruptError,
} from "../rag/agent-interrupts.js";
import { EXECUTION_GRAPH_REASON_CODES } from "../rag/agent-execution-graph.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { REPLAN_DECISIONS, REPLAN_REASON_CODES } from "../rag/agent-replanner.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { CUSTOM_RAG_SKILL_CONTRACT } from "../rag/skills/custom/custom-skill-contract.js";
import { createSkillRegistry } from "../rag/skills/registry.js";

// The migration incision. This stage is the only place where the V1 chain and
// the typed DAG meet, so these tests are mostly about what must NOT change:
// the step type, the step id shape, the flat result array the rest of the run
// consumes, and the rule that a skill runs once per request no matter which
// path the stage took. The one thing that is allowed to change is how a node
// receives its inputs -- typed bindings instead of a concatenated question.

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
  const graphRecords = [];
  const skillList = skills.map(({ skill }) => skill);

  return {
    budgetState,
    graphRecords,
    options: {
      accessScope: {
        authProvider: "local",
        authenticated: true,
        userId: "alice",
        workspaceId: "workspace-a",
      },
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

// ---------------------------------------------------------------------------
// off: the V1 chain, untouched
// ---------------------------------------------------------------------------

test("off mode runs the V1 chain with its original step ids and free-text chaining", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.off,
  });

  assert.equal(results.length, 2);
  assert.equal(
    results.every((result) => result.ok),
    true
  );
  assert.deepEqual(stepIds(harness.trace), [
    "custom_skill:compare_documents",
    "custom_skill:risk_review",
  ]);
  assert.deepEqual(
    harness.trace.map((step) => step.type),
    ["custom_skill", "custom_skill"]
  );
  // V1's data interface is the concatenated question, and off mode keeps it.
  assert.match(risk.calls[0].question, /Previous skill outputs/i);
  assert.equal(risk.calls[0].priorFindings, undefined);
});

test("off mode never plans a graph and never records one", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });
  let plannerCalls = 0;

  await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.off,
    plannerAdapter: {
      createExecutionGraph: () => {
        plannerCalls += 1;

        return { nodes: [] };
      },
      id: "should_not_run",
    },
  });

  assert.equal(plannerCalls, 0);
  assert.deepEqual(harness.graphRecords, []);
});

test("the stage stays on the V1 chain when no mode is configured", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });
  const previousMode = process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;

  try {
    const results = await runCustomSkillStage({ ...harness.options });

    assert.equal(results.length, 1);
    assert.deepEqual(harness.graphRecords, []);
  } finally {
    if (previousMode === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = previousMode;
    }
  }
});

// No production caller passes `mode`; the stage resolves it from the rollout
// dial itself. Asserting only the `off` default would leave the operator's
// side of that contract untested -- the dial could stop being read at all and
// every other test in this file would still pass, because they all inject the
// mode directly.
test("the stage advances to the graph when the operator sets the rollout dial", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });
  const previousMode = process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  process.env.AGENT_SKILL_GRAPH_ROLLOUT = CUSTOM_SKILL_STAGE_MODES.guarded;

  try {
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
          nodeId: "risk",
          skillId: "risk_review",
        }),
      ]),
    });

    assert.equal(results.length, 2);
    assert.equal(harness.graphRecords.length, 1);
    assert.equal(harness.graphRecords[0].executed, true);
    assert.equal(harness.graphRecords[0].mode, CUSTOM_SKILL_STAGE_MODES.guarded);
    assert.deepEqual(harness.graphRecords[0].graph.nodeIds, ["compare", "risk"]);
    // Node ids, not skill ids: this is the typed DAG rather than the chain.
    assert.deepEqual(stepIds(harness.trace), [
      "custom_skill:compare",
      "custom_skill:risk",
    ]);
    // The dependent node read its upstream output as a typed binding, which is
    // the thing the V1 chain could only express by splicing text into the
    // question.
    assert.equal(risk.calls[0].priorFindings, "Compare answered.");
    assert.doesNotMatch(risk.calls[0].question, /Previous skill outputs/i);
  } finally {
    if (previousMode === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = previousMode;
    }
  }
});

// ---------------------------------------------------------------------------
// shadow: plan for comparison, execute nothing
// ---------------------------------------------------------------------------

test("shadow mode answers from V1 and plans the graph without executing it", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.shadow,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
    ]),
  });

  // One execution each: the shadow graph is planned and validated, never run.
  assert.equal(compare.calls.length, 1);
  assert.equal(risk.calls.length, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(stepIds(harness.trace), [
    "custom_skill:compare_documents",
    "custom_skill:risk_review",
  ]);

  const [record] = harness.graphRecords;
  assert.equal(record.mode, CUSTOM_SKILL_STAGE_MODES.shadow);
  assert.equal(record.executed, false);
  assert.deepEqual(record.graph.nodeIds, ["compare", "risk"]);
  assert.deepEqual(record.nodeRuns, []);
  assert.equal(record.planner.status, "selected");
});

test("shadow mode reports a rejected graph instead of executing a repaired one", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });

  const results = await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.shadow,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "unknown", skillId: "not_a_registered_skill" }),
    ]),
  });

  assert.equal(compare.calls.length, 1);
  assert.equal(results.length, 1);

  const [record] = harness.graphRecords;
  assert.equal(record.executed, false);
  // The deterministic fallback is legal, so the shadow still produces a graph;
  // what matters is that the rejection of the primary proposal is visible.
  assert.equal(record.planner.fallback, true);
  assert.ok(
    record.planner.fallbackReasonCodes.includes(
      EXECUTION_GRAPH_REASON_CODES.unregisteredCapability
    )
  );
});

test("a shadow planner failure is recorded, not raised", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.shadow,
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
  assert.equal(record.executed, false);
  assert.equal(record.planner.fallback, true);
  assert.match(record.planner.fallbackReason, /planner exploded/);
});

test("a broken shadow path cannot break the real run", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });

  // A misconfigured stage must cost the user a comparison datapoint, never an
  // answer: the shadow graph is built after V1 has already finished.
  const results = await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.shadow,
    registry: undefined,
  });

  assert.equal(compare.calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);

  const [record] = harness.graphRecords;
  assert.equal(record.executed, false);
  assert.equal(record.status, "error");
  assert.ok(record.error);
});

// ---------------------------------------------------------------------------
// guarded: the DAG executes
// ---------------------------------------------------------------------------

test("guarded mode executes the graph and replaces chained questions with typed inputs", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({ skills: [compare, risk] });

  const results = await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
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

test("guarded mode runs independent nodes concurrently", async () => {
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
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
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

test("guarded mode keeps per-document citations attributed to their own node", async () => {
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
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
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

test("guarded mode falls back to the V1 chain when no legal graph exists", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  // One call funds one node, so every two-node graph is over budget and both
  // the proposed graph and the deterministic fallback are rejected outright.
  const harness = createHarness({
    budget: { maxCustomSkillCalls: 1 },
    skills: [compare, risk],
  });

  const results = await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
    ]),
  });

  // The rejection happened before any node ran, so V1 starts from a budget
  // that was never charged: one skill runs, the second is budget-skipped.
  assert.equal(compare.calls.length, 1);
  assert.equal(risk.calls.length, 0);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.deepEqual(stepIds(harness.trace), ["custom_skill:compare_documents"]);

  const [record] = harness.graphRecords;
  assert.equal(record.executed, false);
  assert.equal(record.fallback, "v1");
  assert.equal(record.planner.status, "rejected");
});

test("guarded mode does not fall back to V1 after a node has already run", async () => {
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
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
    ]),
  });

  // Re-running the chain here would execute compare a second time and charge
  // the budget for it twice, so a partial run keeps its partial answer.
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

test("guarded mode charges each node once", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const risk = createRecordingSkill({ id: "risk_review", label: "Risk" });
  const harness = createHarness({
    budget: { maxCustomSkillCalls: 4 },
    skills: [compare, risk],
  });

  await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
    plannerAdapter: stubPlanner([
      readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
      readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
    ]),
  });

  assert.equal(getRemainingBudget(harness.budgetState).customSkillCalls, 2);
});

test("guarded mode lets an approval interrupt out instead of restarting under V1", async () => {
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
      mode: CUSTOM_SKILL_STAGE_MODES.guarded,
      plannerAdapter: stubPlanner([
        readOnlyNode({ nodeId: "compare", skillId: "compare_documents" }),
        readOnlyNode({ nodeId: "risk", skillId: "risk_review" }),
      ]),
    }),
    (error) => error.type === AGENT_INTERRUPT_TYPES.capabilityApprovalRequired
  );

  // Swallowing the interrupt into a V1 restart would re-run compare and ask
  // for approval against an input the user never saw.
  assert.equal(compare.calls.length, 1);
  assert.equal(risk.calls.length, 1);
});

// ---------------------------------------------------------------------------
// guarded + one bounded replan
// ---------------------------------------------------------------------------

test("guarded mode records that it considered replanning and declined", async () => {
  const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
  const harness = createHarness({ skills: [compare] });
  let patchCalls = 0;

  await runCustomSkillStage({
    ...harness.options,
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
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

test("guarded mode applies at most one replan and reuses the nodes that already ran", async () => {
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
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
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
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
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

test("every mode returns the same flat skill-result array", async () => {
  const shapes = [];

  for (const mode of [
    CUSTOM_SKILL_STAGE_MODES.off,
    CUSTOM_SKILL_STAGE_MODES.shadow,
    CUSTOM_SKILL_STAGE_MODES.guarded,
  ]) {
    const compare = createRecordingSkill({ id: "compare_documents", label: "Compare" });
    const harness = createHarness({ skills: [compare] });
    const results = await runCustomSkillStage({
      ...harness.options,
      mode,
      plannerAdapter: stubPlanner([
        readOnlyNode({ nodeId: "compare_documents", skillId: "compare_documents" }),
      ]),
    });

    shapes.push(
      results.map((result) => ({
        citationCount: result.citations?.length ?? 0,
        ok: result.ok,
        skillId: result.skillId,
        skillVersion: result.skillVersion,
      }))
    );
  }

  assert.deepEqual(shapes[0], shapes[1]);
  assert.deepEqual(shapes[0], shapes[2]);
});
