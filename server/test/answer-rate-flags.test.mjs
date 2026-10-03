import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  describeAnswerRateFlags,
  getClaimJudgeTemperature,
} from "../rag/config.js";
import {
  buildInflectionIndex,
  getInflectionBases,
  isInflectionMatch,
} from "../rag/inflection.js";
import { assessQaConfidence, computeQueryTermCoverage } from "../rag/confidence.js";
import { evaluateClaimSupport } from "../rag/self-check/evaluate.js";
import { splitAnswerStructure } from "../rag/self-check/claims.js";
import {
  buildHeadingScopedSupportSentences,
  readHeadingTitle,
} from "../rag/self-check/attribution.js";
import { buildEvidenceRetryQuestion, buildFollowUpQuestion } from "../rag/self-check/gaps.js";
import { judgeClaimSupport, resetClaimJudgeCache } from "../rag/self-check/claim-judge.js";
import { finalizeGroundedAnswer } from "../rag/grounded-answer-finalizer.js";
import { buildConfidenceTrace } from "../rag/observability.js";
import { createChatClient } from "../rag/openai-client.js";
import { buildPlan } from "../rag/agent-intent-rules.js";
import { buildPreExecutionClarification } from "../rag/agent-planner.js";
import { GROUNDED_ABSTENTION_TEXT } from "../rag/agent-finalizer.js";
import {
  classifyAgentAnswer,
  describeAgentFollowUp,
  summarizeAgentOutcomes,
} from "../evaluation/agent-answer-outcome.js";

// Each answer-rate flag is off by default and changes one thing. Every test
// sets the flags it depends on and clears the rest, so the suite means the
// same under any ambient value.
const FLAG_KEYS = [
  "AGENT_FOLLOW_UP_ORIGINAL_QUESTION",
  "AGENT_SINGLE_DOCUMENT_ROUTING",
  "RAG_QA_GATE_INFLECTION",
  "RAG_CLAIM_HEADING_CONTEXT",
  "RAG_CLAIM_INFLECTION",
  "RAG_CLAIM_SOURCE_INHERITANCE",
  "RAG_CLAIM_JUDGE_TEMPERATURE",
  "RAG_CLAIM_JUDGE",
  "RAG_QA_ANSWER_VERDICT",
  "RAG_QA_VERDICT_OVERRIDE",
  "RAG_QA_PARTIAL_COVERAGE_FLOOR",
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
// rag/inflection.js

test("inflection matching joins inflected forms of one word", () => {
  for (const [left, right] of [
    ["governs", "governed"],
    ["govern", "governed"],
    ["law", "laws"],
    ["metric", "metrics"],
    ["propose", "proposed"],
    ["proposes", "proposing"],
    ["study", "studies"],
    ["apply", "applied"],
    ["match", "matches"],
    ["stop", "stopped"],
    ["ceiling", "ceilings"],
    ["use", "used"],
    ["train", "trained"],
  ]) {
    assert.equal(isInflectionMatch(left, right), true, `${left} ~ ${right}`);
    assert.equal(isInflectionMatch(right, left), true, `${right} ~ ${left}`);
  }
});

test("inflection matching never strips derivations, prefixes, numbers or identifiers", () => {
  for (const [left, right] of [
    ["large", "larger"],
    ["paid", "unpaid"],
    ["approve", "approval"],
    ["terminate", "termination"],
    ["parental", "annual"],
    ["amber", "cobalt"],
    ["us", "used"],
    ["fee", "feed"],
    ["see", "seed"],
    ["12", "twelve"],
    ["30", "30s"],
    ["re-ranker", "re-rankers"],
    ["status", "stat"],
    ["analysis", "analysi"],
  ]) {
    assert.equal(isInflectionMatch(left, right), false, `${left} !~ ${right}`);
  }

  assert.deepEqual([...getInflectionBases("bert")], ["bert"]);
  assert.deepEqual([...getInflectionBases("2024s")], ["2024s"]);
  assert.equal(buildInflectionIndex(["governed", "laws"]).has("governs"), true);
  assert.equal(buildInflectionIndex(["governed", "laws"]).has("state"), false);
});

// ---------------------------------------------------------------------------
// QA gate: RAG_QA_GATE_INFLECTION

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

test("the QA gate counts inflected query words only with RAG_QA_GATE_INFLECTION", () => {
  const results = [
    makeResult({ id: "law", queryText: GOVERNING_LAW_QUESTION, text: GOVERNING_LAW_CHUNK }),
  ];

  // "governs" and "law" appear only as "governed" and "laws": exact coverage 0.5.
  assert.equal(results[0].keywordScore, 0.5);

  const off = assessQaConfidence({ queryText: GOVERNING_LAW_QUESTION, results });

  assert.equal(off.confident, false);
  assert.equal("coverageBasis" in off, false);
  assert.equal("coverageBasis" in buildConfidenceTrace(off), false);

  withFlags({ RAG_QA_GATE_INFLECTION: "true" }, () => {
    const on = assessQaConfidence({ queryText: GOVERNING_LAW_QUESTION, results });

    assert.equal(on.confident, true);
    assert.deepEqual(on.coverageBasis, { fromQueryText: false, inflection: true });
    assert.deepEqual(buildConfidenceTrace(on).coverageBasis, { fromQueryText: false, inflection: true });
  });
});

test("with RAG_QA_GATE_INFLECTION adjacent topics, rivals and anchors are still refused", () => {
  withFlags({ RAG_QA_GATE_INFLECTION: "true" }, () => {
    for (const [queryText, text] of [
      ["What is the parental leave policy?", "Annual leave policy: employees receive 10 paid annual leave days each year."],
      ["What is the amber ceiling?", "Archive serial cobalt ceilings: approved amount is 3600 dollars per cycle."],
      ["How much notice ends the lease?", "Either party may terminate the employment agreement upon written notice."],
    ]) {
      const assessment = assessQaConfidence({
        queryText,
        results: [makeResult({ id: "neighbour", queryText, text })],
      });

      assert.equal(assessment.confident, false, queryText);
    }

    // An identifier must still appear exactly: "re-ranker" is not "re-rankers".
    const anchored = assessQaConfidence({
      queryText: "How are the re-rankers trained?",
      results: [
        makeResult({
          id: "anchor",
          keywordScore: 1,
          text: "The re-ranker is trained with hard negatives.",
        }),
      ],
    });

    assert.equal(anchored.confident, false);
    assert.deepEqual(
      anchored.missingAnchorGroups.map((group) => group.label),
      ["re-rankers"]
    );
  });
});

test("RAG_QA_GATE_INFLECTION changes only chunks with an inflected query word and never lowers a score", () => {
  withFlags({ RAG_QA_GATE_INFLECTION: "true" }, () => {
    // The stored score came from another retrieval query and is lower than the
    // chunk's coverage of the question; the flag does not re-measure it.
    const thin = assessQaConfidence({
      queryText: "What are the liability caps?",
      results: [makeResult({ id: "thin", keywordScore: 0.25, text: "Liability is described in the schedule." })],
    });

    assert.equal(thin.confident, false);

    // A stored score above the chunk's own coverage of the question is never
    // lowered.
    const high = assessQaConfidence({
      queryText: "What are the liability caps?",
      results: [makeResult({ id: "high", keywordScore: 0.75, text: "Liability is described in the schedule." })],
    });

    assert.equal(high.confident, true);
  });
});

test("with RAG_QA_GATE_INFLECTION a topic-only chunk of a multi-part question stays below the floor", () => {
  const queryText = "When does the refund policy take effect and which regions does it apply to?";

  withFlags({ RAG_QA_GATE_INFLECTION: "true" }, () => {
    const assessment = assessQaConfidence({
      evidenceRequirementCount: 2,
      queryText,
      results: [
        makeResult({ id: "topic-only", queryText, text: "Refunds are issued back to the original payment method." }),
      ],
    });

    assert.equal(assessment.confident, false);
  });
});

test("with the answer verdict on, RAG_QA_GATE_INFLECTION keeps the substitution veto in the partial band", () => {
  withFlags(
    {
      RAG_QA_ANSWER_VERDICT: "true",
      RAG_QA_GATE_INFLECTION: "true",
      RAG_QA_PARTIAL_COVERAGE_FLOOR: "0.3",
    },
    () => {
      for (const [queryText, text] of [
        ["What is the amber ceiling?", "Archive serial cobalt ceilings: approved amount is 3600 dollars per cycle."],
        ["What is the parental leave policy?", "Annual leave policy: employees receive 10 paid annual leave days each year."],
      ]) {
        const assessment = assessQaConfidence({
          queryText,
          results: [makeResult({ id: "neighbour", queryText, text })],
        });

        assert.equal(assessment.confident, false, queryText);
      }
    }
  );
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
// Claim check: RAG_CLAIM_INFLECTION

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

test("the claim check accepts inflected claim words only with RAG_CLAIM_INFLECTION", () => {
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

  withFlags({ RAG_CLAIM_INFLECTION: "true" }, () => {
    for (const [answerText, citations] of answers) {
      assert.deepEqual(claimVerdicts(answerText, citations), [true], answerText);
    }
  });
});

test("with RAG_CLAIM_INFLECTION wrong facts are still refused", () => {
  const notice = [cite({ excerpt: "Either party may terminate this Agreement upon thirty (30) days written notice." })];
  const approval = [cite({ excerpt: "Remote work requires manager approval before the first remote day." })];
  const payment = [cite({ excerpt: "The Vendor pays the Client a monthly fee." })];
  const leave = [cite({ excerpt: "Annual leave: employees receive 10 paid annual leave days each year." })];
  const twoHandbooks = [
    cite({
      docId: "doc-alpha",
      excerpt: "Employees may work remotely 2 days per week with manager approval.",
      fileName: "handbook-alpha.pdf",
      rank: 1,
    }),
    cite({
      docId: "doc-gamma",
      excerpt: "Employees may work remotely 3 days per week with manager approval.",
      fileName: "handbook-gamma.pdf",
      rank: 2,
    }),
  ];

  withFlags({ RAG_CLAIM_INFLECTION: "true" }, () => {
    for (const [label, answerText, citations] of [
      ["wrong number", "Either party may terminate the agreement with sixty days notices. [Source 1]", notice],
      ["swapped party", "The Client pays the Vendor a monthly fee. [Source 1]", payment],
      ["negation", "Remote work does not require manager approval. [Source 1]", approval],
      ["added condition", "Remote work requires manager approval and HR approvals. [Source 1]", approval],
      ["adjacent topic", "Parental leaves are 10 paid days each year. [Source 1]", leave],
      ["wrong source", "Employees may work remotely 2 days per week with manager approvals. [Source 2]", twoHandbooks],
      ["mis-attribution", "According to handbook-gamma.pdf, employees may work remotely 2 days per week with manager approvals. [Source 1]", twoHandbooks],
    ]) {
      assert.deepEqual(claimVerdicts(answerText, citations), [false], label);
    }
  });
});

test("RAG_CLAIM_INFLECTION does not touch comparison answers", () => {
  withFlags({ RAG_CLAIM_INFLECTION: "true" }, () => {
    assert.deepEqual(
      claimVerdicts("The laws of Delaware govern the agreement. [Source 1]", GOVERNING_LAW_CITATIONS, {
        comparisonAnalysisSummary: { status: "analyzed" },
      }),
      [false]
    );
  });
});

// ---------------------------------------------------------------------------
// Claim check: RAG_CLAIM_SOURCE_INHERITANCE

const APPROVAL_CITATIONS = [
  cite({ excerpt: "Remote work requires manager approval before the first remote day." }),
];

test("an unlabelled sentence takes the labels of its line only with RAG_CLAIM_SOURCE_INHERITANCE", () => {
  const answerText =
    "Remote work requires manager approval. Remote work requires manager approval before the first remote day [Source 1].";

  assert.deepEqual(claimVerdicts(answerText, APPROVAL_CITATIONS), [false, true]);

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
// Follow-up question: AGENT_FOLLOW_UP_ORIGINAL_QUESTION

test("the follow-up question is the meta text by default and the question with the flag", () => {
  const check = {
    claimSupport: {
      claims: [{ supported: false, text: "The satellite stipend is 500 dollars" }],
      unsupportedClaimCount: 1,
    },
    reasons: ["1 answer claim lacks citation support."],
  };
  const question = "What does remote work require?";

  assert.equal(
    buildFollowUpQuestion({ check, question, resolvedQuestion: "ignored" }),
    buildEvidenceRetryQuestion({ check, question })
  );

  withFlags({ AGENT_FOLLOW_UP_ORIGINAL_QUESTION: "true" }, () => {
    assert.equal(buildFollowUpQuestion({ check, question }), question);
    assert.equal(
      buildFollowUpQuestion({ check, question, resolvedQuestion: "What does remote work require for staff?" }),
      "What does remote work require for staff?"
    );
    assert.equal(buildFollowUpQuestion({ check, question, resolvedQuestion: "  " }), question);
  });
});

test("describeAnswerRateFlags reports every flag, all off by default", () => {
  assert.deepEqual(describeAnswerRateFlags(), {
    agentFollowUpOriginalQuestion: false,
    agentSingleDocumentRouting: false,
    claimHeadingContext: false,
    claimInflection: false,
    claimJudgeTemperature: null,
    claimSourceInheritance: false,
    qaGateInflection: false,
    qaVerdictOverride: "off",
  });

  withFlags(
    {
      AGENT_FOLLOW_UP_ORIGINAL_QUESTION: "true",
      AGENT_SINGLE_DOCUMENT_ROUTING: "true",
      RAG_CLAIM_HEADING_CONTEXT: "true",
      RAG_CLAIM_INFLECTION: "true",
      RAG_CLAIM_JUDGE_TEMPERATURE: "0",
      RAG_CLAIM_SOURCE_INHERITANCE: "true",
      RAG_QA_GATE_INFLECTION: "true",
      RAG_QA_VERDICT_OVERRIDE: "supported",
    },
    () => {
      assert.deepEqual(describeAnswerRateFlags(), {
        agentFollowUpOriginalQuestion: true,
        agentSingleDocumentRouting: true,
        claimHeadingContext: true,
        claimInflection: true,
        claimJudgeTemperature: 0,
        claimSourceInheritance: true,
        qaGateInflection: true,
        qaVerdictOverride: "supported",
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

// ---------------------------------------------------------------------------
// Deterministic routing: AGENT_SINGLE_DOCUMENT_ROUTING

test("incidental wording routes a single-document question to document QA only with AGENT_SINGLE_DOCUMENT_ROUTING", () => {
  const cases = [
    ["How did DPR compare with BM25?", "compare_documents"],
    ["What is the similarity between relations?", "compare_documents"],
    ["How does RAG-Sequence differ from RAG-Token?", "extract_timeline"],
    ["What dataset does this study use?", "research_brief"],
  ];

  for (const [question, mode] of cases) {
    assert.equal(buildPlan({ docIds: ["paper-1"], question }).mode, mode, question);
  }

  withFlags({ AGENT_SINGLE_DOCUMENT_ROUTING: "true" }, () => {
    for (const [question] of cases) {
      const plan = buildPlan({ docIds: ["paper-1"], question });

      assert.equal(plan.mode, "document", question);
      assert.equal(buildPreExecutionClarification({ docIds: ["paper-1"], plan }), null, question);
    }
  });
});

test("with AGENT_SINGLE_DOCUMENT_ROUTING real comparison and timeline requests keep their routes", () => {
  withFlags({ AGENT_SINGLE_DOCUMENT_ROUTING: "true" }, () => {
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
    assert.equal(buildPlan({ docIds: ["a"], question: "Write a research brief on this paper." }).mode, "research_brief");
  });
});

// ---------------------------------------------------------------------------
// Claim check: RAG_CLAIM_HEADING_CONTEXT

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

test("a claim naming the section it answers from is supported only with RAG_CLAIM_HEADING_CONTEXT", () => {
  assert.deepEqual(claimVerdicts(NAMED_SECTION_ANSWER, CONTRACT_CITATIONS), [false]);

  withFlags({ RAG_CLAIM_HEADING_CONTEXT: "true" }, () => {
    assert.deepEqual(claimVerdicts(NAMED_SECTION_ANSWER, CONTRACT_CITATIONS), [true]);
  });
});

test("with RAG_CLAIM_HEADING_CONTEXT heading numbers, other sections and wrong facts are still refused", () => {
  withFlags({ RAG_CLAIM_HEADING_CONTEXT: "true" }, () => {
    for (const [label, answerText] of [
      ["wrong number", NAMED_SECTION_ANSWER.replace("twelve (12)", "six (6)")],
      ["section number as a value", NAMED_SECTION_ANSWER.replace("twelve (12)", "7")],
      ["fact from another section", "The limitation of liability is thirty days notice. [Source 1]"],
      ["swapped party", "The limitation of liability is that the total liability of the Client shall not exceed the fees paid in the twelve (12) months preceding the claim. [Source 1]"],
      ["negation", "The limitation of liability is that the total liability of Vendor A is not limited. [Source 1]"],
    ]) {
      assert.deepEqual(claimVerdicts(answerText, CONTRACT_CITATIONS), [false], label);
    }

    // A neighbouring section's title does not cover a sentence of this one.
    const leave = [
      cite({
        excerpt: [
          "Section 3. Parental Leave.",
          "Parental leave is described in the family policy.",
          "Section 4. Annual Leave.",
          "Employees receive 10 paid leave days each year.",
        ].join("\n"),
      }),
    ];

    assert.deepEqual(claimVerdicts("Employees receive 10 paid parental leave days each year. [Source 1]", leave), [false]);
    assert.deepEqual(claimVerdicts("Employees receive 10 paid annual leave days each year. [Source 1]", leave), [true]);

    // A comparison answer is checked as before.
    assert.deepEqual(
      claimVerdicts(NAMED_SECTION_ANSWER, CONTRACT_CITATIONS, {
        comparisonAnalysisSummary: { status: "analyzed" },
      }),
      [false]
    );
  });
});

test("only Title Case section lines without negation count as headings", () => {
  assert.equal(readHeadingTitle("Limitation of Liability."), "Limitation of Liability");
  assert.equal(readHeadingTitle("No Refunds"), null);
  assert.equal(readHeadingTitle("Employees may work remotely"), null);
  // Digits are dropped first; what is left must still read as a title.
  assert.equal(readHeadingTitle("30-Day Notice"), null);
  assert.equal(readHeadingTitle("Section Twelve Governing Law"), "Section Twelve Governing Law");

  assert.deepEqual(
    buildHeadingScopedSupportSentences([
      cite({
        excerpt: [
          "1. Employees may work remotely 2 days per week.",
          "Section 2. No Refunds.",
          "Fees are paid in advance.",
          "Article IV. Governing Law.",
          "This agreement is governed by the laws of Delaware.",
        ].join("\n"),
      }),
    ]),
    ["Governing Law: This agreement is governed by the laws of Delaware."]
  );
  assert.deepEqual(
    buildHeadingScopedSupportSentences([
      { excerpt: "We evaluate on SQuAD.", sectionHeading: "Datasets and Metrics" },
    ]),
    ["Datasets and Metrics: We evaluate on SQuAD."]
  );
});

// ---------------------------------------------------------------------------
// Review regressions: each case below was a wrong answer that a flag accepted.

test("inflection never joins number words or words whose apparent base is another word", () => {
  for (const [left, right] of [
    ["second", "seconds"],
    ["third", "thirds"],
    ["ten", "tens"],
    ["hundred", "hundreds"],
    ["quarter", "quarters"],
    ["new", "news"],
    ["unit", "united"],
    ["units", "united"],
    ["mean", "means"],
    ["mean", "meaning"],
    ["even", "evening"],
    ["good", "goods"],
    ["premise", "premises"],
  ]) {
    assert.equal(isInflectionMatch(left, right), false, `${left} !~ ${right}`);
    assert.equal(isInflectionMatch(right, left), false, `${right} !~ ${left}`);
  }
});

test("with RAG_CLAIM_INFLECTION a number word in another sense is still refused", () => {
  withFlags({ RAG_CLAIM_INFLECTION: "true" }, () => {
    for (const [label, answerText, excerpt] of [
      ["two thirds is not a third", "A third of the board must approve the merger. [Source 1]", "Two thirds of the board must approve the merger."],
      ["seconds is not the second payment", "The second payment is processed on signing. [Source 1]", "Each payment is processed within seconds of signing."],
      ["the United Kingdom is not units", "The fund invests in units. [Source 1]", "The fund invests in the United Kingdom."],
    ]) {
      assert.deepEqual(claimVerdicts(answerText, [cite({ excerpt })]), [false], label);
    }
  });
});

test("with RAG_CLAIM_HEADING_CONTEXT a heading never supplies a party, a list item or another section", () => {
  withFlags({ RAG_CLAIM_HEADING_CONTEXT: "true" }, () => {
    for (const [label, answerText, citation] of [
      [
        "list item read as a heading",
        "Interns receive 12 weeks of parental leave. [Source 1]",
        cite({
          excerpt: [
            "The following roles are excluded:",
            "1. Contract Workers",
            "2. Interns",
            "All other employees receive 12 weeks of parental leave.",
          ].join("\n"),
        }),
      ],
      [
        "heading names the other party",
        "The Customer may terminate on 30 days notice. [Source 1]",
        cite({ excerpt: "Section 9. Termination by Customer\nThe Supplier may terminate on 30 days notice." }),
      ],
      [
        "heading names the other party, claim repeats the heading",
        "Termination by customer: the Customer may terminate on 30 days notice. [Source 1]",
        cite({ excerpt: "Section 9. Termination by Customer\nThe Supplier may terminate on 30 days notice." }),
      ],
      [
        "a Section line with a rejected title ends the previous section",
        "The annual leave is that employees receive 12 weeks of leave. [Source 1]",
        cite({
          excerpt: [
            "Section 3. Annual Leave",
            "Employees receive 20 paid days each year.",
            "Section 4. Leave for parents of newborn children",
            "Employees receive 12 weeks of leave.",
          ].join("\n"),
        }),
      ],
      [
        "an unnumbered heading ends the chunk's section",
        "The annual leave is that employees receive 12 weeks of leave. [Source 1]",
        {
          ...cite({
            excerpt: "Annual Leave\n\nEmployees receive 20 paid days.\n\nParental Leave\n\nEmployees receive 12 weeks of leave.",
          }),
          sectionHeading: "Annual Leave",
        },
      ],
    ]) {
      assert.deepEqual(claimVerdicts(answerText, [citation]), [false], label);
    }

    // The section the claim names still supports what that section says.
    assert.deepEqual(
      claimVerdicts("The annual leave is that employees receive 20 paid days. [Source 1]", [
        {
          ...cite({
            excerpt: "Annual Leave\n\nEmployees receive 20 paid days.\n\nParental Leave\n\nEmployees receive 12 weeks of leave.",
          }),
          sectionHeading: "Annual Leave",
        },
      ]),
      [true]
    );
  });
});
