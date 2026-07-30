import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeterministicEvidenceAnswer,
} from "../evaluation/deterministic-evidence-answer.js";

const buildPrompt = ({ comparison = false, sources = [] } = {}) =>
  [
    comparison
      ? "system:\nYou are a document-grounded comparison assistant for uploaded PDFs."
      : "system:\nYou are a document-grounded assistant for uploaded PDFs.",
    "human:",
    ...sources.flatMap((source, index) => [
      `Source ${index + 1}`,
      `File: handbook-${index + 1}.pdf`,
      `Page: ${index + 1}`,
      "Evidence:",
      source,
      "",
    ]),
    comparison
      ? "Write the answer using these sections:\nSummary:\nPer document:"
      : "Grounded Answer:",
  ].join("\n");

test("deterministic comparison answer grounds one atomic claim in every source", () => {
  const answer = buildDeterministicEvidenceAnswer(
    buildPrompt({
      comparison: true,
      sources: [
        "Employees may work remotely 2 days per week. Extra detail.",
        "Employees may work remotely 3 days per week. Extra detail.",
      ],
    })
  );

  assert.equal(
    answer,
    [
      "Employees may work remotely 2 days per week. [Source 1]",
      "Employees may work remotely 3 days per week. [Source 2]",
    ].join("\n")
  );
});

test("deterministic QA answer cites only the first retrieved source", () => {
  const answer = buildDeterministicEvidenceAnswer(
    buildPrompt({
      sources: [
        "Annual leave is 15 days. Extra detail.",
        "A different document says 20 days.",
      ],
    })
  );

  assert.equal(answer, "Annual leave is 15 days. [Source 1]");
});

test("deterministic answer abstains when no evidence block is present", () => {
  assert.equal(
    buildDeterministicEvidenceAnswer("Grounded Answer:"),
    "I could not find enough grounded evidence in the selected documents."
  );
});
