// The load test's ingest scenario uploads PDFs it writes by hand
// (evaluation/load-bench-pdf.mjs). They must parse with the loader every
// upload goes through (rag/pdf-loader.js, pdf.js) and pass the upload route's
// magic-byte check, or the scenario would measure rejections.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildIngestDocuments, buildTextPdf, probePageIndex } from "../evaluation/load-bench-pdf.mjs";
import { loadPdfDocument } from "../rag/pdf-loader.js";

const parse = async (t, bytes) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "load-bench-pdf-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "document.pdf");
  await writeFile(filePath, bytes);

  return loadPdfDocument(filePath, { includeMetadata: true });
};

// One sentence per line either way: PDF_PARAGRAPH_DETECTION only adds blank
// lines between these lines (each ends a sentence, so none is rejoined), and
// the chunker splits on any run of line breaks.
const pageTexts = (parsed) => parsed.pages.map((page) => page.text.replace(/\n{2,}/g, "\n"));

test("a hand-written PDF parses with pdf.js into one line per sentence", async (t) => {
  const pdf = buildTextPdf({
    pages: [
      ["First page, first line.", "Parentheses (like these) and a back\\slash survive."],
      ["Second page only line."],
    ],
    title: "Load test (sample)",
  });

  assert.equal(pdf.subarray(0, 8).toString("latin1"), "%PDF-1.4");
  assert.match(pdf.subarray(-6).toString("latin1"), /%%EOF\n$/);

  const parsed = await parse(t, pdf);

  assert.equal(parsed.pageCount, 2);
  assert.deepEqual(
    pageTexts(parsed),
    ["First page, first line.\nParentheses (like these) and a back\\slash survive.", "Second page only line."]
  );
  assert.equal(parsed.info?.Title, "Load test (sample)");
});

test("the cross-reference table points at every object", () => {
  const pdf = buildTextPdf({ pages: [["a"], ["b"], ["c"]] }).toString("latin1");
  const startxref = Number(pdf.match(/startxref\n(\d+)\n%%EOF/)[1]);
  const entries = pdf.slice(startxref).match(/^(\d{10}) 00000 n $/gm);

  assert.equal(pdf.slice(startxref, startxref + 4), "xref");
  // catalog, page tree, font, then a page and a content stream per page
  assert.equal(entries.length, 3 + 3 * 2);
  entries.forEach((entry, index) => {
    const offset = Number(entry.slice(0, 10));
    assert.equal(pdf.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`);
  });
  assert.throws(() => buildTextPdf({ pages: [] }), /at least one page/);
});

test("ingest documents are deterministic, distinct per tag and parse page by page", async (t) => {
  const documents = buildIngestDocuments({ documents: 3, pages: 2, sentencesPerPage: 4, tag: "t1" });

  assert.equal(documents.length, 3);
  assert.deepEqual(
    documents.map((document) => document.fileName),
    ["program-albatross-t1-1-manual.pdf", "program-bluebell-t1-2-manual.pdf", "program-cobalt-t1-3-manual.pdf"]
  );
  assert.deepEqual(documents, buildIngestDocuments({ documents: 3, pages: 2, sentencesPerPage: 4, tag: "t1" }));
  assert.notDeepEqual(
    documents[0].pageLines,
    buildIngestDocuments({ documents: 1, pages: 2, sentencesPerPage: 4, tag: "t2" })[0].pageLines
  );
  // Each page states one fact that names its own program.
  assert.match(documents[1].pageLines[0][1], /approval threshold for Program Bluebell-t1-2 is \d+ dollars/);

  const parsed = await parse(t, documents[1].pdf);

  assert.equal(parsed.pageCount, 2);
  assert.deepEqual(
    pageTexts(parsed),
    documents[1].pageLines.map((lines) => lines.join("\n"))
  );
});

test("each document carries a probe: one page's question and the phrase its answer must contain", () => {
  const documents = buildIngestDocuments({ documents: 5, pages: 4, tag: "p1" });

  // Fact kinds rotate over the documents, so a level asks every kind.
  assert.deepEqual(
    documents.map((document) => document.probe.pageNumber),
    [1, 2, 3, 4, 1]
  );
  for (const document of documents) {
    const factLine = document.pageLines[document.probe.pageNumber - 1][1];
    assert.ok(factLine.includes(document.probe.expected), `${factLine} states ${document.probe.expected}`);
    assert.ok(document.probe.question.includes(document.name), "the question names the document's program");
  }
  assert.equal(documents[1].probe.question, "Which department runs Program Bluebell-p1-2?");
  assert.match(documents[1].probe.expected, /^[a-z]+ department$/);
  assert.equal(documents[2].probe.question, "Where is the field office for Program Cobalt-p1-3 located?");
  assert.match(documents[3].probe.expected, /^month \d+$/);
});

test("with more than four pages a repeated kind of fact is about an annex, and the probe asks the unique one", () => {
  const [document] = buildIngestDocuments({ documents: 1, pages: 6, tag: "p2" });

  assert.equal(document.pageLines[0][1].startsWith("The approval threshold for Program Albatross-p2-1 is"), true);
  assert.equal(document.pageLines[4][1].startsWith("The approval threshold for Program Albatross-p2-1 annex 2 is"), true);
  // Kind 0 occurs on pages 1 and 5: the probe asks page 5's question, which
  // page 1 does not answer.
  assert.equal(probePageIndex(0, 6), 4);
  assert.equal(document.probe.pageNumber, 5);
  assert.equal(document.probe.question, "What is the approval threshold for Program Albatross-p2-1 annex 2?");
  assert.deepEqual([0, 1, 2, 3].map((docIndex) => probePageIndex(docIndex, 3)), [0, 1, 2, 0]);
  assert.deepEqual([0, 1, 2, 3].map((docIndex) => probePageIndex(docIndex, 1)), [0, 0, 0, 0]);
});
