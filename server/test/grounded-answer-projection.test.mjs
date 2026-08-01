import assert from "node:assert/strict";
import test from "node:test";

import { projectGroundedAnswer } from "../rag/grounded-answer-projection.js";

test("grounded answer projection filters and continuously rebases text, citations, and contexts", () => {
  const citations = [
    { rank: 1, docId: "doc-removed", pageNumber: 1 },
    { rank: 2, docId: "doc-kept", pageNumber: 2 },
  ];
  const retrievedContexts = [
    { rank: 1, docId: "doc-removed", pageNumber: 1, text: "Unrelated." },
    {
      rank: 2,
      docId: "doc-kept",
      pageNumber: 2,
      text: "Remote work requires manager approval.",
    },
  ];
  const claimSupport = {
    checked: true,
    claims: [
      {
        supported: false,
        sourceRanks: [1],
        verifiedSourceRanks: [],
        supportedSourceRanks: [],
        missingSourceRanks: [],
        ambiguousSourceRanks: [],
      },
      {
        supported: true,
        sourceRanks: [2],
        verifiedSourceRanks: [2],
        supportedSourceRanks: [2],
        missingSourceRanks: [],
        ambiguousSourceRanks: [],
      },
    ],
  };
  const originalClaimSupport = structuredClone(claimSupport);

  const projection = projectGroundedAnswer({
    text: "Remote work requires manager approval. [Source 2]",
    citations,
    retrievedContexts,
    claimSupport,
  });

  assert.equal(
    projection.text,
    "Remote work requires manager approval. [Source 1]"
  );
  assert.deepEqual(projection.citations, [
    { rank: 1, docId: "doc-kept", pageNumber: 2 },
  ]);
  assert.deepEqual(projection.retrievedContexts, [
    {
      rank: 1,
      docId: "doc-kept",
      pageNumber: 2,
      text: "Remote work requires manager approval.",
    },
  ]);
  assert.deepEqual([...projection.sourceRankMap.entries()], [[2, 1]]);
  assert.deepEqual(projection.claimSupport.claims[1].sourceRanks, [1]);
  assert.deepEqual(
    projection.claimSupport.claims[1].verifiedSourceRanks,
    [1]
  );
  assert.deepEqual(
    projection.claimSupport.claims[1].supportedSourceRanks,
    [1]
  );
  assert.deepEqual(
    claimSupport,
    originalClaimSupport,
    "projection must not mutate claim-support diagnostics"
  );
  assert.equal(citations[1].rank, 2, "projection must not mutate product input");
  assert.equal(
    retrievedContexts[1].rank,
    2,
    "projection must not mutate retrieval diagnostics"
  );
});
