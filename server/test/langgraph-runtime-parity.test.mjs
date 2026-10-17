// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { assertMatchesGraphGolden } from "./langgraph-support/graph-goldens.mjs";

// Phase-2 acceptance evidence for the LangGraph runtime (docs/adr/0001-
// langgraph-runtime.md), kept after phase 6 deleted the native scheduler: the
// evaluation cases that exercise the custom-Skill DAG -- the four skill_graph
// trajectory cases, the planner's dynamic-skill-graph case on its mock
// provider, and the recovery-observability replan and startup-resume signal
// -- run through the evaluations' own runners and must come out exactly as
// they did on the native scheduler: every check (with its detail), the whole
// response projection a case reports, the recovery report, and every run the
// cases created (events, status, steps and result, private LangGraph record
// aside). Until phase 6 that was a second, native pass of each case; it is
// now the golden frozen from that pass
// (test/fixtures/graph-goldens/langgraph-runtime-parity/<case id>.json; see
// test/langgraph-support/graph-goldens.mjs).
//
// The cases keep their run stores private, so the evaluation modules' import
// of rag/agent-runs.js is redirected to a stand-in that records each store and
// run (test/langgraph-runtime-parity/). The executor's import is redirected
// too, and every LangGraph invocation is pinned per case, so a case that
// stopped reaching the graph fails here.
//
// Masked, and only these: random ids (UUIDs, also inside run and event ids),
// ISO timestamps, the wall-clock measurements `durationMs` and `latencyMs`,
// and the graph checkpoint's `digest`, a seal over the checkpoint that covers
// those durations. Each one differs between two runs.
const PARITY_DIRECTORY = new URL("./langgraph-runtime-parity/", import.meta.url);
const RUN_STORE_TAP_URL = new URL("agent-run-store-tap.mjs", PARITY_DIRECTORY).href;
const EXECUTOR_TAP_URL = new URL("langgraph-executor-tap.mjs", PARITY_DIRECTORY).href;

register("./langgraph-runtime-parity/redirect-hooks.mjs", import.meta.url, {
  data: {
    redirects: [
      {
        capture: RUN_STORE_TAP_URL,
        fromPrefix: new URL("../evaluation/", import.meta.url).href,
        target: new URL("../rag/agent-runs.js", import.meta.url).href,
      },
      {
        capture: EXECUTOR_TAP_URL,
        fromPrefix: new URL("../rag/", import.meta.url).href,
        target: new URL("../rag/langgraph/run-execution-graph.js", import.meta.url).href,
      },
    ],
  },
});

// The hooks apply only to modules loaded after register(), so every project
// module is imported dynamically.
const { LANGGRAPH_CHECKPOINT_RESULT_KEY, takeCreatedAgentRuns } = await import(
  RUN_STORE_TAP_URL
);
const { takeLangGraphInvocations } = await import(EXECUTOR_TAP_URL);
const { EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY } = await import(
  "../rag/agent-execution-graph-checkpoint.js"
);
const { LANGGRAPH_CHECKPOINT_FORMAT, deriveLangGraphThreadId } = await import(
  "../rag/langgraph/checkpointer.js"
);
const { CUSTOM_SKILL_IDS } = await import("../rag/skills/registry.js");
const { runTrajectoryEvaluation } = await import("../evaluation/trajectory-eval.js");
const {
  createSkillGraphBoundedReplanCase,
  createSkillGraphGuardedExecutionCase,
  createSkillGraphIllegalPlanCase,
  createSkillGraphShadowComparisonCase,
} = await import("../evaluation/trajectory/cases/skill-graph.js");
const { runPlannerEvaluation } = await import("../evaluation/planner/run.js");
const { createDefaultPlannerCases } = await import("../evaluation/planner/cases/index.js");
const {
  buildRecoveryObservabilityEvaluationReport,
  buildRecoveryObservabilityProductionEvents,
} = await import("../evaluation/recovery-observability-eval.js");

const CREATED_AT = "2026-10-14T00:00:00.000Z";
// The answer-rate flags change pinned response projections when on
// (test/trajectory-eval.test.mjs pins them off for the same reason), so every
// pass runs with every one of them off whatever the ambient environment says.
const ANSWER_RATE_FLAGS_OFF = Object.freeze({
  AGENT_FOLLOW_UP_ORIGINAL_QUESTION: undefined,
  AGENT_SINGLE_DOCUMENT_ROUTING: undefined,
  RAG_CLAIM_HEADING_CONTEXT: undefined,
  RAG_CLAIM_INFLECTION: undefined,
  RAG_CLAIM_JUDGE_TEMPERATURE: undefined,
  RAG_CLAIM_SOURCE_INHERITANCE: undefined,
  RAG_QA_GATE_INFLECTION: undefined,
});

const withEnv = async (overrides, work) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]])
  );
  const apply = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };

  apply(overrides);

  try {
    return await work();
  } finally {
    apply(previous);
  }
};

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const WALL_CLOCK_KEYS = new Set(["durationMs", "latencyMs"]);

const maskVolatile = (value, key = "") => {
  if (typeof value === "string") {
    return key === "digest"
      ? "<digest>"
      : value.replace(UUID_PATTERN, "<id>").replace(ISO_TIMESTAMP_PATTERN, "<time>");
  }

  if (typeof value === "number" && WALL_CLOCK_KEYS.has(key)) {
    return "<elapsed>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskVolatile(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, maskVolatile(item, name)])
    );
  }

  return value;
};

// Everything a run leaves in the store except LangGraph's own thread record,
// which the native scheduler never wrote (so the golden cannot hold it) and
// is checked on its own below.
const projectRun = (run) => {
  const { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: _langGraphRecord, ...result } =
    run?.result ?? {};

  return {
    events: run?.events ?? [],
    result,
    status: run?.status ?? null,
    steps: run?.steps ?? [],
  };
};

// The outer-plan dial is pinned unset, the production setting: the outer plan
// stays on the native loop, so only the custom-Skill DAG runs on LangGraph.
const PASS_ENV = Object.freeze({ ...ANSWER_RATE_FLAGS_OFF, AGENT_OUTER_PLAN_RUNTIME: undefined });

/**
 * Runs `work` and returns its outcome with every run the evaluation modules
 * created and every LangGraph invocation made meanwhile.
 */
const runPass = (work) =>
  withEnv(PASS_ENV, async () => {
    // Nothing recorded before this pass may be attributed to it.
    await takeCreatedAgentRuns();
    takeLangGraphInvocations();

    const outcome = await work();

    return {
      invocations: takeLangGraphInvocations(),
      outcome,
      runs: await takeCreatedAgentRuns(),
    };
  });

const GOLDEN_SUITE = "langgraph-runtime-parity";

// The golden holds the masked outcome and every run the pass created, as the
// native pass produced them (UPDATE_GRAPH_GOLDENS=1 rewrites it from this
// pass; see the helper's rules).
const assertPassMatchesGolden = (caseName, pass) => {
  assert.ok(pass.runs.length > 0, "the cases created no run to compare");
  assertMatchesGraphGolden(GOLDEN_SUITE, caseName, {
    outcome: maskVolatile(pass.outcome),
    runs: maskVolatile(pass.runs.map(projectRun)),
  });
};

// Every run whose graph went through a bound invocation wrote its thread into
// the run row while the graph ran: LangGraph's format, this run's thread, the
// root namespace, and none of the run's question. Since phase 4 the save that
// settles the graph drops that thread in the same CAS, so the finished run
// keeps only the null tombstone; the records are checked as the run-store tap
// copied them from each write (before phase 4 the finished run kept its
// record and this read it from the run).
const assertLangGraphRecords = (langgraph) => {
  const boundInvocationCount = langgraph.invocations.filter(
    (invocation) => invocation.boundToRun
  ).length;
  const runsThatWroteRecords = langgraph.runs.filter(
    (run) => run.langGraphRecordsWritten.length > 0
  );

  assert.equal(runsThatWroteRecords.length > 0, boundInvocationCount > 0);

  for (const run of langgraph.runs) {
    // No finished run carries a thread.
    assert.equal(run.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY] ?? null, null);
  }

  for (const run of runsThatWroteRecords) {
    assert.ok(run.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]);
    assert.ok(["completed", "partial"].includes(run.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY].phase));
    // The drop's tombstone: the key, with no thread behind it.
    assert.equal(Object.hasOwn(run.result, LANGGRAPH_CHECKPOINT_RESULT_KEY), true);
    assert.equal(run.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);

    for (const record of run.langGraphRecordsWritten) {
      assert.equal(record.format, LANGGRAPH_CHECKPOINT_FORMAT);
      assert.equal(record.threadId, deriveLangGraphThreadId(run.accessScope, run.runId));
      // The graph checkpoints into the root namespace, never a subgraph's
      // (with AGENT_OUTER_PLAN_RUNTIME=langgraph it is invoked from inside the
      // outer plan graph's custom_skills node, test/agent-run-chat-statement-
      // count.test.mjs pins that case).
      assert.deepStrictEqual(record.namespaces.map((namespace) => namespace.ns), [""]);
      assert.equal(JSON.stringify(record).includes(run.goal), false);
    }
  }
};

const runTrajectoryCase = async (createCase) => {
  const report = await runTrajectoryEvaluation({
    cases: [createCase()],
    createdAt: CREATED_AT,
    runId: "langgraph-runtime-parity",
  });

  assert.equal(report.cases.length, 1);
  return report.cases[0];
};

const runPlannerCase = async (caseId) => {
  const report = await runPlannerEvaluation({
    cases: createDefaultPlannerCases().filter((caseDefinition) => caseDefinition.id === caseId),
    createdAt: CREATED_AT,
    provider: "mock",
    runId: "langgraph-runtime-parity",
  });

  assert.equal(report.cases.length, 1);
  return report.cases[0];
};

const invocation = (nodeIds, reusedNodeIds = []) => ({
  boundToRun: true,
  nodeIds,
  reusedNodeIds,
});
const CONTRACT_NODE_IDS = [
  CUSTOM_SKILL_IDS.summarizeContract,
  CUSTOM_SKILL_IDS.riskReview,
];

const EVALUATION_CASES = [
  {
    id: "skill_graph_guarded_execution",
    langGraphInvocations: [invocation(CONTRACT_NODE_IDS)],
    run: () => runTrajectoryCase(createSkillGraphGuardedExecutionCase),
  },
  {
    // The V1 chain answers; the shadow graph is planned, never executed.
    id: "skill_graph_shadow_comparison",
    langGraphInvocations: [],
    run: () => runTrajectoryCase(createSkillGraphShadowComparisonCase),
  },
  {
    // The forged graph is rejected whole before admission reaches an
    // executor; only the deterministic fallback graph is scheduled.
    id: "skill_graph_illegal_plan_rejected",
    langGraphInvocations: [invocation(CONTRACT_NODE_IDS)],
    run: () => runTrajectoryCase(createSkillGraphIllegalPlanCase),
  },
  {
    // The replan is a second invocation on a new thread that reuses the two
    // settled nodes and runs only the added one.
    id: "skill_graph_bounded_replan",
    langGraphInvocations: [
      invocation(CONTRACT_NODE_IDS),
      invocation([...CONTRACT_NODE_IDS, "risk_review_retry"], CONTRACT_NODE_IDS),
    ],
    run: () => runTrajectoryCase(createSkillGraphBoundedReplanCase),
  },
  {
    id: "planner_dynamic_skill_graph",
    langGraphInvocations: [
      invocation([CUSTOM_SKILL_IDS.compareDocuments, CUSTOM_SKILL_IDS.riskReview]),
    ],
    run: () => runPlannerCase("planner_dynamic_skill_graph"),
  },
];

for (const evaluationCase of EVALUATION_CASES) {
  test(`${evaluationCase.id} on LangGraph matches its native golden`, async () => {
    const langgraph = await runPass(evaluationCase.run);

    // A golden match of a broken run would prove nothing: the case holds.
    assert.equal(langgraph.outcome.id, evaluationCase.id);
    assert.equal(langgraph.outcome.passed, true, JSON.stringify(langgraph.outcome.checks));
    assert.equal(langgraph.outcome.failedCheckCount, 0);
    // Every check with its detail, the whole response projection (summary
    // plus the case's observed fields) and every run the case created, as
    // the native pass produced them.
    assertPassMatchesGolden(evaluationCase.id, langgraph);

    assert.deepStrictEqual(langgraph.invocations, evaluationCase.langGraphInvocations);
    assertLangGraphRecords(langgraph);
  });
}

test("the recovery-observability replan and startup-resume signal on LangGraph matches its native golden", async () => {
  const langgraph = await runPass(async () => {
    // The production builders: a real guarded run with one applied replan,
    // and a startup resume (checkpoint, re-instantiated services, the
    // application's recovery API) that asserts its own expectations.
    const events = await buildRecoveryObservabilityProductionEvents();

    return {
      events,
      report: buildRecoveryObservabilityEvaluationReport({
        createdAt: CREATED_AT,
        events,
        runId: "langgraph-runtime-parity",
      }),
    };
  });
  const signal = (report) => {
    const skillGraphCase = report.cases.find((entry) => entry.id === "skill_graph_signal");
    const resumeCase = report.cases.find(
      (entry) => entry.id === "skill_graph_startup_resume"
    );

    return {
      checks: [...skillGraphCase.checks, ...resumeCase.checks].map(({ id, passed }) => ({
        id,
        passed,
      })),
      replanAppliedCount: report.recovery.skillGraphReplanAppliedCount,
      reusedNodeCount: report.recovery.skillGraphReusedNodeCount,
      startupResumeObservedCount: report.recovery.skillGraphStartupResumeObservedCount,
      unsafeFallbackCount: report.recovery.skillGraphUnsafeFallbackCount,
    };
  };

  assert.equal(langgraph.outcome.report.summary.status, "pass");
  assert.ok(signal(langgraph.outcome.report).checks.every((check) => check.passed));
  assert.equal(signal(langgraph.outcome.report).replanAppliedCount, 1);
  assert.equal(signal(langgraph.outcome.report).startupResumeObservedCount, 1);
  assert.equal(signal(langgraph.outcome.report).unsafeFallbackCount, 0);
  // The whole report and every event it was built from, not only the signal,
  // and every run, as the native pass produced them.
  assertPassMatchesGolden("recovery_observability_skill_graph_signal", langgraph);

  assert.deepStrictEqual(langgraph.invocations, [
    // The replan run.
    invocation(CONTRACT_NODE_IDS),
    invocation([...CONTRACT_NODE_IDS, "risk_review_retry"], CONTRACT_NODE_IDS),
    // The startup resume: the first worker stops after `compare` settles, and
    // the recovery worker reuses it and runs only `risk`.
    invocation(["compare", "risk"]),
    invocation(["compare", "risk"], ["compare"]),
  ]);
  assertLangGraphRecords(langgraph);
});
