import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadPdfDocument,
  loadPdfPages,
} from "../rag/pdf-loader.js";

const escapePdfText = (text) =>
  text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const buildValidPdfBuffer = (pages) => {
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  const contentObjectIds = pages.map((_, index) => 5 + index * 2);
  const objects = [
    {
      id: 1,
      body: "<< /Type /Catalog /Pages 2 0 R >>",
    },
    {
      id: 2,
      body: `<< /Type /Pages /Kids [${pageObjectIds
        .map((id) => `${id} 0 R`)
        .join(" ")}] /Count ${pages.length} >>`,
    },
    {
      id: 3,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    },
  ];

  pages.forEach((pageText, index) => {
    const stream = [
      "BT",
      "/F1 12 Tf",
      "72 720 Td",
      `(${escapePdfText(pageText)}) Tj`,
      "ET",
    ].join("\n");

    objects.push({
      id: pageObjectIds[index],
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjectIds[index]} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    });
    objects.push({
      id: contentObjectIds[index],
      body: `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    });
  });

  objects.sort((left, right) => left.id - right.id);
  let pdf = "%PDF-1.4\n";
  const offsets = new Map();

  for (const entry of objects) {
    offsets.set(entry.id, Buffer.byteLength(pdf, "utf8"));
    pdf += `${entry.id} 0 obj\n${entry.body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (const entry of objects) {
    pdf += `${String(offsets.get(entry.id)).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
};

test("loadPdfPages extracts text from a valid byte-offset PDF", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-loader-test-"));
  const pdfPath = path.join(tempDir, "test.pdf");

  try {
    await writeFile(
      pdfPath,
      buildValidPdfBuffer([
        "Remote work requires manager approval before the first remote day.",
      ])
    );
    const pages = await loadPdfPages(pdfPath);

    assert.deepEqual(pages, [
      {
        pageNumber: 1,
        text: "Remote work requires manager approval before the first remote day.",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPdfPages preserves page order and text shape", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-loader-shape-"));
  const pdfPath = path.join(tempDir, "shape.pdf");

  try {
    await writeFile(
      pdfPath,
      buildValidPdfBuffer([
        "First page (overview).",
        "Second page uses a backslash: C:\\Archive.",
      ])
    );
    const pages = await loadPdfPages(pdfPath);

    assert.deepEqual(pages, [
      {
        pageNumber: 1,
        text: "First page (overview).",
      },
      {
        pageNumber: 2,
        text: "Second page uses a backslash: C:\\Archive.",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPdfDocument limits rendered pages and returns parser metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-loader-document-"));
  const pdfPath = path.join(tempDir, "document.pdf");

  try {
    await writeFile(
      pdfPath,
      buildValidPdfBuffer([
        "First document page.",
        "Second document page.",
      ])
    );
    const result = await loadPdfDocument(pdfPath, {
      maxPages: 1,
      includeMetadata: true,
    });

    assert.equal(result.pageCount, 2);
    assert.equal(result.renderedPageCount, 1);
    assert.deepEqual(result.pages, [
      {
        pageNumber: 1,
        text: "First document page.",
      },
    ]);
    assert.equal(typeof result.pdfVersion, "string");
    assert.ok(result.pdfVersion.length > 0);
    assert.equal(typeof result.info, "object");
    assert.ok(result.info);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPdfPages rejects non-existent file", async () => {
  await assert.rejects(
    () => loadPdfPages("/non/existent/path.pdf"),
    (error) => error.code === "ENOENT"
  );
});

test("loadPdfPages rejects malformed PDF bytes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-loader-malformed-"));
  const pdfPath = path.join(tempDir, "malformed.pdf");

  try {
    await writeFile(pdfPath, "%PDF-1.4\nnot-a-document\n%%EOF\n");

    await assert.rejects(
      () => loadPdfPages(pdfPath),
      (error) => error instanceof Error
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
