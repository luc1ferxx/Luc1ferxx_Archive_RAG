import {
  buildMetricSummary,
  withEnvironmentOverrides,
} from "../agent-eval-harness.js";
import { createDefaultTrajectoryCases } from "./cases/index.js";
import { CATEGORY_LABELS, runTrajectoryCaseSafely } from "./checks.js";

const TRAJECTORY_REPORT_VERSION = "1.0.0";

export const runTrajectoryEvaluation = async ({
  cases = createDefaultTrajectoryCases(),
  createdAt = new Date().toISOString(),
  runId = `trajectory-${createdAt.replace(/[:.]/g, "-")}`,
} = {}) => {
  return withEnvironmentOverrides(
    {
      // The unified-graph case pins `guarded` for its own duration; every
      // other case describes the default V1 path and must not inherit a
      // rollout dial from the CI environment.
      AGENT_UNIFIED_GRAPH_ROLLOUT: "off",
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
