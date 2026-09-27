import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getUnifiedGraphPlannerPromptDescriptor } from "../rag/agent-unified-dag-planner-adapter.js";
import {
  formatUnifiedGraphPlannerReportMarkdown,
  runUnifiedGraphPlannerEvaluation,
  summarizeUnifiedGraphPlannerRuns,
  writeUnifiedGraphPlannerReport,
} from "../evaluation/trajectory/unified-graph-planner-eval.js";

// The runner behind `npm run eval:unified-graph-planner`: the unified-graph
// trajectory cases with the v3 model planner in place of their injected
// proposals. The mock provider answers the planner prompt with the intended
// graphs, so every plan is the model adapter's own and every check passes;
// the real run (local model) is reported, never asserted here.

test("the unified graph planner eval plans both cases with the model adapter and measures each call", async () => {
  const report = await runUnifiedGraphPlannerEvaluation({ provider: "mock", runs: 1 });
  const { cases, checks, plannerCall, plans } = report.summary;

  assert.equal(report.summary.provider, "mock");
  assert.equal(cases.total, 2);
  assert.equal(cases.passed, 2);
  assert.equal(checks.passed, checks.total);
  // Evidence-gated case: two guarded requests; approval case: three.
  assert.equal(plans.total, 5);
  assert.equal(plans.accepted, 5);
  assert.equal(plans.fallback, 0);
  assert.equal(plans.rejectedToV1, 0);
  assert.equal(plannerCall.latencyMs.count, 5);

  // Lineage: what the measured calls ran under, and the commit and worktree
  // state the report was produced from.
  const prompt = getUnifiedGraphPlannerPromptDescriptor();
  assert.deepEqual(report.summary.lineage.promptTemplates, [
    { fingerprint: prompt.fingerprint, id: prompt.id, version: prompt.version },
  ]);
  assert.equal(report.summary.lineage.modelRoutes.length, 1);
  // The mock stands in as a custom provider; a real run names its model.
  assert.equal(report.summary.lineage.modelRoutes[0].providerId, "custom_provider");
  assert.ok(report.summary.lineage.responseFormatDigests.length >= 1);
  assert.ok(
    report.summary.lineage.responseFormatDigests.every((digest) => /^sha256:[a-f0-9]{16}$/.test(digest))
  );
  assert.match(report.evidence.git.commitSha, /^[a-f0-9]{40}$|^unknown$/);
  assert.notEqual(report.evidence.git.dirty, undefined);
  assert.equal(report.evidence.provider.mode, "mock");
  assert.ok(
    report.evidence.promptTemplates.templates.some(
      (template) => template.id === prompt.id && template.fingerprint === prompt.fingerprint
    )
  );
  const decisions = report.runs[0].cases.flatMap(
    (caseResult) => caseResult.response?.observed?.plannerDecisions ?? []
  );
  assert.ok(decisions.every((decision) => decision.promptTemplate?.fingerprint === prompt.fingerprint));

  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "unified-planner-eval-"));
  try {
    const paths = await writeUnifiedGraphPlannerReport({ outputDirectory, report });
    assert.match(path.basename(paths.jsonPath), /^latest-planner-unified-graph-mock\.json$/);
    const markdown = await readFile(paths.markdownPath, "utf8");
    assert.match(markdown, /5\/5.*accepted/);
    assert.match(markdown, new RegExp(`${prompt.id}@${prompt.version}#${prompt.fingerprint}`));
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});

test("fallbacks and V1 refusals are counted with their reasons", () => {
  const decision = (overrides) => ({
    admitted: true,
    fallback: false,
    fallbackReasonCodes: [],
    latencyMs: 10,
    requestedPlannerId: "llm_unified_graph",
    tokens: 100,
    ...overrides,
  });
  const summary = summarizeUnifiedGraphPlannerRuns({
    runs: [{
      cases: [{
        checks: [{ id: "a", passed: true }, { id: "b", passed: false }],
        passed: false,
        response: {
          observed: {
            plannerDecisions: [
              decision({}),
              decision({ fallback: true, fallbackReasonCodes: ["invalid_condition"], latencyMs: 30 }),
              decision({ admitted: false, fallback: true, fallbackReasonCodes: [] }),
              decision({ requestedPlannerId: "injected" }),
            ],
          },
        },
      }],
    }],
  });

  assert.deepEqual(summary.plans, {
    accepted: 1,
    acceptanceRate: 0.3333,
    fallback: 2,
    fallbackRate: 0.6667,
    fallbackReasons: { invalid_condition: 1, unspecified: 1 },
    rejectedToV1: 1,
    total: 3,
  });
  assert.equal(summary.plannerCall.latencyMs.max, 30);
  assert.deepEqual(summary.checks.byId, { a: { passed: 1, total: 1 }, b: { passed: 0, total: 1 } });
  assert.match(formatUnifiedGraphPlannerReportMarkdown({ summary: { ...summary, provider: "mock", model: { chatModel: "mock" }, runCount: 1 } }), /\| b \| 0\/1 \|/);
});
