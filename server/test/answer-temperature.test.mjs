import test from "node:test";
import assert from "node:assert/strict";
import { stubModelReplies, useIsolatedAnswerWriterEnvironment } from "./answer-writer-test-helpers.mjs";
import {
  prepareComparisonSourceBundle,
  prepareQASourceBundle,
  writeComparisonAnswer,
  writeQaAnswer,
} from "../rag/answer-writer.js";
import { analyzeComparison } from "../rag/comparison-engine.js";
import { alignComparisonEvidence } from "../rag/evidence-aligner.js";
import { getAnswerTemperature } from "../rag/config.js";
import { describeAnswerRunDifferences } from "../evaluation/compare-qasper-answer-reports.mjs";

// RAG_ANSWER_TEMPERATURE reaches the three document answer calls (QA prose, QA
// extractive, comparison) and nothing else; unset, every call is what it was.

useIsolatedAnswerWriterEnvironment({
  keys: [
    "RAG_ANSWER_TEMPERATURE",
    "RAG_QA_EXTRACTIVE_OUTPUT",
    "RAG_QA_ANSWER_VERDICT",
    "RAG_COMPARISON_STRUCTURED_OUTPUT",
    "RAG_STRUCTURED_OUTPUT_ENABLED",
    "RAG_INJECTION_SCREEN",
  ],
  prefix: "answer-temperature-",
});

const QUERY = "How many days per week may employees work remotely?";
const POLICY_SENTENCE = "Employees may work remotely 2 days per week with manager approval.";

const qaBundle = () =>
  prepareQASourceBundle({
    results: [
      {
        document: {
          id: "handbook:0",
          pageContent: POLICY_SENTENCE,
          metadata: { chunkIndex: 0, docId: "handbook", fileName: "handbook.pdf", pageNumber: 1 },
        },
        score: 0.9,
      },
    ],
  });

const writeQa = async (replies) => {
  const calls = stubModelReplies(replies);
  const response = await writeQaAnswer({ bundle: qaBundle(), query: QUERY, resolvedQuery: QUERY });

  return { calls, response };
};

const comparison = () => {
  const documents = [
    { docId: "alpha", fileName: "handbook-alpha.pdf", pageContent: POLICY_SENTENCE },
    { docId: "gamma", fileName: "handbook-gamma.pdf", pageContent: "Employees may work remotely 3 days per week with manager approval." },
  ];
  const alignment = alignComparisonEvidence({
    documents: documents.map(({ docId, fileName }) => ({ docId, fileName })),
    perDocumentResults: new Map(
      documents.map(({ docId, fileName, pageContent }) => [
        docId,
        [{ document: { id: `${docId}:0`, metadata: { chunkIndex: 0, docId, fileName, pageNumber: 1 }, pageContent }, score: 0.99 }],
      ])
    ),
    query: "Compare the remote work policy.",
  });

  return { analysis: analyzeComparison({ alignment }), bundle: prepareComparisonSourceBundle({ alignment }) };
};

test("unset or empty, no temperature is sent; a number from 0 to 2 is; anything else refuses", () => {
  assert.equal(getAnswerTemperature(), null);

  for (const empty of ["", "   ", "\t"]) {
    process.env.RAG_ANSWER_TEMPERATURE = empty;
    assert.equal(getAnswerTemperature(), null, JSON.stringify(empty));
  }

  for (const [raw, value] of [["0", 0], [" 0 ", 0], ["0.7", 0.7], ["2", 2]]) {
    process.env.RAG_ANSWER_TEMPERATURE = raw;
    assert.equal(getAnswerTemperature(), value, raw);
  }

  for (const invalid of ["-0.1", "2.5", "abc", "NaN", "Infinity"]) {
    process.env.RAG_ANSWER_TEMPERATURE = invalid;
    assert.throws(() => getAnswerTemperature(), /RAG_ANSWER_TEMPERATURE must be a number from 0 to 2/, invalid);
  }
});

test("the QA answer call carries the temperature only when it is set", async () => {
  const unset = await writeQa([`${POLICY_SENTENCE} [Source 1]`]);

  assert.equal(unset.calls.length, 1);
  assert.equal("temperature" in unset.calls[0].options, false);

  process.env.RAG_ANSWER_TEMPERATURE = "0";
  const zero = await writeQa([`${POLICY_SENTENCE} [Source 1]`]);

  assert.equal(zero.calls[0].options.temperature, 0);
  // Same answer either way: the setting changes the request, not what is done with the reply.
  assert.equal(zero.response.text, unset.response.text);

  // A value the endpoint would refuse never reaches it.
  process.env.RAG_ANSWER_TEMPERATURE = "5";
  await assert.rejects(writeQa([`${POLICY_SENTENCE} [Source 1]`]), /RAG_ANSWER_TEMPERATURE must be a number from 0 to 2/);
});

test("the extractive QA call and its prose fallback carry it too", async () => {
  process.env.RAG_QA_EXTRACTIVE_OUTPUT = "true";
  process.env.RAG_ANSWER_TEMPERATURE = "0";

  // An unparsable reply hands the question to the prose call.
  const { calls } = await writeQa(["not json", `${POLICY_SENTENCE} [Source 1]`]);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.options.temperature), [0, 0]);

  delete process.env.RAG_ANSWER_TEMPERATURE;
  const unset = await writeQa(["not json", `${POLICY_SENTENCE} [Source 1]`]);

  assert.deepEqual(unset.calls.map((call) => "temperature" in call.options), [false, false]);
});

test("the comparison answer call carries it, with or without structured output", async () => {
  for (const structured of [false, true]) {
    if (structured) {
      process.env.RAG_COMPARISON_STRUCTURED_OUTPUT = "true";
    }

    const { analysis, bundle } = comparison();
    const unsetCalls = stubModelReplies(["Differences:\n- alpha says 2 days [Source 1]"]);

    delete process.env.RAG_ANSWER_TEMPERATURE;
    await writeComparisonAnswer({ analysis, bundle, query: "Compare the remote work policy.", resolvedQuery: "Compare the remote work policy." });
    assert.equal("temperature" in unsetCalls[0].options, false, `structured ${structured}`);

    const zeroCalls = stubModelReplies(["Differences:\n- alpha says 2 days [Source 1]"]);

    process.env.RAG_ANSWER_TEMPERATURE = "0";
    await writeComparisonAnswer({ analysis, bundle, query: "Compare the remote work policy.", resolvedQuery: "Compare the remote work policy." });
    assert.equal(zeroCalls[0].options.temperature, 0, `structured ${structured}`);
  }
});

test("two answer reports are compared on it, and a report from before the field ran without one", () => {
  const git = { dirty: false, sha: "abc" };
  const base = { answerTemperature: null, cases: 200, corpus: "qasper-dev.json", git, seed: 1, surface: "rag" };

  assert.deepEqual(describeAnswerRunDifferences({ ...base, answerTemperature: 0 }, base), [
    { current: 0, field: "answerTemperature", other: null },
  ]);

  const { answerTemperature: _unused, ...older } = base;

  assert.equal(
    describeAnswerRunDifferences(base, older).some((difference) => difference.field === "answerTemperature"),
    false
  );
});
