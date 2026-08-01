import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeterministicEvidenceAnswer,
} from "../evaluation/deterministic-evidence-answer.js";

const buildPrompt = ({
  comparison = false,
  question = "What is the remote work policy?",
  sources = [],
} = {}) =>
  [
    comparison
      ? "system:\nYou are a document-grounded comparison assistant for uploaded PDFs."
      : "system:\nYou are a document-grounded assistant for uploaded PDFs.",
    "human:",
    "User Question:",
    question,
    "",
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
      "Extra detail. [Source 1]",
      "Employees may work remotely 3 days per week. [Source 2]",
      "Extra detail. [Source 2]",
    ].join("\n")
  );
});

test("deterministic QA answer selects only the sentence relevant to the question", () => {
  const answer = buildDeterministicEvidenceAnswer(
    buildPrompt({
      question: "How many days of annual leave are provided?",
      sources: [
        "Annual leave is 15 days. Extra detail.",
        "A different document says 20 days.",
      ],
    })
  );

  assert.equal(
    answer,
    "Annual leave is 15 days. [Source 1]"
  );
});

test("deterministic QA selection can skip an irrelevant higher-ranked source", () => {
  const answer = buildDeterministicEvidenceAnswer(
    buildPrompt({
      question: "What is the badge renewal window?",
      sources: [
        "Travel expenses require itemized receipts.",
        "Badge renewal must happen within 30 days after audit completion.",
      ],
    })
  );

  assert.equal(
    answer,
    "Badge renewal must happen within 30 days after audit completion. [Source 2]"
  );
});

test("deterministic QA keeps multiple query-relevant facts without copying unrelated facts", () => {
  const answer = buildDeterministicEvidenceAnswer(
    buildPrompt({
      question: "What is the remote work policy?",
      sources: [
        [
          "Employees may work remotely 2 days per week.",
          "Employees complete a checklist before each remote day.",
          "The cafeteria serves breakfast.",
        ].join(" "),
      ],
    })
  );

  assert.equal(
    answer,
    [
      "Employees may work remotely 2 days per week. [Source 1]",
      "Employees complete a checklist before each remote day. [Source 1]",
    ].join("\n")
  );
});

test("deterministic answer abstains when no evidence block is present", () => {
  assert.equal(
    buildDeterministicEvidenceAnswer("Grounded Answer:"),
    "I could not find enough grounded evidence in the selected documents."
  );
});
