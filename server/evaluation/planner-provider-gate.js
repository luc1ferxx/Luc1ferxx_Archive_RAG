import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlannerReportFileNames } from "./planner/report.js";
import { buildPlannerGate } from "./quality-planner-gate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultResultsDirectory = path.join(__dirname, "results");

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeProvider = (value, fallback = "") =>
  normalizeText(value).toLowerCase() || fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const toNonNegativeNumber = (value, fallback = 0) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const getPlanner = (caseResult = {}) =>
  caseResult.response?.planner ?? caseResult.response?.executionPlanner ?? {};

const getPlannerStepIds = (caseResult = {}) =>
  toArray(getPlanner(caseResult).stepIds).map(normalizeText).filter(Boolean);

const isFallbackPlannerCase = (caseResult = {}) => {
  const planner = getPlanner(caseResult);

  return planner.fallback === true || planner.status === "fallback";
};

const isExpectedFallbackCase = (caseResult = {}) =>
  normalizeText(caseResult.id).toLowerCase().includes("fallback") ||
  toArray(caseResult.checks).some((check) => check.category === "fallback");

const buildPlannerSignature = (caseResult = {}) => {
  const planner = getPlanner(caseResult);

  return {
    fallback: planner.fallback === true,
    selectedPlannerId: normalizeText(planner.selectedPlannerId),
    status: normalizeText(planner.status),
    stepIds: getPlannerStepIds(caseResult),
  };
};

const sameSignature = (left, right) =>
  left.fallback === right.fallback &&
  left.selectedPlannerId === right.selectedPlannerId &&
  left.status === right.status &&
  left.stepIds.join(">") === right.stepIds.join(">");

export const buildPlannerFallbackMetrics = ({ payload = null } = {}) => {
  const cases = toArray(payload?.cases);
  const fallbackCases = cases.filter(isFallbackPlannerCase);
  const expectedFallbackCases = fallbackCases.filter(isExpectedFallbackCase);
  const unexpectedFallbackCases = fallbackCases.filter(
    (caseResult) => !isExpectedFallbackCase(caseResult)
  );
  const caseCount = cases.length;

  return {
    caseCount,
    fallbackCaseIds: fallbackCases.map((caseResult) => caseResult.id),
    fallbackCount: fallbackCases.length,
    fallbackRate: caseCount > 0 ? fallbackCases.length / caseCount : 0,
    expectedFallbackCaseIds: expectedFallbackCases.map(
      (caseResult) => caseResult.id
    ),
    expectedFallbackCount: expectedFallbackCases.length,
    unexpectedFallbackCaseIds: unexpectedFallbackCases.map(
      (caseResult) => caseResult.id
    ),
    unexpectedFallbackCount: unexpectedFallbackCases.length,
    unexpectedFallbackRate:
      caseCount > 0 ? unexpectedFallbackCases.length / caseCount : 0,
  };
};

export const buildPlannerDivergenceMetrics = ({
  comparePayload = null,
  payload = null,
} = {}) => {
  const compareCasesById = new Map(
    toArray(comparePayload?.cases).map((caseResult) => [caseResult.id, caseResult])
  );
  const caseIds = new Set();
  const divergences = [];

  for (const caseResult of toArray(payload?.cases)) {
    caseIds.add(caseResult.id);
    const compareCase = compareCasesById.get(caseResult.id);

    if (!compareCase) {
      divergences.push({
        id: caseResult.id,
        label: caseResult.label,
        reason: "missing_compare_case",
        actual: buildPlannerSignature(caseResult),
        expected: null,
      });
      continue;
    }

    const actual = buildPlannerSignature(caseResult);
    const expected = buildPlannerSignature(compareCase);

    if (!sameSignature(actual, expected)) {
      divergences.push({
        id: caseResult.id,
        label: caseResult.label,
        reason: "planner_signature_mismatch",
        actual,
        expected,
      });
    }
  }

  for (const compareCase of toArray(comparePayload?.cases)) {
    if (caseIds.has(compareCase.id)) {
      continue;
    }

    divergences.push({
      id: compareCase.id,
      label: compareCase.label,
      reason: "missing_provider_case",
      actual: null,
      expected: buildPlannerSignature(compareCase),
    });
  }

  return {
    divergenceCount: divergences.length,
    divergences,
  };
};

export const buildRequiredPlannerProviderGate = ({
  comparePayload = null,
  compareProvider = "",
  maxDivergenceCount = 0,
  maxUnexpectedFallbackRate = 0,
  payload = null,
  provider = "real",
  requireCompare = false,
} = {}) => {
  const normalizedProvider = normalizeProvider(provider, "real");
  const normalizedCompareProvider = normalizeProvider(compareProvider);
  const fallbackLimit = toNonNegativeNumber(maxUnexpectedFallbackRate, 0);
  const divergenceLimit = toNonNegativeNumber(maxDivergenceCount, 0);

  if (!payload) {
    return {
      status: "fail",
      provider: normalizedProvider,
      compareProvider: normalizedCompareProvider || null,
      failedReasons: ["missing_provider_report"],
      summary: `Planner evaluation report for provider ${normalizedProvider} is required but missing.`,
    };
  }

  const providerGate = buildPlannerGate({
    latestPlannerPayload: payload,
  });
  const reportProvider = normalizeProvider(payload.summary?.provider, "unknown");
  const fallbackMetrics = buildPlannerFallbackMetrics({
    payload,
  });
  const divergenceMetrics = comparePayload
    ? buildPlannerDivergenceMetrics({
        comparePayload,
        payload,
      })
    : {
        divergenceCount: 0,
        divergences: [],
      };
  const failedReasons = [];

  if (reportProvider !== normalizedProvider) {
    failedReasons.push("provider_mismatch");
  }

  if (providerGate.status === "fail") {
    failedReasons.push("planner_eval_failed");
  }

  if ((fallbackMetrics.caseCount ?? 0) === 0) {
    failedReasons.push("empty_provider_report");
  }

  if (fallbackMetrics.unexpectedFallbackRate > fallbackLimit) {
    failedReasons.push("unexpected_fallback_rate_exceeded");
  }

  if (requireCompare && !comparePayload) {
    failedReasons.push("missing_compare_provider_report");
  }

  if (divergenceMetrics.divergenceCount > divergenceLimit) {
    failedReasons.push("planner_divergence_exceeded");
  }

  const status = failedReasons.length > 0 ? "fail" : "pass";
  const compareSummary = normalizedCompareProvider
    ? ` Divergence vs ${normalizedCompareProvider}: ${divergenceMetrics.divergenceCount}.`
    : "";

  return {
    ...fallbackMetrics,
    ...divergenceMetrics,
    status,
    provider: normalizedProvider,
    reportProvider,
    compareProvider: normalizedCompareProvider || null,
    currentRunId: providerGate.currentRunId,
    failedReasons,
    providerGate,
    maxDivergenceCount: divergenceLimit,
    maxUnexpectedFallbackRate: fallbackLimit,
    summary:
      status === "fail"
        ? `Planner provider gate (${normalizedProvider}) failed: ${failedReasons.join(
            ", "
          )}. ${providerGate.summary} Unexpected fallback rate: ${fallbackMetrics.unexpectedFallbackRate.toFixed(
            4
          )}. ${compareSummary}`.trim()
        : `Planner provider gate (${normalizedProvider}) passed. ${providerGate.summary} Unexpected fallback rate: ${fallbackMetrics.unexpectedFallbackRate.toFixed(
            4
          )}.${compareSummary}`.trim(),
  };
};

export const readLatestPlannerProviderReport = async ({
  provider = "real",
  resultsDirectory = defaultResultsDirectory,
} = {}) => {
  const fileNames = getPlannerReportFileNames({
    provider,
  });
  const filePath = path.join(resultsDirectory, fileNames.json);

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};
