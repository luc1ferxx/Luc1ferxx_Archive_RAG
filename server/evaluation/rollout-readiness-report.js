import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRequiredPlannerProviderGate,
  readLatestPlannerProviderReport,
} from "./planner-provider-gate.js";
import { buildRecoveryGate } from "./quality-recovery-gate.js";
import { buildTrajectoryGate } from "./quality-trajectory-gate.js";
import {
  getAgentExecutionPlanner,
  getAgentIntentPlanner,
  getAgentPlannerRollout,
} from "../rag/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");

const LATEST_READINESS_JSON = "latest-rollout-readiness.json";
const LATEST_READINESS_MD = "latest-rollout-readiness.md";

const toIsoDate = (date = new Date()) =>
  date instanceof Date ? date.toISOString() : new Date(date).toISOString();

const toRunId = (createdAt) =>
  `rollout-readiness-${createdAt.replace(/[:.]/g, "-")}`;

const isPassingGate = (gate = {}) => gate.status === "pass" && !gate.skipped;

const buildGateCheck = ({ gate = {}, id, label } = {}) => ({
  id,
  label,
  status: isPassingGate(gate) ? "pass" : "fail",
  currentValue: gate.status ?? "missing",
  expectedValue: "pass",
  summary: gate.summary ?? null,
});

const buildMaxMetricCheck = ({
  currentValue,
  id,
  label,
  maximum = 0,
} = {}) => {
  const numericValue = Number(currentValue);
  const hasValue = Number.isFinite(numericValue);

  return {
    id,
    label,
    status: hasValue && numericValue <= maximum ? "pass" : "fail",
    currentValue: hasValue ? numericValue : null,
    expectedValue: maximum,
  };
};

const DEFAULT_REQUIRED_PLANNER_RUNTIME = Object.freeze({
  effectiveExecutionPlanner: "llm",
  effectiveIntentPlanner: "llm",
  plannerRollout: "llm",
});

const normalizeRuntimeValue = (value) =>
  String(value ?? "").trim().toLowerCase();

export const getCurrentPlannerRuntime = () => {
  const plannerRollout = getAgentPlannerRollout();
  const intentPlanner = getAgentIntentPlanner();
  const executionPlanner = getAgentExecutionPlanner();

  return {
    executionPlanner,
    intentPlanner,
    plannerRollout,
    effectiveExecutionPlanner:
      plannerRollout === "llm" || plannerRollout === "deterministic"
        ? plannerRollout
        : executionPlanner,
    effectiveIntentPlanner:
      plannerRollout === "llm" || plannerRollout === "deterministic"
        ? plannerRollout
        : intentPlanner,
  };
};

export const buildPlannerRuntimeGate = ({
  current = getCurrentPlannerRuntime(),
  required = DEFAULT_REQUIRED_PLANNER_RUNTIME,
} = {}) => {
  const normalizedCurrent = {
    executionPlanner: normalizeRuntimeValue(current.executionPlanner),
    intentPlanner: normalizeRuntimeValue(current.intentPlanner),
    plannerRollout: normalizeRuntimeValue(current.plannerRollout),
    effectiveExecutionPlanner: normalizeRuntimeValue(
      current.effectiveExecutionPlanner
    ),
    effectiveIntentPlanner: normalizeRuntimeValue(current.effectiveIntentPlanner),
  };
  const normalizedRequired = {
    effectiveExecutionPlanner: normalizeRuntimeValue(
      required.effectiveExecutionPlanner
    ),
    effectiveIntentPlanner: normalizeRuntimeValue(required.effectiveIntentPlanner),
    plannerRollout: normalizeRuntimeValue(required.plannerRollout),
  };
  const failedReasons = [];

  for (const key of Object.keys(normalizedRequired)) {
    if (
      normalizedRequired[key] &&
      normalizedCurrent[key] !== normalizedRequired[key]
    ) {
      failedReasons.push(`${key}_mismatch`);
    }
  }

  const status = failedReasons.length > 0 ? "fail" : "pass";

  return {
    status,
    current: normalizedCurrent,
    failedReasons,
    required: normalizedRequired,
    skipped: false,
    summary:
      status === "pass"
        ? "Planner runtime target is pure LLM."
        : `Planner runtime target is not pure LLM: ${failedReasons.join(", ")}.`,
  };
};

const buildReadinessChecks = ({
  plannerProviderGate = {},
  plannerRuntimeGate = {},
  recoveryGate = {},
  trajectoryGate = {},
} = {}) => [
  buildGateCheck({
    gate: plannerProviderGate,
    id: "real_planner_gate_passed",
    label: "Real planner provider gate passed",
  }),
  buildGateCheck({
    gate: plannerRuntimeGate,
    id: "planner_runtime_pure_llm",
    label: "Planner runtime target is pure LLM",
  }),
  buildGateCheck({
    gate: trajectoryGate,
    id: "trajectory_gate_passed",
    label: "Trajectory gate passed",
  }),
  buildGateCheck({
    gate: recoveryGate,
    id: "recovery_gate_passed",
    label: "Recovery gate passed",
  }),
  buildMaxMetricCheck({
    currentValue: plannerProviderGate.unexpectedFallbackRate,
    id: "unexpected_fallback_rate_zero",
    label: "Unexpected fallback rate stayed at zero",
    maximum: plannerProviderGate.maxUnexpectedFallbackRate ?? 0,
  }),
  buildMaxMetricCheck({
    currentValue: plannerProviderGate.divergenceCount,
    id: "mock_real_divergence_zero",
    label: "Mock/real planner divergence stayed at zero",
    maximum: plannerProviderGate.maxDivergenceCount ?? 0,
  }),
];

export const buildRolloutReadinessReport = ({
  createdAt = toIsoDate(),
  maxDivergenceCount = 0,
  maxUnexpectedFallbackRate = 0,
  mockPlannerPayload = null,
  plannerRuntime = getCurrentPlannerRuntime(),
  requiredPlannerRuntime = DEFAULT_REQUIRED_PLANNER_RUNTIME,
  realPlannerPayload = null,
  recoveryPayload = null,
  runId = null,
  trajectoryPayload = null,
} = {}) => {
  const plannerProviderGate = buildRequiredPlannerProviderGate({
    comparePayload: mockPlannerPayload,
    compareProvider: "mock",
    maxDivergenceCount,
    maxUnexpectedFallbackRate,
    payload: realPlannerPayload,
    provider: "real",
    requireCompare: true,
  });
  const trajectoryGate = buildTrajectoryGate({
    latestTrajectoryPayload: trajectoryPayload,
  });
  const recoveryGate = buildRecoveryGate({
    latestRecoveryPayload: recoveryPayload,
  });
  const plannerRuntimeGate = buildPlannerRuntimeGate({
    current: plannerRuntime,
    required: requiredPlannerRuntime,
  });
  const checks = buildReadinessChecks({
    plannerProviderGate,
    plannerRuntimeGate,
    recoveryGate,
    trajectoryGate,
  });
  const failedChecks = checks.filter((check) => check.status === "fail");
  const status = failedChecks.length > 0 ? "not_ready" : "ready";

  return {
    summary: {
      runId: runId ?? toRunId(createdAt),
      createdAt,
      status,
      version: "1.0.0",
      checkCount: checks.length,
      failedCheckCount: failedChecks.length,
    },
    checks,
    failedChecks,
    signals: {
      planner: {
        status: plannerProviderGate.status,
        provider: plannerProviderGate.provider,
        reportProvider: plannerProviderGate.reportProvider ?? null,
        currentRunId: plannerProviderGate.currentRunId ?? null,
        fallbackRate: plannerProviderGate.fallbackRate ?? null,
        unexpectedFallbackRate:
          plannerProviderGate.unexpectedFallbackRate ?? null,
        unexpectedFallbackCount:
          plannerProviderGate.unexpectedFallbackCount ?? null,
        divergenceCount: plannerProviderGate.divergenceCount ?? null,
        failedReasons: plannerProviderGate.failedReasons ?? [],
        summary: plannerProviderGate.summary,
      },
      trajectory: {
        status: trajectoryGate.status,
        skipped: Boolean(trajectoryGate.skipped),
        currentRunId: trajectoryGate.currentRunId ?? null,
        caseCount: trajectoryGate.caseCount ?? 0,
        failedCaseCount: trajectoryGate.failedCaseCount ?? 0,
        summary: trajectoryGate.summary,
      },
      recovery: {
        status: recoveryGate.status,
        skipped: Boolean(recoveryGate.skipped),
        currentRunId: recoveryGate.currentRunId ?? null,
        caseCount: recoveryGate.caseCount ?? 0,
        failedCaseCount: recoveryGate.failedCaseCount ?? 0,
        autoReplaySuccessRate:
          recoveryGate.recovery?.autoReplaySuccessRate ?? null,
        manualRecoveryActionFailureCount:
          recoveryGate.recovery?.manualRecoveryActionFailureCount ?? null,
        stepReplayFailureCount:
          recoveryGate.recovery?.stepReplayFailureCount ?? null,
        plannerFallbackCount: recoveryGate.recovery?.plannerFallbackCount ?? null,
        summary: recoveryGate.summary,
      },
      runtime: {
        status: plannerRuntimeGate.status,
        current: plannerRuntimeGate.current,
        failedReasons: plannerRuntimeGate.failedReasons,
        required: plannerRuntimeGate.required,
        summary: plannerRuntimeGate.summary,
      },
    },
    gates: {
      plannerProviderGate,
      plannerRuntimeGate,
      trajectoryGate,
      recoveryGate,
    },
  };
};

const readOptionalJsonFile = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

export const readRolloutReadinessInputs = async ({
  inputDirectory = resultsDirectory,
} = {}) => {
  const resolvedInputDirectory = path.resolve(inputDirectory);
  const [mockPlannerPayload, realPlannerPayload, trajectoryPayload, recoveryPayload] =
    await Promise.all([
      readLatestPlannerProviderReport({
        provider: "mock",
        resultsDirectory: resolvedInputDirectory,
      }),
      readLatestPlannerProviderReport({
        provider: "real",
        resultsDirectory: resolvedInputDirectory,
      }),
      readOptionalJsonFile(
        path.join(resolvedInputDirectory, "latest-trajectory.json")
      ),
      readOptionalJsonFile(
        path.join(resolvedInputDirectory, "latest-recovery-observability.json")
      ),
    ]);

  return {
    inputDirectory: resolvedInputDirectory,
    mockPlannerPayload,
    realPlannerPayload,
    recoveryPayload,
    trajectoryPayload,
  };
};

export const buildRolloutReadinessReportFromResults = async ({
  inputDirectory = resultsDirectory,
  ...options
} = {}) =>
  buildRolloutReadinessReport({
    ...(await readRolloutReadinessInputs({
      inputDirectory,
    })),
    ...options,
  });

const formatPercent = (value) =>
  typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "N/A";

const formatCheck = (check = {}) =>
  `| ${check.label} | ${check.status} | ${check.currentValue ?? "missing"} | ${
    check.expectedValue ?? "n/a"
  } |`;

export const formatRolloutReadinessReportMarkdown = (report = {}) => {
  const summary = report.summary ?? {};
  const planner = report.signals?.planner ?? {};
  const trajectory = report.signals?.trajectory ?? {};
  const recovery = report.signals?.recovery ?? {};
  const runtime = report.signals?.runtime ?? {};
  const lines = [
    "# AgentRAG Rollout Readiness",
    "",
    `- Run ID: \`${summary.runId ?? "unknown"}\``,
    `- Created: \`${summary.createdAt ?? "unknown"}\``,
    `- Status: \`${summary.status ?? "unknown"}\``,
    `- Checks: \`${(summary.checkCount ?? 0) - (summary.failedCheckCount ?? 0)}/${
      summary.checkCount ?? 0
    }\` passed`,
    "",
    "## Signals",
    "",
    `- Real planner gate: \`${planner.status ?? "unknown"}\``,
    `- Real planner fallback rate: \`${formatPercent(planner.fallbackRate)}\``,
    `- Unexpected fallback rate: \`${formatPercent(
      planner.unexpectedFallbackRate
    )}\``,
    `- Mock/real divergence: \`${planner.divergenceCount ?? "N/A"}\``,
    `- Planner runtime target: \`${runtime.status ?? "unknown"}\``,
    `- Planner rollout: \`${runtime.current?.plannerRollout ?? "unknown"}\``,
    `- Trajectory gate: \`${trajectory.status ?? "unknown"}\``,
    `- Recovery gate: \`${recovery.status ?? "unknown"}\``,
    `- Recovery step replay failures: \`${
      recovery.stepReplayFailureCount ?? "N/A"
    }\``,
    "",
    "## Checks",
    "",
    "| Check | Status | Current | Expected |",
    "| --- | --- | ---: | ---: |",
    ...(report.checks ?? []).map(formatCheck),
    "",
    "## Gate Summaries",
    "",
    `- Planner: ${planner.summary ?? "N/A"}`,
    `- Runtime: ${runtime.summary ?? "N/A"}`,
    `- Trajectory: ${trajectory.summary ?? "N/A"}`,
    `- Recovery: ${recovery.summary ?? "N/A"}`,
  ];

  return `${lines.join("\n").trim()}\n`;
};

export const writeRolloutReadinessReport = async ({
  outputDirectory = resultsDirectory,
  report,
} = {}) => {
  await mkdir(outputDirectory, {
    recursive: true,
  });

  const jsonPath = path.join(outputDirectory, LATEST_READINESS_JSON);
  const markdownPath = path.join(outputDirectory, LATEST_READINESS_MD);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, formatRolloutReadinessReportMarkdown(report), "utf8");

  return {
    jsonPath,
    markdownPath,
  };
};
