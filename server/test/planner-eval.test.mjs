import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPlannerReportMarkdown,
  runPlannerEvaluation,
} from "../evaluation/planner-eval.js";

test("planner eval passes default mock LLM planner trajectories", async () => {
  const report = await runPlannerEvaluation({
    createdAt: "2026-06-11T00:00:00.000Z",
    provider: "mock",
    runId: "planner-test",
  });

  assert.equal(report.summary.status, "pass");
  assert.equal(report.summary.provider, "mock");
  assert.equal(report.summary.metrics.caseCount, 5);
  assert.equal(report.summary.metrics.failedCaseCount, 0);
  assert.equal(report.summary.metrics.categories.planner.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.validator.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.fallback.failedCheckCount, 0);

  const inventoryCase = report.cases.find(
    (caseResult) => caseResult.id === "planner_inventory"
  );
  assert.equal(inventoryCase.response.planner.selectedPlannerId, "llm");
  assert.deepEqual(inventoryCase.response.planner.stepIds, ["inventory"]);

  const fallbackCase = report.cases.find(
    (caseResult) => caseResult.id === "planner_invalid_fallback"
  );
  assert.equal(fallbackCase.response.planner.selectedPlannerId, "deterministic");
  assert.equal(fallbackCase.response.planner.status, "fallback");
  assert.match(
    fallbackCase.response.planner.fallbackReason,
    /unknown execution step shell_tool/
  );
});

test("planner eval markdown summarizes planner and fallback cases", async () => {
  const report = await runPlannerEvaluation({
    createdAt: "2026-06-11T00:00:00.000Z",
    provider: "mock",
    runId: "planner-test",
  });
  const markdown = formatPlannerReportMarkdown(report);

  assert.match(markdown, /AgentRAG Planner Eval/);
  assert.match(markdown, /Provider: `mock`/);
  assert.match(markdown, /Inventory planner selection/);
  assert.match(markdown, /Invalid planner fallback/);
  assert.match(markdown, /PASS/);
});
