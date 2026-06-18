import { defaultHistoryLimit, toTimestamp } from "./quality-shared.js";
import {
  buildQualityRunSummary,
  isSyntheticRegressionResultPayload,
} from "./quality-run-summary.js";
import {
  buildRegressionGate,
  selectRegressionBaseline,
} from "./quality-regression-gate.js";
import {
  buildFeedbackGate,
  buildFeedbackGateChecks,
} from "./quality-feedback-gate.js";
import {
  buildTrajectoryGate,
  buildTrajectoryGateChecks,
} from "./quality-trajectory-gate.js";
import {
  buildPlannerGate,
  buildPlannerGateChecks,
} from "./quality-planner-gate.js";
import {
  buildRecoveryGate,
  buildRecoveryGateChecks,
} from "./quality-recovery-gate.js";

const buildCombinedGateSummary = ({
  regressionGate = {},
  feedbackGate = {},
  plannerGate = {},
  recoveryGate = {},
  trajectoryGate = {},
} = {}) =>
  [
    regressionGate.summary,
    feedbackGate.skipped ? null : feedbackGate.summary,
    trajectoryGate.skipped ? null : trajectoryGate.summary,
    plannerGate.skipped ? null : plannerGate.summary,
    recoveryGate.skipped ? null : recoveryGate.summary,
  ]
    .filter(Boolean)
    .join(" ");

export const buildCombinedQualityGate = ({
  regressionGate = {},
  feedbackGate = {},
  plannerGate = {},
  recoveryGate = {},
  trajectoryGate = {},
} = {}) => {
  const combinedChecks = [
    ...(regressionGate.checks ?? []),
    ...buildFeedbackGateChecks({
      feedbackGate,
    }),
    ...buildTrajectoryGateChecks({
      trajectoryGate,
    }),
    ...buildPlannerGateChecks({
      plannerGate,
    }),
    ...buildRecoveryGateChecks({
      recoveryGate,
    }),
  ];

  if (feedbackGate.status === "fail") {
    return {
      status: "fail",
      summary: feedbackGate.summary,
      checks: combinedChecks,
    };
  }

  if (trajectoryGate.status === "fail") {
    return {
      status: "fail",
      summary: trajectoryGate.summary,
      checks: combinedChecks,
    };
  }

  if (plannerGate.status === "fail") {
    return {
      status: "fail",
      summary: plannerGate.summary,
      checks: combinedChecks,
    };
  }

  if (recoveryGate.status === "fail") {
    return {
      status: "fail",
      summary: recoveryGate.summary,
      checks: combinedChecks,
    };
  }

  if (regressionGate.status === "fail" || regressionGate.status === "warn") {
    return {
      status: regressionGate.status,
      summary: buildCombinedGateSummary({
        regressionGate,
        feedbackGate,
        plannerGate,
        recoveryGate,
        trajectoryGate,
      }),
      checks: combinedChecks,
    };
  }

  if (regressionGate.status === "unknown") {
    return {
      status: "unknown",
      summary: buildCombinedGateSummary({
        regressionGate,
        feedbackGate,
        plannerGate,
        recoveryGate,
        trajectoryGate,
      }),
      checks: combinedChecks,
    };
  }

  return {
    status: "pass",
    summary: buildCombinedGateSummary({
      regressionGate,
      feedbackGate,
      plannerGate,
      recoveryGate,
      trajectoryGate,
    }),
    checks: combinedChecks,
  };
};

export const buildQualityHistoryResponse = ({
  latestPayload = null,
  latestFeedbackPayload = null,
  latestPlannerPayload = null,
  latestPlannerPayloads = null,
  latestRecoveryPayload = null,
  latestTrajectoryPayload = null,
  limit = defaultHistoryLimit,
  runPayloads = [],
} = {}) => {
  const runSummaries = runPayloads
    .filter((entry) => isSyntheticRegressionResultPayload(entry.payload))
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
  const baseline = selectRegressionBaseline({
    currentRun,
    sortedRuns,
  });
  const regressionGate = buildRegressionGate({
    baselineRun: baseline.run,
    baselineSelection: baseline.selection,
    currentRun,
  });
  const feedbackGate = buildFeedbackGate({
    latestFeedbackPayload,
  });
  const trajectoryGate = buildTrajectoryGate({
    latestTrajectoryPayload,
  });
  const plannerGate = buildPlannerGate({
    latestPlannerPayload,
    latestPlannerPayloads,
  });
  const recoveryGate = buildRecoveryGate({
    latestRecoveryPayload,
  });
  const qualityGate = buildCombinedQualityGate({
    regressionGate,
    feedbackGate,
    plannerGate,
    recoveryGate,
    trajectoryGate,
  });

  return {
    status: qualityGate.status,
    latestRun: currentRun,
    runs: sortedRuns.slice(0, limit),
    regressionGate,
    feedbackGate,
    trajectoryGate,
    plannerGate,
    recoveryGate,
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
