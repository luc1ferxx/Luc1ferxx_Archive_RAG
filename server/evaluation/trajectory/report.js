import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendCaseCheckTable,
  appendCategoryMetricsTable,
} from "../agent-eval-harness.js";
import { CATEGORY_LABELS } from "./checks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "..", "results");

const LATEST_TRAJECTORY_JSON = "latest-trajectory.json";
const LATEST_TRAJECTORY_MD = "latest-trajectory.md";

export const formatTrajectoryReportMarkdown = (report = {}) => {
  const summary = report.summary ?? {};
  const metrics = summary.metrics ?? {};
  const categories = metrics.categories ?? {};
  const lines = [
    "# AgentRAG Trajectory Eval",
    "",
    `- Run ID: \`${summary.runId ?? "unknown"}\``,
    `- Created: \`${summary.createdAt ?? "unknown"}\``,
    `- Status: \`${summary.status ?? "unknown"}\``,
    `- Cases: \`${metrics.passedCaseCount ?? 0}/${metrics.caseCount ?? 0}\` passed`,
    `- Checks: \`${metrics.passedCheckCount ?? 0}/${metrics.checkCount ?? 0}\` passed`,
  ];

  appendCategoryMetricsTable({
    categories,
    lines,
  });

  lines.push("", "## Cases", "");

  for (const caseResult of report.cases ?? []) {
    lines.push(
      `### ${caseResult.passed ? "PASS" : "FAIL"} ${caseResult.label}`,
      "",
      caseResult.description,
      "",
      `- ID: \`${caseResult.id}\``,
      `- Agent mode: \`${caseResult.response?.agentMode ?? "unknown"}\``,
      `- Trace: \`${(caseResult.response?.traceTypes ?? []).join(" -> ")}\``
    );

    appendCaseCheckTable({
      categoryLabels: CATEGORY_LABELS,
      checks: caseResult.checks,
      lines,
    });

    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
};

export const writeTrajectoryEvaluationReport = async ({
  report,
  outputDirectory = resultsDirectory,
} = {}) => {
  await mkdir(outputDirectory, {
    recursive: true,
  });

  const jsonPath = path.join(outputDirectory, LATEST_TRAJECTORY_JSON);
  const markdownPath = path.join(outputDirectory, LATEST_TRAJECTORY_MD);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, formatTrajectoryReportMarkdown(report), "utf8");

  return {
    jsonPath,
    markdownPath,
  };
};
