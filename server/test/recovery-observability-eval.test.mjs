import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRecoveryObservabilityEvaluationReport,
  buildRecoveryObservabilityFixtureEvents,
  formatRecoveryObservabilityReportMarkdown,
  writeRecoveryObservabilityEvaluationReport,
} from "../evaluation/recovery-observability-eval.js";

test("recovery observability eval builds a deterministic passing report", () => {
  const report = buildRecoveryObservabilityEvaluationReport({
    createdAt: "2026-06-19T00:00:00.000Z",
    runId: "recovery-deterministic",
  });

  assert.equal(report.summary.runId, "recovery-deterministic");
  assert.equal(report.summary.status, "pass");
  assert.equal(report.summary.metrics.caseCount, 4);
  assert.equal(report.summary.metrics.failedCaseCount, 0);
  assert.equal(report.summary.metrics.checkCount, 14);
  assert.equal(report.recovery.recoverableRunCount, 3);
  assert.equal(report.recovery.manualRecoveryCount, 1);
  assert.equal(report.recovery.manualRecoveryActionCount, 3);
  assert.equal(report.recovery.manualRecoveryActionFailureCount, 0);
  assert.equal(report.recovery.autoReplayAttemptCount, 2);
  assert.equal(report.recovery.autoReplaySuccessRate, 1);
  assert.equal(report.recovery.stepRetryCount, 1);
  assert.equal(report.recovery.stepResumeCount, 1);
  assert.equal(report.recovery.stepReplayFailureCount, 0);
  assert.deepEqual(
    report.cases.map((caseResult) => caseResult.id),
    [
      "startup_recovery_summary",
      "manual_recovery_actions",
      "step_replay_actions",
      "planner_fallback_signal",
    ]
  );

  const markdown = formatRecoveryObservabilityReportMarkdown(report);

  assert.match(markdown, /AgentRAG Recovery Observability Eval/);
  assert.match(markdown, /Recoverable runs: `3`/);
  assert.match(markdown, /PASS Startup recovery summary/);
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
  assert.deepEqual(
    report.cases
      .filter((caseResult) => !caseResult.passed)
      .map((caseResult) => caseResult.id),
    ["manual_recovery_actions", "step_replay_actions"]
  );
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
