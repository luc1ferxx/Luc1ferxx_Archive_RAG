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
  findQueryTermSubstitution,
  selectQaContext,
  toRerankProbability,
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
import {
  MODEL_CAPABILITIES,
  MODEL_ROUTE_IDS,
  configureModelProviderRegistry,
  createModelProviderRegistry,
  resetModelProviderRegistry,
} from "../rag/model-providers/index.js";

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
  // Dense cosine defaults to the overall score so the synthetic result carries a
  // faithful admission signal: the evidence gate reads getAdmissionScore (raw
  // dense/keyword), not the fusion `score`, so a fixture with only `score` and no
  // raw signal would admit at 0 and be rejected. Callers that need a divergent
  // dense score (e.g. the anchor-bypass precision test) overlay vectorScore, and
  // callers modelling a sparse/rerank-only result with no dense score pass null.
  vectorScore = score,
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
  ...(vectorScore === null ? {} : { vectorScore }),
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
  resetModelProviderRegistry();
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

test("a strong dense score satisfies query-term coverage for comparison", async () => {
  // Query-term coverage is lexical, so it vetoes exactly what hybrid retrieval
  // exists to find: the document phrasing the same thing in other words. Asking
  // about a "cap" of a clause reading "shall not exceed" matches only one of two
  // query terms. Comparison is the structural worst case, because the words naming
  // the task and the documents dilute the denominator without ever being able to
  // appear in a clause. Fails before the semantic bypass exists.
  await withEnv(
    {
      RAG_MIN_RELEVANCE_SCORE: "0.32",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.51",
    },
    async () => {
      const paraphrased = {
        ...makeResult({
          id: "paraphrased",
          text: "The total liability of Vendor A shall not exceed the fees paid in the twelve (12) months preceding the claim.",
          score: 0.5,
          keywordScore: 0.5,
        }),
        vectorScore: 0.465,
      };

      const assessment = assessComparisonConfidence({
        docIds: ["vendor-a", "vendor-b"],
        queryText: "compare liability caps",
        perDocumentResults: new Map([
          ["vendor-a", [paraphrased]],
          ["vendor-b", [{ ...paraphrased, id: "paraphrased-b" }]],
        ]),
      });

      assert.equal(assessment.confident, true);
      assert.equal(assessment.usableResultsByDoc.get("vendor-a").length, 1);
      assert.equal(assessment.usableResultsByDoc.get("vendor-b").length, 1);
    }
  );
});

test("single-document QA gets no semantic bypass of its coverage floor", async () => {
  // The dense-score bypass is deliberately NOT extended to QA. There, low
  // coverage carries real information: it marks a chunk answering only part of
  // a multi-aspect question, which is what drives the gap-suggestion machinery.
  // Granting the bypass here made a correct abstention silently disappear. The
  // partial coverage band, QA's own narrower relief, is off here and tested
  // below.
  await withEnv(
    {
      RAG_MIN_QA_QUERY_TERM_COVERAGE: "0.51",
      RAG_MIN_RELEVANCE_SCORE: "0.32",
      RAG_QA_PARTIAL_COVERAGE_FLOOR: "1",
    },
    async () => {
      const assessment = assessQaConfidence({
        queryText: "compare liability caps",
        results: [
          {
            ...makeResult({
              id: "semantically-close",
              text: "The total liability of Vendor A shall not exceed the fees paid.",
              score: 0.5,
              keywordScore: 0.5,
            }),
            vectorScore: 0.465,
          },
        ],
      });

      assert.equal(assessment.confident, false);
      assert.equal(assessment.usableResults.length, 0);
    }
  );
});

test("QA admits a reworded chunk in the partial coverage band but not a neighbouring topic", async () => {
  const gate = {
    RAG_MIN_QA_QUERY_TERM_COVERAGE: "0.51",
    RAG_MIN_RELEVANCE_SCORE: "0.32",
    RAG_QA_ANSWER_VERDICT: "true",
    RAG_QA_PARTIAL_COVERAGE_FLOOR: "0.3",
  };
  const chunk = (id, text, keywordScore) => ({
    ...makeResult({ id, text, score: 0.5, keywordScore }),
    vectorScore: 0.465,
  });

  await withEnv(gate, async () => {
    // Other words for the same thing: "caps" is "shall not exceed".
    const reworded = assessQaConfidence({
      queryText: "What are the liability caps?",
      results: [chunk("reworded", "The total liability of Vendor A shall not exceed the fees paid.", 0.5)],
    });

    assert.equal(reworded.confident, true);
    assert.equal(reworded.partialCoverageResultCount, 1);

    // The same coverage, but the asked word was replaced on its head word.
    for (const [queryText, text] of [
      ["What is the amber ceiling?", "Archive serial cobalt ceiling: approved amount is 3600 dollars per cycle."],
      ["What is the parental leave policy?", "Annual leave policy: employees receive 10 paid annual leave days each year."],
    ]) {
      const neighbour = assessQaConfidence({ queryText, results: [chunk("neighbour", text, 0.5)] });

      assert.equal(neighbour.confident, false, queryText);
    }

    // Below the band, for a question the decomposer split into parts, and
    // without the answer model's verdict to back it, the floor alone decides.
    assert.equal(
      assessQaConfidence({
        queryText: "What are the liability caps?",
        results: [chunk("thin", "Liability is described in the schedule.", 0.25)],
      }).confident,
      false
    );
    assert.equal(
      assessQaConfidence({
        evidenceRequirementCount: 2,
        queryText: "When does the refund policy take effect and which regions does it apply to?",
        results: [chunk("topic-only", "Refunds are issued back to the original payment method.", 0.34)],
      }).confident,
      false
    );
  });
  await withEnv({ ...gate, RAG_QA_ANSWER_VERDICT: undefined }, async () => {
    assert.equal(
      assessQaConfidence({
        queryText: "What are the liability caps?",
        results: [chunk("reworded", "The total liability of Vendor A shall not exceed the fees paid.", 0.5)],
      }).confident,
      false
    );
  });
});

test("once the gate answers, the context adds reworded candidates but not neighbouring topics", async () => {
  await withEnv(
    { RAG_MIN_QA_QUERY_TERM_COVERAGE: "0.51", RAG_MIN_RELEVANCE_SCORE: "0.32", RAG_QA_ANSWER_VERDICT: undefined },
    async () => {
      const admitted = makeResult({ id: "admitted", text: "The amber ceiling is 2400 dollars.", keywordScore: 1 });
      const reworded = makeResult({ id: "reworded", text: "Approved amounts above that need a director.", keywordScore: 0 });
      const neighbour = makeResult({ id: "neighbour", text: "The cobalt ceiling is 3600 dollars.", keywordScore: 0.5 });
      const results = [admitted, neighbour, reworded];
      const queryText = "What is the amber ceiling?";
      const confidence = assessQaConfidence({ queryText, results });
      const ids = (context) => context.map((result) => result.document.id);

      assert.deepEqual(ids(confidence.usableResults), ["admitted"]);
      assert.deepEqual(ids(selectQaContext({ confidence, limit: 6, minCoverage: 0, queryText, results })), [
        "admitted",
        "reworded",
      ]);
      // The limit fills up to the context size but never drops an admitted chunk.
      assert.deepEqual(ids(selectQaContext({ confidence, limit: 1, minCoverage: 0, queryText, results })), ["admitted"]);
      assert.deepEqual(
        selectQaContext({ confidence: { ...confidence, confident: false }, limit: 6, minCoverage: 0, queryText, results }),
        []
      );

      // A question naming an identifier only takes candidates naming it.
      const anchored = "What does clause ABC-12 cap?";
      const anchorResults = [
        makeResult({ id: "anchor", text: "Clause ABC-12 caps liability at the fees paid.", keywordScore: 1 }),
        makeResult({ id: "other-clause", text: "Clause XYZ-9 caps indemnity.", keywordScore: 0.3 }),
      ];
      const anchorConfidence = assessQaConfidence({ queryText: anchored, results: anchorResults });

      assert.deepEqual(
        ids(selectQaContext({ confidence: anchorConfidence, limit: 6, minCoverage: 0, queryText: anchored, results: anchorResults })),
        ["anchor"]
      );
    }
  );
});

test("with a reranker probability floor, QA answers on the cross-encoder's judgement, not shared words", async () => {
  const scored = (id, text, keywordScore, crossEncoderScore) => ({
    ...makeResult({ id, text, keywordScore }),
    crossEncoderScore,
  });
  const reworded = scored("reworded", "We evaluate on SQuAD and TriviaQA.", 0, 2); // p = 0.88
  const wordy = scored("wordy", "The datasets section lists what they use.", 1, -3); // p = 0.05
  const queryText = "What datasets do they use?";

  await withEnv({ RAG_MIN_QA_QUERY_TERM_COVERAGE: "0.51", RAG_QA_MIN_RERANK_PROBABILITY: "0.5" }, async () => {
    const assessment = assessQaConfidence({ queryText, results: [wordy, reworded] });

    assert.equal(assessment.gate, "rerank");
    assert.equal(assessment.confident, true);
    assert.deepEqual(assessment.usableResults.map((result) => result.document.id), ["reworded"]);
    assert.equal(assessQaConfidence({ queryText, results: [wordy] }).confident, false);

    // An identifier the question names must still be in the chunk.
    const anchored = assessQaConfidence({ queryText: "What does clause ABC-12 cap?", results: [reworded] });

    assert.equal(anchored.confident, false);
    assert.ok(anchored.missingAnchorGroups.length > 0);

    // A result without a cross-encoder score (a failed rerank) keeps the lexical gate.
    const unscored = makeResult({ id: "unscored", text: "The datasets they use are listed here.", keywordScore: 1 });
    const lexical = assessQaConfidence({ queryText, results: [unscored] });

    assert.equal(lexical.gate, "lexical");
    assert.equal(lexical.confident, true);
  });

  await withEnv(
    { RAG_CROSS_ENCODER_SCORES: "probabilities", RAG_QA_MIN_RERANK_PROBABILITY: "0.5" },
    async () => {
      assert.equal(toRerankProbability(0.7), 0.7);
      assert.equal(assessQaConfidence({ queryText, results: [scored("p", "We evaluate on SQuAD.", 0, 0.7)] }).confident, true);
    }
  );

  await withEnv({ RAG_MIN_QA_QUERY_TERM_COVERAGE: "0.51", RAG_QA_MIN_RERANK_PROBABILITY: "off" }, async () => {
    assert.equal(assessQaConfidence({ queryText, results: [wordy, reworded] }).gate, "lexical");
  });

  // Unset: the tuned default applies whenever results carry reranker scores.
  await withEnv({ RAG_MIN_QA_QUERY_TERM_COVERAGE: "0.51", RAG_QA_MIN_RERANK_PROBABILITY: undefined }, async () => {
    const assessment = assessQaConfidence({ queryText, results: [wordy, reworded] });

    assert.equal(assessment.gate, "rerank");
    assert.deepEqual(assessment.usableResults.map((result) => result.document.id), ["wordy", "reworded"]);
  });
});

test("findQueryTermSubstitution names the replaced pair and ignores rewording and misspelling", () => {
  assert.deepEqual(
    findQueryTermSubstitution("What is the parental leave policy?", "Annual leave policy: 10 days."),
    { asked: "parental leave", found: "annual leave" }
  );
  assert.equal(findQueryTermSubstitution("What are the liability caps?", "Liability shall not exceed the fees."), null);
  // The asked word is present, so the other pair is not a replacement.
  assert.equal(
    findQueryTermSubstitution("What is the amber ceiling?", "The amber ceiling is 2400; the cobalt ceiling is 3600."),
    null
  );
  assert.equal(
    findQueryTermSubstitution("Which knowedge graph embeddings?", "Knowledge graph embeddings map entities."),
    null
  );
  // Never across a sentence boundary.
  assert.equal(findQueryTermSubstitution("What is the amber ceiling?", "Paint it cobalt. Ceiling rules follow."), null);
  // Character pairs for CJK: 育儿假 against 年假.
  assert.ok(findQueryTermSubstitution("育儿假政策是什么？", "年假政策：员工每年享有10天年假。"));
});

test("QA and comparison read separate coverage floors", async () => {
  const halfCoverage = {
    ...makeResult({
      id: "half-coverage",
      text: "The total liability of Vendor A shall not exceed the fees paid.",
      score: 0.5,
      keywordScore: 0.5,
    }),
    vectorScore: 0.2,
  };

  // Lowering the QA floor admits the chunk to QA ...
  await withEnv(
    {
      RAG_MIN_QA_QUERY_TERM_COVERAGE: "0.4",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.51",
      RAG_MIN_RELEVANCE_SCORE: "0.32",
      RAG_QA_PARTIAL_COVERAGE_FLOOR: "1",
    },
    async () => {
      assert.equal(assessQaConfidence({ queryText: "liability cap", results: [halfCoverage] }).confident, true);
    }
  );
  // ... and raising the comparison floor does not touch QA.
  await withEnv(
    {
      RAG_MIN_QA_QUERY_TERM_COVERAGE: "0.51",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.4",
      RAG_MIN_RELEVANCE_SCORE: "0.32",
      RAG_QA_PARTIAL_COVERAGE_FLOOR: "1",
    },
    async () => {
      assert.equal(assessQaConfidence({ queryText: "liability cap", results: [halfCoverage] }).confident, false);
    }
  );
});

test("a weak dense score does not rescue insufficient query-term coverage", async () => {
  // The other half: the bypass must not become a way around the gate entirely.
  // This is the off-topic chunk that shares one query word -- a governing-law
  // clause against a liability question -- and it must stay rejected even in
  // comparison, where the bypass is available.
  await withEnv(
    {
      RAG_MIN_RELEVANCE_SCORE: "0.32",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.51",
    },
    async () => {
      const offTopic = {
        ...makeResult({
          id: "off-topic",
          text: "Section 12. Governing Law. This agreement is governed by the laws of Delaware.",
          score: 0.5,
          keywordScore: 0.5,
        }),
        vectorScore: 0.1849,
      };

      const assessment = assessComparisonConfidence({
        docIds: ["vendor-a", "vendor-b"],
        queryText: "compare liability caps",
        perDocumentResults: new Map([
          ["vendor-a", [offTopic]],
          ["vendor-b", [{ ...offTopic, id: "off-topic-b" }]],
        ]),
      });

      assert.equal(assessment.confident, false);
    }
  );
});

test("a result carrying no dense score keeps the original coverage behaviour", async () => {
  // Reranked or sparse-only results may arrive without a vectorScore, and those
  // must not be silently promoted by a bypass that cannot evaluate them.
  await withEnv(
    {
      RAG_MIN_RELEVANCE_SCORE: "0.32",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.51",
    },
    async () => {
      const noVectorScore = makeResult({
        id: "no-vector-score",
        text: "The total liability shall not exceed the fees paid.",
        score: 0.5,
        keywordScore: 0.5,
        vectorScore: null,
      });

      const assessment = assessComparisonConfidence({
        docIds: ["vendor-a", "vendor-b"],
        queryText: "compare liability caps",
        perDocumentResults: new Map([
          ["vendor-a", [noVectorScore]],
          ["vendor-b", [{ ...noVectorScore, id: "no-vector-score-b" }]],
        ]),
      });

      assert.equal(assessment.confident, false);
    }
  );
});

test("the dense bypass does not let a missing anchor through", async () => {
  // The precision guarantee that must survive the bypass. A query naming a
  // specific identifier still requires that identifier to be present, even when
  // the chunk is semantically a great match -- otherwise "what does ABC-123
  // require" gets answered from a different policy that merely reads similarly.
  await withEnv(
    {
      RAG_MIN_RELEVANCE_SCORE: "0.32",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.51",
    },
    async () => {
      const wrongPolicy = {
        ...makeResult({
          id: "similar-but-wrong-policy",
          text: "The approval memo describes finance sign-off but names no code.",
          score: 0.9,
          keywordScore: 0.2,
        }),
        vectorScore: 0.95,
      };

      const assessment = assessComparisonConfidence({
        docIds: ["vendor-a", "vendor-b"],
        queryText: "Compare what ABC-123 requires.",
        perDocumentResults: new Map([
          ["vendor-a", [wrongPolicy]],
          ["vendor-b", [{ ...wrongPolicy, id: "similar-but-wrong-policy-b" }]],
        ]),
      });

      assert.equal(assessment.confident, false);
      assert.match(assessment.reason, /ABC-123/);
    }
  );
});

test("qa confidence rejects results that miss anchor-specific evidence", async () => {  await withEnv(
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

test("evidence admission gates on the raw signal, not the fusion score", async () => {
  // The separation guarantee at the core of the retrieval-correctness fix: RRF can
  // rank a chunk first on both routes and hand it a fused `score` near 1.0, but a
  // fusion rank is not retrieval strength. A satellite chunk with a weak dense
  // cosine (0.14) and no lexical overlap must be refused admission even though its
  // fused `score` tops the list -- and an otherwise identical chunk whose only
  // difference is a strong dense signal must be admitted. Holding `score` fixed at
  // 1.0 across both isolates what actually decides: getAdmissionScore, never `score`.
  await withEnv(
    {
      RAG_MIN_RELEVANCE_SCORE: "0.32",
      RAG_MIN_QUERY_TERM_COVERAGE: "0.51",
    },
    async () => {
      const queryText = "How does the evaluation harness measure latency?";
      const baseDocument = {
        id: "fused-first",
        pageContent:
          "The evaluation harness records latency percentiles for each run.",
        metadata: { fileName: "paper.pdf", sectionHeading: "Evaluation" },
      };
      // Fusion placed it first on both routes, so the scaled RRF `score` tops out
      // near 1.0 and rrfScore carries the raw sum for provenance only.
      const fusionRanking = {
        score: 1,
        rrfScore: 1 / (60 + 1),
        denseRank: 1,
        sparseRank: 1,
      };

      const inflatedByFusion = {
        document: baseDocument,
        ...fusionRanking,
        // Raw dense signal is below the 0.32 relevance floor.
        vectorScore: 0.14,
      };
      const groundedBySignal = {
        document: { ...baseDocument, id: "grounded" },
        ...fusionRanking,
        // Same fusion rank and `score`; only the raw dense signal differs.
        vectorScore: 0.9,
      };

      const refused = assessQaConfidence({
        queryText,
        results: [inflatedByFusion],
      });
      assert.equal(refused.confident, false);
      assert.equal(refused.usableResults.length, 0);

      const admitted = assessQaConfidence({
        queryText,
        results: [groundedBySignal],
      });
      assert.equal(admitted.confident, true);
      assert.equal(admitted.usableResults.length, 1);
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

test("http cross-encoder rerank can read model name from model provider route", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_RERANK_WEIGHT: "0.95",
      RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
      RAG_CROSS_ENCODER_MODEL: undefined,
    },
    async () => {
      const requestBodies = [];

      configureModelProviderRegistry(
        createModelProviderRegistry({
          providers: [
            {
              id: "cross_encoder",
              label: "Cross Encoder",
              models: [
                {
                  capabilities: [MODEL_CAPABILITIES.rerank],
                  id: "cross_encoder.default",
                  label: "Default cross encoder",
                  modelName: "registry-cross-encoder",
                },
              ],
              routes: [
                {
                  capability: MODEL_CAPABILITIES.rerank,
                  id: MODEL_ROUTE_IDS.rerankCrossEncoderDefault,
                  primaryModelId: "cross_encoder.default",
                },
              ],
              transport: {
                type: "http",
              },
            },
          ],
        })
      );

      globalThis.fetch = async (_url, options) => {
        requestBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          status: 200,
          json: async () => [0.1, 0.9],
        };
      };

      const reranked = await rerankResultsWithProvider({
        queryText: "quartz capsule approval",
        results: makeRerankResults(),
        topK: 1,
      });

      assert.equal(reranked[0].document.id, "semantic");
      assert.equal(requestBodies[0].model, "registry-cross-encoder");
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
