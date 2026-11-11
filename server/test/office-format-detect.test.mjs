// Format detection (rag/document-formats.js) and its settings (rag/config.js
// RAG_DOCUMENT_FORMATS, RAG_OFFICE_*, RAG_XLSX_MAX_CELLS): every rule of the
// Office formats contract, the PDF rule unchanged when only PDF is enabled
// (compared with routes/helpers.js hasPdfMagicBytes on the same bytes), and
// the refusals with their status and code.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as config from "../rag/config.js";
import {
  DOCUMENT_FORMAT_ERROR_CODES,
  DOCUMENT_MIME_TYPES,
  DocumentFormatError,
  NOT_A_VALID_PDF_MESSAGE,
  UNSUPPORTED_DOCUMENT_MESSAGE,
  createNoExtractableTextError,
  detectDocumentFormat,
  detectDocumentFormatAtPath,
  getDocumentFormatForFileName,
  getDocumentFormatForMimeType,
  inspectDocumentBytes,
  normalizeDocumentFormats,
  resolveStoredDocumentFormats,
} from "../rag/document-formats.js";
import { TENANT_ENVELOPE_MAGIC } from "../rag/tenant-encryption.js";
import { WORKING_FILE_MAGIC, writeWorkingFile } from "../rag/working-files.js";
import { hasPdfMagicBytes } from "../routes/helpers.js";
import {
  MAIN_CONTENT_TYPES,
  PDF_HEADER_BYTES,
  VARIANT_CONTENT_TYPES,
  addDoctype,
  bombEntry,
  buildDocx,
  buildOle2Bytes,
  buildPptx,
  buildXlsx,
  buildZip,
  docxEntries,
  fillerEntries,
  removePart,
  replacePart,
  unsafeNameEntry,
} from "./office-fixture-builder.mjs";

const ALL = ["pdf", "docx", "pptx", "xlsx"];
const PDF_ONLY = ["pdf"];
const CODES = DOCUMENT_FORMAT_ERROR_CODES;

const SETTINGS = [
  "RAG_DOCUMENT_FORMATS",
  "RAG_OFFICE_MAX_UNCOMPRESSED_BYTES",
  "RAG_OFFICE_MAX_ZIP_ENTRIES",
  "RAG_OFFICE_MAX_COMPRESSION_RATIO",
  "RAG_OFFICE_MAX_XML_BYTES",
  "RAG_OFFICE_MAX_TEXT_CHARS",
  "RAG_XLSX_MAX_CELLS",
  "TENANT_ENCRYPTION",
];
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

const PDF = Buffer.concat([PDF_HEADER_BYTES, Buffer.from("trailer\n%%EOF\n")]);
const DOCX = buildDocx({ blocks: [{ text: "Hello" }] });
const PPTX = buildPptx({ slides: [{ title: "Hello" }] });
const XLSX_BYTES = buildXlsx({ sheets: [{ name: "Data", rows: [["Hello", "World"]] }] });
// A stored entry whose text begins "%PDF" lands inside the first kilobyte.
const ZIP_WITH_PDF_MARKER = buildZip([{ data: "%PDF-1.4 inside a zip entry", method: "store", name: "a.txt" }]);

const expectRefusal = async (promise, { code, status, message }) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DocumentFormatError, `a DocumentFormatError, got ${error?.stack ?? error}`);
    assert.equal(error.status, status);
    assert.equal(error.expose, true);

    if (code === null) {
      assert.equal(Object.hasOwn(error, "code"), false, "the old refusal carries no code key");
    } else {
      assert.equal(error.code, code);
    }

    if (message !== undefined) {
      assert.equal(error.message, message);
    }

    return true;
  });
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("RAG_DOCUMENT_FORMATS: blank is every format; a list is trimmed, lower-cased, deduplicated and canonical", () => {
  for (const value of [undefined, "", "   ", "\t"]) {
    if (value === undefined) {
      delete process.env.RAG_DOCUMENT_FORMATS;
    } else {
      process.env.RAG_DOCUMENT_FORMATS = value;
    }

    assert.deepEqual(config.getDocumentFormats(), ALL);
  }

  process.env.RAG_DOCUMENT_FORMATS = " XLSX , pdf,Docx,pdf ";
  assert.deepEqual(config.getDocumentFormats(), ["pdf", "docx", "xlsx"]);
  process.env.RAG_DOCUMENT_FORMATS = "pdf";
  assert.deepEqual(config.getDocumentFormats(), ["pdf"]);
  process.env.RAG_DOCUMENT_FORMATS = "pptx,";
  assert.deepEqual(config.getDocumentFormats(), ["pptx"]);
});

test("RAG_DOCUMENT_FORMATS: an unknown entry or a list naming nothing refuses with RAG_DOCUMENT_FORMATS_INVALID", () => {
  for (const value of ["pdf,doc", "xls", ", ,", "pdf;docx", "odt"]) {
    process.env.RAG_DOCUMENT_FORMATS = value;
    assert.throws(
      () => config.getDocumentFormats(),
      (error) =>
        error.code === "RAG_DOCUMENT_FORMATS_INVALID" &&
        error.message.includes("RAG_DOCUMENT_FORMATS") &&
        error.message.includes(JSON.stringify(value)),
      value
    );
    assert.throws(() => config.assertDocumentFormatSettings(), { code: "RAG_DOCUMENT_FORMATS_INVALID" });
  }
});

const LIMITS = [
  ["RAG_OFFICE_MAX_UNCOMPRESSED_BYTES", () => config.getOfficeMaxUncompressedBytes(), 268_435_456, true],
  ["RAG_OFFICE_MAX_ZIP_ENTRIES", () => config.getOfficeMaxZipEntries(), 10_000, true],
  ["RAG_OFFICE_MAX_COMPRESSION_RATIO", () => config.getOfficeMaxCompressionRatio(), 200, false],
  ["RAG_XLSX_MAX_CELLS", () => config.getXlsxMaxCells(), 2_000_000, true],
  ["RAG_OFFICE_MAX_XML_BYTES", () => config.getOfficeMaxXmlBytes(), 16_777_216, true],
  ["RAG_OFFICE_MAX_TEXT_CHARS", () => config.getOfficeMaxTextChars(), 67_108_864, true],
];

test("the Office limits: blank is the default, a valid value is used, anything else refuses with RAG_OFFICE_LIMIT_INVALID", () => {
  for (const [name, read, fallback, integer] of LIMITS) {
    delete process.env[name];
    assert.equal(read(), fallback, `${name} default`);

    for (const blank of ["", "  ", "\t"]) {
      process.env[name] = blank;
      assert.equal(read(), fallback, `${name}=${JSON.stringify(blank)}`);
    }

    process.env[name] = " 42 ";
    assert.equal(read(), 42);
    process.env[name] = "1";
    assert.equal(read(), 1);

    const invalid = ["0", "-1", "abc", "Infinity", "NaN", ...(integer ? ["1.5", "9007199254740993"] : ["0.5"])];

    for (const value of invalid) {
      process.env[name] = value;
      assert.throws(read, (error) => error.code === "RAG_OFFICE_LIMIT_INVALID" && error.message.includes(name), `${name}=${value}`);
      assert.throws(() => config.assertDocumentFormatSettings(), { code: "RAG_OFFICE_LIMIT_INVALID" });
    }

    delete process.env[name];
  }

  process.env.RAG_OFFICE_MAX_COMPRESSION_RATIO = "12.5";
  assert.equal(config.getOfficeMaxCompressionRatio(), 12.5);
  assert.doesNotThrow(() => config.assertDocumentFormatSettings());
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("format ids, MIME types and names", () => {
  assert.deepEqual(config.DOCUMENT_FORMATS, ALL);
  assert.deepEqual(DOCUMENT_MIME_TYPES, {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  for (const format of ALL) {
    assert.equal(getDocumentFormatForMimeType(DOCUMENT_MIME_TYPES[format]), format);
    assert.equal(getDocumentFormatForMimeType(DOCUMENT_MIME_TYPES[format].toUpperCase()), format);
    assert.equal(getDocumentFormatForFileName(`Report.${format.toUpperCase()}`), format);
  }

  assert.equal(getDocumentFormatForMimeType(null), null);
  assert.equal(getDocumentFormatForMimeType("text/plain"), null);
  assert.equal(getDocumentFormatForFileName("archive.doc"), null);
  assert.equal(getDocumentFormatForFileName("no-extension"), null);
  assert.equal(getDocumentFormatForFileName("x.docx.zip"), null);

  // A stored PDF (or a document without a MIME type) re-parses as PDF alone.
  assert.deepEqual(resolveStoredDocumentFormats(undefined), ["pdf"]);
  assert.deepEqual(resolveStoredDocumentFormats("application/pdf"), ["pdf"]);
  assert.deepEqual(resolveStoredDocumentFormats("text/plain"), ["pdf"]);
  assert.deepEqual(resolveStoredDocumentFormats(DOCUMENT_MIME_TYPES.xlsx), ["xlsx"]);

  assert.deepEqual(normalizeDocumentFormats(["xlsx", "pdf", "xlsx"]), ["pdf", "xlsx"]);

  for (const bad of [[], ["doc"], null, "pdf,docx"]) {
    assert.throws(() => normalizeDocumentFormats(bad), TypeError);
  }
});

test("the 422 for pages without text says PDF for PDF and document for the Office formats", () => {
  const pdfError = createNoExtractableTextError("pdf");

  assert.equal(pdfError.message, "No extractable text was found in the uploaded PDF.");
  assert.equal(pdfError.status, 422);
  assert.deepEqual(Object.keys(pdfError), ["status"]);
  assert.equal(createNoExtractableTextError().message, pdfError.message);

  for (const format of ["docx", "pptx", "xlsx"]) {
    const error = createNoExtractableTextError(format);

    assert.equal(error.message, "No extractable text was found in the uploaded document.");
    assert.equal(error.status, 422);
  }
});

// ---------------------------------------------------------------------------
// RAG_DOCUMENT_FORMATS=pdf: the old check, exactly
// ---------------------------------------------------------------------------

test("PDF alone: '%PDF' within the first 1024 bytes is a PDF, anything else the old 400 without a code", async () => {
  assert.deepEqual(await detectDocumentFormat(PDF, { formats: PDF_ONLY }), { format: "pdf", mimeType: "application/pdf" });

  // Junk before the header, within the 1024-byte window.
  const late = Buffer.concat([Buffer.alloc(1000, 0x20), PDF]);
  const tooLate = Buffer.concat([Buffer.alloc(1021, 0x20), PDF]);

  assert.equal((await detectDocumentFormat(late, { formats: PDF_ONLY })).format, "pdf");

  for (const bytes of [tooLate, Buffer.from("plain text"), Buffer.alloc(0), DOCX, PPTX, XLSX_BYTES, buildOle2Bytes()]) {
    await expectRefusal(detectDocumentFormat(bytes, { formats: PDF_ONLY }), {
      code: null,
      message: NOT_A_VALID_PDF_MESSAGE,
      status: 400,
    });
  }
});

test("PDF alone: a ZIP or OLE2 file with '%PDF' in its first kilobyte is still taken as a PDF", async () => {
  assert.ok(ZIP_WITH_PDF_MARKER.subarray(0, 1024).includes("%PDF"));
  assert.equal((await detectDocumentFormat(ZIP_WITH_PDF_MARKER, { formats: PDF_ONLY })).format, "pdf");
  assert.equal((await detectDocumentFormat(buildOle2Bytes({ pdfMarker: true }), { formats: PDF_ONLY })).format, "pdf");
});

test("PDF alone: plaintext beginning with a reserved magic is refused like any non-PDF", async () => {
  for (const magic of [TENANT_ENVELOPE_MAGIC, WORKING_FILE_MAGIC]) {
    const bytes = Buffer.concat([magic, Buffer.from([1]), PDF]);

    assert.ok(bytes.subarray(0, 1024).includes("%PDF"));
    await expectRefusal(detectDocumentFormat(bytes, { formats: PDF_ONLY }), {
      code: null,
      message: NOT_A_VALID_PDF_MESSAGE,
      status: 400,
    });
  }
});

// ---------------------------------------------------------------------------
// Office formats enabled
// ---------------------------------------------------------------------------

test("the three OOXML formats are told apart by their main part's content type", async () => {
  assert.deepEqual(await detectDocumentFormat(DOCX, { formats: ALL }), { format: "docx", mimeType: DOCUMENT_MIME_TYPES.docx });
  assert.deepEqual(await detectDocumentFormat(PPTX, { formats: ALL }), { format: "pptx", mimeType: DOCUMENT_MIME_TYPES.pptx });
  assert.deepEqual(await detectDocumentFormat(XLSX_BYTES, { formats: ALL }), {
    format: "xlsx",
    mimeType: DOCUMENT_MIME_TYPES.xlsx,
  });
  assert.deepEqual(await detectDocumentFormat(PDF, { formats: ALL }), { format: "pdf", mimeType: "application/pdf" });

  // The file name plays no part, and the default is the setting (all four).
  delete process.env.RAG_DOCUMENT_FORMATS;
  assert.equal((await detectDocumentFormat(DOCX)).format, "docx");
});

test("a ZIP with '%PDF' in its first kilobyte is never a PDF once an Office format is enabled", async () => {
  await expectRefusal(detectDocumentFormat(ZIP_WITH_PDF_MARKER, { formats: ALL }), {
    code: CODES.unsupported,
    message: UNSUPPORTED_DOCUMENT_MESSAGE,
    status: 400,
  });

  // Even with docx the only Office format enabled.
  await expectRefusal(detectDocumentFormat(ZIP_WITH_PDF_MARKER, { formats: ["pdf", "docx"] }), {
    code: CODES.unsupported,
    status: 400,
  });
});

test("OLE2 (legacy or password-protected Office) is 415 DOCUMENT_FORMAT_LEGACY_OFFICE, '%PDF' or not", async () => {
  for (const bytes of [buildOle2Bytes(), buildOle2Bytes({ pdfMarker: true })]) {
    await expectRefusal(detectDocumentFormat(bytes, { formats: ALL }), {
      code: CODES.legacyOffice,
      message:
        "Legacy or password-protected Office files are not supported; save the file as .docx, .pptx or .xlsx without a password.",
      status: 415,
    });
  }
});

test("macro-enabled files, templates, slide shows and other Office kinds are 415 DOCUMENT_FORMAT_OFFICE_VARIANT", async () => {
  const variants = [
    buildDocx({ blocks: [{ text: "x" }], mainContentType: VARIANT_CONTENT_TYPES.docm }),
    buildDocx({ blocks: [{ text: "x" }], mainContentType: VARIANT_CONTENT_TYPES.dotx }),
    buildPptx({ mainContentType: VARIANT_CONTENT_TYPES.pptm, slides: [{ title: "x" }] }),
    buildPptx({ mainContentType: VARIANT_CONTENT_TYPES.potx, slides: [{ title: "x" }] }),
    buildPptx({ mainContentType: VARIANT_CONTENT_TYPES.ppsx, slides: [{ title: "x" }] }),
    buildXlsx({ mainContentType: VARIANT_CONTENT_TYPES.xlsm, sheets: [{ name: "A", rows: [["x"]] }] }),
    buildXlsx({ mainContentType: VARIANT_CONTENT_TYPES.xltx, sheets: [{ name: "A", rows: [["x"]] }] }),
    buildXlsx({ mainContentType: VARIANT_CONTENT_TYPES.xlsb, sheets: [{ name: "A", rows: [["x"]] }] }),
    buildDocx({ blocks: [{ text: "x" }], mainContentType: VARIANT_CONTENT_TYPES.vsdx }),
  ];

  for (const bytes of variants) {
    await expectRefusal(detectDocumentFormat(bytes, { formats: ALL }), { code: CODES.officeVariant, status: 415 });
  }
});

test("a format the setting leaves out is 415 DOCUMENT_FORMAT_DISABLED, PDF included", async () => {
  await expectRefusal(detectDocumentFormat(XLSX_BYTES, { formats: ["pdf", "docx"] }), {
    code: CODES.disabled,
    status: 415,
  });
  await expectRefusal(detectDocumentFormat(PDF, { formats: ["docx", "pptx", "xlsx"] }), {
    code: CODES.disabled,
    status: 415,
  });

  process.env.RAG_DOCUMENT_FORMATS = "pdf,pptx";
  await expectRefusal(detectDocumentFormat(DOCX), { code: CODES.disabled, status: 415 });
  assert.equal((await detectDocumentFormat(PPTX)).format, "pptx");

  // A broken setting fails the check itself.
  process.env.RAG_DOCUMENT_FORMATS = "pdf,doc";
  await assert.rejects(detectDocumentFormat(PDF), { code: "RAG_DOCUMENT_FORMATS_INVALID" });
});

test("bytes of no enabled format are 400 DOCUMENT_FORMAT_UNSUPPORTED", async () => {
  const plainZip = buildZip([{ data: "hello", name: "readme.txt" }]);
  const odt = buildZip([
    { data: "application/vnd.oasis.opendocument.text", method: "store", name: "mimetype" },
    { data: "<office:document-content/>", name: "content.xml" },
  ]);
  // An OPC package that is not an Office document (no officeDocument relationship).
  const opc = buildZip([
    {
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      name: "[Content_Types].xml",
    },
    { data: "<a/>", name: "data.xml" },
  ]);

  for (const bytes of [Buffer.from("plain text"), Buffer.alloc(0), plainZip, odt, opc, Buffer.from("PK\u0005\u0006")]) {
    await expectRefusal(detectDocumentFormat(bytes, { formats: ALL }), {
      code: CODES.unsupported,
      message: UNSUPPORTED_DOCUMENT_MESSAGE,
      status: 400,
    });
  }

  // Reserved magics are refused first, even before a PDF header.
  for (const magic of [TENANT_ENVELOPE_MAGIC, WORKING_FILE_MAGIC]) {
    await expectRefusal(detectDocumentFormat(Buffer.concat([magic, Buffer.from([1]), PDF]), { formats: ALL }), {
      code: CODES.unsupported,
      status: 400,
    });
  }
});

test("a broken OOXML package is 400 DOCUMENT_ARCHIVE_INVALID", async () => {
  const docxParts = docxEntries({ blocks: [{ text: "x" }] });
  const cases = {
    // The relationship names word/document.xml, which is not there.
    missingMainPart: buildZip(removePart(docxParts, "word/document.xml")),
    // A package with a main content type but no officeDocument relationship.
    noMainRelationship: buildZip(removePart(docxParts, "_rels/.rels")),
    // The main part has only the generic xml type.
    genericMainType: buildZip(
      replacePart(
        docxParts,
        "[Content_Types].xml",
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'
      )
    ),
    // Content types without a usable XML document.
    unreadableContentTypes: buildZip(replacePart(docxParts, "[Content_Types].xml", "<Types><Default")),
    // Two main parts.
    twoMainParts: buildZip(
      replacePart(
        docxParts,
        "_rels/.rels",
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/other.xml"/>' +
          "</Relationships>"
      )
    ),
  };

  for (const [label, bytes] of Object.entries(cases)) {
    await expectRefusal(detectDocumentFormat(bytes, { formats: ALL }), { code: CODES.archiveInvalid, status: 400 }).catch(
      (error) => {
        error.message = `${label}: ${error.message}`;
        throw error;
      }
    );
  }
});

test("the archive guard's refusals surface from detection, and its messages quote nothing of the file", async () => {
  const bomb = buildDocx({
    blocks: [{ text: "x" }],
    transform: (entries) => [...entries, bombEntry({ bytes: 4 * 1024 * 1024, name: "word/media/secret-name.bin" })],
  });
  const lyingBomb = buildPptx({
    slides: [{ title: "x" }],
    transform: (entries) => [...entries, bombEntry({ declaredUncompressedSize: 64, name: "ppt/media/secret.bin" })],
  });
  const doctype = buildDocx({
    blocks: [{ text: "Secret paragraph" }],
    transform: (entries) => addDoctype(entries, "word/document.xml"),
  });
  const crowded = buildXlsx({ sheets: [{ name: "A", rows: [["x"]] }], transform: (entries) => [...entries, ...fillerEntries(20)] });
  const escaping = buildDocx({ blocks: [{ text: "x" }], transform: (entries) => [...entries, unsafeNameEntry("../secret.xml")] });

  await expectRefusal(detectDocumentFormat(bomb, { formats: ALL }), { code: CODES.archiveTooLarge, status: 413 });
  await expectRefusal(detectDocumentFormat(lyingBomb, { formats: ALL }), { code: CODES.archiveTooLarge, status: 413 });
  await expectRefusal(detectDocumentFormat(doctype, { formats: ALL }), { code: CODES.archiveInvalid, status: 400 });
  await expectRefusal(detectDocumentFormat(crowded, { formats: ALL, limits: { maxEntries: 20 } }), {
    code: CODES.archiveTooLarge,
    status: 413,
  });
  await expectRefusal(detectDocumentFormat(escaping, { formats: ALL }), { code: CODES.archiveInvalid, status: 400 });

  for (const bytes of [bomb, lyingBomb, doctype, escaping]) {
    const error = await detectDocumentFormat(bytes, { formats: ALL }).catch((caught) => caught);

    assert.doesNotMatch(error.message, /secret|word\/|document\.xml|Secret paragraph/i);
  }

  // Limits passed in replace the settings for one call.
  await expectRefusal(detectDocumentFormat(DOCX, { formats: ALL, limits: { maxEntries: 2 } }), {
    code: CODES.archiveTooLarge,
    status: 413,
  });
});

test("RAG_OFFICE_MAX_XML_BYTES at the upload check: a Word document's XML parts together, any one part of a deck", async () => {
  const xmlTotal = async (bytes) => {
    const { archive } = await inspectDocumentBytes(bytes, { formats: ALL });
    const sizes = [...archive.partSizes].filter(([name]) => /\.(?:xml|rels)$/.test(name)).map(([, size]) => size);

    return { largest: Math.max(...sizes), total: sizes.reduce((sum, size) => sum + size, 0) };
  };
  const docx = await xmlTotal(DOCX);
  const pptx = await xmlTotal(PPTX);

  assert.deepEqual(await detectDocumentFormat(DOCX, { formats: ALL, limits: { maxXmlBytes: docx.total } }), {
    format: "docx",
    mimeType: DOCUMENT_MIME_TYPES.docx,
  });
  await expectRefusal(detectDocumentFormat(DOCX, { formats: ALL, limits: { maxXmlBytes: docx.total - 1 } }), {
    code: CODES.archiveTooLarge,
    message: `The document is too large to read: its XML parts inflate to more than ${docx.total - 1} bytes together (RAG_OFFICE_MAX_XML_BYTES).`,
    status: 413,
  });

  // A deck's parts count one by one: their total may pass the limit.
  assert.ok(pptx.total > pptx.largest);
  assert.equal((await detectDocumentFormat(PPTX, { formats: ALL, limits: { maxXmlBytes: pptx.largest } })).format, "pptx");
  await expectRefusal(detectDocumentFormat(PPTX, { formats: ALL, limits: { maxXmlBytes: pptx.largest - 1 } }), {
    code: CODES.archiveTooLarge,
    message: `The document is too large to read: an XML part inflates to more than ${pptx.largest - 1} bytes (RAG_OFFICE_MAX_XML_BYTES).`,
    status: 413,
  });

  // A workbook's parts are bounded where its worksheets are known (the XLSX
  // loader), not here.
  assert.equal((await detectDocumentFormat(XLSX_BYTES, { formats: ALL, limits: { maxXmlBytes: 1 } })).format, "xlsx");

  // From the setting.
  process.env.RAG_OFFICE_MAX_XML_BYTES = String(docx.total - 1);
  await expectRefusal(detectDocumentFormat(DOCX, { formats: ALL }), { code: CODES.archiveTooLarge, status: 413 });
});

test("[Content_Types].xml and _rels/.rels are capped before the guard parses them", async () => {
  // Stored, so the ratio cap stays out of it.
  const padded = (name, bytes) =>
    buildDocx({
      blocks: [{ text: "x" }],
      transform: (entries) =>
        entries.map((entry) =>
          entry.name === name
            ? { ...entry, data: `${String(entry.data)}<!-- ${"p".repeat(bytes)} -->`, method: "store" }
            : entry
        ),
    });

  for (const name of ["[Content_Types].xml", "_rels/.rels"]) {
    await expectRefusal(detectDocumentFormat(padded(name, 4 * 1024 * 1024 + 1), { formats: ALL }), {
      code: CODES.archiveTooLarge,
      status: 413,
    });
    assert.equal((await detectDocumentFormat(padded(name, 64 * 1024), { formats: ALL })).format, "docx");
  }
});

test("inspectDocumentBytes hands back the guard's scan of an Office file, null for a PDF", async () => {
  const pdf = await inspectDocumentBytes(PDF, { formats: ALL });

  assert.equal(pdf.archive, null);

  const pptx = await inspectDocumentBytes(PPTX, { formats: ALL, keep: (name) => name === "ppt/presentation.xml" });

  assert.equal(pptx.format, "pptx");
  assert.ok(pptx.archive.parts.has("ppt/presentation.xml"));
  assert.ok(pptx.archive.parts.has("[Content_Types].xml"));
  assert.equal(pptx.archive.package.mainPart.name, "ppt/presentation.xml");
});

test("the main content types are the contract's", () => {
  assert.equal(MAIN_CONTENT_TYPES.docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
  assert.equal(MAIN_CONTENT_TYPES.pptx, "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
  assert.equal(MAIN_CONTENT_TYPES.xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml");
});

// ---------------------------------------------------------------------------
// The path variant, against hasPdfMagicBytes
// ---------------------------------------------------------------------------

const withTempDirectory = async (callback) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "office-format-detect-"));

  try {
    return await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const SAMPLES = {
  docx: DOCX,
  envelopePrefixed: Buffer.concat([TENANT_ENVELOPE_MAGIC, Buffer.from([1]), PDF]),
  late: Buffer.concat([Buffer.alloc(1000, 0x20), PDF]),
  ole2: buildOle2Bytes(),
  ole2Pdf: buildOle2Bytes({ pdfMarker: true }),
  pdf: PDF,
  text: Buffer.from("plain text"),
  tooLate: Buffer.concat([Buffer.alloc(1021, 0x20), PDF]),
  workingPrefixed: Buffer.concat([WORKING_FILE_MAGIC, Buffer.from([1]), PDF]),
  zipPdf: ZIP_WITH_PDF_MARKER,
};

for (const encryption of ["off", "on"]) {
  test(`with only PDF enabled the path check agrees with hasPdfMagicBytes (TENANT_ENCRYPTION=${encryption})`, async () => {
    process.env.TENANT_ENCRYPTION = encryption;

    await withTempDirectory(async (directory) => {
      for (const [name, bytes] of Object.entries(SAMPLES)) {
        const filePath = path.join(directory, name);

        // As multer stores an upload: a working file (encrypted when on).
        await writeWorkingFile(filePath, bytes);

        const legacy = await hasPdfMagicBytes(filePath);
        const detected = await detectDocumentFormatAtPath(filePath, { formats: PDF_ONLY }).then(
          (result) => result.format === "pdf",
          (error) => {
            assert.equal(error.message, NOT_A_VALID_PDF_MESSAGE, name);
            assert.equal(error.status, 400, name);
            assert.equal(Object.hasOwn(error, "code"), false, name);
            return false;
          }
        );

        assert.equal(detected, legacy, `${name}: hasPdfMagicBytes says ${legacy}`);
      }
    });
  });

  test(`with Office formats enabled the path check reads whole ZIPs and decrypts working files (TENANT_ENCRYPTION=${encryption})`, async () => {
    process.env.TENANT_ENCRYPTION = encryption;

    await withTempDirectory(async (directory) => {
      const check = async (name, bytes) => {
        const filePath = path.join(directory, name);

        await writeWorkingFile(filePath, bytes);
        return detectDocumentFormatAtPath(filePath, { formats: ALL });
      };

      assert.equal((await check("a.pdf", PDF)).format, "pdf");
      assert.equal((await check("a.docx", DOCX)).format, "docx");
      assert.equal((await check("a.pptx", PPTX)).format, "pptx");
      assert.equal((await check("a.xlsx", XLSX_BYTES)).format, "xlsx");
      await expectRefusal(check("zip-pdf", ZIP_WITH_PDF_MARKER), { code: CODES.unsupported, status: 400 });
      await expectRefusal(check("ole2", buildOle2Bytes({ pdfMarker: true })), { code: CODES.legacyOffice, status: 415 });
      await expectRefusal(check("envelope", SAMPLES.envelopePrefixed), { code: CODES.unsupported, status: 400 });
      await expectRefusal(check("working", SAMPLES.workingPrefixed), { code: CODES.unsupported, status: 400 });
    });
  });
}

test("a working file another process wrote is no supported document, not a 500", async () => {
  process.env.TENANT_ENCRYPTION = "on";

  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "foreign");

    // The working-file framing with a ciphertext this process's key did not write.
    await writeFile(filePath, Buffer.concat([WORKING_FILE_MAGIC, Buffer.from([1]), Buffer.alloc(64, 7)]));

    await expectRefusal(detectDocumentFormatAtPath(filePath, { formats: PDF_ONLY }), {
      code: null,
      message: NOT_A_VALID_PDF_MESSAGE,
      status: 400,
    });
    await expectRefusal(detectDocumentFormatAtPath(filePath, { formats: ALL }), {
      code: CODES.unsupported,
      status: 400,
    });
  });
});
