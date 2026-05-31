import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const latestResultPath = path.join(__dirname, "results", "latest.json");

const toPercent = (value) =>
  typeof value === "number" ? Number((value * 100).toFixed(1)) : null;

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

export const readLatestQualityReport = async () => {
  let payload = null;

  try {
    payload = JSON.parse(await readFile(latestResultPath, "utf8"));
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
