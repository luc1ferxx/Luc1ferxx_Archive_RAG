import { MODEL_ROUTE_IDS } from "../rag/model-providers/schema.js";

export const DEFAULT_RELEASE_EVIDENCE_MAX_AGE_HOURS = 24;

export const RELEASE_EVIDENCE_REASON_CODES = Object.freeze({
  ok: "ok",
  missingReport: "missing_report",
  missingLineage: "missing_lineage",
  unknownCommit: "unknown_commit",
  commitMismatch: "commit_mismatch",
  dirtyWorktree: "dirty_worktree",
  staleReport: "stale_report",
  futureReport: "future_report",
  invalidGeneratedAt: "invalid_generated_at",
  reportFailed: "report_failed",
  configHashMismatch: "config_hash_mismatch",
  wrongCorpus: "wrong_corpus",
  wrongProvider: "wrong_provider",
  wrongModelRoute: "wrong_model_route",
  sourceReportLineageMismatch: "source_report_lineage_mismatch",
  robustLineageSplit: "robust_lineage_split",
});

export const RELEASE_EVIDENCE_REPORT_SPECS = Object.freeze([
  {
    id: "compare-hard-synthetic",
    fileName: "latest.json",
    reportType: "synthetic",
    providerId: "openai",
    providerMode: "real",
    modelRouteId: MODEL_ROUTE_IDS.chatDefault,
    suiteId: "robust",
    corpus: {
      id: "synthetic-corpus-compare-hard",
      relativePath: "server/evaluation/synthetic-corpus-compare-hard.json",
      version: "1",
    },
  },
  {
    id: "rerank-hard-cs",
    fileName: "latest-rerank-hard-cs.json",
    reportType: "rerank",
    providerId: "rerank",
    providerMode: "heuristic",
    modelRouteId: null,
    suiteId: "robust",
    corpus: {
      id: "synthetic-corpus-rerank-hard-cs",
      relativePath: "server/evaluation/synthetic-corpus-rerank-hard-cs.json",
      version: "1",
    },
  },
  {
    id: "arxiv-real-paper-rerank",
    fileName: "latest-arxiv-rerank.json",
    reportType: "rerank",
    providerId: "rerank",
    providerMode: "heuristic",
    modelRouteId: null,
    suiteId: "robust",
    corpus: {
      id: "arxiv-computer-science-rerank-seed",
      relativePath: "server/evaluation/generated/arxiv-corpus.json",
      version: "1",
    },
  },
  {
    id: "trajectory",
    fileName: "latest-trajectory.json",
    reportType: "trajectory",
    providerId: "agent-eval",
    providerMode: "deterministic",
    modelRouteId: null,
  },
  {
    id: "planner-real",
    fileName: "latest-planner-real.json",
    reportType: "planner",
    providerId: "openai",
    providerMode: "real",
    modelRouteId: MODEL_ROUTE_IDS.executionPlannerDefault,
  },
  {
    id: "recovery-observability",
    fileName: "latest-recovery-observability.json",
    reportType: "recovery_observability",
    providerId: "agent-observability",
    providerMode: "deterministic",
    modelRouteId: null,
  },
  {
    id: "runtime-smoke",
    fileName: "latest-runtime-smoke.json",
    reportType: "runtime_smoke",
    providerId: "openai",
    providerMode: "real",
    modelRouteId: MODEL_ROUTE_IDS.executionPlannerDefault,
  },
  {
    id: "rollout-readiness",
    fileName: "latest-rollout-readiness.json",
    reportType: "rollout_readiness",
    providerId: "release-readiness",
    providerMode: "aggregate",
    modelRouteId: null,
  },
]);

export const RELEASE_EVIDENCE_SOURCE_SPECS = Object.freeze([
  {
    id: "planner-mock",
    fileName: "latest-planner-mock.json",
    reportType: "planner",
    providerId: "mock",
    providerMode: "mock",
    modelRouteId: null,
  },
]);

export const RELEASE_READINESS_SOURCE_IDS = Object.freeze([
  "planner-mock",
  "planner-real",
  "trajectory",
  "recovery-observability",
  "runtime-smoke",
]);
