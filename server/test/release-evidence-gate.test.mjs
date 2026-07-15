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

const TARGET_COMMIT = "a".repeat(40);
const NOW = "2026-07-15T08:00:00.000Z";
const GENERATED_AT = "2026-07-15T07:30:00.000Z";
const SUITE = {
  configHash: "b".repeat(64),
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

const buildBaseReport = (reportId) => {
  if (reportId === "compare-hard-synthetic") {
    return {
      summary: {
        config: { chunkSize: 900 },
        corpus: {
          path: "server/evaluation/synthetic-corpus-compare-hard.json",
          cases: 1,
        },
        metrics: { overallPassRate: 1 },
        status: "pass",
      },
      cases: [{ id: "compare-hard", passed: true }],
    };
  }

  if (["rerank-hard-cs", "arxiv-real-paper-rerank"].includes(reportId)) {
    const corpusPath =
      reportId === "rerank-hard-cs"
        ? "server/evaluation/synthetic-corpus-rerank-hard-cs.json"
        : "server/evaluation/generated/arxiv-corpus.json";

    return {
      summary: {
        caseCount: 1,
        config: { rerankProvider: "heuristic", topK: 6 },
        corpus: { path: corpusPath, cases: 1 },
        metrics: {
          baseline: { ndcgAtK: 0.5, recallAtK: 0.5 },
          reranked: { ndcgAtK: 0.8, recallAtK: 0.8 },
        },
      },
      cases: [{ id: reportId, passed: true }],
    };
  }

  if (reportId === "runtime-smoke") {
    return {
      completedAt: GENERATED_AT,
      runId: "runtime-smoke-run",
      status: "pass",
      version: "1.0.0",
      checks: {
        planners: {
          executionPlanner: "llm",
          executionPlannerStatus: "selected",
          intentPlanner: "llm",
          intentPlannerStatus: "selected",
        },
      },
    };
  }

  if (reportId === "rollout-readiness") {
    return {
      summary: {
        createdAt: GENERATED_AT,
        runId: "rollout-readiness-run",
        status: "ready",
        version: "1.0.0",
      },
      checks: [{ id: "all_release_signals", status: "pass" }],
      signals: {
        runtime: {
          required: {
            effectiveExecutionPlanner: "llm",
            effectiveIntentPlanner: "llm",
            plannerRollout: "llm",
          },
        },
      },
    };
  }

  const provider = reportId.startsWith("planner-")
    ? reportId.slice("planner-".length)
    : undefined;

  return {
    summary: {
      createdAt: GENERATED_AT,
      provider,
      runId: `${reportId}-run`,
      status: "pass",
      version: "1.0.0",
    },
    cases: [{ id: `${reportId}-case`, passed: true }],
  };
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
  profile: suite ? "robust" : "release",
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

  for (const spec of RELEASE_EVIDENCE_REPORT_SPECS) {
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

  assert.equal(report.summary.status, "pass");
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
  reports["planner-real"].evidence.generatedAt = "2026-07-13T07:30:00.000Z";
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
  reports["planner-real"].evidence.generatedAt = "2026-07-16T08:00:00.000Z";
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
