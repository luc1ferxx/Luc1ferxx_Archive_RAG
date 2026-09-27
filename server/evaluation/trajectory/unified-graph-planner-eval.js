import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  UNIFIED_GRAPH_PLANNER_IDS,
  unifiedGraphLlmPlannerAdapter,
} from "../../rag/agent-unified-dag-planner-adapter.js";
import { MODEL_ROUTE_IDS } from "../../rag/model-providers/index.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../../rag/openai.js";
import { withEnvironmentOverrides } from "../agent-eval-harness.js";
import { attachEvaluationEvidence } from "../eval-evidence.js";
import { createMockPlannerProvider } from "../planner/cases/index.js";
import { createUnifiedGraphApprovalGatedActionCase } from "./cases/unified-graph-approval.js";
import { createUnifiedGraphEvidenceGatedSkillCase } from "./cases/unified-graph.js";
import { runTrajectoryCaseSafely } from "./checks.js";

// The unified-graph trajectory cases with the v3 model planner in place of
// their injected proposals, repeated `runs` times, and what planning cost.
//
// Only the planner calls a model: document RAG, Skills, Web, and the task
// Capability are the cases' own mocks, so a failed check here is a planning
// outcome, never an answer-quality one. Each planning decision is read from
// the run's `unified_graph_planned` event:
//   * accepted: the model's own proposal passed validation and admission;
//   * fallback: it did not (or did not parse, or the call failed) and was
//     replaced whole by the deterministic graph, with the reason codes;
//   * rejected: nothing admissible, V1 answered.
// Latency and tokens are per planner call (tokens as the provider reported
// them to the run's usage meter).
//
// Lineage: `summary.lineage` lists the distinct prompt templates (id, version,
// fingerprint), model routes, and response-format schema digests the measured
// planner calls actually ran under, and `evidence` records the commit, whether
// the worktree was dirty, and every registered prompt template at report
// time (eval-evidence.js). Quote numbers only from a report whose lineage
// matches the code being described.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "..", "results");
const REPORT_VERSION = "1.1.0";

const ratio = (numerator, denominator) =>
  denominator === 0 ? null : Number((numerator / denominator).toFixed(4));

const describeNumbers = (values) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);

  if (sorted.length === 0) {
    return { count: 0, max: null, mean: null, min: null, p50: null };
  }

  return {
    count: sorted.length,
    max: sorted.at(-1),
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(1)),
    min: sorted[0],
    p50: sorted[Math.floor((sorted.length - 1) / 2)],
  };
};

const distinctBy = (values, keyOf) => {
  const seen = new Map();

  for (const value of values) {
    if (value !== null && value !== undefined && !seen.has(keyOf(value))) {
      seen.set(keyOf(value), value);
    }
  }

  return [...seen.values()];
};

const describeDecisionLineage = (decisions) => ({
  modelRoutes: distinctBy(
    decisions.map((decision) => decision.modelRoute ?? null),
    (route) => `${route.providerId}/${route.modelId}@${route.routeId}:${route.status}`
  ),
  promptTemplates: distinctBy(
    decisions.map((decision) => decision.promptTemplate ?? null),
    (template) => `${template.id}@${template.version}:${template.fingerprint}`
  ),
  responseFormatDigests: distinctBy(
    decisions.map((decision) => decision.responseFormatDigest ?? null),
    (digest) => digest
  ),
});

export const summarizeUnifiedGraphPlannerRuns = ({ runs = [] } = {}) => {
  const cases = runs.flatMap((run) => run.cases);
  const checks = cases.flatMap((caseResult) => caseResult.checks);
  const decisions = cases
    .flatMap((caseResult) => caseResult.response?.observed?.plannerDecisions ?? [])
    .filter((decision) => decision.requestedPlannerId === UNIFIED_GRAPH_PLANNER_IDS.llm);
  const accepted = decisions.filter((decision) => decision.admitted && !decision.fallback);
  const fallbacks = decisions.filter((decision) => decision.fallback);
  const rejected = decisions.filter((decision) => !decision.admitted);
  const fallbackReasons = {};

  for (const decision of fallbacks) {
    for (const code of decision.fallbackReasonCodes.length > 0
      ? decision.fallbackReasonCodes
      : ["unspecified"]) {
      fallbackReasons[code] = (fallbackReasons[code] ?? 0) + 1;
    }
  }

  const checkRates = {};

  for (const check of checks) {
    const entry = (checkRates[check.id] ??= { passed: 0, total: 0 });
    entry.total += 1;
    entry.passed += check.passed ? 1 : 0;
  }

  return {
    lineage: describeDecisionLineage(decisions),
    cases: {
      passed: cases.filter((caseResult) => caseResult.passed).length,
      passRate: ratio(cases.filter((caseResult) => caseResult.passed).length, cases.length),
      total: cases.length,
    },
    checks: {
      byId: checkRates,
      passed: checks.filter((check) => check.passed).length,
      passRate: ratio(checks.filter((check) => check.passed).length, checks.length),
      total: checks.length,
    },
    plans: {
      accepted: accepted.length,
      acceptanceRate: ratio(accepted.length, decisions.length),
      fallback: fallbacks.length,
      fallbackRate: ratio(fallbacks.length, decisions.length),
      fallbackReasons,
      rejectedToV1: rejected.length,
      total: decisions.length,
    },
    plannerCall: {
      latencyMs: describeNumbers(decisions.map((decision) => decision.latencyMs)),
      tokens: describeNumbers(decisions.map((decision) => decision.tokens)),
    },
  };
};

export const runUnifiedGraphPlannerEvaluation = async ({
  createdAt = new Date().toISOString(),
  provider = "mock",
  runs = 3,
} = {}) => {
  if (!["mock", "real"].includes(provider)) {
    throw new Error(`Unsupported unified graph planner provider: ${provider}`);
  }

  if (provider === "mock") {
    configureOpenAIProvider(createMockPlannerProvider());
  } else {
    resetOpenAIProvider();
  }

  const planner = {
    adapter: unifiedGraphLlmPlannerAdapter,
    evidenceKind: provider === "real" ? "real_model_planner" : "mock_model_planner",
  };

  try {
    const results = await withEnvironmentOverrides(
      {
        AGENT_UNIFIED_GRAPH_ROLLOUT: "off",
        RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
        RAG_LONG_MEMORY_ENABLED: "false",
      },
      async () => {
        const collected = [];

        for (let index = 0; index < runs; index += 1) {
          const cases = [];

          for (const definition of [
            createUnifiedGraphEvidenceGatedSkillCase({ planner }),
            createUnifiedGraphApprovalGatedActionCase({ planner }),
          ]) {
            cases.push(await runTrajectoryCaseSafely(definition));
          }

          collected.push({ cases, run: index + 1 });
        }

        return collected;
      }
    );

    const report = {
      runs: results,
      summary: {
        createdAt,
        model: provider === "real"
          ? {
              baseUrlHost: (() => {
                try {
                  return new URL(process.env.OPENAI_BASE_URL ?? "").host || null;
                } catch {
                  return null;
                }
              })(),
              chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
            }
          : { chatModel: "mock" },
        provider,
        runCount: runs,
        version: REPORT_VERSION,
        ...summarizeUnifiedGraphPlannerRuns({ runs: results }),
      },
    };

    return attachEvaluationEvidence(report, {
      command: `npm run eval:unified-graph-planner${provider === "real" ? " -- --real" : ""}`,
      modelRouteId: MODEL_ROUTE_IDS.executionPlannerDefault,
      provider: { id: "unified-graph-planner", mode: provider },
      publicConfig: {
        caseIds: [
          ...new Set(results.flatMap((run) => run.cases.map((caseResult) => caseResult.id))),
        ],
        provider,
        runCount: runs,
        version: REPORT_VERSION,
      },
      reportId: `planner-unified-graph-${provider}`,
      reportType: "planner_unified_graph",
      runId: `planner-unified-graph-${provider}-${createdAt}`,
    });
  } finally {
    resetOpenAIProvider();
  }
};

export const formatUnifiedGraphPlannerReportMarkdown = (report = {}) => {
  const summary = report.summary ?? {};
  const lines = [
    "# Unified Graph Planner Eval",
    "",
    `- Provider: \`${summary.provider}\` (${summary.model?.chatModel ?? "unknown"})`,
    `- Runs: \`${summary.runCount}\``,
    `- Commit: \`${report.evidence?.git?.commitSha ?? "unknown"}\` (dirty worktree: \`${report.evidence?.git?.dirty ?? "unknown"}\`)`,
    `- Planner prompt: \`${(summary.lineage?.promptTemplates ?? []).map((template) => `${template.id}@${template.version}#${template.fingerprint}`).join(", ") || "none"}\``,
    `- Model routes: \`${(summary.lineage?.modelRoutes ?? []).map((route) => `${route.providerId}/${route.modelId}`).join(", ") || "none"}\`; response-format digests: \`${(summary.lineage?.responseFormatDigests ?? []).join(", ") || "none"}\``,
    `- Plans: \`${summary.plans?.accepted}/${summary.plans?.total}\` accepted, \`${summary.plans?.fallback}\` replaced by the deterministic graph, \`${summary.plans?.rejectedToV1}\` answered by V1`,
    `- Fallback reasons: \`${JSON.stringify(summary.plans?.fallbackReasons ?? {})}\``,
    `- Cases: \`${summary.cases?.passed}/${summary.cases?.total}\` passed; checks \`${summary.checks?.passed}/${summary.checks?.total}\``,
    `- Planner latency ms (mean/p50/max): \`${summary.plannerCall?.latencyMs?.mean}/${summary.plannerCall?.latencyMs?.p50}/${summary.plannerCall?.latencyMs?.max}\``,
    `- Planner tokens (mean/max): \`${summary.plannerCall?.tokens?.mean}/${summary.plannerCall?.tokens?.max}\``,
    "",
    "| Check | Passed |",
    "| --- | --- |",
    ...Object.entries(summary.checks?.byId ?? {}).map(
      ([id, rate]) => `| ${id} | ${rate.passed}/${rate.total} |`
    ),
    "",
  ];

  return `${lines.join("\n")}\n`;
};

export const writeUnifiedGraphPlannerReport = async ({
  outputDirectory = resultsDirectory,
  report,
} = {}) => {
  await mkdir(outputDirectory, { recursive: true });
  const base = `latest-planner-unified-graph-${report.summary.provider}`;
  const jsonPath = path.join(outputDirectory, `${base}.json`);
  const markdownPath = path.join(outputDirectory, `${base}.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, formatUnifiedGraphPlannerReportMarkdown(report), "utf8");

  return { jsonPath, markdownPath };
};
