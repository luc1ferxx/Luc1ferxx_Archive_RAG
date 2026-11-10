import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEmptyArchiveResult,
  formatAskResult,
  formatCitation,
  formatCitations,
  formatDocumentList,
  formatEvidence,
  formatToolError,
  parseDocIdList,
  resolveDocIds,
  toMcpTextContent,
} from "../archive-mcp-tools.js";

test("citations keep the page-level contract from buildCitation", () => {
  const citation = formatCitation({
    rank: 1,
    score: 0.8123,
    docId: "doc-1",
    fileName: "contract.pdf",
    filePath: "/files/contract.pdf",
    pageNumber: 12,
    chunkIndex: 4,
    excerpt: "  Termination   requires\n thirty days notice.  ",
    sectionHeading: "3.2 Termination",
  });

  assert.deepEqual(citation, {
    rank: 1,
    score: 0.8123,
    docId: "doc-1",
    fileName: "contract.pdf",
    filePath: "/files/contract.pdf",
    pageNumber: 12,
    chunkIndex: 4,
    excerpt: "Termination requires thirty days notice.",
    sectionHeading: "3.2 Termination",
  });
});

test("citation excerpts stay capped at 220 characters", () => {
  const citation = formatCitation({ excerpt: "x".repeat(500) });

  assert.equal(citation.excerpt.length, 220);
});

test("missing citation fields degrade without throwing", () => {
  const citation = formatCitation({});

  assert.equal(citation.docId, null);
  assert.equal(citation.fileName, "Unknown document");
  assert.equal(citation.filePath, "");
  assert.equal(citation.pageNumber, null);
  assert.equal(citation.chunkIndex, null);
  assert.equal(citation.sectionHeading, null);
  assert.equal(citation.excerpt, "");
});

test("non-array citation and evidence inputs collapse to empty lists", () => {
  assert.deepEqual(formatCitations(undefined), []);
  assert.deepEqual(formatCitations(null), []);
  assert.deepEqual(formatEvidence(undefined), []);
});

test("evidence entries carry the full chunk text", () => {
  const evidence = formatEvidence([
    {
      rank: 2,
      docId: "doc-9",
      fileName: "policy.pdf",
      pageNumber: 3,
      chunkIndex: 7,
      sectionHeading: null,
      text: "Full chunk text is preserved verbatim.",
    },
  ]);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].text, "Full chunk text is preserved verbatim.");
  assert.equal(evidence[0].pageNumber, 3);
});

test("a confident answer surfaces answer, citations and evidence", () => {
  const result = formatAskResult({
    abstained: false,
    text: "Thirty days notice is required.",
    citations: [{ rank: 1, score: 0.5, docId: "doc-1", pageNumber: 12 }],
    retrievedContexts: [{ rank: 1, docId: "doc-1", text: "chunk" }],
    resolvedQuery: "What notice is required?",
  });

  assert.equal(result.abstained, false);
  assert.equal(result.abstainReason, null);
  assert.equal(result.answer, "Thirty days notice is required.");
  assert.equal(result.citations.length, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.resolvedQuestion, "What notice is required?");
});

test("an abstention returns the reason and withholds all citations", () => {
  const result = formatAskResult({
    abstained: true,
    abstainReason: "No qualifying evidence was retrieved.",
    text: "No qualifying evidence was retrieved.",
    citations: [{ rank: 1, docId: "doc-1", pageNumber: 12 }],
    retrievedContexts: [{ rank: 1, docId: "doc-1", text: "chunk" }],
  });

  assert.equal(result.abstained, true);
  assert.equal(result.abstainReason, "No qualifying evidence was retrieved.");
  assert.equal(result.answer, "");
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.evidence, []);
});

test("an answer the output limit cut off says so; one that finished keeps its shape", () => {
  const cut = formatAskResult({
    abstained: false,
    answerTruncated: true,
    text: "Thirty days notice is required for",
    citations: [{ rank: 1, score: 0.5, docId: "doc-1", pageNumber: 12 }],
  });
  const finished = formatAskResult({ abstained: false, text: "Thirty days notice is required." });

  assert.equal(cut.answerTruncated, true);
  assert.equal(cut.answer, "Thirty days notice is required for");
  assert.equal("answerTruncated" in finished, false);
});

test("an abstention without an explicit reason falls back to the answer text", () => {
  const result = formatAskResult({
    abstained: true,
    text: "I cannot answer from the available pages.",
  });

  assert.equal(result.abstainReason, "I cannot answer from the available pages.");
});

test("an abstention with no reason at all still reports one", () => {
  const result = formatAskResult({ abstained: true });

  assert.equal(result.abstainReason, "No reason provided.");
});

test("comparison summaries pass through when present", () => {
  const result = formatAskResult({
    abstained: false,
    text: "They differ on notice period.",
    comparisonAnalysisSummary: { materialDifference: true },
  });

  assert.deepEqual(result.comparison, { materialDifference: true });
});

test("tool errors are reported in abstention shape rather than thrown", () => {
  const result = formatToolError(new Error("OPENAI_API_KEY is not configured."));

  assert.equal(result.abstained, true);
  assert.equal(result.abstainReason, "OPENAI_API_KEY is not configured.");
  assert.equal(result.error, "OPENAI_API_KEY is not configured.");
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.evidence, []);
});

test("tool errors without a message still produce a reason", () => {
  assert.equal(
    formatToolError(undefined).abstainReason,
    "The archive request failed."
  );
});

test("docId lists drop blanks and trim entries", () => {
  assert.deepEqual(parseDocIdList([" doc-1 ", "", "doc-2", null]), [
    "doc-1",
    "doc-2",
  ]);
  assert.deepEqual(parseDocIdList("not-an-array"), []);
});

test("explicit docIds win over the available document list", () => {
  const resolved = resolveDocIds({
    docIds: ["doc-2"],
    availableDocuments: [{ docId: "doc-1" }, { docId: "doc-2" }],
  });

  assert.deepEqual(resolved, ["doc-2"]);
});

test("omitted docIds widen to every available document", () => {
  const resolved = resolveDocIds({
    availableDocuments: [{ docId: "doc-1" }, { docId: "doc-2" }],
  });

  assert.deepEqual(resolved, ["doc-1", "doc-2"]);
});

test("an empty archive resolves to no docIds", () => {
  assert.deepEqual(resolveDocIds({}), []);
  assert.deepEqual(resolveDocIds({ availableDocuments: [] }), []);
});

test("the empty-archive result tells the caller how to recover", () => {
  const result = buildEmptyArchiveResult();

  assert.equal(result.abstained, true);
  assert.match(result.abstainReason, /archive_refresh/);
  assert.deepEqual(result.citations, []);
});

test("document summaries expose the fields needed to pick a docId", () => {
  const documents = formatDocumentList([
    {
      docId: "doc-1",
      fileName: "contract.pdf",
      pageCount: 20,
      chunkCount: 40,
      uploadedAt: "2026-01-01T00:00:00.000Z",
      profile: { summary: "dropped" },
    },
  ]);

  assert.deepEqual(documents, [
    {
      docId: "doc-1",
      fileName: "contract.pdf",
      pageCount: 20,
      chunkCount: 40,
      uploadedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

test("document summaries tolerate missing fields", () => {
  assert.deepEqual(formatDocumentList([{}]), [
    {
      docId: null,
      fileName: "Unknown document",
      pageCount: null,
      chunkCount: null,
      uploadedAt: null,
    },
  ]);
  assert.deepEqual(formatDocumentList(null), []);
});

test("payloads are wrapped in the MCP text-content envelope", () => {
  const content = toMcpTextContent({ abstained: false });

  assert.equal(content.content.length, 1);
  assert.equal(content.content[0].type, "text");
  assert.deepEqual(JSON.parse(content.content[0].text), { abstained: false });
});
