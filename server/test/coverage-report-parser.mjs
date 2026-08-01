import path from "node:path";
import { fileURLToPath } from "node:url";
import { COVERAGE_EVENT_PREFIX } from "./coverage-event-reporter.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultServerDirectory = path.resolve(testDirectory, "..");

const metricDefinitions = [
  {
    name: "line",
    totalKey: "totalLineCount",
    coveredKey: "coveredLineCount",
  },
  {
    name: "branch",
    totalKey: "totalBranchCount",
    coveredKey: "coveredBranchCount",
  },
  {
    name: "funcs",
    totalKey: "totalFunctionCount",
    coveredKey: "coveredFunctionCount",
  },
];

const round = (value) =>
  Number.isFinite(value) ? Number(value.toFixed(2)) : null;

const percentage = (covered, total) => {
  if (!Number.isFinite(covered) || !Number.isFinite(total) || total < 0) {
    return null;
  }

  return total === 0 ? 100 : round((covered / total) * 100);
};

const average = (values) => {
  const safeValues = values.filter((value) => Number.isFinite(value));

  if (safeValues.length === 0) {
    return null;
  }

  return round(
    safeValues.reduce((sum, value) => sum + value, 0) / safeValues.length
  );
};

const normalizeCoveragePath = (rawFilePath, serverDirectory) => {
  if (typeof rawFilePath !== "string" || !rawFilePath || rawFilePath.includes("\0")) {
    throw new Error("coverage path is empty or contains a NUL byte");
  }

  let absolutePath;

  if (rawFilePath.startsWith("file:")) {
    absolutePath = fileURLToPath(rawFilePath);
  } else {
    const portablePath = rawFilePath.replaceAll("\\", "/");

    if (path.isAbsolute(portablePath)) {
      absolutePath = path.resolve(portablePath);
    } else if (portablePath.startsWith("server/")) {
      absolutePath = path.resolve(path.dirname(serverDirectory), portablePath);
    } else {
      absolutePath = path.resolve(serverDirectory, portablePath);
    }
  }

  const relativePath = path.relative(serverDirectory, absolutePath);

  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`coverage path is outside server/: ${rawFilePath}`);
  }

  return `server/${relativePath.split(path.sep).join("/")}`;
};

const parseCoverageFile = (file, serverDirectory) => {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("coverage event contains a non-object file entry");
  }

  const filePath = normalizeCoveragePath(file.path, serverDirectory);
  const row = { filePath };

  for (const definition of metricDefinitions) {
    const total = file[definition.totalKey];
    const covered = file[definition.coveredKey];

    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      !Number.isSafeInteger(covered) ||
      covered < 0 ||
      covered > total
    ) {
      throw new Error(
        `coverage event has invalid ${definition.name} counts for ${filePath}`
      );
    }

    row[definition.totalKey] = total;
    row[definition.coveredKey] = covered;
    row[definition.name] = percentage(covered, total);
  }

  return row;
};

export const summarizeCoverageTotals = (rows) => {
  if (rows.length === 0) {
    return {
      fileCount: 0,
      line: null,
      branch: null,
      funcs: null,
    };
  }

  const summary = {
    fileCount: rows.length,
  };

  for (const definition of metricDefinitions) {
    const total = rows.reduce(
      (sum, row) => sum + row[definition.totalKey],
      0
    );
    const covered = rows.reduce(
      (sum, row) => sum + row[definition.coveredKey],
      0
    );

    summary[definition.name] = percentage(covered, total);
  }

  return summary;
};

export const parseCoverageReport = (
  output,
  { serverDirectory = defaultServerDirectory } = {}
) => {
  const rows = [];
  const errors = [];
  const seenPaths = new Set();
  const eventLines = output
    .split(/\r?\n/g)
    .filter((line) => line.startsWith(COVERAGE_EVENT_PREFIX));

  if (eventLines.length !== 1) {
    errors.push(
      `expected exactly one structured coverage event, found ${eventLines.length}`
    );
    return {
      rows,
      allFilesSummary: summarizeCoverageTotals(rows),
      errors,
    };
  }

  let payload;
  try {
    payload = JSON.parse(eventLines[0].slice(COVERAGE_EVENT_PREFIX.length));
  } catch {
    errors.push("structured coverage event is not valid JSON");
    return {
      rows,
      allFilesSummary: summarizeCoverageTotals(rows),
      errors,
    };
  }

  if (
    typeof payload?.workingDirectory !== "string" ||
    path.resolve(payload.workingDirectory) !== path.resolve(serverDirectory)
  ) {
    errors.push("structured coverage event has an unexpected working directory");
  }

  if (!Array.isArray(payload?.files)) {
    errors.push("structured coverage event is missing its files array");
    return {
      rows,
      allFilesSummary: summarizeCoverageTotals(rows),
      errors,
    };
  }

  for (const file of payload.files) {
    try {
      const row = parseCoverageFile(file, serverDirectory);

      if (seenPaths.has(row.filePath)) {
        errors.push(`coverage event contains duplicate path ${row.filePath}`);
        continue;
      }

      seenPaths.add(row.filePath);
      rows.push(row);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    rows,
    allFilesSummary: summarizeCoverageTotals(rows),
    errors,
  };
};

export const stripStructuredCoverageEvents = (output) =>
  output
    .split(/\r?\n/g)
    .filter((line) => !line.startsWith(COVERAGE_EVENT_PREFIX))
    .join("\n");

export const isTestCoverageRow = (row) =>
  /^server\/test\//.test(row.filePath) ||
  /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(row.filePath);

export const summarizeRows = (rows) => ({
  fileCount: rows.length,
  line: average(rows.map((row) => row.line)),
  branch: average(rows.map((row) => row.branch)),
  funcs: average(rows.map((row) => row.funcs)),
});
