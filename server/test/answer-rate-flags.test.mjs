import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  describeAnswerRateFlags,
  getClaimJudgeTemperature,
} from "../rag/config.js";
import { assessQaConfidence, computeQueryTermCoverage } from "../rag/confidence.js";
import { evaluateClaimSupport } from "../rag/self-check/evaluate.js";
import { splitAnswerStructure } from "../rag/self-check/claims.js";
import { buildFollowUpQuestion } from "../rag/self-check/gaps.js";
import { judgeClaimSupport, resetClaimJudgeCache } from "../rag/self-check/claim-judge.js";
import { finalizeGroundedAnswer } from "../rag/grounded-answer-finalizer.js";
import { buildConfidenceTrace } from "../rag/observability.js";
import { createChatClient } from "../rag/openai-client.js";
import { buildPlan } from "../rag/agent-intent-rules.js";
import { buildPreExecutionClarification } from "../rag/agent-planner.js";
import { GROUNDED_ABSTENTION_TEXT } from "../rag/agent-finalizer.js";
import { finalizeAgentRun } from "../rag/agent-finalization-flow.js";
import {
  classifyAgentAnswer,
  describeAgentFollowUp,
  summarizeAgentOutcomes,
} from "../evaluation/agent-answer-outcome.js";

// Each answer-rate flag is off by default and changes one thing. Every test
// sets the flags it depends on and clears the rest, so the suite means the
// same under any ambient value.
const FLAG_KEYS = [
  "RAG_CLAIM_SOURCE_INHERITANCE",
  "RAG_CLAIM_JUDGE_TEMPERATURE",
  "RAG_CLAIM_JUDGE",
  "RAG_MIN_QA_QUERY_TERM_COVERAGE",
  "RAG_MIN_RELEVANCE_SCORE",
  "RAG_QA_MIN_RERANK_PROBABILITY",
];
let savedEnvironment = {};

beforeEach(() => {
  savedEnvironment = Object.fromEntries(FLAG_KEYS.map((key) => [key, process.env[key]]));

  for (const key of FLAG_KEYS) {
    delete process.env[key];
  }

  process.env.RAG_MIN_QA_QUERY_TERM_COVERAGE = "0.51";
  process.env.RAG_MIN_RELEVANCE_SCORE = "0.32";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const withFlags = (flags, callback) => {
  for (const [key, value] of Object.entries(flags)) {
    process.env[key] = value;
  }

  return callback();
};

// ---------------------------------------------------------------------------
// QA gate: exact query words (RAG_QA_GATE_INFLECTION, which also counted
// inflected forms, was deleted on 2026-11-20)

const makeResult = ({ id, text, keywordScore, vectorScore = 0.465, queryText = null }) => {
  const result = {
    document: {
      id,
      pageContent: text,
      metadata: { fileName: "contract.pdf", sectionHeading: "Terms" },
    },
    score: 0.5,
    vectorScore,
  };
  const coverage =
    keywordScore ??
    computeQueryTermCoverage({
      queryText,
      resultText: ["contract.pdf", "Terms", text].join("\n"),
    });

  return { ...result, keywordScore: coverage };
};

const GOVERNING_LAW_QUESTION = "Which state's law governs the agreement?";
const GOVERNING_LAW_CHUNK = "This Agreement shall be governed by the laws of the State of Delaware.";

test("the QA gate counts exact query words: an inflected form is no match", () => {
  const results = [
    makeResult({ id: "law", queryText: GOVERNING_LAW_QUESTION, text: GOVERNING_LAW_CHUNK }),
  ];

  // "governs" and "law" appear only as "governed" and "laws": exact coverage 0.5.
  assert.equal(results[0].keywordScore, 0.5);

  const assessment = assessQaConfidence({ queryText: GOVERNING_LAW_QUESTION, results });

  assert.equal(assessment.confident, false);
  assert.equal("coverageBasis" in assessment, false);
  assert.equal("coverageBasis" in buildConfidenceTrace(assessment), false);
});

// ---------------------------------------------------------------------------
// QA gate: coverage measured against the question (agent follow-up)

test("coverageFromQueryText judges a follow-up candidate by the question, not by the repair query", () => {
  const queryText = "What does remote work require?";
  // Scored high against a repair query that repeats the model's own claim.
  const inflated = makeResult({
    id: "inflated",
    keywordScore: 0.9,
    text: "The satellite stipend is 500 dollars per month.",
  });
  // Found only by a repair query, so its stored score is against that query.
  const relevant = makeResult({
    id: "relevant",
    keywordScore: 0.2,
    text: "Remote work requires manager approval before the first remote day.",
  });

  const stored = assessQaConfidence({ queryText, results: [inflated, relevant] });

  assert.equal(stored.confident, true);
  assert.deepEqual(
    stored.usableResults.map((result) => result.document.id),
    ["inflated"]
  );

  const fromQuestion = assessQaConfidence({
    coverageFromQueryText: true,
    queryText,
    results: [inflated, relevant],
  });

  assert.equal(fromQuestion.confident, true);
  assert.deepEqual(
    fromQuestion.usableResults.map((result) => result.document.id),
    ["relevant"]
  );
  assert.deepEqual(fromQuestion.coverageBasis, { fromQueryText: true, inflection: false });

  // An adjacent topic is refused on the question's own words.
  const neighbour = assessQaConfidence({
    coverageFromQueryText: true,
    queryText: "What is the parental leave policy?",
    results: [
      makeResult({
        id: "annual",
        keywordScore: 1,
        text: "Annual leave policy: employees receive 10 paid annual leave days each year.",
      }),
    ],
  });

  assert.equal(neighbour.confident, false);
});

// ---------------------------------------------------------------------------
// Claim check: exact claim words (RAG_CLAIM_INFLECTION, which also accepted
// inflected forms, was deleted on 2026-11-20)

const cite = ({ docId = "doc-1", excerpt, fileName = "contract.pdf", rank }) => ({
  docId,
  excerpt,
  fileName,
  pageNumber: 1,
  ...(rank ? { rank } : {}),
});

const claimVerdicts = (answerText, citations, options = {}) =>
  evaluateClaimSupport({ answerText, citations, ...options }).claims.map((claim) => claim.supported);

const GOVERNING_LAW_CITATIONS = [cite({ excerpt: GOVERNING_LAW_CHUNK })];

test("the claim check reads exact claim words: an inflected form is no support", () => {
  const answers = [
    ["The laws of Delaware govern the agreement. [Source 1]", GOVERNING_LAW_CITATIONS],
    [
      "The model was trained on studies of patients. [Source 1]",
      [cite({ excerpt: "We train the model on a study of patient records." })],
    ],
  ];

  for (const [answerText, citations] of answers) {
    assert.deepEqual(claimVerdicts(answerText, citations), [false], answerText);
  }
});

// ---------------------------------------------------------------------------
// Claim check: RAG_CLAIM_SOURCE_INHERITANCE

const APPROVAL_CITATIONS = [
  cite({ excerpt: "Remote work requires manager approval before the first remote day." }),
];

test("an unlabelled sentence takes the labels of its line unless RAG_CLAIM_SOURCE_INHERITANCE=false", () => {
  const answerText =
    "Remote work requires manager approval. Remote work requires manager approval before the first remote day [Source 1].";

  // On by default since 2026-11-19 (withFlags does not restore, so the default goes first).
  assert.deepEqual(claimVerdicts(answerText, APPROVAL_CITATIONS), [true, true]);
  withFlags({ RAG_CLAIM_SOURCE_INHERITANCE: "false" }, () => {
    assert.deepEqual(claimVerdicts(answerText, APPROVAL_CITATIONS), [false, true]);
  });

  withFlags({ RAG_CLAIM_SOURCE_INHERITANCE: "true" }, () => {
    const claimSupport = evaluateClaimSupport({ answerText, citations: APPROVAL_CITATIONS });

    assert.deepEqual(claimSupport.claims.map((claim) => claim.supported), [true, true]);
    assert.equal(claimSupport.claims[0].sourceRanksInherited, true);
    assert.equal("sourceRanksInherited" in claimSupport.claims[1], false);

    // From the previous labelled sentence when nothing labelled follows.
    assert.deepEqual(
      claimVerdicts(
        "Remote work requires manager approval before the first remote day [Source 1]. Remote work requires manager approval.",
        APPROVAL_CITATIONS
      ),
      [true, true]
    );

    // The finalizer writes the inherited, verified label out.
    const finalized = finalizeGroundedAnswer({
      answerText: "Remote work requires manager approval. Alice prefers 20 remote days. [Source 1]",
      citations: APPROVAL_CITATIONS,
    });

    assert.equal(finalized.text, "Remote work requires manager approval. [Source 1]");
    assert.deepEqual(finalized.removedClaims, ["Alice prefers 20 remote days"]);
  });
});

test("with RAG_CLAIM_SOURCE_INHERITANCE an inherited label is checked like a written one", () => {
  withFlags({ RAG_CLAIM_SOURCE_INHERITANCE: "true" }, () => {
    // Wrong content under an inherited label is still refused.
    assert.deepEqual(
      claimVerdicts(
        "The satellite stipend is 500 dollars. Remote work requires manager approval [Source 1].",
        APPROVAL_CITATIONS
      ),
      [false, true]
    );

    // A bare "Yes." is dropped as before rather than becoming a supported claim.
    const yes = evaluateClaimSupport({
      answerText: "Yes. Remote work requires manager approval before the first remote day [Source 1].",
      citations: APPROVAL_CITATIONS,
    });

    assert.deepEqual(yes.claims.map((claim) => claim.text), [
      "Remote work requires manager approval before the first remote day",
    ]);

    // Labels never cross lines.
    assert.deepEqual(
      claimVerdicts(
        "Remote work requires manager approval.\nRemote work requires manager approval before the first remote day [Source 1].",
        APPROVAL_CITATIONS
      ),
      [false, true]
    );

    // A sentence inheriting the other handbook's label fails on its number.
    assert.deepEqual(
      claimVerdicts(
        "Employees may work remotely 2 days per week with manager approval. Gamma staff need manager approval [Source 2].",
        [
          cite({
            docId: "doc-alpha",
            excerpt: "Employees may work remotely 2 days per week with manager approval.",
            fileName: "handbook-alpha.pdf",
            rank: 1,
          }),
          cite({
            docId: "doc-gamma",
            excerpt: "Employees may work remotely 3 days per week with manager approval. Gamma staff need manager approval.",
            fileName: "handbook-gamma.pdf",
            rank: 2,
          }),
        ]
      ),
      [false, true]
    );

    // A comparison answer is split as before.
    assert.deepEqual(
      claimVerdicts(
        "Remote work requires manager approval. Remote work requires manager approval before the first remote day [Source 1].",
        APPROVAL_CITATIONS,
        { comparisonAnalysisSummary: { status: "analyzed" } }
      ),
      [false, true]
    );
  });
});

test("splitAnswerStructure inherits only when asked", () => {
  const text = "Remote work requires manager approval. Approval comes first [Source 1].";

  assert.deepEqual(
    splitAnswerStructure(text, APPROVAL_CITATIONS).claims.map((claim) => claim.sourceRanks),
    [[], [1]]
  );
  assert.deepEqual(
    splitAnswerStructure(text, APPROVAL_CITATIONS, { inheritSourceLabels: true }).claims.map(
      (claim) => claim.sourceRanks
    ),
    [[1], [1]]
  );
});

// ---------------------------------------------------------------------------
// Claim judge: RAG_CLAIM_JUDGE_TEMPERATURE

const judgeOnce = async () => {
  resetClaimJudgeCache();
  const calls = [];
  const citations = [cite({ excerpt: "Remote work needs a manager's sign-off before the first remote day." })];

  await judgeClaimSupport({
    citations,
    claimSupport: evaluateClaimSupport({
      answerText: "Remote work requires manager approval. [Source 1]",
      citations,
    }),
    complete: async (_prompt, options) => {
      calls.push(options);
      return { text: JSON.stringify({ verdicts: [{ claim: 0, reason: "ok", supported: true }] }) };
    },
  });

  return calls;
};

test("the claim judge sends a temperature only when RAG_CLAIM_JUDGE_TEMPERATURE is set", async () => {
  process.env.RAG_CLAIM_JUDGE = "llm";

  const unset = await judgeOnce();

  assert.equal(unset.length, 1);
  assert.equal("temperature" in unset[0], false);
  assert.equal(getClaimJudgeTemperature(), null);

  process.env.RAG_CLAIM_JUDGE_TEMPERATURE = "0";
  const zero = await judgeOnce();

  assert.equal(zero[0].temperature, 0);
  assert.equal(getClaimJudgeTemperature(), 0);

  for (const invalid of ["abc", "-1", "3"]) {
    process.env.RAG_CLAIM_JUDGE_TEMPERATURE = invalid;
    assert.equal(getClaimJudgeTemperature(), null, invalid);
  }

  resetClaimJudgeCache();
});

test("the chat client sends temperature only when given one", async (t) => {
  const originalFetch = globalThis.fetch;
  const bodies = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    };
  };

  const client = createChatClient({ apiKey: "test-key", model: "test-model" });

  await client.invoke("hello");
  await client.invoke("hello", { temperature: 0 });

  assert.equal("temperature" in bodies[0], false);
  assert.equal(bodies[1].temperature, 0);
});

// ---------------------------------------------------------------------------
// Follow-up question (self-check/gaps.js)

test("the follow-up asks the primary call's resolved question, else the question", () => {
  const question = "What does remote work require?";

  assert.equal(buildFollowUpQuestion({ question }), question);
  assert.equal(
    buildFollowUpQuestion({ question, resolvedQuestion: "What does remote work require for staff?" }),
    "What does remote work require for staff?"
  );
  assert.equal(buildFollowUpQuestion({ question, resolvedQuestion: "  " }), question);
});

test("describeAnswerRateFlags reports every flag, all off by default except source inheritance", () => {
  assert.deepEqual(describeAnswerRateFlags(), {
    claimJudgeTemperature: null,
    claimSourceInheritance: true,
  });

  withFlags(
    {
      RAG_CLAIM_JUDGE_TEMPERATURE: "0",
      RAG_CLAIM_SOURCE_INHERITANCE: "true",
    },
    () => {
      assert.deepEqual(describeAnswerRateFlags(), {
        claimJudgeTemperature: 0,
        claimSourceInheritance: true,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Evaluation accounting (evaluation/agent-answer-outcome.js)

test("an agent body answers only when it is neither a clarification nor the grounded abstention", () => {
  assert.deepEqual(classifyAgentAnswer({ agentMode: "clarification", agentAnswer: "Which document?" }), {
    abstainSource: "clarification",
    answered: false,
  });
  assert.deepEqual(classifyAgentAnswer({ agentMode: "document", agentAnswer: ` ${GROUNDED_ABSTENTION_TEXT} ` }), {
    abstainSource: "grounded_abstention",
    answered: false,
  });
  assert.deepEqual(
    classifyAgentAnswer({
      agentMode: "research_brief",
      agentAnswer: `Executive Summary\n${GROUNDED_ABSTENTION_TEXT}\n\nKey Findings\n${GROUNDED_ABSTENTION_TEXT}`,
      ragAbstained: true,
    }),
    { abstainSource: "grounded_abstention", answered: false }
  );
  assert.deepEqual(classifyAgentAnswer({ agentMode: "document", agentAnswer: "" }), {
    abstainSource: "empty_answer",
    answered: false,
  });
  assert.deepEqual(classifyAgentAnswer({ agentMode: "document", agentAnswer: "Delaware law governs. [Source 1]" }), {
    abstainSource: null,
    answered: true,
  });

  const body = {
    agentObservability: { executionLoop: { followUpsRun: 1, stoppedReason: "follow_up_resolved" } },
  };

  assert.deepEqual(describeAgentFollowUp(body), { followUpRan: true, stoppedReason: "follow_up_resolved" });
  assert.deepEqual(describeAgentFollowUp({}), { followUpRan: false, stoppedReason: null });
  assert.deepEqual(
    summarizeAgentOutcomes([
      { answered: true, abstainSource: null, followUpRan: true, stoppedReason: "follow_up_resolved" },
      { answered: false, abstainSource: "clarification", followUpRan: true, stoppedReason: "follow_up_unresolved" },
      { answered: false, abstainSource: "grounded_abstention", followUpRan: false, stoppedReason: null },
      { f1: 0.4 },
    ]),
    {
      abstainSources: { clarification: 1, grounded_abstention: 1 },
      answered: 1,
      cases: 3,
      followUpResolved: 1,
      followUpRuns: 2,
    }
  );
});

// The QA gate's gap-plan message, passed on by the agent as its document
// answer, is the document RAG's abstention, not an answer (KX round: read as
// answers, 1 on L1 and 3 on T1). Built by finalizeAgentRun, as /chat builds the
// body (a source-less abstention is not finalized), in English and Chinese;
// a retried step normalizes the answer's whitespace, the reason keeps it.
test("an agent body that passes on document RAG's own abstention has not answered", async () => {
  for (const message of [
    "I found material related to system designs introduced, but I still cannot confirm system designs introduced reliably.",
    "我找到了一些和“国内出差的每日餐”相关的内容，但还不能可靠确认国内出差的每日餐。",
  ]) {
    const response = await finalizeAgentRun({
      addTraceStep: () => {},
      buildAgentObservability: ({ agentMode }) => ({ agentMode, planMode: "document" }),
      customSkillResults: [],
      customSkills: [],
      discoveryAnswer: null,
      documentRagSkill: { id: "document_rag", version: "1.0.0", label: "Document RAG" },
      getAgentSkills: () => [{ skillId: "document_rag", status: "completed" }],
      getBudgetSnapshot: () => ({ used: { documentRagCalls: 1 } }),
      inventoryAnswer: null,
      plan: { mode: "document" },
      question: "What system designs are introduced?",
      ragResult: {
        ok: true,
        value: { abstained: true, abstainReason: message, citations: [], memoryApplied: false, text: message },
      },
      recordAgentTrace: async () => {},
      recordWorkingMemoryClaimSupport: () => {},
      researchBrief: null,
      skippedWebBecauseBudget: false,
      trace: [],
      webResult: null,
      workingMemory: {},
    });

    assert.equal(response.body.agentAnswer, message);
    assert.deepEqual(classifyAgentAnswer(response.body), { abstainSource: "rag_abstention", answered: false });
  }

  const padded = "I found material related to  the  notice period, but the answer is still not reliable enough.";

  assert.deepEqual(
    classifyAgentAnswer({ agentAnswer: padded.replace(/\s+/g, " "), agentMode: "document", ragAbstained: true, ragAbstainReason: padded }),
    { abstainSource: "rag_abstention", answered: false }
  );
});

// ---------------------------------------------------------------------------
// Deterministic routing (agent-intent-rules.js narrowSingleDocumentSignals)

test("incidental wording routes a single-document question to document QA", () => {
  for (const question of [
    "How did DPR compare with BM25?",
    "What is the similarity between relations?",
    "How does RAG-Sequence differ from RAG-Token?",
    "What dataset does this study use?",
    // A question about the one selected paper is not a research-brief request.
    "Do they report results only on English data?",
    "How is face and audio data analysis evaluated?",
    "这篇论文的研究方法是什么？",
  ]) {
    const plan = buildPlan({ docIds: ["paper-1"], question });

    assert.equal(plan.mode, "document", question);
    assert.equal(buildPreExecutionClarification({ docIds: ["paper-1"], plan }), null, question);
  }
});

test("real comparison, timeline and research requests keep their routes", () => {
  // One document selected, another one named: the comparison clarification.
  for (const question of [
    "Compare this contract against the other agreement.",
    "Compare these documents.",
    "What changed from the previous version of the policy?",
    "比较这两份合同",
  ]) {
    const plan = buildPlan({ docIds: ["contract-1"], question });

    assert.equal(plan.wantsCompareDocuments, true, question);
    assert.equal(
      buildPreExecutionClarification({ docIds: ["contract-1"], plan })?.reason,
      "comparison_requires_multiple_documents",
      question
    );
  }

  assert.equal(buildPlan({ docIds: ["a", "b"], question: "How do they compare?" }).wantsCompareDocuments, true);
  assert.equal(buildPlan({ docIds: ["a"], question: "Build a timeline of the sequence of events." }).mode, "extract_timeline");

  // An imperative or a "Can you ...?" request, or two selected documents, keep the research brief.
  for (const [docIds, question] of [
    [["a"], "Write a research brief on this paper."],
    [["a"], "Can you write a research brief on this paper?"],
    [["a", "b"], "Do they report results only on English data?"],
  ]) {
    assert.equal(buildPlan({ docIds, question }).mode, "research_brief", question);
  }
});

// ---------------------------------------------------------------------------
// Claim check: a section heading supplies no claim word (RAG_CLAIM_HEADING_CONTEXT,
// which let it, was deleted on 2026-11-20)

const CONTRACT_PAGE = [
  "Section 7. Limitation of Liability.",
  "The total liability of Vendor A shall not exceed the fees paid",
  "in the twelve (12) months preceding the claim.",
  "Section 8. Termination.",
  "Either party may terminate this agreement on thirty (30) days",
  "written notice to the other party.",
].join("\n\n");
const CONTRACT_CITATIONS = [cite({ excerpt: CONTRACT_PAGE, fileName: "vendor-a.pdf" })];
const NAMED_SECTION_ANSWER =
  "The limitation of liability is that the total liability of Vendor A shall not exceed the fees paid in the twelve (12) months preceding the claim. [Source 1]";

test("a claim naming the section it answers from is checked against the sentence, not its heading", () => {
  assert.deepEqual(claimVerdicts(NAMED_SECTION_ANSWER, CONTRACT_CITATIONS), [false]);
});
