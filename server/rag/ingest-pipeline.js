import { getRagIngestStageOutputMaxBytes, isRagIngestEmbedBatchingEnabled } from "./config.js";
import { getDefaultEmbeddingBatcher } from "./ingest-embedding-batcher.js";
import { INGEST_JOB_KINDS, INGEST_STAGE_OUTPUTS, INGEST_STAGES } from "./ingest-stages.js";
import {
  chunkDocumentPages,
  commitDocument,
  embedDocumentChunks,
  findDuplicateDocument,
} from "./index.js";
import { loadPdfPages } from "./pdf-loader.js";
import { embedDocumentTextsForIndex } from "./vector-store.js";

// The staged form of an ingest, run by rag/ingest-worker.js for an async job:
//
//   parse  the job's PDF -> `pages` (the PDF itself becomes `document_file`)
//   chunk  `pages`       -> `chunks` (chunk documents, page count, profile)
//   embed  `chunks`      -> `embeddings` (per embedding space, through the
//                           process's cross-document batcher, or one request
//                           per job and space with RAG_INGEST_EMBED_BATCHING=false)
//   index  `chunks` + `embeddings` + `document_file` -> the committed document
//
// Each stage is a function of the previous stages' outputs, which the worker
// reads from and writes to the job store (migration 017); none of them touches
// the queue. The same functions of rag/index.js back the synchronous upload, so
// a staged job indexes exactly what a synchronous upload of the same bytes
// would. Outputs are serialized here, and a stage whose output is larger than
// RAG_INGEST_STAGE_OUTPUT_MAX_BYTES fails with a 413 instead of being stored.

const STAGE_OUTPUT_FORMAT_VERSION = 1;
const HEADER_LENGTH_BYTES = 4;

export const STAGE_INPUTS = Object.freeze({
  chunk: Object.freeze([INGEST_STAGE_OUTPUTS.pages]),
  embed: Object.freeze([INGEST_STAGE_OUTPUTS.chunks]),
  index: Object.freeze([INGEST_STAGE_OUTPUTS.chunks, INGEST_STAGE_OUTPUTS.embeddings]),
  parse: Object.freeze([]),
});

export const STAGE_OUTPUT_OF = Object.freeze({
  chunk: INGEST_STAGE_OUTPUTS.chunks,
  embed: INGEST_STAGE_OUTPUTS.embeddings,
  index: null,
  parse: INGEST_STAGE_OUTPUTS.pages,
});

const resolveLimit = (value) => {
  const limit = Math.floor(Number(typeof value === "function" ? value() : value));

  return Number.isFinite(limit) && limit > 0 ? limit : 0;
};

// Pages and chunks are functions of the upload alone: too large is final.
// Embeddings also depend on the configured models' widths, so that error does
// not say `retryable: false`: at the embed stage the worker keeps the job's
// bytes and dead-letters it once its retries are spent (ingest-worker.js).
const createOutputTooLargeError = (name, size, limit, { final = true } = {}) =>
  Object.assign(
    new Error(
      `The document is too large to ingest: its ${name} would take ${size} bytes, above the ${limit}-byte limit (RAG_INGEST_STAGE_OUTPUT_MAX_BYTES).`
    ),
    { expose: true, status: 413, ...(final ? { retryable: false } : {}) }
  );

const createCorruptOutputError = (name, reason) =>
  Object.assign(new Error(`The stored ${name} output of this ingest job is unreadable: ${reason}.`), {
    code: "INGEST_STAGE_OUTPUT_CORRUPT",
  });

const assertWithinLimit = (name, buffer, maxBytes) => {
  const limit = resolveLimit(maxBytes);

  if (limit > 0 && buffer.byteLength > limit) {
    throw createOutputTooLargeError(name, buffer.byteLength, limit);
  }

  return buffer;
};

export const encodeJsonOutput = (name, value, { maxBytes = getRagIngestStageOutputMaxBytes } = {}) =>
  assertWithinLimit(name, Buffer.from(JSON.stringify({ format: STAGE_OUTPUT_FORMAT_VERSION, value })), maxBytes);

export const decodeJsonOutput = (name, buffer) => {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw createCorruptOutputError(name, "it is missing");
  }

  let parsed;

  try {
    parsed = JSON.parse(Buffer.from(buffer).toString("utf8"));
  } catch {
    throw createCorruptOutputError(name, "it is not JSON");
  }

  if (parsed?.format !== STAGE_OUTPUT_FORMAT_VERSION) {
    throw createCorruptOutputError(name, `format ${parsed?.format} is not ${STAGE_OUTPUT_FORMAT_VERSION}`);
  }

  return parsed.value;
};

const describeSpace = (space) => ({
  dimensions: space.dimensions,
  documentPrefix: space.documentPrefix ?? "",
  identity: space.identity ?? "",
  key: space.key,
  model: space.model ?? "",
  queryPrefix: space.queryPrefix ?? "",
});

/**
 * Embeddings as a 4-byte header length, a JSON header (spaces, widths, count)
 * and the vectors as little-endian float32 -- a quarter of their JSON size.
 * pgvector stores float4 anyway, so nothing a search could tell apart is lost.
 *
 * The size limit applies to each space's vectors, not to their sum: while an
 * index version is built under a second model every upload carries a second
 * set, and a document that fits without the build must fit during it.
 */
export const encodeEmbeddingsOutput = (
  { spaces = [], vectorsBySpace = {} } = {},
  { maxBytes = getRagIngestStageOutputMaxBytes } = {}
) => {
  const layout = spaces.map((space) => {
    const vectors = vectorsBySpace[space.key] ?? [];
    const width = Array.isArray(vectors[0]) ? vectors[0].length : 0;

    if (vectors.some((vector) => !Array.isArray(vector) || vector.length !== width)) {
      throw new Error(`Embeddings in space ${space.key} do not share one width.`);
    }

    return { count: vectors.length, space: describeSpace(space), vectors, width };
  });
  const header = Buffer.from(
    JSON.stringify({
      format: STAGE_OUTPUT_FORMAT_VERSION,
      spaces: layout.map(({ count, space, width }) => ({ ...space, count, width })),
    })
  );
  const valueCount = layout.reduce((total, entry) => total + entry.count * entry.width, 0);
  const size = HEADER_LENGTH_BYTES + header.byteLength + valueCount * 4;
  const limit = resolveLimit(maxBytes);
  const largest = layout.reduce((max, entry) => Math.max(max, entry.count * entry.width * 4), 0);

  if (limit > 0 && largest > limit) {
    throw createOutputTooLargeError(INGEST_STAGE_OUTPUTS.embeddings, largest, limit, { final: false });
  }

  const buffer = Buffer.alloc(size);
  let offset = 0;

  buffer.writeUInt32LE(header.byteLength, offset);
  offset += HEADER_LENGTH_BYTES;
  header.copy(buffer, offset);
  offset += header.byteLength;

  for (const entry of layout) {
    for (const vector of entry.vectors) {
      for (const value of vector) {
        buffer.writeFloatLE(Number(value) || 0, offset);
        offset += 4;
      }
    }
  }

  return buffer;
};

export const decodeEmbeddingsOutput = (buffer) => {
  const name = INGEST_STAGE_OUTPUTS.embeddings;

  if ((!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) || buffer.byteLength < HEADER_LENGTH_BYTES) {
    throw createCorruptOutputError(name, "it is missing or truncated");
  }

  const bytes = Buffer.from(buffer);
  const headerLength = bytes.readUInt32LE(0);
  let header;

  try {
    header = JSON.parse(bytes.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + headerLength).toString("utf8"));
  } catch {
    throw createCorruptOutputError(name, "its header is not JSON");
  }

  if (header?.format !== STAGE_OUTPUT_FORMAT_VERSION || !Array.isArray(header.spaces)) {
    throw createCorruptOutputError(name, "its header has another format");
  }

  let offset = HEADER_LENGTH_BYTES + headerLength;
  const expected =
    offset + header.spaces.reduce((total, space) => total + space.count * space.width * 4, 0);

  if (expected !== bytes.byteLength) {
    throw createCorruptOutputError(name, `it holds ${bytes.byteLength} bytes where its header says ${expected}`);
  }

  const spaces = [];
  const vectorsBySpace = {};

  for (const { count, width, ...space } of header.spaces) {
    const vectors = [];

    for (let row = 0; row < count; row += 1) {
      const vector = new Array(width);

      for (let column = 0; column < width; column += 1) {
        vector[column] = bytes.readFloatLE(offset);
        offset += 4;
      }

      vectors.push(vector);
    }

    spaces.push(space);
    vectorsBySpace[space.key] = vectors;
  }

  return { spaces, vectorsBySpace };
};

/**
 * The stages, over injectable parts (tests swap the parser, the batcher or
 * the commit). Every stage takes the job and the inputs STAGE_INPUTS names as
 * Buffers and returns { output } (a Buffer for the stage's STAGE_OUTPUT_OF
 * name) or, for index, the commit outcome.
 *
 * The embed stage goes through `batcher` when one is given; otherwise through
 * the process's default batcher while `batchingEnabled()` holds
 * (RAG_INGEST_EMBED_BATCHING), else straight through `embedUnbatched`, one
 * request per job and embedding space.
 */
export const createIngestPipeline = ({
  batcher = null,
  batchingEnabled = isRagIngestEmbedBatchingEnabled,
  chunkPages = chunkDocumentPages,
  commit = commitDocument,
  embedChunks = embedDocumentChunks,
  embedUnbatched = embedDocumentTextsForIndex,
  findDuplicate = findDuplicateDocument,
  loadPages = loadPdfPages,
  maxOutputBytes = getRagIngestStageOutputMaxBytes,
} = {}) => {
  const resolveEmbedInSpace = () => {
    if (batcher) {
      return (texts, space) => batcher.embed(texts, space);
    }

    const enabled = typeof batchingEnabled === "function" ? batchingEnabled() : batchingEnabled;

    return enabled === false
      ? (texts, space) => embedUnbatched(texts, space)
      : (texts, space) => getDefaultEmbeddingBatcher().embed(texts, space);
  };

  return {
    stages: INGEST_STAGES,

    /**
     * A document this job's tenant already stored with these bytes, before
     * any stage runs: { docId, documentVersion } or null. Only for a create
     * job that asked for deduplication; the index stage checks again under
     * the tenant's content lock.
     */
    async findDuplicate({ job }) {
      if (job.kind !== INGEST_JOB_KINDS.create || !job.deduplicate || !job.contentSha256) {
        return null;
      }

      const document = await findDuplicate({
        contentSha256: job.contentSha256,
        docId: job.docId,
        ownerUserId: job.ownerUserId,
        workspaceId: job.workspaceId,
      });

      return document ? { docId: document.docId, documentVersion: document.version ?? null } : null;
    },

    async parse({ filePath }) {
      const pages = await loadPages(filePath);

      return {
        output: encodeJsonOutput(
          INGEST_STAGE_OUTPUTS.pages,
          (Array.isArray(pages) ? pages : []).map((page) => ({ ...page })),
          { maxBytes: maxOutputBytes }
        ),
      };
    },

    async chunk({ inputs, job }) {
      const pages = decodeJsonOutput(INGEST_STAGE_OUTPUTS.pages, inputs[INGEST_STAGE_OUTPUTS.pages]);
      const chunked = chunkPages({ docId: job.docId, fileName: job.fileName, pages, source: null });

      return {
        output: encodeJsonOutput(INGEST_STAGE_OUTPUTS.chunks, chunked, { maxBytes: maxOutputBytes }),
      };
    },

    async embed({ inputs }) {
      const { documents } = decodeJsonOutput(INGEST_STAGE_OUTPUTS.chunks, inputs[INGEST_STAGE_OUTPUTS.chunks]);
      const embedded = await embedChunks({
        documents,
        embedInSpace: resolveEmbedInSpace(),
      });

      return { output: encodeEmbeddingsOutput(embedded, { maxBytes: maxOutputBytes }) };
    },

    /**
     * Commits the document (rag/index.js commitDocument) from the stored
     * outputs; `documentFilePath` holds the job's PDF. `onCommit` runs inside
     * the write transaction where there is one.
     */
    async index({ documentFilePath, inputs, job, onCommit = null }) {
      const { documents, pageCount, profile } = decodeJsonOutput(
        INGEST_STAGE_OUTPUTS.chunks,
        inputs[INGEST_STAGE_OUTPUTS.chunks]
      );
      const { vectorsBySpace } = decodeEmbeddingsOutput(inputs[INGEST_STAGE_OUTPUTS.embeddings]);

      return commit({
        contentSha256: job.contentSha256,
        deduplicate: job.kind === INGEST_JOB_KINDS.create && Boolean(job.deduplicate),
        docId: job.docId,
        documents,
        fileName: job.fileName,
        filePath: documentFilePath,
        mode: job.kind === INGEST_JOB_KINDS.replace ? "replace" : "create",
        onCommit,
        ownerUserId: job.ownerUserId,
        pageCount,
        profile,
        // When the upload or replacement was requested: an older replacement
        // finishing after a newer one does not overwrite it.
        requestedAt: job.createdAt,
        vectorsBySpace,
        workspaceId: job.workspaceId,
      });
    },
  };
};

let defaultPipeline = null;

export const getDefaultIngestPipeline = () => {
  defaultPipeline ??= createIngestPipeline();
  return defaultPipeline;
};
