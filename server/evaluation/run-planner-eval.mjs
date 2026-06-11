#!/usr/bin/env node

import "dotenv/config";
import {
  runPlannerEvaluation,
  writePlannerEvaluationReport,
} from "./planner-eval.js";

const parseProvider = (args) => {
  const providerFlagIndex = args.findIndex((arg) => arg === "--provider");

  if (providerFlagIndex !== -1) {
    return args[providerFlagIndex + 1] ?? "mock";
  }

  if (args.includes("--real")) {
    return "real";
  }

  if (args.includes("--mock")) {
    return "mock";
  }

  return "mock";
};

const provider = parseProvider(process.argv.slice(2));
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
console.log(`JSON: ${paths.jsonPath}`);
console.log(`Markdown: ${paths.markdownPath}`);

if (report.summary.status === "fail") {
  process.exitCode = 1;
}
