import { buildMetricSummary } from "../agent-eval-harness.js";
import { createDefaultTrajectoryCases } from "./cases/index.js";
import { CATEGORY_LABELS, runTrajectoryCaseSafely } from "./checks.js";

const TRAJECTORY_REPORT_VERSION = "1.0.0";

const withEnvironmentOverrides = async (overrides, callback) => {
  const originalValues = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

export const runTrajectoryEvaluation = async ({
  cases = createDefaultTrajectoryCases(),
  createdAt = new Date().toISOString(),
  runId = `trajectory-${createdAt.replace(/[:.]/g, "-")}`,
} = {}) => {
  return withEnvironmentOverrides(
    {
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
      RAG_LONG_MEMORY_ENABLED: "false",
    },
    async () => {
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
    }
  );
};
