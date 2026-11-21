import test from "node:test";
import assert from "node:assert/strict";
import {
  createDagPlannerAdapter,
  createExecutionPlannerAdapter,
  createIntentPlannerAdapter,
  createReplanAdapter,
} from "../app-services.js";
import { runAgentRag } from "../rag/agent.js";
import { DAG_PLANNER_IDS } from "../rag/agent-dag-planner-adapter.js";
import { replanAdapter } from "../rag/agent-replan-adapter.js";
import { evaluateDocumentEvidence } from "../rag/self-check/evaluate.js";
import {
  describeAgentChecks,
  describeClaimFailures,
  summarizeAgentChecks,
  summarizeAgentPlanners,
} from "../evaluation/agent-answer-outcome.js";
import {
  askAgentSurface,
  createAgentSurfacePlanners,
  describeAgentSurfaceAnswer,
  formatAgentPlanners,
} from "../evaluation/run-qasper-answer-eval.mjs";

// What eval:qasper-answers --surface agent records about the agent's
// self-checks: per row, every self_check step with the answer it read, and for
// each claim it rejected the check's own fields and the cited sources' text as
// the check compared it; in the summary, those claims by failure and the
// failed checks by reason. And how it plans: with the planners /chat builds,
// recording per row whether each fell back to the rules and why.

const citation = (rank, pageNumber, chunkIndex, excerpt) => ({
  chunkIndex,
  docId: "paper-1",
  excerpt,
  fileName: "paper-1.txt",
  pageNumber,
  rank,
  sectionHeading: null,
});
const reply = (text) => ({
  abstained: false,
  citations: [
    citation(1, 3, 4, "We train the model on SQuAD."),
    citation(2, 5, 9, "Results are reported on the development set."),
  ],
  // The chunks the check reads beside the excerpts (attachRetrievedEvidence).
  retrievedContexts: [
    { chunkIndex: 4, docId: "paper-1", pageNumber: 3, rank: 1, text: "We train the model on SQuAD.\nIt has 12 layers." },
    { chunkIndex: 9, docId: "paper-1", pageNumber: 5, rank: 2, text: "Results are reported on the development set." },
  ],
  text,
});
const check = (value) => evaluateDocumentEvidence({ docIds: ["paper-1"], ragResult: { ok: true, value } });

test("an agent row records each self-check, its rejected claims and the cited text the check compared", () => {
  const question = "Which datasets is the model trained and evaluated on?";
  // The follow-up asks the question again; replies pair with steps in call order.
  const followUpQuestion = question;
  const primary = reply("We train the model on SQuAD [Source 1]. It is evaluated on TriviaQA [Source 1][Source 2].");
  const followUp = reply("We train the model on SQuAD [Source 1].");
  const primaryCheck = check(primary);
  const followUpCheck = check(followUp);
  const rejected = primaryCheck.claimSupport.claims.find((claim) => !claim.supported);

  // The fixture: one claim of two rejected, citing two sources; the follow-up passes.
  assert.equal(primaryCheck.passed, false);
  assert.equal(followUpCheck.passed, true);
  assert.deepEqual([rejected.text, rejected.sourceRanks], ["It is evaluated on TriviaQA", [1, 2]]);

  const body = {
    agentAnswer: followUp.text,
    agentMode: "document",
    agentObservability: { executionLoop: { followUpsRun: 1, stoppedReason: "follow_up_resolved" } },
    agentTrace: [
      { type: "plan" },
      { input: { question }, output: { text: primary.text }, type: "document_rag" },
      { detail: primaryCheck, label: "Self Check", status: "failed", type: "self_check" },
      { type: "gap_analysis" },
      { input: { question: followUpQuestion }, output: { text: followUp.text }, type: "follow_up_retrieval" },
      { detail: followUpCheck, label: "Follow-up Self Check", status: "completed", type: "self_check" },
      { type: "answer_finalizer" },
    ],
    ragSources: [citation(1, 3, 4, "We train the model on SQuAD.")],
  };
  // Replies in call order; another Skill's question pairs with no step.
  const ragReplies = [
    { question: "What else does the paper say?", value: reply("Unrelated [Source 1].") },
    { question, value: primary },
    { question: followUpQuestion, value: followUp },
  ];
  const answer = describeAgentSurfaceAnswer(body, ragReplies);
  const source1 = {
    evidenceText: "We train the model on SQuAD.\nIt has 12 layers.",
    excerpt: "We train the model on SQuAD.",
    pageNumber: 3,
    rank: 1,
  };
  const source2 = {
    evidenceText: "Results are reported on the development set.",
    excerpt: "Results are reported on the development set.",
    pageNumber: 5,
    rank: 2,
  };

  assert.deepEqual(answer.agent.checks, [
    {
      answer: primary.text,
      // These checks ran without the claim judge.
      judge: null,
      passed: false,
      phase: "primary",
      reasons: primaryCheck.reasons,
      supportedClaimCount: 1,
      unsupportedClaimCount: 1,
      // The check's own fields, unchanged, plus the sources it cites.
      unsupportedClaims: [{ ...rejected, sources: [source1, source2] }],
    },
    {
      answer: followUp.text,
      judge: null,
      passed: true,
      phase: "follow_up",
      reasons: [],
      supportedClaimCount: 1,
      unsupportedClaimCount: 0,
      unsupportedClaims: [],
    },
  ]);
  // The rest of the agent answer is as before.
  assert.equal(answer.agent.stoppedReason, "follow_up_resolved");
  assert.equal(answer.abstained, false);
  assert.deepEqual(answer.citedPages, [3]);
});

test("a final self-check reads the finalizer's evidence, so it has no answer or sources", () => {
  const claim = { sourceRanks: [1], supported: false, text: "Revenue grew." };
  const [final] = describeAgentChecks({
    agentTrace: [
      {
        detail: {
          claimSupport: { claims: [claim], supportedClaimCount: 0, unsupportedClaimCount: 1 },
          finalAnswer: true,
          passed: false,
          reasons: ["1 final answer claim lacks citation support."],
        },
        type: "self_check",
      },
    ],
  });

  assert.equal(final.phase, "final");
  assert.equal(final.answer, null);
  assert.deepEqual(final.unsupportedClaims, [{ ...claim, sources: null }]);
  assert.deepEqual(describeAgentChecks({}), []);
});

test("a rejected claim is counted under each failure field or code it carries, once", () => {
  assert.deepEqual(
    describeClaimFailures({
      anchors: ["12"],
      missingAnchors: ["term:triviaqa", "term:evaluated", "12"],
      sourceRanks: [],
      verifiedSourceRanks: [],
    }),
    ["sourceRanks: none", "missingAnchors: term", "missingAnchors: anchor"]
  );
  assert.deepEqual(
    describeClaimFailures({ anchors: [], missingAnchors: ["polarity"], missingSourceRanks: [4], sourceRanks: [4] }),
    ["missingSourceRanks", "missingAnchors: polarity"]
  );
  // Nothing else set: the cited sources were not each verified.
  assert.deepEqual(describeClaimFailures({ missingAnchors: [], sourceRanks: [1, 2], verifiedSourceRanks: [1] }), [
    "verifiedSourceRanks ≠ sourceRanks",
  ]);
  assert.deepEqual(describeClaimFailures({ missingAnchors: [], sourceRanks: [1], verifiedSourceRanks: [1] }), [
    "no failure field set",
  ]);
});

test("the summary counts rejected claims by failure and failed checks by reason, with their rows", () => {
  const claim = (missingAnchors) => ({ anchors: [], missingAnchors, sourceRanks: [1], verifiedSourceRanks: [] });
  const failed = (reasons, claims) => ({ passed: false, phase: "primary", reasons, unsupportedClaims: claims });
  const rows = [
    {
      checks: [
        failed(["1 answer claim lacks citation support."], [claim(["term:a"])]),
        { ...failed(["2 answer claims lacks citation support."], [claim(["term:b", "term:c"]), claim(["polarity"])]), phase: "follow_up" },
      ],
      id: "q1",
    },
    { checks: [failed(["1 answer claim lacks citation support."], [claim(["term:d"])])], id: "q2" },
    { checks: [{ passed: true, phase: "primary", reasons: [], unsupportedClaims: [] }], id: "q3" },
    // A row without checks (the rag surface) counts nothing.
    { id: "q4" },
  ];

  assert.deepEqual(summarizeAgentChecks(rows), {
    checks: 4,
    claimFailures: [
      { claims: 3, failure: "missingAnchors: term", rows: 2 },
      { claims: 1, failure: "missingAnchors: polarity", rows: 1 },
    ],
    failedCheckReasons: [
      { checks: 2, reason: "1 answer claim lacks citation support.", rows: 2 },
      { checks: 1, reason: "2 answer claims lacks citation support.", rows: 1 },
    ],
    failedChecks: 3,
    judgeStatuses: { none: 4 },
    phases: { follow_up: 1, primary: 3 },
    unsupportedClaims: 4,
  });
});

test("each check records the claim judge's summary, and the summary counts checks by judge status", () => {
  const judge = (status, fields = {}) => ({
    cachedClaimCount: 0,
    judgedClaimCount: 2,
    missingVerdictCount: 0,
    modelId: "judge-model",
    numberGuardRejectedCount: 0,
    status,
    upgradedClaimCount: 0,
    ...fields,
  });
  const failed = judge("failed", { error: "no verdict could be parsed from the reply: Sure!" });
  const partial = judge("judged", { missingVerdictCount: 1, upgradedClaimCount: 1 });
  const selfCheck = (claimSupport) => ({
    detail: { claimSupport: { claims: [], ...claimSupport }, passed: false, reasons: [] },
    type: "self_check",
  });
  const checks = describeAgentChecks({
    agentTrace: [selfCheck({ judge: failed }), selfCheck({ judge: partial }), selfCheck({})],
  });

  assert.deepEqual(checks.map((check) => check.judge), [failed, partial, null]);
  assert.deepEqual(summarizeAgentChecks([{ checks, id: "q1" }]).judgeStatuses, { failed: 1, judged: 1, none: 1 });
});

// Planners ------------------------------------------------------------------

const withPlannerRollout = async (value, callback) => {
  const previous = process.env.AGENT_PLANNER_ROLLOUT;

  if (value === undefined) {
    delete process.env.AGENT_PLANNER_ROLLOUT;
  } else {
    process.env.AGENT_PLANNER_ROLLOUT = value;
  }

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_PLANNER_ROLLOUT;
    } else {
      process.env.AGENT_PLANNER_ROLLOUT = previous;
    }
  }
};

test("the agent surface gets the four planners /chat builds, as AGENT_PLANNER_ROLLOUT picks them", async () => {
  // As createAppServices builds them for buildChatResponse.
  const appPlanners = () => {
    const dagPlannerAdapter = createDagPlannerAdapter();

    return {
      dagPlannerAdapter,
      executionPlannerAdapter: createExecutionPlannerAdapter(),
      intentPlannerAdapter: createIntentPlannerAdapter(),
      replanAdapter: createReplanAdapter(dagPlannerAdapter),
    };
  };
  const ids = (planners) => [
    planners.intentPlannerAdapter.id,
    planners.executionPlannerAdapter.id,
    planners.dagPlannerAdapter.id,
  ];

  // Unset: the model plans, as /chat's default, with the replanner.
  await withPlannerRollout(undefined, async () => {
    const planners = await createAgentSurfacePlanners();

    assert.deepEqual(planners, appPlanners());
    assert.deepEqual(ids(planners), ["llm", "llm", DAG_PLANNER_IDS.llm]);
    assert.equal(planners.intentPlannerAdapter.rolloutMode, "llm");
    assert.equal(planners.replanAdapter, replanAdapter);
  });

  // deterministic: the rules, the earlier agent runs' planners, and no replanner.
  await withPlannerRollout("deterministic", async () => {
    const planners = await createAgentSurfacePlanners();

    assert.deepEqual(planners, appPlanners());
    assert.deepEqual(ids(planners), ["deterministic", "deterministic", DAG_PLANNER_IDS.deterministic]);
    assert.equal(planners.replanAdapter, null);
  });

  // A removed value refuses, as it does /chat's start.
  await withPlannerRollout("shadow", () =>
    assert.rejects(createAgentSurfacePlanners(), { code: "AGENT_PLANNER_ROLLOUT_REMOVED" })
  );
});

test("an agent question runs with the given planners and records whether each fell back, and why", async () => {
  const contract = {
    chunkIndex: 0,
    docId: "contract-1",
    excerpt: "The services agreement renews every 12 months unless either party gives 30 days notice.",
    fileName: "services-agreement.pdf",
    pageNumber: 3,
    rank: 1,
  };
  const ragService = {
    chat: async () => ({
      abstained: false,
      citations: [contract],
      memoryApplied: false,
      resolvedQuery: "contract terms",
      text: `${contract.excerpt} [Source 1]`,
    }),
    // The custom-Skill stage plans only over documents this lookup verifies.
    getDocument: (docId) => (docId === contract.docId ? { docId, fileName: contract.fileName } : null),
    listDocuments: () => [{ docId: contract.docId, fileName: contract.fileName }],
  };
  // Planners standing in for the model: each refuses, so each falls back to
  // the rules; the replanner is asked and proposes nothing.
  const refuse = (message) => async () => {
    throw new Error(message);
  };
  const planners = {
    dagPlannerAdapter: { createExecutionGraph: refuse("graph model unavailable"), id: DAG_PLANNER_IDS.llm },
    executionPlannerAdapter: { createExecutionPlan: refuse("plan model unavailable"), id: "llm" },
    intentPlannerAdapter: { id: "llm", selectIntentPlan: refuse("intent model unavailable") },
    replanAdapter: { createPatch: async () => ({ addNodes: [], removeNodeIds: [] }), id: "llm_replan" },
  };
  const ask = (question) =>
    askAgentSurface({
      accessScope: { authenticated: false, userId: "", workspaceId: "" },
      docId: contract.docId,
      planners,
      question,
      ragService,
      runAgentRag,
      sessionId: "qasper-agent-planners",
    });
  const fellBack = (fallbackReason) => ({ fallback: true, fallbackReason, status: "fallback" });

  // The rules review a contract with two custom Skills, so a graph is
  // planned: its planner and replans come from the run's skill_graph_planned
  // event, which the body does not carry.
  const review = await ask("Review this contract for risks and key terms.");

  assert.deepEqual(review.agent.planners, {
    dag: fellBack("graph model unavailable"),
    execution: fellBack("plan model unavailable"),
    intent: fellBack("intent model unavailable"),
    replans: [{ decision: "abstain", reasonCode: "replan_not_triggered" }],
  });
  assert.equal(review.abstained, false);

  // A question about the document plans no graph.
  const fact = await ask("How long does the services agreement renew for?");

  assert.deepEqual(fact.agent.planners, {
    dag: null,
    execution: fellBack("plan model unavailable"),
    intent: fellBack("intent model unavailable"),
    replans: null,
  });

  // A planner that did not run is null: no execution plan after a
  // clarification during preparation.
  assert.deepEqual(
    describeAgentSurfaceAnswer({
      agentMode: "clarification",
      agentObservability: {
        executionPlanner: { fallback: false, fallbackReason: null, status: "not_run" },
        intentPlanner: { fallback: false, fallbackReason: null, status: "selected" },
      },
    }).agent.planners,
    { dag: null, execution: null, intent: { fallback: false, fallbackReason: null, status: "selected" }, replans: null }
  );
});

test("the summary gives each planner's fallback rate and reasons, and the Markdown prints them", () => {
  const selected = { fallback: false, fallbackReason: null, status: "selected" };
  const fellBack = (fallbackReason, status = "fallback") => ({ fallback: true, fallbackReason, status });
  const rows = [
    {
      id: "q1",
      planners: {
        dag: fellBack("graph refused"),
        execution: fellBack("plan refused"),
        intent: selected,
        replans: [
          { decision: "applied", reasonCode: null },
          { decision: "abstain", reasonCode: "replan_limit_reached" },
        ],
      },
    },
    { id: "q2", planners: { dag: null, execution: selected, intent: fellBack("intent | refused"), replans: null } },
    // A graph rejected whole falls back with nothing in its place.
    { id: "q3", planners: { dag: fellBack("graph refused", "rejected"), execution: null, intent: fellBack("intent | refused"), replans: [] } },
    // A row without planners (a report from before the field) counts nothing.
    { id: "q4" },
  ];
  const summary = summarizeAgentPlanners(rows);

  assert.deepEqual(summary, {
    dag: { fallback: 2, fallbackRate: 1, fallbackReasons: [{ reason: "graph refused", rows: 2 }], ran: 2, selected: 0 },
    execution: { fallback: 1, fallbackRate: 0.5, fallbackReasons: [{ reason: "plan refused", rows: 1 }], ran: 2, selected: 1 },
    intent: { fallback: 2, fallbackRate: 0.6667, fallbackReasons: [{ reason: "intent | refused", rows: 2 }], ran: 3, selected: 1 },
    replans: { applied: 1, considered: 1, notApplied: [{ reason: "replan_limit_reached", rows: 1 }] },
  });

  const markdown = formatAgentPlanners(summary, "llm").join("\n");

  assert.match(markdown, /^Agent planners \(AGENT_PLANNER_ROLLOUT llm;/);
  assert.match(markdown, /Replans considered in 1 rows, applied in 1; not applied by reason: replan_limit_reached 1\./);
  assert.match(markdown, /\n\| intent \| 3 \| 1 \| 2 \| 0\.6667 \|\n\| execution \| 2 \| 1 \| 1 \| 0\.5 \|\n\| dag \| 2 \| 0 \| 2 \| 1 \|\n/);
  // A pipe in a reason does not split the table's cell.
  assert.match(markdown, /\n\| intent \| intent \\\| refused \| 2 \|\n/);
  assert.match(markdown, /\n\| dag \| graph refused \| 2 \|\n/);
  // A planner that never ran has no rate.
  assert.match(formatAgentPlanners(summarizeAgentPlanners([]), "deterministic").join("\n"), /\| dag \| 0 \| 0 \| 0 \| – \|/);
});
