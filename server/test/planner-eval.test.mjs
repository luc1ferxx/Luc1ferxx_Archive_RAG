import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withEnvironmentOverrides } from "../evaluation/agent-eval-harness.js";
import {
  createDefaultPlannerCases,
  formatPlannerReportMarkdown,
  getPlannerReportFileNames,
  runPlannerEvaluation,
  writePlannerEvaluationReport,
} from "../evaluation/planner-eval.js";

test("planner eval passes default mock LLM planner trajectories", async () => {
  const report = await runPlannerEvaluation({
    createdAt: "2026-06-11T00:00:00.000Z",
    provider: "mock",
    runId: "planner-test",
  });

  assert.equal(report.summary.status, "pass");
  assert.equal(report.summary.provider, "mock");
  assert.equal(report.summary.metrics.caseCount, 6);
  assert.equal(report.summary.metrics.failedCaseCount, 0);
  assert.equal(report.summary.metrics.categories.planner.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.validator.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.fallback.failedCheckCount, 0);

  const inventoryCase = report.cases.find(
    (caseResult) => caseResult.id === "planner_inventory"
  );
  assert.equal(inventoryCase.response.planner.selectedPlannerId, "llm");
  assert.deepEqual(inventoryCase.response.planner.stepIds, ["inventory"]);

  const graphCase = report.cases.find(
    (caseResult) => caseResult.id === "planner_dynamic_skill_graph"
  );
  assert.equal(graphCase?.passed, true);
  assert.deepEqual(graphCase.response.skillGraph.nodeSkills, [
    "compare_documents",
    "risk_review",
  ]);
  assert.equal(graphCase.response.skillGraph.selectedPlannerId, "llm_dag");

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

// The dynamic graph case pinned AGENT_SKILL_GRAPH_ROLLOUT to guarded until
// 2026-11-20, so under a removed value it alone still passed.
test("planner eval's dynamic graph case refuses a removed AGENT_SKILL_GRAPH_ROLLOUT value like every other case", async () => {
  const report = await withEnvironmentOverrides({ AGENT_SKILL_GRAPH_ROLLOUT: "off" }, () =>
    runPlannerEvaluation({
      cases: createDefaultPlannerCases().filter(
        (caseDefinition) => caseDefinition.id === "planner_dynamic_skill_graph"
      ),
      createdAt: "2026-11-20T00:00:00.000Z",
      provider: "mock",
      runId: "planner-removed-dial",
    })
  );
  const [graphCase] = report.cases;

  assert.equal(graphCase.passed, false);
  assert.match(
    graphCase.checks.find((check) => check.id === "case_error")?.detail ?? "",
    /^AGENT_SKILL_GRAPH_ROLLOUT=off was removed \(ADR 0001 phase 8\)/u
  );
});

test("planner eval isolates memory configuration from local runtime", async () => {
  const originalAgentExperienceMemory =
    process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED;
  const originalLongMemory = process.env.RAG_LONG_MEMORY_ENABLED;

  process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED = "true";
  process.env.RAG_LONG_MEMORY_ENABLED = "true";

  try {
    const report = await runPlannerEvaluation({
      createdAt: "2026-06-11T00:00:00.000Z",
      provider: "mock",
      runId: "planner-memory-isolation-test",
    });
    const inventoryCase = report.cases.find(
      (caseResult) => caseResult.id === "planner_inventory"
    );

    assert.equal(report.summary.status, "pass");
    assert.equal(
      inventoryCase.response.intentPlanner.experienceMemory.applied,
      false
    );
    assert.equal(
      inventoryCase.response.intentPlanner.experienceMemory.hintCount,
      0
    );
    assert.equal(process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED, "true");
    assert.equal(process.env.RAG_LONG_MEMORY_ENABLED, "true");
  } finally {
    if (originalAgentExperienceMemory === undefined) {
      delete process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED;
    } else {
      process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED =
        originalAgentExperienceMemory;
    }

    if (originalLongMemory === undefined) {
      delete process.env.RAG_LONG_MEMORY_ENABLED;
    } else {
      process.env.RAG_LONG_MEMORY_ENABLED = originalLongMemory;
    }
  }
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

test("planner eval writes provider-specific latest reports", async () => {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "archive-rag-planner-eval-")
  );

  try {
    const report = await runPlannerEvaluation({
      createdAt: "2026-06-11T00:00:00.000Z",
      provider: "mock",
      runId: "planner-test",
    });
    const paths = await writePlannerEvaluationReport({
      outputDirectory,
      report,
    });
    const providerFileNames = getPlannerReportFileNames({
      provider: "mock",
    });

    assert.equal(
      path.basename(paths.providerJsonPath),
      providerFileNames.json
    );
    assert.equal(path.basename(paths.jsonPath), "latest-planner.json");
    assert.equal(
      JSON.parse(await readFile(paths.providerJsonPath, "utf8")).summary.provider,
      "mock"
    );
    assert.match(
      await readFile(paths.providerMarkdownPath, "utf8"),
      /Provider: `mock`/
    );
  } finally {
    await rm(outputDirectory, {
      force: true,
      recursive: true,
    });
  }
});
