import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { robustEvalSuite } from "./eval-suite.js";
import { defaultHistoryLimit } from "./quality-shared.js";
import { buildQualityReportFromResultPayload } from "./quality-run-summary.js";
import { buildQualityHistoryResponse } from "./quality-combined-gate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const resultsDirectory = path.join(__dirname, "results");
const latestResultPath = path.join(resultsDirectory, "latest.json");
const latestFeedbackResultPath = path.join(resultsDirectory, "latest-feedback.json");
const latestTrajectoryResultPath = path.join(resultsDirectory, "latest-trajectory.json");
const latestPlannerResultPath = path.join(resultsDirectory, "latest-planner.json");
const latestRecoveryObservabilityResultPath = path.join(
  resultsDirectory,
  "latest-recovery-observability.json"
);
const latestPlannerProviderResultPaths = [
  path.join(resultsDirectory, "latest-planner-mock.json"),
  path.join(resultsDirectory, "latest-planner-real.json"),
];
const latestRobustSuiteResultPaths = robustEvalSuite.reports.map((report) => ({
  reportId: report.id,
  filePath: path.join(resultsDirectory, `${report.latestName}.json`),
}));

const isQualityResultFile = (fileName) =>
  fileName.endsWith(".json") &&
  !fileName.startsWith("latest") &&
  !fileName.includes("ragas");

const readJsonFile = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const readOptionalJsonFile = async (filePath) => {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const readLatestPlannerPayloads = async () => {
  const providerPayloads = (
    await Promise.all(latestPlannerProviderResultPaths.map(readOptionalJsonFile))
  ).filter(Boolean);

  if (providerPayloads.length > 0) {
    return providerPayloads;
  }

  const legacyPayload = await readOptionalJsonFile(latestPlannerResultPath);
  return legacyPayload ? [legacyPayload] : [];
};

const readLatestRobustPayloads = async () =>
  Promise.all(
    latestRobustSuiteResultPaths.map(async ({ filePath, reportId }) => ({
      reportId,
      payload: await readOptionalJsonFile(filePath),
    }))
  );

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

export const readQualityHistory = async ({
  limit = defaultHistoryLimit,
  requireRobustSuite = false,
} = {}) => {
  let latestPayload = null;
  let latestFeedbackPayload = null;
  let latestPlannerPayloads = [];
  let latestRecoveryPayload = null;
  let latestRobustPayloads = [];
  let latestTrajectoryPayload = null;

  try {
    latestPayload = await readJsonFile(latestResultPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    latestFeedbackPayload = await readJsonFile(latestFeedbackResultPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    latestTrajectoryPayload = await readJsonFile(latestTrajectoryResultPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  latestPlannerPayloads = await readLatestPlannerPayloads();
  latestRobustPayloads = await readLatestRobustPayloads();

  try {
    latestRecoveryPayload = await readJsonFile(latestRecoveryObservabilityResultPath);
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
        latestFeedbackPayload,
        latestPlannerPayloads,
        latestRecoveryPayload,
        latestRobustPayloads,
        latestTrajectoryPayload,
        limit,
        requireRobustSuite,
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
    latestFeedbackPayload,
    latestPlannerPayloads,
    latestRecoveryPayload,
    latestRobustPayloads,
    latestTrajectoryPayload,
    limit,
    requireRobustSuite,
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
