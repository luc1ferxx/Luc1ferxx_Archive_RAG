import assert from "node:assert/strict";
import test from "node:test";

import { finalizeAgentAnswer } from "../rag/agent-finalizer.js";
import { finalizeGroundedAnswer } from "../rag/grounded-answer-finalizer.js";

test("grounded answer finalization preserves the legacy agent contract", () => {
  const input = {
    answerText: [
      "Remote work requires manager approval. [Source 1]",
      "A satellite stipend is provided. [Source 1]",
    ].join("\n"),
    citations: [
      {
        rank: 1,
        docId: "policy",
        excerpt: "Remote work requires manager approval.",
      },
    ],
  };

  const grounded = finalizeGroundedAnswer(input);

  assert.equal(grounded.changed, true);
  assert.equal(grounded.abstained, false);
  assert.equal(
    grounded.text,
    "Remote work requires manager approval. [Source 1]"
  );
  assert.deepEqual(finalizeAgentAnswer(input), grounded);
});
