import test from "node:test";
import assert from "node:assert/strict";
import { evaluateClaimSupport } from "../rag/agent-self-check.js";
import { rebaseEvidenceResults } from "../rag/source-labels.js";

test("source labels are rebased across independently ranked evidence results", () => {
  const rebased = rebaseEvidenceResults([
    {
      text: "First finding. [Source 1]",
      citations: [{ docId: "doc-1", excerpt: "First finding." }],
    },
    {
      text: "Second finding. [来源 1]",
      citations: [{ docId: "doc-2", excerpt: "Second finding." }],
    },
  ]);

  assert.deepEqual(
    rebased.results.map((result) => result.text),
    ["First finding. [Source 1]", "Second finding. [来源 2]"]
  );
  assert.deepEqual(
    rebased.citations.map((citation) => citation.rank),
    [1, 2]
  );
});

test("source label rebasing preserves ambiguous local ranks for validation", () => {
  const rebased = rebaseEvidenceResults([
    {
      text: "Ambiguous finding. [Source 1]",
      citations: [
        { rank: 1, docId: "doc-1", excerpt: "First version." },
        { rank: 1, docId: "doc-2", excerpt: "Second version." },
      ],
    },
  ]);

  assert.deepEqual(
    rebased.citations.map((citation) => citation.rank),
    [1, 1]
  );
});

test("source label rebasing isolates labels missing from the current result citations", () => {
  const rebased = rebaseEvidenceResults([
    {
      text: "First finding. [Source 1]",
      citations: [
        { rank: 1, docId: "doc-1", excerpt: "First finding." },
      ],
    },
    {
      text: "Second finding. [Source 1]",
      citations: [
        { rank: 2, docId: "doc-2", excerpt: "Second finding." },
      ],
    },
  ]);

  assert.equal(rebased.results[1].text, "Second finding. [Source 3]");
  assert.deepEqual(
    rebased.citations.map((citation) => citation.rank),
    [1, 2]
  );
  const claimSupport = evaluateClaimSupport({
    answerText: rebased.results[1].text,
    citations: rebased.citations,
  });

  assert.equal(claimSupport.unsupportedClaimCount, 1);
  assert.deepEqual(claimSupport.claims[0].missingSourceRanks, [3]);
});
