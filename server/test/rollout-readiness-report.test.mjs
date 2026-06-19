import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPlannerRuntimeGate,
  buildRolloutReadinessReport,
  buildRolloutReadinessReportFromResults,
  formatRolloutReadinessReportMarkdown,
  writeRolloutReadinessReport,
} from "../evaluation/rollout-readiness-report.js";
import {
  buildRecoveryObservabilityEvaluationReport,
  buildRecoveryObservabilityFixtureEvents,
} from "../evaluation/recovery-observability-eval.js";

const buildPlannerPayload = ({ cases = null, provider = "real" } = {}) => {
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
            id: "llm_selected_inventory",
            label: "LLM selected inventory",
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
            label: "Fallback to deterministic",
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
      status: failedCaseCount > 0 ? "fail" : "pass",
      metrics: {
        caseCount: caseResults.length,
        checkCount,
        failedCaseCount,
        failedCheckCount: 0,
        passedCaseCount: caseResults.length - failedCaseCount,
        passedCheckCount: checkCount,
      },
    },
  };
};

const buildTrajectoryPayload = ({ failed = false } = {}) => ({
  cases: [
    {
      id: "capability_approval_resume",
      label: "Capability approval resume",
      passed: !failed,
      failedCheckCount: failed ? 1 : 0,
      checks: [
        {
          category: "approval",
          id: "approval_resumed",
          label: "Approval resumed the same run",
          passed: !failed,
        },
      ],
    },
  ],
  summary: {
    createdAt: "2026-06-19T00:05:00.000Z",
    runId: "trajectory-latest",
    status: failed ? "fail" : "pass",
    metrics: {
      caseCount: 1,
      failedCaseCount: failed ? 1 : 0,
      passedCaseCount: failed ? 0 : 1,
    },
  },
});

const pureLlmPlannerRuntime = {
  executionPlanner: "deterministic",
  intentPlanner: "deterministic",
  plannerRollout: "llm",
  effectiveExecutionPlanner: "llm",
  effectiveIntentPlanner: "llm",
};

test("rollout readiness report marks all required signals ready", () => {
  const report = buildRolloutReadinessReport({
    createdAt: "2026-06-19T00:10:00.000Z",
    mockPlannerPayload: buildPlannerPayload({
      provider: "mock",
    }),
    realPlannerPayload: buildPlannerPayload({
      provider: "real",
    }),
    recoveryPayload: buildRecoveryObservabilityEvaluationReport({
      createdAt: "2026-06-19T00:08:00.000Z",
    }),
    plannerRuntime: pureLlmPlannerRuntime,
    runId: "readiness-ready",
    trajectoryPayload: buildTrajectoryPayload(),
  });

  assert.equal(report.summary.status, "ready");
  assert.equal(report.summary.failedCheckCount, 0);
  assert.equal(report.signals.planner.fallbackRate, 0.5);
  assert.equal(report.signals.planner.unexpectedFallbackRate, 0);
  assert.equal(report.signals.planner.divergenceCount, 0);
  assert.equal(report.signals.trajectory.status, "pass");
  assert.equal(report.signals.recovery.status, "pass");
  assert.deepEqual(
    report.checks.map((check) => check.status),
    ["pass", "pass", "pass", "pass", "pass", "pass"]
  );

  const markdown = formatRolloutReadinessReportMarkdown(report);

  assert.match(markdown, /AgentRAG Rollout Readiness/);
  assert.match(markdown, /Status: `ready`/);
  assert.match(markdown, /Mock\/real divergence: `0`/);
  assert.match(markdown, /Planner runtime target: `pass`/);
});

test("rollout readiness report blocks on planner, trajectory, and recovery signals", () => {
  const realPlannerPayload = buildPlannerPayload({
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
            stepIds: ["document_rag"],
          },
        },
      },
    ],
    provider: "real",
  });
  const mockPlannerPayload = buildPlannerPayload({
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
  const recoveryPayload = buildRecoveryObservabilityEvaluationReport({
    events: [
      ...buildRecoveryObservabilityFixtureEvents(),
      {
        traceType: "agent_run_step_replay",
        action: "resume_step",
        status: "failed",
        error: {
          message: "Replay failed.",
        },
      },
    ],
  });

  const report = buildRolloutReadinessReport({
    mockPlannerPayload,
    plannerRuntime: {
      executionPlanner: "deterministic",
      intentPlanner: "deterministic",
      plannerRollout: "configured",
      effectiveExecutionPlanner: "deterministic",
      effectiveIntentPlanner: "deterministic",
    },
    realPlannerPayload,
    recoveryPayload,
    trajectoryPayload: buildTrajectoryPayload({
      failed: true,
    }),
  });

  assert.equal(report.summary.status, "not_ready");
  assert.ok(
    report.signals.planner.failedReasons.includes(
      "unexpected_fallback_rate_exceeded"
    )
  );
  assert.ok(
    report.signals.planner.failedReasons.includes("planner_divergence_exceeded")
  );
  assert.equal(report.signals.trajectory.status, "fail");
  assert.equal(report.signals.recovery.status, "fail");
  assert.deepEqual(
    report.failedChecks.map((check) => check.id),
    [
      "real_planner_gate_passed",
      "planner_runtime_pure_llm",
      "trajectory_gate_passed",
      "recovery_gate_passed",
      "unexpected_fallback_rate_zero",
      "mock_real_divergence_zero",
    ]
  );
});

test("rollout readiness report reads and writes latest result files", async () => {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rollout-readiness-report-")
  );

  await writeFile(
    path.join(outputDirectory, "latest-planner-mock.json"),
    `${JSON.stringify(buildPlannerPayload({ provider: "mock" }), null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(outputDirectory, "latest-planner-real.json"),
    `${JSON.stringify(buildPlannerPayload({ provider: "real" }), null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(outputDirectory, "latest-trajectory.json"),
    `${JSON.stringify(buildTrajectoryPayload(), null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(outputDirectory, "latest-recovery-observability.json"),
    `${JSON.stringify(buildRecoveryObservabilityEvaluationReport(), null, 2)}\n`,
    "utf8"
  );

  const report = await buildRolloutReadinessReportFromResults({
    inputDirectory: outputDirectory,
    plannerRuntime: pureLlmPlannerRuntime,
    runId: "readiness-from-files",
  });
  const paths = await writeRolloutReadinessReport({
    outputDirectory,
    report,
  });

  assert.equal(report.summary.status, "ready");
  assert.equal(path.basename(paths.jsonPath), "latest-rollout-readiness.json");
  assert.equal(path.basename(paths.markdownPath), "latest-rollout-readiness.md");

  const writtenJson = JSON.parse(await readFile(paths.jsonPath, "utf8"));
  const writtenMarkdown = await readFile(paths.markdownPath, "utf8");

  assert.equal(writtenJson.summary.runId, "readiness-from-files");
  assert.match(writtenMarkdown, /Real planner fallback rate/);
});

test("planner runtime gate requires pure LLM rollout target", () => {
  const gate = buildPlannerRuntimeGate({
    current: {
      executionPlanner: "llm",
      intentPlanner: "llm",
      plannerRollout: "configured",
      effectiveExecutionPlanner: "llm",
      effectiveIntentPlanner: "llm",
    },
  });

  assert.equal(gate.status, "fail");
  assert.ok(gate.failedReasons.includes("plannerRollout_mismatch"));
});
