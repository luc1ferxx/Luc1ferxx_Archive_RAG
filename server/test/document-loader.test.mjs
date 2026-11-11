// The single loader entry point (rag/document-loader.js): PDF through the
// unchanged loadPdfPages, the Office formats through the archive guard and
// their loaders, the parts the PPTX reader is handed, the formats a read
// accepts, encrypted working files, and the parse metadata of each format.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describePdfParseSettings } from "../rag/chunk-profile.js";
import { DOCUMENT_FORMAT_ERROR_CODES, DocumentFormatError } from "../rag/document-format-errors.js";
import { DOCUMENT_MIME_TYPES } from "../rag/document-formats.js";
import { PPTX_EXTRACTOR, isPptxReaderPart, loadDocumentPages, resolveQueuedDocumentFormats } from "../rag/document-loader.js";
import { loadQueuedDocument } from "../rag/ingest-pipeline.js";
import { extractDocxPages, getMammothVersion } from "../rag/office/docx-loader.js";
import { extractXlsxPages, getSheetjsVersion } from "../rag/office/xlsx-loader.js";
import { loadPdfPages } from "../rag/pdf-loader.js";
import { WORKING_FILE_MAGIC, writeWorkingFile } from "../rag/working-files.js";
import {
  buildDocx,
  buildOle2Bytes,
  buildPptx,
  buildXlsx,
  buildZip,
  pptxEntries,
} from "./office-fixture-builder.mjs";
import { buildProsePdf } from "./pdf-fixture-builder.mjs";

const CODES = DOCUMENT_FORMAT_ERROR_CODES;
const SETTINGS = ["TENANT_ENCRYPTION", "RAG_XLSX_MAX_CELLS", "PDF_PARSER", "PDF_PARSE_WORKERS", "RAG_DOCUMENT_FORMATS"];
const savedSettings = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of SETTINGS) {
    if (savedSettings[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedSettings[name];
    }
  }
});

const withFiles = async (files, callback) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "document-loader-"));

  try {
    const paths = {};

    for (const [name, bytes] of Object.entries(files)) {
      paths[name] = path.join(directory, name);
      // As an upload is stored: a working file (encrypted with TENANT_ENCRYPTION=on).
      await writeWorkingFile(paths[name], bytes);
    }

    return await callback(paths, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const PDF = buildProsePdf();
const DOCX = buildDocx({
  blocks: [{ text: "Preface" }, { heading: 1, text: "Scope" }, { text: "The scope paragraph." }, { heading: 1, text: "Terms" }],
});
const XLSX_BYTES = buildXlsx({
  sheets: [
    { name: "Visible", rows: [["Name", "Value"], ["alpha", 1]] },
    { name: "Hidden", rows: [["secret", "x"]], state: "hidden" },
  ],
});
const PPTX_OPTIONS = {
  slides: [
    { notes: "Remember the numbers", shapes: [{ paragraphs: [{ bullet: true, text: "First point" }], x: 1, y: 2 }], title: "Kickoff" },
    { hidden: true, title: "Backup slide" },
    { shapes: [{ table: [["Owner", "Due"], ["Ana", "May"]], x: 1, y: 2 }], title: "Plan" },
  ],
};
const PPTX = buildPptx(PPTX_OPTIONS);

test("a PDF goes through loadPdfPages unchanged, with the parse settings of the staged ingest", async () => {
  delete process.env.PDF_PARSER;
  delete process.env.PDF_PARSE_WORKERS;

  await withFiles({ "document.pdf": PDF }, async ({ "document.pdf": filePath }) => {
    const expectedPages = await loadPdfPages(filePath);

    for (const formats of [undefined, ["pdf"], ["pdf", "docx", "pptx", "xlsx"]]) {
      const loaded = await loadDocumentPages(filePath, formats ? { formats } : {});

      assert.deepStrictEqual(loaded, {
        format: "pdf",
        mimeType: "application/pdf",
        pages: expectedPages,
        parse: describePdfParseSettings(),
      });
      assert.deepEqual(Object.keys(loaded.parse), ["paragraphDetection", "pdfParser"]);

      for (const page of loaded.pages) {
        assert.deepEqual(Object.keys(page).sort(), ["pageNumber", "text"]);
      }
    }
  });
});

test("with PDF alone there is no detection: other bytes fail exactly as loadPdfPages fails", async () => {
  await withFiles({ "word.docx": DOCX }, async ({ "word.docx": filePath }) => {
    const direct = await loadPdfPages(filePath).then(
      () => null,
      (error) => error
    );
    const viaLoader = await loadDocumentPages(filePath, { formats: ["pdf"] }).then(
      () => null,
      (error) => error
    );

    assert.ok(direct instanceof Error, "pdf.js refuses a .docx");
    assert.equal(viaLoader?.constructor, direct.constructor);
    assert.equal(viaLoader?.message, direct.message);
    assert.equal(viaLoader instanceof DocumentFormatError, false);
  });
});

test("a .docx loads through mammoth, a page per section, with its parse metadata", async () => {
  await withFiles({ "word.docx": DOCX }, async ({ "word.docx": filePath }) => {
    const loaded = await loadDocumentPages(filePath, { fileName: "Report.docx" });

    assert.equal(loaded.format, "docx");
    assert.equal(loaded.mimeType, DOCUMENT_MIME_TYPES.docx);
    assert.deepStrictEqual(loaded.pages, await extractDocxPages(DOCX));
    assert.deepStrictEqual(loaded.parse, { extractor: "mammoth", extractorVersion: getMammothVersion(), format: "docx" });
    assert.deepEqual(
      loaded.pages.map((page) => [page.pageNumber, page.locationLabel ?? null]),
      [
        [1, null],
        [2, "Scope"],
        [3, "Terms"],
      ]
    );
  });
});

test("a .xlsx loads through SheetJS, visible sheets only, with its parse metadata", async () => {
  await withFiles({ "book.xlsx": XLSX_BYTES }, async ({ "book.xlsx": filePath }) => {
    const loaded = await loadDocumentPages(filePath);

    assert.equal(loaded.format, "xlsx");
    assert.equal(loaded.mimeType, DOCUMENT_MIME_TYPES.xlsx);
    assert.deepStrictEqual(loaded.pages, await extractXlsxPages(XLSX_BYTES));
    assert.deepStrictEqual(loaded.parse, { extractor: "sheetjs", extractorVersion: getSheetjsVersion(), format: "xlsx" });
    assert.deepEqual(loaded.pages, [
      { locationLabel: "Visible", locationUnit: "sheet", pageNumber: 1, text: "Sheet: Visible\nName; Value\nName: alpha; Value: 1" },
    ]);

    // RAG_XLSX_MAX_CELLS applies through the loader (the pre-parse bound or the count).
    process.env.RAG_XLSX_MAX_CELLS = "1";
    await assert.rejects(loadDocumentPages(filePath), { code: CODES.spreadsheetTooLarge, status: 413 });
    process.env.RAG_XLSX_MAX_CELLS = "2";
    await assert.rejects(loadDocumentPages(filePath), { code: CODES.spreadsheetTooLarge, status: 413 });
    // Four visible cells fit; the hidden sheet's two do not count.
    process.env.RAG_XLSX_MAX_CELLS = "4";
    assert.equal((await loadDocumentPages(filePath)).pages.length, 1);
  });
});

test("the PPTX reader is handed ppt/**/*.xml, ppt/**/*.rels, _rels/.rels and [Content_Types].xml as the guard inflated them", async () => {
  const entries = pptxEntries(PPTX_OPTIONS);
  const expected = new Map(
    entries
      .filter((entry) => isPptxReaderPart(entry.name))
      .map((entry) => [entry.name, Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8")])
  );
  let received = null;
  let receivedOptions = null;
  const fakeReader = {
    PPTX_EXTRACTOR_VERSION: 7,
    extractPptxPages: (parts, options) => {
      received = parts;
      receivedOptions = options;
      return [{ locationLabel: "Kickoff", locationUnit: "slide", pageNumber: 1, text: "Kickoff" }];
    },
  };

  await withFiles({ "deck.pptx": PPTX }, async ({ "deck.pptx": filePath }) => {
    const loaded = await loadDocumentPages(filePath, { importPptxReader: async () => fakeReader });

    assert.equal(loaded.format, "pptx");
    assert.equal(loaded.mimeType, DOCUMENT_MIME_TYPES.pptx);
    assert.deepStrictEqual(loaded.parse, { extractor: PPTX_EXTRACTOR, extractorVersion: 7, format: "pptx" });
    assert.equal(PPTX_EXTRACTOR, "ooxml-pptx");
    assert.deepEqual(loaded.pages, [{ locationLabel: "Kickoff", locationUnit: "slide", pageNumber: 1, text: "Kickoff" }]);
  });

  assert.ok(received instanceof Map);
  assert.deepEqual([...received.keys()].sort(), [...expected.keys()].sort());
  assert.ok(received.has("[Content_Types].xml"));
  assert.ok(received.has("ppt/presentation.xml"));
  assert.ok(received.has("ppt/_rels/presentation.xml.rels"));
  assert.ok(received.has("ppt/notesSlides/notesSlide1.xml"));
  // The package relationships name the presentation part; the reader is also
  // told which part the guard classified.
  assert.ok(received.has("_rels/.rels"));
  assert.deepEqual(receivedOptions, { maxTextChars: 67_108_864, presentationPart: "ppt/presentation.xml" });
  assert.equal([...received.keys()].some((name) => name.endsWith(".png")), false);

  for (const [name, bytes] of expected) {
    assert.ok(received.get(name).equals(bytes), name);
  }
});

test("a deck whose main part is not ppt/presentation.xml reads the part the guard classified", async () => {
  const rename = (name) =>
    name.replace("ppt/presentation.xml", "ppt/deck.xml").replace("ppt/_rels/presentation.xml.rels", "ppt/_rels/deck.xml.rels");
  const renamed = buildZip(
    pptxEntries(PPTX_OPTIONS).map((entry) => ({
      ...entry,
      data: typeof entry.data === "string" ? entry.data.replace("/ppt/presentation.xml", "/ppt/deck.xml").replace('Target="ppt/presentation.xml"', 'Target="ppt/deck.xml"') : entry.data,
      name: rename(entry.name),
    }))
  );

  await withFiles({ "deck.pptx": PPTX, "renamed.pptx": renamed }, async (paths) => {
    const original = await loadDocumentPages(paths["deck.pptx"]);
    const loaded = await loadDocumentPages(paths["renamed.pptx"]);

    assert.equal(loaded.format, "pptx");
    assert.deepStrictEqual(loaded.pages, original.pages);
    assert.match(loaded.pages[0].text, /Kickoff/);
  });
});

test("a queued job is read as the PDF a PDF-only server queued it as, a ZIP with '%PDF' in its first kilobyte included", async () => {
  // A real .docx whose first entry's name puts '%PDF' in the first kilobyte:
  // RAG_DOCUMENT_FORMATS=pdf takes it for a PDF at the enqueue.
  const polyglot = buildDocx({
    blocks: [{ text: "Hello" }],
    transform: (entries) => [{ data: "x", method: "store", name: "%PDF-1.7.txt" }, ...entries],
  });

  await withFiles({ "doc.pdf": PDF, "polyglot.docx": polyglot, "word.docx": DOCX }, async (paths) => {
    const ALL_FORMATS = ["pdf", "docx", "pptx", "xlsx"];

    // Office formats enabled: every job is read as what it is.
    for (const name of ["doc.pdf", "polyglot.docx", "word.docx"]) {
      assert.deepEqual(await resolveQueuedDocumentFormats(paths[name]), ALL_FORMATS, name);
    }

    assert.equal((await loadQueuedDocument(paths["polyglot.docx"])).format, "docx");

    process.env.RAG_DOCUMENT_FORMATS = "pdf";
    // PDF alone: what the PDF check passes is read as a PDF, as at the
    // enqueue; a .docx the check refuses was queued while Office formats were
    // enabled and is still read as one.
    assert.deepEqual(await resolveQueuedDocumentFormats(paths["doc.pdf"]), ["pdf"]);
    assert.deepEqual(await resolveQueuedDocumentFormats(paths["polyglot.docx"]), ["pdf"]);
    assert.deepEqual(await resolveQueuedDocumentFormats(paths["word.docx"]), ALL_FORMATS);
    assert.equal((await loadQueuedDocument(paths["word.docx"])).format, "docx");
    assert.equal((await loadQueuedDocument(paths["doc.pdf"])).format, "pdf");

    // The polyglot goes to pdf.js, which refuses it as it would have before
    // Office formats existed; mammoth never sees it.
    const direct = await loadPdfPages(paths["polyglot.docx"]).catch((error) => error);
    const queued = await loadQueuedDocument(paths["polyglot.docx"]).catch((error) => error);

    assert.ok(direct instanceof Error);
    assert.equal(queued?.message, direct.message);
    assert.equal(queued instanceof DocumentFormatError, false);
  });
});

test("RAG_OFFICE_MAX_TEXT_CHARS applies to every Office loader", async () => {
  await withFiles({ "book.xlsx": XLSX_BYTES, "deck.pptx": PPTX, "word.docx": DOCX }, async (paths) => {
    process.env.RAG_OFFICE_MAX_TEXT_CHARS = "10";

    try {
      for (const name of ["book.xlsx", "deck.pptx", "word.docx"]) {
        await assert.rejects(loadDocumentPages(paths[name]), { code: CODES.archiveTooLarge, status: 413 }, name);
      }
    } finally {
      delete process.env.RAG_OFFICE_MAX_TEXT_CHARS;
    }
  });
});

test("a reader that breaks the page contract fails the load", async () => {
  await withFiles({ "deck.pptx": PPTX }, async ({ "deck.pptx": filePath }) => {
    for (const pages of [[{ pageNumber: 0, text: "x" }], [{ pageNumber: 1.5, text: "x" }], [{ pageNumber: 1 }], "nope"]) {
      await assert.rejects(
        loadDocumentPages(filePath, {
          importPptxReader: async () => ({ PPTX_EXTRACTOR_VERSION: 1, extractPptxPages: () => pages }),
        }),
        /page contract/
      );
    }
  });
});

const pptxReaderPath = fileURLToPath(new URL("../rag/office/pptx-loader.js", import.meta.url));

test("a .pptx loads through the real PPTX reader", { skip: !existsSync(pptxReaderPath) && "rag/office/pptx-loader.js is not there yet" }, async () => {
  const { PPTX_EXTRACTOR_VERSION } = await import("../rag/office/pptx-loader.js");

  await withFiles({ "deck.pptx": PPTX }, async ({ "deck.pptx": filePath }) => {
    const loaded = await loadDocumentPages(filePath);

    assert.equal(loaded.format, "pptx");
    assert.deepStrictEqual(loaded.parse, { extractor: "ooxml-pptx", extractorVersion: PPTX_EXTRACTOR_VERSION, format: "pptx" });
    assert.ok(loaded.pages.length > 0);

    for (const page of loaded.pages) {
      assert.ok(Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0);
      assert.equal(page.locationUnit, "slide");
    }

    // The hidden second slide gives no page; the third keeps its number.
    assert.deepEqual(
      loaded.pages.map((page) => page.pageNumber),
      [1, 3]
    );
    assert.deepStrictEqual(await loadDocumentPages(filePath), loaded);
  });
});

test("the formats a read accepts, and the refusals it passes on", async () => {
  const bomb = buildZip([{ data: Buffer.alloc(4 * 1024 * 1024), name: "bomb.bin" }]);

  await withFiles(
    { bomb, "book.xlsx": XLSX_BYTES, "doc.pdf": PDF, "legacy.doc": buildOle2Bytes(), "text.txt": Buffer.from("plain text"), "word.docx": DOCX },
    async (paths) => {
      await assert.rejects(loadDocumentPages(paths["word.docx"], { formats: ["pdf", "xlsx"] }), {
        code: CODES.disabled,
        status: 415,
      });
      await assert.rejects(loadDocumentPages(paths["doc.pdf"], { formats: ["docx"] }), { code: CODES.disabled, status: 415 });
      await assert.rejects(loadDocumentPages(paths["legacy.doc"]), { code: CODES.legacyOffice, status: 415 });
      await assert.rejects(loadDocumentPages(paths["text.txt"]), { code: CODES.unsupported, status: 400 });
      await assert.rejects(loadDocumentPages(paths.bomb), { code: CODES.archiveTooLarge, status: 413 });

      // The setting gates new uploads only: the loader's default is every format.
      process.env.RAG_DOCUMENT_FORMATS = "pdf";
      assert.equal((await loadDocumentPages(paths["book.xlsx"])).format, "xlsx");

      await assert.rejects(loadDocumentPages(paths["doc.pdf"], { formats: [] }), TypeError);
    }
  );
});

for (const encryption of ["off", "on"]) {
  test(`Office working files load with TENANT_ENCRYPTION=${encryption}`, async () => {
    process.env.TENANT_ENCRYPTION = encryption;

    await withFiles({ "book.xlsx": XLSX_BYTES, "word.docx": DOCX }, async (paths) => {
      assert.deepStrictEqual((await loadDocumentPages(paths["word.docx"])).pages, await extractDocxPages(DOCX));
      assert.deepStrictEqual((await loadDocumentPages(paths["book.xlsx"])).pages, await extractXlsxPages(XLSX_BYTES));
    });
  });
}

test("a working file another process wrote is no supported document", async () => {
  process.env.TENANT_ENCRYPTION = "on";

  const directory = await mkdtemp(path.join(os.tmpdir(), "document-loader-foreign-"));

  try {
    const filePath = path.join(directory, "foreign");

    await writeFile(filePath, Buffer.concat([WORKING_FILE_MAGIC, Buffer.from([1]), Buffer.alloc(64, 7)]));
    await assert.rejects(loadDocumentPages(filePath), { code: CODES.unsupported, status: 400 });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("loading twice gives the same result", async () => {
  await withFiles({ "book.xlsx": XLSX_BYTES, "word.docx": DOCX }, async (paths) => {
    assert.deepStrictEqual(await loadDocumentPages(paths["word.docx"]), await loadDocumentPages(paths["word.docx"]));
    assert.deepStrictEqual(await loadDocumentPages(paths["book.xlsx"]), await loadDocumentPages(paths["book.xlsx"]));
  });
});

test("isPptxReaderPart", () => {
  for (const name of [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/slides/_rels/slide1.xml.rels",
    "PPT/Slides/Slide1.XML",
  ]) {
    assert.equal(isPptxReaderPart(name), true, name);
  }

  for (const name of ["ppt/media/image1.png", "docProps/core.xml", "word/document.xml", "word/_rels/.rels", "ppt"]) {
    assert.equal(isPptxReaderPart(name), false, name);
  }
});
