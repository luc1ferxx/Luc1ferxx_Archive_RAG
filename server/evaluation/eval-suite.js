const robustRerankRankingConfig = Object.freeze({
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
});

export const robustEvalSuite = {
  id: "robust",
  label: "Robust hard/real evaluation suite",
  reports: [
    {
      id: "compare-hard-synthetic",
      label: "Compare-hard synthetic regression",
      reportType: "synthetic",
      latestName: "latest",
      corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
      minOverallPassRate: 0.99,
      executionConfig: {
        chunkStrategy: "structured",
        chunkSize: 900,
        chunkOverlap: 180,
        retrievalTopK: 6,
        compareTopKPerDoc: 3,
        maxComparisonSources: 8,
        minRelevanceScore: 0.32,
        nearDuplicateGuardEnabled: true,
        uploadChunkSizeBytes: 180,
      },
    },
    {
      id: "rerank-hard-cs",
      label: "Hard CS rerank regression",
      reportType: "rerank",
      latestName: "latest-rerank-hard-cs",
      corpusPath: "evaluation/synthetic-corpus-rerank-hard-cs.json",
      rerankProvider: "heuristic",
      rerankWeight: 0.6,
      rankingConfig: {
        ...robustRerankRankingConfig,
      },
    },
    {
      id: "arxiv-real-paper-rerank",
      label: "arXiv real-paper rerank regression",
      reportType: "rerank",
      latestName: "latest-arxiv-rerank",
      corpusPath:
        "evaluation/corpora/arxiv-computer-science-rerank-v1.json",
      corpusIntegrity: {
        algorithm: "sha256",
        contentHash:
          "7e95acc5d3ce9d6d3aba915354f338df9ed34c176f8536b98974d70976cc3779",
        id: "arxiv-computer-science-rerank-seed",
        version: "1",
      },
      rerankProvider: "heuristic",
      rerankWeight: 0.6,
      rankingConfig: {
        ...robustRerankRankingConfig,
      },
    },
  ],
};

export const robustEvalSuiteReportIds = robustEvalSuite.reports.map(
  (report) => report.id
);

export const getRobustEvalSuiteReport = (reportId) =>
  robustEvalSuite.reports.find((report) => report.id === reportId) ?? null;
