import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMarkdown,
  describeProviders,
  pairedBootstrapDelta,
  resolveComparisonOptions,
} from "../evaluation/run-retrieval-comparison.mjs";

const DETERMINISTIC_OPTIONS = {
  embeddingProvider: "deterministic",
  rerankProvider: "heuristic",
  refusalProvider: "deterministic",
};

test("retrieval comparison defaults to the unbilled deterministic provider and report name", () => {
  const options = resolveComparisonOptions({}, {});

  assert.equal(options.embeddingProvider, "deterministic");
  assert.equal(options.rerankProvider, "heuristic");
  assert.equal(options.refusalProvider, "deterministic");
  assert.equal(options.latestName, "latest-retrieval-comparison");
  assert.equal(options.crossEncoderEndpoint, undefined);
});

test("retrieval comparison fails fast when a real provider is missing its credential or endpoint", () => {
  assert.throws(
    () => resolveComparisonOptions({ "embedding-provider": "openai" }, { OPENAI_API_KEY: "  " }),
    /needs OPENAI_API_KEY/
  );
  assert.throws(
    () => resolveComparisonOptions({ "rerank-provider": "cross-encoder" }, { RAG_CROSS_ENCODER_ENDPOINT: "" }),
    /needs --cross-encoder-endpoint or RAG_CROSS_ENCODER_ENDPOINT/
  );
  assert.throws(
    () => resolveComparisonOptions({ "embedding-provider": "cohere" }, {}),
    /--embedding-provider must be one of: deterministic, openai/
  );
  assert.throws(
    () => resolveComparisonOptions({ "latest-name": "../escape" }, {}),
    /--latest-name must contain only/
  );
});

test("a real run gets its own report name so it never overwrites deterministic evidence", () => {
  const openai = resolveComparisonOptions(
    { "embedding-provider": "openai" },
    { OPENAI_API_KEY: "sk-test" }
  );
  assert.equal(openai.latestName, "latest-retrieval-comparison-openai");
  assert.equal(openai.refusalProvider, "real");

  const both = resolveComparisonOptions(
    { "embedding-provider": "openai", "rerank-provider": "cross-encoder" },
    { OPENAI_API_KEY: "sk-test", RAG_CROSS_ENCODER_ENDPOINT: "http://127.0.0.1:8080/rerank" }
  );
  assert.equal(both.latestName, "latest-retrieval-comparison-openai-cross-encoder");
  assert.equal(both.crossEncoderEndpoint, "http://127.0.0.1:8080/rerank");

  const named = resolveComparisonOptions(
    { "embedding-provider": "openai", "latest-name": "my-run" },
    { OPENAI_API_KEY: "sk-test" }
  );
  assert.equal(named.latestName, "my-run");
});

test("provider description records the endpoint host only and never prices an unknown model", () => {
  const options = resolveComparisonOptions(
    { "embedding-provider": "openai" },
    { OPENAI_API_KEY: "ollama" }
  );
  const providers = describeProviders(options, {
    env: { OPENAI_BASE_URL: "http://user:secret@127.0.0.1:11434/v1?key=abc" },
    embeddingName: "nomic-embed-text",
  });

  assert.equal(providers.mode, "real");
  assert.equal(providers.embedding.endpointHost, "127.0.0.1:11434");
  assert.doesNotMatch(JSON.stringify(providers), /secret|key=abc/);
  assert.equal(providers.cost.embeddingModel, "nomic-embed-text");
  assert.equal(providers.cost.embeddingUsdPerMillionTokens, null);

  const deterministic = describeProviders(DETERMINISTIC_OPTIONS, { env: {}, embeddingName: "ignored" });
  assert.equal(deterministic.mode, "deterministic");
  assert.equal(deterministic.embedding.callsEndpoint, false);
  assert.equal(deterministic.cost.embeddingModel, "text-embedding-3-small");
  assert.equal(deterministic.cost.embeddingUsdPerMillionTokens, 0.02);
});

test("paired bootstrap reports a zero interval for identical arms", () => {
  const values = [1, 0, 0.5, 1, 0.25, 0, 1, 0.75];
  const result = pairedBootstrapDelta(values, values);

  assert.equal(result.delta, 0);
  assert.equal(result.ciLow, 0);
  assert.equal(result.ciHigh, 0);
  assert.equal(result.excludesZero, false);
  assert.equal(result.caseCount, values.length);
});

test("paired bootstrap separates a consistent gain from a noisy one", () => {
  const reference = [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5];
  const consistent = pairedBootstrapDelta(
    reference,
    reference.map((value) => value + 0.25)
  );
  assert.equal(consistent.delta, 0.25);
  assert.equal(consistent.excludesZero, true);
  assert.ok(consistent.ciLow > 0);

  // Same average gain, but half the cases get worse: not a demonstrated difference.
  const noisy = pairedBootstrapDelta(reference, [1, 0, 1, 0, 1, 0, 1, 0]);
  assert.equal(noisy.delta, 0.25);
  assert.equal(noisy.excludesZero, false);
  assert.ok(noisy.ciLow <= 0 && noisy.ciHigh > 0);
});

test("paired bootstrap is reproducible and skips unscorable pairs", () => {
  const reference = [0.2, 0.4, Number.NaN, 0.6, 0.1];
  const candidate = [0.3, 0.1, 0.9, 0.8, 0.4];

  assert.deepEqual(
    pairedBootstrapDelta(reference, candidate),
    pairedBootstrapDelta(reference, candidate)
  );
  assert.equal(pairedBootstrapDelta(reference, candidate).caseCount, 4);
  assert.equal(pairedBootstrapDelta([], []), null);
});

const buildReport = (providers) => ({
  runId: "cmp-test",
  generatedAt: "2026-09-25T00:00:00.000Z",
  previewOnly: false,
  evidence: { git: { commitSha: "abc123", dirty: false }, corpus: { contentHash: "hash" } },
  corpus: { relativePath: "server/evaluation/corpora/test.json" },
  abstainCorpus: null,
  providers,
  runEmbeddingEstimate: { tokens: 1200, usd: 0.000024 },
  splits: [
    {
      split: "heldout",
      documentKeys: ["doc_a"],
      documentCount: 1,
      caseCount: 2,
      topK: 5,
      arms: [
        { id: "dense", label: "dense-only" },
        { id: "sparse", label: "sparse-only (BM25)" },
        { id: "hybrid_rrf", label: "hybrid RRF" },
        { id: "hybrid_rerank", label: "hybrid + rerank" },
      ].map((arm) => ({
        ...arm,
        recallAtK: 0.5,
        ndcgAtK: 0.5,
        mrr: 0.5,
        precisionAtK: 0.2,
        noiseRateAtK: 0.8,
        citationSupportRate: 1,
        latency: { p50Ms: 1, p95Ms: 2 },
        estimatedCost: { embeddingTokens: 10, embeddingUsd: null },
      })),
      pairedDeltas: [
        {
          candidate: "hybrid_rrf",
          reference: "dense",
          recallAtK: { delta: 0.25, ciLow: 0.1, ciHigh: 0.4, excludesZero: true },
          ndcgAtK: { delta: -0.05, ciLow: -0.2, ciHigh: 0.1, excludesZero: false },
        },
      ],
    },
  ],
  refusal: null,
});

test("a real-embedding report is labeled as real and carries the paired-delta table", () => {
  const options = resolveComparisonOptions(
    { "embedding-provider": "openai" },
    { OPENAI_API_KEY: "sk-test" }
  );
  const providers = describeProviders(options, { env: {}, embeddingName: "text-embedding-3-small" });
  const markdown = buildMarkdown({ report: buildReport(providers) });

  assert.match(markdown, /Provider: \*\*real\*\* embeddings — `text-embedding-3-small` via `api\.openai\.com`/);
  assert.match(markdown, /Interpreting these numbers \(real embeddings/);
  assert.doesNotMatch(markdown, /deterministic provider — read before quoting/);
  assert.match(markdown, /\| hybrid RRF − dense-only \| \*\*\+0\.2500\*\* \[\+0\.1000, \+0\.4000\] \| -0\.0500 \[-0\.2000, \+0\.1000\] \|/);
  assert.match(markdown, /\| N\/A \|/);
});

test("a deterministic report keeps its non-semantic boundary wording", () => {
  const providers = describeProviders(DETERMINISTIC_OPTIONS, { env: {}, embeddingName: "ignored" });
  const markdown = buildMarkdown({ report: buildReport(providers) });

  assert.match(markdown, /Provider: \*\*deterministic\*\* embedding \+ answer provider \(labeled\) — model-equivalent `text-embedding-3-small`/);
  assert.match(markdown, /Interpreting these numbers \(deterministic provider — read before quoting\)/);
  assert.match(markdown, /Rerank: heuristic lexical reranker \(not a neural cross-encoder\)/);
  assert.doesNotMatch(markdown, /\*\*real\*\* embeddings/);
});
