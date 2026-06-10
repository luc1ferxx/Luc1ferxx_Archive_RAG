import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument } from "../rag/chunker.js";
import {
  buildCitation,
  buildContextSection,
  dedupeCitations,
  getResultKey,
} from "../rag/citations.js";
import {
  assessComparisonConfidence,
  assessQaConfidence,
} from "../rag/confidence.js";
import {
  configureCrossEncoderProvider,
  configureCustomRerankProvider,
  configureRerankMetricsCollector,
  rerankResults,
  rerankResultsWithProvider,
  resetCrossEncoderProvider,
  resetCustomRerankProvider,
  resetRerankMetricsCollector,
} from "../rag/reranker.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

const withEnv = async (overrides, callback) => {
  const originalValues = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const makeResult = ({
  id,
  text,
  score = 0.9,
  keywordScore,
  fileName = "paper.pdf",
  sectionHeading = "Evaluation",
}) => ({
  document: {
    id,
    pageContent: text,
    metadata: {
      fileName,
      sectionHeading,
    },
  },
  score,
  ...(keywordScore === undefined ? {} : { keywordScore }),
});

const makeRerankResults = () => [
  makeResult({
    id: "dense-first",
    text: "General systems overview with unrelated background.",
    score: 0.95,
  }),
  makeResult({
    id: "semantic",
    text: "Quartz capsule approval requires finance sign-off.",
    score: 0.1,
  }),
];

afterEach(() => {
  resetCrossEncoderProvider();
  resetCustomRerankProvider();
  resetRerankMetricsCollector();
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

test("simple chunking handles tight overlap and skips blank pages", async () => {
  await withEnv(
    {
      RAG_CHUNK_STRATEGY: "simple",
      RAG_CHUNK_SIZE: "5",
      RAG_CHUNK_OVERLAP: "9",
    },
    async () => {
      const chunks = chunkDocument({
        docId: "doc-simple",
        fileName: "simple.pdf",
        pages: [
          {
            pageNumber: 1,
            text: "abcdefghij",
          },
          {
            pageNumber: 2,
            text: "   \n\t   ",
          },
        ],
      });

      assert.deepEqual(
        chunks.map((chunk) => chunk.pageContent),
        ["abcde", "bcdef", "cdefg", "defgh", "efghi", "fghij"]
      );
      assert.ok(
        chunks.every(
          (chunk, index) =>
            chunk.id === `doc-simple:${index}` &&
            chunk.metadata.publicFilePath === "documents/doc-simple/file"
        )
      );
    }
  );
});

test("structured chunking tracks headings and splits oversized paragraphs", async () => {
  await withEnv(
    {
      RAG_CHUNK_STRATEGY: "structured",
      RAG_CHUNK_SIZE: "54",
      RAG_CHUNK_OVERLAP: "18",
    },
    async () => {
      const chunks = chunkDocument({
        docId: "doc-structured",
        fileName: "structured.pdf",
        publicFilePath: "custom/path.pdf",
        pages: [
          {
            pageNumber: 7,
            text: [
              "Neural Retrieval",
              "Dense retrieval paragraph with BM25 hybrid context.",
              "1 Evaluation",
              "Sentence one uses NDCG metrics. Sentence two validates MRR. Sentence three checks noise.",
              "\u7b2c2\u7ae0 \u7ed3\u8bba",
              "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijk",
            ].join("\n"),
          },
        ],
      });

      assert.equal(chunks[0].metadata.sectionHeading, "Neural Retrieval");
      assert.ok(
        chunks.some((chunk) => chunk.metadata.sectionHeading === "1 Evaluation")
      );
      assert.ok(chunks.some((chunk) => chunk.pageContent.includes("\u7b2c2\u7ae0 \u7ed3\u8bba")));
      assert.ok(
        chunks.some((chunk) =>
          chunk.pageContent.includes("abcdefghijklmnopqrstuvwxyz")
        )
      );
      assert.ok(
        chunks.every(
          (chunk, index) =>
            chunk.metadata.chunkIndex === index &&
            chunk.metadata.filePath === "custom/path.pdf"
        )
      );
    }
  );
});

test("qa confidence uses fallback score threshold when grounded evidence is close", async () => {
  await withEnv(
    {
      RAG_MIN_RELEVANCE_SCORE: "0.5",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.6",
    },
    async () => {
      const assessment = assessQaConfidence({
        queryText: "How is reranking evaluated?",
        results: [
          makeResult({
            id: "fallback",
            text: "Reranking is evaluated with NDCG, precision, recall, and MRR.",
            score: 0.42,
          }),
        ],
      });

      assert.equal(assessment.confident, true);
      assert.equal(assessment.usableResults[0].document.id, "fallback");
      assert.deepEqual(assessment.missingAnchorGroups, []);
    }
  );
});

test("qa confidence rejects results that miss anchor-specific evidence", async () => {
  await withEnv(
    {
      RAG_MIN_RELEVANCE_SCORE: "0.5",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.5",
    },
    async () => {
      const assessment = assessQaConfidence({
        queryText: "What is required by ABC-123?",
        results: [
          makeResult({
            id: "near",
            text: "The approval memo describes finance sign-off but names no code.",
            score: 0.9,
            keywordScore: 0.8,
          }),
        ],
      });

      assert.equal(assessment.confident, false);
      assert.equal(assessment.usableResults.length, 0);
      assert.equal(assessment.missingAnchorGroups[0].label, "ABC-123");
      assert.match(assessment.reason, /ABC-123/);
    }
  );
});

test("comparison confidence explains zero and partial document coverage", async () => {
  await withEnv(
    {
      RAG_MIN_RELEVANCE_SCORE: "0.5",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.5",
    },
    async () => {
      const zeroCoverage = assessComparisonConfidence({
        docIds: ["a", "b"],
        queryText: "Compare ABC-123 requirements.",
        perDocumentResults: new Map([
          [
            "a",
            [
              makeResult({
                id: "a-near",
                text: "This document discusses approvals without the code.",
                score: 0.9,
              }),
            ],
          ],
          ["b", []],
        ]),
      });

      assert.equal(zeroCoverage.confident, false);
      assert.match(zeroCoverage.reason, /selected documents to compare them/);

      const partialCoverage = assessComparisonConfidence({
        docIds: ["a", "b"],
        queryText: "Compare ABC-123 requirements.",
        perDocumentResults: new Map([
          [
            "a",
            [
              makeResult({
                id: "a-hit",
                text: "ABC-123 requires finance approval before release.",
                score: 0.95,
              }),
            ],
          ],
          ["b", []],
        ]),
      });

      assert.equal(partialCoverage.confident, false);
      assert.match(partialCoverage.reason, /1 of the 2 selected documents/);

      const genericPartialCoverage = assessComparisonConfidence({
        docIds: ["a", "b"],
        queryText: "Compare the evaluation metrics.",
        perDocumentResults: new Map([
          [
            "a",
            [
              makeResult({
                id: "a-generic",
                text: "The evaluation uses NDCG and MRR.",
                score: 0.95,
              }),
            ],
          ],
          ["b", []],
        ]),
      });

      assert.equal(genericPartialCoverage.confident, false);
      assert.match(genericPartialCoverage.reason, /1 of the 2 selected documents/);
    }
  );
});

test("citations derive page metadata, clean excerpts, and dedupe stable keys", () => {
  const document = {
    id: "chunk-1",
    pageContent: `Evidence text with
      irregular      spacing that should be compacted before it is shown.`,
    metadata: {
      docId: "doc-1",
      fileName: "paper.pdf",
      publicFilePath: "documents/doc-1/file",
      loc: {
        pageNumber: 3,
      },
      chunkIndex: 4,
      sectionHeading: "Evaluation",
    },
  };

  const citation = buildCitation(document, 0.987654, 2);

  assert.equal(citation.rank, 2);
  assert.equal(citation.score, 0.9877);
  assert.equal(citation.pageNumber, 3);
  assert.equal(citation.sectionHeading, "Evaluation");
  assert.match(citation.excerpt, /irregular spacing/);
  assert.equal(getResultKey({ document }), "doc-1:4");

  const contextSection = buildContextSection(document, 0.9, 1);
  assert.match(contextSection, /Source 1/);
  assert.match(contextSection, /Page: 3/);
  assert.match(contextSection, /Section: Evaluation/);

  const deduped = dedupeCitations(
    [
      citation,
      {
        ...citation,
        rank: 3,
      },
      {
        ...citation,
        docId: "doc-2",
        chunkIndex: null,
        pageNumber: 1,
      },
    ],
    2
  );

  assert.deepEqual(
    deduped.map((entry) => entry.docId),
    ["doc-1", "doc-2"]
  );
});

test("citation helpers use fallbacks when metadata is sparse", () => {
  const document = {
    id: "fallback-chunk",
    pageContent: "Sparse metadata evidence.",
    metadata: {
      page: 8,
    },
  };

  const citation = buildCitation(document, 0.5, 1);

  assert.equal(citation.docId, null);
  assert.equal(citation.fileName, "Unknown document");
  assert.equal(citation.filePath, "");
  assert.equal(citation.pageNumber, 8);
  assert.equal(citation.chunkIndex, null);
  assert.equal(citation.sectionHeading, null);
  assert.equal(getResultKey(document), "unknown:fallback-chunk");
  assert.doesNotMatch(buildContextSection(document, 0.5, 1), /Section:/);
});

test("heuristic rerank handles empty signals and invalid topK defensively", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.5",
    },
    async () => {
      const reranked = rerankResults({
        queryText: "",
        results: [
          {
            document: {
              id: "blank",
              pageContent: "",
              metadata: {},
            },
            score: "not-a-number",
          },
        ],
        topK: "invalid",
      });

      assert.equal(reranked.length, 1);
      assert.equal(reranked[0].originalScore, 0);
      assert.equal(reranked[0].rerankScore, 0);
      assert.equal(reranked[0].score, 0);
    }
  );
});

test("custom rerank provider falls back when missing or returning invalid output", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "custom",
    },
    async () => {
      const fallbackWithoutProvider = await rerankResultsWithProvider({
        queryText: "quartz capsule approval",
        results: makeRerankResults(),
        topK: 1,
      });

      assert.equal(fallbackWithoutProvider.length, 1);

      configureCustomRerankProvider({
        rerank: async () => ({ invalid: true }),
      });

      const fallbackWithInvalidProvider = await rerankResultsWithProvider({
        queryText: "quartz capsule approval",
        results: makeRerankResults(),
        topK: 1,
      });

      assert.equal(fallbackWithInvalidProvider.length, 1);
      assert.equal(fallbackWithInvalidProvider[0].document.id, "dense-first");
    }
  );
});

test("cross-encoder rerank exits early for empty result windows", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
    },
    async () => {
      configureCrossEncoderProvider({
        score: async () => {
          throw new Error("cross encoder should not be called");
        },
      });

      assert.deepEqual(
        await rerankResultsWithProvider({
          queryText: "quartz capsule approval",
          results: makeRerankResults(),
          topK: 0,
        }),
        []
      );
    }
  );
});

test("cross-encoder rerank tolerates metrics collector failures", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_RERANK_WEIGHT: "0.95",
    },
    async () => {
      console.error = () => {};
      configureRerankMetricsCollector(() => {
        throw new Error("metrics sink unavailable");
      });
      configureCrossEncoderProvider({
        score: async ({ pairs }) =>
          pairs.map((pair) => (pair.id === "semantic" ? 0.9 : 0.1)),
      });

      const reranked = await rerankResultsWithProvider({
        queryText: "quartz capsule approval",
        results: makeRerankResults(),
        topK: 1,
      });

      assert.equal(reranked[0].document.id, "semantic");
    }
  );
});

test("cross-encoder rerank reports provider errors before rethrowing", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
    },
    async () => {
      const metrics = [];
      configureRerankMetricsCollector((metric) => {
        metrics.push(metric);
      });
      configureCrossEncoderProvider({
        score: async () => {
          throw new TypeError("provider failed");
        },
      });

      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "quartz capsule approval",
          results: makeRerankResults(),
          topK: 1,
        }),
        /provider failed/
      );

      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].status, "error");
      assert.equal(metrics[0].errorName, "TypeError");
      assert.equal(metrics[0].transport, "custom-provider");
    }
  );
});

test("http cross-encoder rerank parses score arrays and indexed data payloads", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_RERANK_WEIGHT: "0.95",
      RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
      RAG_CROSS_ENCODER_MODEL: "mini-cross-encoder",
    },
    async () => {
      const requestBodies = [];

      globalThis.fetch = async (_url, options) => {
        requestBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          status: 200,
          json: async () => [0.1, 0.9],
        };
      };

      let reranked = await rerankResultsWithProvider({
        queryText: "quartz capsule approval",
        results: makeRerankResults(),
        topK: 1,
      });

      assert.equal(reranked[0].document.id, "semantic");
      assert.equal(requestBodies[0].model, "mini-cross-encoder");
      assert.equal(requestBodies[0].texts.length, 2);

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              document_index: 1,
              relevance_score: 0.95,
            },
            {
              document_index: 0,
              relevance_score: 0.05,
            },
          ],
        }),
      });

      reranked = await rerankResultsWithProvider({
        queryText: "quartz capsule approval",
        results: makeRerankResults(),
        topK: 1,
      });

      assert.equal(reranked[0].document.id, "semantic");
    }
  );
});

test("http cross-encoder rerank surfaces transport and payload errors", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
    },
    async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      });

      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "quartz capsule approval",
          results: makeRerankResults(),
          topK: 1,
        }),
        /HTTP 503/
      );

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "quartz capsule approval",
          results: makeRerankResults(),
          topK: 1,
        }),
        /scores or results/
      );

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              index: 0,
              score: 0.2,
            },
          ],
        }),
      });

      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "quartz capsule approval",
          results: makeRerankResults(),
          topK: 1,
        }),
        /did not include scores/
      );
    }
  );
});

test("cross-encoder rerank requires an HTTP endpoint when no provider is installed", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_CROSS_ENCODER_ENDPOINT: undefined,
    },
    async () => {
      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "quartz capsule approval",
          results: makeRerankResults(),
          topK: 1,
        }),
        /RAG_CROSS_ENCODER_ENDPOINT is required/
      );
    }
  );
});
