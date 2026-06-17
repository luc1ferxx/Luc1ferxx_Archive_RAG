import { buildMetricSummary } from "../agent-eval-harness.js";
import { llmPlannerAdapter } from "../../rag/agent-llm-planner-adapter.js";
import {
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../../rag/openai.js";
import {
  createDefaultPlannerCases,
  createMockPlannerProvider,
} from "./cases/index.js";
import { CATEGORY_LABELS, runPlannerCaseSafely } from "./checks.js";

const PLANNER_REPORT_VERSION = "1.0.0";

const configurePlannerProvider = ({ provider }) => {
  if (provider === "mock") {
    configureOpenAIProvider(createMockPlannerProvider());
    return;
  }

  resetOpenAIProvider();
};

export const runPlannerEvaluation = async ({
  cases,
  createdAt = new Date().toISOString(),
  plannerAdapter = llmPlannerAdapter,
  provider = "mock",
  runId = `planner-${provider}-${createdAt.replace(/[:.]/g, "-")}`,
} = {}) => {
  if (!["mock", "real"].includes(provider)) {
    throw new Error(`Unsupported planner eval provider: ${provider}`);
  }

  configurePlannerProvider({
    provider,
  });

  try {
    const caseDefinitions =
      cases ??
      createDefaultPlannerCases({
        plannerAdapter,
      });
    const caseResults = [];

    for (const caseDefinition of caseDefinitions) {
      caseResults.push(await runPlannerCaseSafely(caseDefinition));
    }

    const metrics = buildMetricSummary({
      caseResults,
      categoryLabels: CATEGORY_LABELS,
    });
    const status = metrics.failedCaseCount > 0 ? "fail" : "pass";

    return {
      cases: caseResults,
      summary: {
        createdAt,
        metrics,
        provider,
        runId,
        status,
        version: PLANNER_REPORT_VERSION,
      },
    };
  } finally {
    resetOpenAIProvider();
  }
};
