#!/usr/bin/env node

import {
  buildRecoveryObservabilityEvaluationReport,
  buildRecoveryObservabilityProductionEvents,
  writeRecoveryObservabilityEvaluationReport,
} from "./recovery-observability-eval.js";

const events = await buildRecoveryObservabilityProductionEvents();
const report = buildRecoveryObservabilityEvaluationReport({
  events,
});
const paths = await writeRecoveryObservabilityEvaluationReport({
  report,
});

console.log(`Recovery observability eval: ${report.summary.status.toUpperCase()}`);
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
