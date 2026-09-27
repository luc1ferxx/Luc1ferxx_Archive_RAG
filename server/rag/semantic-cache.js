import { createHash, randomUUID } from "node:crypto";
import { getActiveAnswerPromptDescriptors } from "./answer-writer.js";
import {
  getChatFallbackModel,
  getChatModel,
  getSemanticCacheMaxBytes,
  getSemanticCacheMaxEntries,
  getSemanticCacheThreshold,
  getSemanticCacheTtlMs,
  getVectorStoreProviderConfigStatus,
  isSemanticCacheEnabled,
} from "./config.js";
import { onDocumentStoreChange } from "./doc-registry.js";
import { getQueryVectorEmbeddingSpace } from "./embedding-cache.js";
import { hashPromptSet } from "./prompt-registry.js";
import { getQueryVectorAdapterFingerprint } from "./query-adapter.js";
import { analyzeCacheQuestion, compareCacheQuestions } from "./semantic-cache-guard.js";
import { addActiveSpanEvent } from "./tracing.js";
import { readIndexVersionSnapshot } from "./vector-store-pgvector-versions.js";
import { getPgvectorRuntime } from "./vector-store-pgvector-runtime.js";

// The semantic answer cache: opt-in (RAG_SEMANTIC_CACHE=on), per process.
//
// It sits at the answer seam, executeDocumentRag (document-rag-execution.js),
// which both /chat (through the agent's document_rag step) and MCP
// archive_ask reach through ragService.chat. A lookup runs after routing and
// the query embedding (the vector retrieval would use anyway, so a lookup
// costs no extra model call) and before retrieval; a hit returns the stored
// document RAG response and skips retrieval and the answer model.
//
// Nothing crosses a key. The key is a digest of: the tenant (userId and
// workspaceId, as the request's access scope names them), the exact doc id
// set with each document's content version (version, content hash, update
// and upload time, chunk count), the active index version (pgvector version
// id and pointer generation, or the provider), the query embedding space, the
// query adapter that shaped the vector (its fingerprint: an adapter retrained
// in place moves every lookup to a new key), the active answer prompt
// fingerprints, the chat and fallback models, the answer mode (route mode and requirement count), the shape of an agent
// retrieval plan with the question taken out, the long-term memory
// preference block, and the retrieval/answer configuration (RAG_*, OPENAI_*
// and store settings, secrets excluded). Within a key, a hit needs the query
// embeddings' cosine similarity at or above RAG_SEMANTIC_CACHE_THRESHOLD
// (default 0.97) AND the lexical guard (semantic-cache-guard.js), because the
// embedding alone scores negations and role swaps above paraphrases. The guard
// compares the resolved retrieval question and, when a session rewrite made
// it differ from what the user typed, the raw question too: the answer prompt
// answers the raw question ("Answer in Chinese: and for contractors?").
//
// Invalidation. A replaced or re-ingested document has another content
// version, and an index version switch another index key, so older entries
// can no longer be reached; they are also purged eagerly: ingest, replace,
// delete and clear call invalidateSemanticCacheDocuments, and a lookup that
// sees a document version or an index version this process has not seen
// before drops every entry built on the old one; a registry read that finds a
// document gone or replaced by another instance (doc-registry.js
// onDocumentStoreChange) drops its entries at once. Expired entries are swept
// on every lookup and store.
//
// Bounds: RAG_SEMANTIC_CACHE_MAX_ENTRIES entries and
// RAG_SEMANTIC_CACHE_MAX_BYTES of stored response JSON, least recently used
// out first. retrievedContexts (chunk text) are kept only when the storing
// request asked for them, and an entry without them never serves a request
// that asks for them.
//
// A hit is marked on the response: `semanticCache.hit`, and a `retrieval`
// block with `servedFromCache: true` and no route executed, so an evaluation
// report cannot present a cached answer as a fresh retrieval.
//
// Only answers are stored. An abstention is not: the gate or the answer model
// refused, and a cached refusal would outlive the reason for it.
//
// Why only in process: the value is latency on repeated questions, the entries
// hold tenant document text (answers, citations, retrieved contexts), and a
// PostgreSQL copy would add a tenant-owned table with RLS policies, retention
// and delete-on-document-delete for a cache whose correctness does not need
// sharing (every key part is read fresh per request). The cost is a lower hit
// rate with several instances.

const CACHE_SCHEMA = "semantic-cache/v2";

// Configuration that changes retrieval or the answer goes into the key.
// Timeouts, caches, observability, ingest tuning and secrets do not.
const CONFIG_ENV_PREFIXES = ["RAG_", "OPENAI_", "VECTOR_STORE_", "QDRANT_", "EMBEDDING_", "PDF_", "DOCLING_"];
const CONFIG_ENV_EXCLUDED_PREFIXES = [
  "RAG_SEMANTIC_CACHE",
  "RAG_OBSERVABILITY",
  "RAG_EMBEDDING_CACHE",
  "RAG_LLM_",
  "RAG_INGEST_",
  "RAG_DATA_DIRECTORY",
  "RAG_SHARED_STATE",
];
const SECRET_ENV_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

const createState = () => ({
  // entryId -> entry, in LRU order (oldest first).
  entries: new Map(),
  // key digest -> Set(entryId)
  buckets: new Map(),
  // docId -> Set(entryId)
  entriesByDocument: new Map(),
  // docId -> the content version this process last saw
  documentVersions: new Map(),
  indexVersionKey: null,
  // Sum of the stored entries' `bytes`.
  bytes: 0,
  stats: {
    bypasses: 0,
    evictions: 0,
    expirations: 0,
    guardRejections: {},
    hits: 0,
    invalidations: 0,
    lookups: 0,
    misses: 0,
    stores: 0,
  },
});

let state = createState();

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const round = (value, digits = 4) => Number(Number(value).toFixed(digits));

const normalizeQuestionText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toTenantKey = (accessScope) =>
  `${String(accessScope?.userId ?? "").trim()}\u0000${String(accessScope?.workspaceId ?? "").trim()}`;

const describeDocumentVersion = (document = {}) =>
  [
    `v${document.version ?? ""}`,
    document.contentSha256 ?? "",
    document.updatedAt ?? "",
    document.uploadedAt ?? "",
    document.chunkCount ?? "",
  ].join(":");

const buildConfigFingerprint = () =>
  sha256(
    JSON.stringify(
      Object.keys(process.env)
        .filter(
          (name) =>
            CONFIG_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
            !CONFIG_ENV_EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
            !SECRET_ENV_PATTERN.test(name)
        )
        .sort()
        .map((name) => [name, process.env[name]])
    )
  );

/**
 * The shape of an agent retrieval plan with the question itself taken out,
 * so two phrasings of one question share a key when the planner built the
 * same plan around them. Null for a plan that is not the primary one: a
 * follow-up plan is built from the gaps of an earlier answer, not from the
 * question, and is never cached.
 */
export const describeRetrievalPlanShape = (plan, query) => {
  if (!plan) {
    return "none";
  }

  if (String(plan.phase ?? "primary") !== "primary") {
    return null;
  }

  const question = normalizeQuestionText(query);

  return JSON.stringify({
    intent: plan.intent ?? null,
    options: plan.retrievalOptions ?? null,
    phase: plan.phase ?? "primary",
    queries: (plan.retrievalQueries ?? []).map((retrievalQuery) => ({
      id: retrievalQuery.id,
      primary: Boolean(retrievalQuery.primary),
      template: question
        ? normalizeQuestionText(retrievalQuery.query).split(question).join("\u0000Q\u0000")
        : normalizeQuestionText(retrievalQuery.query),
    })),
    source: plan.source ?? null,
  });
};

const resolveIndexVersionKey = async (queryVector) => {
  const space = getQueryVectorEmbeddingSpace(queryVector);
  const adapter = getQueryVectorAdapterFingerprint(queryVector) ?? "no-adapter";
  const spaceKey = `${space ? `${space.key}|${space.queryPrefix ?? ""}` : "untagged-space"}|${adapter}`;
  const provider = getVectorStoreProviderConfigStatus();

  if (!provider.valid) {
    return null;
  }

  if (provider.provider !== "pgvector") {
    return `${provider.provider}|${spaceKey}`;
  }

  if (!getPgvectorRuntime().isConfigured()) {
    return `pgvector:unconfigured|${spaceKey}`;
  }

  const snapshot = await readIndexVersionSnapshot();

  return `pgvector:v${snapshot.active.versionId}:g${snapshot.generation}|${spaceKey}`;
};

const toUnitVector = (vector) => {
  if (!vector || typeof vector.length !== "number" || vector.length === 0) {
    return null;
  }

  const unit = Float32Array.from(vector, (value) => Number(value) || 0);
  let norm = 0;

  for (const value of unit) {
    norm += value * value;
  }

  if (!(norm > 0)) {
    return null;
  }

  const scale = 1 / Math.sqrt(norm);

  for (let index = 0; index < unit.length; index += 1) {
    unit[index] *= scale;
  }

  return unit;
};

const dot = (left, right) => {
  if (left.length !== right.length) {
    return -1;
  }

  let sum = 0;

  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index];
  }

  return sum;
};

const removeEntry = (entryId) => {
  const entry = state.entries.get(entryId);

  if (!entry) {
    return false;
  }

  state.entries.delete(entryId);
  state.bytes -= entry.bytes ?? 0;

  const bucket = state.buckets.get(entry.keyDigest);

  bucket?.delete(entryId);

  if (bucket && bucket.size === 0) {
    state.buckets.delete(entry.keyDigest);
  }

  for (const docId of entry.docIds) {
    const entries = state.entriesByDocument.get(docId);

    entries?.delete(entryId);

    if (entries && entries.size === 0) {
      state.entriesByDocument.delete(docId);
    }
  }

  return true;
};

/** Drops every entry whose answer came from any of these documents. */
export const invalidateSemanticCacheDocuments = (docIds = []) => {
  let removed = 0;

  for (const docId of new Set((Array.isArray(docIds) ? docIds : [docIds]).map(String))) {
    for (const entryId of [...(state.entriesByDocument.get(docId) ?? [])]) {
      removed += removeEntry(entryId) ? 1 : 0;
    }

    state.documentVersions.delete(docId);
  }

  state.stats.invalidations += removed;
  return removed;
};

export const clearSemanticCache = () => {
  const removed = state.entries.size;

  state.entries.clear();
  state.bytes = 0;
  state.buckets.clear();
  state.entriesByDocument.clear();
  state.documentVersions.clear();
  state.indexVersionKey = null;
  state.stats.invalidations += removed;
  return removed;
};

/** For tests: forget every entry and every counter. */
export const resetSemanticCache = () => {
  state = createState();
};

export const getSemanticCacheStats = () => ({
  ...state.stats,
  guardRejections: { ...state.stats.guardRejections },
  bytes: state.bytes,
  entries: state.entries.size,
  enabled: isSemanticCacheEnabled(),
  maxBytes: getSemanticCacheMaxBytes(),
  maxEntries: getSemanticCacheMaxEntries(),
  threshold: getSemanticCacheThreshold(),
  ttlMs: getSemanticCacheTtlMs(),
});

// A process that sees a new document version or index version drops what was
// built on the old one.
const reconcileVersions = ({ documentVersions, indexVersionKey }) => {
  if (state.indexVersionKey !== null && state.indexVersionKey !== indexVersionKey) {
    for (const [entryId, entry] of [...state.entries]) {
      if (entry.indexVersionKey !== indexVersionKey) {
        state.stats.invalidations += removeEntry(entryId) ? 1 : 0;
      }
    }
  }

  state.indexVersionKey = indexVersionKey;

  for (const [docId, version] of documentVersions) {
    const known = state.documentVersions.get(docId);

    if (known !== undefined && known !== version) {
      invalidateSemanticCacheDocuments([docId]);
    }

    state.documentVersions.set(docId, version);
  }
};

const isExpired = (entry, now) => entry.expiresAt !== null && now >= entry.expiresAt;

// Every expired entry, not only those in the bucket a lookup scans: an entry
// holds tenant document text and should not outlive its TTL in a quiet key.
const sweepExpired = (now) => {
  for (const [entryId, entry] of [...state.entries]) {
    if (isExpired(entry, now) && removeEntry(entryId)) {
      state.stats.expirations += 1;
    }
  }
};

// A hit ran no retrieval: say so where evaluation reports and the /chat
// retrieval block look, so it never counts as a fresh retrieval.
const markServedFromCache = (retrieval = {}) => ({
  ...retrieval,
  queryCount: 0,
  routes: Object.fromEntries(
    Object.entries(retrieval?.routes ?? {}).map(([route, summary]) => [
      route,
      { ...summary, candidateCount: 0, executed: false, queryCount: 0 },
    ])
  ),
  servedFromCache: true,
});

// Another instance deleted or replaced these documents (a registry read saw it).
onDocumentStoreChange((docIds) => {
  invalidateSemanticCacheDocuments(docIds);
});

const bypass = (reason) => {
  state.stats.bypasses += 1;
  return { bypass: reason, trace: { enabled: true, hit: false, bypass: reason } };
};

/**
 * Looks the question up. Null when the cache is off. Otherwise one of
 * `{ bypass, trace }` (this request is neither served nor stored),
 * `{ hit: true, response, trace }` or `{ hit: false, pending, trace }`, where
 * `pending` is what storeSemanticCacheAnswer needs after the RAG run.
 */
export const lookupSemanticCache = async ({
  accessScope,
  agentRetrievalPlan = null,
  docIds = [],
  includeRetrievedContexts = false,
  preferenceBlock = "",
  query,
  queryVector,
  requirementCount = 1,
  resolvedQuery,
  routeMode,
  selectedDocuments = [],
} = {}) => {
  if (!isSemanticCacheEnabled()) {
    return null;
  }

  state.stats.lookups += 1;
  sweepExpired(Date.now());

  // A caller that does not say whose request this is gets no cache: an
  // unscoped key would be shared by every tenant.
  if (!accessScope || typeof accessScope !== "object") {
    return bypass("no_access_scope");
  }

  const planShape = describeRetrievalPlanShape(agentRetrievalPlan, query);

  if (planShape === null) {
    return bypass("follow_up_plan");
  }

  const documentsById = new Map((selectedDocuments ?? []).map((document) => [String(document?.docId), document]));
  const sortedDocIds = [...new Set((docIds ?? []).map(String))].sort();
  const documentVersions = new Map();

  for (const docId of sortedDocIds) {
    const document = documentsById.get(docId);

    if (!document) {
      return bypass("unknown_document_version");
    }

    documentVersions.set(docId, describeDocumentVersion(document));
  }

  if (sortedDocIds.length === 0) {
    return bypass("no_documents");
  }

  const vector = toUnitVector(queryVector);

  if (!vector) {
    return bypass("no_query_vector");
  }

  let indexVersionKey;

  try {
    indexVersionKey = await resolveIndexVersionKey(queryVector);
  } catch {
    indexVersionKey = null;
  }

  if (!indexVersionKey) {
    return bypass("index_version_unavailable");
  }

  const keyDigest = sha256(
    JSON.stringify({
      answerMode: { requirementCount: Number(requirementCount) || 1, routeMode: String(routeMode ?? "") },
      chatModels: [getChatModel(), getChatFallbackModel()],
      config: buildConfigFingerprint(),
      documents: [...documentVersions.entries()],
      indexVersionKey,
      plan: planShape,
      preference: sha256(String(preferenceBlock ?? "")),
      prompts: hashPromptSet(getActiveAnswerPromptDescriptors()),
      schema: CACHE_SCHEMA,
      tenant: toTenantKey(accessScope),
    })
  );

  reconcileVersions({ documentVersions, indexVersionKey });

  const question = normalizeQuestionText(resolvedQuery ?? query);
  const analysis = analyzeCacheQuestion(question);
  // What the user typed; the answer prompt answers this one.
  const rawQuestion = normalizeQuestionText(query ?? resolvedQuery);
  const rawAnalysis = rawQuestion === question ? analysis : analyzeCacheQuestion(rawQuestion);
  const threshold = getSemanticCacheThreshold();
  const now = Date.now();
  const candidates = [];
  let bestSimilarity = null;
  let withoutContexts = 0;

  for (const entryId of [...(state.buckets.get(keyDigest) ?? [])]) {
    const entry = state.entries.get(entryId);

    if (!entry) {
      continue;
    }

    if (includeRetrievedContexts && !entry.hasRetrievedContexts) {
      withoutContexts += 1;
      continue;
    }

    const similarity = dot(vector, entry.vector);

    bestSimilarity = bestSimilarity === null ? similarity : Math.max(bestSimilarity, similarity);

    if (similarity >= threshold) {
      candidates.push({ entry, similarity });
    }
  }

  candidates.sort((left, right) => right.similarity - left.similarity);

  const guardRejections = [];

  for (const { entry, similarity } of candidates) {
    let verdict = compareCacheQuestions(analysis, entry.analysis);

    // The resolved questions match; when either side was rewritten from what
    // its user typed, what they typed must match too.
    if (verdict.ok && (rawQuestion !== question || entry.rawQuestion !== entry.question)) {
      const rawVerdict = compareCacheQuestions(rawAnalysis, entry.rawAnalysis);

      verdict = rawVerdict.ok ? rawVerdict : { ...rawVerdict, reason: `raw_${rawVerdict.reason}` };
    }

    if (!verdict.ok) {
      guardRejections.push(verdict.reason);
      state.stats.guardRejections[verdict.reason] = (state.stats.guardRejections[verdict.reason] ?? 0) + 1;
      continue;
    }

    // Most recently used goes last.
    state.entries.delete(entry.id);
    state.entries.set(entry.id, entry);
    state.stats.hits += 1;

    const ageMs = now - entry.createdAt;
    const response = structuredClone(entry.response);

    // Numbers only: never the question or the answer on a span.
    addActiveSpanEvent("rag.semantic_cache.hit", {
      "rag.semantic_cache.similarity": round(similarity),
      "rag.semantic_cache.age_ms": ageMs,
    });

    response.semanticCache = { hit: true, similarity: round(similarity), ageMs };
    response.retrieval = markServedFromCache(response.retrieval);

    return {
      hit: true,
      response,
      trace: {
        enabled: true,
        hit: true,
        similarity: round(similarity),
        threshold,
        ageMs,
        entryId: entry.id,
        candidateCount: candidates.length,
        guardRejections,
      },
    };
  }

  state.stats.misses += 1;

  return {
    hit: false,
    pending: {
      analysis,
      docIds: sortedDocIds,
      documentVersions,
      includeRetrievedContexts: Boolean(includeRetrievedContexts),
      indexVersionKey,
      keyDigest,
      question,
      rawAnalysis,
      rawQuestion,
      vector,
    },
    trace: {
      enabled: true,
      hit: false,
      bestSimilarity: bestSimilarity === null ? null : round(bestSimilarity),
      threshold,
      candidateCount: candidates.length,
      guardRejections,
      ...(withoutContexts > 0 ? { entriesWithoutContexts: withoutContexts } : {}),
    },
  };
};

/**
 * Stores the answer a missed lookup went on to produce. Abstentions and
 * responses that cannot be cloned are not stored. Returns the trace fields to
 * add to the lookup's trace.
 */
export const storeSemanticCacheAnswer = (lookup, response) => {
  if (lookup?.bypass) {
    return {};
  }

  if (!lookup?.pending || !isSemanticCacheEnabled()) {
    return { stored: false, storeSkipReason: "not_pending" };
  }

  if (!response || response.abstained) {
    return { stored: false, storeSkipReason: "abstained" };
  }

  let snapshot;

  try {
    snapshot = structuredClone(response);
  } catch {
    return { stored: false, storeSkipReason: "not_cloneable" };
  }

  const {
    analysis,
    docIds,
    documentVersions,
    includeRetrievedContexts,
    indexVersionKey,
    keyDigest,
    question,
    rawAnalysis,
    rawQuestion,
    vector,
  } = lookup.pending;

  // Chunk text stays only for a caller that asked for it (the agent's
  // document step does; MCP archive_ask does not).
  if (!includeRetrievedContexts) {
    delete snapshot.retrievedContexts;
  }

  let bytes;

  try {
    bytes = Buffer.byteLength(JSON.stringify(snapshot));
  } catch {
    return { stored: false, storeSkipReason: "not_serializable" };
  }

  const maxBytes = getSemanticCacheMaxBytes();

  if (bytes > maxBytes) {
    return { stored: false, storeSkipReason: "too_large" };
  }

  const now = Date.now();

  sweepExpired(now);

  // An answer that was being written while its index version switched, or
  // while one of its documents was replaced or deleted, is not stored: its key
  // names what it was built on, which is no longer current.
  if (state.indexVersionKey !== null && state.indexVersionKey !== indexVersionKey) {
    return { stored: false, storeSkipReason: "index_version_changed" };
  }

  for (const [docId, version] of documentVersions) {
    if (state.documentVersions.get(docId) !== version) {
      return { stored: false, storeSkipReason: "document_version_changed" };
    }
  }

  // One entry per question text in a bucket: a concurrent duplicate replaces it.
  for (const entryId of [...(state.buckets.get(keyDigest) ?? [])]) {
    const existing = state.entries.get(entryId);

    if (existing?.question === question && existing.rawQuestion === rawQuestion) {
      removeEntry(entryId);
    }
  }

  const ttlMs = getSemanticCacheTtlMs();
  const entry = {
    analysis,
    bytes,
    createdAt: now,
    docIds,
    expiresAt: ttlMs > 0 ? now + ttlMs : null,
    hasRetrievedContexts: Array.isArray(snapshot.retrievedContexts),
    id: randomUUID(),
    indexVersionKey,
    keyDigest,
    question,
    rawAnalysis,
    rawQuestion,
    response: snapshot,
    vector,
  };

  state.entries.set(entry.id, entry);
  state.bytes += bytes;

  const bucket = state.buckets.get(keyDigest) ?? new Set();

  bucket.add(entry.id);
  state.buckets.set(keyDigest, bucket);

  for (const docId of docIds) {
    const entries = state.entriesByDocument.get(docId) ?? new Set();

    entries.add(entry.id);
    state.entriesByDocument.set(docId, entries);
  }

  state.stats.stores += 1;

  const maxEntries = getSemanticCacheMaxEntries();

  while (state.entries.size > maxEntries || state.bytes > maxBytes) {
    removeEntry(state.entries.keys().next().value);
    state.stats.evictions += 1;
  }

  return { stored: true, entryId: entry.id };
};
