#!/usr/bin/env node

import {
  runTrajectoryEvaluation,
  writeTrajectoryEvaluationReport,
} from "./trajectory-eval.js";

const report = await runTrajectoryEvaluation();
const paths = await writeTrajectoryEvaluationReport({
  report,
});

console.log(`Trajectory eval: ${report.summary.status.toUpperCase()}`);
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
