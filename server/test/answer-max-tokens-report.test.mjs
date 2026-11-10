import test from "node:test";
import assert from "node:assert/strict";
import { isAgentAnswerTruncated } from "../evaluation/agent-answer-outcome.js";
import { describeAnswerRunDifferences } from "../evaluation/compare-qasper-answer-reports.mjs";
import {
  describeAnswerOutputLimit,
  describeRagSurfaceAnswer,
  summarizeAnswerTruncations,
} from "../evaluation/run-qasper-answer-eval.mjs";

// What eval:qasper-answers records about RAG_ANSWER_MAX_TOKENS: the limit and
// its field in the config, and per question whether the answer model's reply
// was cut off, on either surface.

test("a row says whether the reply was cut off, on the rag surface and the agent's", () => {
  assert.equal(describeRagSurfaceAnswer({ answerTruncated: true, citations: [], text: "Employees may" }).answerTruncated, true);
  assert.equal(describeRagSurfaceAnswer({ citations: [], text: "Employees may work remotely." }).answerTruncated, false);

  const step = (type, output) => ({ agentTrace: [{ output, type }] });

  assert.equal(isAgentAnswerTruncated(step("document_rag", { answerTruncated: true })), true);
  assert.equal(isAgentAnswerTruncated(step("follow_up_retrieval", { answerTruncated: true })), true);
  assert.equal(isAgentAnswerTruncated(step("document_rag", { abstained: false })), false);
  // Only a document RAG step's output counts.
  assert.equal(isAgentAnswerTruncated(step("web_search", { answerTruncated: true })), false);
  assert.equal(isAgentAnswerTruncated({}), false);
});

test("the summary counts cut-off replies by whether the question was answerable", () => {
  assert.deepEqual(
    summarizeAnswerTruncations([
      { answerTruncated: true, shouldAbstain: false },
      { answerTruncated: true, shouldAbstain: true },
      { answerTruncated: false, shouldAbstain: false },
      // A row from before the field: not cut.
      { shouldAbstain: false },
    ]),
    { answerable: 1, unanswerable: 1 }
  );
});

test("the config records the limit and its field, both null when no limit was sent", () => {
  const getters = (maxTokens, field = "max_tokens") => ({
    getAnswerMaxTokens: () => maxTokens,
    getLlmMaxTokensField: () => field,
  });

  assert.deepEqual(describeAnswerOutputLimit(getters(null)), { answerMaxTokens: null, answerMaxTokensField: null });
  assert.deepEqual(describeAnswerOutputLimit(getters(1024)), { answerMaxTokens: 1024, answerMaxTokensField: "max_tokens" });
  assert.deepEqual(describeAnswerOutputLimit(getters(1024, "max_completion_tokens")), {
    answerMaxTokens: 1024,
    answerMaxTokensField: "max_completion_tokens",
  });

  // Through a model gateway the gateway's own setting picks the field; this
  // process's is never read, even when it would be refused.
  const unreadField = {
    getAnswerMaxTokens: () => 1024,
    getLlmMaxTokensField: () => assert.fail("the local field was read"),
  };

  assert.deepEqual(describeAnswerOutputLimit(unreadField, { routedToGateway: true }), {
    answerMaxTokens: 1024,
    answerMaxTokensField: "model_gateway",
  });
  assert.deepEqual(describeAnswerOutputLimit(getters(null), { routedToGateway: true }), {
    answerMaxTokens: null,
    answerMaxTokensField: null,
  });
});

test("two answer reports are compared on the limit, and a report from before the fields ran without one", () => {
  const git = { dirty: false, sha: "abc" };
  const base = {
    answerMaxTokens: null,
    answerMaxTokensField: null,
    cases: 200,
    corpus: "qasper-dev.json",
    git,
    seed: 1,
    surface: "rag",
  };

  assert.deepEqual(
    describeAnswerRunDifferences({ ...base, answerMaxTokens: 1024, answerMaxTokensField: "max_tokens" }, base),
    [
      { current: 1024, field: "answerMaxTokens", other: null },
      { current: "max_tokens", field: "answerMaxTokensField", other: null },
    ]
  );

  const { answerMaxTokens: _limit, answerMaxTokensField: _field, ...older } = base;

  assert.deepEqual(
    describeAnswerRunDifferences(base, older).filter(({ field }) => field.startsWith("answerMaxTokens")),
    []
  );
});
