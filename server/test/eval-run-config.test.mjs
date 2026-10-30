import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  describeChunkingConfig,
  describeEvaluationCheckout,
  describePdfConfig,
  describeRetrievalConfig,
  sumTextChars,
} from "../evaluation/eval-run-config.js";

// What evaluation reports record as config.chunking, config.pdf,
// config.retrieval and config.git (run-qasper-retrieval-eval,
// run-qasper-answer-eval, run-layout-parsing-eval).

// Every case starts from the defaults (a file runs in a process of its own).
const SETTINGS = [
  "MODEL_GATEWAY_URL",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "PDF_PARAGRAPH_DETECTION",
  "PDF_PARSER",
  "RAG_BM25_B",
  "RAG_KEYWORD_WEIGHT",
  "RAG_QA_PARTIAL_COVERAGE_FLOOR",
  "RAG_RETRIEVAL_SCORING_MODE",
  "RAG_VECTOR_WEIGHT",
  "RETRIEVAL_SERVICE_URL",
  "RAG_BM25_K1",
  "RAG_CHUNK_OVERLAP",
  "RAG_CHUNK_SIZE",
  "RAG_CHUNK_STRATEGY",
  "RAG_HYBRID_DENSE_WEIGHT",
  "RAG_HYBRID_ENABLED",
  "RAG_HYBRID_FUSION",
  "RAG_HYBRID_SPARSE_WEIGHT",
  "RAG_MIN_QA_QUERY_TERM_COVERAGE",
  "RAG_MIN_RELEVANCE_SCORE",
  "RAG_QA_ANSWER_VERDICT",
  "RAG_QA_GATE_INFLECTION",
  "RAG_QA_MIN_RERANK_PROBABILITY",
  "RAG_QUERY_DECOMPOSITION_ENABLED",
  "RAG_QUERY_DECOMPOSITION_MAX_REQUIREMENTS",
  "RAG_RERANK_CANDIDATE_MULTIPLIER",
  "RAG_RERANK_ENABLED",
  "RAG_RERANK_PROVIDER",
  "RAG_RERANK_WEIGHT",
  "RAG_RETRIEVAL_ROUTE",
  "RAG_RETRIEVAL_TOP_K",
  "RAG_RRF_K",
  "RAG_SPARSE_TOP_K",
];
const clearSettings = () => {
  for (const name of SETTINGS) {
    delete process.env[name];
  }
};

clearSettings();
afterEach(clearSettings);

test("config.chunking names the settings and the chunker version the run cut chunks with", async () => {
  assert.deepEqual(await describeChunkingConfig(), {
    chunkerVersion: 2,
    overlap: 180,
    size: 900,
    strategy: "structured",
  });

  process.env.RAG_CHUNK_STRATEGY = " Sentence ";
  process.env.RAG_CHUNK_SIZE = "600";
  process.env.RAG_CHUNK_OVERLAP = "";
  assert.deepEqual(await describeChunkingConfig(), {
    chunkerVersion: 2,
    overlap: 180,
    size: 600,
    strategy: "sentence",
  });

  // A run never records a strategy it did not use.
  process.env.RAG_CHUNK_STRATEGY = "fixed";
  await assert.rejects(describeChunkingConfig(), /RAG_CHUNK_STRATEGY/);
});

test("config.retrieval names every setting of the QA route as the route reads it", async () => {
  const defaults = {
    bm25B: 0.75,
    bm25K1: 1.2,
    denseWeight: 0.65,
    embeddingEndpointHost: null,
    fusion: "rrf",
    hybridEnabled: true,
    keywordWeight: 0.18,
    maxQueryRequirements: 4,
    minQaQueryTermCoverage: 0.51,
    minRelevanceScore: 0.32,
    modelGateway: false,
    qaAnswerVerdict: false,
    qaGateInflection: false,
    qaMinRerankProbability: 0.02,
    qaPartialCoverageFloor: 0.3,
    queryDecomposition: true,
    remoteRetrieval: false,
    rerankCandidateMultiplier: 3,
    rerankEnabled: false,
    rerankProvider: "heuristic",
    rerankWeight: 0.6,
    route: "hybrid",
    rrfK: 60,
    scoringMode: "combined",
    sparseTopK: 8,
    sparseWeight: 0.35,
    topK: 10,
    vectorWeight: 0.82,
  };

  assert.deepEqual(await describeRetrievalConfig(), defaults);

  // The arms of a parameter sweep: exported before the run, read lazily.
  process.env.RAG_RRF_K = "4";
  process.env.RAG_HYBRID_DENSE_WEIGHT = "0.5";
  process.env.RAG_HYBRID_SPARSE_WEIGHT = "0.5";
  process.env.RAG_RETRIEVAL_TOP_K = "8";
  process.env.RAG_HYBRID_FUSION = "weighted";
  process.env.RAG_QA_MIN_RERANK_PROBABILITY = "off";
  // The host of the embedding endpoint, never its URL.
  process.env.OPENAI_BASE_URL = "http://user:secret@127.0.0.1:11434/v1";
  assert.deepEqual(await describeRetrievalConfig(), {
    ...defaults,
    denseWeight: 0.5,
    embeddingEndpointHost: "127.0.0.1:11434",
    fusion: "weighted",
    qaMinRerankProbability: null,
    rrfK: 4,
    sparseWeight: 0.5,
    topK: 8,
  });

  // The dense-only route, cosine only.
  process.env.RAG_HYBRID_ENABLED = "false";
  process.env.RAG_RETRIEVAL_SCORING_MODE = "dense";
  process.env.OPENAI_BASE_URL = "not a url";
  const denseOnly = await describeRetrievalConfig();

  assert.equal(denseOnly.hybridEnabled, false);
  assert.equal(denseOnly.scoringMode, "dense");
  assert.equal(denseOnly.embeddingEndpointHost, "invalid");
});

test("config.pdf names the parser and paragraph detection as configured", async () => {
  assert.deepEqual(await describePdfConfig(), { paragraphDetection: true, parser: "pdfjs" });

  process.env.PDF_PARSER = "auto";
  process.env.PDF_PARAGRAPH_DETECTION = "false";
  assert.deepEqual(await describePdfConfig(), { paragraphDetection: false, parser: "auto" });
});

const SHA = "c".repeat(40);
const gitAnswering = (status) => async (args) => {
  if (args.join(" ") === "rev-parse HEAD") {
    return `${SHA}\n`;
  }

  if (args.join(" ") === "status --porcelain=v1 -z --untracked-files=all") {
    return status;
  }

  throw new Error(`Unexpected git args: ${args.join(" ")}`);
};

test("config.git records the commit, whether the work tree had changes and how many paths", async () => {
  assert.deepEqual(await describeEvaluationCheckout({ runGit: gitAnswering("") }), {
    changedPaths: 0,
    dirty: false,
    sha: SHA,
  });
  assert.deepEqual(
    await describeEvaluationCheckout({
      runGit: gitAnswering(
        [
          " M server/rag/chunker.js",
          "?? server/test/new.test.mjs",
          "R  server/rag/new-name.js",
          "server/rag/old-name.js",
          // The evaluation's own outputs do not make a checkout dirty.
          " M server/evaluation/results/latest.json",
          "?? server/evaluation/generated/qasper-dev.json",
          "",
        ].join("\0")
      ),
    }),
    { changedPaths: 4, dirty: true, sha: SHA }
  );
});

test("config.git is null when git cannot say, and the run goes on", async () => {
  assert.equal(
    await describeEvaluationCheckout({
      runGit: async () => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      },
    }),
    null
  );
  assert.equal(await describeEvaluationCheckout({ runGit: async () => "fatal: not a git repository\n" }), null);
  assert.equal(
    await describeEvaluationCheckout({
      runGit: async (args) => {
        if (args[0] === "rev-parse") {
          return `${SHA}\n`;
        }

        throw new Error("status failed");
      },
    }),
    null
  );

  // This checkout itself: a commit, or null where git is unavailable.
  const checkout = await describeEvaluationCheckout();

  assert.ok(checkout === null || (/^[0-9a-f]{40,64}$/.test(checkout.sha) && typeof checkout.dirty === "boolean"));
});

test("text sizes add up characters and read missing text as empty", () => {
  assert.equal(sumTextChars(["abc", "de", ""]), 5);
  assert.equal(sumTextChars([{ text: "abc" }, { text: null }, {}], (item) => item.text), 3);
  assert.equal(sumTextChars(undefined), 0);
});
