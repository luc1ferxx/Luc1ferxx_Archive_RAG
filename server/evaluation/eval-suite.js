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
    },
    {
      id: "rerank-hard-cs",
      label: "Hard CS rerank regression",
      reportType: "rerank",
      latestName: "latest-rerank-hard-cs",
      corpusPath: "evaluation/synthetic-corpus-rerank-hard-cs.json",
      rerankProvider: "heuristic",
    },
    {
      id: "arxiv-real-paper-rerank",
      label: "arXiv real-paper rerank regression",
      reportType: "rerank",
      latestName: "latest-arxiv-rerank",
      corpusPath: "evaluation/generated/arxiv-corpus.json",
      build: {
        label: "Build arXiv real-paper corpus",
        scriptPath: "evaluation/build-arxiv-corpus.mjs",
      },
      rerankProvider: "heuristic",
    },
  ],
};

export const robustEvalSuiteReportIds = robustEvalSuite.reports.map(
  (report) => report.id
);

export const getRobustEvalSuiteReport = (reportId) =>
  robustEvalSuite.reports.find((report) => report.id === reportId) ?? null;
