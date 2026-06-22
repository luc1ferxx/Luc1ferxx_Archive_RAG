import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRecoveryObservabilityCases,
  buildRecoveryObservabilityEvaluationReport,
  buildRecoveryObservabilityFixtureEvents,
  formatRecoveryObservabilityReportMarkdown,
  writeRecoveryObservabilityEvaluationReport,
} from "../evaluation/recovery-observability-eval.js";

const findCase = (report, id) =>
  report.cases.find((caseResult) => caseResult.id === id);

const findCheck = (caseResult, id) =>
  caseResult?.checks.find((check) => check.id === id);

test("recovery observability eval builds a deterministic passing report", () => {
  const report = buildRecoveryObservabilityEvaluationReport({
    createdAt: "2026-06-19T00:00:00.000Z",
    runId: "recovery-deterministic",
  });

  assert.equal(report.summary.runId, "recovery-deterministic");
  assert.equal(report.summary.status, "pass");
  assert.equal(report.summary.metrics.caseCount, 5);
  assert.equal(report.summary.metrics.failedCaseCount, 0);
  assert.equal(report.summary.metrics.checkCount, 17);
  assert.equal(report.recovery.recoverableRunCount, 3);
  assert.equal(report.recovery.manualRecoveryCount, 1);
  assert.equal(report.recovery.manualRecoveryActionCount, 3);
  assert.equal(report.recovery.manualRecoveryActionFailureCount, 0);
  assert.equal(report.recovery.autoReplayAttemptCount, 2);
  assert.equal(report.recovery.autoReplaySuccessRate, 1);
  assert.equal(report.recovery.stepLifecycleEventCount, 4);
  assert.equal(report.recovery.primaryStepStartedCount, 2);
  assert.equal(report.recovery.primaryStepCompletedCount, 1);
  assert.equal(report.recovery.primaryStepFailedCount, 1);
  assert.equal(report.recovery.stepRetryCount, 1);
  assert.equal(report.recovery.stepResumeCount, 1);
  assert.equal(report.recovery.stepReplayFailureCount, 0);

  for (const caseId of [
    "startup_recovery_summary",
    "primary_step_lifecycle",
    "manual_recovery_actions",
    "step_replay_actions",
    "planner_fallback_signal",
  ]) {
    assert.ok(findCase(report, caseId), `${caseId} case should be present`);
  }

  assert.equal(
    findCheck(findCase(report, "primary_step_lifecycle"), "primary_step_started")
      ?.passed,
    true
  );

  const markdown = formatRecoveryObservabilityReportMarkdown(report);

  assert.match(markdown, /AgentRAG Recovery Observability Eval/);
  assert.match(markdown, /Recoverable runs: `3`/);
  assert.match(markdown, /Primary step started: `2`/);
  assert.match(markdown, /PASS Startup recovery summary/);
  assert.match(markdown, /PASS Primary persisted step lifecycle/);
});

test("recovery observability eval fails when primary lifecycle coverage is missing", () => {
  const cases = buildRecoveryObservabilityCases({
    recovery: {
      primaryStepStartedCount: 1,
      primaryStepCompletedCount: 0,
      primaryStepFailedCount: 0,
    },
  });
  const primaryCase = cases.find(
    (caseResult) => caseResult.id === "primary_step_lifecycle"
  );

  assert.equal(primaryCase.passed, false);
  const failedCheckIds = new Set(
    primaryCase.checks
      .filter((check) => !check.passed)
      .map((check) => check.id)
  );

  assert.equal(failedCheckIds.has("primary_step_completed"), true);
  assert.equal(failedCheckIds.has("primary_step_failed"), true);
  assert.equal(failedCheckIds.size, 2);
});

test("recovery observability eval fails when replay or manual action failures are observed", () => {
  const report = buildRecoveryObservabilityEvaluationReport({
    createdAt: "2026-06-19T00:00:00.000Z",
    events: [
      ...buildRecoveryObservabilityFixtureEvents(),
      {
        traceType: "agent_run_step_replay",
        action: "retry_step",
        status: "failed",
        error: {
          message: "Retry failed.",
        },
      },
      {
        traceType: "agent_run_recovery",
        eventType: "manual_recovery_action",
        action: "resume_from_step",
        status: "failed",
        error: {
          message: "Resume failed.",
        },
      },
    ],
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(report.recovery.stepReplayFailureCount, 1);
  assert.equal(report.recovery.manualRecoveryActionFailureCount, 1);
  const failedCaseIds = report.cases
    .filter((caseResult) => !caseResult.passed)
    .map((caseResult) => caseResult.id);

  assert.ok(failedCaseIds.includes("manual_recovery_actions"));
  assert.ok(failedCaseIds.includes("step_replay_actions"));
});

test("recovery observability eval writes latest json and markdown reports", async () => {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "recovery-observability-eval-")
  );
  const report = buildRecoveryObservabilityEvaluationReport({
    createdAt: "2026-06-19T00:00:00.000Z",
    runId: "recovery-write-test",
  });

  const paths = await writeRecoveryObservabilityEvaluationReport({
    outputDirectory,
    report,
  });

  assert.equal(
    path.basename(paths.jsonPath),
    "latest-recovery-observability.json"
  );
  assert.equal(
    path.basename(paths.markdownPath),
    "latest-recovery-observability.md"
  );

  const writtenJson = JSON.parse(await readFile(paths.jsonPath, "utf8"));
  const writtenMarkdown = await readFile(paths.markdownPath, "utf8");

  assert.equal(writtenJson.summary.runId, "recovery-write-test");
  assert.match(writtenMarkdown, /Recovery Metrics/);
});
