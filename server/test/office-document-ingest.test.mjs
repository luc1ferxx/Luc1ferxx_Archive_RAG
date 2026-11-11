// Word, PowerPoint and Excel documents through every entry point and parse
// site of the ingest (the parsing layer itself is office-*.test.mjs and
// document-loader.test.mjs):
//
// * the chunk profile of an Office document names its parse, a PDF's stays
//   exactly what it was; chunks carry their page's location (slide, sheet,
//   section) and nothing else changes in them;
// * POST /upload, the chunked upload and PUT /documents/:docId check the
//   bytes, answer every refusal with its status and code, and hand a
//   synchronous ingest the format they found; the real ingest registers the
//   document's MIME type, and the download sends it as an attachment;
// * the async enqueue runs an Office upload through the staged pipeline to a
//   document (parse metadata, chunk profile, MIME type through the stage
//   outputs), and the one-step worker path reads any format;
// * the trash restore re-parses a stored document as the format it was
//   registered as;
// * RAG_DOCUMENT_FORMATS=pdf restores every PDF-only check, message and stored
//   file name, and an invalid setting refuses the start.
//
// The index-version build and vector:reindex re-parse are in
// vector-store-pgvector-version-lifecycle.test.mjs and vector-reindex.test.mjs.
import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp } from "../app.js";
import { createAppServices } from "../app-services.js";
import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { createFileFeedbackStore } from "../feedback.js";
import { createAdminAuditService, createInMemoryAdminAuditStore } from "../rag/admin-audit.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import {
  CHUNK_PROFILE_FIELDS,
  OFFICE_CHUNK_PROFILE_FIELDS,
  computeChunkProfileId,
  describeChunkProfile,
  describePdfParseSettings,
  readStoredChunkProfile,
  readStoredDocumentParse,
} from "../rag/chunk-profile.js";
import { chunkDocumentWithConfig } from "../rag/chunker.js";
import { CHUNK_STRATEGIES, DOCUMENT_FORMATS } from "../rag/config.js";
import { configureDocumentRegistryStore, resetDocumentRegistryStore } from "../rag/doc-registry.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import { DOCUMENT_MIME_TYPES } from "../rag/document-formats.js";
import { chunkDocumentPages, chunkStoredDocument, clearDocuments } from "../rag/index.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import {
  createIngestPipeline,
  decodeJsonOutput,
  decodeJsonOutputEnvelope,
  encodeEmbeddingsOutput,
  encodeJsonOutput,
} from "../rag/ingest-pipeline.js";
import { createIngestWorker } from "../rag/ingest-worker.js";
import { getMammothVersion } from "../rag/office/docx-loader.js";
import { PPTX_EXTRACTOR_VERSION } from "../rag/office/pptx-loader.js";
import { getSheetjsVersion } from "../rag/office/xlsx-loader.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import { resetVectorStore } from "../rag/vector-store.js";
import { createInMemoryWorkspaceArtifactStore } from "../rag/workspace-artifacts/index.js";
import { writeWorkingFile } from "../rag/working-files.js";
import { createStoredFileName, isAcceptedUploadFile } from "../routes/helpers.js";
import {
  VARIANT_CONTENT_TYPES,
  addDoctype,
  buildDocx,
  buildOle2Bytes,
  buildPptx,
  buildXlsx,
  fillerEntries,
} from "./office-fixture-builder.mjs";

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";
// The cases upload the same fixtures again; each must be ingested, not
// resolved to the earlier upload (deduplication is ingest-pipeline's suite).
process.env.RAG_INGEST_DEDUP = "false";

// Every case starts from the defaults of what decides a chunk profile and
// what an upload accepts (a file runs in a process of its own).
const SETTINGS = [
  "PDF_PARAGRAPH_DETECTION",
  "PDF_PARSER",
  "RAG_CHUNK_OVERLAP",
  "RAG_CHUNK_SIZE",
  "RAG_CHUNK_STRATEGY",
  "RAG_DOCUMENT_FORMATS",
  "RAG_INGEST_MODE",
  "RAG_OFFICE_MAX_COMPRESSION_RATIO",
  "RAG_OFFICE_MAX_UNCOMPRESSED_BYTES",
  "RAG_OFFICE_MAX_ZIP_ENTRIES",
  "RAG_XLSX_MAX_CELLS",
];

for (const name of SETTINGS) {
  delete process.env[name];
}

afterEach(() => {
  for (const name of SETTINGS) {
    delete process.env[name];
  }
});

const MIME = DOCUMENT_MIME_TYPES;
const OFFICE_PARSES = Object.freeze({
  docx: { extractor: "mammoth", extractorVersion: getMammothVersion(), format: "docx" },
  pptx: { extractor: "ooxml-pptx", extractorVersion: PPTX_EXTRACTOR_VERSION, format: "pptx" },
  xlsx: { extractor: "sheetjs", extractorVersion: getSheetjsVersion(), format: "xlsx" },
});
const UNSUPPORTED = Object.freeze({
  code: "DOCUMENT_FORMAT_UNSUPPORTED",
  error: "The uploaded file is not a supported document (PDF, Word .docx, PowerPoint .pptx or Excel .xlsx).",
});

const DOCX = buildDocx({
  blocks: [
    { heading: 1, text: "Retention" },
    { text: "Signed contracts are kept for seven years after they end." },
    { heading: 1, text: "Approval" },
    { text: "Two managers approve every change to the retention schedule." },
  ],
});
const PPTX = buildPptx({
  slides: [
    {
      notes: "Mention the pilot deadline.",
      shapes: [{ paragraphs: [{ bullet: true, text: "Budget approved for the pilot program." }], x: 1, y: 2 }],
      title: "Kickoff",
    },
    { hidden: true, title: "Backup" },
    { shapes: [{ table: [["Owner", "Due"], ["Ana", "May"]], x: 1, y: 2 }], title: "Plan" },
  ],
});
const XLSX = buildXlsx({
  sheets: [
    { name: "Budget", rows: [["Item", "Amount"], ["Travel", 1200], ["Hotels", 800]] },
    { name: "Secret", rows: [["hidden", "x"]], state: "hidden" },
    { name: "Staff", rows: [["Name", "Role"], ["Ana", "Lead"]] },
  ],
});
const PDF = buildTextPdf({ pages: [["The travel policy needs manager approval."]] });

// What each loader makes of the fixtures above: page numbers (a hidden slide
// or sheet keeps its number), units and labels.
const EXPECTED_LOCATIONS = Object.freeze({
  docx: [
    [1, "section", "Retention"],
    [2, "section", "Approval"],
  ],
  pptx: [
    [1, "slide", "Kickoff"],
    [3, "slide", "Plan"],
  ],
  xlsx: [
    [1, "sheet", "Budget"],
    [3, "sheet", "Staff"],
  ],
});

const officeProfileOf = (format) => describeChunkProfile(OFFICE_PARSES[format]);
const locationsOf = (chunks) =>
  [...new Map(chunks.map(({ metadata }) => [metadata.pageNumber, [metadata.pageNumber, metadata.locationUnit, metadata.locationLabel]])).values()];

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};
const silentLogger = { error() {}, log() {}, warn() {} };

// The real ingest over a local index and the file-backed registry, with a
// stand-in embedding model.
let tempRoot;
let originalRagDataDirectory;

const embedText = (text) => {
  const vector = new Array(8).fill(0);

  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    vector[word.length % 8] += 1;
  }

  return vector;
};

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "office-document-ingest-"));
  originalRagDataDirectory = getRagDataDirectory();
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  await resetDocumentRegistryStore();
  configureDocumentRegistryStore(createFileDocumentRegistryStore());
  resetVectorStore();
  configureOpenAIProvider({
    completeText: async () => "unused",
    embedQuery: async (query) => embedText(query),
    embedTexts: async (texts) => texts.map(embedText),
  });
});

after(async () => {
  await clearDocuments({ deleteFiles: false });
  resetVectorStore();
  await resetDocumentRegistryStore();
  resetOpenAIProvider();
  configureRagDataDirectory(originalRagDataDirectory);
  await rm(tempRoot, { force: true, recursive: true });
});

let appCount = 0;

// The real app and its real ingest (app-services.js ragService); only the
// conversation memories, which need PostgreSQL to start, are left out.
const startApp = async ({ ragService = {}, ...options } = {}) => {
  appCount += 1;

  const uploadsDirectory = path.join(tempRoot, `uploads-${appCount}`);
  const app = await createApp({
    adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore({ maxEvents: 100 }) }),
    agentRunStore: createInMemoryAgentRunStore(),
    executionPlannerAdapter: deterministicPlannerAdapter,
    feedbackStore: createFileFeedbackStore(),
    healthService: okHealthService,
    ingestJobStore: createInMemoryIngestJobStore(),
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService: {
      initializeLongMemory: async () => true,
      initializeSessionMemory: async () => true,
      ...ragService,
    },
    taskStore: createInMemoryTaskStore(),
    uploadSessionDirectory: path.join(tempRoot, `sessions-${appCount}`),
    uploadsDirectory,
    workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
    ...options,
  });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    app,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await app.locals?.stop?.();
    },
    uploadsDirectory,
  };
};

const sendDocument = (baseUrl, bytes, fileName, { method = "POST", requestPath = "/upload", type = "" } = {}) => {
  const form = new FormData();

  form.append("file", new Blob([bytes], { type }), fileName);
  return fetch(`${baseUrl}${requestPath}`, { body: form, method });
};

const readJson = async (response) => ({ body: await response.json(), status: response.status });

// The chunks the local index holds for a document.
const storedChunks = async (docId) =>
  JSON.parse(await readFile(path.join(getRagDataDirectory(), "vector-index.json"), "utf8")).filter(
    (entry) => entry.metadata.docId === docId
  );

const listFiles = async (directory) => {
  try {
    return (await readdir(directory, { recursive: true })).filter((name) => !name.startsWith("."));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const chunkedUpload = async (baseUrl, { bytes, fileId, fileName }) => {
  const init = await fetch(`${baseUrl}/upload/init`, {
    body: JSON.stringify({
      chunkSize: bytes.length,
      fileId,
      fileName,
      fileSize: bytes.length,
      lastModified: 0,
      totalChunks: 1,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (init.status !== 201) {
    return init;
  }

  const form = new FormData();

  form.append("fileId", fileId);
  form.append("chunkIndex", "0");
  form.append("totalChunks", "1");
  form.append("chunk", new Blob([bytes]), `${fileName}.part-0`);

  const chunk = await fetch(`${baseUrl}/upload/chunk`, { body: form, method: "POST" });

  assert.equal(chunk.status, 201);

  return fetch(`${baseUrl}/upload/complete`, {
    body: JSON.stringify({ fileId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
};

// ---------------------------------------------------------------------------
// Chunk profile and chunk metadata
// ---------------------------------------------------------------------------

test("an Office document's chunk profile names its parse; a PDF's is the one it always was", () => {
  const pdf = describeChunkProfile();

  // The default PDF profile and its id, as chunk-profile.test.mjs pins them.
  assert.deepEqual(Object.keys(pdf), ["id", ...CHUNK_PROFILE_FIELDS]);
  assert.equal(pdf.id, "06c55d11be63");

  for (const format of ["docx", "pptx", "xlsx"]) {
    const profile = officeProfileOf(format);

    assert.deepEqual(Object.keys(profile), ["id", ...OFFICE_CHUNK_PROFILE_FIELDS], format);
    assert.deepEqual(
      { ...profile, id: undefined },
      { chunkerVersion: 2, id: undefined, overlap: 180, size: 900, strategy: "structured", ...OFFICE_PARSES[format] }
    );
    assert.match(profile.id, /^[0-9a-f]{12}$/);
    assert.notEqual(profile.id, pdf.id);
    assert.ok(Object.isFrozen(profile));

    // The id hashes the fields alone, in any order.
    const reversed = Object.fromEntries(OFFICE_CHUNK_PROFILE_FIELDS.toReversed().map((field) => [field, profile[field]]));

    assert.equal(computeChunkProfileId(reversed), profile.id);
    // Read back from storage, it keeps its Office fields.
    assert.deepEqual(readStoredChunkProfile(JSON.parse(JSON.stringify(profile))), profile);
  }

  // Every Office field changes the id, and so does a chunker setting.
  const ids = new Set(
    [
      OFFICE_PARSES.docx,
      { ...OFFICE_PARSES.docx, extractorVersion: "0.0.1" },
      { ...OFFICE_PARSES.docx, extractor: "another" },
      { ...OFFICE_PARSES.docx, format: "xlsx" },
      { ...OFFICE_PARSES.docx, size: 600 },
    ].map((overrides) => describeChunkProfile(overrides).id)
  );

  assert.equal(ids.size, 5);

  // The PDF settings take no part: an invalid PDF_PARSER stops a PDF's
  // profile, not a Word document's.
  process.env.PDF_PARSER = "pdf.js";
  assert.throws(() => describeChunkProfile(), /PDF_PARSER/);
  assert.equal(describeChunkProfile(OFFICE_PARSES.docx).id, officeProfileOf("docx").id);
});

test("a stored parse is read back as an Office document's parse metadata or as the PDF settings", () => {
  assert.deepEqual(readStoredDocumentParse(OFFICE_PARSES.pptx), OFFICE_PARSES.pptx);
  assert.deepEqual(readStoredDocumentParse({ ...OFFICE_PARSES.docx, extractor: " mammoth " }), OFFICE_PARSES.docx);
  assert.deepEqual(readStoredDocumentParse({ paragraphDetection: false, pdfParser: "docling" }), {
    paragraphDetection: false,
    pdfParser: "docling",
  });
  assert.deepEqual(readStoredDocumentParse(describePdfParseSettings()), describePdfParseSettings());

  for (const value of [null, undefined, "docx", [], {}, { format: "odt" }, { format: "pdf" }]) {
    assert.equal(readStoredDocumentParse(value), null, JSON.stringify(value));
  }
});

test("chunks carry their page's location; their text and boundaries are the strategy's alone", () => {
  const texts = [
    `Retention\n${"Signed contracts are kept for seven years after they end. ".repeat(18)}`,
    "Plan\nOwner; Due\nOwner: Ana; Due: May",
    "Sheet: Budget\nItem; Amount\nItem: Travel; Amount: 1200",
  ];
  const bare = texts.map((text, index) => ({ pageNumber: index + 1, text }));
  const located = [
    { ...bare[0], locationLabel: "Retention", locationUnit: "section" },
    { ...bare[1], locationUnit: "slide" },
    { ...bare[2], locationLabel: "Budget", locationUnit: "sheet" },
  ];

  for (const chunkStrategy of CHUNK_STRATEGIES) {
    const cut = (pages) =>
      chunkDocumentWithConfig({ chunkOverlap: 60, chunkSize: 300, chunkStrategy, docId: "doc-located", fileName: "f", pages });
    const withLocation = cut(located);
    const without = cut(bare);

    assert.ok(withLocation.length > 3, chunkStrategy);
    assert.deepEqual(
      withLocation.map((chunk) => [chunk.id, chunk.pageContent, chunk.metadata.sectionHeading]),
      without.map((chunk) => [chunk.id, chunk.pageContent, chunk.metadata.sectionHeading]),
      `${chunkStrategy}: the same chunks`
    );

    for (const [index, chunk] of withLocation.entries()) {
      const { locationLabel, locationUnit, ...rest } = chunk.metadata;
      const page = located[chunk.metadata.pageNumber - 1];

      assert.equal(locationUnit, page.locationUnit);
      assert.equal(locationLabel, page.locationLabel);
      assert.equal("locationLabel" in chunk.metadata, page.locationLabel !== undefined, "no key without a label");
      assert.deepEqual(rest, without[index].metadata, "nothing else in the metadata changes");
    }

    // A PDF page has neither field, so its chunks have neither key.
    assert.ok(without.every((chunk) => !("locationUnit" in chunk.metadata) && !("locationLabel" in chunk.metadata)));
  }
});

test("the chunk stage gives an Office document its profile and MIME type, and a 422 worded for a document", () => {
  const pages = EXPECTED_LOCATIONS.pptx.map(([pageNumber, locationUnit, locationLabel]) => ({
    locationLabel,
    locationUnit,
    pageNumber,
    text: `${locationLabel}\nThe ${locationLabel.toLowerCase()} slide holds the pilot budget.`,
  }));
  const chunked = chunkDocumentPages({ docId: "doc-deck", fileName: "deck.pptx", pages, parse: OFFICE_PARSES.pptx });
  const profile = officeProfileOf("pptx");

  assert.deepEqual(chunked.chunkProfile, profile);
  assert.equal(chunked.mimeType, MIME.pptx);
  assert.ok(chunked.documents.every((document) => document.metadata.chunkProfileId === profile.id));
  assert.deepEqual(locationsOf(chunked.documents), EXPECTED_LOCATIONS.pptx);

  // A PDF's chunk stage result has exactly the fields it always had.
  const pdf = chunkDocumentPages({ docId: "doc-pdf", fileName: "a.pdf", pages: [{ pageNumber: 1, text: "Some text." }] });

  assert.deepEqual(Object.keys(pdf), ["chunkProfile", "documents", "pageCount", "profile"]);
  assert.equal(pdf.chunkProfile.id, describeChunkProfile().id);

  assert.throws(
    () => chunkDocumentPages({ docId: "doc-empty", fileName: "empty.docx", pages: [], parse: OFFICE_PARSES.docx }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.message, "No extractable text was found in the uploaded document.");
      return true;
    }
  );
  assert.throws(
    () => chunkDocumentPages({ docId: "doc-empty", fileName: "empty.pdf", pages: [] }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.message, "No extractable text was found in the uploaded PDF.");
      assert.deepEqual(Object.keys(error), ["status"], "the PDF error is the one it always was");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// The upload routes over the real ingest
// ---------------------------------------------------------------------------

test("POST /upload ingests a .docx, a .pptx and an .xlsx with their MIME type, located chunks of their own profile, and a download", async () => {
  const server = await startApp();

  try {
    for (const [format, bytes, fileName] of [
      ["docx", DOCX, "Retention Policy.docx"],
      ["pptx", PPTX, "kickoff.PPTX"],
      ["xlsx", XLSX, "budget.xlsx"],
    ]) {
      const created = await readJson(await sendDocument(server.baseUrl, bytes, fileName, { type: MIME[format] }));

      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.mimeType, MIME[format]);
      assert.equal(created.body.fileName, fileName);
      assert.equal(created.body.pageCount, EXPECTED_LOCATIONS[format].length);

      const chunks = await storedChunks(created.body.docId);
      const profile = officeProfileOf(format);

      assert.ok(chunks.length > 0);
      assert.deepEqual(locationsOf(chunks), EXPECTED_LOCATIONS[format], format);
      assert.ok(chunks.every((chunk) => chunk.metadata.chunkProfileId === profile.id), format);

      const listed = (await (await fetch(`${server.baseUrl}/documents`)).json()).find(
        (document) => document.docId === created.body.docId
      );

      assert.equal(listed.mimeType, MIME[format]);

      // The download: its own type, as an attachment.
      const download = await fetch(`${server.baseUrl}/documents/${created.body.docId}/file`);

      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-type"), MIME[format]);
      assert.equal(
        download.headers.get("content-disposition"),
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    }

    // A PDF in the same archive: chunks without a location, the PDF profile,
    // and the download inline as it always was.
    const pdf = await readJson(await sendDocument(server.baseUrl, PDF, "travel.pdf", { type: "application/pdf" }));

    assert.equal(pdf.status, 201);
    assert.equal(pdf.body.mimeType, "application/pdf");

    const pdfChunks = await storedChunks(pdf.body.docId);

    assert.ok(pdfChunks.length > 0);
    assert.ok(pdfChunks.every((chunk) => !("locationUnit" in chunk.metadata) && !("locationLabel" in chunk.metadata)));
    assert.ok(pdfChunks.every((chunk) => chunk.metadata.chunkProfileId === describeChunkProfile().id));

    const download = await fetch(`${server.baseUrl}/documents/${pdf.body.docId}/file`);

    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.equal(download.headers.get("content-disposition"), "inline; filename*=UTF-8''travel.pdf");
    assert.deepEqual(await listFiles(server.uploadsDirectory), [], "the working files are removed");
  } finally {
    await server.close();
  }
});

test("a chunked upload is checked by its bytes and ingested as their format", async () => {
  const server = await startApp();

  try {
    const deck = await readJson(await chunkedUpload(server.baseUrl, { bytes: PPTX, fileId: "chunked-deck", fileName: "deck.pptx" }));

    assert.equal(deck.status, 201, JSON.stringify(deck.body));
    assert.equal(deck.body.mimeType, MIME.pptx);
    assert.deepEqual(locationsOf(await storedChunks(deck.body.docId)), EXPECTED_LOCATIONS.pptx);

    // The name says Word, the bytes are a workbook: the bytes decide.
    const misnamed = await readJson(
      await chunkedUpload(server.baseUrl, { bytes: XLSX, fileId: "chunked-misnamed", fileName: "budget.docx" })
    );

    assert.equal(misnamed.status, 201, JSON.stringify(misnamed.body));
    assert.equal(misnamed.body.mimeType, MIME.xlsx);

    // A legacy file under an Office name is refused at completion, and its
    // session is gone.
    const legacy = await readJson(
      await chunkedUpload(server.baseUrl, { bytes: buildOle2Bytes(), fileId: "chunked-legacy", fileName: "old.docx" })
    );

    assert.equal(legacy.status, 415);
    assert.equal(legacy.body.code, "DOCUMENT_FORMAT_LEGACY_OFFICE");
    assert.equal((await fetch(`${server.baseUrl}/upload/status?fileId=chunked-legacy`)).status, 404);

    // A name of no supported format is refused at init.
    const named = await readJson(await chunkedUpload(server.baseUrl, { bytes: DOCX, fileId: "chunked-odt", fileName: "notes.odt" }));

    assert.equal(named.status, 400);
    assert.deepEqual(named.body, UNSUPPORTED);
  } finally {
    await server.close();
  }
});

test("every refusal answers its status and code at the route, and nothing reaches the index", async () => {
  const server = await startApp();
  // `ingest`: refused by the loader during the synchronous ingest, past the
  // byte check; the rest are refused by the byte check itself (or the upload
  // filter), which PUT runs too.
  const refusals = [
    // No supported name or MIME type: the upload filter drops the file.
    { bytes: Buffer.from("plain text"), expected: { ...UNSUPPORTED }, fileName: "notes.txt", status: 400, type: "text/plain" },
    // A supported name over bytes of no supported format.
    { bytes: Buffer.from("plain text"), expected: { ...UNSUPPORTED }, fileName: "notes.docx", status: 400 },
    { bytes: buildOle2Bytes(), code: "DOCUMENT_FORMAT_LEGACY_OFFICE", fileName: "protected.docx", status: 415 },
    {
      bytes: buildDocx({ blocks: [{ text: "Macros" }], mainContentType: VARIANT_CONTENT_TYPES.docm }),
      code: "DOCUMENT_FORMAT_OFFICE_VARIANT",
      fileName: "macro.docx",
      status: 415,
    },
    {
      bytes: buildDocx({ blocks: [{ text: "Entity" }], transform: (entries) => addDoctype(entries, "word/document.xml") }),
      code: "DOCUMENT_ARCHIVE_INVALID",
      fileName: "entity.docx",
      status: 400,
    },
    {
      bytes: buildDocx({ blocks: [{ text: "Many parts" }], transform: (entries) => [...entries, ...fillerEntries(20)] }),
      code: "DOCUMENT_ARCHIVE_TOO_LARGE",
      env: { RAG_OFFICE_MAX_ZIP_ENTRIES: "10" },
      fileName: "parts.docx",
      status: 413,
    },
    // A recognised format the setting leaves out.
    {
      bytes: PPTX,
      code: "DOCUMENT_FORMAT_DISABLED",
      env: { RAG_DOCUMENT_FORMATS: "pdf, DOCX" },
      fileName: "deck.pptx",
      status: 415,
    },
    {
      bytes: XLSX,
      code: "DOCUMENT_SPREADSHEET_TOO_LARGE",
      env: { RAG_XLSX_MAX_CELLS: "2" },
      fileName: "big.xlsx",
      ingest: true,
      status: 413,
    },
    // No text: the 422 every ingest answers, worded for a document.
    {
      bytes: buildDocx({ blocks: [{ alt: "chart", image: true }] }),
      expected: { error: "No extractable text was found in the uploaded document." },
      fileName: "picture.docx",
      ingest: true,
      status: 422,
    },
  ];

  try {
    const before = (await (await fetch(`${server.baseUrl}/documents`)).json()).length;

    for (const { bytes, code, env = {}, expected, fileName, ingest = false, status, type = "" } of refusals) {
      Object.assign(process.env, env);

      try {
        for (const [method, requestPath] of [
          ["POST", "/upload"],
          // PUT runs the same filter and byte check before anything else.
          ...(ingest ? [] : [["PUT", "/documents/doc-missing"]]),
        ]) {
          const response = await readJson(await sendDocument(server.baseUrl, bytes, fileName, { method, requestPath, type }));

          assert.equal(response.status, status, `${method} ${fileName}: ${JSON.stringify(response.body)}`);

          if (expected) {
            assert.deepEqual(response.body, expected, `${method} ${fileName}`);
          } else {
            assert.equal(response.body.code, code, `${method} ${fileName}`);
            assert.equal(typeof response.body.error, "string");
          }
        }
      } finally {
        for (const name of Object.keys(env)) {
          delete process.env[name];
        }
      }
    }

    assert.equal((await (await fetch(`${server.baseUrl}/documents`)).json()).length, before, "nothing was ingested");
    assert.deepEqual(await listFiles(server.uploadsDirectory), [], "every refused upload is removed");
  } finally {
    await server.close();
  }
});

test("PUT /documents/:docId hands a synchronous replacement the format of its bytes", async () => {
  const replaced = [];
  const server = await startApp({
    ragService: {
      getDocument: (docId) => (docId === "doc-1" ? { docId, fileName: "plan.pdf", fileSize: 10 } : null),
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      ingestDocument: async () => {
        throw new Error("not a replacement");
      },
      isDocumentRegistryShared: () => false,
      loadDocumentsFromStore: async () => [],
      replaceDocument: async (input) => {
        replaced.push(input);
        return { docId: input.docId, fileName: input.fileName, version: 2 };
      },
    },
  });

  try {
    for (const [bytes, fileName, type] of [
      [PDF, "plan.pdf", "application/pdf"],
      [XLSX, "plan.xlsx", MIME.xlsx],
    ]) {
      const response = await readJson(
        await sendDocument(server.baseUrl, bytes, fileName, { method: "PUT", requestPath: "/documents/doc-1", type })
      );

      assert.equal(response.status, 200, JSON.stringify(response.body));
    }

    // A PDF's replacement is handed exactly what it always was; an Office
    // file's is told its format.
    assert.equal("formats" in replaced[0], false);
    assert.deepEqual(replaced[1].formats, ["xlsx"]);
    assert.equal(replaced[1].fileName, "plan.xlsx");
  } finally {
    await server.close();
  }
});

test("the async enqueue runs an Office upload through the staged pipeline to a document", async () => {
  process.env.RAG_INGEST_MODE = "async";

  const ingestJobStore = createInMemoryIngestJobStore();
  const server = await startApp({ ingestJobStore });
  const worker = createIngestWorker({
    leaseMs: 60000,
    logger: silentLogger,
    pipeline: createIngestPipeline({ batchingEnabled: () => false }),
    ragService: server.app.locals.services.ragService,
    retryDelayMs: () => 0,
    store: ingestJobStore,
    tempDirectory: tempRoot,
    workerId: "office-worker",
  });

  try {
    const queued = await readJson(await sendDocument(server.baseUrl, XLSX, "budget.xlsx", { type: MIME.xlsx }));

    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    assert.equal((await worker.runOnce()).outcome, "succeeded");

    const job = await readJson(await fetch(`${server.baseUrl}/ingest-jobs/${queued.body.jobId}`));

    assert.equal(job.body.status, "succeeded");
    assert.equal(job.body.document.mimeType, MIME.xlsx);
    assert.equal(job.body.document.pageCount, 2);

    const chunks = await storedChunks(job.body.docId);

    assert.deepEqual(locationsOf(chunks), EXPECTED_LOCATIONS.xlsx);
    assert.ok(chunks.every((chunk) => chunk.metadata.chunkProfileId === officeProfileOf("xlsx").id));

    // A workbook the loader refuses fails its job at parse with that answer.
    process.env.RAG_XLSX_MAX_CELLS = "2";

    const refused = await readJson(await sendDocument(server.baseUrl, XLSX, "big.xlsx", { type: MIME.xlsx }));

    assert.equal(refused.status, 202);
    assert.equal((await worker.runOnce()).outcome, "failed");

    const failed = await readJson(await fetch(`${server.baseUrl}/ingest-jobs/${refused.body.jobId}`));

    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.stage, "parse");
    assert.match(failed.body.error, /RAG_XLSX_MAX_CELLS/);
  } finally {
    await worker.stop?.();
    await server.close();
  }
});

test("the staged pipeline carries an Office document's parse, profile and MIME type through its stage outputs", async () => {
  const committed = [];
  const pipeline = createIngestPipeline({
    commit: async (input) => {
      committed.push(input);
      return { docId: input.docId, documentVersion: 1, duplicate: false, superseded: false };
    },
  });
  const filePath = path.join(tempRoot, "staged-word.bin");
  const job = { docId: "doc-staged-word", fileName: "retention.docx", kind: "create" };

  // As the worker writes the job's file: a working file.
  await writeWorkingFile(filePath, DOCX);

  const parsed = await pipeline.parse({ filePath, job });
  const { meta, value: pages } = decodeJsonOutputEnvelope("pages", parsed.output);

  assert.deepEqual(meta, { parse: OFFICE_PARSES.docx });
  assert.deepEqual(
    pages.map((page) => [page.pageNumber, page.locationUnit, page.locationLabel]),
    EXPECTED_LOCATIONS.docx
  );

  const chunkOutput = (await pipeline.chunk({ inputs: { pages: parsed.output }, job })).output;
  const chunked = decodeJsonOutput("chunks", chunkOutput);

  assert.equal(chunked.mimeType, MIME.docx);
  assert.deepEqual(chunked.chunkProfile, JSON.parse(JSON.stringify(officeProfileOf("docx"))));
  assert.deepEqual(locationsOf(chunked.documents), EXPECTED_LOCATIONS.docx);

  const space = { dimensions: 2, key: "fake|2", model: "fake" };
  const embeddingsOf = (documents) =>
    encodeEmbeddingsOutput({ spaces: [space], vectorsBySpace: { [space.key]: documents.map(() => [0.5, 0.5]) } });

  await pipeline.index({
    documentFilePath: filePath,
    inputs: { chunks: chunkOutput, embeddings: embeddingsOf(chunked.documents) },
    job,
  });
  assert.equal(committed[0].mimeType, MIME.docx);

  // A PDF goes through the same stages exactly as before: its parse settings,
  // no MIME type anywhere.
  const pdfPath = path.join(tempRoot, "staged.pdf");
  const pdfJob = { ...job, docId: "doc-staged-pdf", fileName: "staged.pdf" };

  await writeWorkingFile(pdfPath, PDF);

  const pdfParsed = await pipeline.parse({ filePath: pdfPath, job: pdfJob });

  assert.deepEqual(decodeJsonOutputEnvelope("pages", pdfParsed.output).meta, { parse: describePdfParseSettings() });

  const pdfChunkOutput = (await pipeline.chunk({ inputs: { pages: pdfParsed.output }, job: pdfJob })).output;
  const pdfChunked = decodeJsonOutput("chunks", pdfChunkOutput);

  assert.deepEqual(Object.keys(pdfChunked), ["chunkProfile", "documents", "pageCount", "profile"]);
  await pipeline.index({
    documentFilePath: pdfPath,
    inputs: { chunks: pdfChunkOutput, embeddings: embeddingsOf(pdfChunked.documents) },
    job: pdfJob,
  });
  assert.equal("mimeType" in committed[1], false, "a PDF's commit is the one it always was");
});

test("the re-chunk rule compares an Office job's chunks on the chunker fields alone, and a re-chunk keeps its format", async () => {
  const officeChunks = (profile) => ({
    chunks: encodeJsonOutput("chunks", { chunkProfile: JSON.parse(JSON.stringify(profile)), documents: [] }),
  });
  const staleUnder = (current, profile) =>
    createIngestPipeline({ describeProfile: () => current }).chunksAreStale({ inputs: officeChunks(profile) });

  // This process's PDF settings never make an Office document's chunks stale;
  // a chunker setting does, for every format alike.
  assert.equal(staleUnder(describeChunkProfile(), officeProfileOf("pptx")), false);
  assert.equal(staleUnder(describeChunkProfile({ paragraphDetection: false, pdfParser: "docling" }), officeProfileOf("pptx")), false);
  assert.equal(staleUnder(describeChunkProfile({ size: 300 }), officeProfileOf("pptx")), true);

  // Moved back to the chunk stage, the job's stored pages are cut again as
  // the format their parse recorded.
  const pages = encodeJsonOutput(
    "pages",
    EXPECTED_LOCATIONS.pptx.map(([pageNumber, locationUnit, locationLabel]) => ({
      locationLabel,
      locationUnit,
      pageNumber,
      text: `${locationLabel}\nThe pilot budget is approved.`,
    })),
    { meta: { parse: OFFICE_PARSES.pptx } }
  );

  process.env.RAG_CHUNK_SIZE = "300";

  const rechunked = decodeJsonOutput(
    "chunks",
    (await createIngestPipeline().chunk({ inputs: { pages }, job: { docId: "doc-rechunk", fileName: "deck.pptx" }, rechunk: true }))
      .output
  );

  assert.equal(rechunked.rechunked, true);
  assert.equal(rechunked.mimeType, MIME.pptx);
  assert.equal(rechunked.chunkProfile.size, 300);
  assert.equal(rechunked.chunkProfile.format, "pptx");
  assert.deepEqual(locationsOf(rechunked.documents), EXPECTED_LOCATIONS.pptx);
});

test("the worker's one-step path asks the ingest to read any supported format", async () => {
  const store = createInMemoryIngestJobStore();
  const inputs = [];
  const worker = createIngestWorker({
    leaseMs: 60000,
    logger: silentLogger,
    ragService: {
      getDocument: () => null,
      ingestDocument: async (input) => {
        inputs.push(input);
        return { docId: input.docId, fileName: input.fileName };
      },
    },
    store,
    tempDirectory: tempRoot,
    workerId: "one-step",
  });

  // Queued before RAG_DOCUMENT_FORMATS left Word documents out: still ingested.
  await store.enqueue({ docId: "doc-one-step", fileBytes: DOCX, fileName: "queued.docx", ownerUserId: "", workspaceId: "" });
  process.env.RAG_DOCUMENT_FORMATS = "pdf";

  assert.equal((await worker.runOnce()).outcome, "succeeded");
  assert.deepEqual(inputs[0].formats, DOCUMENT_FORMATS);
});

test("the trash restore re-parses a stored document as the format it was registered as", async () => {
  for (const [format, bytes] of [
    ["docx", DOCX],
    ["pptx", PPTX],
    ["xlsx", XLSX],
  ]) {
    const chunked = await chunkStoredDocument({
      document: { docId: `doc-restored-${format}`, fileName: `restored.${format}`, mimeType: MIME[format], profile: {} },
      fileBuffer: bytes,
    });

    assert.equal(chunked.mimeType, MIME[format]);
    assert.deepEqual(chunked.chunkProfile, officeProfileOf(format));
    assert.deepEqual(locationsOf(chunked.documents), EXPECTED_LOCATIONS[format]);
  }

  // Whatever RAG_DOCUMENT_FORMATS says now: a stored Word document is still read.
  process.env.RAG_DOCUMENT_FORMATS = "pdf";

  const word = await chunkStoredDocument({
    document: { docId: "doc-restored-word", fileName: "w.docx", mimeType: MIME.docx, profile: {} },
    fileBuffer: DOCX,
  });

  assert.equal(word.mimeType, MIME.docx);

  // A stored PDF (application/pdf, or no type: every document stored before
  // Office formats) is re-chunked exactly as before.
  for (const mimeType of ["application/pdf", undefined]) {
    const pdf = await chunkStoredDocument({
      document: { docId: "doc-restored-pdf", fileName: "travel.pdf", mimeType, profile: {} },
      fileBuffer: PDF,
    });

    assert.deepEqual(Object.keys(pdf), ["chunkProfile", "documents", "pageCount", "profile"]);
    assert.equal(pdf.chunkProfile.id, describeChunkProfile().id);
    assert.ok(pdf.documents.every((document) => !("locationUnit" in document.metadata)));
  }
});

// ---------------------------------------------------------------------------
// RAG_DOCUMENT_FORMATS
// ---------------------------------------------------------------------------

test("RAG_DOCUMENT_FORMATS=pdf restores every PDF-only check, message and stored file name", async () => {
  process.env.RAG_DOCUMENT_FORMATS = "pdf";

  const server = await startApp();

  try {
    // A .docx by name and type: the upload filter drops it, as before.
    let response = await readJson(await sendDocument(server.baseUrl, DOCX, "notes.docx", { type: MIME.docx }));

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "A PDF file is required." });

    // Word bytes under a PDF name and type: the old %PDF check and its 400.
    response = await readJson(await sendDocument(server.baseUrl, DOCX, "notes.pdf", { type: "application/pdf" }));

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "The uploaded file is not a valid PDF." });

    response = await readJson(await chunkedUpload(server.baseUrl, { bytes: DOCX, fileId: "pdf-only-docx", fileName: "notes.docx" }));

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "Only PDF files are supported." });

    response = await readJson(await sendDocument(server.baseUrl, PDF, "travel.pdf", { type: "application/pdf" }));

    assert.equal(response.status, 201);
    assert.equal(response.body.mimeType, "application/pdf");

    // The stored file name is "<uuid>.pdf" whatever the upload is called.
    for (const fileName of ["notes.docx", "travel.pdf", "deck.pptx", "unnamed"]) {
      assert.match(createStoredFileName({ fileName }), /^[0-9a-f-]{36}\.pdf$/, fileName);
    }

    assert.match(createStoredFileName(), /^[0-9a-f-]{36}\.pdf$/);
    assert.equal(isAcceptedUploadFile({ mimetype: MIME.docx, originalname: "notes.docx" }), false);
    assert.equal(isAcceptedUploadFile({ mimetype: "application/pdf", originalname: "notes.docx" }), true);
  } finally {
    await server.close();
  }

  delete process.env.RAG_DOCUMENT_FORMATS;

  // With Office formats: the name's extension, else the client's type, else .pdf.
  assert.match(createStoredFileName({ fileName: "Notes.DOCX" }), /^[0-9a-f-]{36}\.docx$/);
  assert.match(createStoredFileName({ fileName: "deck", mimeType: MIME.pptx }), /^[0-9a-f-]{36}\.pptx$/);
  assert.match(createStoredFileName({ fileName: "budget.xlsx", mimeType: "application/pdf" }), /^[0-9a-f-]{36}\.xlsx$/);
  assert.match(createStoredFileName({ fileName: "scan" }), /^[0-9a-f-]{36}\.pdf$/);
  // Every supported format gets through the filter (the bytes then decide),
  // even one the setting leaves out; nothing else does.
  process.env.RAG_DOCUMENT_FORMATS = "pdf,docx";
  assert.equal(isAcceptedUploadFile({ mimetype: "", originalname: "deck.pptx" }), true);
  assert.equal(isAcceptedUploadFile({ mimetype: MIME.xlsx, originalname: "budget" }), true);
  assert.equal(isAcceptedUploadFile({ mimetype: "text/plain", originalname: "notes.txt" }), false);
  assert.equal(isAcceptedUploadFile({ mimetype: MIME.docx, originalname: "../notes.docx" }), false, "an unsafe name");
});

test("an invalid RAG_DOCUMENT_FORMATS or Office limit refuses the start, and answers its code once changed at run time", async () => {
  const untouchable = new Proxy(
    {},
    {
      get: (_target, name) => assert.fail(`createAppServices read options.${String(name)}`),
      has: (_target, name) => assert.fail(`createAppServices probed options.${String(name)}`),
    }
  );

  for (const [name, value, code] of [
    ["RAG_DOCUMENT_FORMATS", "pdf,odt", "RAG_DOCUMENT_FORMATS_INVALID"],
    ["RAG_DOCUMENT_FORMATS", " , ", "RAG_DOCUMENT_FORMATS_INVALID"],
    ["RAG_OFFICE_MAX_ZIP_ENTRIES", "0", "RAG_OFFICE_LIMIT_INVALID"],
    ["RAG_OFFICE_MAX_UNCOMPRESSED_BYTES", "1.5", "RAG_OFFICE_LIMIT_INVALID"],
    ["RAG_OFFICE_MAX_COMPRESSION_RATIO", "-3", "RAG_OFFICE_LIMIT_INVALID"],
    ["RAG_XLSX_MAX_CELLS", "many", "RAG_OFFICE_LIMIT_INVALID"],
  ]) {
    process.env[name] = value;
    assert.throws(() => createAppServices(untouchable, { uploadsDirectory: "/nonexistent" }), { code }, `${name}=${value}`);
    delete process.env[name];
  }

  // Valid, or blank (the default), nothing is refused.
  process.env.RAG_DOCUMENT_FORMATS = "PDF, xlsx, pdf";
  process.env.RAG_XLSX_MAX_CELLS = "  ";

  const server = await startApp();

  try {
    // A value changed to an invalid one after the start: the upload answers
    // the setting's coded error instead of accepting some other set.
    process.env.RAG_DOCUMENT_FORMATS = "pdf,odt";

    for (const response of [
      await sendDocument(server.baseUrl, PDF, "travel.pdf", { type: "application/pdf" }),
      await chunkedUpload(server.baseUrl, { bytes: PDF, fileId: "invalid-setting", fileName: "travel.pdf" }),
    ]) {
      const { body, status } = await readJson(response);

      assert.equal(status, 500);
      assert.equal(body.code, "RAG_DOCUMENT_FORMATS_INVALID");
      assert.match(body.error, /RAG_DOCUMENT_FORMATS must be a comma list/);
    }
  } finally {
    await server.close();
  }
});
