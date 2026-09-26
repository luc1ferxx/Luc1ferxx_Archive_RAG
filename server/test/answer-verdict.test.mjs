import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOT_IN_EVIDENCE_REASON,
  readQaAnswerVerdict,
  startsWithNotInEvidenceVerdict,
} from "../rag/answer-verdict.js";

test("a reply opening with the marker is an abstention with the model's reason", () => {
  assert.deepEqual(readQaAnswerVerdict("NOT_IN_EVIDENCE: The paper does not report the dataset size."), {
    abstained: true,
    reason: "The paper does not report the dataset size.",
  });
  // Markdown, a missing colon, lower case and a full-width colon all count.
  for (const reply of [
    "**NOT_IN_EVIDENCE:** Not stated [Source 2]",
    "`NOT_IN_EVIDENCE` Not stated",
    "not in evidence: Not stated",
    "NOT_IN_EVIDENCE：Not stated",
  ]) {
    assert.deepEqual(readQaAnswerVerdict(reply), { abstained: true, reason: "Not stated" }, reply);
  }

  assert.deepEqual(readQaAnswerVerdict("NOT_IN_EVIDENCE:"), {
    abstained: true,
    reason: DEFAULT_NOT_IN_EVIDENCE_REASON,
  });
});

test("a marker after a partial answer is removed and the answer kept", () => {
  assert.deepEqual(
    readQaAnswerVerdict("It takes effect on 1 May [Source 1].\nNOT_IN_EVIDENCE: The regions are not stated."),
    { abstained: false, text: "It takes effect on 1 May [Source 1].\nThe regions are not stated." }
  );
  assert.deepEqual(readQaAnswerVerdict("BERT [Source 1]."), { abstained: false, text: "BERT [Source 1]." });
  assert.equal(startsWithNotInEvidenceVerdict("BERT is not in evidence here."), false);
});
