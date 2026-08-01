import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSourceReportReference,
  evaluationRepositoryRoot,
  hashCorpusContent,
} from "./eval-evidence.js";
import {
  SHA256_PATTERN,
  buildEvaluationEvidenceCheck as buildCheck,
  getEvaluationEvidenceFailureReason,
  toEvaluationEvidenceActualSummary as toActualSummary,
} from "./eval-evidence-validation.js";
import {
  DEFAULT_RELEASE_EVIDENCE_MAX_AGE_HOURS,
  RELEASE_EVIDENCE_REASON_CODES,
  RELEASE_EVIDENCE_REPORT_SPECS,
  RELEASE_EVIDENCE_SOURCE_SPECS,
  RELEASE_READINESS_SOURCE_IDS,
} from "./eval-evidence-policy.js";
import { buildRobustSuiteGate } from "./quality-robust-suite-gate.js";
import { buildRobustSuiteExecutionPlan } from "./robust-suite-execution.js";
import {
  validateReleaseReportContract,
} from "./release-report-contract-validation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");
const LATEST_RELEASE_EVIDENCE_JSON = "latest-release-evidence.json";
const LATEST_RELEASE_EVIDENCE_MD = "latest-release-evidence.md";
const EXPECTED_RELEASE_ROBUST_SUITE_CONFIG_HASH =
  buildRobustSuiteExecutionPlan({
    options: {
      syntheticProvider: "real",
    },
  }).configHash;

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

const reportPassed = ({ contract, report, spec, robustStatuses }) => {
  if (spec.suiteId === "robust") {
    return robustStatuses.get(spec.id) === "pass";
  }

  if (contract.status !== "pass") {
    return false;
  }

  if (spec.reportType === "runtime_smoke") {
    return report.status === "pass";
  }

  if (spec.reportType === "rollout_readiness") {
    return report.summary?.status === "ready";
  }

  return report.summary?.status === "pass";
};

const buildRobustLineageCheck = ({ reports, targetCommit }) => {
  const suiteReports = RELEASE_EVIDENCE_REPORT_SPECS.filter(
    (spec) => spec.suiteId === "robust"
  ).map((spec) => reports[spec.id]?.evidence ?? null);
  const suites = suiteReports.map((evidence) => evidence?.suite ?? null);
  const firstSuite = suites[0] ?? null;
  const sameLineage =
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
  const matched =
    sameLineage &&
    firstSuite.configHash === EXPECTED_RELEASE_ROBUST_SUITE_CONFIG_HASH;
  const reasonCode = matched
    ? RELEASE_EVIDENCE_REASON_CODES.ok
    : sameLineage
      ? RELEASE_EVIDENCE_REASON_CODES.configHashMismatch
      : RELEASE_EVIDENCE_REASON_CODES.robustLineageSplit;

  return buildCheck({
    actual: suites,
    expected: {
      commitSha: targetCommit,
      configHash: EXPECTED_RELEASE_ROBUST_SUITE_CONFIG_HASH,
      suiteId: "robust",
      sameRunId: true,
      sameConfigHash: true,
    },
    id: "robust-lineage",
    reasonCode,
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
  const reportContracts = new Map(
    [...RELEASE_EVIDENCE_REPORT_SPECS, ...RELEASE_EVIDENCE_SOURCE_SPECS].map(
      (spec) => [
        spec.id,
        validateReleaseReportContract({
          reportId: spec.id,
          report: reports[spec.id] ?? null,
          reports,
        }),
      ]
    )
  );
  const reportChecks = RELEASE_EVIDENCE_REPORT_SPECS.map((spec) => {
    const report = reports[spec.id] ?? null;
    const contract = reportContracts.get(spec.id);
    const reasonCode = getEvaluationEvidenceFailureReason({
      expectedCorpusHash: expectedCorpusHashes[spec.id],
      maxAgeHours,
      nowMs,
      report,
      reportPassed: report
        ? reportPassed({ contract, report, spec, robustStatuses })
        : false,
      spec,
      targetCommit,
    });

    return buildCheck({
      actual: report ? toActualSummary(report) : null,
      expected: {
        commitSha: targetCommit,
        corpus: spec.corpus ?? null,
        corpusContentHash: expectedCorpusHashes[spec.id] ?? null,
        maxAgeHours,
        modelRouteId: spec.modelRouteId,
        profile: spec.profile,
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
    const contract = reportContracts.get(spec.id);
    const reasonCode = getEvaluationEvidenceFailureReason({
      maxAgeHours,
      nowMs,
      report,
      reportPassed: report
        ? reportPassed({ contract, report, spec, robustStatuses })
        : false,
      spec,
      targetCommit,
    });

    return buildCheck({
      actual: report ? toActualSummary(report) : null,
      expected: {
        commitSha: targetCommit,
        maxAgeHours,
        modelRouteId: spec.modelRouteId,
        profile: spec.profile,
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
  const contractChecks = [
    ...RELEASE_EVIDENCE_REPORT_SPECS,
    ...RELEASE_EVIDENCE_SOURCE_SPECS,
  ]
    .map((spec) => {
      const contract = reportContracts.get(spec.id);
      const report = reports[spec.id] ?? null;

      return buildCheck({
        actual: contract.issues,
        expected: { rawReportContractPassed: true },
        id: `${spec.id}-contract`,
        reasonCode:
          contract.status === "pass"
            ? RELEASE_EVIDENCE_REASON_CODES.ok
            : RELEASE_EVIDENCE_REASON_CODES.reportIntegrityFailed,
        report,
        reportType: spec.reportType,
      });
    });
  const checks = [
    ...reportChecks,
    ...sourceChecks,
    ...contractChecks,
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
