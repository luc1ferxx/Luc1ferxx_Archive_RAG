import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildEmbeddingIndexIdentity,
  getEmbeddingDimensions,
  getEmbeddingDocumentPrefix,
  getEmbeddingModel,
  getEmbeddingQueryAdapterPath,
  getEmbeddingQueryPrefix,
} from "./config.js";

// Query-side linear embedding adapter (RAG_EMBEDDING_QUERY_ADAPTER).
//
// Embedding fine-tuning without touching the embedding model or the index: a
// d x d matrix W, trained on (question, evidence paragraph) pairs by
// evaluation/train-query-adapter.py, maps a query vector q to W q before the
// dense search. Document vectors are left alone, so nothing is reindexed and
// turning the adapter off is a configuration change.
//
// Where it applies is deliberately narrow: only where it was measured
// (evaluation/run-query-adapter-eval.mjs). embedQuery always returns the
// model's own vector; the retrieval seam (rag/vector-store.js) adapts it for
// one search only when all of these hold, and otherwise searches unadapted:
//   - the caller is the single-document QA route's own retrieval (scope
//     QUERY_ADAPTER_SCOPE_QA, no agent retrieval plan) over exactly one
//     document -- comparison, multi-document, gap-plan, agent-planned and
//     follow-up retrieval stay unadapted until each is measured;
//   - the route is hybrid with RRF fusion (the dense-only opt-out measured
//     worse; weighted fusion would score the dense route by vectorScore and
//     was never measured);
//   - the vector came from the embedding model itself (openai.js marks it)
//     in the adapter's space -- the model, both task prefixes and the width.
//     A stand-in provider's vectors are never adapted unless it opts in, and
//     a query embedded for an index version pinned to another space is left
//     alone, because W was never trained against those documents;
//   - the store can rank by W q while scoring with the model's own cosine
//     (local and pgvector). vectorScore, and so every admission floor keyed
//     on it (RAG_MIN_RELEVANCE_SCORE, selectQaContext's extras, comparison's
//     semantic bypass), stays the unadapted cosine the floors were set on;
//     W q moves absolute cosines far below them (held-out top-1 cosine 0.31
//     against 0.72 unadapted).
// A missing or broken file, or one trained for another space, leaves searches
// unadapted with a warning; checks.queryAdapter in the health report fails
// startup on the first and warns on the rest.
//
// The dense route of a search the adapter ranked carries its fingerprint
// (routes.dense.queryAdapter, provenance.queryAdapter).

export const QUERY_ADAPTER_FORMAT = "archive-rag.query-adapter/v1";
export const QUERY_ADAPTER_WEIGHT_ENCODING = "float32le-base64";

export class QueryAdapterConfigError extends Error {
  constructor(message, { code = "QUERY_ADAPTER_INVALID" } = {}) {
    super(message);
    this.name = "QueryAdapterConfigError";
    this.code = code;
    this.status = 500;
  }
}

// The one caller scope the adapter applies to (see above).
export const QUERY_ADAPTER_SCOPE_QA = "single_document_qa";

let loaded = null;
// vector -> fingerprint of the adapter that produced it. Weak, like the
// embedding cache's own space tags.
let adaptedVectors = new WeakMap();
// model vector -> { fingerprint, vector } of its adapted form, so the
// sub-queries and the verdict retry of one question do not redo W q.
let adaptedByModelVector = new WeakMap();
// vector -> the embedding space the embedding model produced it in
// (markModelQueryVector). A vector without an entry is never adapted.
let modelVectorSpaces = new WeakMap();
let warnedSkips = new Set();

const describeSpace = ({ model, queryPrefix, documentPrefix, dimensions }) =>
  `${model} (query prefix ${JSON.stringify(queryPrefix)}, document prefix ${JSON.stringify(documentPrefix)}, ${dimensions} dimensions)`;

const normalizeSpace = (space = {}) => ({
  dimensions: Number(space.dimensions),
  documentPrefix: String(space.documentPrefix ?? ""),
  model: String(space.model ?? "").trim(),
  queryPrefix: String(space.queryPrefix ?? ""),
});

const isSameSpace = (left, right) =>
  left.model === right.model &&
  left.queryPrefix === right.queryPrefix &&
  left.documentPrefix === right.documentPrefix &&
  left.dimensions === right.dimensions;

const getConfiguredSpace = () =>
  normalizeSpace({
    dimensions: getEmbeddingDimensions(),
    documentPrefix: getEmbeddingDocumentPrefix(),
    model: getEmbeddingModel(),
    queryPrefix: getEmbeddingQueryPrefix(),
  });

/**
 * Parses and validates an adapter file's JSON. The fingerprint covers the
 * format, the embedding space and the exact weight bytes, so two files that
 * would map a query differently never share one.
 */
export const parseQueryAdapter = (json, { source = "adapter" } = {}) => {
  const document = typeof json === "string" ? JSON.parse(json) : json;

  if (document?.format !== QUERY_ADAPTER_FORMAT) {
    throw new QueryAdapterConfigError(
      `${source}: expected format ${QUERY_ADAPTER_FORMAT}, found ${JSON.stringify(document?.format ?? null)}.`
    );
  }

  const space = normalizeSpace(document.embedding);

  if (!space.model || !Number.isInteger(space.dimensions) || space.dimensions <= 0) {
    throw new QueryAdapterConfigError(`${source}: embedding.model and a positive integer embedding.dimensions are required.`);
  }

  const weights = document.weights ?? {};
  const dimensions = space.dimensions;

  if (
    weights.encoding !== QUERY_ADAPTER_WEIGHT_ENCODING ||
    weights.layout !== "row-major" ||
    Number(weights.rows) !== dimensions ||
    Number(weights.cols) !== dimensions ||
    typeof weights.data !== "string"
  ) {
    throw new QueryAdapterConfigError(
      `${source}: weights must be a ${dimensions}x${dimensions} row-major ${QUERY_ADAPTER_WEIGHT_ENCODING} matrix.`
    );
  }

  const bytes = Buffer.from(weights.data, "base64");

  if (bytes.length !== dimensions * dimensions * 4) {
    throw new QueryAdapterConfigError(
      `${source}: weights hold ${bytes.length} bytes, expected ${dimensions * dimensions * 4}.`
    );
  }

  const matrix = new Float32Array(dimensions * dimensions);

  for (let index = 0; index < matrix.length; index += 1) {
    matrix[index] = bytes.readFloatLE(index * 4);

    if (!Number.isFinite(matrix[index])) {
      throw new QueryAdapterConfigError(`${source}: weights contain a non-finite value.`);
    }
  }

  const fingerprint = `qa1-${createHash("sha256")
    .update(`${QUERY_ADAPTER_FORMAT}\n${JSON.stringify([space.model, space.queryPrefix, space.documentPrefix, dimensions])}\n`)
    .update(bytes)
    .digest("hex")
    .slice(0, 16)}`;

  return Object.freeze({
    ...space,
    fingerprint,
    identity: buildEmbeddingIndexIdentity(space),
    matrix,
    training: document.training && typeof document.training === "object" ? document.training : null,
  });
};

/**
 * Serializes W (row-major, y = W q) into the file format parseQueryAdapter
 * reads. The Python trainer writes the same layout; this is the reference.
 */
export const serializeQueryAdapter = ({ embedding, matrix, training = null }) => {
  const space = normalizeSpace(embedding);
  const bytes = Buffer.alloc(space.dimensions * space.dimensions * 4);

  for (let index = 0; index < space.dimensions * space.dimensions; index += 1) {
    bytes.writeFloatLE(Number(matrix[index]), index * 4);
  }

  return {
    embedding: space,
    format: QUERY_ADAPTER_FORMAT,
    training,
    weights: {
      cols: space.dimensions,
      data: bytes.toString("base64"),
      encoding: QUERY_ADAPTER_WEIGHT_ENCODING,
      layout: "row-major",
      rows: space.dimensions,
    },
  };
};

/**
 * The configured adapter, or null when RAG_EMBEDDING_QUERY_ADAPTER is unset.
 * Reloaded when the path, size or modification time changes (the trainer
 * replaces the file atomically). A file that cannot be read or parsed throws
 * here; the search path turns that into an unadapted search with a warning
 * (adaptQueryVectorForSearch) and the health report into an error.
 */
export const getConfiguredQueryAdapter = () => {
  const configuredPath = getEmbeddingQueryAdapterPath();

  if (!configuredPath) {
    return null;
  }

  const filePath = path.resolve(process.cwd(), configuredPath);
  let stat;

  try {
    stat = statSync(filePath);
  } catch (error) {
    throw new QueryAdapterConfigError(`RAG_EMBEDDING_QUERY_ADAPTER: cannot read ${filePath} (${error.code ?? error.message}).`);
  }

  if (loaded && loaded.filePath === filePath && loaded.size === stat.size && loaded.mtimeMs === stat.mtimeMs) {
    return loaded.adapter;
  }

  let adapter;

  try {
    adapter = parseQueryAdapter(readFileSync(filePath, "utf8"), { source: `RAG_EMBEDDING_QUERY_ADAPTER ${filePath}` });
  } catch (error) {
    throw error instanceof QueryAdapterConfigError
      ? error
      : new QueryAdapterConfigError(`RAG_EMBEDDING_QUERY_ADAPTER ${filePath}: ${error.message}`);
  }

  loaded = { adapter, filePath, mtimeMs: stat.mtimeMs, size: stat.size };
  return adapter;
};

/**
 * Records that the embedding model returned `vector` for a query in `space`
 * ({ model, queryPrefix, documentPrefix, dimensions }). Only openai.js calls
 * it: for the real embedding client always, for a configured stand-in
 * provider only when that provider opts in (allowQueryAdapter).
 */
export const markModelQueryVector = (vector, space) => {
  if (vector && typeof vector === "object") {
    modelVectorSpaces.set(vector, Object.freeze(normalizeSpace(space)));
  }

  return vector;
};

/** The space the embedding model produced `vector` in, or null. */
export const getModelQueryVectorSpace = (vector) =>
  vector && typeof vector === "object" ? modelVectorSpaces.get(vector) ?? null : null;

const skip = (reason, detail) => {
  if (!warnedSkips.has(reason)) {
    warnedSkips.add(reason);
    console.warn(`RAG_EMBEDDING_QUERY_ADAPTER not applied (${reason}): ${detail} Searching with the unadapted query vector.`);
  }

  return null;
};

/**
 * For one search: `{ fingerprint, rankVector }` when the configured adapter
 * applies (the conditions at the top of this file), otherwise null and the
 * search uses `queryVector` as is. Never throws: a broken or mismatched
 * adapter degrades to the unadapted search with a one-time warning.
 *
 * `hybrid`: the search runs the hybrid route, `fusion` its fusion method.
 * `supportsScoreVector`: the store can rank by one vector and report the
 * cosine of another.
 */
export const adaptQueryVectorForSearch = ({ docIds, fusion = "rrf", hybrid, queryVector, scope, supportsScoreVector }) => {
  if (scope !== QUERY_ADAPTER_SCOPE_QA || !getEmbeddingQueryAdapterPath()) {
    return null;
  }

  if (!Array.isArray(docIds) || docIds.length !== 1) {
    return null;
  }

  if (!hybrid) {
    return skip("route_not_hybrid", "it was measured on the hybrid route only; the dense-only route measured worse.");
  }

  if (fusion !== "rrf") {
    return skip("fusion_not_rrf", `it was measured with RRF fusion; RAG_HYBRID_FUSION=${fusion} was not.`);
  }

  if (!supportsScoreVector) {
    return skip(
      "store_cannot_keep_model_cosine",
      "this vector store cannot rank by the adapted vector while scoring with the model's cosine (local and pgvector can)."
    );
  }

  const space = getModelQueryVectorSpace(queryVector);

  if (!space) {
    return skip("not_a_model_vector", "the query vector did not come from the embedding model (a stand-in provider).");
  }

  let adapter;

  try {
    adapter = getConfiguredQueryAdapter();
  } catch (error) {
    return skip("adapter_unavailable", `${error.message}`);
  }

  if (!isSameSpace(adapter, space)) {
    return skip(
      "space_mismatch",
      `it was trained for ${describeSpace(adapter)}; the query was embedded in ${describeSpace(space)}.`
    );
  }

  const memo = adaptedByModelVector.get(queryVector);

  if (memo?.fingerprint === adapter.fingerprint) {
    return { fingerprint: adapter.fingerprint, rankVector: memo.vector };
  }

  const rankVector = applyQueryAdapter(adapter, queryVector);

  adaptedByModelVector.set(queryVector, { fingerprint: adapter.fingerprint, vector: rankVector });
  return { fingerprint: adapter.fingerprint, rankVector };
};

/** W q, scaled back to the length of q (cosine search only reads direction). */
export const applyQueryAdapter = (adapter, vector) => {
  const dimensions = adapter.dimensions;

  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
    throw new QueryAdapterConfigError("Query embedding is not a vector; the adapter cannot be applied.");
  }

  if (vector.length !== dimensions) {
    throw new QueryAdapterConfigError(
      `Query embedding has ${vector.length} dimensions; adapter ${adapter.fingerprint} expects ${dimensions}.`,
      { code: "QUERY_ADAPTER_MISMATCH" }
    );
  }

  const input = Array.from(vector, (value) => Number(value) || 0);
  const output = new Array(dimensions);
  let inputNorm = 0;
  let outputNorm = 0;

  for (let row = 0; row < dimensions; row += 1) {
    const offset = row * dimensions;
    let sum = 0;

    for (let column = 0; column < dimensions; column += 1) {
      sum += adapter.matrix[offset + column] * input[column];
    }

    output[row] = sum;
    outputNorm += sum * sum;
    inputNorm += input[row] * input[row];
  }

  const scale = outputNorm > 0 ? Math.sqrt(inputNorm / outputNorm) : 0;
  const adapted = output.map((value) => value * scale);

  adaptedVectors.set(adapted, adapter.fingerprint);
  return adapted;
};

/** The fingerprint of the adapter that produced `vector`, or null. */
export const getQueryVectorAdapterFingerprint = (vector) =>
  vector && typeof vector === "object" ? adaptedVectors.get(vector) ?? null : null;

/** The configured adapter's public description (reports, health), or null. */
export const describeQueryAdapter = () => {
  const adapter = getConfiguredQueryAdapter();

  return adapter
    ? {
        dimensions: adapter.dimensions,
        documentPrefix: adapter.documentPrefix,
        fingerprint: adapter.fingerprint,
        identity: adapter.identity,
        model: adapter.model,
        queryPrefix: adapter.queryPrefix,
      }
    : null;
};

/**
 * The configured adapter's fingerprint for evaluation reports, or null when
 * none is configured. A configured file that cannot be used is reported as
 * `unavailable:<code>` (searches then run unadapted), never thrown, so two
 * reports can be refused as a pair when this field differs.
 */
export const getQueryAdapterReportFingerprint = () => {
  if (!getEmbeddingQueryAdapterPath()) {
    return null;
  }

  try {
    return getConfiguredQueryAdapter().fingerprint;
  } catch (error) {
    return `unavailable:${error.code ?? "QUERY_ADAPTER_INVALID"}`;
  }
};

/**
 * Two evaluation reports may be paired only when the same adapter (or none)
 * shaped both; a report written before this field existed counts as none.
 */
export const assertSameQueryAdapterFingerprint = (current, other, { label = "the other report" } = {}) => {
  const left = current ?? null;
  const right = other ?? null;

  if (left !== right) {
    throw new QueryAdapterConfigError(
      `This run's query adapter is ${JSON.stringify(left)} but ${label} was made with ${JSON.stringify(right)}; a paired difference would mix the adapter into whatever else changed. Rerun one side with the same RAG_EMBEDDING_QUERY_ADAPTER.`,
      { code: "QUERY_ADAPTER_MISMATCH" }
    );
  }
};

/**
 * checks.queryAdapter of the health report. An adapter file that cannot be
 * read or parsed is an error (STARTUP_HEALTH_STRICT fails startup); settings
 * under which it would never apply are warnings, since searches then run
 * unadapted, which is the default behaviour.
 */
export const describeQueryAdapterHealth = ({ fusion = "rrf", hybrid, supportsScoreVector }) => {
  const configuredPath = getEmbeddingQueryAdapterPath();

  if (!configuredPath) {
    return { status: "disabled", message: "RAG_EMBEDDING_QUERY_ADAPTER is not set; query vectors are used as the model returns them." };
  }

  let adapter;

  try {
    adapter = getConfiguredQueryAdapter();
  } catch (error) {
    return { status: "error", code: error.code ?? "QUERY_ADAPTER_INVALID", message: error.message };
  }

  const configured = getConfiguredSpace();
  const warnings = [];
  const messages = [];

  if (!isSameSpace(adapter, configured)) {
    warnings.push("space_mismatch");
    messages.push(
      `It was trained for ${describeSpace(adapter)} but the configured space is ${describeSpace(configured)}; it applies only to queries embedded in its own space (an index version pinned to it).`
    );
  }

  if (!hybrid) {
    warnings.push("route_not_hybrid");
    messages.push("The retrieval route is not hybrid, where it was measured; it is not applied.");
  } else if (fusion !== "rrf") {
    warnings.push("fusion_not_rrf");
    messages.push(`Hybrid fusion is ${fusion}, not the RRF it was measured with; it is not applied.`);
  }

  if (!supportsScoreVector) {
    warnings.push("store_cannot_keep_model_cosine");
    messages.push("This vector store cannot keep the model's cosine as vectorScore under an adapted ranking; it is not applied.");
  }

  return {
    status: "ok",
    fingerprint: adapter.fingerprint,
    identity: adapter.identity,
    scope: QUERY_ADAPTER_SCOPE_QA,
    message: messages.length > 0
      ? messages.join(" ")
      : "Applied to single-document QA retrieval on the hybrid route; everything else searches unadapted.",
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

/**
 * Stamps a search's dense route with the adapter that ranked it:
 * `routes.dense.queryAdapter` on the route summary and
 * `provenance.queryAdapter` on every result the dense route ranked. Nothing
 * is added without a fingerprint, so the unadapted shape is unchanged.
 */
export const stampQueryAdapterProvenance = (search, fingerprint) => {
  if (!fingerprint || !search?.routes?.dense?.executed) {
    return search;
  }

  return {
    ...search,
    results: (search.results ?? []).map((result) =>
      (result?.provenance?.routes ?? []).some((route) => route?.route === "dense")
        ? { ...result, provenance: { ...result.provenance, queryAdapter: fingerprint } }
        : result
    ),
    routes: { ...search.routes, dense: { ...search.routes.dense, queryAdapter: fingerprint } },
  };
};

export const resetQueryAdapter = () => {
  loaded = null;
  adaptedVectors = new WeakMap();
  adaptedByModelVector = new WeakMap();
  modelVectorSpaces = new WeakMap();
  warnedSkips = new Set();
};
