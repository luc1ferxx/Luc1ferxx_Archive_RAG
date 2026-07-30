import {
  getPublicEvaluationConfig,
  hashCanonicalJson,
} from "./eval-evidence.js";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export const EVALUATION_EVIDENCE_REASON_CODES = Object.freeze({
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
  wrongProfile: "wrong_profile",
});

export const toEvaluationEvidenceActualSummary = (report = {}) => ({
  reportType: report.evidence?.reportType ?? "unknown",
  runId: report.evidence?.runId ?? "unknown",
  generatedAt: report.evidence?.generatedAt ?? "unknown",
  commitSha: report.evidence?.git?.commitSha ?? "unknown",
  profile: report.evidence?.profile ?? "unknown",
  corpus: report.evidence?.corpus ?? null,
  provider: report.evidence?.provider ?? null,
  modelRouteId: report.evidence?.modelRouteId ?? null,
});

export const buildEvaluationEvidenceCheck = ({
  actual,
  expected,
  id,
  reasonCode = EVALUATION_EVIDENCE_REASON_CODES.ok,
  report,
  reportType,
} = {}) => ({
  id,
  status:
    reasonCode === EVALUATION_EVIDENCE_REASON_CODES.ok ? "pass" : "fail",
  reasonCode,
  expected,
  actual,
  reportType: reportType ?? report?.evidence?.reportType ?? "unknown",
  runId: report?.evidence?.runId ?? null,
  generatedAt: report?.evidence?.generatedAt ?? null,
  commitSha: report?.evidence?.git?.commitSha ?? null,
  corpus: report?.evidence?.corpus ?? null,
  provider: report?.evidence?.provider ?? null,
});

export const hasCompleteEvaluationLineage = (report, spec) => {
  const evidence = report?.evidence;

  return Boolean(
      evidence &&
      evidence.schemaVersion &&
      evidence.reportType === spec.reportType &&
      evidence.reportId === (spec.reportId ?? spec.id) &&
      evidence.runId &&
      evidence.generatedAt &&
      evidence.git &&
      evidence.command &&
      evidence.profile &&
      evidence.corpus &&
      evidence.corpus.id &&
      evidence.corpus.relativePath &&
      evidence.corpus.contentHash &&
      evidence.corpus.version &&
      evidence.configHash &&
      evidence.provider?.id &&
      evidence.provider?.mode &&
      Object.hasOwn(evidence, "modelRouteId") &&
      Array.isArray(evidence.sourceReports) &&
      evidence.generatorVersion
  );
};

export const getEvaluationEvidenceFailureReason = ({
  expectedCorpusHash,
  maxAgeHours,
  nowMs,
  report,
  reportPassed = true,
  spec,
  targetCommit,
} = {}) => {
  if (!report) {
    return EVALUATION_EVIDENCE_REASON_CODES.missingReport;
  }

  if (!hasCompleteEvaluationLineage(report, spec)) {
    return EVALUATION_EVIDENCE_REASON_CODES.missingLineage;
  }

  if (!reportPassed) {
    return EVALUATION_EVIDENCE_REASON_CODES.reportFailed;
  }

  const evidence = report.evidence;

  if (evidence.git.commitSha === "unknown") {
    return EVALUATION_EVIDENCE_REASON_CODES.unknownCommit;
  }

  if (evidence.git.commitSha !== targetCommit) {
    return EVALUATION_EVIDENCE_REASON_CODES.commitMismatch;
  }

  if (evidence.git.dirty !== false) {
    return EVALUATION_EVIDENCE_REASON_CODES.dirtyWorktree;
  }

  const generatedAtMs = Date.parse(evidence.generatedAt);

  if (!Number.isFinite(generatedAtMs)) {
    return EVALUATION_EVIDENCE_REASON_CODES.invalidGeneratedAt;
  }

  if (generatedAtMs > nowMs) {
    return EVALUATION_EVIDENCE_REASON_CODES.futureReport;
  }

  if (nowMs - generatedAtMs > maxAgeHours * 60 * 60 * 1000) {
    return EVALUATION_EVIDENCE_REASON_CODES.staleReport;
  }

  const expectedConfigHash = hashCanonicalJson(
    getPublicEvaluationConfig({ report, reportType: spec.reportType })
  );

  if (
    !SHA256_PATTERN.test(evidence.configHash) ||
    evidence.configHash !== expectedConfigHash
  ) {
    return EVALUATION_EVIDENCE_REASON_CODES.configHashMismatch;
  }

  if (
    spec.corpus &&
    (evidence.corpus.id !== spec.corpus.id ||
      evidence.corpus.relativePath !== spec.corpus.relativePath ||
      evidence.corpus.version !== spec.corpus.version ||
      !SHA256_PATTERN.test(evidence.corpus.contentHash) ||
      (expectedCorpusHash !== undefined &&
        evidence.corpus.contentHash !== expectedCorpusHash))
  ) {
    return EVALUATION_EVIDENCE_REASON_CODES.wrongCorpus;
  }

  if (
    evidence.provider.id !== spec.providerId ||
    evidence.provider.mode !== spec.providerMode
  ) {
    return EVALUATION_EVIDENCE_REASON_CODES.wrongProvider;
  }

  if (spec.profile && evidence.profile !== spec.profile) {
    return EVALUATION_EVIDENCE_REASON_CODES.wrongProfile;
  }

  if (evidence.modelRouteId !== spec.modelRouteId) {
    return EVALUATION_EVIDENCE_REASON_CODES.wrongModelRoute;
  }

  return EVALUATION_EVIDENCE_REASON_CODES.ok;
};
