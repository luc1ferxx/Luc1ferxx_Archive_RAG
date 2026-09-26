import assert from "node:assert/strict";
import test from "node:test";
import { convertQasperPaper, describeQasperAnswer } from "../evaluation/import-qasper.mjs";
import {
  normalizeQasperAnswer,
  qasperAnswerF1,
  qasperTokenF1,
  summarizeQasperRuns,
  toQasperPrediction,
} from "../evaluation/qasper-answer-metrics.js";
import { sampleQasperCases } from "../evaluation/run-qasper-answer-eval.mjs";

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

test("the summary separates answer quality, abstention and evidence recall", () => {
  const summary = summarizeQasperRuns([
    { abstained: false, answerType: "extractive", evidenceHit: true, f1: 1, shouldAbstain: false },
    { abstained: true, answerType: "extractive", evidenceHit: false, f1: 0, shouldAbstain: false },
    { abstained: true, answerType: "none", evidenceHit: null, f1: 1, shouldAbstain: true },
    { abstained: false, answerType: "none", evidenceHit: null, f1: 0, shouldAbstain: true },
  ]);

  assert.equal(summary.answerF1, 0.5);
  assert.equal(summary.answerableAbstainRate, 0.5);
  assert.equal(summary.abstainRecall, 0.5);
  assert.equal(summary.abstainPrecision, 0.5);
  assert.equal(summary.evidenceRecall, 0.5);
  assert.equal(summary.evidenceRecallWhenAnswered, 1);
  assert.equal(summary.f1WhenAnswered, 1);
  assert.deepEqual(summary.answerF1ByType.none, { cases: 2, f1: 0.5 });
});

test("case sampling is seeded and independent of input order", () => {
  const cases = Array.from({ length: 30 }, (_, index) => ({ id: `case-${index}` }));
  const first = sampleQasperCases(cases, 10, 7).map((testCase) => testCase.id);

  assert.deepEqual(sampleQasperCases([...cases].reverse(), 10, 7).map((testCase) => testCase.id), first);
  assert.notDeepEqual(sampleQasperCases(cases, 10, 8).map((testCase) => testCase.id), first);
});
