import { incrementMapCount } from "./quality-shared.js";
import {
  buildFailedCases,
  buildQualityRunSummary,
  getFeedbackMetadata,
  getReportableClaimSummary,
  hasCurrentUnsupportedClaims,
} from "./quality-run-summary.js";

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

export const buildFeedbackGateChecks = ({ feedbackGate = {} } = {}) => [
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
