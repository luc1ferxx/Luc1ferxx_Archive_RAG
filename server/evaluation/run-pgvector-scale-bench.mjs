// run-pgvector-scale-bench.mjs
//
// How retrieval behaves as the pgvector chunk table grows, measured with the
// app's own schema and query code rather than hand-written SQL.
//
// Against a DISPOSABLE PostgreSQL database it runs the real migrations (so the
// real rag_document_chunks table, its HNSW index, the generated tsvector column
// and the GIN index exist exactly as production creates them), then loads
// synthetic data in nested steps (10k, 100k, 500k, 1M chunks by default): N
// documents x M chunks, clustered unit vectors, and text drawn from a fixed
// vocabulary so full-text search has terms to match. The rows are bulk loaded
// with multi-row INSERT ... SELECT unnest(...) into the real tables, with the
// embedding_model / embedding_dimensions values the app's search filters on
// (getEmbeddingIndexIdentity / getEmbeddingDimensions) and search_text built by
// the app's buildSearchText.
//
// Per size it reports:
//   load       append time for the new rows (HNSW and GIN dropped while
//              loading, btrees live) and the cumulative load time from empty
//   build      GIN and HNSW build time over the whole table, using the index
//              definitions the migrations created (read back from pg_indexes).
//              The build session raises maintenance_work_mem (sized so the HNSW
//              graph fits in memory) and max_parallel_maintenance_workers, and
//              records how many parallel workers pgvector actually used
//   disk       pg_total_relation_size and its heap / TOAST / per-index parts
//   latency    p50/p95 over a fixed, seeded query set for the dense route on 1
//              and on 100 documents (searchPgvectorDocuments), the sparse FTS
//              route (searchPgvectorSparseDocuments), and the hybrid path
//              through searchDocumentsWithRoutes -- all run the way the app
//              runs them: POSTGRES_ROW_LEVEL_SECURITY=enforce, inside
//              runWithDatabaseTenant, so every statement is its own transaction
//              under the tenant role. An unfiltered ORDER BY over the whole
//              table (direct SQL as the owner, not an app path) measures the
//              HNSW index on its own. Before a query's timed calls, one untimed
//              dense and one sparse read of its document set bring those rows
//              into memory, so every series is timed in the same warm state
//              (without it the first document-set series of each query paid the
//              cold read the later ones skipped); the priming reads are
//              reported separately.
//   recall     recall@K of the app's dense results against exact search: the
//              same captured statement re-run with enable_indexscan = off (so
//              no HNSW scan is possible), on every timed query for the
//              document-filtered series and on --recall-queries of them for
//              the whole-table series (whose exact search scans the table).
//   plans      EXPLAIN ANALYZE of each app statement under the tenant role.
//   ingest     one document written through writeDocumentsToPgvectorIndex in a
//              tenant transaction while the HNSW and GIN indexes are live
//              (embedding call excluded).
//
// Sizes run in ascending order and stop when the next one is projected (from
// the previous step's measured throughput) to overrun --time-budget-minutes;
// a skipped size is listed in the report with its projection, never dropped
// silently.
//
// Safety: the target database must be disposable. The run refuses to start if
// the documents or chunks table already holds rows, and truncates both at the
// end. It never reads server/.env. scripts/run-pgvector-scale-bench.sh creates
// a throwaway cluster, runs this, and deletes the cluster on exit.
//
// Usage:
//   bash scripts/run-pgvector-scale-bench.sh [-- <options>]
//   node evaluation/run-pgvector-scale-bench.mjs --database-url <url of a disposable db>
//     [--sizes 10k,100k,500k,1M] [--chunks-per-doc 50] [--dimensions 768]
//     [--clusters 256] [--noise 1] [--words-per-chunk 120] [--queries 100]
//     [--warmup 10] [--recall-queries 20] [--top-k 10] [--doc-set-size 100]
//     [--ingest-probes 3] [--time-budget-minutes 18] [--seed 20260926]
//     [--load-concurrency 8] [--batch-docs 20] [--parallel-maintenance-workers 8]
//     [--maintenance-work-mem-cap-mb 8192] [--latest-name latest-pgvector-scale]
//     [--iterative-scan relaxed_order|strict_order|off]
//     [--keep-data]   leave the last size loaded; with the wrapper's KEEP_CLUSTER=1
//                     the cluster stays up for EXPLAIN work afterwards

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

export const BENCH_SCOPE = Object.freeze({ userId: "bench-user", workspaceId: "bench-workspace" });
export const BENCH_EMBEDDING_MODEL = "synthetic-clustered-unit";
// Vector components are written as integers scaled by 1e-5 ("3612e-5"), which
// pgvector parses with strtof; a unit vector keeps its norm to about 1e-4.
export const VECTOR_SCALE = 1e5;
export const SERIES = Object.freeze([
  "dense_1doc",
  "dense_docset",
  "sparse_1doc",
  "sparse_docset",
  "hybrid_1doc",
  "hybrid_docset",
  "dense_unfiltered_sql",
]);
export const RECALL_SERIES = Object.freeze(["dense_1doc", "dense_docset", "dense_unfiltered_sql"]);
// Untimed-in-the-table reads that bring a query's document set into memory
// (heap, embedding TOAST, tsvector) before its timed series run.
export const PRIMING_SERIES = Object.freeze(["dense_docset", "sparse_docset"]);

// Bytes the in-memory HNSW graph takes per element beyond the vector itself
// (element header, level-0 neighbour list for m=16, heap tid). Used only to
// size maintenance_work_mem so the build stays in memory; if pgvector still
// reports the graph no longer fits, that notice is recorded in the report.
const HNSW_ELEMENT_OVERHEAD_BYTES = 1024;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** "10k" -> 10000, "1M" -> 1000000, "2500" -> 2500. */
export const parseSize = (value) => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(value ?? ""));

  if (!match) {
    throw new Error(`Invalid size "${value}"; use a number with an optional k or M suffix.`);
  }

  const multiplier = { "": 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[match[2]];
  const size = Math.round(Number(match[1]) * multiplier);

  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`Invalid size "${value}".`);
  }

  return size;
};

export const parseSizes = (value) =>
  [...new Set(String(value).split(",").filter((part) => part.trim()).map(parseSize))].sort(
    (left, right) => left - right
  );

const NUMERIC_OPTIONS = Object.freeze({
  "--batch-docs": "batchDocs",
  "--chunks-per-doc": "chunksPerDoc",
  "--clusters": "clusters",
  "--dimensions": "dimensions",
  "--doc-set-size": "docSetSize",
  "--ingest-probes": "ingestProbes",
  "--load-concurrency": "loadConcurrency",
  "--maintenance-work-mem-cap-mb": "maintenanceWorkMemCapMb",
  "--noise": "noise",
  "--parallel-maintenance-workers": "parallelMaintenanceWorkers",
  "--queries": "queries",
  "--recall-queries": "recallQueries",
  "--seed": "seed",
  "--time-budget-minutes": "timeBudgetMinutes",
  "--top-k": "topK",
  "--warmup": "warmup",
  "--words-per-chunk": "wordsPerChunk",
});
// A captured app search statement: it selects chunk ids and either carries its
// own LIMIT or hands the limit to the owner-run full-text rank function that
// tenant sparse searches go through (migration 014).
export const isSearchStatement = (sql) =>
  /chunk_id/.test(sql) && (/\bLIMIT\b/.test(sql) || /_sparse_rank\(/.test(sql));

// The app's RAG_PGVECTOR_ITERATIVE_SCAN values; `off` measures the plain statement.
const ITERATIVE_SCAN_CHOICES = Object.freeze(["relaxed_order", "strict_order", "off"]);
// Options that may legitimately be zero.
const ZERO_ALLOWED = new Set(["ingestProbes", "warmup", "recallQueries", "noise"]);

export const DEFAULT_OPTIONS = Object.freeze({
  batchDocs: 20,
  chunksPerDoc: 50,
  clusters: 256,
  databaseUrl: "",
  dimensions: 768,
  docSetSize: 100,
  ingestProbes: 3,
  iterativeScan: "relaxed_order",
  keepData: false,
  latestName: "latest-pgvector-scale",
  loadConcurrency: 8,
  maintenanceWorkMemCapMb: 8192,
  noise: 1,
  parallelMaintenanceWorkers: 8,
  queries: 100,
  recallQueries: 20,
  seed: 20260926,
  sizes: [10000, 100000, 500000, 1000000],
  timeBudgetMinutes: 18,
  topK: 10,
  warmup: 10,
  wordsPerChunk: 120,
});

export const parseArgs = (argv) => {
  const options = { ...DEFAULT_OPTIONS, sizes: [...DEFAULT_OPTIONS.sizes] };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === "--") {
      continue;
    }

    if (flag === "--keep-data") {
      options.keepData = true;
      continue;
    }

    if (value === undefined) {
      throw new Error(`Missing value for ${flag}.`);
    }

    index += 1;

    if (flag === "--database-url") {
      options.databaseUrl = String(value).trim();
    } else if (flag === "--sizes") {
      options.sizes = parseSizes(value);
    } else if (flag === "--latest-name") {
      options.latestName = String(value).trim();
    } else if (flag === "--iterative-scan") {
      options.iterativeScan = String(value).trim().toLowerCase();

      if (!ITERATIVE_SCAN_CHOICES.includes(options.iterativeScan)) {
        throw new Error(`--iterative-scan must be one of ${ITERATIVE_SCAN_CHOICES.join(", ")}.`);
      }
    } else if (NUMERIC_OPTIONS[flag]) {
      const key = NUMERIC_OPTIONS[flag];
      const parsed = Number(value);

      if (!Number.isFinite(parsed) || parsed < 0 || (parsed === 0 && !ZERO_ALLOWED.has(key))) {
        throw new Error(`${flag} must be a ${ZERO_ALLOWED.has(key) ? "non-negative" : "positive"} number.`);
      }

      options[key] = key === "noise" || key === "timeBudgetMinutes" ? parsed : Math.floor(parsed);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!options.databaseUrl) {
    throw new Error(
      "Pass --database-url for a DISPOSABLE database (scripts/run-pgvector-scale-bench.sh creates one). " +
        "POSTGRES_DATABASE_URL is deliberately not read."
    );
  }

  if (!/^[A-Za-z0-9_-]+$/.test(options.latestName)) {
    throw new Error("--latest-name must be a simple file stem.");
  }

  if (options.sizes.length === 0) {
    throw new Error("--sizes must name at least one size.");
  }

  options.recallQueries = Math.min(options.recallQueries, options.queries);

  return options;
};

// ---------------------------------------------------------------------------
// Seeded synthetic data
// ---------------------------------------------------------------------------

// mulberry32, as the QASPER harnesses sample with.
export const createSeededRandom = (seed) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A stable 32-bit seed for (seed, stream, index) so any document regenerates alone. */
export const deriveSeed = (seed, stream, index) => {
  let hash = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(stream + 1, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
};

/** Standard normal samples via Box-Muller; keeps the spare value. */
export const createGaussian = (random) => {
  let spare = null;

  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }

    const u = random() || Number.MIN_VALUE;
    const v = random();
    const radius = Math.sqrt(-2 * Math.log(u));

    spare = radius * Math.sin(2 * Math.PI * v);
    return radius * Math.cos(2 * Math.PI * v);
  };
};

export const normalizeVector = (vector) => {
  let sum = 0;

  for (let index = 0; index < vector.length; index += 1) {
    sum += vector[index] * vector[index];
  }

  const norm = Math.sqrt(sum) || 1;

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }

  return vector;
};

export const generateCentroids = ({ clusters, dimensions, seed }) => {
  const gaussian = createGaussian(createSeededRandom(deriveSeed(seed, 1, 0)));

  return Array.from({ length: clusters }, () => {
    const centroid = new Float64Array(dimensions);

    for (let index = 0; index < dimensions; index += 1) {
      centroid[index] = gaussian();
    }

    return normalizeVector(centroid);
  });
};

/**
 * A unit vector around `centroid`: centroid + noise * g / sqrt(d) with g
 * standard normal, normalized. With noise 1 the noise has about the centroid's
 * norm, so a member's cosine to its centroid is ~0.71 and two members of one
 * cluster sit at ~0.5, while unrelated clusters are near 0.
 */
export const generateClusteredVector = ({ centroid, gaussian, noise }) => {
  const scale = noise / Math.sqrt(centroid.length);
  const vector = new Float64Array(centroid.length);

  for (let index = 0; index < centroid.length; index += 1) {
    vector[index] = centroid[index] + scale * gaussian();
  }

  return normalizeVector(vector);
};

/** Quantized components, the exact values the database stores. */
export const quantizeVector = (vector) =>
  Array.from(vector, (value) => Math.round(value * VECTOR_SCALE) / VECTOR_SCALE || 0);

/** pgvector text input with integer mantissas ("[3612e-5,-18e-5]"). */
export const formatVectorLiteral = (vector) => {
  const parts = new Array(vector.length);

  for (let index = 0; index < vector.length; index += 1) {
    parts[index] = `${Math.round(vector[index] * VECTOR_SCALE)}e-5`;
  }

  return `[${parts.join(",")}]`;
};

export const cosineSimilarity = (left, right) => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
};

const CONSONANTS = "bdfgklmnprstvz";
const VOWELS = "aeiou";
const SYLLABLES = [...CONSONANTS].flatMap((consonant) => [...VOWELS].map((vowel) => `${consonant}${vowel}`));

/**
 * Deterministic three-syllable pseudo-words ("bakodi"). They survive the app's
 * tokenizer (no stop words, longer than one character) and PostgreSQL's
 * `simple` text search configuration unchanged.
 */
export const buildVocabulary = (size) => {
  const syllableCount = SYLLABLES.length;

  if (size > syllableCount ** 3) {
    throw new Error(`Vocabulary size ${size} exceeds ${syllableCount ** 3} distinct words.`);
  }

  return Array.from(
    { length: size },
    (_, index) =>
      SYLLABLES[index % syllableCount] +
      SYLLABLES[Math.floor(index / syllableCount) % syllableCount] +
      SYLLABLES[Math.floor(index / syllableCount ** 2) % syllableCount]
  );
};

export const VOCABULARY_SIZE = 5000;
export const TOPIC_WORDS_PER_CLUSTER = 40;
// Share of a chunk's words drawn from its document's topic.
export const TOPIC_WORD_SHARE = 0.25;

export const buildTopicWords = ({ clusters, seed, vocabulary, perCluster = TOPIC_WORDS_PER_CLUSTER }) =>
  Array.from({ length: clusters }, (_, cluster) => {
    const random = createSeededRandom(deriveSeed(seed, 2, cluster));
    const words = new Set();

    while (words.size < Math.min(perCluster, vocabulary.length)) {
      words.add(vocabulary[Math.floor(random() * vocabulary.length)]);
    }

    return [...words];
  });

/** General words are skewed toward the start of the vocabulary (a few very common terms). */
export const pickGeneralWord = (random, vocabulary) => vocabulary[Math.floor(vocabulary.length * random() ** 2)];

export const generateChunkText = ({ random, topicWords, vocabulary, words }) => {
  const parts = new Array(words);

  for (let index = 0; index < words; index += 1) {
    parts[index] =
      random() < TOPIC_WORD_SHARE
        ? topicWords[Math.floor(random() * topicWords.length)]
        : pickGeneralWord(random, vocabulary);
  }

  return parts.join(" ");
};

export const docIdFor = (docIndex) => `bench-doc-${String(docIndex).padStart(7, "0")}`;

export const clusterForDocument = ({ docIndex, clusters, seed }) => deriveSeed(seed, 3, docIndex) % clusters;

/**
 * Every chunk of one document, regenerated from (seed, docIndex) alone so the
 * nested sizes share their first documents byte for byte.
 */
export const generateDocumentChunks = ({ docIndex, chunksPerDoc, corpus }) => {
  const { centroids, clusters, noise, seed, topicWords, vocabulary, wordsPerChunk } = corpus;
  const random = createSeededRandom(deriveSeed(seed, 4, docIndex));
  const gaussian = createGaussian(random);
  const cluster = clusterForDocument({ clusters, docIndex, seed });
  const docId = docIdFor(docIndex);
  const fileName = `${docId}.pdf`;

  return Array.from({ length: chunksPerDoc }, (_, chunkIndex) => {
    const vector = generateClusteredVector({ centroid: centroids[cluster], gaussian, noise });

    return {
      chunkId: `${docId}:${chunkIndex}`,
      chunkIndex,
      cluster,
      content: generateChunkText({ random, topicWords: topicWords[cluster], vocabulary, words: wordsPerChunk }),
      docId,
      fileName,
      pageNumber: Math.floor(chunkIndex / 3) + 1,
      vector,
    };
  });
};

export const createCorpus = ({ clusters, dimensions, noise, seed, wordsPerChunk }) => {
  const vocabulary = buildVocabulary(VOCABULARY_SIZE);

  return {
    centroids: generateCentroids({ clusters, dimensions, seed }),
    clusters,
    noise,
    seed,
    topicWords: buildTopicWords({ clusters, seed, vocabulary }),
    vocabulary,
    wordsPerChunk,
  };
};

const sampleDistinct = ({ count, excluding, random, total }) => {
  const picked = new Set([excluding]);

  while (picked.size < Math.min(count, total)) {
    picked.add(Math.floor(random() * total));
  }

  return [...picked];
};

/**
 * The fixed query set for one size: each query targets a random document, its
 * vector is a fresh draw around that document's cluster centroid, its text is
 * three of the topic's words plus one general word, and its document set is
 * the target plus random others (docSetSize in total, or every document).
 */
export const buildQuerySet = ({ corpus, count, docCount, docSetSize, seed }) => {
  const random = createSeededRandom(deriveSeed(seed, 5, docCount));
  const gaussian = createGaussian(random);

  return Array.from({ length: count }, (_, queryIndex) => {
    const docIndex = Math.floor(random() * docCount);
    const cluster = clusterForDocument({ clusters: corpus.clusters, docIndex, seed: corpus.seed });
    const topic = corpus.topicWords[cluster];
    const words = new Set();

    while (words.size < Math.min(3, topic.length)) {
      words.add(topic[Math.floor(random() * topic.length)]);
    }

    words.add(pickGeneralWord(random, corpus.vocabulary));

    return {
      docId: docIdFor(docIndex),
      docSet: sampleDistinct({ count: docSetSize, excluding: docIndex, random, total: docCount }).map(docIdFor),
      id: queryIndex,
      text: [...words].join(" "),
      vector: quantizeVector(
        generateClusteredVector({ centroid: corpus.centroids[cluster], gaussian, noise: corpus.noise })
      ),
    };
  });
};

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentile: the smallest value with at least `fraction` of the sample at or below it. */
export const percentile = (values, fraction) => {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(Math.min(1, Math.max(0, fraction)) * sorted.length);

  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
};

export const round = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

export const summarizeLatencies = (values) => ({
  count: values.length,
  maxMs: round(values.length ? Math.max(...values) : null, 3),
  meanMs: round(values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, 3),
  p50Ms: round(percentile(values, 0.5), 3),
  p95Ms: round(percentile(values, 0.95), 3),
});

/**
 * |retrieved[:k] ∩ exact[:k]| / min(k, |exact|). An empty exact set (nothing
 * matched the filter) counts as full recall when nothing was retrieved either.
 */
export const recallAtK = (retrievedIds, exactIds, k) => {
  const exact = new Set(exactIds.slice(0, k));

  if (exact.size === 0) {
    return retrievedIds.length === 0 ? 1 : 0;
  }

  const hits = retrievedIds.slice(0, k).filter((id) => exact.has(id)).length;

  return hits / Math.min(k, exact.size);
};

/**
 * How many timed queries a recall series checks against exact search. The
 * document-filtered series check every timed query: their exact search reads
 * only the document set through the doc_id index, and a filtered HNSW scan
 * that comes back short can hit any query (a 20-query sample once reported
 * recall 1 next to 9.95 of 10 rows returned). The whole-table series checks
 * the first `recallQueries`, since each of its exact searches scans the table.
 * recallQueries 0 turns recall off.
 */
export const recallSampleSize = ({ options, series, timedQueries }) => {
  if (!RECALL_SERIES.includes(series) || !(options.recallQueries > 0)) {
    return 0;
  }

  return series === "dense_unfiltered_sql" ? Math.min(options.recallQueries, timedQueries) : timedQueries;
};

export const summarizeRecall = (recalls) => ({
  meanRecall: round(recalls.length ? recalls.reduce((sum, value) => sum + value, 0) / recalls.length : null, 4),
  minRecall: round(recalls.length ? Math.min(...recalls) : null, 4),
  queries: recalls.length,
  queriesBelowOne: recalls.filter((value) => value < 1).length,
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Projected wall time of the next step from the one before it: loading scales
 * with the rows appended, the GIN build and the measurement phase (whose exact
 * unfiltered searches scan the table) with table size, and the HNSW build with
 * n log n, times PROJECTION_SAFETY_FACTOR. Conservative on purpose; a
 * projection is only used to skip.
 */
// Headroom on every projection: index builds grow faster than n log n once the
// graph outgrows the CPU caches, and a step that overruns cannot be stopped.
export const PROJECTION_SAFETY_FACTOR = 1.2;

export const projectStepMs = ({ previous, loadedChunks, targetChunks }) => {
  if (!previous) {
    return null;
  }

  const deltaChunks = Math.max(0, targetChunks - loadedChunks);
  const growth = targetChunks / previous.chunks;
  const nLogN =
    (targetChunks * Math.log2(Math.max(2, targetChunks))) /
    (previous.chunks * Math.log2(Math.max(2, previous.chunks)));
  const loadPerChunk = previous.load.loadMs / Math.max(1, previous.load.deltaChunks);

  return Math.round(
    PROJECTION_SAFETY_FACTOR *
      (loadPerChunk * deltaChunks +
        (previous.load.analyzeMs ?? 0) * growth +
        previous.indexBuild.ginMs * growth +
        previous.indexBuild.hnswMs * nLogN +
        previous.measureMs * growth)
  );
};

export const decideSizeRun = ({ budgetMs, elapsedMs, projectedMs }) => {
  const remainingMs = Math.max(0, budgetMs - elapsedMs);

  if (projectedMs === null || projectedMs <= remainingMs) {
    return { run: true, projectedMs, remainingMs };
  }

  return {
    projectedMs,
    reason: `projected ${round(projectedMs / 60000, 1)} min exceeds the ${round(remainingMs / 60000, 1)} min left of the time budget`,
    remainingMs,
    run: false,
  };
};

// Session settings for the index builds (never for queries).
export const BUILD_MIN_PARALLEL_TABLE_SCAN_SIZE = "1MB";
export const GIN_MAINTENANCE_WORK_MEM_MB = 1024;

/**
 * Splits the messages a CREATE INDEX sent at client_min_messages = debug1:
 * the worker count (pgvector: "using N parallel workers"; core: "... with
 * request for N parallel workers"), and every NOTICE/WARNING verbatim, such as
 * pgvector's "hnsw graph no longer fits into maintenance_work_mem".
 */
export const summarizeBuildMessages = (messages) => {
  const find = (pattern) => {
    for (const { message } of messages) {
      const match = pattern.exec(message);

      if (match) {
        return Number(match[1]);
      }
    }

    return null;
  };
  const used = find(/using (\d+) parallel workers/);

  return {
    notices: messages
      .filter(({ severity }) => !/^DEBUG/i.test(severity) && !/^LOG$/i.test(severity))
      .map(({ message }) => message),
    parallelWorkers: used ?? find(/with request for (\d+) parallel workers/),
  };
};

/** maintenance_work_mem (MB) large enough to keep an n-element HNSW graph in memory. */
export const hnswMaintenanceWorkMemMb = ({ capMb, chunks, dimensions }) => {
  const bytes = chunks * (dimensions * 4 + 8 + HNSW_ELEMENT_OVERHEAD_BYTES) * 1.25;

  return Math.max(64, Math.min(capMb, Math.ceil(bytes / (1024 * 1024))));
};

// ---------------------------------------------------------------------------
// Plans and formatting
// ---------------------------------------------------------------------------

/** EXPLAIN (FORMAT JSON) output -> ["Limit", "Index Scan (idx) rows=10", ...] top-down. */
export const summarizePlan = (explainJson) => {
  const root = Array.isArray(explainJson) ? explainJson[0]?.Plan : explainJson?.Plan;
  const nodes = [];
  const visit = (node) => {
    if (!node) {
      return;
    }

    const label = node["Index Name"] ? `${node["Node Type"]} (${node["Index Name"]})` : node["Node Type"];
    const details = [
      node["Actual Rows"] !== undefined ? `rows=${node["Actual Rows"]}` : null,
      node["Rows Removed by Filter"] ? `filtered=${node["Rows Removed by Filter"]}` : null,
    ].filter(Boolean);

    nodes.push(details.length ? `${label} ${details.join(" ")}` : label);
    (node.Plans ?? []).forEach(visit);
  };

  visit(root);
  return nodes;
};

export const planUsesIndex = (nodes, indexName) => nodes.some((node) => node.includes(`(${indexName})`));

export const formatBytes = (bytes) => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return "n/a";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

export const formatCount = (value) => Number(value).toLocaleString("en-US");

const formatSeconds = (ms) => (ms === null || ms === undefined ? "n/a" : `${round(ms / 1000, 1)} s`);

const SERIES_LABELS = Object.freeze({
  dense_1doc: "dense, 1 document (searchPgvectorDocuments)",
  dense_docset: "dense, document set (searchPgvectorDocuments)",
  dense_unfiltered_sql: "dense, whole table, direct SQL as owner (index only)",
  hybrid_1doc: "hybrid RRF, 1 document (searchDocumentsWithRoutes)",
  hybrid_docset: "hybrid RRF, document set (searchDocumentsWithRoutes)",
  sparse_1doc: "sparse FTS, 1 document (searchPgvectorSparseDocuments)",
  sparse_docset: "sparse FTS, document set (searchPgvectorSparseDocuments)",
});

export const formatMarkdown = (report) => {
  const { config } = report;
  const lines = [
    "# pgvector scale benchmark",
    "",
    `Generated ${report.generatedAt} at commit \`${config.gitSha}\`${config.gitDirty ? " (uncommitted changes)" : ""}; PostgreSQL ${config.postgresVersion}, pgvector ${config.pgvectorVersion}.`,
    "",
    `Synthetic corpus: ${config.chunksPerDoc} chunks per document, ${config.dimensions}-dimension clustered unit vectors (${config.clusters} clusters, noise ${config.noise}), ${config.wordsPerChunk} words per chunk from a ${config.vocabularySize}-word vocabulary; seed ${config.seed}. Embedding identity \`${config.embeddingIdentity}\`.`,
    "",
    `App path: VECTOR_STORE_PROVIDER=pgvector, POSTGRES_ROW_LEVEL_SECURITY=${config.rowLevelSecurity} (tenant role \`${config.tenantRole}\`, one tenant owns every row), hybrid ${config.runtime.hybridEnabled ? `on (${config.runtime.hybridFusion})` : "off"}, top-K ${config.topK}, document set ${config.docSetSize}. ${config.queries} timed queries per series after ${config.warmup} warm-up queries, run one at a time; ${
      config.filteredRecallQueries === undefined
        ? `recall on ${config.recallQueries} of them`
        : `recall on ${config.filteredRecallQueries} of them with a document filter and on ${config.recallQueries} for the whole table`
    }.`,
    "",
    `HNSW: ${config.hnsw.indexDefinition}; hnsw.ef_search=${config.hnsw.efSearch}, ${
      config.hnsw.appIterativeScan
        ? `the app's dense route sets hnsw.iterative_scan=${config.hnsw.appIterativeScan} per query (server default ${config.hnsw.iterativeScan ?? "n/a"})`
        : `hnsw.iterative_scan=${config.hnsw.iterativeScan ?? "n/a"}`
    }. Server settings: ${Object.entries(config.serverSettings)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}.`,
    "",
  ];

  if (report.steps.length) {
    lines.push(
      "## Overview",
      "",
      "| Chunks | Docs | Load (cumulative) | GIN build | HNSW build | Total size | HNSW size | dense 1 doc p50/p95 ms | dense set p50/p95 ms | hybrid set p50/p95 ms | recall@K dense set (plan) | recall@K whole table (HNSW only) |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...report.steps.map((step) => {
        const latency = (series) => `${step.latency[series]?.p50Ms ?? "n/a"} / ${step.latency[series]?.p95Ms ?? "n/a"}`;
        // A recall of 1 from a plan that never touched the HNSW index is an
        // exact scan, not evidence about the index; say which one it was.
        const denseSetPlan = step.plans?.dense_docset;
        const denseSetRecall = `${step.recall.dense_docset?.meanRecall ?? "n/a"}${
          denseSetPlan ? ` (${denseSetPlan.usesHnsw ? "HNSW" : "exact, no HNSW"})` : ""
        }`;

        return `| ${formatCount(step.chunks)} | ${formatCount(step.documents)} | ${formatSeconds(step.load.cumulativeLoadMs)} | ${formatSeconds(step.indexBuild.ginMs)} | ${formatSeconds(step.indexBuild.hnswMs)} | ${formatBytes(step.disk.totalBytes)} | ${formatBytes(step.disk.hnswBytes)} | ${latency("dense_1doc")} | ${latency("dense_docset")} | ${latency("hybrid_docset")} | ${denseSetRecall} | ${step.recall.dense_unfiltered_sql?.meanRecall ?? "n/a"} |`;
      }),
      ""
    );
  }

  for (const step of report.steps) {
    lines.push(
      `## ${formatCount(step.chunks)} chunks (${formatCount(step.documents)} documents)`,
      "",
      `Load: ${formatCount(step.load.deltaChunks)} rows appended in ${formatSeconds(step.load.loadMs)} (${formatCount(step.load.rowsPerSecond)} rows/s), cumulative ${formatSeconds(step.load.cumulativeLoadMs)}; ANALYZE ${formatSeconds(step.load.analyzeMs)}. GIN build ${formatSeconds(step.indexBuild.ginMs)} (maintenance_work_mem ${step.indexBuild.ginMaintenanceWorkMemMb} MB, parallel workers ${step.indexBuild.ginParallelWorkers ?? "n/a"}); HNSW build ${formatSeconds(step.indexBuild.hnswMs)} (maintenance_work_mem ${step.indexBuild.maintenanceWorkMemMb} MB, parallel workers ${step.indexBuild.hnswParallelWorkers ?? "n/a"} of max_parallel_maintenance_workers ${step.indexBuild.maxParallelMaintenanceWorkers}, min_parallel_table_scan_size ${step.indexBuild.minParallelTableScanSize})${step.indexBuild.notices.length ? `; notices: ${step.indexBuild.notices.map((notice) => `"${notice}"`).join("; ")}` : ""}. Schema verification (ensurePgvectorSchema, forced) ${formatSeconds(step.schemaVerifyMs)}.`,
      "",
      `Disk: total ${formatBytes(step.disk.totalBytes)} = heap ${formatBytes(step.disk.heapBytes)} + TOAST ${formatBytes(step.disk.toastBytes)} + indexes ${formatBytes(step.disk.indexesBytes)} (HNSW ${formatBytes(step.disk.hnswBytes)}, GIN ${formatBytes(step.disk.ginBytes)}, btrees ${formatBytes(step.disk.btreeBytes)}); documents table ${formatBytes(step.disk.documentsTotalBytes)}.`,
      "",
      "| Query | p50 ms | p95 ms | mean ms | returned / requested | recall@K vs exact | uses HNSW | plan (EXPLAIN ANALYZE, first query) |",
      "|---|---|---|---|---|---|---|---|",
      ...SERIES.filter((series) => step.latency[series]).map((series) => {
        const latency = step.latency[series];
        const recall = step.recall[series];
        const plan = step.plans[series];

        return `| ${SERIES_LABELS[series]} | ${latency.p50Ms} | ${latency.p95Ms} | ${latency.meanMs} | ${latency.meanReturned} / ${latency.requested} | ${recall ? `${recall.meanRecall} (min ${recall.minRecall}, ${recall.queriesBelowOne}/${recall.queries} below 1)` : "n/a"} | ${plan ? (plan.usesHnsw ? "yes" : "no") : "n/a"} | ${plan ? plan.app.join(" > ") : "n/a"} |`;
      }),
      "",
      `Hybrid dense-route candidates returned / requested: 1 document ${step.hybridDenseCandidates.hybrid_1doc ?? "n/a"} / ${step.hybridDenseCandidates.requested}, document set ${step.hybridDenseCandidates.hybrid_docset ?? "n/a"} / ${step.hybridDenseCandidates.requested}.`,
      "",
      ...(step.primingRead
        ? [
            `Priming reads (each query's first dense, then sparse read of its document set, before the timed series above; other queries may already have read some of its documents): ${PRIMING_SERIES.map(
              (series) =>
                `${series} p50 ${step.primingRead[series]?.p50Ms ?? "n/a"} / p95 ${step.primingRead[series]?.p95Ms ?? "n/a"} ms`
            ).join(", ")}.`,
            "",
          ]
        : []),
      step.ingestProbe
        ? `Ingest with live indexes: ${step.ingestProbe.documents} documents of ${step.ingestProbe.chunksPerDocument} chunks through writeDocumentsToPgvectorIndex in a tenant transaction, p50 ${step.ingestProbe.p50Ms} ms, max ${step.ingestProbe.maxMs} ms per document (embedding excluded${
            config.serverSettings?.fsync === "off" ? "; fsync off on this cluster, so a lower bound for a durable server" : ""
          }).`
        : "Ingest probe not run.",
      ""
    );
  }

  if (report.skipped.length) {
    lines.push(
      "## Sizes not run",
      "",
      ...report.skipped.map(
        (entry) => `- ${formatCount(entry.targetChunks)} chunks: ${entry.reason}.`
      ),
      ""
    );
  }

  lines.push(
    "## Notes",
    "",
    "- Recall compares the app's dense results with the same captured statement re-run with enable_indexscan = off (exact search), so a value below 1 is the HNSW index losing rows, including rows dropped by the document filter after the index scan returned its ef_search candidates.",
    "- The unfiltered series is not an app path: the app always filters by document. It isolates the index's own recall and latency.",
    "- A dense document-set recall of 1 from a plan that does not use HNSW (the doc_id btree plus a sort) is an exact scan and says nothing about the index.",
    "- The HNSW recall figures are a stress case, not a forecast for real embeddings: inside a cluster the synthetic vectors are isotropic Gaussian noise in every dimension, so the true top-K are near ties (for the default queries at 1M chunks the 10th nearest chunk is about 0.01 cosine closer than the 40th and 0.02 closer than the 100th), and graph ANN search degrades on such high intrinsic-dimension data far more than on real embeddings.",
    "- The seed fixes the data and the queries, not the HNSW graph: a build with parallel workers is not deterministic, so the whole-table recall moves between runs (two runs of the defaults on one machine differed by 0.06-0.07 at 500k and 1M chunks).",
    "- Series latencies are warm: before a query's timed calls, one dense and one sparse read of its document set bring those rows into memory, so every series sees the same cache state. The priming line shows what that first read cost.",
    "- Load time is for the rows appended at this size with the HNSW and GIN indexes dropped; cumulative load time sums the appends from empty. Index build times are full builds over the whole table.",
    "- The data are synthetic; latency depends on this machine, and the clustered vectors are not real embeddings.",
    ""
  );

  return `${lines.join("\n")}\n`;
};

// ---------------------------------------------------------------------------
// Database run
// ---------------------------------------------------------------------------

// Env the vector store reads, cleared so the app defaults apply and nothing
// leaks in from the calling shell.
const APP_ENV_TO_CLEAR = Object.freeze([
  "DOCUMENTS_POSTGRES_TABLE",
  "DOCUMENT_CHUNKS_POSTGRES_TABLE",
  "LONG_MEMORY_DATABASE_URL",
  "POSTGRES_SSL_ENABLED",
  "POSTGRES_TENANT_ROLE",
  "RAG_EMBEDDING_DOCUMENT_PREFIX",
  "RAG_EMBEDDING_QUERY_PREFIX",
  "RAG_HYBRID_DENSE_WEIGHT",
  "RAG_HYBRID_ENABLED",
  "RAG_HYBRID_FUSION",
  "RAG_HYBRID_SPARSE_WEIGHT",
  "RAG_KEYWORD_WEIGHT",
  "RAG_PGVECTOR_HNSW_EF_CONSTRUCTION",
  "RAG_PGVECTOR_HNSW_M",
  "RAG_PGVECTOR_INDEX_TYPE",
  "RAG_PGVECTOR_ITERATIVE_SCAN",
  "RAG_PGVECTOR_TEXT_SEARCH_CONFIG",
  "RAG_RETRIEVAL_ROUTE",
  "RAG_RETRIEVAL_SCORING_MODE",
  "RAG_RRF_K",
  "RAG_SPARSE_TOP_K",
  "RAG_VECTOR_WEIGHT",
]);

const readGitState = () => {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: __dirname, encoding: "utf8" }).trim() !== "";

    return { dirty, sha };
  } catch {
    return { dirty: null, sha: "unknown" };
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const benchStartedAt = performance.now();
  const budgetMs = options.timeBudgetMinutes * 60000;

  for (const key of APP_ENV_TO_CLEAR) {
    delete process.env[key];
  }

  process.env.POSTGRES_DATABASE_URL = options.databaseUrl;
  process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.OPENAI_EMBEDDING_MODEL = BENCH_EMBEDDING_MODEL;
  process.env.RAG_EMBEDDING_DIMENSIONS = String(options.dimensions);
  process.env.RAG_PGVECTOR_ITERATIVE_SCAN = options.iterativeScan;

  const { default: pg } = await import("pg");
  const [config, postgres, tenant, migrations, pgvector, vectorStore] = await Promise.all([
    import("../rag/config.js"),
    import("../rag/postgres.js"),
    import("../rag/postgres-tenant.js"),
    import("../rag/db-migrations.js"),
    import("../rag/vector-store-pgvector.js"),
    import("../rag/vector-store.js"),
  ]);

  config.configureEmbeddingDimensions(options.dimensions);

  const admin = new pg.Pool({ connectionString: options.databaseUrl, max: options.loadConcurrency + 2 });
  const chunksTable = pgvector.getPgvectorTableName();
  const documentsTable = config.getDocumentsPostgresTable();
  const hnswIndexName = migrations.getPgvectorEmbeddingIndexName(chunksTable);
  const ginIndexName = `${chunksTable}_search_vector_idx`;
  const asTenant = (callback) => tenant.runWithDatabaseTenant(BENCH_SCOPE, callback);
  let loadedChunks = 0;
  let loadStarted = false;

  const tableRowCount = async (table) => {
    const exists = await admin.query("SELECT to_regclass($1) AS relation", [table]);

    if (!exists.rows[0].relation) {
      return 0;
    }

    return Number((await admin.query(`SELECT count(*)::bigint AS n FROM ${table}`)).rows[0].n);
  };

  try {
    // --- Refuse anything that is not an empty, disposable database ----------
    for (const table of [documentsTable, chunksTable]) {
      const rows = await tableRowCount(table);

      if (rows > 0) {
        throw new Error(
          `${table} already holds ${rows} row(s). This benchmark loads and truncates its tables; point --database-url at a disposable database.`
        );
      }
    }

    migrations.resetPostgresMigrations();
    const migrationResult = await migrations.runPostgresMigrations();
    await pgvector.ensurePgvectorSchema({ force: true });

    // Loading the extension library defines the hnsw.* settings in the session.
    const settingsResult = await admin.query(`
      SELECT
        (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector_version,
        current_setting('server_version') AS server_version,
        ('[1]'::vector)::text AS loaded,
        current_setting('hnsw.ef_search', true) AS ef_search,
        current_setting('hnsw.iterative_scan', true) AS iterative_scan,
        current_setting('shared_buffers') AS shared_buffers,
        current_setting('work_mem') AS work_mem,
        current_setting('effective_cache_size') AS effective_cache_size,
        current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather,
        current_setting('max_parallel_workers') AS max_parallel_workers,
        current_setting('max_worker_processes') AS max_worker_processes,
        current_setting('fsync') AS fsync,
        current_setting('synchronous_commit') AS synchronous_commit,
        current_setting('wal_level') AS wal_level
    `);
    const settings = settingsResult.rows[0];
    const indexDefinitions = Object.fromEntries(
      (
        await admin.query(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])",
          [[hnswIndexName, ginIndexName]]
        )
      ).rows.map((row) => [row.indexname, row.indexdef])
    );

    for (const name of [hnswIndexName, ginIndexName]) {
      if (!indexDefinitions[name]) {
        throw new Error(`The migrations did not create ${name}; nothing to benchmark.`);
      }
    }

    const dropSearchIndexes = async () => {
      await admin.query(`DROP INDEX IF EXISTS ${hnswIndexName}`);
      await admin.query(`DROP INDEX IF EXISTS ${ginIndexName}`);
    };

    const corpus = createCorpus(options);
    const embeddingIdentity = config.getEmbeddingIndexIdentity();
    const embeddingDimensions = config.getEmbeddingDimensions();
    const git = readGitState();
    const runtime = vectorStore.describeVectorStoreRuntime();
    const reportConfig = {
      chunksPerDoc: options.chunksPerDoc,
      clusters: options.clusters,
      dimensions: embeddingDimensions,
      docSetSize: options.docSetSize,
      embeddingIdentity,
      gitDirty: git.dirty,
      gitSha: git.sha,
      hnsw: {
        efSearch: settings.ef_search,
        indexDefinition: indexDefinitions[hnswIndexName],
        iterativeScan: settings.iterative_scan,
        // What the app's dense route actually sets per query: null when it
        // keeps the plain statement (switched off or pgvector older than 0.8).
        appIterativeScan:
          config.getPgvectorIterativeScan() !== "off" &&
          pgvector.supportsPgvectorIterativeScan(settings.pgvector_version)
            ? config.getPgvectorIterativeScan()
            : null,
      },
      filteredRecallQueries: recallSampleSize({ options, series: "dense_docset", timedQueries: options.queries }),
      ginIndexDefinition: indexDefinitions[ginIndexName],
      ingestProbes: options.ingestProbes,
      migrationsApplied: migrationResult.appliedMigrations.length,
      noise: options.noise,
      pgvectorVersion: settings.pgvector_version,
      postgresVersion: settings.server_version,
      queries: options.queries,
      recallQueries: options.recallQueries,
      requestedSizes: options.sizes,
      rowLevelSecurity: config.getPostgresRowLevelSecurityMode(),
      runtime,
      seed: options.seed,
      serverSettings: {
        effective_cache_size: settings.effective_cache_size,
        fsync: settings.fsync,
        max_parallel_workers: settings.max_parallel_workers,
        max_parallel_workers_per_gather: settings.max_parallel_workers_per_gather,
        max_worker_processes: settings.max_worker_processes,
        shared_buffers: settings.shared_buffers,
        synchronous_commit: settings.synchronous_commit,
        wal_level: settings.wal_level,
        work_mem: settings.work_mem,
      },
      tenantRole: config.getPostgresTenantRole(),
      timeBudgetMinutes: options.timeBudgetMinutes,
      topK: options.topK,
      vocabularySize: VOCABULARY_SIZE,
      warmup: options.warmup,
      wordsPerChunk: options.wordsPerChunk,
    };

    console.log(
      `PostgreSQL ${settings.server_version}, pgvector ${settings.pgvector_version}; sizes ${options.sizes.join(", ")}; budget ${options.timeBudgetMinutes} min`
    );

    // --- Loading -------------------------------------------------------------
    const insertDocuments = async (fromDoc, toDoc) => {
      for (let start = fromDoc; start < toDoc; start += 2000) {
        const ids = Array.from({ length: Math.min(2000, toDoc - start) }, (_, offset) => docIdFor(start + offset));

        await admin.query(
          `INSERT INTO ${documentsTable}
             (doc_id, file_name, file_size, file_bytes, chunk_count, page_count, owner_user_id, workspace_id)
           SELECT id, id || '.pdf', 0, '\\x'::bytea, $2, $3, $4, $5 FROM unnest($1::text[]) AS id`,
          [ids, options.chunksPerDoc, Math.ceil(options.chunksPerDoc / 3), BENCH_SCOPE.userId, BENCH_SCOPE.workspaceId]
        );
      }
    };

    const insertChunkBatch = async (chunks) => {
      const columns = {
        chunkId: [],
        chunkIndex: [],
        content: [],
        docId: [],
        embedding: [],
        metadata: [],
        pageNumber: [],
        searchText: [],
      };

      for (const chunk of chunks) {
        const metadata = {
          chunkIndex: chunk.chunkIndex,
          docId: chunk.docId,
          fileName: chunk.fileName,
          filePath: `/documents/${chunk.docId}/file`,
          pageNumber: chunk.pageNumber,
          publicFilePath: `/documents/${chunk.docId}/file`,
          sectionHeading: null,
        };

        columns.chunkId.push(chunk.chunkId);
        columns.chunkIndex.push(chunk.chunkIndex);
        columns.content.push(chunk.content);
        columns.docId.push(chunk.docId);
        columns.embedding.push(formatVectorLiteral(chunk.vector));
        columns.metadata.push(JSON.stringify(metadata));
        columns.pageNumber.push(chunk.pageNumber);
        columns.searchText.push(pgvector.buildSearchText({ metadata, pageContent: chunk.content }));
      }

      await admin.query(
        `INSERT INTO ${chunksTable}
           (chunk_id, doc_id, chunk_index, page_number, section_heading, content, search_text, metadata,
            owner_user_id, workspace_id, embedding_model, embedding_dimensions, embedding)
         SELECT c.chunk_id, c.doc_id, c.chunk_index, c.page_number, NULL, c.content, c.search_text,
                c.metadata::jsonb, $9, $10, $11, $12, c.embedding::vector
         FROM unnest($1::text[], $2::text[], $3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[])
           AS c(chunk_id, doc_id, chunk_index, page_number, content, search_text, metadata, embedding)`,
        [
          columns.chunkId,
          columns.docId,
          columns.chunkIndex,
          columns.pageNumber,
          columns.content,
          columns.searchText,
          columns.metadata,
          columns.embedding,
          BENCH_SCOPE.userId,
          BENCH_SCOPE.workspaceId,
          embeddingIdentity,
          embeddingDimensions,
        ]
      );
    };

    const loadDocuments = async (fromDoc, toDoc) => {
      await insertDocuments(fromDoc, toDoc);

      let nextDoc = fromDoc;
      const worker = async () => {
        while (nextDoc < toDoc) {
          const start = nextDoc;
          const end = Math.min(toDoc, start + options.batchDocs);
          const chunks = [];

          nextDoc = end;

          for (let docIndex = start; docIndex < end; docIndex += 1) {
            chunks.push(...generateDocumentChunks({ chunksPerDoc: options.chunksPerDoc, corpus, docIndex }));
          }

          await insertChunkBatch(chunks);
        }
      };

      await Promise.all(Array.from({ length: options.loadConcurrency }, worker));
    };

    // --- Measurement helpers ------------------------------------------------
    const timeIt = async (callback) => {
      const startedAt = performance.now();
      const value = await callback();

      return { ms: performance.now() - startedAt, value };
    };

    // Build-session settings only: more maintenance memory and parallel
    // workers for this CREATE INDEX, and debug1 so PostgreSQL / pgvector say
    // how many workers they actually used.
    const buildIndex = async (definition, { maintenanceWorkMemMb }) => {
      const client = await admin.connect();
      const messages = [];
      const onNotice = (notice) => messages.push({ message: String(notice.message), severity: String(notice.severity ?? "") });

      client.on("notice", onNotice);

      try {
        await client.query(`SET maintenance_work_mem = '${maintenanceWorkMemMb}MB'`);
        await client.query(`SET max_parallel_maintenance_workers = ${options.parallelMaintenanceWorkers}`);
        await client.query(`SET min_parallel_table_scan_size = '${BUILD_MIN_PARALLEL_TABLE_SCAN_SIZE}'`);
        await client.query("SET client_min_messages = debug1");

        const { ms } = await timeIt(() => client.query(definition));

        return { ms, ...summarizeBuildMessages(messages) };
      } finally {
        client.off("notice", onNotice);
        await client.query("RESET ALL");
        client.release();
      }
    };

    const readDisk = async () => {
      const result = await admin.query(
        `
          SELECT
            pg_total_relation_size($1::regclass) AS total,
            pg_relation_size($1::regclass) AS heap,
            COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0) AS toast,
            pg_indexes_size($1::regclass) AS indexes,
            pg_relation_size(to_regclass($2)) AS hnsw,
            pg_relation_size(to_regclass($3)) AS gin,
            pg_total_relation_size($4::regclass) AS documents_total
          FROM pg_class c WHERE c.oid = $1::regclass
        `,
        [chunksTable, hnswIndexName, ginIndexName, documentsTable]
      );
      const row = Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));

      return {
        btreeBytes: row.indexes - row.hnsw - row.gin,
        documentsTotalBytes: row.documents_total,
        ginBytes: row.gin,
        heapBytes: row.heap,
        hnswBytes: row.hnsw,
        indexesBytes: row.indexes,
        toastBytes: row.toast,
        totalBytes: row.total,
      };
    };

    const exactSearch = async ({ sql, values }) => {
      const client = await admin.connect();

      try {
        await client.query("BEGIN");
        // No plain index scans: the HNSW index can only be used that way, so
        // the planner falls back to a bitmap or sequential scan plus a sort,
        // which is exact.
        await client.query("SET LOCAL enable_indexscan = off");
        await client.query("SET LOCAL enable_indexonlyscan = off");
        const result = await client.query(sql, values);
        const plan = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, values);
        await client.query("COMMIT");

        return { ids: result.rows.map((row) => String(row.chunk_id)), plan: summarizePlan(plan.rows[0]["QUERY PLAN"]) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };

    const unfilteredSql = `SELECT chunk_id FROM ${chunksTable} ORDER BY embedding <=> $1::vector ASC LIMIT $2`;
    const topK = options.topK;
    const searchFunctions = {
      dense_1doc: (query) =>
        asTenant(() =>
          pgvector.searchPgvectorDocuments({
            docIds: [query.docId],
            queryText: query.text,
            queryVector: query.vector,
            scoringMode: "dense",
            topK,
          })
        ),
      dense_docset: (query) =>
        asTenant(() =>
          pgvector.searchPgvectorDocuments({
            docIds: query.docSet,
            queryText: query.text,
            queryVector: query.vector,
            scoringMode: "dense",
            topK,
          })
        ),
      sparse_1doc: (query) =>
        asTenant(() => pgvector.searchPgvectorSparseDocuments({ docIds: [query.docId], queryText: query.text, topK })),
      sparse_docset: (query) =>
        asTenant(() => pgvector.searchPgvectorSparseDocuments({ docIds: query.docSet, queryText: query.text, topK })),
      hybrid_1doc: (query) =>
        asTenant(() =>
          vectorStore.searchDocumentsWithRoutes({
            docIds: [query.docId],
            queryText: query.text,
            queryVector: query.vector,
            topK,
          })
        ),
      hybrid_docset: (query) =>
        asTenant(() =>
          vectorStore.searchDocumentsWithRoutes({
            docIds: query.docSet,
            queryText: query.text,
            queryVector: query.vector,
            topK,
          })
        ),
      dense_unfiltered_sql: async (query) =>
        (await admin.query(unfilteredSql, [`[${query.vector.join(",")}]`, topK])).rows.map((row) => ({
          document: { id: String(row.chunk_id) },
        })),
    };
    const resultIds = (series, value) =>
      (series.startsWith("hybrid") ? value.results : value).map((result) => String(result.document.id));

    const measure = async ({ docCount }) => {
      const queries = buildQuerySet({
        corpus,
        count: options.warmup + options.queries,
        docCount,
        docSetSize: options.docSetSize,
        seed: options.seed,
      });
      const samples = Object.fromEntries(SERIES.map((series) => [series, { latencies: [], returned: [] }]));
      const priming = Object.fromEntries(PRIMING_SERIES.map((series) => [series, []]));
      const hybridDense = { hybrid_1doc: [], hybrid_docset: [] };

      // Timed pass: the app functions exactly as production calls them,
      // interleaved per query. The priming reads come first so every series
      // sees the same warm cache state; without them the first document-set
      // series of each query paid the cold read that later series skipped.
      for (const [index, query] of queries.entries()) {
        for (const series of PRIMING_SERIES) {
          const { ms } = await timeIt(() => searchFunctions[series](query));

          if (index >= options.warmup) {
            priming[series].push(ms);
          }
        }

        for (const series of SERIES) {
          const { ms, value } = await timeIt(() => searchFunctions[series](query));

          if (index >= options.warmup) {
            samples[series].latencies.push(ms);
            samples[series].returned.push(resultIds(series, value).length);

            if (hybridDense[series]) {
              hybridDense[series].push(value.routes.dense.candidateCount);
            }
          }
        }
      }

      // Recall and plan pass: the same calls with the statement captured, so
      // the exact search and EXPLAIN run the SQL the app actually sent.
      const captured = [];
      const recalls = Object.fromEntries(RECALL_SERIES.map((series) => [series, []]));
      const plans = {};

      // The iterative-scan setting and the dense search run in one
      // transaction; capture both so the EXPLAIN replays the setting too.
      pgvector.configurePgvectorRuntime({
        query: (sql, values = []) => {
          captured.push({ sql, values });
          return postgres.queryPostgres(sql, values);
        },
        withTransaction: (callback) =>
          postgres.withPostgresTransaction((client) =>
            callback({
              query: (sql, values = []) => {
                captured.push({ sql, values });
                return client.query(sql, values);
              },
            })
          ),
      });

      try {
        const timedQueries = queries.slice(options.warmup);
        const recallLimit = (series) => recallSampleSize({ options, series, timedQueries: timedQueries.length });

        // The first query also yields the plans (every non-hybrid series; the
        // hybrid path issues the same two statements); the rest only recall.
        for (const [index, query] of timedQueries.entries()) {
          const seriesForQuery = SERIES.filter(
            (series) => !series.startsWith("hybrid") && (index === 0 || index < recallLimit(series))
          );

          if (seriesForQuery.length === 0) {
            break;
          }

          for (const series of seriesForQuery) {
            captured.length = 0;

            const value = await searchFunctions[series](query);
            const setting = captured.filter((entry) => /set_config/.test(entry.sql)).at(-1) ?? null;
            const statement =
              series === "dense_unfiltered_sql"
                ? { sql: unfilteredSql, values: [`[${query.vector.join(",")}]`, topK] }
                : captured.filter((entry) => isSearchStatement(entry.sql)).at(-1);

            if (!statement) {
              throw new Error(`No search statement was captured for ${series}.`);
            }

            if (index === 0) {
              const explained =
                series === "dense_unfiltered_sql"
                  ? await admin.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.values)
                  : await asTenant(() =>
                      postgres.withPostgresTransaction(async (client) => {
                        if (setting) {
                          await client.query(setting.sql, setting.values);
                        }

                        return client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.values);
                      })
                    );
              const app = summarizePlan(explained.rows[0]["QUERY PLAN"]);

              plans[series] = { app, usesHnsw: planUsesIndex(app, hnswIndexName) };
            }

            if (index < recallLimit(series)) {
              const exact = await exactSearch(statement);

              if (planUsesIndex(exact.plan, hnswIndexName)) {
                throw new Error(`The exact ${series} search still used the HNSW index: ${exact.plan.join(" > ")}`);
              }

              if (index === 0) {
                plans[series].exact = exact.plan;
              }

              recalls[series].push(recallAtK(resultIds(series, value), exact.ids, topK));
            }
          }
        }
      } finally {
        pgvector.resetPgvectorRuntime();
      }

      const latency = Object.fromEntries(
        SERIES.map((series) => [
          series,
          {
            ...summarizeLatencies(samples[series].latencies),
            meanReturned: round(
              samples[series].returned.reduce((sum, value) => sum + value, 0) / Math.max(1, samples[series].returned.length),
              2
            ),
            requested: topK,
          },
        ])
      );
      const recall = Object.fromEntries(
        RECALL_SERIES.filter((series) => recalls[series].length).map((series) => [series, summarizeRecall(recalls[series])])
      );
      const meanOf = (values) => (values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 2) : null);

      return {
        docSetSize: Math.min(options.docSetSize, docCount),
        hybridDenseCandidates: {
          hybrid_1doc: meanOf(hybridDense.hybrid_1doc),
          hybrid_docset: meanOf(hybridDense.hybrid_docset),
          requested: Math.max(topK, config.getSparseRetrievalTopK()),
        },
        latency,
        plans,
        primingRead: Object.fromEntries(
          PRIMING_SERIES.map((series) => [series, summarizeLatencies(priming[series])])
        ),
        recall,
      };
    };

    // One document written the way ingestDocumentPages writes it (document row
    // plus chunks in one tenant transaction) with every index live.
    const ingestProbe = async ({ sizeLabel }) => {
      if (options.ingestProbes === 0) {
        return null;
      }

      const latencies = [];
      const probeDocIds = [];

      try {
        for (let probe = 0; probe < options.ingestProbes; probe += 1) {
          const docId = `bench-ingest-${sizeLabel}-${probe}`;
          const template = generateDocumentChunks({
            chunksPerDoc: options.chunksPerDoc,
            corpus,
            docIndex: 9_000_000 + probe,
          });
          const preparedDocuments = template.map((chunk) => {
            const metadata = {
              chunkIndex: chunk.chunkIndex,
              docId,
              fileName: `${docId}.pdf`,
              filePath: `/documents/${docId}/file`,
              pageNumber: chunk.pageNumber,
              publicFilePath: `/documents/${docId}/file`,
              sectionHeading: null,
            };

            return {
              id: `${docId}:${chunk.chunkIndex}`,
              metadata,
              pageContent: chunk.content,
              searchText: pgvector.buildSearchText({ metadata, pageContent: chunk.content }),
              vector: quantizeVector(chunk.vector),
            };
          });

          probeDocIds.push(docId);

          const { ms } = await timeIt(() =>
            asTenant(() =>
              postgres.withPostgresTransaction(async (client) => {
                await client.query(
                  `INSERT INTO ${documentsTable}
                     (doc_id, file_name, file_size, file_bytes, chunk_count, page_count, owner_user_id, workspace_id)
                   VALUES ($1, $2, 0, '\\x'::bytea, $3, $4, $5, $6)`,
                  [docId, `${docId}.pdf`, options.chunksPerDoc, Math.ceil(options.chunksPerDoc / 3), BENCH_SCOPE.userId, BENCH_SCOPE.workspaceId]
                );
                await pgvector.writeDocumentsToPgvectorIndex({ accessScope: BENCH_SCOPE, client, preparedDocuments });
              })
            )
          );

          latencies.push(ms);
        }
      } finally {
        await admin.query(`DELETE FROM ${documentsTable} WHERE doc_id = ANY($1::text[])`, [probeDocIds]);
      }

      return {
        chunksPerDocument: options.chunksPerDoc,
        documents: latencies.length,
        maxMs: round(Math.max(...latencies), 1),
        p50Ms: round(percentile(latencies, 0.5), 1),
      };
    };

    // --- Size steps ------------------------------------------------------------
    const steps = [];
    const skipped = [];
    let cumulativeLoadMs = 0;

    await dropSearchIndexes();

    for (const targetChunks of options.sizes) {
      const docCount = Math.ceil(targetChunks / options.chunksPerDoc);
      const chunkCount = docCount * options.chunksPerDoc;
      const previous = steps.at(-1) ?? null;
      const decision = decideSizeRun({
        budgetMs,
        elapsedMs: performance.now() - benchStartedAt,
        projectedMs: projectStepMs({ loadedChunks, previous, targetChunks: chunkCount }),
      });

      if (!decision.run || chunkCount <= loadedChunks) {
        skipped.push({
          projectedMs: decision.projectedMs,
          reason: decision.run ? "not larger than the size already loaded" : decision.reason,
          remainingMs: decision.remainingMs,
          targetChunks: chunkCount,
        });
        console.log(`skip ${chunkCount}: ${skipped.at(-1).reason}`);
        continue;
      }

      const stepStartedAt = performance.now();
      const fromDoc = loadedChunks / options.chunksPerDoc;

      if (steps.length > 0) {
        await dropSearchIndexes();
      }

      console.log(`[${chunkCount}] loading documents ${fromDoc}..${docCount - 1}`);
      loadStarted = true;
      const load = await timeIt(() => loadDocuments(fromDoc, docCount));
      const deltaChunks = chunkCount - loadedChunks;

      loadedChunks = chunkCount;
      cumulativeLoadMs += load.ms;

      const analyze = await timeIt(() => admin.query(`ANALYZE ${documentsTable}, ${chunksTable}`));
      console.log(`[${chunkCount}] loaded in ${round(load.ms / 1000, 1)} s; building GIN`);
      const ginMaintenanceWorkMemMb = Math.min(options.maintenanceWorkMemCapMb, GIN_MAINTENANCE_WORK_MEM_MB);
      const gin = await buildIndex(indexDefinitions[ginIndexName], { maintenanceWorkMemMb: ginMaintenanceWorkMemMb });
      const maintenanceWorkMemMb = hnswMaintenanceWorkMemMb({
        capMb: options.maintenanceWorkMemCapMb,
        chunks: chunkCount,
        dimensions: embeddingDimensions,
      });
      console.log(`[${chunkCount}] GIN ${round(gin.ms / 1000, 1)} s; building HNSW (maintenance_work_mem ${maintenanceWorkMemMb} MB)`);
      const hnsw = await buildIndex(indexDefinitions[hnswIndexName], { maintenanceWorkMemMb });
      console.log(`[${chunkCount}] HNSW ${round(hnsw.ms / 1000, 1)} s; measuring`);

      // Everything from here on (the budget projection scales it with size).
      const measureStartedAt = performance.now();

      await admin.query(`ANALYZE ${chunksTable}`);
      await admin.query("CHECKPOINT");

      const disk = await readDisk();

      // A forced re-verification is what a restarted server pays on its
      // first search: migrations check plus the stored-model scan.
      pgvector.resetPgvectorVectorStore();
      const verify = await timeIt(() => pgvector.ensurePgvectorSchema({ force: true }));

      const measured = await measure({ docCount });
      const probe = await ingestProbe({ sizeLabel: String(chunkCount) });
      const measureMs = performance.now() - measureStartedAt;

      steps.push({
        chunks: chunkCount,
        disk,
        docSetSize: measured.docSetSize,
        documents: docCount,
        hybridDenseCandidates: measured.hybridDenseCandidates,
        indexBuild: {
          ginMaintenanceWorkMemMb,
          ginMs: round(gin.ms, 0),
          ginParallelWorkers: gin.parallelWorkers,
          hnswMs: round(hnsw.ms, 0),
          hnswParallelWorkers: hnsw.parallelWorkers,
          maintenanceWorkMemMb,
          maxParallelMaintenanceWorkers: options.parallelMaintenanceWorkers,
          minParallelTableScanSize: BUILD_MIN_PARALLEL_TABLE_SCAN_SIZE,
          notices: [...new Set([...gin.notices, ...hnsw.notices])],
        },
        ingestProbe: probe,
        latency: measured.latency,
        load: {
          analyzeMs: round(analyze.ms, 0),
          cumulativeLoadMs: round(cumulativeLoadMs, 0),
          deltaChunks,
          loadMs: round(load.ms, 0),
          rowsPerSecond: Math.round(deltaChunks / Math.max(0.001, load.ms / 1000)),
        },
        measureMs: round(measureMs, 0),
        plans: measured.plans,
        primingRead: measured.primingRead,
        projectedMs: decision.projectedMs,
        recall: measured.recall,
        schemaVerifyMs: round(verify.ms, 0),
        stepMs: round(performance.now() - stepStartedAt, 0),
        targetChunks,
      });

      console.log(
        `[${chunkCount}] done in ${round((performance.now() - stepStartedAt) / 1000, 1)} s; dense set p50 ${measured.latency.dense_docset.p50Ms} ms, recall ${measured.recall.dense_docset?.meanRecall}`
      );
    }

    const report = {
      config: reportConfig,
      generatedAt: new Date().toISOString(),
      reportType: "pgvector-scale",
      skipped,
      steps,
      totalMs: round(performance.now() - benchStartedAt, 0),
    };
    const markdown = formatMarkdown(report);

    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, `${options.latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(resultsDirectory, `${options.latestName}.md`), markdown);
    process.stdout.write(markdown);
  } finally {
    pgvector.resetPgvectorRuntime();

    // --keep-data leaves the last size loaded for inspection; only useful with
    // the wrapper's KEEP_CLUSTER=1, since the cluster is deleted otherwise.
    if (loadStarted && !options.keepData) {
      await admin.query(`TRUNCATE ${chunksTable}, ${documentsTable}`).catch((error) => {
        console.error(`Could not truncate the benchmark tables: ${error.message}`);
      });
    }

    await postgres.resetPostgresPool();
    await admin.end();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
