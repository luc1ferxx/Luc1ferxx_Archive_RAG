import { summarizeCoverageTotals } from "./coverage-report-parser.mjs";

export const COVERAGE_GROUPS = [
  {
    id: "rag_agent_core",
    label: "RAG / AgentRAG core",
    enforce: true,
    include: [
      /^server\/rag\/agent(?:-|\.js)/,
      /^server\/rag\/comparison-engine\.js$/,
      /^server\/rag\/evidence-aligner\.js$/,
      /^server\/rag\/evidence-summary\.js$/,
      /^server\/rag\/query-decomposer\.js$/,
      /^server\/rag\/query-router\.js$/,
      /^server\/rag\/research-brief\.js$/,
      /^server\/rag\/skills\/registry\.js$/,
      /^server\/rag\/skills\/custom\//,
    ],
    minimum: {
      line: 90,
      branch: 75,
      funcs: 80,
    },
    target: {
      line: 95,
      branch: 80,
      funcs: 90,
    },
  },
  {
    id: "rerank_retrieval",
    label: "Rerank / retrieval",
    enforce: true,
    include: [
      /^server\/rag\/reranker\.js$/,
      /^server\/rag\/retrievers\//,
      /^server\/rag\/vector-store(?:-|\.js)/,
      /^server\/rag\/sparse-store\.js$/,
      /^server\/rag\/text-utils\.js$/,
      /^server\/rag\/chunker\.js$/,
      /^server\/rag\/citations\.js$/,
      /^server\/rag\/confidence\.js$/,
    ],
    exclude: [
      /^server\/rag\/vector-store-local\.js$/,
      /^server\/rag\/vector-store-qdrant\.js$/,
    ],
    minimum: {
      line: 80,
      branch: 65,
      funcs: 80,
    },
    target: {
      line: 95,
      branch: 85,
      funcs: 95,
    },
  },
  {
    id: "api_routes",
    label: "API routes",
    enforce: true,
    include: [
      /^server\/app\.js$/,
      /^server\/auth\.js$/,
      /^server\/routes\//,
    ],
    minimum: {
      line: 70,
      branch: 45,
      funcs: 70,
    },
    target: {
      line: 85,
      branch: 70,
      funcs: 85,
    },
  },
  {
    id: "infra_external_cli",
    label: "DB / OpenAI / CLI scripts",
    enforce: false,
    include: [
      /^server\/rag\/openai\.js$/,
      /^server\/rag\/postgres\.js$/,
      /^server\/rag\/db-migrations\.js$/,
      /^server\/rag\/vector-store-local\.js$/,
      /^server\/rag\/vector-store-qdrant\.js$/,
      /^server\/rag\/doc-registry\.js$/,
      /^server\/rag\/long-memory\.js$/,
      /^server\/rag\/memory\.js$/,
      /^server\/health\.js$/,
      /^server\/chat-mcp\.js$/,
      /^server\/feedback\.js$/,
      /^server\/upload-session-store\.js$/,
      /^server\/evaluation\/run-/,
      /^server\/evaluation\/eval-store-overrides\.js$/,
    ],
    minimum: {
      line: 0,
      branch: 0,
      funcs: 0,
    },
    target: {
      line: 70,
      branch: 70,
      funcs: 70,
    },
  },
];

export const GLOBAL_GATE = {
  label: "Global backend",
  enforce: true,
  minimum: {
    line: 78,
    branch: 65,
    funcs: 80,
  },
  target: {
    line: 85,
    branch: 75,
    funcs: 90,
  },
};

// These tracked files are executable entry points, evaluation utilities, or
// test-only fixtures that are not part of the in-process backend test surface.
// Keeping the list explicit makes every newly added backend source opt in to
// coverage by default instead of silently disappearing when no test imports it.
export const GLOBAL_COVERAGE_EXCLUDED_PATHS = Object.freeze([
  "server/evaluation/benchmark-rerank-latency.mjs",
  "server/evaluation/build-arxiv-corpus.mjs",
  "server/evaluation/build-feedback-corpus.mjs",
  "server/evaluation/build-observability-report.mjs",
  "server/evaluation/check-current-quality.mjs",
  "server/evaluation/check-planner-provider-gate.mjs",
  "server/evaluation/local-cross-encoder-endpoint.mjs",
  "server/evaluation/ragas-sample.js",
  "server/evaluation/run-eval-suite.mjs",
  "server/evaluation/run-param-sweep.mjs",
  "server/evaluation/run-planner-eval.mjs",
  "server/evaluation/run-real-eval.mjs",
  "server/evaluation/run-recovery-observability-eval.mjs",
  "server/evaluation/run-rerank-sweep.mjs",
  "server/evaluation/run-rollout-readiness-report.mjs",
  "server/evaluation/run-runtime-smoke.mjs",
  "server/evaluation/run-synthetic-eval.mjs",
  "server/evaluation/run-trajectory-eval.mjs",
  "server/mcp-server.js",
  "server/rag/connectors/built-ins/test-connector.js",
  "server/server.js",
]);

const globalCoverageExcludedPathSet = new Set(
  GLOBAL_COVERAGE_EXCLUDED_PATHS
);

export const isGlobalCoverageSourcePath = (filePath) =>
  !globalCoverageExcludedPathSet.has(filePath);

export const matchesCoverageGroup = (row, group) =>
  group.include.some((pattern) => pattern.test(row.filePath)) &&
  !(group.exclude ?? []).some((pattern) => pattern.test(row.filePath));

export const summarizeCoverageGroup = (rows, group) => ({
  id: group.id,
  label: group.label,
  enforce: group.enforce,
  minimum: group.minimum,
  target: group.target,
  ...summarizeCoverageTotals(
    rows.filter((row) => matchesCoverageGroup(row, group))
  ),
});

export const isReportOnlyCoverageRow = (row) =>
  COVERAGE_GROUPS.some(
    (group) => !group.enforce && matchesCoverageGroup(row, group)
  );

export const findMissingEnforcedCoverage = ({
  expectedPaths,
  observedRows,
  groups = COVERAGE_GROUPS,
}) => {
  const observedPaths = new Set(observedRows.map((row) => row.filePath));

  return groups.flatMap((group) => {
    if (!group.enforce) {
      return [];
    }

    return expectedPaths
      .filter((filePath) => matchesCoverageGroup({ filePath }, group))
      .filter((filePath) => !observedPaths.has(filePath))
      .map((filePath) => ({
        groupId: group.id,
        groupLabel: group.label,
        filePath,
      }));
  });
};

export const findMissingGlobalCoverage = ({ expectedPaths, observedRows }) => {
  const observedPaths = new Set(observedRows.map((row) => row.filePath));

  return expectedPaths
    .filter(isGlobalCoverageSourcePath)
    .filter((filePath) => !observedPaths.has(filePath));
};
