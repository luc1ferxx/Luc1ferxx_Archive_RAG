import test from "node:test";
import assert from "node:assert/strict";
import { startsWithNotInEvidenceVerdict } from "../rag/answer-verdict.js";

test("only a reply opening with the marker starts with it", () => {
  // Markdown, a missing colon, lower case and a full-width colon all count.
  for (const reply of [
    "NOT_IN_EVIDENCE: The paper does not report the dataset size.",
    "**NOT_IN_EVIDENCE:** Not stated [Source 2]",
    "`NOT_IN_EVIDENCE` Not stated",
    "not in evidence: Not stated",
    "NOT_IN_EVIDENCE：Not stated",
  ]) {
    assert.equal(startsWithNotInEvidenceVerdict(reply), true, reply);
  }

  assert.equal(
    startsWithNotInEvidenceVerdict("It takes effect on 1 May [Source 1].\nNOT_IN_EVIDENCE: The regions are not stated."),
    false
  );
  assert.equal(startsWithNotInEvidenceVerdict("BERT is not in evidence here."), false);
});
