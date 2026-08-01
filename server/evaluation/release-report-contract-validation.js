import { isDeepStrictEqual } from "node:util";

import {
  buildRolloutReadinessReport,
} from "./rollout-readiness-report.js";
import { robustEvalSuiteReportIds } from "./eval-suite.js";
import {
  validateReportEnvelopeIntegrity,
  validateCurrentQualitySuiteReport,
} from "./quality-current-suite-validator.js";

const RUNTIME_SMOKE_DOCUMENT_ID = "runtime-smoke-contract";

const addMismatch = ({ actual, expected, id, issues }) => {
  if (!isDeepStrictEqual(actual, expected)) {
    issues.push({ id, expected, actual });
  }
};

const validateRuntimeSmokeReport = (report = {}) => {
  const issues = [];
  const checks = report.checks ?? {};

  addMismatch({
    actual: report.status,
    expected: "pass",
    id: "status",
    issues,
  });
  addMismatch({
    actual: report.version,
    expected: "1.0.0",
    id: "version",
    issues,
  });
  addMismatch({
    actual: checks.longMemory,
    expected: {
      healthReason: "postgres_configured_default",
      healthStatus: "ok",
    },
    id: "checks.longMemory",
    issues,
  });
  addMismatch({
    actual: {
      healthReason: checks.agentExperienceMemory?.healthReason,
      healthStatus: checks.agentExperienceMemory?.healthStatus,
      writeStatus: checks.agentExperienceMemory?.writeStatus,
    },
    expected: {
      healthReason: "postgres_configured_default",
      healthStatus: "ok",
      writeStatus: "stored",
    },
    id: "checks.agentExperienceMemory.health",
    issues,
  });
  addMismatch({
    actual: checks.planners,
    expected: {
      executionPlanner: "llm",
      executionPlannerStatus: "selected",
      intentPlanner: "llm",
      intentPlannerStatus: "selected",
    },
    id: "checks.planners",
    issues,
  });
  addMismatch({
    actual: checks.sources?.sourceDocIds,
    expected: [RUNTIME_SMOKE_DOCUMENT_ID],
    id: "checks.sources.sourceDocIds",
    issues,
  });

  for (const [id, value] of [
    [
      "checks.agentExperienceMemory.secondRunHintCount",
      checks.agentExperienceMemory?.secondRunHintCount,
    ],
    ["checks.sources.firstRunSourceCount", checks.sources?.firstRunSourceCount],
    ["checks.sources.secondRunSourceCount", checks.sources?.secondRunSourceCount],
    ["runtime.ragCallCount", report.runtime?.ragCallCount],
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      issues.push({ id, expected: "positive integer", actual: value ?? null });
    }
  }

  for (const [id, value] of [
    ["completedAt", report.completedAt],
    ["runId", report.runId],
    ["runtime.userId", report.runtime?.userId],
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push({ id, expected: "non-empty string", actual: value ?? null });
    }
  }

  return issues;
};

const RELEASE_PLANNER_RUNTIME = Object.freeze({
  executionPlanner: "llm",
  intentPlanner: "llm",
  plannerRollout: "llm",
  effectiveExecutionPlanner: "llm",
  effectiveIntentPlanner: "llm",
});

const validateRolloutReadinessReport = ({ report = {}, reports = {} } = {}) => {
  const expected = buildRolloutReadinessReport({
    createdAt: report.summary?.createdAt,
    runId: report.summary?.runId,
    mockPlannerPayload: reports["planner-mock"] ?? null,
    realPlannerPayload: reports["planner-real"] ?? null,
    trajectoryPayload: reports.trajectory ?? null,
    recoveryPayload: reports["recovery-observability"] ?? null,
    runtimeSmokePayload: reports["runtime-smoke"] ?? null,
    plannerRuntime: RELEASE_PLANNER_RUNTIME,
  });
  const actualProjection = {
    summary: report.summary ?? null,
    checks: report.checks ?? null,
    failedChecks: report.failedChecks ?? null,
    signals: report.signals ?? null,
    gates: report.gates ?? null,
  };
  const expectedProjection = {
    summary: expected.summary,
    checks: expected.checks,
    failedChecks: expected.failedChecks,
    signals: expected.signals,
    gates: expected.gates,
  };

  return isDeepStrictEqual(actualProjection, expectedProjection)
    ? []
    : [
        {
          id: "rollout_readiness_projection",
          expected: expectedProjection,
          actual: actualProjection,
        },
      ];
};

const SUITE_MANIFEST_IDS = Object.freeze({
  trajectory: "trajectory",
  "planner-real": "planner-real",
  "planner-mock": "planner-mock",
  "recovery-observability": "recovery",
});
const ROBUST_REPORT_IDS = new Set(robustEvalSuiteReportIds);

export const validateReleaseReportContract = ({
  reportId,
  report = null,
  reports = {},
} = {}) => {
  if (!report) {
    return {
      status: "fail",
      issues: [{ id: "report", expected: "report payload", actual: null }],
    };
  }

  const manifestId = SUITE_MANIFEST_IDS[reportId];
  let issues = [];

  if (manifestId) {
    const validation = validateCurrentQualitySuiteReport({
      report,
      specId: manifestId,
    });
    issues = [
      ...validation.contractErrors,
      ...validation.integrityErrors,
    ];
  } else if (ROBUST_REPORT_IDS.has(reportId)) {
    issues = validateReportEnvelopeIntegrity(report);
  } else if (reportId === "runtime-smoke") {
    issues = [
      ...validateReportEnvelopeIntegrity(report, {
        contentGeneratedAt: report.completedAt,
        contentRunId: report.runId,
      }),
      ...validateRuntimeSmokeReport(report),
    ];
  } else if (reportId === "rollout-readiness") {
    issues = [
      ...validateReportEnvelopeIntegrity(report),
      ...validateRolloutReadinessReport({ report, reports }),
    ];
  }

  return {
    status: issues.length === 0 ? "pass" : "fail",
    issues,
  };
};
