import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPlannerDivergenceMetrics,
  buildPlannerFallbackMetrics,
  buildRequiredPlannerProviderGate,
  readLatestPlannerProviderReport,
} from "../evaluation/planner-provider-gate.js";

const buildPlannerPayload = ({
  cases = null,
  provider = "real",
  status = "pass",
} = {}) => {
  const caseResults =
    cases ??
    [
      {
        id: "planner_inventory",
        label: "Inventory planner selection",
        passed: true,
        checks: [
          {
            category: "planner",
            id: "llm_planner_selected",
            label: "LLM planner selected inventory",
            passed: true,
          },
        ],
        response: {
          planner: {
            fallback: false,
            selectedPlannerId: "llm",
            status: "selected",
            stepIds: ["inventory"],
          },
        },
      },
      {
        id: "planner_invalid_fallback",
        label: "Invalid planner fallback",
        passed: true,
        checks: [
          {
            category: "fallback",
            id: "fallback_to_deterministic",
            label: "Invalid planner output falls back",
            passed: true,
          },
        ],
        response: {
          planner: {
            fallback: true,
            selectedPlannerId: "deterministic",
            status: "fallback",
            stepIds: ["inventory"],
          },
        },
      },
    ];
  const failedCaseCount = caseResults.filter((caseResult) => !caseResult.passed)
    .length;
  const checkCount = caseResults.reduce(
    (sum, caseResult) => sum + (caseResult.checks ?? []).length,
    0
  );

  return {
    cases: caseResults,
    summary: {
      createdAt: "2026-06-19T00:00:00.000Z",
      provider,
      runId: `planner-${provider}`,
      status,
      version: "1.0.0",
      metrics: {
        caseCount: caseResults.length,
        passedCaseCount: caseResults.length - failedCaseCount,
        failedCaseCount,
        checkCount,
        passedCheckCount: checkCount,
        failedCheckCount: 0,
      },
    },
  };
};

test("planner provider gate requires the selected provider report", () => {
  const gate = buildRequiredPlannerProviderGate({
    payload: null,
    provider: "real",
  });

  assert.equal(gate.status, "fail");
  assert.deepEqual(gate.failedReasons, ["missing_provider_report"]);
  assert.match(gate.summary, /provider real is required but missing/);
});

test("planner provider gate passes expected fallback and matching mock report", () => {
  const realPayload = buildPlannerPayload({
    provider: "real",
  });
  const mockPayload = buildPlannerPayload({
    provider: "mock",
  });
  const gate = buildRequiredPlannerProviderGate({
    comparePayload: mockPayload,
    compareProvider: "mock",
    payload: realPayload,
    provider: "real",
    requireCompare: true,
  });

  assert.equal(gate.status, "pass");
  assert.equal(gate.fallbackCount, 1);
  assert.equal(gate.expectedFallbackCount, 1);
  assert.equal(gate.unexpectedFallbackCount, 0);
  assert.equal(gate.divergenceCount, 0);
});

test("planner provider gate fails unexpected fallback on normal planner cases", () => {
  const realPayload = buildPlannerPayload({
    cases: [
      {
        id: "planner_inventory",
        label: "Inventory planner selection",
        passed: true,
        checks: [],
        response: {
          planner: {
            fallback: true,
            selectedPlannerId: "deterministic",
            status: "fallback",
            stepIds: ["inventory"],
          },
        },
      },
    ],
  });
  const metrics = buildPlannerFallbackMetrics({
    payload: realPayload,
  });
  const gate = buildRequiredPlannerProviderGate({
    payload: realPayload,
    provider: "real",
  });

  assert.equal(metrics.unexpectedFallbackCount, 1);
  assert.equal(metrics.unexpectedFallbackRate, 1);
  assert.equal(gate.status, "fail");
  assert.ok(gate.failedReasons.includes("unexpected_fallback_rate_exceeded"));
});

test("planner provider gate fails mock and real planner divergence", () => {
  const realPayload = buildPlannerPayload({
    cases: [
      {
        id: "planner_inventory",
        label: "Inventory planner selection",
        passed: true,
        checks: [],
        response: {
          planner: {
            fallback: false,
            selectedPlannerId: "llm",
            status: "selected",
            stepIds: ["document_rag"],
          },
        },
      },
    ],
  });
  const mockPayload = buildPlannerPayload({
    cases: [
      {
        id: "planner_inventory",
        label: "Inventory planner selection",
        passed: true,
        checks: [],
        response: {
          planner: {
            fallback: false,
            selectedPlannerId: "llm",
            status: "selected",
            stepIds: ["inventory"],
          },
        },
      },
    ],
    provider: "mock",
  });
  const divergenceMetrics = buildPlannerDivergenceMetrics({
    comparePayload: mockPayload,
    payload: realPayload,
  });
  const gate = buildRequiredPlannerProviderGate({
    comparePayload: mockPayload,
    compareProvider: "mock",
    payload: realPayload,
    provider: "real",
    requireCompare: true,
  });

  assert.equal(divergenceMetrics.divergenceCount, 1);
  assert.equal(gate.status, "fail");
  assert.ok(gate.failedReasons.includes("planner_divergence_exceeded"));
  assert.equal(gate.divergences[0].id, "planner_inventory");
});

test("planner provider report reader uses provider-specific latest reports", async () => {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "archive-rag-planner-provider-gate-")
  );

  try {
    await writeFile(
      path.join(outputDirectory, "latest-planner-real.json"),
      `${JSON.stringify(buildPlannerPayload({ provider: "real" }), null, 2)}\n`,
      "utf8"
    );

    const payload = await readLatestPlannerProviderReport({
      provider: "real",
      resultsDirectory: outputDirectory,
    });
    const missingPayload = await readLatestPlannerProviderReport({
      provider: "mock",
      resultsDirectory: outputDirectory,
    });

    assert.equal(payload.summary.provider, "real");
    assert.equal(missingPayload, null);
  } finally {
    await rm(outputDirectory, {
      force: true,
      recursive: true,
    });
  }
});
