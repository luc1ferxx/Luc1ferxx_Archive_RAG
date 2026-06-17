#!/usr/bin/env node

import "dotenv/config";
import {
  runPlannerEvaluation,
  writePlannerEvaluationReport,
} from "./planner-eval.js";

const parseProviders = (args) => {
  const providerFlagIndex = args.findIndex((arg) => arg === "--provider");

  if (providerFlagIndex !== -1) {
    const provider = args[providerFlagIndex + 1] ?? "mock";
    return provider === "all" ? ["mock", "real"] : [provider];
  }

  if (args.includes("--all")) {
    return ["mock", "real"];
  }

  if (args.includes("--real")) {
    return ["real"];
  }

  if (args.includes("--mock")) {
    return ["mock"];
  }

  return ["mock"];
};

const providers = parseProviders(process.argv.slice(2));
let failed = false;

for (const provider of providers) {
  const report = await runPlannerEvaluation({
    provider,
  });
  const paths = await writePlannerEvaluationReport({
    report,
  });

  console.log(`Planner eval: ${report.summary.status.toUpperCase()}`);
  console.log(`Provider: ${report.summary.provider}`);
  console.log(
    `Cases: ${report.summary.metrics.passedCaseCount}/${report.summary.metrics.caseCount} passed`
  );
  console.log(
    `Checks: ${report.summary.metrics.passedCheckCount}/${report.summary.metrics.checkCount} passed`
  );
  console.log(`JSON: ${paths.jsonPath ?? paths.providerJsonPath}`);
  console.log(`Markdown: ${paths.markdownPath ?? paths.providerMarkdownPath}`);

  if (report.summary.status === "fail") {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
