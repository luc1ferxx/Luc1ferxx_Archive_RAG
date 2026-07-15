import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSourceReportReference,
  evaluationRepositoryRoot,
  getPublicEvaluationConfig,
  hashCorpusContent,
  hashCanonicalJson,
} from "./eval-evidence.js";
import {
  DEFAULT_RELEASE_EVIDENCE_MAX_AGE_HOURS,
  RELEASE_EVIDENCE_REASON_CODES,
  RELEASE_EVIDENCE_REPORT_SPECS,
  RELEASE_EVIDENCE_SOURCE_SPECS,
  RELEASE_READINESS_SOURCE_IDS,
} from "./eval-evidence-policy.js";
import { buildRobustSuiteGate } from "./quality-robust-suite-gate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");
const LATEST_RELEASE_EVIDENCE_JSON = "latest-release-evidence.json";
const LATEST_RELEASE_EVIDENCE_MD = "latest-release-evidence.md";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const toActualSummary = (report = {}) => ({
  reportType: report.evidence?.reportType ?? "unknown",
  runId: report.evidence?.runId ?? "unknown",
  generatedAt: report.evidence?.generatedAt ?? "unknown",
  commitSha: report.evidence?.git?.commitSha ?? "unknown",
  corpus: report.evidence?.corpus ?? null,
  provider: report.evidence?.provider ?? null,
  modelRouteId: report.evidence?.modelRouteId ?? null,
});

const buildCheck = ({
  actual,
  expected,
  id,
  reasonCode = RELEASE_EVIDENCE_REASON_CODES.ok,
  report,
  reportType,
} = {}) => ({
  id,
  status:
    reasonCode === RELEASE_EVIDENCE_REASON_CODES.ok ? "pass" : "fail",
  reasonCode,
  expected,
  actual,
  reportType: reportType ?? report?.evidence?.reportType ?? "unknown",
  runId: report?.evidence?.runId ?? null,
  generatedAt: report?.evidence?.generatedAt ?? null,
  commitSha: report?.evidence?.git?.commitSha ?? null,
  corpus: report?.evidence?.corpus ?? null,
  provider: report?.evidence?.provider ?? null,
});

const hasCompleteLineage = (report, spec) => {
  const evidence = report?.evidence;

  return Boolean(
    evidence &&
      evidence.schemaVersion &&
      evidence.reportType === spec.reportType &&
      evidence.reportId === spec.id &&
      evidence.runId &&
      evidence.generatedAt &&
      evidence.git &&
      evidence.command &&
      evidence.profile &&
      evidence.corpus &&
      evidence.corpus.id &&
      evidence.corpus.relativePath &&
      evidence.corpus.contentHash &&
      evidence.corpus.version &&
      evidence.configHash &&
      evidence.provider?.id &&
      evidence.provider?.mode &&
      Object.hasOwn(evidence, "modelRouteId") &&
      Array.isArray(evidence.sourceReports) &&
      evidence.generatorVersion
  );
};

const getRobustReportStatuses = (reports) => {
  const gate = buildRobustSuiteGate({
    latestRobustPayloads: [
      {
        reportId: "compare-hard-synthetic",
        payload: reports["compare-hard-synthetic"] ?? null,
      },
      {
        reportId: "rerank-hard-cs",
        payload: reports["rerank-hard-cs"] ?? null,
      },
      {
        reportId: "arxiv-real-paper-rerank",
        payload: reports["arxiv-real-paper-rerank"] ?? null,
      },
    ],
    requireRobustSuite: true,
  });

  return new Map(
    (gate.reports ?? []).map((report) => [report.reportId, report.status])
  );
};

const reportPassed = ({ report, spec, robustStatuses }) => {
  if (spec.suiteId === "robust") {
    return robustStatuses.get(spec.id) === "pass";
  }

  if (spec.reportType === "runtime_smoke") {
    return report.status === "pass";
  }

  if (spec.reportType === "rollout_readiness") {
    return report.summary?.status === "ready";
  }

  return report.summary?.status === "pass";
};

const getReportFailureReason = ({
  maxAgeHours,
  nowMs,
  report,
  robustStatuses,
  spec,
  targetCommit,
  expectedCorpusHash,
}) => {
  if (!report) {
    return RELEASE_EVIDENCE_REASON_CODES.missingReport;
  }

  if (!hasCompleteLineage(report, spec)) {
    return RELEASE_EVIDENCE_REASON_CODES.missingLineage;
  }

  if (!reportPassed({ report, spec, robustStatuses })) {
    return RELEASE_EVIDENCE_REASON_CODES.reportFailed;
  }

  const evidence = report.evidence;

  if (evidence.git.commitSha === "unknown") {
    return RELEASE_EVIDENCE_REASON_CODES.unknownCommit;
  }

  if (evidence.git.commitSha !== targetCommit) {
    return RELEASE_EVIDENCE_REASON_CODES.commitMismatch;
  }

  if (evidence.git.dirty !== false) {
    return RELEASE_EVIDENCE_REASON_CODES.dirtyWorktree;
  }

  const generatedAtMs = Date.parse(evidence.generatedAt);

  if (!Number.isFinite(generatedAtMs)) {
    return RELEASE_EVIDENCE_REASON_CODES.invalidGeneratedAt;
  }

  if (generatedAtMs > nowMs) {
    return RELEASE_EVIDENCE_REASON_CODES.futureReport;
  }

  if (nowMs - generatedAtMs > maxAgeHours * 60 * 60 * 1000) {
    return RELEASE_EVIDENCE_REASON_CODES.staleReport;
  }

  const expectedConfigHash = hashCanonicalJson(
    getPublicEvaluationConfig({ report, reportType: spec.reportType })
  );

  if (
    !SHA256_PATTERN.test(evidence.configHash) ||
    evidence.configHash !== expectedConfigHash
  ) {
    return RELEASE_EVIDENCE_REASON_CODES.configHashMismatch;
  }

  if (
    spec.corpus &&
    (evidence.corpus.id !== spec.corpus.id ||
      evidence.corpus.relativePath !== spec.corpus.relativePath ||
      evidence.corpus.version !== spec.corpus.version ||
      !SHA256_PATTERN.test(evidence.corpus.contentHash) ||
      (expectedCorpusHash !== undefined &&
        evidence.corpus.contentHash !== expectedCorpusHash))
  ) {
    return RELEASE_EVIDENCE_REASON_CODES.wrongCorpus;
  }

  if (
    evidence.provider.id !== spec.providerId ||
    evidence.provider.mode !== spec.providerMode
  ) {
    return RELEASE_EVIDENCE_REASON_CODES.wrongProvider;
  }

  if (evidence.modelRouteId !== spec.modelRouteId) {
    return RELEASE_EVIDENCE_REASON_CODES.wrongModelRoute;
  }

  return RELEASE_EVIDENCE_REASON_CODES.ok;
};

const buildRobustLineageCheck = ({ reports, targetCommit }) => {
  const suiteReports = RELEASE_EVIDENCE_REPORT_SPECS.filter(
    (spec) => spec.suiteId === "robust"
  ).map((spec) => reports[spec.id]?.evidence ?? null);
  const suites = suiteReports.map((evidence) => evidence?.suite ?? null);
  const firstSuite = suites[0] ?? null;
  const matched =
    suiteReports.every(
      (evidence) => evidence?.git?.commitSha === targetCommit
    ) &&
    firstSuite?.id === "robust" &&
    firstSuite?.runId &&
    SHA256_PATTERN.test(firstSuite?.configHash ?? "") &&
    suites.every(
      (suite) =>
        suite?.id === firstSuite.id &&
        suite?.runId === firstSuite.runId &&
        suite?.configHash === firstSuite.configHash
    );

  return buildCheck({
    actual: suites,
    expected: {
      commitSha: targetCommit,
      suiteId: "robust",
      sameRunId: true,
      sameConfigHash: true,
    },
    id: "robust-lineage",
    reasonCode: matched
      ? RELEASE_EVIDENCE_REASON_CODES.ok
      : RELEASE_EVIDENCE_REASON_CODES.robustLineageSplit,
    reportType: "suite",
  });
};

const buildReadinessSourceCheck = ({ reports }) => {
  const readiness = reports["rollout-readiness"];
  const expectedSources = RELEASE_READINESS_SOURCE_IDS.map((id) =>
    buildSourceReportReference(reports[id])
  );
  const actualSources = readiness?.evidence?.sourceReports ?? [];
  const matched =
    expectedSources.length === actualSources.length &&
    expectedSources.every(
      (expected, index) =>
        JSON.stringify(expected) === JSON.stringify(actualSources[index])
    );

  return buildCheck({
    actual: actualSources,
    expected: expectedSources,
    id: "rollout-readiness-sources",
    reasonCode: matched
      ? RELEASE_EVIDENCE_REASON_CODES.ok
      : RELEASE_EVIDENCE_REASON_CODES.sourceReportLineageMismatch,
    report: readiness,
    reportType: "aggregate",
  });
};

export const buildReleaseEvidenceReport = ({
  expectedCorpusHashes = {},
  maxAgeHours = DEFAULT_RELEASE_EVIDENCE_MAX_AGE_HOURS,
  now = new Date().toISOString(),
  reports = {},
  targetCommit,
} = {}) => {
  const nowMs = Date.parse(now);
  const robustStatuses = getRobustReportStatuses(reports);
  const reportChecks = RELEASE_EVIDENCE_REPORT_SPECS.map((spec) => {
    const report = reports[spec.id] ?? null;
    const reasonCode = getReportFailureReason({
      maxAgeHours,
      nowMs,
      report,
      robustStatuses,
      spec,
      targetCommit,
      expectedCorpusHash: expectedCorpusHashes[spec.id],
    });

    return buildCheck({
      actual: report ? toActualSummary(report) : null,
      expected: {
        commitSha: targetCommit,
        corpus: spec.corpus ?? null,
        corpusContentHash: expectedCorpusHashes[spec.id] ?? null,
        maxAgeHours,
        modelRouteId: spec.modelRouteId,
        providerId: spec.providerId,
        providerMode: spec.providerMode,
        reportId: spec.id,
        reportType: spec.reportType,
      },
      id: spec.id,
      reasonCode,
      report,
      reportType: spec.reportType,
    });
  });
  const sourceChecks = RELEASE_EVIDENCE_SOURCE_SPECS.map((spec) => {
    const report = reports[spec.id] ?? null;
    const reasonCode = getReportFailureReason({
      maxAgeHours,
      nowMs,
      report,
      robustStatuses,
      spec,
      targetCommit,
    });

    return buildCheck({
      actual: report ? toActualSummary(report) : null,
      expected: {
        commitSha: targetCommit,
        maxAgeHours,
        modelRouteId: spec.modelRouteId,
        providerId: spec.providerId,
        providerMode: spec.providerMode,
        reportId: spec.id,
        reportType: spec.reportType,
      },
      id: spec.id,
      reasonCode,
      report,
      reportType: spec.reportType,
    });
  });
  const checks = [
    ...reportChecks,
    ...sourceChecks,
    buildRobustLineageCheck({ reports, targetCommit }),
    buildReadinessSourceCheck({ reports }),
  ];
  const failedChecks = checks.filter((check) => check.status === "fail");

  return {
    summary: {
      status: failedChecks.length === 0 ? "pass" : "fail",
      reasonCode:
        failedChecks[0]?.reasonCode ?? RELEASE_EVIDENCE_REASON_CODES.ok,
      generatedAt: new Date(nowMs).toISOString(),
      targetCommit,
      maxAgeHours,
      checkCount: checks.length,
      failedCheckCount: failedChecks.length,
    },
    checks,
    failedChecks,
  };
};

const readOptionalJsonFile = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

export const readReleaseEvidenceInputs = async ({
  inputDirectory = resultsDirectory,
} = {}) => {
  const specs = [
    ...RELEASE_EVIDENCE_REPORT_SPECS,
    ...RELEASE_EVIDENCE_SOURCE_SPECS,
  ];
  const entries = await Promise.all(
    specs.map(async (spec) => [
      spec.id,
      await readOptionalJsonFile(path.join(inputDirectory, spec.fileName)),
    ])
  );

  return Object.fromEntries(entries);
};

export const readReleaseCorpusHashes = async ({
  repoRoot = evaluationRepositoryRoot,
} = {}) => {
  const entries = await Promise.all(
    RELEASE_EVIDENCE_REPORT_SPECS.filter((spec) => spec.corpus).map(
      async (spec) => {
        try {
          return [
            spec.id,
            await hashCorpusContent(
              path.resolve(repoRoot, spec.corpus.relativePath)
            ),
          ];
        } catch (error) {
          if (error.code === "ENOENT") {
            return [spec.id, null];
          }

          throw error;
        }
      }
    )
  );

  return Object.fromEntries(entries);
};

const formatValue = (value) => {
  if (value === null || value === undefined) {
    return "unknown";
  }

  if (typeof value === "object") {
    return JSON.stringify(value).replaceAll("|", "\\|");
  }

  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ");
};

export const formatReleaseEvidenceReportMarkdown = (report = {}) => {
  const summary = report.summary ?? {};
  const lines = [
    "# Release Evidence Gate",
    "",
    `- Status: \`${summary.status ?? "unknown"}\``,
    `- Reason code: \`${summary.reasonCode ?? "unknown"}\``,
    `- Target commit: \`${summary.targetCommit ?? "unknown"}\``,
    `- Generated at: \`${summary.generatedAt ?? "unknown"}\``,
    `- Max age: \`${summary.maxAgeHours ?? "unknown"} hours\``,
    `- Checks: \`${
      (summary.checkCount ?? 0) - (summary.failedCheckCount ?? 0)
    }/${summary.checkCount ?? 0}\` passed`,
    "",
    "## Checks",
    "",
    "| Report | Status | Reason code | Type | Run ID | Generated at | Commit | Corpus / provider | Expected | Actual |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const check of report.checks ?? []) {
    lines.push(
      `| ${formatValue(check.id)} | ${formatValue(check.status)} | ${formatValue(
        check.reasonCode
      )} | ${formatValue(check.reportType)} | ${formatValue(
        check.runId
      )} | ${formatValue(check.generatedAt)} | ${formatValue(
        check.commitSha
      )} | ${formatValue({
        corpus: check.corpus?.id ?? null,
        provider: check.provider?.mode ?? null,
      })} | ${formatValue(check.expected)} | ${formatValue(check.actual)} |`
    );
  }

  return `${lines.join("\n").trim()}\n`;
};

export const writeReleaseEvidenceReport = async ({
  outputDirectory = resultsDirectory,
  report,
} = {}) => {
  await mkdir(outputDirectory, { recursive: true });

  const jsonPath = path.join(outputDirectory, LATEST_RELEASE_EVIDENCE_JSON);
  const markdownPath = path.join(outputDirectory, LATEST_RELEASE_EVIDENCE_MD);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    formatReleaseEvidenceReportMarkdown(report),
    "utf8"
  );

  return {
    jsonPath,
    markdownPath,
  };
};

export const getReleaseEvidenceExitCode = (report = {}, { noFail = false } = {}) =>
  noFail || report.summary?.status === "pass" ? 0 : 1;
