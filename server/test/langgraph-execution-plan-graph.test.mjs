// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-spike/langsmith-off.mjs";

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
// Every scenario runs four times (PASSES below): natively, with the outer
// plan on LangGraph, under AGENT_RUNTIME=langgraph with the outer dial
// unset -- the production setting, which must keep the outer plan on the
// native loop while the custom-Skill DAG still runs on LangGraph -- and with
// the outer dial alone (AGENT_RUNTIME=native), where the outer plan runs on
// LangGraph and the custom-Skill DAG nested in its custom_skills node stays
// native, because the two dials are documented as independent. All four
// answer exactly alike.
//
// The trajectory cases keep their run stores private, so the evaluation
// modules' import of rag/agent-runs.js is redirected to the phase-2 recording
// stand-in, and the runner's on-demand import of the graph module is
// redirected to a tap that records each invocation; a LangGraph pass that
// never left the native loop fails the suite, and so does an
// AGENT_RUNTIME=langgraph pass that left it without the outer dial. The
// custom-Skill stage's import of the LangGraph executor is tapped too, so the
// DAG's LangGraph invocations are compared between the two LangGraph passes.
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
const { getAgentOuterPlanRuntime, getAgentRuntime } = await import("../rag/config.js");
const { DependencyOutageError } = await import("../rag/dependency-outage.js");
const { LANGSMITH_TRACING_ENABLED_CODE } = await import("../rag/langgraph/langsmith-guard.js");
const {
  EXECUTION_PLAN_RECEIPT_REASONS,
  LANGGRAPH_EXECUTION_PLAN_ERROR_CODES,
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

const CREATED_AT = "2026-10-14T00:00:00.000Z";
// The four passes of every scenario, by the two dials they pin:
//   native      -- everything on the native schedulers;
//   langgraph   -- AGENT_RUNTIME=langgraph plus the experimental
//                  AGENT_OUTER_PLAN_RUNTIME=langgraph: the outer plan on the
//                  StateGraph (what this suite was written to prove);
//   outerNative -- AGENT_RUNTIME=langgraph alone: the outer plan stays on the
//                  native loop, the custom-Skill DAG runs on LangGraph;
//   outerOnly   -- AGENT_OUTER_PLAN_RUNTIME=langgraph with AGENT_RUNTIME=
//                  native: the outer plan on the StateGraph with a native
//                  custom-Skill DAG inside its custom_skills node.
const PASSES = Object.freeze({
  native: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: undefined, AGENT_RUNTIME: "native" }),
  langgraph: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: "langgraph", AGENT_RUNTIME: "langgraph" }),
  outerNative: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: undefined, AGENT_RUNTIME: "langgraph" }),
  outerOnly: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: "langgraph", AGENT_RUNTIME: "native" }),
});
const PASS_DIALS = Object.freeze({
  native: Object.freeze({ outerPlan: "native", runtime: "native" }),
  langgraph: Object.freeze({ outerPlan: "langgraph", runtime: "langgraph" }),
  outerNative: Object.freeze({ outerPlan: "native", runtime: "langgraph" }),
  outerOnly: Object.freeze({ outerPlan: "langgraph", runtime: "native" }),
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
    assert.equal(getAgentRuntime(), PASS_DIALS[pass].runtime);
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

// Every LangGraph pass against the native one: neither the outer plan's
// scheduler nor the DAG's changes anything a client, the run store or a
// streaming client can see.
const assertPassesIdentical = (passes) => {
  const { native } = passes;

  for (const pass of ["langgraph", "outerNative", "outerOnly"]) {
    const other = passes[pass];

    assert.deepStrictEqual(maskVolatile(other.outcome), maskVolatile(native.outcome), pass);
    assert.deepStrictEqual(maskVolatile(other.events), maskVolatile(native.events), pass);
    assert.deepStrictEqual(
      maskVolatile(other.runs.map(projectAgentRun)),
      maskVolatile(native.runs.map(projectAgentRun)),
      pass
    );
  }
};

// AGENT_RUNTIME=langgraph without the outer dial keeps the outer plan on the
// native loop (no plan-graph invocation), and the custom-Skill DAG's
// LangGraph invocations do not depend on who scheduled the outer plan: the
// same ones as with both dials on LangGraph, none natively. The outer dial
// alone schedules exactly the plan-graph invocations both dials do, and the
// DAG inside its custom_skills node follows AGENT_RUNTIME=native: no
// executor invocation.
const assertOuterPlanFollowsItsOwnDial = ({ langgraph, native, outerNative, outerOnly }) => {
  assert.deepStrictEqual(outerNative.invocations, []);
  assert.deepStrictEqual(native.graphInvocations, []);
  assert.deepStrictEqual(outerNative.graphInvocations, langgraph.graphInvocations);
  assert.deepStrictEqual(outerOnly.invocations, langgraph.invocations);
  assert.deepStrictEqual(outerOnly.graphInvocations, []);
};

// The native pass never touches the graph; the LangGraph pass schedules every
// outer plan on it, with the validated plan's step ids, and so does the outer
// dial alone (the same invocations); the AGENT_RUNTIME=langgraph pass without
// the outer dial never does.
const assertScheduledOnLangGraph = (passes, { minimumInvocations = 1 } = {}) => {
  const { langgraph, native } = passes;

  assert.deepStrictEqual(native.invocations, []);
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
// must make no LangGraph invocation on either runtime. `customSkillGraph:
// true` marks a case whose custom-Skill stage runs a guarded DAG, which both
// AGENT_RUNTIME=langgraph passes must schedule on LangGraph (the same
// invocations, assertOuterPlanFollowsItsOwnDial); every other case makes no
// executor invocation.
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
      assert.deepStrictEqual(native.invocations, []);
      assert.deepStrictEqual(passes.langgraph.invocations, []);
      assertOuterPlanFollowsItsOwnDial(passes);
      assert.deepStrictEqual(passes.outerOnly.invocations, []);
    }

    if (customSkillGraph) {
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

  const webCalls = { langgraph: 0, native: 0, outerNative: 0, outerOnly: 0 };
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
  assert.deepStrictEqual(webCalls, { langgraph: 1, native: 1, outerNative: 1, outerOnly: 1 });
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

// The one deliberate difference: LangGraph refuses to run with a LangSmith
// tracer switched on, before the graph is built; the run is failed with the
// guard's code. The native loop has no tracer to refuse, and neither has
// AGENT_RUNTIME=langgraph without the outer dial on a request that builds no
// LangGraph graph (a document question): the outer plan runs on the native
// loop, and the refusal stays with the graphs that are still built on
// LangGraph (the custom-Skill stage and the v3 entry refuse on their own
// path, test/langgraph-execution-graph-runtime.test.mjs and
// test/langgraph-unified-graph.test.mjs).
test("a LangSmith tracing variable refuses the LangGraph plan before any stage runs, and the run is failed with the guard's code", async () => {
  const passes = await withEnv({ LANGSMITH_TRACING: "true" }, () =>
    runDirectScenario(({ agentRunService }) =>
      askAgent({ agentRunService, ragService: createRagService() })
    )
  );

  assert.equal(passes.native.outcome.error, null);
  assert.equal(passes.native.outcome.response.status, 200);
  // The outer plan on the native loop under AGENT_RUNTIME=langgraph: nothing
  // to refuse, the native answer and run.
  assert.equal(passes.outerNative.outcome.error, null);
  assert.deepStrictEqual(
    maskVolatile(passes.outerNative.outcome),
    maskVolatile(passes.native.outcome)
  );
  assert.deepStrictEqual(passes.outerNative.invocations, []);
  assert.deepStrictEqual(passes.outerNative.graphInvocations, []);

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
  // The refusal follows the outer dial, not AGENT_RUNTIME: the outer dial
  // alone refuses exactly as both dials do.
  assert.deepStrictEqual(
    maskVolatile(passes.outerOnly.outcome),
    maskVolatile(passes.langgraph.outcome)
  );
  assert.deepStrictEqual(passes.outerOnly.invocations, passes.langgraph.invocations);
  assert.deepStrictEqual(passes.outerOnly.graphInvocations, []);
});

// --- The dial -------------------------------------------------------------

// The phase-3 load test put the outer plan behind a dial of its own
// (config.js): AGENT_RUNTIME, whatever its value, never moves the outer plan
// onto LangGraph; only AGENT_OUTER_PLAN_RUNTIME=langgraph does, and anything
// else (unset, empty, whitespace, a typo) is native.
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
    for (const runtime of ["native", "langgraph"]) {
      await withEnv({ AGENT_OUTER_PLAN_RUNTIME: value, AGENT_RUNTIME: runtime }, async () => {
        const label = `AGENT_OUTER_PLAN_RUNTIME=${JSON.stringify(value)} AGENT_RUNTIME=${runtime}`;

        assert.equal(getAgentOuterPlanRuntime(), expected, label);
        assert.equal(getAgentRuntime(), runtime, label);
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

const compileWithStages = ({ stages, state }) => {
  const entered = [];
  const control = { entered: [], fatalError: null };
  const app = compileAgentExecutionPlanGraph({
    control,
    executionPlan: PLAN,
    getStage: (step) => async () => {
      entered.push(step.id);
      await stages[step.id]?.();
    },
    state,
  });

  return { app, control, entered };
};

const invokeGraph = (app) =>
  app.invoke(
    { receipts: {} },
    { configurable: { thread_id: "plan-graph-unit" }, durability: "sync", recursionLimit: 4 }
  );

test("the compiled graph enters the stages in plan order and ends at the stage that set the response", async () => {
  const state = { response: null };
  const { app, entered } = compileWithStages({
    stages: {
      [AGENT_EXECUTION_STEP_IDS.documentRag]: async () => {
        state.response = { body: {}, status: 200 };
      },
    },
    state,
  });

  const output = await invokeGraph(app);

  assert.deepStrictEqual(entered, [AGENT_EXECUTION_STEP_IDS.documentRag]);
  assert.deepStrictEqual(output.receipts, {
    [AGENT_EXECUTION_STEP_IDS.documentRag]: {
      reason: EXECUTION_PLAN_RECEIPT_REASONS.responded,
      status: "completed",
    },
  });

  const whole = { response: null };
  const all = compileWithStages({ stages: {}, state: whole });
  const everyStage = await invokeGraph(all.app);

  assert.deepStrictEqual(all.entered, PLAN.map((step) => step.id));
  assert.deepStrictEqual(everyStage.receipts, {
    [AGENT_EXECUTION_STEP_IDS.documentRag]: { reason: null, status: "completed" },
    [AGENT_EXECUTION_STEP_IDS.webSearch]: { reason: null, status: "completed" },
  });
});

test("a stage error leaves the invocation as the original error object, an interrupt with the execution state attached", async () => {
  const interrupt = new AgentRunInterruptError({ type: "capability_approval_required" });
  const state = { response: null, webResult: null };
  const { control, app, entered } = compileWithStages({
    stages: {
      [AGENT_EXECUTION_STEP_IDS.documentRag]: async () => {
        throw interrupt;
      },
    },
    state,
  });

  await assert.rejects(invokeGraph(app), (error) => {
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
    withEnv({ AGENT_RUNTIME: "langgraph" }, () =>
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
      })
    ),
    (error) => {
      assert.notEqual(error?.code, LANGGRAPH_EXECUTION_PLAN_ERROR_CODES.stageStopped);
      assert.ok(error instanceof Error);
      return true;
    }
  );
});
