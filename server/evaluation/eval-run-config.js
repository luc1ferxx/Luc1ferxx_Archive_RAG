// What an evaluation report records about the code and settings behind its
// chunks, so two runs that differ there can be told apart (1dcc8467 changed
// the structured chunker's output and no report showed it):
//
//   config.chunking  { strategy, size, overlap, chunkerVersion } this run cut
//                    its chunks with (rag/chunk-profile.js);
//   config.pdf       { parser, paragraphDetection } where the run parses PDFs;
//   config.retrieval every setting of the single-document QA route that
//                    changes which chunks come back or which ones the gate
//                    admits (route, fusion, pools, rerank, decomposition,
//                    BM25, gate floors), where a run retrieves: the retrieval
//                    eval used to record only the top-K, so two arms of a
//                    parameter sweep could differ with nothing showing it;
//   config.git       { sha, dirty, changedPaths } of the checkout, or null
//                    when git cannot say (eval-evidence.js).
//
// Additive fields: older reports lack them, and nothing gates on them.
// rag/ modules are imported when called, after a runner has set its own
// environment (storage reads RAG_DATA_DIRECTORY on first import).

import { describeEvaluationCheckout } from "./eval-evidence.js";

export const describeChunkingConfig = async () => {
  const [{ CHUNKER_VERSION }, config] = await Promise.all([
    import("../rag/chunk-profile.js"),
    import("../rag/config.js"),
  ]);

  return {
    chunkerVersion: CHUNKER_VERSION,
    overlap: config.getChunkOverlap(),
    size: config.getChunkSize(),
    strategy: config.getChunkStrategy(),
  };
};

export const describePdfConfig = async () => {
  const config = await import("../rag/config.js");

  return {
    paragraphDetection: config.isPdfParagraphDetectionEnabled(),
    parser: config.getPdfParser(),
  };
};

// The host of the embedding endpoint, never the URL (a URL may carry a key).
const describeEmbeddingEndpointHost = (env = process.env) => {
  const raw = env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE ?? "";

  if (!String(raw).trim()) {
    return null;
  }

  try {
    return new URL(String(raw).trim()).host || null;
  } catch {
    return "invalid";
  }
};

/**
 * The retrieval settings as the QA route reads them (the same getters), flat
 * so a comparison can name the one that differs. `topK` repeats the report's
 * `retrievalTopK` so every setting of the route is in one place. `scoringMode`,
 * `vectorWeight` and `keywordWeight` only act on the dense-only route (hybrid
 * off), where they blend keyword coverage into the ranking. `remoteRetrieval`
 * and `modelGateway` say whether a service URL in the environment moved the
 * search or the embedding to another tier; `embeddingEndpointHost` which host
 * embedded.
 */
export const describeRetrievalConfig = async () => {
  const [config, topology] = await Promise.all([import("../rag/config.js"), import("../rag/service-topology.js")]);

  return {
    bm25B: config.getBm25B(),
    bm25K1: config.getBm25K1(),
    denseWeight: config.getHybridDenseWeight(),
    embeddingEndpointHost: describeEmbeddingEndpointHost(),
    fusion: config.getHybridFusionMethod(),
    hybridEnabled: config.isHybridRetrievalEnabled(),
    keywordWeight: config.getKeywordWeight(),
    maxQueryRequirements: config.getMaxQueryRequirements(),
    minQaQueryTermCoverage: config.getMinQaQueryTermCoverage(),
    minRelevanceScore: config.getMinRelevanceScore(),
    modelGateway: topology.isModelGatewayEnabled(),
    qaAnswerVerdict: config.isQaAnswerVerdictEnabled(),
    qaGateInflection: config.isQaGateInflectionEnabled(),
    qaMinRerankProbability: config.getQaMinRerankProbability(),
    qaPartialCoverageFloor: config.getQaPartialCoverageFloor(),
    queryDecomposition: config.isQueryDecompositionEnabled(),
    remoteRetrieval: topology.isRemoteRetrievalEnabled(),
    rerankCandidateMultiplier: config.getRerankCandidateMultiplier(),
    rerankEnabled: config.isRerankEnabled(),
    rerankProvider: config.getRerankProvider(),
    rerankWeight: config.getRerankWeight(),
    route: config.getRetrievalRoute(),
    rrfK: config.getRrfK(),
    scoringMode: config.getRetrievalScoringMode(),
    sparseTopK: config.getSparseRetrievalTopK(),
    sparseWeight: config.getHybridSparseWeight(),
    topK: config.getRetrievalTopK(),
    vectorWeight: config.getVectorWeight(),
  };
};

export { describeEvaluationCheckout };

/** Characters of text over `items` (chunks, contexts), read by `readText`. */
export const sumTextChars = (items, readText = (item) => item) =>
  (Array.isArray(items) ? items : []).reduce((total, item) => total + String(readText(item) ?? "").length, 0);

const CHUNKING_FIELDS = Object.freeze(["strategy", "size", "overlap", "chunkerVersion"]);
const RETRIEVAL_FIELDS = Object.freeze([
  "route",
  "hybridEnabled",
  "fusion",
  "rrfK",
  "denseWeight",
  "sparseWeight",
  "scoringMode",
  "vectorWeight",
  "keywordWeight",
  "topK",
  "sparseTopK",
  "rerankEnabled",
  "rerankProvider",
  "rerankCandidateMultiplier",
  "rerankWeight",
  "queryDecomposition",
  "maxQueryRequirements",
  "bm25K1",
  "bm25B",
  "minRelevanceScore",
  "minQaQueryTermCoverage",
  "qaPartialCoverageFloor",
  "qaGateInflection",
  "qaAnswerVerdict",
  "qaMinRerankProbability",
  "remoteRetrieval",
  "modelGateway",
  "embeddingEndpointHost",
]);

/**
 * Where this run's chunking, retrieval settings and checkout differ from
 * another report's, for a paired comparison: `[{ field, current, other }]`,
 * null for a side that cannot say (a report from before the field, or git
 * unavailable): unknown, so listed.
 *
 * Retrieval settings are compared field by field when both reports recorded
 * them; when only one did, one `retrieval` entry says so ("recorded" against
 * null) instead of listing every field as unknown; when neither did (answer
 * reports, reports from before the field) nothing is listed.
 *
 * The checkout: `git.sha` when the commits differ or either one is unknown,
 * and `git.changedPaths` (the uncommitted path counts) whenever either run
 * had uncommitted changes, also at the same commit and the same count: a
 * commit does not say which code a dirty work tree ran. An empty list means
 * both runs cut their chunks and retrieved the same way from the same clean
 * commit.
 */
export const describeRunConfigDifferences = (config = {}, otherConfig = {}) => {
  const differences = [];
  const list = (field, current, other) => differences.push({ current: current ?? null, field, other: other ?? null });
  const compare = (field, current, other) => {
    if (!Object.is(current ?? null, other ?? null)) {
      list(field, current, other);
    }
  };

  for (const field of CHUNKING_FIELDS) {
    compare(`chunking.${field}`, config.chunking?.[field], otherConfig?.chunking?.[field]);
  }

  const retrieval = config.retrieval ?? null;
  const otherRetrieval = otherConfig?.retrieval ?? null;

  if (retrieval && otherRetrieval) {
    for (const field of RETRIEVAL_FIELDS) {
      compare(`retrieval.${field}`, retrieval[field], otherRetrieval[field]);
    }
  } else if (retrieval || otherRetrieval) {
    list("retrieval", retrieval ? "recorded" : null, otherRetrieval ? "recorded" : null);
  }

  const git = config.git ?? null;
  const otherGit = otherConfig?.git ?? null;

  if (!git?.sha || !otherGit?.sha || git.sha !== otherGit.sha) {
    list("git.sha", git?.sha, otherGit?.sha);
  }

  if (git?.dirty === true || otherGit?.dirty === true) {
    list("git.changedPaths", git?.changedPaths, otherGit?.changedPaths);
  }

  return differences;
};
