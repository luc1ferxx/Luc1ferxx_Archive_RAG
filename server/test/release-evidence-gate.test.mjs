import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSourceReportReference,
  getCorpusIdentity,
  getPublicEvaluationConfig,
  hashCanonicalJson,
} from "../evaluation/eval-evidence.js";
import {
  RELEASE_EVIDENCE_REPORT_SPECS,
  RELEASE_EVIDENCE_SOURCE_SPECS,
} from "../evaluation/eval-evidence-policy.js";
import {
  buildReleaseEvidenceReport,
  formatReleaseEvidenceReportMarkdown,
  readReleaseEvidenceInputs,
  writeReleaseEvidenceReport,
} from "../evaluation/release-evidence-gate.js";
import { buildRobustSuiteExecutionPlan } from "../evaluation/robust-suite-execution.js";
import {
  buildPassingCheckSuiteReport,
  buildPassingRobustRerankReport,
  buildPassingRobustSyntheticReport,
  buildPassingRolloutReadinessReport,
  buildPassingRuntimeSmokeReport,
} from "./fixtures/release-evidence-report-fixtures.mjs";

const TARGET_COMMIT = "a".repeat(40);
const NOW = "2026-07-15T08:00:00.000Z";
const GENERATED_AT = "2026-07-15T07:30:00.000Z";
const SUITE = {
  configHash: buildRobustSuiteExecutionPlan({
    options: {
      syntheticProvider: "real",
    },
  }).configHash,
  id: "robust",
  runId: "robust-release-run",
};
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_IDS = Object.freeze({
  "arxiv-real-paper-rerank": "rerank",
  "compare-hard-synthetic": "openai",
  "planner-mock": "mock",
  "planner-real": "openai",
  "recovery-observability": "agent-observability",
  "rerank-hard-cs": "rerank",
  "rollout-readiness": "release-readiness",
  "runtime-smoke": "openai",
  trajectory: "agent-eval",
});
const MODEL_ROUTE_IDS = Object.freeze({
  "compare-hard-synthetic": "chat.default",
  "planner-real": "planner.execution.default",
  "runtime-smoke": "planner.execution.default",
});
const PASSING_ROBUST_SYNTHETIC_REPORT =
  await buildPassingRobustSyntheticReport({
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
    createdAt: GENERATED_AT,
    runId: "compare-hard-synthetic-run",
  });

const buildBaseReport = (reportId) => {
  if (reportId === "compare-hard-synthetic") {
    return structuredClone(PASSING_ROBUST_SYNTHETIC_REPORT);
  }

  if (["rerank-hard-cs", "arxiv-real-paper-rerank"].includes(reportId)) {
    const corpusPath =
      reportId === "rerank-hard-cs"
        ? "evaluation/synthetic-corpus-rerank-hard-cs.json"
        : "evaluation/corpora/arxiv-computer-science-rerank-v1.json";

    return buildPassingRobustRerankReport({
      corpusPath,
      createdAt: GENERATED_AT,
      reportId,
      runId: `${reportId}-run`,
    });
  }

  if (reportId === "runtime-smoke") {
    return buildPassingRuntimeSmokeReport({
      createdAt: GENERATED_AT,
      runId: "runtime-smoke-run",
    });
  }

  const provider = reportId.startsWith("planner-")
    ? reportId.slice("planner-".length)
    : undefined;
  const manifestId = reportId === "recovery-observability"
    ? "recovery"
    : reportId;

  return buildPassingCheckSuiteReport({
    createdAt: GENERATED_AT,
    provider,
    runId: `${reportId}-run`,
    specId: manifestId,
  });
};

const buildEvidence = ({
  corpus,
  providerMode,
  report,
  reportId,
  reportType,
  sourceReports = [],
  suite = null,
}) => ({
  schemaVersion: "1.0.0",
  reportType,
  reportId,
  runId: report.summary?.runId ?? report.runId ?? `${reportId}-run`,
  generatedAt: GENERATED_AT,
  git: {
    commitSha: TARGET_COMMIT,
    dirty: false,
  },
  command: `npm run ${reportId}`,
  profile: "release",
  corpus: {
    contentHash: corpus?.contentHash ?? "unknown",
    id: corpus?.id ?? "unknown",
    relativePath: corpus?.relativePath ?? "unknown",
    version: corpus?.version ?? "unknown",
  },
  configHash: hashCanonicalJson(
    getPublicEvaluationConfig({ report, reportType })
  ),
  provider: {
    id: PROVIDER_IDS[reportId] ?? providerMode,
    mode: providerMode,
  },
  modelRouteId: MODEL_ROUTE_IDS[reportId] ?? null,
  sourceReports,
  suite: suite ? { ...suite } : null,
  generatorVersion: "1.0.0",
});

const createCompleteFixture = () => {
  const reports = {};

  for (const spec of RELEASE_EVIDENCE_REPORT_SPECS.filter(
    ({ id }) => id !== "rollout-readiness"
  )) {
    const report = buildBaseReport(spec.id);
    reports[spec.id] = {
      ...report,
      evidence: buildEvidence({
        corpus: spec.corpus
          ? {
              ...spec.corpus,
              contentHash: `${String(spec.id.length % 10)}`.repeat(64),
            }
          : undefined,
        providerMode: spec.providerMode,
        report,
        reportId: spec.id,
        reportType: spec.reportType,
        suite: spec.suiteId === "robust" ? SUITE : null,
      }),
    };
  }

  const mockPlanner = buildBaseReport("planner-mock");
  reports["planner-mock"] = {
    ...mockPlanner,
    evidence: buildEvidence({
      providerMode: "mock",
      report: mockPlanner,
      reportId: "planner-mock",
      reportType: "planner",
    }),
  };

  const readinessSpec = RELEASE_EVIDENCE_REPORT_SPECS.find(
    ({ id }) => id === "rollout-readiness"
  );
  const readiness = buildPassingRolloutReadinessReport({
    createdAt: GENERATED_AT,
    reports,
    runId: "rollout-readiness-run",
  });
  reports["rollout-readiness"] = {
    ...readiness,
    evidence: buildEvidence({
      providerMode: readinessSpec.providerMode,
      report: readiness,
      reportId: readinessSpec.id,
      reportType: readinessSpec.reportType,
    }),
  };

  const readinessSources = [
    reports["planner-mock"],
    reports["planner-real"],
    reports.trajectory,
    reports["recovery-observability"],
    reports["runtime-smoke"],
  ].map(buildSourceReportReference);
  reports["rollout-readiness"].evidence.sourceReports = readinessSources;

  return reports;
};

const setReportGeneratedAt = ({ generatedAt, reportId, reports }) => {
  const report = reports[reportId];
  report.evidence.generatedAt = generatedAt;

  if (report.summary) {
    report.summary.createdAt = generatedAt;
  } else {
    report.completedAt = generatedAt;
  }

  const readinessSource = reports[
    "rollout-readiness"
  ].evidence.sourceReports.find((source) => source.reportId === reportId);

  if (readinessSource) {
    readinessSource.generatedAt = generatedAt;
  }
};

const runReleaseGateCli = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["evaluation/check-release-evidence.mjs", ...args],
      {
        cwd: path.resolve(testDirectory, ".."),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });

test("release evidence gate passes a complete same-commit fixture", () => {
  const report = buildReleaseEvidenceReport({
    maxAgeHours: 24,
    now: NOW,
    reports: createCompleteFixture(),
    targetCommit: TARGET_COMMIT,
  });

  assert.equal(
    report.summary.status,
    "pass",
    JSON.stringify(report.failedChecks, null, 2)
  );
  assert.equal(report.summary.reasonCode, "ok");
  assert.equal(
    report.checks.every((check) => check.status === "pass"),
    true
  );
  assert.equal(
    report.checks.find((check) => check.id === "planner-real")?.actual.provider
      .mode,
    "real"
  );
});

test("release evidence policy pins every robust corpus version", () => {
  const robustSpecs = RELEASE_EVIDENCE_REPORT_SPECS.filter(
    (spec) => spec.suiteId === "robust"
  );

  assert.equal(robustSpecs.length, 3);
  assert.equal(
    robustSpecs.every(
      (spec) => spec.corpus?.version && spec.corpus.version !== "unknown"
    ),
    true
  );
});

test("release evidence policy matches checked-in robust corpus identities", async () => {
  const repositoryRoot = path.resolve(testDirectory, "..", "..");
  const staticSpecs = RELEASE_EVIDENCE_REPORT_SPECS.filter(
    (spec) =>
      spec.suiteId === "robust" &&
      !spec.corpus.relativePath.includes("/generated/")
  );

  for (const spec of staticSpecs) {
    const corpusPath = path.resolve(repositoryRoot, spec.corpus.relativePath);
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

    assert.deepEqual(getCorpusIdentity({ corpus, corpusPath }), {
      id: spec.corpus.id,
      version: spec.corpus.version,
    });
  }
});

test("release evidence gate fails a report from another commit", () => {
  const reports = createCompleteFixture();
  reports.trajectory.evidence.git.commitSha = "c".repeat(40);
  const report = buildReleaseEvidenceReport({
    maxAgeHours: 24,
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "trajectory");

  assert.equal(report.summary.status, "fail");
  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "commit_mismatch");
});

test("release evidence gate fails reports generated from a dirty worktree", () => {
  const reports = createCompleteFixture();
  reports["runtime-smoke"].evidence.git.dirty = true;
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "runtime-smoke");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "dirty_worktree");
});

test("release evidence gate fails stale reports", () => {
  const reports = createCompleteFixture();
  setReportGeneratedAt({
    generatedAt: "2026-07-13T07:30:00.000Z",
    reportId: "planner-real",
    reports,
  });
  const report = buildReleaseEvidenceReport({
    maxAgeHours: 24,
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "planner-real");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "stale_report");
});

test("release evidence gate rejects reports generated in the future", () => {
  const reports = createCompleteFixture();
  setReportGeneratedAt({
    generatedAt: "2026-07-16T08:00:00.000Z",
    reportId: "planner-real",
    reports,
  });
  const report = buildReleaseEvidenceReport({
    maxAgeHours: 24,
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "planner-real");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "future_report");
});

test("release evidence gate rejects legacy reports without lineage metadata", () => {
  const reports = createCompleteFixture();
  delete reports.trajectory.evidence;
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "trajectory");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "missing_lineage");
});

test("release evidence gate fails when a required report is missing", () => {
  const reports = createCompleteFixture();
  delete reports["arxiv-real-paper-rerank"];
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find(
    (entry) => entry.id === "arxiv-real-paper-rerank"
  );

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "missing_report");
});

test("release evidence gate fails a report generated from the wrong corpus", () => {
  const reports = createCompleteFixture();
  reports["compare-hard-synthetic"].evidence.corpus.id =
    "synthetic-corpus-near-duplicate";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find(
    (entry) => entry.id === "compare-hard-synthetic"
  );

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "wrong_corpus");
});

test("release evidence gate matches corpus content against the current checkout", () => {
  const reports = createCompleteFixture();
  const expectedCorpusHashes = Object.fromEntries(
    RELEASE_EVIDENCE_REPORT_SPECS.filter((spec) => spec.corpus).map((spec) => [
      spec.id,
      reports[spec.id].evidence.corpus.contentHash,
    ])
  );
  reports["rerank-hard-cs"].evidence.corpus.contentHash = "e".repeat(64);
  const report = buildReleaseEvidenceReport({
    expectedCorpusHashes,
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "rerank-hard-cs");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "wrong_corpus");
});

test("release evidence gate requires the real planner provider", () => {
  const reports = createCompleteFixture();
  reports["planner-real"].evidence.provider.mode = "mock";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "planner-real");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "wrong_provider");
});

test("release evidence gate requires the expected provider identity", () => {
  const reports = createCompleteFixture();
  reports["planner-real"].evidence.provider.id = "unknown";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "planner-real");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "wrong_provider");
});

test("release evidence gate requires the public model route identity", () => {
  const reports = createCompleteFixture();
  reports["planner-real"].evidence.modelRouteId = null;
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "planner-real");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "wrong_model_route");
});

test("release evidence gate rejects a report from a non-release profile", () => {
  const reports = createCompleteFixture();
  reports["planner-real"].evidence.profile = "default";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "planner-real");

  assert.equal(report.summary.status, "fail");
  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "wrong_profile");
});

test("release evidence gate validates rollout readiness source lineage", () => {
  const reports = createCompleteFixture();
  reports["rollout-readiness"].evidence.sourceReports[0].configHash =
    "c".repeat(64);
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find(
    (entry) => entry.id === "rollout-readiness-sources"
  );

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "source_report_lineage_mismatch");
});

test("release evidence gate validates the planner mock transitive source", () => {
  const reports = createCompleteFixture();
  reports["planner-mock"].evidence.git.dirty = true;
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "planner-mock");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "dirty_worktree");
});

test("release evidence gate rejects split robust suite lineage", () => {
  const reports = createCompleteFixture();
  reports["rerank-hard-cs"].evidence.suite.runId = "another-robust-run";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "robust-lineage");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "robust_lineage_split");
});

test("release evidence gate rejects a malformed robust suite config hash", () => {
  const reports = createCompleteFixture();

  for (const id of [
    "compare-hard-synthetic",
    "rerank-hard-cs",
    "arxiv-real-paper-rerank",
  ]) {
    reports[id].evidence.suite.configHash = "not-a-sha256";
  }

  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "robust-lineage");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "robust_lineage_split");
});

test("release evidence gate rejects a shared but non-canonical robust suite config", () => {
  const reports = createCompleteFixture();

  for (const id of [
    "compare-hard-synthetic",
    "rerank-hard-cs",
    "arxiv-real-paper-rerank",
  ]) {
    reports[id].evidence.suite.configHash = "c".repeat(64);
  }

  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "robust-lineage");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "config_hash_mismatch");
});

test("release evidence gate rejects a mismatched public config hash", () => {
  const reports = createCompleteFixture();
  reports["rerank-hard-cs"].evidence.configHash = "d".repeat(64);
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "rerank-hard-cs");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "config_hash_mismatch");
});

test("release evidence gate requires each source report to pass its own checks", () => {
  const reports = createCompleteFixture();
  reports.trajectory.summary.status = "fail";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const check = report.checks.find((entry) => entry.id === "trajectory");

  assert.equal(check.status, "fail");
  assert.equal(check.reasonCode, "report_failed");
});

test("release evidence gate binds every robust report body to its evidence envelope", () => {
  const robustReportIds = [
    "compare-hard-synthetic",
    "rerank-hard-cs",
    "arxiv-real-paper-rerank",
  ];

  for (const reportId of robustReportIds) {
    for (const [field, issueId] of [
      ["runId", "envelope.runId"],
      ["createdAt", "envelope.generatedAt"],
    ]) {
      const reports = createCompleteFixture();
      reports[reportId].summary[field] = `stale-${field}`;
      const report = buildReleaseEvidenceReport({
        now: NOW,
        reports,
        targetCommit: TARGET_COMMIT,
      });
      const contractCheck = report.checks.find(
        (entry) => entry.id === `${reportId}-contract`
      );

      assert.equal(report.summary.status, "fail", `${reportId}.${field}`);
      assert.equal(contractCheck.status, "fail", `${reportId}.${field}`);
      assert.equal(
        contractCheck.reasonCode,
        "report_integrity_failed",
        `${reportId}.${field}`
      );
      assert.ok(
        contractCheck.actual.some((issue) => issue.id === issueId),
        `${reportId}.${field}`
      );
    }
  }
});

test("release evidence gate pins robust envelope schema and generator versions", () => {
  for (const reportId of [
    "compare-hard-synthetic",
    "rerank-hard-cs",
    "arxiv-real-paper-rerank",
  ]) {
    for (const [field, issueId] of [
      ["schemaVersion", "envelope.schemaVersion"],
      ["generatorVersion", "envelope.generatorVersion"],
    ]) {
      const reports = createCompleteFixture();
      reports[reportId].evidence[field] = "999.0.0";
      const report = buildReleaseEvidenceReport({
        now: NOW,
        reports,
        targetCommit: TARGET_COMMIT,
      });
      const contractCheck = report.checks.find(
        (entry) => entry.id === `${reportId}-contract`
      );

      assert.equal(report.summary.status, "fail", `${reportId}.${field}`);
      assert.equal(contractCheck.status, "fail", `${reportId}.${field}`);
      assert.ok(
        contractCheck.actual.some((issue) => issue.id === issueId),
        `${reportId}.${field}`
      );
    }
  }
});

test("release evidence gate rejects a one-case trajectory hidden by a passing summary", () => {
  const reports = createCompleteFixture();
  reports.trajectory.cases = [reports.trajectory.cases[0]];
  reports.trajectory.summary.metrics = {
    caseCount: 1,
    checkCount: reports.trajectory.cases[0].checks.length,
    failedCaseCount: 0,
    failedCheckCount: 0,
    passedCaseCount: 1,
    passedCheckCount: reports.trajectory.cases[0].checks.length,
    overallPassRate: 1,
    checkPassRate: 1,
  };
  reports.trajectory.summary.status = "pass";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const contractCheck = report.checks.find(
    (entry) => entry.id === "trajectory-contract"
  );

  assert.equal(report.summary.status, "fail");
  assert.equal(contractCheck.status, "fail");
  assert.equal(contractCheck.reasonCode, "report_integrity_failed");
  assert.ok(
    contractCheck.actual.some((issue) => issue.id === "cases.contract")
  );
});

test("release evidence gate rejects a forged passing runtime smoke envelope", () => {
  const reports = createCompleteFixture();
  reports["runtime-smoke"].checks.longMemory.healthStatus = "error";
  reports["runtime-smoke"].status = "pass";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const contractCheck = report.checks.find(
    (entry) => entry.id === "runtime-smoke-contract"
  );

  assert.equal(report.summary.status, "fail");
  assert.equal(contractCheck.status, "fail");
  assert.equal(contractCheck.reasonCode, "report_integrity_failed");
  assert.ok(
    contractCheck.actual.some((issue) => issue.id === "checks.longMemory")
  );
});

test("release evidence gate rejects runtime smoke content wrapped in a fresh evidence envelope", () => {
  const reports = createCompleteFixture();
  reports["runtime-smoke"].runId = "stale-runtime-smoke-run";
  reports["runtime-smoke"].completedAt = "2026-07-13T07:30:00.000Z";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const contractCheck = report.checks.find(
    (entry) => entry.id === "runtime-smoke-contract"
  );

  assert.equal(report.summary.status, "fail");
  assert.equal(contractCheck.status, "fail");
  assert.equal(contractCheck.reasonCode, "report_integrity_failed");
  assert.ok(
    contractCheck.actual.some((issue) => issue.id === "envelope.runId")
  );
  assert.ok(
    contractCheck.actual.some((issue) => issue.id === "envelope.generatedAt")
  );
});

test("release evidence gate rejects forged ready status over failing readiness facts", () => {
  const reports = createCompleteFixture();
  reports["rollout-readiness"].checks[0].status = "fail";
  reports["rollout-readiness"].summary.status = "ready";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const contractCheck = report.checks.find(
    (entry) => entry.id === "rollout-readiness-contract"
  );

  assert.equal(report.summary.status, "fail");
  assert.equal(contractCheck.status, "fail");
  assert.equal(contractCheck.reasonCode, "report_integrity_failed");
  assert.ok(
    contractCheck.actual.some(
      (issue) => issue.id === "rollout_readiness_projection"
    )
  );
});

test("release evidence gate rejects rollout readiness content wrapped in a fresh evidence envelope", () => {
  const reports = createCompleteFixture();
  reports["rollout-readiness"].summary.runId = "stale-readiness-run";
  reports["rollout-readiness"].summary.createdAt =
    "2026-07-13T07:30:00.000Z";
  const report = buildReleaseEvidenceReport({
    now: NOW,
    reports,
    targetCommit: TARGET_COMMIT,
  });
  const contractCheck = report.checks.find(
    (entry) => entry.id === "rollout-readiness-contract"
  );

  assert.equal(report.summary.status, "fail");
  assert.equal(contractCheck.status, "fail");
  assert.equal(contractCheck.reasonCode, "report_integrity_failed");
  assert.ok(
    contractCheck.actual.some((issue) => issue.id === "envelope.runId")
  );
  assert.ok(
    contractCheck.actual.some((issue) => issue.id === "envelope.generatedAt")
  );
});

test("release evidence gate pins runtime and readiness envelope schema versions", () => {
  for (const [reportId, field, issueId] of [
    ["runtime-smoke", "schemaVersion", "envelope.schemaVersion"],
    ["runtime-smoke", "generatorVersion", "envelope.generatorVersion"],
    ["rollout-readiness", "schemaVersion", "envelope.schemaVersion"],
    ["rollout-readiness", "generatorVersion", "envelope.generatorVersion"],
  ]) {
    const reports = createCompleteFixture();
    reports[reportId].evidence[field] = "999.0.0";
    const report = buildReleaseEvidenceReport({
      now: NOW,
      reports,
      targetCommit: TARGET_COMMIT,
    });
    const contractCheck = report.checks.find(
      (entry) => entry.id === `${reportId}-contract`
    );

    assert.equal(report.summary.status, "fail", `${reportId}.${field}`);
    assert.equal(contractCheck.status, "fail", `${reportId}.${field}`);
    assert.equal(
      contractCheck.reasonCode,
      "report_integrity_failed",
      `${reportId}.${field}`
    );
    assert.ok(
      contractCheck.actual.some((issue) => issue.id === issueId),
      `${reportId}.${field}`
    );
  }
});

test("release evidence gate reads latest inputs and writes stable JSON and Markdown", async () => {
  const inputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "release-evidence-gate-")
  );

  try {
    const reports = createCompleteFixture();
    const specs = [
      ...RELEASE_EVIDENCE_REPORT_SPECS,
      ...RELEASE_EVIDENCE_SOURCE_SPECS,
    ];

    for (const spec of specs) {
      await writeFile(
        path.join(inputDirectory, spec.fileName),
        `${JSON.stringify(reports[spec.id], null, 2)}\n`,
        "utf8"
      );
    }

    const readReports = await readReleaseEvidenceInputs({ inputDirectory });
    const report = buildReleaseEvidenceReport({
      now: NOW,
      reports: readReports,
      targetCommit: TARGET_COMMIT,
    });
    const paths = await writeReleaseEvidenceReport({
      outputDirectory: inputDirectory,
      report,
    });
    const writtenJson = await readFile(paths.jsonPath, "utf8");
    const writtenMarkdown = await readFile(paths.markdownPath, "utf8");

    assert.equal(report.summary.status, "pass");
    assert.equal(path.basename(paths.jsonPath), "latest-release-evidence.json");
    assert.equal(path.basename(paths.markdownPath), "latest-release-evidence.md");
    assert.equal(writtenJson, `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(writtenMarkdown, formatReleaseEvidenceReportMarkdown(report));
    assert.match(writtenMarkdown, /Release Evidence Gate/);
    assert.match(writtenMarkdown, /compare-hard-synthetic/);
    assert.match(writtenMarkdown, /rollout-readiness-sources/);
    assert.doesNotMatch(writtenJson, new RegExp(inputDirectory));
    assert.doesNotMatch(writtenMarkdown, new RegExp(inputDirectory));
  } finally {
    await rm(inputDirectory, { force: true, recursive: true });
  }
});

test("release evidence CLI no-fail changes only the exit code", async () => {
  const inputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "release-evidence-cli-")
  );
  const baseArgs = [
    "--input-directory",
    inputDirectory,
    "--json",
  ];

  try {
    const failing = await runReleaseGateCli(baseArgs);
    const noFail = await runReleaseGateCli([...baseArgs, "--no-fail"]);
    const failingReport = JSON.parse(failing.stdout);
    const noFailReport = JSON.parse(noFail.stdout);

    assert.equal(failing.exitCode, 1, failing.stderr);
    assert.equal(noFail.exitCode, 0, noFail.stderr);
    assert.equal(failingReport.summary.status, "fail");
    assert.equal(noFailReport.summary.status, "fail");
    assert.equal(noFailReport.summary.reasonCode, failingReport.summary.reasonCode);
    assert.deepEqual(noFailReport.checks, failingReport.checks);
  } finally {
    await rm(inputDirectory, { force: true, recursive: true });
  }
});

test("release evidence CLI rejects an explicit target that is not HEAD", async () => {
  const result = await runReleaseGateCli([
    "--target-commit",
    "0".repeat(40),
    "--json",
  ]);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /does not match HEAD/);
  assert.equal(result.stdout, "");
});
