import assert from "node:assert/strict";
import test from "node:test";
import { writeQaAnswer } from "../rag/answer-writer.js";
import { evaluateClaimSupport } from "../rag/agent-self-check.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { normalizeGroupedSourceLabels } from "../rag/self-check/text.js";

test("grouped source labels expand to one bracket per rank in every common form", () => {
  const cases = [
    ["[Source 1, Source 3]", "[Source 1] [Source 3]"],
    ["[Source 1 Source 3]", "[Source 1] [Source 3]"],
    ["[Sources 1, 3]", "[Source 1] [Source 3]"],
    ["[Source 1 and 3]", "[Source 1] [Source 3]"],
    ["[Source 1; Source 2 ]", "[Source 1] [Source 2]"],
    ["[来源 1、来源 3]", "[Source 1] [Source 3]"],
    ["[Source 2, Source 10, Source 11]", "[Source 2] [Source 10] [Source 11]"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeGroupedSourceLabels(input), expected, input);
  }
});

test("grouped source label normalization never splits or merges single labels", () => {
  assert.equal(normalizeGroupedSourceLabels("[Source 12]"), "[Source 12]");
  assert.equal(
    normalizeGroupedSourceLabels("see [Source 3] and [Source 4]"),
    "see [Source 3] and [Source 4]"
  );
});

test("a comma-grouped label after the sentence still binds to that claim", () => {
  const citations = [
    { rank: 1, docId: "doc-a", fileName: "policy-a.pdf", excerpt: "Remote work requires manager approval." },
    { rank: 2, docId: "doc-b", fileName: "policy-b.pdf", excerpt: "Remote work requires manager approval." },
  ];
  const result = evaluateClaimSupport({
    answerText: "Remote work requires manager approval. [Source 1, Source 2]",
    citations,
  });

  // Before the fix the label split off as its own unsupported "claim" and the
  // sentence lost both sources.
  assert.equal(result.claims.length, 1);
  assert.deepEqual(result.claims[0].sourceRanks, [1, 2]);
  assert.equal(result.unsupportedClaimCount, 0);
});

test("the QA writer hands downstream readers one source label per bracket", async (t) => {
  configureOpenAIProvider({
    completeText: async () => "Remote work requires manager approval. [Source 1, Source 2]",
  });
  t.after(() => resetOpenAIProvider());

  const answer = await writeQaAnswer({
    query: "Who approves remote work?",
    resolvedQuery: "Who approves remote work?",
    bundle: { context: "[Source 1] Remote work requires manager approval.", citations: [] },
  });

  assert.equal(answer.text, "Remote work requires manager approval. [Source 1] [Source 2]");
});
