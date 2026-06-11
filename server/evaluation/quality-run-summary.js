import {
  getCorpusName,
  isRecord,
  toNonNegativeInteger,
  toPercent,
} from "./quality-shared.js";

export const isFeedbackResultPayload = (payload = {}) => {
  const corpusPath = String(payload.summary?.corpus?.path ?? "");
  const corpusName = getCorpusName(corpusPath);

  return corpusName === "feedback-corpus.json";
};

export const isPlannerResultPayload = (payload = {}) => {
  const summary = payload.summary ?? {};
  const metrics = summary.metrics ?? {};

  return (
    typeof summary.provider === "string" &&
    typeof metrics.failedCheckCount === "number" &&
    Array.isArray(payload.cases) &&
    payload.cases.some((caseResult) => caseResult?.response?.planner)
  );
};

export const isSyntheticRegressionResultPayload = (payload = {}) =>
  typeof payload.summary?.metrics?.overallPassRate === "number" &&
  !isFeedbackResultPayload(payload) &&
  !isPlannerResultPayload(payload);

export const getFeedbackMetadata = (caseResult = {}) => {
  const metadata = caseResult.metadata && typeof caseResult.metadata === "object"
    ? caseResult.metadata
    : {};
  const feedback = metadata.feedback && typeof metadata.feedback === "object"
    ? metadata.feedback
    : {};

  return feedback;
};

const normalizeClaimCheck = (claimCheck = {}) => {
  const claims = Array.isArray(claimCheck.claims)
    ? claimCheck.claims.slice(0, 12).map((claim) => ({
        text: String(claim.text ?? "").trim(),
        supported: Boolean(claim.supported),
        tokenOverlap: Number.isFinite(Number(claim.tokenOverlap))
          ? Number(claim.tokenOverlap)
          : null,
        anchors: Array.isArray(claim.anchors)
          ? claim.anchors.map((anchor) => String(anchor ?? "").trim()).filter(Boolean)
          : [],
        missingAnchors: Array.isArray(claim.missingAnchors)
          ? claim.missingAnchors
              .map((anchor) => String(anchor ?? "").trim())
              .filter(Boolean)
          : [],
      }))
    : [];
  const derivedUnsupportedClaimCount = claims.filter(
    (claim) => !claim.supported
  ).length;
  const unsupportedClaimCount = toNonNegativeInteger(
    claimCheck.unsupportedClaimCount,
    derivedUnsupportedClaimCount
  );

  return {
    checked: Boolean(claimCheck.checked),
    supportedClaimCount: toNonNegativeInteger(claimCheck.supportedClaimCount),
    unsupportedClaimCount,
    claims,
  };
};

const summarizeClaimChecks = (claimChecks = []) => {
  const normalizedClaimChecks = claimChecks
    .filter(isRecord)
    .map(normalizeClaimCheck)
    .filter(
      (claimCheck) =>
        claimCheck.checked ||
        claimCheck.unsupportedClaimCount > 0 ||
        claimCheck.claims.length > 0
    );
  const unsupportedClaims = normalizedClaimChecks
    .flatMap((claimCheck) =>
      claimCheck.claims
        .filter((claim) => !claim.supported)
        .map((claim) => ({
          text: claim.text,
          missingAnchors: claim.missingAnchors,
        }))
    )
    .filter((claim) => claim.text)
    .slice(0, 12);

  return {
    checked: normalizedClaimChecks.some((claimCheck) => claimCheck.checked),
    claimChecks: normalizedClaimChecks,
    unsupportedClaimCount: normalizedClaimChecks.reduce(
      (sum, claimCheck) => sum + claimCheck.unsupportedClaimCount,
      0
    ),
    unsupportedClaims,
  };
};

const getCurrentClaimChecks = (caseResult = {}) => {
  const metadata = isRecord(caseResult.metadata) ? caseResult.metadata : {};
  const checks = [];

  if (isRecord(caseResult.claimSupport)) {
    checks.push(caseResult.claimSupport);
  }

  if (isRecord(metadata.claimSupport)) {
    checks.push(metadata.claimSupport);
  }

  return checks;
};

const getFeedbackClaimChecks = (caseResult = {}) => {
  const feedback = getFeedbackMetadata(caseResult);

  return Array.isArray(feedback.claimChecks) ? feedback.claimChecks : [];
};

const getCurrentClaimSummary = (caseResult = {}) =>
  summarizeClaimChecks(getCurrentClaimChecks(caseResult));

const getFeedbackClaimSummary = (caseResult = {}) =>
  summarizeClaimChecks(getFeedbackClaimChecks(caseResult));

export const getReportableClaimSummary = (caseResult = {}) =>
  summarizeClaimChecks([
    ...getCurrentClaimChecks(caseResult),
    ...getFeedbackClaimChecks(caseResult),
  ]);

export const hasCurrentUnsupportedClaims = (caseResult = {}) =>
  getCurrentClaimSummary(caseResult).unsupportedClaimCount > 0;

const getFailedReasons = (caseResult = {}) => {
  const reasons = [];

  if (!caseResult.shouldAbstain && caseResult.abstained) {
    reasons.push("Unexpected abstain");
  }

  if (caseResult.shouldAbstain && !caseResult.abstained) {
    reasons.push("Expected abstain was missed");
  }

  if (!caseResult.docCoverageHit) {
    reasons.push("Document coverage missed");
  }

  if (!caseResult.pageCoverageHit) {
    reasons.push("Page coverage missed");
  }

  if (!caseResult.answerExpectationHit) {
    reasons.push("Answer expectation missed");
  }

  const currentClaimSummary = getCurrentClaimSummary(caseResult);

  if (currentClaimSummary.unsupportedClaimCount > 0) {
    reasons.push(
      `${currentClaimSummary.unsupportedClaimCount} unsupported answer claim${
        currentClaimSummary.unsupportedClaimCount === 1 ? "" : "s"
      }`
    );
  }

  const feedbackClaimSummary = getFeedbackClaimSummary(caseResult);

  if (
    currentClaimSummary.unsupportedClaimCount === 0 &&
    feedbackClaimSummary.unsupportedClaimCount > 0
  ) {
    reasons.push(
      `Feedback record flagged ${feedbackClaimSummary.unsupportedClaimCount} unsupported claim${
        feedbackClaimSummary.unsupportedClaimCount === 1 ? "" : "s"
      }`
    );
  }

  return reasons.length > 0 ? reasons : ["Case failed"];
};

export const buildFailedCases = (cases = []) =>
  cases
    .filter((caseResult) => !caseResult.passed || hasCurrentUnsupportedClaims(caseResult))
    .map((caseResult) => {
      const currentClaimSummary = getCurrentClaimSummary(caseResult);
      const feedbackClaimSummary = getFeedbackClaimSummary(caseResult);

      return {
        id: caseResult.id,
        type: caseResult.type,
        question: caseResult.question,
        answer: caseResult.answer,
        citationCount: caseResult.citationCount ?? 0,
        responseTimeMs: caseResult.responseTimeMs ?? null,
        reasons: getFailedReasons(caseResult),
        citations: caseResult.citations ?? [],
        currentClaimSupport: currentClaimSummary,
        feedbackClaimSupport: feedbackClaimSummary,
        unsupportedClaimCount:
          currentClaimSummary.unsupportedClaimCount +
          feedbackClaimSummary.unsupportedClaimCount,
        metadata: caseResult.metadata ?? null,
      };
    });

const buildRecommendations = ({ metrics = {}, failedCases = [] }) => {
  const recommendations = [];
  const failedReasonText = failedCases
    .flatMap((caseResult) => caseResult.reasons)
    .join(" ")
    .toLowerCase();

  if ((metrics.overallPassRate ?? 1) < 0.9) {
    recommendations.push({
      label: "Review failed cases before adding more features",
      detail: "Overall pass rate is below 90%, so retrieval or answer grounding needs attention.",
    });
  }

  if (
    (metrics.qaPageHitRate ?? 1) < 0.9 ||
    (metrics.comparePageHitRate ?? 1) < 0.9 ||
    failedReasonText.includes("page coverage")
  ) {
    recommendations.push({
      label: "Tune retrieval breadth",
      detail: "Page coverage misses usually mean increasing retrieval topK, enabling rerank, or adjusting chunk overlap.",
    });
  }

  if (
    (metrics.compareDocCoverageRate ?? 1) < 0.9 ||
    failedReasonText.includes("document coverage")
  ) {
    recommendations.push({
      label: "Inspect multi-document retrieval balance",
      detail: "Document coverage misses point to compare topK-per-doc, hybrid retrieval, or per-document evidence alignment.",
    });
  }

  if ((metrics.abstainAccuracy ?? 1) < 1) {
    recommendations.push({
      label: "Tighten abstain confidence gates",
      detail: "Abstain misses indicate the confidence gate should be stricter for unsupported or cross-document questions.",
    });
  }

  if (
    (metrics.claimSupportHitRate ?? 1) < 1 ||
    failedReasonText.includes("unsupported answer claim")
  ) {
    recommendations.push({
      label: "Review unsupported answer claims",
      detail: "Unsupported claims mean answers are saying more than the cited excerpts can prove.",
    });
  }

  if ((metrics.averageCitationCount ?? 0) < 1) {
    recommendations.push({
      label: "Require stronger citation coverage",
      detail: "Average citation count below one means answers may not be reliably grounded.",
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      label: "Quality gate is healthy",
      detail: "No immediate retrieval or grounding tuning is suggested by the latest synthetic run.",
    });
  }

  return recommendations;
};

const getStatus = ({ metrics = {}, failedCases = [] }) => {
  if (failedCases.length === 0 && (metrics.overallPassRate ?? 0) >= 0.99) {
    return "ok";
  }

  if ((metrics.overallPassRate ?? 0) >= 0.8) {
    return "warn";
  }

  return "fail";
};

export const buildQualityReportFromResultPayload = (payload = {}) => {
  const summary = payload.summary ?? {};
  const metrics = summary.metrics ?? {};
  const failedCases = buildFailedCases(payload.cases ?? []);

  return {
    status: getStatus({
      metrics,
      failedCases,
    }),
    summary: {
      runId: summary.runId ?? null,
      createdAt: summary.createdAt ?? null,
      corpus: summary.corpus ?? null,
      models: summary.models ?? null,
      config: summary.config ?? null,
      metrics: {
        ...metrics,
        overallPassPercent: toPercent(metrics.overallPassRate),
        qaPageHitPercent: toPercent(metrics.qaPageHitRate),
        compareDocCoveragePercent: toPercent(metrics.compareDocCoverageRate),
        comparePageHitPercent: toPercent(metrics.comparePageHitRate),
        abstainAccuracyPercent: toPercent(metrics.abstainAccuracy),
        claimSupportHitPercent: toPercent(metrics.claimSupportHitRate),
      },
    },
    failedCases,
    recommendations: buildRecommendations({
      metrics,
      failedCases,
    }),
  };
};

export const buildQualityRunSummary = ({ fileName = null, payload = {} } = {}) => {
  if (!payload?.summary?.metrics) {
    return null;
  }

  const report = buildQualityReportFromResultPayload(payload);
  const summary = report.summary ?? {};
  const corpus = summary.corpus ?? null;

  return {
    runId:
      summary.runId ??
      (fileName ? fileName.replace(/\.json$/i, "") : "unknown-run"),
    createdAt: summary.createdAt ?? null,
    fileName,
    status: report.status,
    corpus: corpus
      ? {
          ...corpus,
          name: getCorpusName(corpus.path),
        }
      : null,
    models: summary.models ?? null,
    config: summary.config ?? null,
    metrics: summary.metrics ?? {},
    failedCaseCount: report.failedCases.length,
    caseCount: Array.isArray(payload.cases)
      ? payload.cases.length
      : corpus?.cases ?? null,
  };
};
