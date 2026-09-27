// The load test's ingest scenario uploads PDFs it writes by hand
// (evaluation/load-bench-pdf.mjs). They must parse with the loader every
// upload goes through (rag/pdf-loader.js, pdf.js) and pass the upload route's
// magic-byte check, or the scenario would measure rejections.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildIngestDocuments, buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { loadPdfDocument } from "../rag/pdf-loader.js";

const parse = async (t, bytes) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "load-bench-pdf-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "document.pdf");
  await writeFile(filePath, bytes);

  return loadPdfDocument(filePath, { includeMetadata: true });
};

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
    parsed.pages.map((page) => page.text),
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
    parsed.pages.map((page) => page.text),
    documents[1].pageLines.map((lines) => lines.join("\n"))
  );
});
