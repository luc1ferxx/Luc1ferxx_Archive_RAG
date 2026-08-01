import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ROUTE_IDS } from "../rag/model-providers/schema.js";
import {
  evaluationRepositoryRoot,
  hashCorpusContent,
} from "./eval-evidence.js";
import {
  EVALUATION_EVIDENCE_REASON_CODES,
  buildEvaluationEvidenceCheck,
  getEvaluationEvidenceFailureReason,
  toEvaluationEvidenceActualSummary,
} from "./eval-evidence-validation.js";
import {
  buildQualityGateDecision,
  buildQualityHistoryResponse,
} from "./quality-combined-gate.js";
import { buildFeedbackGate } from "./quality-feedback-gate.js";
import { buildPlannerGate } from "./quality-planner-gate.js";
import { buildRecoveryGate } from "./quality-recovery-gate.js";
import { buildQualityRunSummary } from "./quality-run-summary.js";
import { buildTrajectoryGate } from "./quality-trajectory-gate.js";
import {
  CURRENT_QUALITY_EVIDENCE_PROFILE,
} from "./quality-current-suite-manifest.js";
import {
  validateCurrentQualitySuiteReport,
} from "./quality-current-suite-validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");
export const DEFAULT_CURRENT_QUALITY_BASELINE_PATH = path.join(
  __dirname,
  "baselines",
  "quality-near-duplicate-deterministic-v1.json"
);
export const CURRENT_QUALITY_BASELINE_RUN_ID =
  "quality-near-duplicate-deterministic-v1";
const LATEST_CURRENT_QUALITY_GATE_JSON =
  "latest-current-quality-gate.json";
const LATEST_CURRENT_QUALITY_GATE_MD = "latest-current-quality-gate.md";

export const DEFAULT_CURRENT_QUALITY_MAX_AGE_HOURS = 24;

export const CURRENT_QUALITY_REASON_CODES = Object.freeze({
  ...EVALUATION_EVIDENCE_REASON_CODES,
  invalidReport: "invalid_report",
  qualityMetricsFailed: "quality_metrics_failed",
  qualityMetricsUnverified: "quality_metrics_unverified",
  reportIntegrityFailed: "report_integrity_failed",
  suiteContractMismatch: "suite_contract_mismatch",
  wrongBaseline: "wrong_baseline",
});

export const CURRENT_QUALITY_REPORT_SPECS = Object.freeze([
  {
    id: "quality-synthetic",
    reportId: "synthetic-latest-quality",
    fileName: "latest-quality.json",
    reportType: "synthetic",
    providerId: "deterministic",
    providerMode: "deterministic",
    profile: CURRENT_QUALITY_EVIDENCE_PROFILE,
    modelRouteId: null,
    required: true,
    corpus: {
      id: "synthetic-corpus-near-duplicate",
      relativePath:
        "server/evaluation/synthetic-corpus-near-duplicate.json",
      version: "1",
    },
  },
  {
    id: "feedback",
    reportId: "synthetic-latest-feedback",
    fileName: "latest-feedback.json",
    reportType: "synthetic",
    providerId: "deterministic",
    providerMode: "deterministic",
    profile: CURRENT_QUALITY_EVIDENCE_PROFILE,
    modelRouteId: null,
    required: true,
    corpus: {
      id: "feedback-corpus",
      relativePath: "server/evaluation/generated/feedback-corpus.json",
      version: "1",
    },
  },
  {
    id: "trajectory",
    fileName: "latest-trajectory.json",
    reportType: "trajectory",
    providerId: "agent-eval",
    providerMode: "deterministic",
    profile: CURRENT_QUALITY_EVIDENCE_PROFILE,
    modelRouteId: null,
    required: true,
  },
  {
    id: "planner-mock",
    fileName: "latest-planner-mock.json",
    reportType: "planner",
    providerId: "mock",
    providerMode: "mock",
    profile: CURRENT_QUALITY_EVIDENCE_PROFILE,
    modelRouteId: null,
    required: true,
  },
  {
    id: "recovery",
    reportId: "recovery-observability",
    fileName: "latest-recovery-observability.json",
    reportType: "recovery_observability",
    providerId: "agent-observability",
    providerMode: "deterministic",
    profile: CURRENT_QUALITY_EVIDENCE_PROFILE,
    modelRouteId: null,
    required: true,
  },
  {
    id: "planner-real",
    fileName: "latest-planner-real.json",
    reportType: "planner",
    providerId: "openai",
    providerMode: "real",
    profile: CURRENT_QUALITY_EVIDENCE_PROFILE,
    modelRouteId: MODEL_ROUTE_IDS.executionPlannerDefault,
    required: false,
  },
]);

const readOptionalJsonInput = async (filePath) => {
  try {
    return {
      error: null,
      payload: JSON.parse(await readFile(filePath, "utf8")),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        error: null,
        payload: null,
      };
    }

    return {
      error: {
        code: error instanceof SyntaxError ? "invalid_json" : "read_error",
        fileName: path.basename(filePath),
      },
      payload: null,
    };
  }
};

export const readCurrentQualityInputs = async ({
  baselinePath = DEFAULT_CURRENT_QUALITY_BASELINE_PATH,
  inputDirectory = resultsDirectory,
} = {}) => {
  const reportInputs = await Promise.all(
    CURRENT_QUALITY_REPORT_SPECS.map(async (spec) => ({
      id: spec.id,
      input: await readOptionalJsonInput(
        path.join(inputDirectory, spec.fileName)
      ),
    }))
  );
  const reports = Object.fromEntries(
    reportInputs.map(({ id, input }) => [id, input.payload])
  );
  const inputErrors = Object.fromEntries(
    reportInputs
      .filter(({ input }) => input.error)
      .map(({ id, input }) => [id, input.error])
  );
  let runPayloads = [];

  if (baselinePath) {
    const resolvedBaselinePath = path.resolve(baselinePath);
    const baselineInput = await readOptionalJsonInput(resolvedBaselinePath);
    const baselinePayload = baselineInput.payload;

    if (baselineInput.error) {
      inputErrors["quality-baseline"] = baselineInput.error;
    }

    runPayloads = baselinePayload
      ? [
          {
            fileName: path.basename(resolvedBaselinePath),
            payload: baselinePayload,
          },
        ]
      : [];
  }
  const latestPlannerPayloads = [
    reports["planner-mock"],
    reports["planner-real"],
  ].filter(Boolean);
  const history = buildQualityHistoryResponse({
    latestPayload: reports["quality-synthetic"],
    latestFeedbackPayload: reports.feedback,
    latestPlannerPayloads,
    latestRecoveryPayload: reports.recovery,
    latestRobustPayloads: [],
    latestTrajectoryPayload: reports.trajectory,
    requireRobustSuite: false,
    runPayloads,
  });

  return {
    history,
    inputErrors,
    reports,
  };
};

export const isCurrentQualityReportPassing = ({ report, spec } = {}) => {
  if (!report || report.summary?.status === "fail") {
    return false;
  }

  if (spec.id === "quality-synthetic") {
    const run = buildQualityRunSummary({
      fileName: spec.fileName,
      payload: report,
    });

    return run?.status === "ok" && (run.caseCount ?? 0) > 0;
  }

  if (spec.id === "feedback") {
    const gate = buildFeedbackGate({
      latestFeedbackPayload: report,
    });

    return gate.status === "pass" && !gate.skipped && gate.caseCount > 0;
  }

  if (spec.id === "trajectory") {
    const gate = buildTrajectoryGate({
      latestTrajectoryPayload: report,
    });

    return gate.status === "pass" && !gate.skipped && gate.caseCount > 0;
  }

  if (spec.id === "planner-mock" || spec.id === "planner-real") {
    const gate = buildPlannerGate({
      latestPlannerPayload: report,
    });

    return (
      gate.status === "pass" &&
      !gate.skipped &&
      gate.caseCount > 0 &&
      gate.checkCount > 0
    );
  }

  if (spec.id === "recovery") {
    const gate = buildRecoveryGate({
      latestRecoveryPayload: report,
    });

    return (
      gate.status === "pass" &&
      !gate.skipped &&
      gate.caseCount > 0 &&
      gate.checkCount > 0
    );
  }

  return false;
};

export const readCurrentQualityCorpusExpectations = async ({
  repoRoot = evaluationRepositoryRoot,
} = {}) => {
  const entries = await Promise.all(
    CURRENT_QUALITY_REPORT_SPECS.filter((spec) => spec.corpus).map(
      async (spec) => {
        try {
          const corpusPath = path.resolve(
            repoRoot,
            spec.corpus.relativePath
          );
          const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

          return [
            spec.id,
            {
              contract: {
                cases: Array.isArray(corpus.cases)
                  ? corpus.cases.map((caseDefinition) => ({
                      docKeys: caseDefinition?.docKeys,
                      expectedAnswerIncludes:
                        caseDefinition?.expectedAnswerIncludes,
                      expectedEvidence: caseDefinition?.expectedEvidence,
                      id: caseDefinition?.id,
                      question: caseDefinition?.question,
                      shouldAbstain: caseDefinition?.shouldAbstain,
                      type: caseDefinition?.type,
                    }))
                  : [],
                documentCount: Array.isArray(corpus.documents)
                  ? corpus.documents.length
                  : null,
                documents: Array.isArray(corpus.documents)
                  ? corpus.documents.map((document) => ({
                      fileName: document?.fileName,
                      key: document?.key,
                      pageCount: Array.isArray(document?.pages)
                        ? document.pages.length
                        : null,
                      pages: Array.isArray(document?.pages)
                        ? document.pages
                        : [],
                    }))
                  : [],
              },
              hash: await hashCorpusContent(corpusPath),
            },
          ];
        } catch (error) {
          if (error.code === "ENOENT") {
            return [
              spec.id,
              {
                contract: null,
                hash: null,
              },
            ];
          }

          throw error;
        }
      }
    )
  );

  const expectations = Object.fromEntries(entries);

  return {
    contracts: Object.fromEntries(
      Object.entries(expectations).map(([id, expectation]) => [
        id,
        expectation.contract,
      ])
    ),
    hashes: Object.fromEntries(
      Object.entries(expectations).map(([id, expectation]) => [
        id,
        expectation.hash,
      ])
    ),
  };
};

export const readCurrentQualityCorpusHashes = async (options = {}) =>
  (await readCurrentQualityCorpusExpectations(options)).hashes;

const getGateWorktreeReason = ({ currentGitState, targetCommit }) => {
  if (!currentGitState || currentGitState.commitSha === "unknown") {
    return CURRENT_QUALITY_REASON_CODES.unknownCommit;
  }

  if (currentGitState.commitSha !== targetCommit) {
    return CURRENT_QUALITY_REASON_CODES.commitMismatch;
  }

  if (currentGitState.dirty !== false) {
    return CURRENT_QUALITY_REASON_CODES.dirtyWorktree;
  }

  return CURRENT_QUALITY_REASON_CODES.ok;
};

export const buildCurrentQualityGateReport = ({
  currentGitState,
  expectedCorpusContracts = {},
  expectedCorpusHashes = {},
  failOnWarn = true,
  history = {},
  inputErrors = {},
  maxAgeHours = DEFAULT_CURRENT_QUALITY_MAX_AGE_HOURS,
  now = new Date().toISOString(),
  reports = {},
  requirePlannerReal = false,
  targetCommit,
} = {}) => {
  const nowMs = Date.parse(now);

  if (!Number.isFinite(nowMs)) {
    throw new Error("Current quality gate requires a valid current time.");
  }

  const reportSpecs = CURRENT_QUALITY_REPORT_SPECS.filter(
    (spec) =>
      spec.required ||
      (spec.id === "planner-real" &&
        (requirePlannerReal ||
          Boolean(reports[spec.id]) ||
          Boolean(inputErrors[spec.id])))
  );
  const worktreeReason = getGateWorktreeReason({
    currentGitState,
    targetCommit,
  });
  const worktreeCheck = buildEvaluationEvidenceCheck({
    actual: currentGitState ?? null,
    expected: {
      commitSha: targetCommit,
      dirty: false,
    },
    id: "gate-worktree",
    reasonCode: worktreeReason,
    reportType: "repository",
  });
  const reportChecks = reportSpecs.map((spec) => {
    const report = reports[spec.id] ?? null;
    const inputError = inputErrors[spec.id] ?? null;
    const suiteValidation = validateCurrentQualitySuiteReport({
      corpusContract: expectedCorpusContracts[spec.id] ?? null,
      report,
      specId: spec.id,
    });
    const reportPassed =
      suiteValidation.contractErrors.length === 0 &&
      suiteValidation.integrityErrors.length === 0 &&
      suiteValidation.resultPassed &&
      isCurrentQualityReportPassing({
        report,
        spec,
      });
    const evidenceReasonCode = inputError
      ? CURRENT_QUALITY_REASON_CODES.invalidReport
      : getEvaluationEvidenceFailureReason({
          expectedCorpusHash: expectedCorpusHashes[spec.id],
          maxAgeHours,
          nowMs,
          report,
          reportPassed,
          spec,
          targetCommit,
        });
    const reasonCode =
      evidenceReasonCode === CURRENT_QUALITY_REASON_CODES.reportFailed &&
      suiteValidation.contractErrors.length > 0
        ? CURRENT_QUALITY_REASON_CODES.suiteContractMismatch
        : evidenceReasonCode === CURRENT_QUALITY_REASON_CODES.reportFailed &&
            suiteValidation.integrityErrors.length > 0
          ? CURRENT_QUALITY_REASON_CODES.reportIntegrityFailed
          : evidenceReasonCode;

    return buildEvaluationEvidenceCheck({
      actual: inputError
        ? inputError
        : report
          ? {
              ...toEvaluationEvidenceActualSummary(report),
              suite: {
                contractErrors: suiteValidation.contractErrors,
                integrityErrors: suiteValidation.integrityErrors,
                ...suiteValidation.actual,
              },
            }
          : null,
      expected: {
        commitSha: targetCommit,
        corpus: spec.corpus ?? null,
        corpusContentHash: expectedCorpusHashes[spec.id] ?? null,
        maxAgeHours,
        modelRouteId: spec.modelRouteId,
        providerId: spec.providerId,
        providerMode: spec.providerMode,
        profile: spec.profile,
        reportId: spec.reportId ?? spec.id,
        reportType: spec.reportType,
        suite: suiteValidation.expected,
      },
      id: spec.id,
      reasonCode,
      report,
      reportType: spec.reportType,
    });
  });
  const supplementalInputChecks = Object.entries(inputErrors)
    .filter(
      ([id]) => !reportSpecs.some((spec) => spec.id === id)
    )
    .map(([id, inputError]) =>
      buildEvaluationEvidenceCheck({
        actual: inputError,
        expected: {
          validJson: true,
        },
        id,
        reasonCode: CURRENT_QUALITY_REASON_CODES.invalidReport,
        reportType: "input",
      })
    );
  const baselineRunId = history.regressionGate?.baselineRunId ?? null;
  const baselineSelection =
    history.regressionGate?.baselineSelection ?? null;
  const baselineRun = (history.runs ?? []).find(
    (run) => run.runId === baselineRunId
  );
  const baselineValid =
    baselineRunId === CURRENT_QUALITY_BASELINE_RUN_ID &&
    baselineRun?.status === "ok" &&
    baselineSelection?.strategy === "same_corpus_same_profile" &&
    baselineSelection?.profileMatched === true;
  const baselineCheck = buildEvaluationEvidenceCheck({
    actual: {
      runId: baselineRunId,
      selection: baselineSelection,
      status: baselineRun?.status ?? "unknown",
    },
    expected: {
      profileMatched: true,
      runId: CURRENT_QUALITY_BASELINE_RUN_ID,
      status: "ok",
      strategy: "same_corpus_same_profile",
    },
    id: "quality-baseline",
    reasonCode: baselineValid
      ? CURRENT_QUALITY_REASON_CODES.ok
      : CURRENT_QUALITY_REASON_CODES.wrongBaseline,
    reportType: "baseline",
  });
  const metricDecision = buildQualityGateDecision({
    allowUnknown: false,
    failOnWarn,
    history,
  });
  const evidenceChecks = [
    worktreeCheck,
    ...reportChecks,
    ...supplementalInputChecks,
    baselineCheck,
  ];
  const currentEvidenceVerified = evidenceChecks.every(
    (check) => check.status === "pass"
  );
  const metricStatus = currentEvidenceVerified
    ? metricDecision.status
    : "unverified";
  const metricSummary = currentEvidenceVerified
    ? metricDecision.summary
    : "Metric result withheld because current evidence validation failed.";
  const metricReason = !currentEvidenceVerified
    ? CURRENT_QUALITY_REASON_CODES.qualityMetricsUnverified
    : metricDecision.passed
      ? CURRENT_QUALITY_REASON_CODES.ok
      : CURRENT_QUALITY_REASON_CODES.qualityMetricsFailed;
  const metricCheck = buildEvaluationEvidenceCheck({
    actual: {
      diagnosticStatus: metricDecision.status,
      diagnosticSummary: metricDecision.summary,
      status: metricStatus,
      summary: metricSummary,
    },
    expected: {
      failOnWarn,
      status: "pass",
    },
    id: "quality-metrics",
    reasonCode: metricReason,
    reportType: "aggregate",
  });
  const checks = [...evidenceChecks, metricCheck];
  const failedChecks = checks.filter((check) => check.status === "fail");

  return {
    summary: {
      status: failedChecks.length === 0 ? "pass" : "fail",
      reasonCode:
        failedChecks[0]?.reasonCode ?? CURRENT_QUALITY_REASON_CODES.ok,
      generatedAt: new Date(nowMs).toISOString(),
      targetCommit,
      maxAgeHours,
      checkCount: checks.length,
      failedCheckCount: failedChecks.length,
    },
    currentEvidence: {
      label: "current_commit_evidence",
      requiredReportIds: CURRENT_QUALITY_REPORT_SPECS.filter(
        (spec) => spec.required
      ).map((spec) => spec.id),
      validatedReportIds: reportSpecs.map((spec) => spec.id),
      plannerRealRequired: requirePlannerReal,
    },
    metricGate: {
      label: "current_metrics_pinned_baseline",
      ...metricDecision,
      currentEvidenceVerified,
      diagnosticStatus: metricDecision.status,
      diagnosticSummary: metricDecision.summary,
      status: metricStatus,
      passed: currentEvidenceVerified && metricDecision.passed,
      summary: metricSummary,
      currentRunId: history.latestRun?.runId ?? null,
      baselineRunId: history.regressionGate?.baselineRunId ?? null,
      robustSuiteCurrentEvidence: false,
    },
    checks,
    failedChecks,
  };
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

export const formatCurrentQualityGateMarkdown = (report = {}) => {
  const summary = report.summary ?? {};
  const lines = [
    "# Current Quality Gate",
    "",
    `- Status: \`${summary.status ?? "unknown"}\``,
    `- Reason code: \`${summary.reasonCode ?? "unknown"}\``,
    `- Target commit: \`${summary.targetCommit ?? "unknown"}\``,
    `- Generated at: \`${summary.generatedAt ?? "unknown"}\``,
    `- Max age: \`${summary.maxAgeHours ?? "unknown"} hours\``,
    `- Metrics: \`${report.metricGate?.status ?? "unknown"}\``,
    "- Only the pinned deterministic baseline is accepted; robust/release evidence is not claimed by this gate.",
    "",
    "## Checks",
    "",
    "| Check | Status | Reason code | Type | Run ID | Generated at | Commit | Expected | Actual |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const check of report.checks ?? []) {
    lines.push(
      `| ${formatValue(check.id)} | ${formatValue(
        check.status
      )} | ${formatValue(check.reasonCode)} | ${formatValue(
        check.reportType
      )} | ${formatValue(check.runId)} | ${formatValue(
        check.generatedAt
      )} | ${formatValue(check.commitSha)} | ${formatValue(
        check.expected
      )} | ${formatValue(check.actual)} |`
    );
  }

  return `${lines.join("\n").trim()}\n`;
};

export const writeCurrentQualityGateReport = async ({
  outputDirectory = resultsDirectory,
  report,
} = {}) => {
  await mkdir(outputDirectory, { recursive: true });

  const jsonPath = path.join(
    outputDirectory,
    LATEST_CURRENT_QUALITY_GATE_JSON
  );
  const markdownPath = path.join(
    outputDirectory,
    LATEST_CURRENT_QUALITY_GATE_MD
  );

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    formatCurrentQualityGateMarkdown(report),
    "utf8"
  );

  return {
    jsonPath,
    markdownPath,
  };
};

export const getCurrentQualityGateExitCode = (report = {}) =>
  report.summary?.status === "pass" ? 0 : 1;
