import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { robustEvalSuite } from "./eval-suite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultResultsDirectory = path.join(__dirname, "results");

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

export const readLatestRobustPayloads = async ({
  inputDirectory = defaultResultsDirectory,
} = {}) =>
  Promise.all(
    robustEvalSuite.reports.map(async (report) => ({
      reportId: report.id,
      payload: await readOptionalJsonFile(
        path.join(inputDirectory, `${report.latestName}.json`)
      ),
    }))
  );
