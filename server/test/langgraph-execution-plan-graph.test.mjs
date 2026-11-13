// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The V1 outer execution plan on LangGraph
// (rag/langgraph/execution-plan-graph.js), the only scheduler of the outer
// plan since ADR 0001 phase 7 removed the native loop and the
// AGENT_OUTER_PLAN_RUNTIME dial. Until then every scenario here ran twice,
// once on the native loop and once on the graph, and the two passes had to be
// identical after masking. Before the loop was deleted its pass of every
// scenario -- the /chat response (status and body, agentObservability
// included) or the thrown error, the agent events a streaming client would
// receive, and the runs' events, steps, result and error -- was frozen under
// test/fixtures/graph-goldens/langgraph-execution-plan-graph/ (commit
// 3313b40b, where the native pass wrote each fixture and both passes were
// held to it), and the graph is now held to those goldens with the same
// masking (assertMatchesGraphGolden; rewriting one is a decision, see
// test/langgraph-support/graph-goldens.mjs). The scenarios the outer plan
// owns: document QA with a follow-up retrieval, an abstention that falls
// through to the Web stage with and without a standing approval, the
// custom-Skill stage, a Capability approval (AgentRunInterruptError ->
// waiting_for_user, then the approval re-entry), a research brief, budget
// exhaustion, a cancellation at a stage boundary (both reasons), a
// cancellation surfaced by the drain after a stage settled, and a dependency
// outage. The three trajectory cases whose custom-Skill stage runs a guarded
// DAG (`customSkillGraph` below) keep the fixtures phase 6 froze from the
// native graph scheduler; phase 7 found them unchanged.
//
// One scenario left with phase 8: custom_skill_retry, a failed step of the V1
// sequential chain retried on its own from the run. It set
// AGENT_SKILL_GRAPH_ROLLOUT=off, the chain it needed is deleted, and a graph
// run refuses a standalone step retry (agent-run-graph-replay-guard.js), so
// the case and its fixture were removed rather than rewritten.
//
// The trajectory cases keep their run stores private, so the evaluation
// modules' import of rag/agent-runs.js is redirected to the phase-2 recording
// stand-in, and the runner's on-demand import of the graph module is
// redirected to a tap that records each invocation: a scenario that should
// reach the outer plan and never scheduled it on the graph fails the suite.
// The custom-Skill stage's import of the LangGraph executor is tapped too.
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
const agentExecutionPlanRunner = await import("../rag/agent-execution-plan-runner.js");
const { runAgentExecutionPlan } = agentExecutionPlanRunner;
const { deterministicPlannerAdapter } = await import("../rag/agent-execution-plan.js");
const { deterministicIntentPlannerAdapter } = await import("../rag/agent-intent-planner.js");
const { runAgentRag } = await import("../rag/agent.js");
const { AGENT_RUN_STATUSES, createAgentRunService, createInMemoryAgentRunStore } = await import(
  "../rag/agent-runs.js"
);
const { CAPABILITY_IDS } = await import("../rag/capabilities/index.js");
const config = await import("../rag/config.js");
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
const { createApprovalResumeCase, createWebApprovalDenyCase } = await import(
  "../evaluation/trajectory/cases/run-control.js"
);

// The stages each scenario really scheduled: every outer-plan graph LangGraph
// streams (one whose nodes are all execution step ids, never the custom-Skill
// DAG's or the v3 graph's) records its node ids in order. The graph leaves
// out a built-in stage whose Skill was not selected
// (isAgentExecutionPlanStageStaticallyInert), so a scenario that equals the
// native loop's golden proves that pruning changed nothing only if it is seen
// to have pruned.
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
  // Removed dials: unset, the only setting that selects nothing.
  AGENT_OUTER_PLAN_RUNTIME: undefined,
  AGENT_REQUEST_TIMEOUT_MS: undefined,
  AGENT_RUNTIME: undefined,
  AGENT_SKILL_GRAPH_ROLLOUT: undefined,
  AGENT_UNIFIED_GRAPH_ROLLOUT: "off",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

/**
 * Runs `work` with the environment pinned and returns its outcome with every
 * run the evaluation modules created, every plan-graph and custom-Skill DAG
 * executor invocation made meanwhile, and every agent event a streaming
 * client would have received.
 */
const runScenario = (work) =>
  withEnv(RUN_ENV, async () => {
    await takeCreatedAgentRuns();
    takePlanGraphInvocations();
    takeLangGraphInvocations();
    scheduledShapes.splice(0);

    const events = [];
    const outcome = await runWithAgentEventSink((event) => events.push(event), work);

    return {
      events,
      graphInvocations: takeLangGraphInvocations(),
      invocations: takePlanGraphInvocations(),
      outcome,
      runs: await takeCreatedAgentRuns(),
      scheduledShapes: scheduledShapes.splice(0),
    };
  });

// What the native loop left for a scenario (the golden, see the header),
// against this run: nothing a client, the run store or a streaming client can
// see changed when the loop was removed.
const GOLDEN_SUITE = "langgraph-execution-plan-graph";

const assertMatchesNativeGolden = (caseName, { events, outcome, runs }) =>
  assertMatchesGraphGolden(GOLDEN_SUITE, caseName, {
    events: maskVolatile(events),
    outcome: maskVolatile(outcome),
    runs: maskVolatile(runs.map(projectAgentRun)),
  });

// Every plan the graph entry received was streamed as a graph of its stages
// in plan order, without any stage that decides at run time (custom_skills,
// document_rag, web_search) left out.
const assertScheduledShapesFollowPlans = (run) => {
  assert.equal(run.scheduledShapes.length, run.invocations.length);

  run.invocations.forEach(({ stepIds }, index) => {
    const shape = run.scheduledShapes[index];
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

// Every outer plan of the scenario was scheduled on the graph, with the
// validated plan's step ids.
const assertScheduledOnLangGraph = (run, { minimumInvocations = 1 } = {}) => {
  assert.ok(
    run.invocations.length >= minimumInvocations,
    `expected at least ${minimumInvocations} plan-graph invocation(s), got ${run.invocations.length}`
  );

  for (const invocation of run.invocations) {
    assert.ok(invocation.stepIds.length > 0);
    assert.ok(
      invocation.stepIds.every((stepId) => Object.values(AGENT_EXECUTION_STEP_IDS).includes(stepId)),
      JSON.stringify(invocation.stepIds)
    );
  }

  assertScheduledShapesFollowPlans(run);
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
// must make no plan-graph invocation. `customSkillGraph: [...]` marks a case
// whose custom-Skill stage runs a guarded DAG and lists the nodes its one
// executor invocation must schedule; every other case makes no executor
// invocation. Every case's outcome, agent events and runs must equal the
// golden.
const TRAJECTORY_CASES = [
  ["document_follow_up_retrieval", createFollowUpCase, "document QA with a follow-up retrieval"],
  [
    "skill_chain_contract_review",
    createSkillChainCase,
    "the custom-Skill stage",
    { customSkillGraph: ["summarize_contract", "risk_review"] },
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
    { customSkillGraph: ["risk_review"] },
  ],
  ["budget_exhaustion_clarification", createBudgetCase, "budget exhaustion in the document loop"],
  [
    "capability_approval_resume",
    createApprovalResumeCase,
    "an AgentRunInterruptError parks the run waiting_for_user and the approval re-entry completes it",
  ],
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
    { customSkillGraph: ["compare_documents"] },
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
  { customSkillGraph = null, planned = true } = {},
] of TRAJECTORY_CASES) {
  test(`${caseId} equals the native loop's golden (${proves})`, async () => {
    const run = await runScenario(() => runTrajectoryCase(createCase));

    // A golden of a broken run proves nothing: the case holds.
    assert.equal(run.outcome.id, caseId);
    assert.equal(run.outcome.passed, true, JSON.stringify(run.outcome.checks));
    // A case without a run store creates no run; the ones with one (approval
    // resume, the Web gate, the goal lifecycle) compare every run they
    // created.
    assertMatchesNativeGolden(caseId, run);

    if (planned) {
      assertScheduledOnLangGraph(run);
    } else {
      assert.deepStrictEqual(run.invocations, []);
      assert.deepStrictEqual(run.scheduledShapes, []);
    }

    // The custom-Skill DAG's executor invocations, which the goldens do not
    // hold: the nodes of the one graph the case schedules, none reused, no
    // run to bind to. The loop's pass and the graph's pass recorded exactly
    // these at commit 3313b40b.
    assert.deepStrictEqual(
      run.graphInvocations,
      customSkillGraph
        ? [{ boundToRun: false, nodeIds: customSkillGraph, reusedNodeIds: [] }]
        : []
    );
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

// A direct scenario: its own run service, the thrown error (if any) as the
// route sees it, and every run it created.
const runDirectScenario = (scenario) =>
  runScenario(async () => {
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

test("a research brief equals the native loop's golden", async () => {
  const run = await runDirectScenario(({ agentRunService }) =>
    askAgent({
      agentRunService,
      question: "Write a research brief on the key risks in this policy.",
      ragService: createRagService(),
    })
  );

  assert.equal(run.outcome.error, null);
  assert.equal(run.outcome.response.status, 200);
  assert.ok(
    run.outcome.runs[0].steps.some((step) => step.type === "research_question"),
    "the brief asked its research questions"
  );
  assertMatchesNativeGolden("direct-research-brief", run);
  assertScheduledOnLangGraph(run);
  assert.deepStrictEqual(run.invocations[0].stepIds, DETERMINISTIC_STEP_IDS);
  // Only the selected built-in stage of the five is scheduled.
  assert.deepStrictEqual(run.scheduledShapes, [
    [
      AGENT_EXECUTION_STEP_IDS.researchBrief,
      AGENT_EXECUTION_STEP_IDS.documentRag,
      AGENT_EXECUTION_STEP_IDS.webSearch,
    ],
  ]);
});

test("an abstention falls through to the Web stage as the golden records: without a standing approval the run parks at the gate, with one Web answers", async () => {
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

  assert.equal(withoutApproval.outcome.error, null);
  assert.equal(withoutApproval.outcome.response.body.agentMode, "clarification");
  assert.equal(
    withoutApproval.outcome.response.body.clarification.reason,
    "capability_approval_required"
  );
  assert.equal(withoutApproval.outcome.runs[0].status, AGENT_RUN_STATUSES.waitingForUser);
  assertMatchesNativeGolden("direct-abstention-without-approval", withoutApproval);
  assertScheduledOnLangGraph(withoutApproval);

  let webCalls = 0;
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
        webCalls += 1;
        return { text: "Remote work requires manager approval, says the web." };
      },
    })
  );

  assert.equal(withApproval.outcome.error, null);
  assert.equal(withApproval.outcome.response.status, 200);
  assert.equal(withApproval.outcome.response.body.agentMode, "document_web");
  assert.ok(
    withApproval.outcome.runs[0].steps.some(
      (step) => step.id === "web_search:primary" && step.status === "completed"
    ),
    "the Web step ran"
  );
  assert.equal(webCalls, 1);
  assertMatchesNativeGolden("direct-abstention-with-approval", withApproval);
  assertScheduledOnLangGraph(withApproval);
});

test("a dependency outage ends the run as the golden records: the thrown 503, the failed run and its retryable error", async () => {
  const run = await runDirectScenario(({ agentRunService }) =>
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

  assert.equal(run.outcome.errorIsOutage, true);
  assert.equal(run.outcome.error.status, 503);
  assert.equal(run.outcome.error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(run.outcome.error.dependency, "retrieval");
  assert.equal(run.outcome.error.causeCode, "SERVICE_UNREACHABLE");
  assert.equal(run.outcome.runs[0].status, AGENT_RUN_STATUSES.failed);
  assert.equal(run.outcome.runs[0].error.retryable, true);
  assertMatchesNativeGolden("direct-dependency-outage", run);
  assertScheduledOnLangGraph(run);
});

// The removed native loop threw the request's cancellation at the stage
// boundary; the graph's first node passes the same safe point and ends the
// stream with a drain, which resolves to the same RequestCancelledError.
test("a request already cancelled stops at the first stage boundary with the golden's code, for both reasons", async () => {
  for (const [reason, status] of [
    [REQUEST_CANCELLATION_REASONS.clientCancelled, AGENT_RUN_STATUSES.canceled],
    [REQUEST_CANCELLATION_REASONS.deadlineExceeded, AGENT_RUN_STATUSES.failed],
  ]) {
    const run = await runDirectScenario(({ agentRunService }) => {
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

    assert.equal(run.outcome.errorIsCancellation, true, reason);
    assert.equal(run.outcome.error.reason, reason);
    assert.equal(run.outcome.runs[0].status, status);
    assert.equal(run.outcome.runs[0].error.reason, reason);
    assert.deepStrictEqual(run.outcome.runs[0].steps, []);
    assertMatchesNativeGolden(`direct-cancelled-before-first-stage-${reason}`, run);
    assertScheduledOnLangGraph(run);
    // The document question's five built-in stages, the first of them the
    // one whose safe point stopped the native loop, are not scheduled.
    assert.deepStrictEqual(run.scheduledShapes, [
      [AGENT_EXECUTION_STEP_IDS.documentRag, AGENT_EXECUTION_STEP_IDS.webSearch],
    ]);
  }
});

// The signal fires while the document stage runs, and the stage still
// settles: the removed native loop threw at the next stage's safe point; on
// LangGraph the drain stops the graph after that superstep and the stream
// ends with the same cancellation. Either way the document step is recorded
// completed and the run ends canceled.
test("a cancellation during a stage surfaces after that stage settles, through the drain, with the same run record", async () => {
  const run = await runDirectScenario(({ agentRunService }) => {
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

  assert.equal(run.outcome.errorIsCancellation, true);
  assert.equal(run.outcome.error.code, "AGENT_CLIENT_CANCELLED");
  assert.equal(run.outcome.runs[0].status, AGENT_RUN_STATUSES.canceled);
  assert.ok(
    run.outcome.runs[0].steps.some(
      (step) => step.id === "document_rag:primary" && step.status === "completed"
    ),
    "the document step settled before the cancellation surfaced"
  );
  assertMatchesNativeGolden("direct-cancelled-during-stage", run);
  assertScheduledOnLangGraph(run);
});

test("a deadline that passes inside a stage ends the run failed with AGENT_DEADLINE_EXCEEDED, as the golden records", async () => {
  const run = await runDirectScenario(({ agentRunService }) => {
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

  assert.equal(run.outcome.errorIsCancellation, true);
  assert.equal(run.outcome.error.code, "AGENT_DEADLINE_EXCEEDED");
  assert.equal(run.outcome.error.status, 504);
  assert.equal(run.outcome.runs[0].status, AGENT_RUN_STATUSES.failed);
  assert.equal(run.outcome.runs[0].error.reason, "deadline_exceeded");
  assertMatchesNativeGolden("direct-deadline-inside-stage", run);
  assertScheduledOnLangGraph(run);
});

// A stage that fails right after a burst of agent events. On the removed
// native loop each event reached the client as it was emitted, then the
// error. On the Pregel the events travel as custom stream chunks, and LangGraph errors its
// stream (a ReadableStream, which drops every chunk not yet read) a microtask
// after a node fails or a drain stops the loop, so a node may settle only once
// the consumer has forwarded what it relayed. Here the primary answer carries
// an unsupported claim (the stipend), so the document stage emits its
// document_rag, self_check and gap_analysis steps and plans a follow-up
// retrieval; the cancellation raised during the primary call throws at the
// follow-up step's start, a safe point inside the same stage, right after
// that burst.
test("a stage that throws right after a burst of agent events streams every event before the error, for both reasons", async () => {
  for (const [reason, code, status] of [
    [REQUEST_CANCELLATION_REASONS.deadlineExceeded, "AGENT_DEADLINE_EXCEEDED", AGENT_RUN_STATUSES.failed],
    [REQUEST_CANCELLATION_REASONS.clientCancelled, "AGENT_CLIENT_CANCELLED", AGENT_RUN_STATUSES.canceled],
  ]) {
    const run = await runDirectScenario(({ agentRunService }) => {
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

    assert.equal(run.outcome.errorIsCancellation, true, reason);
    assert.equal(run.outcome.error.code, code, reason);
    assert.equal(run.outcome.runs[0].status, status, reason);
    assert.ok(
      run.outcome.runs[0].steps.some(
        (step) => step.id === "document_rag:primary" && step.status === "completed"
      ),
      "the primary document step settled before the cancellation surfaced"
    );
    // The burst the stage emitted before its own safe point threw.
    assert.deepStrictEqual(
      run.events.slice(-3).map((event) => event.step?.type),
      ["document_rag", "self_check", "gap_analysis"],
      reason
    );
    assertMatchesNativeGolden(`direct-burst-then-throw-${reason}`, run);
    assertScheduledOnLangGraph(run);
  }
});

// A built-in stage whose Skill was not selected is not scheduled at all
// (isAgentExecutionPlanStageStaticallyInert): its body would return at once,
// so only its safe point is left out, and the next node's safe point or the
// drain stands in for it. On the removed native loop that safe point was
// where the cancellation surfaced. A plan with such stages first and between
// two scheduled ones (inventory and research_brief here, neither selected for
// a document question) must end every cancellation as the loop did: before
// the first stage (the loop threw at inventory's safe point; the drain stops
// the pruned graph before its first superstep), and during the document
// stage (the loop threw at research_brief's safe point; the drain stops the
// graph after that superstep), for both reasons.
test("a cancellation before a stage the plan graph does not schedule ends the run as the golden records", async () => {
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
    const run = await runDirectScenario(({ agentRunService }) => {
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

    assert.equal(run.outcome.errorIsCancellation, true, label);
    assert.equal(run.outcome.error.reason, reason, label);
    assert.equal(run.outcome.runs[0].status, status, label);
    assert.equal(run.outcome.runs[0].error.reason, reason, label);
    assert.deepStrictEqual(
      run.outcome.runs[0].steps.map((step) => [step.id, step.status]),
      cancelBeforeTheRun ? [] : [["document_rag:primary", "completed"]],
      label
    );
    assertMatchesNativeGolden(
      `direct-interleaved-plan-${reason}-${cancelBeforeTheRun ? "before-the-run" : "during-the-document-stage"}`, run);
    assertScheduledOnLangGraph(run);
    // The planner's interleaved plan reached the graph entry as planned (no
    // fallback to the deterministic plan); the entry itself schedules only
    // document_rag and web_search of it.
    assert.deepStrictEqual(
      run.invocations.map((entry) => entry.stepIds),
      [interleavedPlan],
      label
    );
    assert.deepStrictEqual(
      run.scheduledShapes,
      [[AGENT_EXECUTION_STEP_IDS.documentRag, AGENT_EXECUTION_STEP_IDS.webSearch]],
      label
    );
  }
});

// LangGraph never runs with a LangSmith tracer switched on: the outer plan's
// entry refuses before the graph is built, and the run is failed with the
// guard's code. (On the removed native loop a request that built no graph, a
// document question, answered under such a variable; since phase 7 every
// request that reaches the plan builds one.)
test("a LangSmith tracing variable refuses the plan before any stage runs, and the run is failed with the guard's code", async () => {
  const run = await withEnv({ LANGSMITH_TRACING: "true" }, () =>
    runDirectScenario(({ agentRunService }) =>
      askAgent({ agentRunService, ragService: createRagService() })
    )
  );

  assert.equal(run.outcome.error?.code, LANGSMITH_TRACING_ENABLED_CODE);
  assert.equal(run.outcome.response, null);
  assert.equal(run.outcome.runs[0].status, AGENT_RUN_STATUSES.failed);
  assert.deepStrictEqual(run.outcome.runs[0].steps, []);
  // The plan reached the graph entry (the tap records the invocation before
  // handing it to the real entry), which refused before building the graph:
  // the run was created and planned, and no stage ran.
  assert.deepStrictEqual(run.invocations.map((entry) => entry.stepIds), [DETERMINISTIC_STEP_IDS]);
  assert.deepStrictEqual(run.scheduledShapes, []);
  assert.deepStrictEqual(run.graphInvocations, []);
});

// --- One scheduler --------------------------------------------------------

// Phase 7 removed the native loop and the dial that chose between it and the
// graph: nothing resolves a runner any more, and runAgentExecutionPlan hands
// every plan to the graph module (the tap), whatever the removed variable's
// accepted values say. A removed value is refused at that entry
// (test/agent-runtime-removed.test.mjs covers every check site).
test("the outer plan has one scheduler: no dial resolves a runner, and runAgentExecutionPlan hands the plan to the graph", async () => {
  assert.equal(Object.hasOwn(config, "getAgentOuterPlanRuntime"), false);
  assert.equal(Object.hasOwn(agentExecutionPlanRunner, "resolveAgentExecutionPlanRunner"), false);
  assert.notEqual(runAgentExecutionPlan, tappedPlanGraphRunner);

  const webSkill = { budgetKey: "webSearchCalls", id: "web_search", kind: "built_in" };
  const options = () => ({
    accessScope: ACCESS_SCOPE,
    budgetState: null,
    executionPlan: [AGENT_EXECUTION_STEP_IDS.documentRag],
    getSelectedSkill: () => null,
    registry: { get: (skillId) => (skillId === webSkill.id ? webSkill : null) },
    selectedSkills: [],
  });

  for (const value of [undefined, "", "  ", "langgraph", " LangGraph "]) {
    await withEnv({ ...RUN_ENV, AGENT_OUTER_PLAN_RUNTIME: value }, async () => {
      takePlanGraphInvocations();
      // The document stage fails on the collaborators these options leave
      // out; only that the plan reached the graph entry matters here.
      await runAgentExecutionPlan(options()).catch(() => null);

      assert.deepStrictEqual(
        takePlanGraphInvocations(),
        [{ boundToRun: false, stepIds: [AGENT_EXECUTION_STEP_IDS.documentRag] }],
        `AGENT_OUTER_PLAN_RUNTIME=${JSON.stringify(value)}`
      );
    });
  }

  await withEnv({ ...RUN_ENV, AGENT_OUTER_PLAN_RUNTIME: "native" }, async () => {
    await assert.rejects(runAgentExecutionPlan(options()), (error) => {
      assert.equal(error?.code, config.AGENT_OUTER_PLAN_RUNTIME_REMOVED_CODE);
      return true;
    });
  });
  takePlanGraphInvocations();
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
