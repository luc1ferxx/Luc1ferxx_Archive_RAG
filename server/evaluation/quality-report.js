import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const resultsDirectory = path.join(__dirname, "results");
const latestResultPath = path.join(resultsDirectory, "latest.json");
const defaultHistoryLimit = 10;
const statusRank = {
  unknown: 0,
  ok: 1,
  pass: 1,
  warn: 2,
  fail: 3,
};

const regressionMetricChecks = [
  {
    metric: "overallPassRate",
    label: "Overall pass rate",
    warnDrop: 0.02,
    failDrop: 0.05,
  },
  {
    metric: "qaPageHitRate",
    label: "QA page hit rate",
    warnDrop: 0.05,
    failDrop: 0.1,
  },
  {
    metric: "comparePageHitRate",
    label: "Compare page hit rate",
    warnDrop: 0.05,
    failDrop: 0.1,
  },
  {
    metric: "averageCitationCount",
    label: "Average citations",
    warnDrop: 0.5,
    failDrop: 1,
  },
];

const toPercent = (value) =>
  typeof value === "number" ? Number((value * 100).toFixed(1)) : null;

const getWorstStatus = (statuses = []) =>
  statuses.reduce((worstStatus, status) => {
    const normalizedStatus = status ?? "unknown";

    return (statusRank[normalizedStatus] ?? 0) > (statusRank[worstStatus] ?? 0)
      ? normalizedStatus
      : worstStatus;
  }, "unknown");

const getCorpusName = (corpusPath) => {
  if (!corpusPath) {
    return null;
  }

  return String(corpusPath).split(/[\\/]/).pop() ?? corpusPath;
};

const toTimestamp = (createdAt) => {
  const parsed = Date.parse(createdAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

const isQualityResultFile = (fileName) =>
  fileName.endsWith(".json") &&
  !fileName.startsWith("latest") &&
  !fileName.includes("ragas");

const readJsonFile = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const getFailedReasons = (caseResult = {}) => {
  const reasons = [];

  if (!caseResult.shouldAbstain && caseResult.abstained) {
    reasons.push("Unexpected abstain");
  }

  if (caseResult.shouldAbstain && !caseResult.abstained) {
    reasons.push("Expected abstain was missed");
  }

  if (!caseResult.docCoverageHit) {
    reasons.push("Document coverage missed");
  }

  if (!caseResult.pageCoverageHit) {
    reasons.push("Page coverage missed");
  }

  if (!caseResult.answerExpectationHit) {
    reasons.push("Answer expectation missed");
  }

  return reasons.length > 0 ? reasons : ["Case failed"];
};

const buildFailedCases = (cases = []) =>
  cases
    .filter((caseResult) => !caseResult.passed)
    .map((caseResult) => ({
      id: caseResult.id,
      type: caseResult.type,
      question: caseResult.question,
      answer: caseResult.answer,
      citationCount: caseResult.citationCount ?? 0,
      responseTimeMs: caseResult.responseTimeMs ?? null,
      reasons: getFailedReasons(caseResult),
      citations: caseResult.citations ?? [],
    }));

const buildRecommendations = ({ metrics = {}, failedCases = [] }) => {
  const recommendations = [];
  const failedReasonText = failedCases
    .flatMap((caseResult) => caseResult.reasons)
    .join(" ")
    .toLowerCase();

  if ((metrics.overallPassRate ?? 1) < 0.9) {
    recommendations.push({
      label: "Review failed cases before adding more features",
      detail: "Overall pass rate is below 90%, so retrieval or answer grounding needs attention.",
    });
  }

  if (
    (metrics.qaPageHitRate ?? 1) < 0.9 ||
    (metrics.comparePageHitRate ?? 1) < 0.9 ||
    failedReasonText.includes("page coverage")
  ) {
    recommendations.push({
      label: "Tune retrieval breadth",
      detail: "Page coverage misses usually mean increasing retrieval topK, enabling rerank, or adjusting chunk overlap.",
    });
  }

  if (
    (metrics.compareDocCoverageRate ?? 1) < 0.9 ||
    failedReasonText.includes("document coverage")
  ) {
    recommendations.push({
      label: "Inspect multi-document retrieval balance",
      detail: "Document coverage misses point to compare topK-per-doc, hybrid retrieval, or per-document evidence alignment.",
    });
  }

  if ((metrics.abstainAccuracy ?? 1) < 1) {
    recommendations.push({
      label: "Tighten abstain confidence gates",
      detail: "Abstain misses indicate the confidence gate should be stricter for unsupported or cross-document questions.",
    });
  }

  if ((metrics.averageCitationCount ?? 0) < 1) {
    recommendations.push({
      label: "Require stronger citation coverage",
      detail: "Average citation count below one means answers may not be reliably grounded.",
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      label: "Quality gate is healthy",
      detail: "No immediate retrieval or grounding tuning is suggested by the latest synthetic run.",
    });
  }

  return recommendations;
};

const getStatus = ({ metrics = {}, failedCases = [] }) => {
  if (failedCases.length === 0 && (metrics.overallPassRate ?? 0) >= 0.99) {
    return "ok";
  }

  if ((metrics.overallPassRate ?? 0) >= 0.8) {
    return "warn";
  }

  return "fail";
};

export const buildQualityReportFromResultPayload = (payload = {}) => {
  const summary = payload.summary ?? {};
  const metrics = summary.metrics ?? {};
  const failedCases = buildFailedCases(payload.cases ?? []);

  return {
    status: getStatus({
      metrics,
      failedCases,
    }),
    summary: {
      runId: summary.runId ?? null,
      createdAt: summary.createdAt ?? null,
      corpus: summary.corpus ?? null,
      models: summary.models ?? null,
      config: summary.config ?? null,
      metrics: {
        ...metrics,
        overallPassPercent: toPercent(metrics.overallPassRate),
        qaPageHitPercent: toPercent(metrics.qaPageHitRate),
        compareDocCoveragePercent: toPercent(metrics.compareDocCoverageRate),
        comparePageHitPercent: toPercent(metrics.comparePageHitRate),
        abstainAccuracyPercent: toPercent(metrics.abstainAccuracy),
      },
    },
    failedCases,
    recommendations: buildRecommendations({
      metrics,
      failedCases,
    }),
  };
};

export const buildQualityRunSummary = ({ fileName = null, payload = {} } = {}) => {
  if (!payload?.summary?.metrics) {
    return null;
  }

  const report = buildQualityReportFromResultPayload(payload);
  const summary = report.summary ?? {};
  const corpus = summary.corpus ?? null;

  return {
    runId:
      summary.runId ??
      (fileName ? fileName.replace(/\.json$/i, "") : "unknown-run"),
    createdAt: summary.createdAt ?? null,
    fileName,
    status: report.status,
    corpus: corpus
      ? {
          ...corpus,
          name: getCorpusName(corpus.path),
        }
      : null,
    models: summary.models ?? null,
    config: summary.config ?? null,
    metrics: summary.metrics ?? {},
    failedCaseCount: report.failedCases.length,
    caseCount: Array.isArray(payload.cases)
      ? payload.cases.length
      : corpus?.cases ?? null,
  };
};

const buildRegressionMetricCheck = ({ baselineRun, currentRun, definition }) => {
  const baselineValue = baselineRun.metrics?.[definition.metric];
  const currentValue = currentRun.metrics?.[definition.metric];

  if (typeof baselineValue !== "number" || typeof currentValue !== "number") {
    return {
      metric: definition.metric,
      label: definition.label,
      status: "unknown",
      baselineValue: baselineValue ?? null,
      currentValue: currentValue ?? null,
      delta: null,
    };
  }

  const delta = Number((currentValue - baselineValue).toFixed(4));
  const status =
    delta <= -definition.failDrop
      ? "fail"
      : delta <= -definition.warnDrop
        ? "warn"
        : "pass";

  return {
    metric: definition.metric,
    label: definition.label,
    status,
    baselineValue,
    currentValue,
    delta,
    warnDrop: definition.warnDrop,
    failDrop: definition.failDrop,
  };
};

const buildFailedCaseCheck = ({ baselineRun, currentRun }) => {
  const baselineValue = baselineRun.failedCaseCount ?? 0;
  const currentValue = currentRun.failedCaseCount ?? 0;
  const delta = currentValue - baselineValue;
  const status = delta >= 2 ? "fail" : delta >= 1 ? "warn" : "pass";

  return {
    metric: "failedCaseCount",
    label: "Failed cases",
    status,
    baselineValue,
    currentValue,
    delta,
    warnIncrease: 1,
    failIncrease: 2,
  };
};

export const buildRegressionGate = ({ baselineRun = null, currentRun = null } = {}) => {
  if (!currentRun) {
    return {
      status: "unknown",
      currentRunId: null,
      baselineRunId: null,
      checks: [],
      summary: "No synthetic evaluation run is available yet.",
    };
  }

  if (!baselineRun) {
    return {
      status: "unknown",
      currentRunId: currentRun.runId,
      baselineRunId: null,
      checks: [],
      summary: "No previous synthetic run is available for regression comparison.",
    };
  }

  const checks = [
    ...regressionMetricChecks.map((definition) =>
      buildRegressionMetricCheck({
        baselineRun,
        currentRun,
        definition,
      })
    ),
    buildFailedCaseCheck({
      baselineRun,
      currentRun,
    }),
  ];
  const status = getWorstStatus(checks.map((check) => check.status));
  const summary =
    status === "fail"
      ? "Regression detected against the previous synthetic run."
      : status === "warn"
        ? "Possible quality regression detected against the previous synthetic run."
        : "No regression detected against the previous synthetic run.";

  return {
    status,
    currentRunId: currentRun.runId,
    baselineRunId: baselineRun.runId,
    baselineCreatedAt: baselineRun.createdAt,
    checks,
    summary,
  };
};

export const buildQualityHistoryResponse = ({
  latestPayload = null,
  limit = defaultHistoryLimit,
  runPayloads = [],
} = {}) => {
  const runSummaries = runPayloads
    .map((entry) =>
      buildQualityRunSummary({
        fileName: entry.fileName,
        payload: entry.payload,
      })
    )
    .filter(Boolean)
    .sort((left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt));
  const latestRun = latestPayload
    ? buildQualityRunSummary({
        fileName: "latest.json",
        payload: latestPayload,
      })
    : runSummaries[0] ?? null;
  const combinedRuns =
    latestRun && !runSummaries.some((run) => run.runId === latestRun.runId)
      ? [latestRun, ...runSummaries]
      : runSummaries;
  const sortedRuns = combinedRuns.sort(
    (left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt)
  );
  const currentRun = latestRun ?? sortedRuns[0] ?? null;
  const baselineRun =
    sortedRuns.find((run) => run.runId !== currentRun?.runId) ?? null;
  const regressionGate = buildRegressionGate({
    baselineRun,
    currentRun,
  });

  return {
    status: regressionGate.status,
    latestRun: currentRun,
    runs: sortedRuns.slice(0, limit),
    regressionGate,
  };
};

export const readLatestQualityReport = async () => {
  let payload = null;

  try {
    payload = await readJsonFile(latestResultPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      const missingError = new Error("No synthetic evaluation report exists yet.");
      missingError.status = 404;
      throw missingError;
    }

    throw error;
  }

  return buildQualityReportFromResultPayload(payload);
};

export const readQualityHistory = async ({ limit = defaultHistoryLimit } = {}) => {
  let latestPayload = null;

  try {
    latestPayload = await readJsonFile(latestResultPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  let fileNames = [];

  try {
    fileNames = await readdir(resultsDirectory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return buildQualityHistoryResponse({
        latestPayload,
        limit,
        runPayloads: [],
      });
    }

    throw error;
  }

  const runPayloads = (
    await Promise.all(
      fileNames.filter(isQualityResultFile).map(async (fileName) => {
        try {
          return {
            fileName,
            payload: await readJsonFile(path.join(resultsDirectory, fileName)),
          };
        } catch (error) {
          console.warn(`Skipping unreadable quality result ${fileName}.`, error);
          return null;
        }
      })
    )
  ).filter(Boolean);

  return buildQualityHistoryResponse({
    latestPayload,
    limit,
    runPayloads,
  });
};

export const runSyntheticQualityEvaluation = async ({ corpusPath = "" } = {}) => {
  const args = ["evaluation/run-synthetic-eval.mjs"];

  if (corpusPath) {
    args.push(corpusPath);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: serverDirectory,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];

    child.stderr.on("data", (chunk) => {
      stderr.push(chunk.toString("utf8"));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error(
        `Synthetic evaluation failed with exit code ${code}: ${stderr.join("").slice(-1200)}`
      );
      error.status = 500;
      reject(error);
    });
  });

  return readLatestQualityReport();
};
