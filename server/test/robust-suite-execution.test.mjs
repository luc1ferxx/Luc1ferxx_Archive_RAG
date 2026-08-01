import test from "node:test";
import assert from "node:assert/strict";

import { hashCanonicalJson } from "../evaluation/eval-evidence.js";
import { robustEvalSuite } from "../evaluation/eval-suite.js";
import {
  buildRobustSuiteChildEnvironment,
  buildRobustSuiteExecutionPlan,
} from "../evaluation/robust-suite-execution.js";
import {
  parseRobustSuiteArgs,
  verifyPinnedCorpora,
} from "../evaluation/run-eval-suite.mjs";

const DEFAULT_OPTIONS = Object.freeze({
  syntheticProvider: "real",
});

const buildPlan = ({ options = DEFAULT_OPTIONS, suite = robustEvalSuite } = {}) =>
  buildRobustSuiteExecutionPlan({ options, suite });

const findStep = (plan, reportId, kind = "report") =>
  plan.steps.find(
    (step) => step.reportId === reportId && step.kind === kind
  );

test("robust suite execution plan hashes the canonical public execution contract", () => {
  const plan = buildPlan();
  const syntheticReport = plan.contract.reports.find(
    (report) => report.id === "compare-hard-synthetic"
  );
  const hardCsReport = plan.contract.reports.find(
    (report) => report.id === "rerank-hard-cs"
  );
  const arxivReport = plan.contract.reports.find(
    (report) => report.id === "arxiv-real-paper-rerank"
  );
  const syntheticStep = findStep(plan, "compare-hard-synthetic");
  const hardCsStep = findStep(plan, "rerank-hard-cs");
  const arxivStep = findStep(plan, "arxiv-real-paper-rerank");

  assert.match(plan.configHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.configHash, hashCanonicalJson(plan.contract));
  assert.equal(plan.contract.schemaVersion, "2.0.0");
  assert.deepEqual(plan.contract.options, DEFAULT_OPTIONS);
  assert.deepEqual(syntheticReport.config, {
    chunkStrategy: "structured",
    chunkSize: 900,
    chunkOverlap: 180,
    retrievalTopK: 6,
    compareTopKPerDoc: 3,
    maxComparisonSources: 8,
    minRelevanceScore: 0.32,
    nearDuplicateGuardEnabled: true,
    uploadChunkSizeBytes: 180,
  });
  assert.deepEqual(hardCsReport.config, {
    chunkStrategy: "structured",
    chunkSize: 900,
    chunkOverlap: 180,
    vectorStoreProvider: "local",
    hybridEnabled: false,
    retrievalScoringMode: "combined",
    vectorWeight: 0.82,
    keywordWeight: 0.18,
    topK: 6,
    topKPerDoc: 3,
    candidateMultiplier: 3,
    embeddingProvider: "deterministic",
    rerankProvider: "heuristic",
    rerankWeight: 0.6,
  });
  assert.deepEqual(arxivReport.config, hardCsReport.config);
  assert.equal(
    arxivReport.corpusPath,
    "evaluation/corpora/arxiv-computer-science-rerank-v1.json"
  );
  assert.deepEqual(arxivReport.corpusIntegrity, {
    algorithm: "sha256",
    contentHash:
      "7e95acc5d3ce9d6d3aba915354f338df9ed34c176f8536b98974d70976cc3779",
    id: "arxiv-computer-science-rerank-seed",
    version: "1",
  });
  assert.equal(
    findStep(plan, "arxiv-real-paper-rerank", "build"),
    undefined
  );
  assert.equal(
    arxivStep.args[1],
    "evaluation/corpora/arxiv-computer-science-rerank-v1.json"
  );
  assert.deepEqual(syntheticStep.args, [
    "evaluation/run-synthetic-eval.mjs",
    "evaluation/synthetic-corpus-compare-hard.json",
    "--latest-name",
    "latest",
    "--openai-provider",
    "real",
  ]);
  assert.deepEqual(hardCsStep.args.slice(-2), ["--rerank-weight", "0.6"]);
});

test("robust suite child environment overrides every configurable synthetic public knob", () => {
  const plan = buildPlan();
  const syntheticStep = findStep(plan, "compare-hard-synthetic");
  const environment = buildRobustSuiteChildEnvironment({
    baseEnvironment: {
      KEEP_ME: "preserved",
      RAG_CHUNK_OVERLAP: "999",
      RAG_CHUNK_SIZE: "1",
      RAG_CHUNK_STRATEGY: "fixed",
      RAG_COMPARE_TOP_K_PER_DOC: "99",
      RAG_MAX_COMPARISON_SOURCES: "99",
      RAG_MIN_RELEVANCE_SCORE: "0.99",
      RAG_NEAR_DUPLICATE_GUARD_ENABLED: "false",
      RAG_RETRIEVAL_TOP_K: "99",
    },
    evidenceEnvironment: {
      EVAL_EVIDENCE_SUITE_ID: "robust",
    },
    step: syntheticStep,
  });

  assert.equal(environment.KEEP_ME, "preserved");
  assert.equal(environment.RAG_CHUNK_STRATEGY, "structured");
  assert.equal(environment.RAG_CHUNK_SIZE, "900");
  assert.equal(environment.RAG_CHUNK_OVERLAP, "180");
  assert.equal(environment.RAG_RETRIEVAL_TOP_K, "6");
  assert.equal(environment.RAG_COMPARE_TOP_K_PER_DOC, "3");
  assert.equal(environment.RAG_MAX_COMPARISON_SOURCES, "8");
  assert.equal(environment.RAG_MIN_RELEVANCE_SCORE, "0.32");
  assert.equal(environment.RAG_NEAR_DUPLICATE_GUARD_ENABLED, "true");
  assert.equal(environment.EVAL_EVIDENCE_SUITE_ID, "robust");
});

test("robust suite child environment overrides every rerank retrieval and ranking input", () => {
  const plan = buildPlan();
  const pollutedEnvironment = {
    KEEP_ME: "preserved",
    RAG_CHUNK_STRATEGY: "fixed",
    RAG_CHUNK_SIZE: "1",
    RAG_CHUNK_OVERLAP: "999",
    VECTOR_STORE_PROVIDER: "qdrant",
    RAG_HYBRID_ENABLED: "true",
    RAG_RETRIEVAL_SCORING_MODE: "vector-only",
    RAG_VECTOR_WEIGHT: "0.01",
    RAG_KEYWORD_WEIGHT: "0.99",
  };

  for (const reportId of ["rerank-hard-cs", "arxiv-real-paper-rerank"]) {
    const environment = buildRobustSuiteChildEnvironment({
      baseEnvironment: pollutedEnvironment,
      evidenceEnvironment: {
        EVAL_EVIDENCE_SUITE_ID: "robust",
      },
      step: findStep(plan, reportId),
    });

    assert.equal(environment.KEEP_ME, "preserved");
    assert.equal(environment.RAG_CHUNK_STRATEGY, "structured");
    assert.equal(environment.RAG_CHUNK_SIZE, "900");
    assert.equal(environment.RAG_CHUNK_OVERLAP, "180");
    assert.equal(environment.VECTOR_STORE_PROVIDER, "local");
    assert.equal(environment.RAG_HYBRID_ENABLED, "false");
    assert.equal(environment.RAG_RETRIEVAL_SCORING_MODE, "combined");
    assert.equal(environment.RAG_VECTOR_WEIGHT, "0.82");
    assert.equal(environment.RAG_KEYWORD_WEIGHT, "0.18");
    assert.equal(environment.EVAL_EVIDENCE_SUITE_ID, "robust");
  }
});

test("robust suite lineage binds the pinned arXiv corpus without a network build", () => {
  const defaultPlan = buildPlan();
  const changedSuite = structuredClone(robustEvalSuite);
  changedSuite.reports.find(
    (report) => report.id === "arxiv-real-paper-rerank"
  ).corpusIntegrity.contentHash = "f".repeat(64);

  assert.notEqual(
    buildPlan({ suite: changedSuite }).configHash,
    defaultPlan.configHash
  );
  assert.equal(
    defaultPlan.steps.some((step) => step.kind === "build"),
    false
  );
});

test("robust suite runner fails before evaluation when the pinned corpus hash drifts", async () => {
  const plan = buildPlan();
  plan.contract.reports.find(
    (report) => report.id === "arxiv-real-paper-rerank"
  ).corpusIntegrity.contentHash = "f".repeat(64);

  await assert.rejects(
    verifyPinnedCorpora(plan),
    /Pinned corpus content hash mismatch/
  );
});

test("robust suite lineage binds corpus identity and actual evaluation knobs", () => {
  const defaultHash = buildPlan().configHash;
  const rerankConfigDrift = [
    ["chunkStrategy", "fixed"],
    ["chunkSize", 901],
    ["chunkOverlap", 181],
    ["vectorStoreProvider", "qdrant"],
    ["hybridEnabled", true],
    ["retrievalScoringMode", "vector"],
    ["vectorWeight", 0.81],
    ["keywordWeight", 0.19],
  ].map(([field, value]) => (suite) => {
    suite.reports.find(
      (report) => report.id === "rerank-hard-cs"
    ).rankingConfig[field] = value;
  });
  const variants = [
    (suite) => {
      suite.reports.find(
        (report) => report.id === "arxiv-real-paper-rerank"
      ).corpusIntegrity.id = "different-corpus";
    },
    (suite) => {
      suite.reports.find(
        (report) => report.id === "rerank-hard-cs"
      ).rerankWeight = 0.9;
    },
    (suite) => {
      suite.reports.find(
        (report) => report.id === "rerank-hard-cs"
      ).rankingConfig.topK = 7;
    },
    (suite) => {
      suite.reports.find(
        (report) => report.id === "compare-hard-synthetic"
      ).executionConfig.chunkSize = 901;
    },
    ...rerankConfigDrift,
  ];

  for (const mutate of variants) {
    const suite = structuredClone(robustEvalSuite);
    mutate(suite);
    assert.notEqual(buildPlan({ suite }).configHash, defaultHash);
  }
});

test("robust suite lineage excludes presentation-only labels", () => {
  const suite = structuredClone(robustEvalSuite);
  suite.label = "Renamed suite";

  for (const report of suite.reports) {
    report.label = `Renamed ${report.id}`;
  }

  assert.equal(buildPlan({ suite }).configHash, buildPlan().configHash);
});

test("robust suite CLI preserves the complete inline value and fails closed", () => {
  assert.throws(
    () => parseRobustSuiteArgs(["--synthetic-provider=real=forged"]),
    /synthetic-provider must be either deterministic or real/
  );
  assert.throws(
    () => parseRobustSuiteArgs(["--suite=robust=forged"]),
    /Unknown evaluation suite: robust=forged/
  );
  assert.throws(
    () => parseRobustSuiteArgs(["--synthetic-provider"]),
    /Unknown or incomplete option: --synthetic-provider/
  );
  assert.throws(
    () => parseRobustSuiteArgs(["--unknown=value"]),
    /Unknown option: --unknown=value/
  );
  assert.throws(
    () => parseRobustSuiteArgs(["--skip-arxiv-build"]),
    /Unknown or incomplete option: --skip-arxiv-build/
  );
  assert.throws(
    () => parseRobustSuiteArgs(["--arxiv-skip-download"]),
    /Unknown or incomplete option: --arxiv-skip-download/
  );
  assert.deepEqual(
    parseRobustSuiteArgs(["--synthetic-provider=deterministic"]),
    {
      help: false,
      suite: "robust",
      syntheticProvider: "deterministic",
    }
  );
});
