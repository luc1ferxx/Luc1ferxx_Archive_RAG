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
  getAgentSkillGraphRollout,
} from "../rag/config.js";
import {
  attachEvaluationEvidence,
  buildSourceReportReference,
} from "./eval-evidence.js";

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

const DYNAMIC_DAG_CASE_ID = "planner_dynamic_skill_graph";
const REQUIRED_DAG_CHECK_IDS = Object.freeze([
  "compare_only_intent_selected",
  "real_dag_planner_selected",
  "dag_composed_compare_then_risk",
  "dag_selected_skills_observed",
  "dag_kept_document_scope",
]);

export const buildSkillGraphRuntimeGate = ({ mode = getAgentSkillGraphRollout() } = {}) => {
  const currentMode = String(mode ?? "").trim().toLowerCase();
  const status = currentMode === "guarded" ? "pass" : "fail";

  return {
    status,
    currentMode,
    requiredMode: "guarded",
    skipped: false,
    summary: status === "pass"
      ? "The custom Skill DAG is active in guarded mode."
      : `The custom Skill DAG is not active in guarded mode: ${currentMode || "missing"}.`,
  };
};

export const buildRealDagPlannerGate = ({ payload = null } = {}) => {
  const caseResult = (payload?.cases ?? []).find(
    (entry) => entry.id === DYNAMIC_DAG_CASE_ID
  );
  const checks = new Map((caseResult?.checks ?? []).map((check) => [check.id, check]));
  const graph = caseResult?.response?.skillGraph ?? {};
  const observed =
    payload?.summary?.provider === "real" &&
    caseResult?.passed === true &&
    REQUIRED_DAG_CHECK_IDS.every((id) => checks.get(id)?.passed === true) &&
    graph.mode === "guarded" &&
    graph.executed === true &&
    graph.fallback === null &&
    graph.status === "completed" &&
    graph.nodeStatuses?.join(">") === "completed>completed" &&
    graph.plannerFallback === false &&
    graph.selectedPlannerId === "llm_dag" &&
    graph.nodeSkills?.join(">") === "compare_documents>risk_review" &&
    graph.riskDependsOnCompare === true;

  return {
    status: observed ? "pass" : "fail",
    caseId: DYNAMIC_DAG_CASE_ID,
    currentRunId: payload?.summary?.runId ?? null,
    failedReasons: observed ? [] : [caseResult ? "real_dag_case_failed" : "real_dag_case_missing"],
    skipped: false,
    summary: observed
      ? "A real LLM planned and executed the guarded comparison-to-risk DAG."
      : "The real LLM guarded DAG case is missing or failed.",
  };
};

const buildGateCheck = ({ gate = {}, id, label } = {}) => ({
  id,
  label,
  status: isPassingGate(gate) ? "pass" : "fail",
  currentValue: gate.status ?? "missing",
  expectedValue: "pass",
  summary: gate.summary ?? null,
});

const buildRuntimeSmokeGate = ({ payload = null } = {}) => {
  if (!payload) {
    return {
      status: "fail",
      failedReasons: ["runtime_smoke_missing"],
      skipped: false,
      summary: "Runtime smoke report is missing.",
    };
  }

  const checks = payload.checks ?? {};
  const planners = checks.planners ?? {};
  const failedReasons = [];

  if (payload.status !== "pass") {
    failedReasons.push("runtime_smoke_failed");
  }
  if (planners.intentPlanner !== "llm") {
    failedReasons.push("intentPlanner_mismatch");
  }
  if (planners.intentPlannerStatus !== "selected") {
    failedReasons.push("intentPlannerStatus_mismatch");
  }
  if (planners.executionPlanner !== "llm") {
    failedReasons.push("executionPlanner_mismatch");
  }
  if (planners.executionPlannerStatus !== "selected") {
    failedReasons.push("executionPlannerStatus_mismatch");
  }
  if ((checks.agentExperienceMemory?.secondRunHintCount ?? 0) < 1) {
    failedReasons.push("experienceMemory_hint_missing");
  }
  if ((checks.sources?.sourceDocIds ?? []).length < 1) {
    failedReasons.push("document_sources_missing");
  }
  if (checks.skillGraph?.mode !== "guarded") {
    failedReasons.push("skill_graph_mode_mismatch");
  }
  if (checks.skillGraph?.bothRunsExecuted !== true) {
    failedReasons.push("skill_graph_execution_missing");
  }
  if (checks.skillGraph?.bothRunsPlannedByLlm !== true) {
    failedReasons.push("skill_graph_llm_planner_missing");
  }
  if (checks.skillGraph?.fallbackCount !== 0) {
    failedReasons.push("skill_graph_fallback_detected");
  }
  if (
    checks.skillGraph?.skillIds?.join(">") !==
    "risk_review>summarize_contract"
  ) {
    failedReasons.push("skill_graph_skills_mismatch");
  }

  const status = failedReasons.length > 0 ? "fail" : "pass";

  return {
    status,
    completedAt: payload.completedAt ?? null,
    currentRunId: payload.runId ?? payload.runtime?.userId ?? null,
    failedReasons,
    plannerChecks: planners,
    skipped: false,
    summary:
      status === "pass"
        ? "Runtime smoke passed on pure LLM planner path."
        : `Runtime smoke is not ready: ${failedReasons.join(", ")}.`,
  };
};

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
  realDagPlannerGate = {},
  recoveryGate = {},
  runtimeSmokeGate = {},
  skillGraphRuntimeGate = {},
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
    gate: skillGraphRuntimeGate,
    id: "skill_graph_runtime_guarded",
    label: "The custom Skill DAG is active in guarded mode",
  }),
  buildGateCheck({
    gate: realDagPlannerGate,
    id: "real_dag_planner_case_passed",
    label: "Real LLM DAG planner case passed",
  }),
  buildGateCheck({
    gate: runtimeSmokeGate,
    id: "runtime_smoke_passed",
    label: "Pure LLM runtime smoke passed",
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
  runtimeSmokePayload = null,
  skillGraphRollout = getAgentSkillGraphRollout(),
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
  const skillGraphRuntimeGate = buildSkillGraphRuntimeGate({
    mode: skillGraphRollout,
  });
  const realDagPlannerGate = buildRealDagPlannerGate({
    payload: realPlannerPayload,
  });
  const runtimeSmokeGate = buildRuntimeSmokeGate({
    payload: runtimeSmokePayload,
  });
  const checks = buildReadinessChecks({
    plannerProviderGate,
    plannerRuntimeGate,
    realDagPlannerGate,
    recoveryGate,
    runtimeSmokeGate,
    skillGraphRuntimeGate,
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
      skillGraph: {
        runtimeMode: skillGraphRuntimeGate.currentMode,
        runtimeStatus: skillGraphRuntimeGate.status,
        realPlannerCaseStatus: realDagPlannerGate.status,
        realPlannerCaseRunId: realDagPlannerGate.currentRunId,
        failedReasons: realDagPlannerGate.failedReasons,
      },
      runtimeSmoke: {
        status: runtimeSmokeGate.status,
        completedAt: runtimeSmokeGate.completedAt ?? null,
        currentRunId: runtimeSmokeGate.currentRunId ?? null,
        failedReasons: runtimeSmokeGate.failedReasons ?? [],
        plannerChecks: runtimeSmokeGate.plannerChecks ?? {},
        summary: runtimeSmokeGate.summary,
      },
    },
    gates: {
      plannerProviderGate,
      plannerRuntimeGate,
      skillGraphRuntimeGate,
      realDagPlannerGate,
      trajectoryGate,
      recoveryGate,
      runtimeSmokeGate,
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
  const [
    mockPlannerPayload,
    realPlannerPayload,
    trajectoryPayload,
    recoveryPayload,
    runtimeSmokePayload,
  ] = await Promise.all([
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
    readOptionalJsonFile(
      path.join(resolvedInputDirectory, "latest-runtime-smoke.json")
    ),
  ]);

  return {
    inputDirectory: resolvedInputDirectory,
    mockPlannerPayload,
    realPlannerPayload,
    recoveryPayload,
    runtimeSmokePayload,
    trajectoryPayload,
  };
};

export const buildRolloutReadinessReportFromResults = async ({
  inputDirectory = resultsDirectory,
  ...options
} = {}) => {
  const inputs = await readRolloutReadinessInputs({
    inputDirectory,
  });
  const report = buildRolloutReadinessReport({
    ...inputs,
    ...options,
  });
  const sourceReports = [
    inputs.mockPlannerPayload,
    inputs.realPlannerPayload,
    inputs.trajectoryPayload,
    inputs.recoveryPayload,
    inputs.runtimeSmokePayload,
  ].map(buildSourceReportReference);

  return attachEvaluationEvidence(report, {
    command: "npm run rollout:readiness",
    generatedAt: report.summary.createdAt,
    profile: process.env.EVAL_EVIDENCE_PROFILE ?? "release",
    provider: {
      id: "release-readiness",
      mode: "aggregate",
    },
    reportId: "rollout-readiness",
    reportType: "rollout_readiness",
    runId: report.summary.runId,
    sourceReports,
  });
};

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
  const runtimeSmoke = report.signals?.runtimeSmoke ?? {};
  const skillGraph = report.signals?.skillGraph ?? {};
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
    `- Guarded Skill graph runtime: \`${skillGraph.runtimeStatus ?? "unknown"}\` (${skillGraph.runtimeMode ?? "unknown"})`,
    `- Real DAG planner case: \`${skillGraph.realPlannerCaseStatus ?? "unknown"}\``,
    `- Runtime smoke: \`${runtimeSmoke.status ?? "unknown"}\``,
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
    `- Runtime smoke: ${runtimeSmoke.summary ?? "N/A"}`,
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

export const getRolloutReadinessExitCode = (report = {}) =>
  report.summary?.status === "ready" ? 0 : 1;
