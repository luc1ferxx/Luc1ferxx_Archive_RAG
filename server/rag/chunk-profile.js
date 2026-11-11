import { createHash } from "node:crypto";
import {
  DOCUMENT_FORMATS,
  getChunkOverlap,
  getChunkSize,
  getChunkStrategy,
  getPdfParser,
  isPdfParagraphDetectionEnabled,
} from "./config.js";

// The chunk profile: everything besides a document's bytes that decides the
// chunks an ingest stores for it -- the chunker's code (CHUNKER_VERSION), its
// settings (RAG_CHUNK_STRATEGY, RAG_CHUNK_SIZE, RAG_CHUNK_OVERLAP) and the PDF
// text it is given (PDF_PARSER, PDF_PARAGRAPH_DETECTION). Its id is a short
// hash of those fields, so two chunk sets with the same id were cut the same
// way, and a changed id says the archive holds chunks a re-chunk would cut
// differently.
//
// Where it is recorded: every chunk an ingest, a trash restore, an index
// version build or `vector:reindex --from documents` stores carries
// `metadata.chunkProfileId` (like `documentVersion`; the citation, trace and
// response builders copy named fields only, so it never reaches a response);
// the staged ingest's chunk output carries the whole profile; an index
// version created by `vector:index build` records it in `index_params`
// (and `vector:reindex --from documents` updates that record after rewriting
// the version, to MIXED_CHUNK_PROFILE when it cannot say one profile cut it).
//
// The PDF fields name the settings the pages were parsed with. Where one
// process parses and chunks in one go (a synchronous upload, a restore, a
// build, a reindex) those are its own; the staged ingest parses before it
// chunks, possibly in another process, so its parse stage stores the settings
// beside the pages and the chunk stage records those (pages stored before
// that fall back to the chunking process's settings).
//
// A Word, PowerPoint or Excel document is not parsed by the PDF settings, so
// its profile names what did parse it instead: { id, chunkerVersion,
// strategy, size, overlap, format, extractor, extractorVersion }, the last
// three being the document loader's parse metadata (rag/document-loader.js:
// "docx" / "mammoth" / its version, "pptx" / "ooxml-pptx" / the reader's
// PPTX_EXTRACTOR_VERSION, "xlsx" / "sheetjs" / its version). Its id hashes
// those fields, so Office chunks carry an id of their own, and a PDF's profile
// (fields and id) is exactly what it was before Office formats. The re-chunk
// rule (CHUNK_PROFILE_RECHUNK_FIELDS) compares the chunker fields both share.

// Bump whenever the chunker's output for the same pages and settings changes
// (chunk text or chunk boundaries), also for a fix: stored chunks and index
// versions then say they were cut by the older chunker. 1 is the structured
// chunker before 1dcc8467 (2026-10-04), whose overlong-paragraph split and
// paragraph overlap differed from today's; 2 is the chunker since then.
export const CHUNKER_VERSION = 2;

export const CHUNK_PROFILE_FIELDS = Object.freeze([
  "chunkerVersion",
  "strategy",
  "size",
  "overlap",
  "pdfParser",
  "paragraphDetection",
]);

// The fields of a Word, PowerPoint or Excel document's profile: the chunker's
// and the parse metadata of the loader that read it (see the header).
export const OFFICE_CHUNK_PROFILE_FIELDS = Object.freeze([
  "chunkerVersion",
  "strategy",
  "size",
  "overlap",
  "format",
  "extractor",
  "extractorVersion",
]);

// The fields a re-chunk of already parsed pages can change: the chunker and
// its settings. The PDF fields are decided by the parse, which re-chunking
// pages does not repeat; so are the Office ones.
export const CHUNK_PROFILE_RECHUNK_FIELDS = Object.freeze(["chunkerVersion", "strategy", "size", "overlap"]);

const OFFICE_PROFILE_FORMATS = Object.freeze(DOCUMENT_FORMATS.filter((format) => format !== "pdf"));

/** Whether `format` names an Office format, whose profile has the Office fields. */
export const isOfficeChunkProfileFormat = (format) =>
  typeof format === "string" && OFFICE_PROFILE_FORMATS.includes(format);

// The fields a profile of these fields' format has: the Office ones when they
// name an Office format, the PDF ones otherwise (every profile before Office
// formats).
const profileFieldsOf = (fields) =>
  isOfficeChunkProfileFormat(fields?.format) ? OFFICE_CHUNK_PROFILE_FIELDS : CHUNK_PROFILE_FIELDS;

const CHUNK_PROFILE_ID_LENGTH = 12;
const CHUNK_PROFILE_ID_PATTERN = /^[0-9a-f]{12}$/;

// Sorted keys, so the id does not depend on the order fields were set in.
const toCanonicalProfileText = (fields) =>
  JSON.stringify(
    Object.fromEntries([...profileFieldsOf(fields)].sort().map((field) => [field, fields[field] ?? null]))
  );

export const computeChunkProfileId = (fields) =>
  createHash("sha256")
    .update(toCanonicalProfileText(fields))
    .digest("hex")
    .slice(0, CHUNK_PROFILE_ID_LENGTH);

const buildChunkProfile = (fields) =>
  Object.freeze({
    id: computeChunkProfileId(fields),
    ...Object.fromEntries(profileFieldsOf(fields).map((field) => [field, fields[field] ?? null])),
  });

/**
 * The profile this process chunks with now: { id, chunkerVersion, strategy,
 * size, overlap, pdfParser, paragraphDetection }. Throws what the getters
 * throw for an invalid RAG_CHUNK_STRATEGY or PDF_PARSER. `overrides` replace
 * single fields (tests, and callers that chunk with explicit settings).
 *
 * Given an Office parse in `overrides` ({ format, extractor,
 * extractorVersion } of rag/document-loader.js, format docx, pptx or xlsx)
 * it is that document's profile instead: { id, chunkerVersion, strategy,
 * size, overlap, format, extractor, extractorVersion }. The PDF settings take
 * no part in it, so an invalid PDF_PARSER does not stop an Office document.
 */
export const describeChunkProfile = (overrides = {}) =>
  isOfficeChunkProfileFormat(overrides.format)
    ? buildChunkProfile({
        chunkerVersion: CHUNKER_VERSION,
        strategy: overrides.strategy ?? getChunkStrategy(),
        size: overrides.size ?? getChunkSize(),
        overlap: overrides.overlap ?? getChunkOverlap(),
        format: overrides.format,
        extractor: overrides.extractor ?? null,
        extractorVersion: overrides.extractorVersion ?? null,
      })
    : buildChunkProfile({
        chunkerVersion: CHUNKER_VERSION,
        strategy: overrides.strategy ?? getChunkStrategy(),
        size: overrides.size ?? getChunkSize(),
        overlap: overrides.overlap ?? getChunkOverlap(),
        pdfParser: overrides.pdfParser ?? getPdfParser(),
        paragraphDetection: overrides.paragraphDetection ?? isPdfParagraphDetectionEnabled(),
      });

/**
 * The PDF settings this process parses with, { pdfParser, paragraphDetection }
 * (the profile's PDF fields). Throws what getPdfParser throws for an invalid
 * PDF_PARSER.
 */
export const describePdfParseSettings = () => ({
  paragraphDetection: isPdfParagraphDetectionEnabled(),
  pdfParser: getPdfParser(),
});

/**
 * PDF settings read back from storage (the staged ingest's pages output):
 * the well-formed fields of { pdfParser, paragraphDetection }, or null when
 * none is (stored before they were recorded). describeChunkProfile takes the
 * result as overrides; a missing field falls back to this process's setting.
 */
export const readStoredPdfParseSettings = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const settings = {
    ...(typeof value.pdfParser === "string" && value.pdfParser.trim() ? { pdfParser: value.pdfParser.trim() } : {}),
    ...(typeof value.paragraphDetection === "boolean" ? { paragraphDetection: value.paragraphDetection } : {}),
  };

  return Object.keys(settings).length > 0 ? settings : null;
};

/**
 * An Office document's parse metadata ({ format, extractor,
 * extractorVersion }, rag/document-loader.js), from the loader or read back
 * from storage (the staged ingest's pages output), or null when `value` names
 * no Office format: a PDF's parse settings, or nothing. describeChunkProfile
 * takes the result as overrides.
 */
export const readOfficeParse = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isOfficeChunkProfileFormat(value.format)) {
    return null;
  }

  const extractor = typeof value.extractor === "string" ? value.extractor.trim() : "";
  const version = value.extractorVersion;

  return Object.freeze({
    format: value.format,
    extractor: extractor || null,
    // A library's version string, or the PPTX reader's own version number.
    extractorVersion:
      typeof version === "string" && version.trim()
        ? version.trim()
        : Number.isFinite(version)
          ? version
          : null,
  });
};

/**
 * What a document was parsed with, read back from storage (the staged
 * ingest's pages output) for its chunk stage: an Office document's parse
 * metadata (readOfficeParse), else the PDF settings exactly as
 * readStoredPdfParseSettings reads them (null when none was recorded).
 */
export const readStoredDocumentParse = (value) => readOfficeParse(value) ?? readStoredPdfParseSettings(value);

/**
 * Whether re-chunking the pages a chunk set was cut from would cut it again
 * the same way here: the two profiles agree on CHUNK_PROFILE_RECHUNK_FIELDS.
 * They may still disagree on the PDF fields, which only a new parse changes.
 */
export const chunkProfilesCutAlike = (left, right) =>
  CHUNK_PROFILE_RECHUNK_FIELDS.every((field) => Object.is(left?.[field] ?? null, right?.[field] ?? null));

/**
 * A profile read back from storage (a stage output, an index version), or
 * null when there is none or it does not hold a well-formed id: written
 * before profiles were recorded, so unknown. An Office document's profile
 * keeps its Office fields.
 */
export const readStoredChunkProfile = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";

  if (!CHUNK_PROFILE_ID_PATTERN.test(id)) {
    return null;
  }

  return Object.freeze({
    id,
    ...Object.fromEntries(profileFieldsOf(value).map((field) => [field, value[field] ?? null])),
  });
};

// The variable behind each field. The chunker's version is code, not a
// setting: only a re-chunk brings chunks of an older chunker up to date.
export const CHUNK_PROFILE_SETTINGS = Object.freeze({
  strategy: "RAG_CHUNK_STRATEGY",
  size: "RAG_CHUNK_SIZE",
  overlap: "RAG_CHUNK_OVERLAP",
  pdfParser: "PDF_PARSER",
  paragraphDetection: "PDF_PARAGRAPH_DETECTION",
});

/**
 * Where two profiles disagree: `fields` in CHUNK_PROFILE_FIELDS order, and
 * `settings`, NAME -> the recorded value, for every differing field a
 * variable sets (applying them makes this process chunk as `recorded` did,
 * unless `chunkerVersion` differs too).
 */
export const describeChunkProfileChange = (recorded, current) => {
  const fields = CHUNK_PROFILE_FIELDS.filter(
    (field) => !Object.is(recorded?.[field] ?? null, current?.[field] ?? null)
  );

  return {
    fields,
    settings: Object.fromEntries(
      fields
        .filter((field) => CHUNK_PROFILE_SETTINGS[field] && recorded?.[field] !== null && recorded?.[field] !== undefined)
        .map((field) => [CHUNK_PROFILE_SETTINGS[field], String(recorded[field])])
    ),
  };
};

// What an index version records once its table holds chunks of more than one
// profile (`vector:reindex --from documents` under another one left documents
// out, or wrote into a version its builder still cuts under the recorded
// one): described as "mixed", never compared, so no warning names a profile
// its chunks do not share.
export const MIXED_CHUNK_PROFILE = Object.freeze({ mixed: true });

export const isMixedChunkProfileRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && value.mixed === true;

/** `metadata` of a stored chunk, stamped with the profile that cut it. */
export const stampChunkProfile = (metadata = {}, profile) => ({
  ...(metadata ?? {}),
  chunkProfileId: profile.id,
});
