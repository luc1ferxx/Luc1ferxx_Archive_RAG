// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Phase-3 evidence for the V1 outer execution plan on LangGraph
// (rag/langgraph/execution-plan-graph.js, behind the experimental
// AGENT_OUTER_PLAN_RUNTIME=langgraph since the phase-3 load test; config.js
// says why): runAgentRag must come out identical on both schedulers -- the
// /chat response (status and
// body, agentObservability included), the run's events, steps, result and
// error, the trace, the agent events a streaming client would receive, and
// the Skill calls made -- for the scenarios the outer plan owns: document QA
// with a follow-up retrieval, an abstention that falls through to the Web
// stage with and without a standing approval, the custom-Skill stage, a
// Capability approval (AgentRunInterruptError -> waiting_for_user, then the
// approval re-entry), a research brief, budget exhaustion, a cancellation at
// a stage boundary (both reasons), a cancellation surfaced by the drain
// after a stage settled, and a dependency outage.
//
// Every scenario runs twice (PASSES below), once per value of the outer
// plan's own dial: AGENT_OUTER_PLAN_RUNTIME unset -- the production setting,
// the outer plan on the native loop -- and AGENT_OUTER_PLAN_RUNTIME=langgraph,
// the outer plan on the LangGraph Pregel. The custom-Skill DAG runs on
// LangGraph in both: the native graph scheduler and the AGENT_RUNTIME dial
// were removed in ADR 0001 phase 6 (until then a pass ran everything under
// AGENT_RUNTIME=native and anchored the others). Before the deletion the
// native pass of the three trajectory cases whose custom-Skill stage runs a
// guarded DAG (`customSkillGraph` below) was frozen, masked exactly as here,
// under test/fixtures/graph-goldens/langgraph-execution-plan-graph/ from HEAD
// e1385c1c with AGENT_RUNTIME=native, and the production pass is now held to
// it (assertMatchesGraphGolden); every other scenario builds no custom-Skill
// DAG or v3 graph and plans through injected adapters, so AGENT_RUNTIME
// never changed how it ran. Both passes answer exactly alike.
//
// The trajectory cases keep their run stores private, so the evaluation
// modules' import of rag/agent-runs.js is redirected to the phase-2 recording
// stand-in, and the runner's on-demand import of the graph module is
// redirected to a tap that records each invocation; a LangGraph pass that
// never left the native loop fails the suite, and so does a native pass that
// left it. The custom-Skill stage's import of the LangGraph executor is
// tapped too, so the DAG's LangGraph invocations are compared between the two
// passes: who schedules the outer plan must not change them.
//
// Masked, and only these: UUIDs, ISO timestamps, wall-clock measurements
// (durationMs, latencyMs, totalDurationMs) and the checkpoint digest.
const PARITY_DIRECTORY = new URL("./langgraph-runtime-parity/", import.meta.url);
const RUN_STORE_TAP_URL = new URL("agent-run-store-tap.mjs", PARITY_DIRECTORY).href;
const EXECUTOR_TAP_URL = new URL("langgraph-executor-tap.mjs", PARITY_DIRECTORY).href;
const PLAN_GRAPH_TAP_URL = new URL(
  "./langgraph-execution-plan-graph/plan-graph-tap.mjs",
  import.meta.url
).href;

register("./langgraph-runtime-parity/redirect-hooks.mjs", import.meta.url, {
  data: {
    redirects: [
      {
        capture: RUN_STORE_TAP_URL,
        fromPrefix: new URL("../evaluation/", import.meta.url).href,
        target: new URL("../rag/agent-runs.js", import.meta.url).href,
      },
      {
        capture: PLAN_GRAPH_TAP_URL,
        fromPrefix: new URL("../rag/", import.meta.url).href,
        target: new URL("../rag/langgraph/execution-plan-graph.js", import.meta.url).href,
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
const {
  ANSWER_RATE_FLAGS_OFF,
  maskVolatile,
  projectAgentError,
  projectAgentRun,
  withEnv,
} = await import("./langgraph-execution-plan-graph/mask.mjs");
const { takeCreatedAgentRuns } = await import(RUN_STORE_TAP_URL);
const { runAgentExecutionPlanOnLangGraph: tappedPlanGraphRunner, takePlanGraphInvocations } =
  await import(PLAN_GRAPH_TAP_URL);
const { takeLangGraphInvocations } = await import(EXECUTOR_TAP_URL);
const { runWithAgentEventSink } = await import("../rag/agent-event-stream.js");
const { AgentRunInterruptError } = await import("../rag/agent-interrupts.js");
const { AGENT_EXECUTION_STEP_IDS, validateAgentExecutionPlan } = await import(
  "../rag/agent-execution-plan.js"
);
const { resolveAgentExecutionPlanRunner, runAgentExecutionPlan } = await import(
  "../rag/agent-execution-plan-runner.js"
);
const { deterministicPlannerAdapter } = await import("../rag/agent-execution-plan.js");
const { deterministicIntentPlannerAdapter } = await import("../rag/agent-intent-planner.js");
const { runAgentRag } = await import("../rag/agent.js");
const { AGENT_RUN_STATUSES, createAgentRunService, createInMemoryAgentRunStore } = await import(
  "../rag/agent-runs.js"
);
const { CAPABILITY_IDS } = await import("../rag/capabilities/index.js");
const { getAgentOuterPlanRuntime } = await import("../rag/config.js");
const { DependencyOutageError } = await import("../rag/dependency-outage.js");
const { LANGSMITH_TRACING_ENABLED_CODE } = await import("../rag/langgraph/langsmith-guard.js");
const {
  EXECUTION_PLAN_GRAPH_INPUT,
  EXECUTION_PLAN_RECEIPT_REASONS,
  LANGGRAPH_EXECUTION_PLAN_ERROR_CODES,
  bindExecutionPlanGraphContext,
  compileAgentExecutionPlanGraph,
  runAgentExecutionPlanOnLangGraph,
} = await import("../rag/langgraph/execution-plan-graph.js");
const {
  REQUEST_CANCELLATION_REASONS,
  RequestCancelledError,
  createRequestCancellation,
  runWithRequestCancellation,
} = await import("../rag/request-deadline.js");
const { ServiceUnavailableError } = await import("../rag/service-client.js");
const { runTrajectoryEvaluation } = await import("../evaluation/trajectory-eval.js");
const { assertMatchesGraphGolden } = await import("./langgraph-support/graph-goldens.mjs");
const {
  createAccessScopeCase,
  createBudgetCase,
  createClarificationCase,
  createFollowUpCase,
  createSkillChainCase,
} = await import("../evaluation/trajectory/cases/core-flow.js");
const { createMemoryNotEvidenceCase, createMultiDocConflictCase } = await import(
  "../evaluation/trajectory/cases/evidence-memory.js"
);
const { createGoalLifecycleCase } = await import("../evaluation/trajectory/cases/goal-lifecycle.js");
const { createPlannerFallbackCase, createPrivacySanitizationCase } = await import(
  "../evaluation/trajectory/cases/planner-privacy.js"
);
const { createApprovalResumeCase, createCustomSkillRetryCase, createWebApprovalDenyCase } =
  await import("../evaluation/trajectory/cases/run-control.js");

// The stages each LangGraph pass really scheduled: every outer-plan graph
// LangGraph streams (one whose nodes are all execution step ids, never the
// custom-Skill DAG's or the v3 graph's) records its node ids in order. The
// graph leaves out a built-in stage whose Skill was not selected
// (isAgentExecutionPlanStageStaticallyInert), so a parity pass proves that
// pruning changed nothing only if it is seen to have pruned.
const { Pregel } = await import("@langchain/langgraph/pregel");
const OUTER_PLAN_STEP_IDS = new Set(Object.values(AGENT_EXECUTION_STEP_IDS));
const RUNTIME_DECIDED_STEP_IDS = new Set([
  AGENT_EXECUTION_STEP_IDS.customSkills,
  AGENT_EXECUTION_STEP_IDS.documentRag,
  AGENT_EXECUTION_STEP_IDS.webSearch,
]);
const scheduledShapes = [];
const streamPregel = Pregel.prototype.stream;

Pregel.prototype.stream = function streamRecordingOuterPlanShape(...args) {
  const nodeIds = Object.keys(this.nodes ?? {});

  if (nodeIds.length > 0 && nodeIds.every((nodeId) => OUTER_PLAN_STEP_IDS.has(nodeId))) {
    scheduledShapes.push(nodeIds);
  }

  return streamPregel.apply(this, args);
};

const CREATED_AT = "2026-10-14T00:00:00.000Z";
// The two passes of every scenario, by the outer plan's dial they pin (the
// custom-Skill DAG runs on LangGraph in both):
//   native    -- AGENT_OUTER_PLAN_RUNTIME unset, the production setting: the
//                outer plan on the native loop;
//   langgraph -- the experimental AGENT_OUTER_PLAN_RUNTIME=langgraph: the
//                outer plan on the LangGraph Pregel (what this suite was
//                written to prove).
const PASSES = Object.freeze({
  native: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: undefined }),
  langgraph: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: "langgraph" }),
});
const PASS_DIALS = Object.freeze({
  native: Object.freeze({ outerPlan: "native" }),
  langgraph: Object.freeze({ outerPlan: "langgraph" }),
});
const ACCESS_SCOPE = Object.freeze({ userId: "alice", workspaceId: "workspace-a" });
const QUESTION = "What does remote work require?";
const CITATION = Object.freeze({
  docId: "doc-1",
  excerpt: "Remote work requires manager approval.",
  fileName: "policy.pdf",
  pageNumber: 2,
  sourceLabel: "Source 1",
  text: "Remote work requires manager approval.",
});
const ANSWER_TEXT = "Remote work requires manager approval. [Source 1]";
const DETERMINISTIC_STEP_IDS = [
  AGENT_EXECUTION_STEP_IDS.arxivImport,
  AGENT_EXECUTION_STEP_IDS.workspaceAction,
  AGENT_EXECUTION_STEP_IDS.researchBrief,
  AGENT_EXECUTION_STEP_IDS.inventory,
  AGENT_EXECUTION_STEP_IDS.documentDiscovery,
  AGENT_EXECUTION_STEP_IDS.documentRag,
  AGENT_EXECUTION_STEP_IDS.webSearch,
];

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const RUN_ENV = Object.freeze({
  ...ANSWER_RATE_FLAGS_OFF,
  AGENT_CANCEL_ON_DISCONNECT: undefined,
  AGENT_REQUEST_TIMEOUT_MS: undefined,
  AGENT_SKILL_GRAPH_ROLLOUT: undefined,
  AGENT_UNIFIED_GRAPH_ROLLOUT: "off",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

// The pass running now (a work function may count per pass).
let currentPass = null;

/**
 * Runs `work` with both dials pinned for `pass` and returns its outcome with
 * every run the evaluation modules created, every plan-graph and custom-Skill
 * DAG executor invocation made meanwhile, and every agent event a streaming
 * client would have received.
 */
const runOnPass = (pass, work) =>
  withEnv({ ...RUN_ENV, ...PASSES[pass] }, async () => {
    await takeCreatedAgentRuns();
    takePlanGraphInvocations();
    takeLangGraphInvocations();
    scheduledShapes.splice(0);
    assert.equal(getAgentOuterPlanRuntime(), PASS_DIALS[pass].outerPlan);

    const events = [];

    currentPass = pass;

    try {
      const outcome = await runWithAgentEventSink((event) => events.push(event), work);

      return {
        events,
        graphInvocations: takeLangGraphInvocations(),
        invocations: takePlanGraphInvocations(),
        outcome,
        runs: await takeCreatedAgentRuns(),
        scheduledShapes: scheduledShapes.splice(0),
      };
    } finally {
      currentPass = null;
    }
  });

const runOnEveryPass = async (work) => {
  const passes = {};

  for (const pass of Object.keys(PASSES)) {
    passes[pass] = await runOnPass(pass, work);
  }

  return passes;
};

// The LangGraph pass against the native one: the outer plan's scheduler
// changes nothing a client, the run store or a streaming client can see.
const assertPassesIdentical = ({ langgraph, native }) => {
  assert.deepStrictEqual(maskVolatile(langgraph.outcome), maskVolatile(native.outcome));
  assert.deepStrictEqual(maskVolatile(langgraph.events), maskVolatile(native.events));
  assert.deepStrictEqual(
    maskVolatile(langgraph.runs.map(projectAgentRun)),
    maskVolatile(native.runs.map(projectAgentRun))
  );
};

// The outer dial unset keeps the outer plan on the native loop (no plan-graph
// invocation, no outer-plan graph streamed), and the custom-Skill DAG's
// LangGraph invocations do not depend on who scheduled the outer plan: the
// native loop's custom_skills stage makes exactly the ones the LangGraph
// pass's custom_skills node makes.
const assertOuterPlanFollowsItsOwnDial = ({ langgraph, native }) => {
  assert.deepStrictEqual(native.invocations, []);
  assert.deepStrictEqual(native.scheduledShapes, []);
  assert.deepStrictEqual(native.graphInvocations, langgraph.graphInvocations);
};

// Every plan the LangGraph pass received was streamed as a graph of its
// stages in plan order, without any stage that decides at run time
// (custom_skills, document_rag, web_search) left out.
const assertScheduledShapesFollowPlans = ({ langgraph }) => {
  assert.equal(langgraph.scheduledShapes.length, langgraph.invocations.length);

  langgraph.invocations.forEach(({ stepIds }, index) => {
    const shape = langgraph.scheduledShapes[index];
    const label = JSON.stringify({ shape, stepIds });

    assert.ok(shape.length > 0, label);
    assert.deepStrictEqual(
      stepIds.filter((stepId) => shape.includes(stepId)),
      shape,
      label
    );
    assert.ok(
      stepIds.every((stepId) => !RUNTIME_DECIDED_STEP_IDS.has(stepId) || shape.includes(stepId)),
      label
    );
  });
};

// The native pass never touches the outer-plan graph; the LangGraph pass
// schedules every outer plan on it, with the validated plan's step ids.
const assertScheduledOnLangGraph = (passes, { minimumInvocations = 1 } = {}) => {
  const { langgraph } = passes;

  assertOuterPlanFollowsItsOwnDial(passes);
  assert.ok(
    langgraph.invocations.length >= minimumInvocations,
    `expected at least ${minimumInvocations} plan-graph invocation(s), got ${langgraph.invocations.length}`
  );

  for (const invocation of langgraph.invocations) {
    assert.ok(invocation.stepIds.length > 0);
    assert.ok(
      invocation.stepIds.every((stepId) => Object.values(AGENT_EXECUTION_STEP_IDS).includes(stepId)),
      JSON.stringify(invocation.stepIds)
    );
  }

  assertScheduledShapesFollowPlans(passes);
};

const runTrajectoryCase = async (createCase) => {
  const report = await runTrajectoryEvaluation({
    cases: [createCase()],
    createdAt: CREATED_AT,
    runId: "langgraph-execution-plan-graph",
  });

  assert.equal(report.cases.length, 1);
  return report.cases[0];
};

// Every trajectory case the V1 outer plan answers (the skill_graph cases are
// phase-2 evidence, the unified_graph cases pin the v3 graph), with what each
// one proves about the outer plan on LangGraph. `planned: false` marks a case
// whose request never reaches the plan (a pre-execution clarification, an
// import approval asked before execution, a goal driven through tasks): it
// must make no plan-graph invocation on either pass. `customSkillGraph:
// true` marks a case whose custom-Skill stage runs a guarded DAG, which both
// passes must schedule on LangGraph (the same invocations,
// assertOuterPlanFollowsItsOwnDial) and whose outcome, agent events and runs
// must equal what the removed native scheduler produced (its golden); every
// other case makes no executor invocation.
const TRAJECTORY_CASES = [
  ["document_follow_up_retrieval", createFollowUpCase, "document QA with a follow-up retrieval"],
  [
    "skill_chain_contract_review",
    createSkillChainCase,
    "the custom-Skill stage",
    { customSkillGraph: true },
  ],
  [
    "comparison_requires_clarification",
    createClarificationCase,
    "a pre-execution clarification never builds the graph",
    { planned: false },
  ],
  [
    "custom_skill_access_scope",
    createAccessScopeCase,
    "access scope through the custom stage",
    { customSkillGraph: true },
  ],
  ["budget_exhaustion_clarification", createBudgetCase, "budget exhaustion in the document loop"],
  [
    "capability_approval_resume",
    createApprovalResumeCase,
    "an AgentRunInterruptError parks the run waiting_for_user and the approval re-entry completes it",
  ],
  ["custom_skill_retry", createCustomSkillRetryCase, "a failed V1 custom step retried from the run"],
  ["memory_not_evidence", createMemoryNotEvidenceCase, "memory is never evidence"],
  [
    "web_approval_deny",
    createWebApprovalDenyCase,
    "the Web stage without a standing approval parks at its gate; a denial completes the run",
  ],
  [
    "multi_doc_conflict",
    createMultiDocConflictCase,
    "a multi-document conflict",
    { customSkillGraph: true },
  ],
  ["planner_fallback", createPlannerFallbackCase, "the planner fallback"],
  [
    "privacy_sanitization",
    createPrivacySanitizationCase,
    "an import approval asked before execution never builds the graph",
    { planned: false },
  ],
  [
    "agent_goal_lifecycle_completion",
    createGoalLifecycleCase,
    "a goal driven through tasks never builds the graph",
    { planned: false },
  ],
];

for (const [
  caseId,
  createCase,
  proves,
  { customSkillGraph = false, planned = true } = {},
] of TRAJECTORY_CASES) {
  test(`${caseId} is identical on both runtimes (${proves})`, async () => {
    const passes = await runOnEveryPass(() => runTrajectoryCase(createCase));
    const { native } = passes;

    // Parity of two broken runs proves nothing: the case holds natively.
    assert.equal(native.outcome.id, caseId);
    assert.equal(native.outcome.passed, true, JSON.stringify(native.outcome.checks));
    // A case without a run store creates no run; the ones with one (approval
    // resume, custom-Skill retry, the Web gate, the goal lifecycle) compare
    // every run they created.
    assertPassesIdentical(passes);

    if (planned) {
      assertScheduledOnLangGraph(passes);
    } else {
      assert.deepStrictEqual(passes.langgraph.invocations, []);
      assertOuterPlanFollowsItsOwnDial(passes);
    }

    if (customSkillGraph) {
      // The production pass (the other one equals it, above) against what
      // the native scheduler did before phase 6.
      assertMatchesGraphGolden("langgraph-execution-plan-graph", caseId, {
        events: maskVolatile(native.events),
        outcome: maskVolatile(native.outcome),
        runs: maskVolatile(native.runs.map(projectAgentRun)),
      });
      assert.ok(
        passes.langgraph.graphInvocations.length > 0,
        "the custom-Skill DAG was scheduled on LangGraph"
      );
    } else {
      assert.deepStrictEqual(passes.langgraph.graphInvocations, []);
    }
  });
}

// --- Direct scenarios ------------------------------------------------------

const createRunService = () =>
  createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });

// A ragService in the shape the route gives the agent (test/agent-cancellation
// pattern): `chat` answers from the fixture, everything else is inert.
const createRagService = ({ chat } = {}) => ({
  chat:
    chat ??
    (async (docIds, question) => ({
      abstained: false,
      citations: [CITATION],
      memoryApplied: false,
      resolvedQuery: question,
      text: ANSWER_TEXT,
    })),
  clearDocuments: async () => [],
  clearSessionMemory: () => true,
  deleteDocument: async () => null,
  getDocument: (docId) => (docId === "doc-1" ? { docId: "doc-1", fileName: "policy.pdf" } : null),
  ingestDocument: async () => null,
  initializeDocumentRegistry: async () => [],
  initializeSessionMemory: async () => true,
  listDocuments: () => [{ docId: "doc-1", fileName: "policy.pdf" }],
});

const askAgent = ({ agentRunService, ragService, ...overrides }) =>
  runAgentRag({
    accessScope: ACCESS_SCOPE,
    agentRunService,
    docIds: ["doc-1"],
    executionPlannerAdapter: deterministicPlannerAdapter,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    question: QUESTION,
    ragService,
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search must not run.");
    },
    ...overrides,
  });

const listRuns = async (agentRunService) =>
  (await agentRunService.listRuns({ accessScope: ACCESS_SCOPE })).runs;

const readRuns = async (agentRunService) => {
  const runs = [];

  for (const listed of await listRuns(agentRunService)) {
    runs.push(await agentRunService.getRun({ accessScope: ACCESS_SCOPE, runId: listed.runId }));
  }

  return runs;
};

// A direct scenario: its own run service per pass, the thrown error (if any)
// as the route sees it, and every run the pass created.
const runDirectScenario = (scenario) =>
  runOnEveryPass(async () => {
    const agentRunService = createRunService();
    let response = null;
    let error = null;

    try {
      response = await scenario({ agentRunService });
    } catch (thrown) {
      error = thrown;
    }

    return {
      error: error ? projectAgentError(error) : null,
      errorIsOutage: error instanceof DependencyOutageError,
      errorIsCancellation: error instanceof RequestCancelledError,
      response,
      runs: (await readRuns(agentRunService)).map(projectAgentRun),
    };
  });

test("a research brief is identical on both runtimes", async () => {
  const passes = await runDirectScenario(({ agentRunService }) =>
    askAgent({
      agentRunService,
      question: "Write a research brief on the key risks in this policy.",
      ragService: createRagService(),
    })
  );
  const { native } = passes;

  assert.equal(native.outcome.error, null);
  assert.equal(native.outcome.response.status, 200);
  assert.ok(
    native.outcome.runs[0].steps.some((step) => step.type === "research_question"),
    "the brief asked its research questions"
  );
  assertPassesIdentical(passes);
  assertScheduledOnLangGraph(passes);
  assert.deepStrictEqual(passes.langgraph.invocations[0].stepIds, DETERMINISTIC_STEP_IDS);
  // Only the selected built-in stage of the five is scheduled.
  assert.deepStrictEqual(passes.langgraph.scheduledShapes, [
    [
      AGENT_EXECUTION_STEP_IDS.researchBrief,
      AGENT_EXECUTION_STEP_IDS.documentRag,
      AGENT_EXECUTION_STEP_IDS.webSearch,
    ],
  ]);
});

test("an abstention falls through to the Web stage identically: without a standing approval the run parks at the gate, with one Web answers", async () => {
  const abstaining = async (docIds, question) => ({
    abstained: true,
    citations: [],
    memoryApplied: false,
    resolvedQuery: question,
    text: "The documents do not say.",
  });

  const withoutApproval = await runDirectScenario(({ agentRunService }) =>
    askAgent({
      agentRunService,
      ragService: createRagService({ chat: abstaining }),
      webChatService: async () => {
        throw new Error("Web search must not run without an approval.");
      },
    })
  );

  assert.equal(withoutApproval.native.outcome.error, null);
  assert.equal(withoutApproval.native.outcome.response.body.agentMode, "clarification");
  assert.equal(
    withoutApproval.native.outcome.response.body.clarification.reason,
    "capability_approval_required"
  );
  assert.equal(withoutApproval.native.outcome.runs[0].status, AGENT_RUN_STATUSES.waitingForUser);
  assertPassesIdentical(withoutApproval);
  assertScheduledOnLangGraph(withoutApproval);

  const webCalls = { langgraph: 0, native: 0 };
  const withApproval = await runDirectScenario(({ agentRunService }) =>
    askAgent({
      agentRunService,
      capabilityApprovals: {
        [CAPABILITY_IDS.webSearch]: {
          approved: true,
          decision: "approved",
          source: "test_approval",
        },
      },
      ragService: createRagService({ chat: abstaining }),
      webChatService: async () => {
        webCalls[currentPass] += 1;
        return { text: "Remote work requires manager approval, says the web." };
      },
    })
  );

  assert.equal(withApproval.native.outcome.error, null);
  assert.equal(withApproval.native.outcome.response.status, 200);
  assert.equal(withApproval.native.outcome.response.body.agentMode, "document_web");
  assert.ok(
    withApproval.native.outcome.runs[0].steps.some(
      (step) => step.id === "web_search:primary" && step.status === "completed"
    ),
    "the Web step ran"
  );
  assert.deepStrictEqual(webCalls, { langgraph: 1, native: 1 });
  assertPassesIdentical(withApproval);
  assertScheduledOnLangGraph(withApproval);
});

test("a dependency outage ends the run identically: the thrown 503, the failed run and its retryable error", async () => {
  const passes = await runDirectScenario(({ agentRunService }) =>
    askAgent({
      agentRunService,
      ragService: createRagService({
        chat: async () => {
          throw new ServiceUnavailableError("The retrieval service is unreachable.", {
            code: "SERVICE_UNREACHABLE",
            service: "retrieval",
          });
        },
      }),
    })
  );
  const { native } = passes;

  assert.equal(native.outcome.errorIsOutage, true);
  assert.equal(native.outcome.error.status, 503);
  assert.equal(native.outcome.error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(native.outcome.error.dependency, "retrieval");
  assert.equal(native.outcome.error.causeCode, "SERVICE_UNREACHABLE");
  assert.equal(native.outcome.runs[0].status, AGENT_RUN_STATUSES.failed);
  assert.equal(native.outcome.runs[0].error.retryable, true);
  assertPassesIdentical(passes);
  assertScheduledOnLangGraph(passes);
});

// The native loop throws the request's cancellation at the stage boundary; the
// graph's first node passes the same safe point and ends the stream with a
// drain, which resolves to the same RequestCancelledError.
test("a request already cancelled stops at the first stage boundary with the same code on both runtimes, for both reasons", async () => {
  for (const [reason, status] of [
    [REQUEST_CANCELLATION_REASONS.clientCancelled, AGENT_RUN_STATUSES.canceled],
    [REQUEST_CANCELLATION_REASONS.deadlineExceeded, AGENT_RUN_STATUSES.failed],
  ]) {
    const passes = await runDirectScenario(({ agentRunService }) => {
      const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });

      cancellation.cancel(reason);

      return runWithRequestCancellation(cancellation, () =>
        askAgent({
          agentRunService,
          ragService: createRagService({
            chat: async () => {
              throw new Error("No stage may run once the request is cancelled.");
            },
          }),
        })
      ).finally(cancellation.dispose);
    });
    const { native } = passes;

    assert.equal(native.outcome.errorIsCancellation, true, reason);
    assert.equal(native.outcome.error.reason, reason);
    assert.equal(native.outcome.runs[0].status, status);
    assert.equal(native.outcome.runs[0].error.reason, reason);
    assert.deepStrictEqual(native.outcome.runs[0].steps, []);
    assertPassesIdentical(passes);
    assertScheduledOnLangGraph(passes);
    // The document question's five built-in stages, the first of them the
    // one whose safe point stops the native loop, are not scheduled.
    assert.deepStrictEqual(passes.langgraph.scheduledShapes, [
      [AGENT_EXECUTION_STEP_IDS.documentRag, AGENT_EXECUTION_STEP_IDS.webSearch],
    ]);
  }
});

// The signal fires while the document stage runs, and the stage still
// settles: natively the next stage's safe point throws; on LangGraph the
// drain stops the loop after that superstep and the stream ends with the
// same cancellation. Either way the document step is recorded completed and
// the run ends canceled.
test("a cancellation during a stage surfaces after that stage settles, through the drain, with the same run record", async () => {
  const passes = await runDirectScenario(({ agentRunService }) => {
    const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });

    return runWithRequestCancellation(cancellation, () =>
      askAgent({
        agentRunService,
        ragService: createRagService({
          chat: async (docIds, question) => {
            cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);

            return {
              abstained: false,
              citations: [CITATION],
              memoryApplied: false,
              resolvedQuery: question,
              text: ANSWER_TEXT,
            };
          },
        }),
      })
    ).finally(cancellation.dispose);
  });
  const { native } = passes;

  assert.equal(native.outcome.errorIsCancellation, true);
  assert.equal(native.outcome.error.code, "AGENT_CLIENT_CANCELLED");
  assert.equal(native.outcome.runs[0].status, AGENT_RUN_STATUSES.canceled);
  assert.ok(
    native.outcome.runs[0].steps.some(
      (step) => step.id === "document_rag:primary" && step.status === "completed"
    ),
    "the document step settled before the cancellation surfaced"
  );
  assertPassesIdentical(passes);
  assertScheduledOnLangGraph(passes);
});

test("a deadline that passes inside a stage ends the run failed with AGENT_DEADLINE_EXCEEDED on both runtimes", async () => {
  const passes = await runDirectScenario(({ agentRunService }) => {
    const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });

    return runWithRequestCancellation(cancellation, () =>
      askAgent({
        agentRunService,
        ragService: createRagService({
          chat: () =>
            new Promise((resolve, reject) => {
              // The model call hangs until the deadline passes, as a bound
              // model call aborted by the request signal does.
              cancellation.signal.addEventListener(
                "abort",
                () => reject(cancellation.signal.reason),
                { once: true }
              );
              setTimeout(() => cancellation.cancel(REQUEST_CANCELLATION_REASONS.deadlineExceeded), 5);
            }),
        }),
      })
    ).finally(cancellation.dispose);
  });
  const { native } = passes;

  assert.equal(native.outcome.errorIsCancellation, true);
  assert.equal(native.outcome.error.code, "AGENT_DEADLINE_EXCEEDED");
  assert.equal(native.outcome.error.status, 504);
  assert.equal(native.outcome.runs[0].status, AGENT_RUN_STATUSES.failed);
  assert.equal(native.outcome.runs[0].error.reason, "deadline_exceeded");
  assertPassesIdentical(passes);
  assertScheduledOnLangGraph(passes);
});

// A stage that fails right after a burst of agent events. Natively each event
// reaches the client as it is emitted, then the error. On the LangGraph
// Pregel the events travel as custom stream chunks, and LangGraph errors its
// stream (a ReadableStream, which drops every chunk not yet read) a microtask
// after a node fails or a drain stops the loop, so a node may settle only once
// the consumer has forwarded what it relayed. Here the primary answer carries
// an unsupported claim (the stipend), so the document stage emits its
// document_rag, self_check and gap_analysis steps and plans a follow-up
// retrieval; the cancellation raised during the primary call throws at the
// follow-up step's start, a safe point inside the same stage, right after
// that burst.
test("a stage that throws right after a burst of agent events streams every event before the error on both runtimes, for both reasons", async () => {
  for (const [reason, code, status] of [
    [REQUEST_CANCELLATION_REASONS.deadlineExceeded, "AGENT_DEADLINE_EXCEEDED", AGENT_RUN_STATUSES.failed],
    [REQUEST_CANCELLATION_REASONS.clientCancelled, "AGENT_CLIENT_CANCELLED", AGENT_RUN_STATUSES.canceled],
  ]) {
    const passes = await runDirectScenario(({ agentRunService }) => {
      const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });

      return runWithRequestCancellation(cancellation, () =>
        askAgent({
          agentRunService,
          question: "What does remote work require and what stipend is paid?",
          ragService: createRagService({
            chat: async (docIds, question) => {
              cancellation.cancel(reason);

              return {
                abstained: false,
                citations: [CITATION],
                memoryApplied: false,
                resolvedQuery: question,
                text:
                  "Remote work requires manager approval. Employees also receive a 500 " +
                  "dollar stipend for home office equipment. [Source 1]",
              };
            },
          }),
        })
      ).finally(cancellation.dispose);
    });
    const { native } = passes;

    assert.equal(native.outcome.errorIsCancellation, true, reason);
    assert.equal(native.outcome.error.code, code, reason);
    assert.equal(native.outcome.runs[0].status, status, reason);
    assert.ok(
      native.outcome.runs[0].steps.some(
        (step) => step.id === "document_rag:primary" && step.status === "completed"
      ),
      "the primary document step settled before the cancellation surfaced"
    );
    // The burst the stage emitted before its own safe point threw.
    assert.deepStrictEqual(
      native.events.slice(-3).map((event) => event.step?.type),
      ["document_rag", "self_check", "gap_analysis"],
      reason
    );
    assertPassesIdentical(passes);
    assertScheduledOnLangGraph(passes);
  }
});

// On LangGraph a built-in stage whose Skill was not selected is not scheduled
// at all (isAgentExecutionPlanStageStaticallyInert): its body would return at
// once, so only its safe point is left out, and the next node's safe point or
// the drain stands in for it. Natively that safe point is where the
// cancellation surfaces. A plan with such stages first and between two
// scheduled ones (inventory and research_brief here, neither selected for a
// document question) must end every cancellation the same way: before the
// first stage (natively at inventory's safe point; on LangGraph the drain
// stops the pruned graph before its first superstep), and during the
// document stage (natively at research_brief's safe point; on LangGraph the
// drain after that superstep), for both reasons.
test("a cancellation before a stage the LangGraph plan does not schedule ends the run identically on both runtimes", async () => {
  const interleavedPlan = [
    AGENT_EXECUTION_STEP_IDS.inventory,
    AGENT_EXECUTION_STEP_IDS.documentRag,
    AGENT_EXECUTION_STEP_IDS.researchBrief,
    AGENT_EXECUTION_STEP_IDS.webSearch,
  ];
  const interleavedPlannerAdapter = {
    createExecutionPlan: () => [...interleavedPlan],
    id: "interleaved_test_plan",
  };
  const scenarios = [
    {
      cancelBeforeTheRun: true,
      reason: REQUEST_CANCELLATION_REASONS.clientCancelled,
      status: AGENT_RUN_STATUSES.canceled,
    },
    {
      cancelBeforeTheRun: true,
      reason: REQUEST_CANCELLATION_REASONS.deadlineExceeded,
      status: AGENT_RUN_STATUSES.failed,
    },
    {
      cancelBeforeTheRun: false,
      reason: REQUEST_CANCELLATION_REASONS.clientCancelled,
      status: AGENT_RUN_STATUSES.canceled,
    },
    {
      cancelBeforeTheRun: false,
      reason: REQUEST_CANCELLATION_REASONS.deadlineExceeded,
      status: AGENT_RUN_STATUSES.failed,
    },
  ];

  for (const { cancelBeforeTheRun, reason, status } of scenarios) {
    const label = `${reason} ${cancelBeforeTheRun ? "before the run" : "during the document stage"}`;
    const passes = await runDirectScenario(({ agentRunService }) => {
      const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });

      if (cancelBeforeTheRun) {
        cancellation.cancel(reason);
      }

      return runWithRequestCancellation(cancellation, () =>
        askAgent({
          agentRunService,
          executionPlannerAdapter: interleavedPlannerAdapter,
          ragService: createRagService({
            chat: async (docIds, question) => {
              if (cancelBeforeTheRun) {
                throw new Error("No stage may run once the request is cancelled.");
              }

              cancellation.cancel(reason);

              return {
                abstained: false,
                citations: [CITATION],
                memoryApplied: false,
                resolvedQuery: question,
                text: ANSWER_TEXT,
              };
            },
          }),
        })
      ).finally(cancellation.dispose);
    });
    const { native } = passes;

    assert.equal(native.outcome.errorIsCancellation, true, label);
    assert.equal(native.outcome.error.reason, reason, label);
    assert.equal(native.outcome.runs[0].status, status, label);
    assert.equal(native.outcome.runs[0].error.reason, reason, label);
    assert.deepStrictEqual(
      native.outcome.runs[0].steps.map((step) => [step.id, step.status]),
      cancelBeforeTheRun ? [] : [["document_rag:primary", "completed"]],
      label
    );
    assertPassesIdentical(passes);
    assertScheduledOnLangGraph(passes);
    // The planner's interleaved plan reached the LangGraph entry as planned
    // (no fallback to the deterministic plan); the entry itself schedules
    // only document_rag and web_search of it.
    assert.deepStrictEqual(
      passes.langgraph.invocations.map((entry) => entry.stepIds),
      [interleavedPlan],
      label
    );
    assert.deepStrictEqual(
      passes.langgraph.scheduledShapes,
      [[AGENT_EXECUTION_STEP_IDS.documentRag, AGENT_EXECUTION_STEP_IDS.webSearch]],
      label
    );
  }
});

// The one deliberate difference: LangGraph refuses to run with a LangSmith
// tracer switched on, before the graph is built; the run is failed with the
// guard's code. The outer plan on the native loop has no tracer to refuse on
// a request that builds no LangGraph graph (a document question): the
// refusal stays with the graphs that are built on LangGraph (the custom-Skill
// stage and the v3 entry refuse on their own path,
// test/langgraph-execution-graph-runtime.test.mjs and
// test/langgraph-unified-graph.test.mjs).
test("a LangSmith tracing variable refuses the LangGraph plan before any stage runs, and the run is failed with the guard's code", async () => {
  const passes = await withEnv({ LANGSMITH_TRACING: "true" }, () =>
    runDirectScenario(({ agentRunService }) =>
      askAgent({ agentRunService, ragService: createRagService() })
    )
  );

  // The outer plan on the native loop: nothing to refuse, the native answer
  // and run, and no graph built.
  assert.equal(passes.native.outcome.error, null);
  assert.equal(passes.native.outcome.response.status, 200);
  assert.deepStrictEqual(passes.native.invocations, []);
  assert.deepStrictEqual(passes.native.graphInvocations, []);

  assert.equal(passes.langgraph.outcome.error?.code, LANGSMITH_TRACING_ENABLED_CODE);
  assert.equal(passes.langgraph.outcome.response, null);
  assert.equal(passes.langgraph.outcome.runs[0].status, AGENT_RUN_STATUSES.failed);
  assert.deepStrictEqual(passes.langgraph.outcome.runs[0].steps, []);
  // The plan reached the LangGraph entry (the tap records the invocation
  // before handing it to the real entry), which refused before building the
  // graph: the run was created and planned, and no stage ran.
  assert.deepStrictEqual(passes.langgraph.invocations.map((entry) => entry.stepIds), [
    DETERMINISTIC_STEP_IDS,
  ]);
  assert.deepStrictEqual(passes.langgraph.graphInvocations, []);
});

// --- The dial -------------------------------------------------------------

// The phase-3 load test put the outer plan behind a dial of its own
// (config.js): only AGENT_OUTER_PLAN_RUNTIME=langgraph moves the outer plan
// onto LangGraph, and anything else (unset, empty, whitespace, a typo) is
// native. AGENT_RUNTIME, which since phase 6 accepts only unset or
// `langgraph`, never moves it.
test("AGENT_OUTER_PLAN_RUNTIME alone selects the outer plan's scheduler: it defaults to native, only `langgraph` selects the graph, and AGENT_RUNTIME never does", async () => {
  for (const [value, expected] of [
    [undefined, "native"],
    ["", "native"],
    ["   ", "native"],
    ["\t", "native"],
    ["native", "native"],
    ["langgraph", "langgraph"],
    [" LangGraph ", "langgraph"],
    ["pregel", "native"],
  ]) {
    for (const runtime of [undefined, "langgraph"]) {
      await withEnv({ AGENT_OUTER_PLAN_RUNTIME: value, AGENT_RUNTIME: runtime }, async () => {
        const label = `AGENT_OUTER_PLAN_RUNTIME=${JSON.stringify(value)} AGENT_RUNTIME=${runtime}`;

        assert.equal(getAgentOuterPlanRuntime(), expected, label);
        // The runner agent.js resolves with no argument follows the outer
        // dial only.
        assert.equal(
          await resolveAgentExecutionPlanRunner(),
          expected === "langgraph" ? tappedPlanGraphRunner : runAgentExecutionPlan,
          label
        );
      });
    }
  }

  assert.equal(await resolveAgentExecutionPlanRunner("native"), runAgentExecutionPlan);
  assert.equal(await resolveAgentExecutionPlanRunner("langgraph"), tappedPlanGraphRunner);
  assert.deepStrictEqual(takePlanGraphInvocations(), []);
});

// --- The compiled graph on its own --------------------------------------

const PLAN = validateAgentExecutionPlan({
  accessScope: ACCESS_SCOPE,
  executionPlan: [
    AGENT_EXECUTION_STEP_IDS.documentRag,
    AGENT_EXECUTION_STEP_IDS.webSearch,
  ],
  selectedSkills: [],
});

// The graph is compiled per plan shape and shared; what a request owns (its
// stages, execution state and control flags) travels with each invocation in
// config.configurable.
const compileWithStages = ({ stages, state }) => {
  const entered = [];
  const control = { entered: [], fatalError: null };
  const app = compileAgentExecutionPlanGraph({ executionPlan: PLAN });
  const context = bindExecutionPlanGraphContext({
    control,
    executionPlan: PLAN,
    getStage: (step) => async () => {
      entered.push(step.id);
      await stages[step.id]?.();
    },
    state,
  });

  return { app, context, control, entered };
};

const invokeGraph = ({ app, context }) =>
  app.invoke(EXECUTION_PLAN_GRAPH_INPUT, {
    configurable: { thread_id: "plan-graph-unit", ...context },
    durability: "sync",
    recursionLimit: 4,
  });

test("the compiled graph enters the stages in plan order and ends at the stage that set the response", async () => {
  const state = { response: null };
  const responding = compileWithStages({
    stages: {
      [AGENT_EXECUTION_STEP_IDS.documentRag]: async () => {
        state.response = { body: {}, status: 200 };
      },
    },
    state,
  });
  const { entered } = responding;

  const output = await invokeGraph(responding);

  assert.deepStrictEqual(entered, [AGENT_EXECUTION_STEP_IDS.documentRag]);
  assert.deepStrictEqual(output.receipts, {
    [AGENT_EXECUTION_STEP_IDS.documentRag]: {
      reason: EXECUTION_PLAN_RECEIPT_REASONS.responded,
      status: "completed",
    },
  });

  const whole = { response: null };
  const all = compileWithStages({ stages: {}, state: whole });
  const everyStage = await invokeGraph(all);

  assert.deepStrictEqual(all.entered, PLAN.map((step) => step.id));
  assert.deepStrictEqual(everyStage.receipts, {
    [AGENT_EXECUTION_STEP_IDS.documentRag]: { reason: null, status: "completed" },
    [AGENT_EXECUTION_STEP_IDS.webSearch]: { reason: null, status: "completed" },
  });
});

test("a stage error leaves the invocation as the original error object, an interrupt with the execution state attached", async () => {
  const interrupt = new AgentRunInterruptError({ type: "capability_approval_required" });
  const state = { response: null, webResult: null };
  const failing = compileWithStages({
    stages: {
      [AGENT_EXECUTION_STEP_IDS.documentRag]: async () => {
        throw interrupt;
      },
    },
    state,
  });
  const { control, entered } = failing;

  await assert.rejects(invokeGraph(failing), (error) => {
    // LangGraph sees a stand-in with a stable code only.
    assert.equal(error.code, LANGGRAPH_EXECUTION_PLAN_ERROR_CODES.stageStopped);
    assert.equal(error.message.includes("capability_approval_required"), false);
    return true;
  });
  assert.equal(control.fatalError, interrupt);
  assert.equal(interrupt.agentExecutionState, state);
  // The plan ended at the failed stage: the Web stage was never entered.
  assert.deepStrictEqual(entered, [AGENT_EXECUTION_STEP_IDS.documentRag]);
});

// Through the runner, the error the run throws is the original object: the
// outage and cancellation scenarios above check `instanceof` on the LangGraph
// pass, and here a plain stage failure comes back by identity.
test("runAgentExecutionPlanOnLangGraph rethrows the original stage error by identity", async () => {
  const thrown = new Error("stage failed");
  const webSkill = { budgetKey: "webSearchCalls", id: "web_search", kind: "built_in" };

  await assert.rejects(
    runAgentExecutionPlanOnLangGraph({
      accessScope: ACCESS_SCOPE,
      // A planned Web Skill makes the Web stage run; it then fails on its
      // first call into the budget, which this call does not provide.
      budgetState: null,
      executionPlan: PLAN,
      getSelectedSkill: (skillId) => (skillId === webSkill.id ? webSkill : null),
      ragService: { chat: async () => ({ abstained: false, citations: [], text: "" }) },
      registry: {
        get: (skillId) => (skillId === webSkill.id ? webSkill : null),
      },
      selectedSkills: [webSkill],
      webChatService: async () => {
        throw thrown;
      },
    }),
    (error) => {
      assert.notEqual(error?.code, LANGGRAPH_EXECUTION_PLAN_ERROR_CODES.stageStopped);
      assert.ok(error instanceof Error);
      return true;
    }
  );
});
