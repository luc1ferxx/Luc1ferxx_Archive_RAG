#!/usr/bin/env node

import "dotenv/config";
import {
  runUnifiedGraphPlannerEvaluation,
  writeUnifiedGraphPlannerReport,
} from "./trajectory/unified-graph-planner-eval.js";

// Usage: npm run eval:unified-graph-planner -- [--real] [--runs 3]
const args = process.argv.slice(2);
const runsIndex = args.indexOf("--runs");
const runs = runsIndex === -1 ? 3 : Math.max(1, Number.parseInt(args[runsIndex + 1], 10) || 3);
const provider = args.includes("--real") ? "real" : "mock";
const report = await runUnifiedGraphPlannerEvaluation({ provider, runs });
const paths = await writeUnifiedGraphPlannerReport({ report });
const { cases, checks, plannerCall, plans } = report.summary;

console.log(`Unified graph planner eval (${provider}, ${report.summary.model.chatModel}), ${runs} run(s)`);
console.log(`Plans: ${plans.accepted}/${plans.total} accepted, ${plans.fallback} fallback, ${plans.rejectedToV1} to V1`);
console.log(`Fallback reasons: ${JSON.stringify(plans.fallbackReasons)}`);
console.log(`Cases: ${cases.passed}/${cases.total}; checks: ${checks.passed}/${checks.total}`);
console.log(`Planner latency ms: ${JSON.stringify(plannerCall.latencyMs)}`);
console.log(`Planner tokens: ${JSON.stringify(plannerCall.tokens)}`);
console.log(`Commit: ${report.evidence.git.commitSha} (dirty: ${report.evidence.git.dirty})`);
console.log(`Lineage: ${JSON.stringify(report.summary.lineage)}`);
console.log(`JSON: ${paths.jsonPath}`);
console.log(`Markdown: ${paths.markdownPath}`);
