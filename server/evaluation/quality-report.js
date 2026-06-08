import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const resultsDirectory = path.join(__dirname, "results");
const latestResultPath = path.join(resultsDirectory, "latest.json");
const latestFeedbackResultPath = path.join(resultsDirectory, "latest-feedback.json");
const defaultHistoryLimit = 10;
const statusRank = {
  unknown: 0,
  ok: 1,
  pass: 1,
  warn: 2,
  fail: 3,
};

const regressionMetricChecks = [
  {
    metric: "overallPassRate",
    label: "Overall pass rate",
    warnDrop: 0.02,
    failDrop: 0.05,
  },
  {
    metric: "qaPageHitRate",
    label: "QA page hit rate",
    warnDrop: 0.05,
    failDrop: 0.1,
  },
  {
    metric: "comparePageHitRate",
    label: "Compare page hit rate",
    warnDrop: 0.05,
    failDrop: 0.1,
  },
  {
    metric: "averageCitationCount",
    label: "Average citations",
    warnDrop: 0.5,
    failDrop: 1,
  },
];

const toPercent = (value) =>
  typeof value === "number" ? Number((value * 100).toFixed(1)) : null;

const getWorstStatus = (statuses = []) =>
  statuses.reduce((worstStatus, status) => {
    const normalizedStatus = status ?? "unknown";

    return (statusRank[normalizedStatus] ?? 0) > (statusRank[worstStatus] ?? 0)
      ? normalizedStatus
      : worstStatus;
  }, "unknown");

const getCorpusName = (corpusPath) => {
  if (!corpusPath) {
    return null;
  }

  return String(corpusPath).split(/[\\/]/).pop() ?? corpusPath;
};

const isFeedbackResultPayload = (payload = {}) => {
  const corpusPath = String(payload.summary?.corpus?.path ?? "");
  const corpusName = getCorpusName(corpusPath);

  return corpusName === "feedback-corpus.json";
};

const toTimestamp = (createdAt) => {
  const parsed = Date.parse(createdAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

const isQualityResultFile = (fileName) =>
  fileName.endsWith(".json") &&
  !fileName.startsWith("latest") &&
  !fileName.includes("ragas");

const readJsonFile = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

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

const buildFailedCases = (cases = []) =>
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

const getFeedbackMetadata = (caseResult = {}) => {
  const metadata = caseResult.metadata && typeof caseResult.metadata === "object"
    ? caseResult.metadata
    : {};
  const feedback = metadata.feedback && typeof metadata.feedback === "object"
    ? metadata.feedback
    : {};

  return feedback;
};

const normalizeSkill = (skill = {}) => ({
  skillId: String(skill.skillId ?? skill.id ?? "unknown").trim() || "unknown",
  skillVersion:
    String(skill.skillVersion ?? skill.version ?? "unknown").trim() || "unknown",
  label: String(skill.label ?? skill.skillId ?? skill.id ?? "Unknown skill").trim() ||
    "Unknown skill",
});

const getFeedbackSkills = (caseResult = {}) => {
  const feedback = getFeedbackMetadata(caseResult);
  const skills = Array.isArray(feedback.skills)
    ? feedback.skills.map(normalizeSkill).filter((skill) => skill.skillId)
    : [];

  return skills.length > 0
    ? skills
    : [
        {
          skillId: "unknown",
          skillVersion: "unknown",
          label: "Unknown skill",
        },
      ];
};

const getFeedbackType = (caseResult = {}) =>
  String(getFeedbackMetadata(caseResult).feedbackType ?? "unknown").trim() ||
  "unknown";

const isRecord = (value) => value && typeof value === "object";

const toNonNegativeInteger = (value, fallbackValue = 0) => {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? Math.floor(parsedValue)
    : fallbackValue;
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

const getReportableClaimSummary = (caseResult = {}) =>
  summarizeClaimChecks([
    ...getCurrentClaimChecks(caseResult),
    ...getFeedbackClaimChecks(caseResult),
  ]);

const hasCurrentUnsupportedClaims = (caseResult = {}) =>
  getCurrentClaimSummary(caseResult).unsupportedClaimCount > 0;

const incrementMapCount = (target, key) => {
  target[key] = (target[key] ?? 0) + 1;
};

export const buildFeedbackSkillFailures = (cases = []) => {
  const statsBySkill = new Map();

  for (const caseResult of cases) {
    if (caseResult.passed && !hasCurrentUnsupportedClaims(caseResult)) {
      continue;
    }

    const feedbackType = getFeedbackType(caseResult);
    const claimSummary = getReportableClaimSummary(caseResult);

    for (const skill of getFeedbackSkills(caseResult)) {
      const skillKey = `${skill.skillId}@${skill.skillVersion}`;
      const stats = statsBySkill.get(skillKey) ?? {
        skillKey,
        skillId: skill.skillId,
        skillVersion: skill.skillVersion,
        label: skill.label,
        failedCaseCount: 0,
        feedbackTypes: {},
        unsupportedClaimCount: 0,
        unsupportedClaimCaseCount: 0,
        unsupportedClaims: [],
        failedCaseIds: [],
      };

      stats.failedCaseCount += 1;
      incrementMapCount(stats.feedbackTypes, feedbackType);
      stats.unsupportedClaimCount += claimSummary.unsupportedClaimCount;

      if (claimSummary.unsupportedClaimCount > 0) {
        stats.unsupportedClaimCaseCount += 1;
        stats.unsupportedClaims.push(
          ...claimSummary.unsupportedClaims.map((claim) => ({
            caseId: caseResult.id,
            text: claim.text,
            missingAnchors: claim.missingAnchors,
          }))
        );
        stats.unsupportedClaims = stats.unsupportedClaims.slice(0, 12);
      }

      stats.failedCaseIds.push(caseResult.id);
      statsBySkill.set(skillKey, stats);
    }
  }

  return [...statsBySkill.values()].sort(
    (left, right) =>
      right.failedCaseCount - left.failedCaseCount ||
      left.skillKey.localeCompare(right.skillKey)
  );
};

const feedbackTypeLabels = {
  citation_error: ["citation error", "citation errors"],
  incomplete: ["incomplete answer", "incomplete answers"],
  hallucination: ["hallucination", "hallucinations"],
  unknown: ["unknown feedback", "unknown feedback"],
};

const formatFeedbackTypeCount = ([feedbackType, count]) => {
  const labels = feedbackTypeLabels[feedbackType] ?? [
    feedbackType.replaceAll("_", " "),
    `${feedbackType.replaceAll("_", " ")}s`,
  ];

  return `${count} ${count === 1 ? labels[0] : labels[1]}`;
};

const formatUnsupportedClaimCount = (count = 0) =>
  count > 0
    ? `${count} unsupported claim${count === 1 ? "" : "s"}`
    : null;

export const formatFeedbackSkillFailureLine = (skillFailure = {}) => {
  const feedbackTypeSummary = Object.entries(skillFailure.feedbackTypes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(formatFeedbackTypeCount);
  const unsupportedClaimSummary = formatUnsupportedClaimCount(
    skillFailure.unsupportedClaimCount ?? 0
  );
  const summaryParts = [
    ...feedbackTypeSummary,
    unsupportedClaimSummary,
  ].filter(Boolean);

  return `${skillFailure.skillKey}: ${summaryParts.join(", ") || "0 failures"}`;
};

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

const buildRegressionMetricCheck = ({ baselineRun, currentRun, definition }) => {
  const baselineValue = baselineRun.metrics?.[definition.metric];
  const currentValue = currentRun.metrics?.[definition.metric];

  if (typeof baselineValue !== "number" || typeof currentValue !== "number") {
    return {
      metric: definition.metric,
      label: definition.label,
      status: "unknown",
      baselineValue: baselineValue ?? null,
      currentValue: currentValue ?? null,
      delta: null,
    };
  }

  const delta = Number((currentValue - baselineValue).toFixed(4));
  const status =
    delta <= -definition.failDrop
      ? "fail"
      : delta <= -definition.warnDrop
        ? "warn"
        : "pass";

  return {
    metric: definition.metric,
    label: definition.label,
    status,
    baselineValue,
    currentValue,
    delta,
    warnDrop: definition.warnDrop,
    failDrop: definition.failDrop,
  };
};

const buildFailedCaseCheck = ({ baselineRun, currentRun }) => {
  const baselineValue = baselineRun.failedCaseCount ?? 0;
  const currentValue = currentRun.failedCaseCount ?? 0;
  const delta = currentValue - baselineValue;
  const status = delta >= 2 ? "fail" : delta >= 1 ? "warn" : "pass";

  return {
    metric: "failedCaseCount",
    label: "Failed cases",
    status,
    baselineValue,
    currentValue,
    delta,
    warnIncrease: 1,
    failIncrease: 2,
  };
};

export const buildRegressionGate = ({ baselineRun = null, currentRun = null } = {}) => {
  if (!currentRun) {
    return {
      status: "unknown",
      currentRunId: null,
      baselineRunId: null,
      checks: [],
      summary: "No synthetic evaluation run is available yet.",
    };
  }

  if (!baselineRun) {
    return {
      status: "unknown",
      currentRunId: currentRun.runId,
      baselineRunId: null,
      checks: [],
      summary: "No previous synthetic run is available for regression comparison.",
    };
  }

  const checks = [
    ...regressionMetricChecks.map((definition) =>
      buildRegressionMetricCheck({
        baselineRun,
        currentRun,
        definition,
      })
    ),
    buildFailedCaseCheck({
      baselineRun,
      currentRun,
    }),
  ];
  const status = getWorstStatus(checks.map((check) => check.status));
  const summary =
    status === "fail"
      ? "Regression detected against the previous synthetic run."
      : status === "warn"
        ? "Possible quality regression detected against the previous synthetic run."
        : "No regression detected against the previous synthetic run.";

  return {
    status,
    currentRunId: currentRun.runId,
    baselineRunId: baselineRun.runId,
    baselineCreatedAt: baselineRun.createdAt,
    checks,
    summary,
  };
};

export const buildFeedbackGate = ({ latestFeedbackPayload = null } = {}) => {
  if (!latestFeedbackPayload) {
    return {
      status: "pass",
      skipped: true,
      currentRunId: null,
      failedCaseCount: 0,
      unsupportedClaimCount: 0,
      unsupportedClaimCaseCount: 0,
      caseCount: 0,
      skillFailures: [],
      failedCases: [],
      summary: "No feedback evaluation report is available; feedback gate skipped.",
    };
  }

  const latestFeedbackRun = buildQualityRunSummary({
    fileName: "latest-feedback.json",
    payload: latestFeedbackPayload,
  });
  const cases = Array.isArray(latestFeedbackPayload.cases)
    ? latestFeedbackPayload.cases
    : [];
  const failedCases = buildFailedCases(cases);
  const skillFailures = buildFeedbackSkillFailures(cases);
  const failedCaseCount = failedCases.length;
  const unsupportedClaimCount = failedCases.reduce(
    (sum, caseResult) => sum + (caseResult.unsupportedClaimCount ?? 0),
    0
  );
  const unsupportedClaimCaseCount = failedCases.filter(
    (caseResult) => (caseResult.unsupportedClaimCount ?? 0) > 0
  ).length;
  const status = failedCaseCount > 0 ? "fail" : "pass";
  const claimSummary = unsupportedClaimCount > 0
    ? ` ${unsupportedClaimCount} unsupported claim${
        unsupportedClaimCount === 1 ? "" : "s"
      } flagged.`
    : "";
  const summary = cases.length === 0
    ? "Feedback evaluation has no cases yet."
    : failedCaseCount > 0
      ? `Feedback evaluation failed ${failedCaseCount} of ${cases.length} case${
          cases.length === 1 ? "" : "s"
        }.${claimSummary}`
      : `Feedback evaluation passed all ${cases.length} case${
          cases.length === 1 ? "" : "s"
        }.`;

  return {
    status,
    skipped: false,
    currentRunId: latestFeedbackRun?.runId ?? null,
    latestRun: latestFeedbackRun,
    failedCaseCount,
    unsupportedClaimCount,
    unsupportedClaimCaseCount,
    caseCount: cases.length,
    skillFailures,
    failedCases,
    summary,
  };
};

const buildFeedbackGateChecks = ({ feedbackGate = {} } = {}) => [
  {
    metric: "feedbackFailedCaseCount",
    label: "Feedback failed cases",
    status: (feedbackGate.failedCaseCount ?? 0) > 0 ? "fail" : "pass",
    currentValue: feedbackGate.failedCaseCount ?? 0,
    baselineValue: 0,
    delta: feedbackGate.failedCaseCount ?? 0,
  },
  {
    metric: "feedbackUnsupportedClaimCount",
    label: "Feedback unsupported claims",
    status: (feedbackGate.unsupportedClaimCount ?? 0) > 0 ? "fail" : "pass",
    currentValue: feedbackGate.unsupportedClaimCount ?? 0,
    baselineValue: 0,
    delta: feedbackGate.unsupportedClaimCount ?? 0,
  },
];

export const buildCombinedQualityGate = ({
  regressionGate = {},
  feedbackGate = {},
} = {}) => {
  if (feedbackGate.status === "fail") {
    return {
      status: "fail",
      summary: feedbackGate.summary,
      checks: [
        ...(regressionGate.checks ?? []),
        ...buildFeedbackGateChecks({
          feedbackGate,
        }),
      ],
    };
  }

  if (regressionGate.status === "fail" || regressionGate.status === "warn") {
    return {
      status: regressionGate.status,
      summary: regressionGate.summary,
      checks: regressionGate.checks ?? [],
    };
  }

  if (regressionGate.status === "unknown") {
    return {
      status: "unknown",
      summary: regressionGate.summary,
      checks: regressionGate.checks ?? [],
    };
  }

  return {
    status: "pass",
    summary:
      feedbackGate.skipped
        ? regressionGate.summary
        : `${regressionGate.summary} ${feedbackGate.summary}`,
    checks: [
      ...(regressionGate.checks ?? []),
      ...buildFeedbackGateChecks({
        feedbackGate,
      }),
    ],
  };
};

export const buildQualityHistoryResponse = ({
  latestPayload = null,
  latestFeedbackPayload = null,
  limit = defaultHistoryLimit,
  runPayloads = [],
} = {}) => {
  const runSummaries = runPayloads
    .filter((entry) => !isFeedbackResultPayload(entry.payload))
    .map((entry) =>
      buildQualityRunSummary({
        fileName: entry.fileName,
        payload: entry.payload,
      })
    )
    .filter(Boolean)
    .sort((left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt));
  const latestRun = latestPayload
    ? buildQualityRunSummary({
        fileName: "latest.json",
        payload: latestPayload,
      })
    : runSummaries[0] ?? null;
  const combinedRuns =
    latestRun && !runSummaries.some((run) => run.runId === latestRun.runId)
      ? [latestRun, ...runSummaries]
      : runSummaries;
  const sortedRuns = combinedRuns.sort(
    (left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt)
  );
  const currentRun = latestRun ?? sortedRuns[0] ?? null;
  const baselineRun =
    sortedRuns.find((run) => run.runId !== currentRun?.runId) ?? null;
  const regressionGate = buildRegressionGate({
    baselineRun,
    currentRun,
  });
  const feedbackGate = buildFeedbackGate({
    latestFeedbackPayload,
  });
  const qualityGate = buildCombinedQualityGate({
    regressionGate,
    feedbackGate,
  });

  return {
    status: qualityGate.status,
    latestRun: currentRun,
    runs: sortedRuns.slice(0, limit),
    regressionGate,
    feedbackGate,
    qualityGate,
  };
};

export const buildQualityGateDecision = ({
  allowUnknown = false,
  failOnWarn = false,
  history = {},
} = {}) => {
  const gate = history.qualityGate ?? history.regressionGate ?? {};
  const status = gate.status ?? history.status ?? "unknown";
  const summary =
    gate.summary ??
    "No quality regression gate summary is available.";
  const exitCode =
    status === "fail"
      ? 1
      : status === "warn" && failOnWarn
        ? 1
        : status === "unknown" && !allowUnknown
          ? 2
          : 0;

  return {
    exitCode,
    status,
    passed: exitCode === 0,
    summary,
  };
};

export const readLatestQualityReport = async () => {
  let payload = null;

  try {
    payload = await readJsonFile(latestResultPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      const missingError = new Error("No synthetic evaluation report exists yet.");
      missingError.status = 404;
      throw missingError;
    }

    throw error;
  }

  return buildQualityReportFromResultPayload(payload);
};

export const readQualityHistory = async ({ limit = defaultHistoryLimit } = {}) => {
  let latestPayload = null;
  let latestFeedbackPayload = null;

  try {
    latestPayload = await readJsonFile(latestResultPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    latestFeedbackPayload = await readJsonFile(latestFeedbackResultPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  let fileNames = [];

  try {
    fileNames = await readdir(resultsDirectory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return buildQualityHistoryResponse({
        latestPayload,
        latestFeedbackPayload,
        limit,
        runPayloads: [],
      });
    }

    throw error;
  }

  const runPayloads = (
    await Promise.all(
      fileNames.filter(isQualityResultFile).map(async (fileName) => {
        try {
          return {
            fileName,
            payload: await readJsonFile(path.join(resultsDirectory, fileName)),
          };
        } catch (error) {
          console.warn(`Skipping unreadable quality result ${fileName}.`, error);
          return null;
        }
      })
    )
  ).filter(Boolean);

  return buildQualityHistoryResponse({
    latestPayload,
    latestFeedbackPayload,
    limit,
    runPayloads,
  });
};

export const runSyntheticQualityEvaluation = async ({ corpusPath = "" } = {}) => {
  const args = ["evaluation/run-synthetic-eval.mjs"];

  if (corpusPath) {
    args.push(corpusPath);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: serverDirectory,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];

    child.stderr.on("data", (chunk) => {
      stderr.push(chunk.toString("utf8"));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error(
        `Synthetic evaluation failed with exit code ${code}: ${stderr.join("").slice(-1200)}`
      );
      error.status = 500;
      reject(error);
    });
  });

  return readLatestQualityReport();
};
