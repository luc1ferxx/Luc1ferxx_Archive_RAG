import { buildMetricSummary } from "../agent-eval-harness.js";
import { createDefaultTrajectoryCases } from "./cases/index.js";
import { CATEGORY_LABELS, runTrajectoryCaseSafely } from "./checks.js";

const TRAJECTORY_REPORT_VERSION = "1.0.0";

export const runTrajectoryEvaluation = async ({
  cases = createDefaultTrajectoryCases(),
  createdAt = new Date().toISOString(),
  runId = `trajectory-${createdAt.replace(/[:.]/g, "-")}`,
} = {}) => {
  const caseResults = [];

  for (const caseDefinition of cases) {
    caseResults.push(await runTrajectoryCaseSafely(caseDefinition));
  }

  const metrics = buildMetricSummary({
    caseResults,
    categoryLabels: CATEGORY_LABELS,
  });
  const status = metrics.failedCaseCount > 0 ? "fail" : "pass";

  return {
    summary: {
      version: TRAJECTORY_REPORT_VERSION,
      runId,
      createdAt,
      status,
      metrics,
    },
    cases: caseResults,
  };
};
