import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runPlannerEvaluation,
  writePlannerEvaluationReport,
} from "../evaluation/planner-eval.js";
import {
  buildRecoveryObservabilityEvaluationReport,
  writeRecoveryObservabilityEvaluationReport,
} from "../evaluation/recovery-observability-eval.js";
import {
  runTrajectoryEvaluation,
  writeTrajectoryEvaluationReport,
} from "../evaluation/trajectory-eval.js";

const readWrittenJson = async (writer, report, prefix) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), prefix));

  try {
    const paths = await writer({ outputDirectory, report });
    return JSON.parse(await readFile(paths.jsonPath, "utf8"));
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
};

test("planner writer adds provider-specific release lineage", async () => {
  const report = await runPlannerEvaluation({
    createdAt: "2026-06-09T00:00:00.000Z",
    provider: "mock",
    runId: "planner-lineage-test",
  });
  const writtenReport = await readWrittenJson(
    writePlannerEvaluationReport,
    report,
    "archive-rag-planner-lineage-"
  );

  assert.equal(writtenReport.summary.provider, "mock");
  assert.equal(writtenReport.evidence.reportType, "planner");
  assert.equal(writtenReport.evidence.reportId, "planner-mock");
  assert.equal(writtenReport.evidence.provider.mode, "mock");
});

test("trajectory writer adds deterministic release lineage", async () => {
  const report = await runTrajectoryEvaluation({
    createdAt: "2026-06-09T00:00:00.000Z",
    runId: "trajectory-lineage-test",
  });
  const writtenReport = await readWrittenJson(
    writeTrajectoryEvaluationReport,
    report,
    "archive-rag-trajectory-lineage-"
  );

  assert.equal(writtenReport.evidence.reportType, "trajectory");
  assert.equal(writtenReport.evidence.reportId, "trajectory");
  assert.equal(writtenReport.evidence.provider.mode, "deterministic");
});

test("recovery writer adds deterministic release lineage", async () => {
  const report = buildRecoveryObservabilityEvaluationReport({
    events: [],
    createdAt: "2026-06-09T00:00:00.000Z",
    runId: "recovery-lineage-test",
  });
  const writtenReport = await readWrittenJson(
    writeRecoveryObservabilityEvaluationReport,
    report,
    "archive-rag-recovery-lineage-"
  );

  assert.equal(writtenReport.evidence.reportType, "recovery_observability");
  assert.equal(writtenReport.evidence.reportId, "recovery-observability");
  assert.equal(writtenReport.evidence.provider.mode, "deterministic");
});
