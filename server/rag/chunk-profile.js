import { createHash } from "node:crypto";
import {
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
// version created by `vector:index build` records it in `index_params`.
//
// The PDF fields name this process's settings when it chunks. The staged
// ingest parses before it chunks, possibly in another process: a job parsed
// under another PDF_PARSER is not re-parsed (its PDF has left the job row by
// then), only re-chunked.

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

const CHUNK_PROFILE_ID_LENGTH = 12;
const CHUNK_PROFILE_ID_PATTERN = /^[0-9a-f]{12}$/;

// Sorted keys, so the id does not depend on the order fields were set in.
const toCanonicalProfileText = (fields) =>
  JSON.stringify(
    Object.fromEntries([...CHUNK_PROFILE_FIELDS].sort().map((field) => [field, fields[field] ?? null]))
  );

export const computeChunkProfileId = (fields) =>
  createHash("sha256")
    .update(toCanonicalProfileText(fields))
    .digest("hex")
    .slice(0, CHUNK_PROFILE_ID_LENGTH);

const buildChunkProfile = (fields) =>
  Object.freeze({
    id: computeChunkProfileId(fields),
    ...Object.fromEntries(CHUNK_PROFILE_FIELDS.map((field) => [field, fields[field] ?? null])),
  });

/**
 * The profile this process chunks with now: { id, chunkerVersion, strategy,
 * size, overlap, pdfParser, paragraphDetection }. Throws what the getters
 * throw for an invalid RAG_CHUNK_STRATEGY or PDF_PARSER. `overrides` replace
 * single fields (tests, and callers that chunk with explicit settings).
 */
export const describeChunkProfile = (overrides = {}) =>
  buildChunkProfile({
    chunkerVersion: CHUNKER_VERSION,
    strategy: overrides.strategy ?? getChunkStrategy(),
    size: overrides.size ?? getChunkSize(),
    overlap: overrides.overlap ?? getChunkOverlap(),
    pdfParser: overrides.pdfParser ?? getPdfParser(),
    paragraphDetection: overrides.paragraphDetection ?? isPdfParagraphDetectionEnabled(),
  });

/**
 * A profile read back from storage (a stage output, an index version), or
 * null when there is none or it does not hold a well-formed id: written
 * before profiles were recorded, so unknown.
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
    ...Object.fromEntries(CHUNK_PROFILE_FIELDS.map((field) => [field, value[field] ?? null])),
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

/** `metadata` of a stored chunk, stamped with the profile that cut it. */
export const stampChunkProfile = (metadata = {}, profile) => ({
  ...(metadata ?? {}),
  chunkProfileId: profile.id,
});
