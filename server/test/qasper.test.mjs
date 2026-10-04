import assert from "node:assert/strict";
import test from "node:test";
import { convertQasperPaper, describeQasperAnswer } from "../evaluation/import-qasper.mjs";
import {
  citedSourcePages,
  normalizeQasperAnswer,
  qasperAnswerF1,
  qasperTokenF1,
  scoreQasperEvidence,
  summarizeQasperRuns,
  toQasperPrediction,
} from "../evaluation/qasper-answer-metrics.js";
import { describeRagSurfaceAnswer, sampleQasperCases } from "../evaluation/run-qasper-answer-eval.mjs";

const answer = (fields) => ({
  answer: {
    evidence: [],
    extractive_spans: [],
    free_form_answer: "",
    highlighted_evidence: [],
    unanswerable: false,
    yes_no: null,
    ...fields,
  },
});

const PAPER = {
  abstract: "We study retrieval for question answering.",
  full_text: [
    { paragraphs: ["We use BM25 as the first stage.", "A cross-encoder reranks the top 100."], section_name: "Method" },
    { paragraphs: ["Results are in Table 2."], section_name: "Experiments" },
  ],
  qas: [
    {
      answers: [
        answer({ evidence: ["A cross-encoder reranks the top 100."], extractive_spans: ["cross-encoder"] }),
        answer({ evidence: ["A cross-encoder reranks the top 100."], free_form_answer: "They rerank with a cross-encoder." }),
      ],
      question: "Which reranker do they use?",
      question_id: "q-reranker",
    },
    { answers: [answer({ unanswerable: true })], question: "What GPU do they use?", question_id: "q-gpu" },
    {
      answers: [answer({ evidence: ["FLOAT SELECTED: Table 2: results"], yes_no: true })],
      question: "Do they beat the baseline?",
      question_id: "q-table",
    },
  ],
  title: "Retrieval Paper",
};

test("paragraph granularity makes each annotated paragraph its own evidence page", () => {
  const { cases, document, skipped } = convertQasperPaper({ paper: PAPER, paperId: "2001.00001" });

  assert.deepEqual(document.pages, [
    "We study retrieval for question answering.",
    "Method\n\nWe use BM25 as the first stage.",
    "Method\n\nA cross-encoder reranks the top 100.",
    "Experiments\n\nResults are in Table 2.",
  ]);

  const reranker = cases.find((testCase) => testCase.id === "qasper_q_reranker");

  assert.deepEqual(reranker.expectedEvidence, [{ docKey: document.key, pages: [3], score: 3 }]);
  assert.equal(reranker.answerType, "extractive");
  assert.deepEqual(reranker.referenceAnswers, ["cross-encoder", "They rerank with a cross-encoder."]);

  const gpu = cases.find((testCase) => testCase.id === "qasper_q_gpu");

  assert.equal(gpu.shouldAbstain, true);
  assert.deepEqual(gpu.referenceAnswers, ["Unanswerable"]);
  // Table-only evidence cannot be located in the text, so retrieval cannot be graded.
  assert.equal(skipped, 1);
});

test("section granularity keeps a whole section on one page", () => {
  const { cases, document } = convertQasperPaper({ granularity: "section", paper: PAPER, paperId: "2001.00001" });

  assert.equal(document.pages.length, 3);
  assert.deepEqual(cases.find((testCase) => testCase.id === "qasper_q_reranker").expectedEvidence[0].pages, [2]);
});

test("answer text and type follow the official evaluator", () => {
  assert.deepEqual(describeQasperAnswer({ extractive_spans: ["BERT", "RoBERTa"], free_form_answer: "x" }), {
    text: "BERT, RoBERTa",
    type: "extractive",
  });
  assert.deepEqual(describeQasperAnswer({ free_form_answer: "They fine-tune." }), {
    text: "They fine-tune.",
    type: "abstractive",
  });
  assert.deepEqual(describeQasperAnswer({ yes_no: false }), { text: "No", type: "boolean" });
  assert.deepEqual(describeQasperAnswer({ unanswerable: true }), { text: "Unanswerable", type: "none" });
});

test("token F1 normalizes like SQuAD and takes the best annotator", () => {
  assert.equal(normalizeQasperAnswer("The Cross-Encoder, reranks!"), "crossencoder reranks");
  assert.equal(qasperTokenF1("a cross encoder", "cross encoder"), 1);
  assert.equal(qasperTokenF1("BERT", "RoBERTa"), 0);
  assert.equal(Number(qasperTokenF1("they use a cross encoder", "cross encoder").toFixed(4)), 0.6667);
  assert.equal(qasperAnswerF1("cross encoder", ["BM25", "a cross encoder"]), 1);
  assert.equal(qasperAnswerF1("anything", []), 0);
});

test("an abstention is scored as Unanswerable and source labels are not answer tokens", () => {
  assert.equal(toQasperPrediction({ abstained: true, text: "I could not find it." }), "Unanswerable");
  assert.equal(qasperAnswerF1(toQasperPrediction({ abstained: true }), ["Unanswerable"]), 1);
  assert.equal(toQasperPrediction({ abstained: false, text: "BM25 [Source 2]." }), "BM25  .");
  assert.equal(qasperAnswerF1(toQasperPrediction({ abstained: false, text: "BM25 [Source 2]" }), ["BM25"]), 1);
});

// QA citations as the answer writer returns them: every context chunk, ranked
// in context order, deduplicated (so a rank can be missing).
const CITATIONS = [
  { chunkIndex: 0, pageNumber: 3, rank: 1 },
  { chunkIndex: 1, pageNumber: 5, rank: 2 },
  { chunkIndex: 2, pageNumber: 3, rank: 3 },
  { chunkIndex: 3, pageNumber: 7, rank: 5 },
];

test("cited pages come from the answer's [Source N] labels, not from every citation", () => {
  assert.deepEqual(citedSourcePages({ abstained: false, citations: CITATIONS, text: "BM25 [Source 2]." }), [5]);
  // Two labels on one page count as one cited page; pages are sorted.
  assert.deepEqual(
    citedSourcePages({ abstained: false, citations: CITATIONS, text: "A [Source 3]. B [Source 2]. C [Source 1]." }),
    [3, 5]
  );
  // Grouped labels are split as the answer writer splits them.
  assert.deepEqual(citedSourcePages({ abstained: false, citations: CITATIONS, text: "A [Source 2, Source 5]." }), [5, 7]);
  // An answer with no label cites nothing, even though every chunk is a citation.
  assert.deepEqual(citedSourcePages({ abstained: false, citations: CITATIONS, text: "BM25." }), []);
});

test("a cited label out of range or naming a dropped rank is ignored", () => {
  assert.deepEqual(citedSourcePages({ abstained: false, citations: CITATIONS, text: "A [Source 9]. B [Source 2]." }), [5]);
  // Rank 4 was deduplicated away, and [Source 0] names no source.
  assert.deepEqual(citedSourcePages({ abstained: false, citations: CITATIONS, text: "A [Source 4] [Source 0]." }), []);
});

test("an abstention cites no page although the response keeps its context and citations", () => {
  assert.deepEqual(citedSourcePages({ abstained: true, citations: CITATIONS, text: "Not found [Source 1]." }), []);

  // A gate abstention on the rag surface: citations and retrievedContexts are
  // still populated, so the context figure can hit while the cited one cannot.
  const answer = describeRagSurfaceAnswer({
    abstained: true,
    citations: CITATIONS,
    retrievedContexts: CITATIONS.map(({ pageNumber, rank }) => ({ pageNumber, rank })),
    text: "The documents do not say [Source 1].",
  });

  assert.equal(answer.abstainSource, "gate");
  assert.deepEqual(answer.citedPages, []);
  assert.deepEqual(answer.contextPages, [3, 5, 3, 7]);
  assert.deepEqual(
    scoreQasperEvidence({ ...answer, expectedPages: [3], shouldAbstain: false }),
    { citationPrecision: null, citedEvidenceHit: false, contextEvidenceHit: true }
  );
});

test("the rag surface resolves labels against the response citations", () => {
  const answer = describeRagSurfaceAnswer({
    abstained: false,
    citations: CITATIONS,
    retrievedContexts: CITATIONS.map(({ pageNumber, rank }) => ({ pageNumber, rank })),
    text: "They use BM25 [Source 2] and a cross-encoder [Source 1].",
  });

  assert.equal(answer.abstainSource, null);
  assert.deepEqual(answer.citedPages, [3, 5]);
});

test("citation precision is the share of distinct cited pages holding evidence", () => {
  // Mixed: page 3 is evidence, page 5 is not.
  assert.deepEqual(
    scoreQasperEvidence({ abstained: false, citedPages: [3, 5], contextPages: [3, 5, 7], expectedPages: [3, 9], shouldAbstain: false }),
    { citationPrecision: 0.5, citedEvidenceHit: true, contextEvidenceHit: true }
  );
  // The context holds the evidence but the answer cites only other pages.
  assert.deepEqual(
    scoreQasperEvidence({ abstained: false, citedPages: [5, 7], contextPages: [3, 5, 7], expectedPages: [3], shouldAbstain: false }),
    { citationPrecision: 0, citedEvidenceHit: false, contextEvidenceHit: true }
  );
  assert.equal(
    scoreQasperEvidence({ abstained: false, citedPages: [3, 5, 7], expectedPages: [3, 7], shouldAbstain: false })
      .citationPrecision,
    0.6667
  );
  // Nothing cited: no precision; an unanswerable question has no evidence.
  assert.equal(scoreQasperEvidence({ abstained: false, citedPages: [], expectedPages: [3], shouldAbstain: false }).citationPrecision, null);
  assert.deepEqual(scoreQasperEvidence({ abstained: false, citedPages: [3], expectedPages: [], shouldAbstain: true }), {
    citationPrecision: null,
    citedEvidenceHit: null,
    contextEvidenceHit: null,
  });
});

test("the summary separates answer quality, abstention, cited and context evidence", () => {
  const summary = summarizeQasperRuns([
    // Answered, cites the evidence page and one other page.
    { abstained: false, answerType: "extractive", citationPrecision: 0.5, citedEvidenceHit: true, citedPages: [3, 5], contextEvidenceHit: true, f1: 1, shouldAbstain: false },
    // Gate abstention: evidence in the context, nothing cited.
    { abstained: true, answerType: "extractive", citationPrecision: null, citedEvidenceHit: false, citedPages: [], contextEvidenceHit: true, f1: 0, shouldAbstain: false },
    // Answered with evidence in the context but no label.
    { abstained: false, answerType: "abstractive", citationPrecision: null, citedEvidenceHit: false, citedPages: [], contextEvidenceHit: true, f1: 0.5, shouldAbstain: false },
    // Answered, cites only a non-evidence page.
    { abstained: false, answerType: "abstractive", citationPrecision: 0, citedEvidenceHit: false, citedPages: [7], contextEvidenceHit: false, f1: 0, shouldAbstain: false },
    { abstained: true, answerType: "none", citationPrecision: null, citedEvidenceHit: null, citedPages: [], contextEvidenceHit: null, f1: 1, shouldAbstain: true },
    // An unanswerable question answered without a citation.
    { abstained: false, answerType: "none", citationPrecision: null, citedEvidenceHit: null, citedPages: [], contextEvidenceHit: null, f1: 0, shouldAbstain: true },
  ]);

  assert.equal(summary.answerF1, 0.4167);
  assert.equal(summary.answerableAbstainRate, 0.25);
  assert.equal(summary.abstainRecall, 0.5);
  assert.equal(summary.abstainPrecision, 0.5);
  assert.equal(summary.f1WhenAnswered, 0.5);
  assert.equal(summary.citedEvidenceRecall, 0.25);
  assert.equal(summary.citedEvidenceRecallWhenAnswered, 0.3333);
  assert.equal(summary.contextEvidenceRecall, 0.75);
  assert.equal(summary.contextEvidenceRecallWhenAnswered, 0.6667);
  assert.equal(summary.citationPrecision, 0.25);
  assert.equal(summary.citationPrecisionCases, 2);
  assert.equal(summary.noCitationRateWhenAnswered, 0.5);
  // The ambiguous old names are gone.
  assert.equal(summary.evidenceRecall, undefined);
  assert.equal(summary.evidenceRecallWhenAnswered, undefined);
  assert.deepEqual(summary.answerF1ByType.none, { cases: 2, f1: 0.5 });
});

test("an earlier report's evidenceHit is re-summarized as the context figure only", () => {
  const summary = summarizeQasperRuns([
    { abstained: false, answerType: "extractive", evidenceHit: true, f1: 1, shouldAbstain: false },
    { abstained: true, answerType: "extractive", evidenceHit: false, f1: 0, shouldAbstain: false },
  ]);

  assert.equal(summary.contextEvidenceRecall, 0.5);
  assert.equal(summary.contextEvidenceRecallWhenAnswered, 1);
  assert.equal(summary.citedEvidenceRecall, null);
  assert.equal(summary.citationPrecision, null);
  assert.equal(summary.noCitationRateWhenAnswered, null);
});

test("case sampling is seeded and independent of input order", () => {
  const cases = Array.from({ length: 30 }, (_, index) => ({ id: `case-${index}` }));
  const first = sampleQasperCases(cases, 10, 7).map((testCase) => testCase.id);

  assert.deepEqual(sampleQasperCases([...cases].reverse(), 10, 7).map((testCase) => testCase.id), first);
  assert.notDeepEqual(sampleQasperCases(cases, 10, 8).map((testCase) => testCase.id), first);
});
