import assert from "node:assert/strict";
import test from "node:test";

import { attachRetrievedEvidence } from "../rag/citations.js";

test("retrieved evidence binding rejects equal ranks with conflicting explicit identities", () => {
  const citation = {
    rank: 1,
    docId: "doc-alpha",
    chunkIndex: 2,
    pageNumber: 3,
  };

  for (const conflictingContext of [
    { ...citation, docId: "doc-beta", text: "Wrong document." },
    { ...citation, chunkIndex: 9, text: "Wrong chunk." },
    { ...citation, pageNumber: 8, text: "Wrong page." },
  ]) {
    const [result] = attachRetrievedEvidence({
      citations: [citation],
      retrievedContexts: [conflictingContext],
    });

    assert.equal(result.evidenceText, undefined);
  }
});

test("retrieved evidence binding accepts equal ranks with compatible explicit identities", () => {
  const [result] = attachRetrievedEvidence({
    citations: [
      {
        rank: 1,
        docId: "doc-alpha",
        chunkIndex: 2,
        pageNumber: 3,
      },
    ],
    retrievedContexts: [
      {
        rank: 1,
        docId: "doc-alpha",
        chunkIndex: 2,
        pageNumber: 3,
        text: "Remote work requires manager approval.",
      },
    ],
  });

  assert.equal(
    result.evidenceText,
    "Remote work requires manager approval."
  );
});
