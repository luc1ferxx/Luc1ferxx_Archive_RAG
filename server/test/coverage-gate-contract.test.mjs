import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeChildProcessClose } from "./coverage-process-result.mjs";
import { COVERAGE_EVENT_PREFIX } from "./coverage-event-reporter.mjs";
import {
  isTestCoverageRow,
  parseCoverageReport,
  stripStructuredCoverageEvents,
  summarizeCoverageTotals,
  summarizeRows,
} from "./coverage-report-parser.mjs";
import {
  COVERAGE_GROUPS,
  findMissingEnforcedCoverage,
  findMissingGlobalCoverage,
  GLOBAL_COVERAGE_EXCLUDED_PATHS,
  summarizeCoverageGroup,
} from "./coverage-policy.mjs";
import { parseTrackedBackendSourcePaths } from "./coverage-source-inventory.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(testDirectory, "..");

const coverageFile = ({
  filePath,
  total = 10,
  covered = total,
}) => ({
  path: filePath,
  totalLineCount: total,
  totalBranchCount: total,
  totalFunctionCount: total,
  coveredLineCount: covered,
  coveredBranchCount: covered,
  coveredFunctionCount: covered,
});

const coverageOutput = (files, overrides = {}) =>
  `${COVERAGE_EVENT_PREFIX}${JSON.stringify({
    workingDirectory: serverDirectory,
    files,
    ...overrides,
  })}\n`;

test("API routes coverage fails when any tracked route is absent", () => {
  const apiGroup = COVERAGE_GROUPS.find((group) => group.id === "api_routes");
  const expectedPaths = [
    "server/app.js",
    "server/auth.js",
    "server/routes/chat.js",
    "server/routes/documents.js",
  ];
  const observedRows = expectedPaths
    .filter((filePath) => filePath !== "server/routes/documents.js")
    .map((filePath) => ({ filePath }));

  assert.ok(apiGroup, "API routes coverage group must exist");
  assert.deepEqual(
    findMissingEnforcedCoverage({
      expectedPaths,
      observedRows,
      groups: [apiGroup],
    }),
    [
      {
        groupId: "api_routes",
        groupLabel: "API routes",
        filePath: "server/routes/documents.js",
      },
    ]
  );
});

test("tracked source inventory excludes tests and ignores untracked files", () => {
  assert.deepEqual(
    parseTrackedBackendSourcePaths(
      "server/app.js\0server/routes/chat.js\0server/test/app.test.mjs\0README.md\0"
    ),
    ["server/app.js", "server/routes/chat.js"]
  );
});

test("global coverage inventory requires new source unless explicitly excluded", () => {
  const expectedPaths = [
    "server/app.js",
    "server/new-module.js",
    GLOBAL_COVERAGE_EXCLUDED_PATHS[0],
  ];

  assert.deepEqual(
    findMissingGlobalCoverage({
      expectedPaths,
      observedRows: [{ filePath: "server/app.js" }],
    }),
    ["server/new-module.js"]
  );
  assert.equal(
    new Set(GLOBAL_COVERAGE_EXCLUDED_PATHS).size,
    GLOBAL_COVERAGE_EXCLUDED_PATHS.length,
    "global coverage exclusions must be unique"
  );
});

test("coverage child termination by signal is always a failing result", () => {
  assert.deepEqual(
    normalizeChildProcessClose({
      exitCode: null,
      signal: "SIGKILL",
    }),
    {
      exitCode: 1,
      signal: "SIGKILL",
    }
  );
  assert.deepEqual(
    normalizeChildProcessClose({
      exitCode: 7,
      signal: null,
    }),
    {
      exitCode: 7,
      signal: null,
    }
  );
});

test("Node 20 coverage rows exclude tests without changing weighted totals", () => {
  const report = parseCoverageReport(
    coverageOutput([
      coverageFile({
        filePath: path.join(serverDirectory, "app.js"),
        total: 100,
        covered: 50,
      }),
      coverageFile({
        filePath: path.join(serverDirectory, "routes", "chat.js"),
        total: 10,
        covered: 10,
      }),
      coverageFile({
        filePath: path.join(testDirectory, "app.test.mjs"),
        total: 100,
        covered: 100,
      }),
    ])
  );
  const sourceRows = report.rows.filter((row) => !isTestCoverageRow(row));

  assert.deepEqual(report.errors, []);
  assert.deepEqual(
    sourceRows.map((row) => row.filePath),
    ["server/app.js", "server/routes/chat.js"]
  );
  assert.deepEqual(summarizeCoverageTotals(sourceRows), {
    fileCount: 2,
    line: 54.55,
    branch: 54.55,
    funcs: 54.55,
  });
  assert.deepEqual(summarizeRows(sourceRows), {
    fileCount: 2,
    line: 75,
    branch: 75,
    funcs: 75,
  });
  assert.deepEqual(
    summarizeCoverageGroup(sourceRows, {
      id: "weighted",
      label: "Weighted group",
      enforce: true,
      include: [/^server\//],
      minimum: { line: 0, branch: 0, funcs: 0 },
      target: { line: 0, branch: 0, funcs: 0 },
    }),
    {
      id: "weighted",
      label: "Weighted group",
      enforce: true,
      minimum: { line: 0, branch: 0, funcs: 0 },
      target: { line: 0, branch: 0, funcs: 0 },
      fileCount: 2,
      line: 54.55,
      branch: 54.55,
      funcs: 54.55,
    }
  );
});

test("Node 20 and Node 25 structured events produce equal source totals", () => {
  const sourceFiles = [
    coverageFile({
      filePath: path.join(serverDirectory, "app.js"),
      total: 100,
      covered: 50,
    }),
    coverageFile({
      filePath: path.join(serverDirectory, "routes", "chat.js"),
      total: 10,
      covered: 10,
    }),
  ];
  const node20Report = parseCoverageReport(
    coverageOutput([
      ...sourceFiles,
      coverageFile({
        filePath: path.join(testDirectory, "app.test.mjs"),
        total: 100,
        covered: 100,
      }),
    ])
  );
  const node25Report = parseCoverageReport(coverageOutput(sourceFiles));
  const sourceSummary = ({ rows }) =>
    summarizeCoverageTotals(rows.filter((row) => !isTestCoverageRow(row)));

  assert.deepEqual(sourceSummary(node20Report), sourceSummary(node25Report));
});

test("coverage parser canonicalizes relative paths and file URLs", () => {
  const chatFileUrl = pathToFileURL(
    path.join(serverDirectory, "routes", "chat.js")
  ).href;
  const report = parseCoverageReport(
    coverageOutput([
      coverageFile({ filePath: "app.js" }),
      coverageFile({ filePath: chatFileUrl }),
    ])
  );

  assert.deepEqual(report.errors, []);
  assert.deepEqual(
    report.rows.map((row) => row.filePath),
    ["server/app.js", "server/routes/chat.js"]
  );
});

test("unknown or duplicate structured coverage events fail closed", () => {
  assert.deepEqual(parseCoverageReport("coverage output changed").errors, [
    "expected exactly one structured coverage event, found 0",
  ]);

  const event = coverageOutput([coverageFile({ filePath: "app.js" })]);
  assert.deepEqual(parseCoverageReport(`${event}${event}`).errors, [
    "expected exactly one structured coverage event, found 2",
  ]);
});

test("structured coverage payload is hidden from human-readable output", () => {
  const event = coverageOutput([coverageFile({ filePath: "app.js" })]);

  assert.equal(
    stripStructuredCoverageEvents(`before\n${event}after\n`),
    "before\nafter\n"
  );
});

test("coverage parser rejects outside and duplicate canonical paths", () => {
  const absoluteAppPath = path.join(serverDirectory, "app.js");
  const report = parseCoverageReport(
    coverageOutput([
      coverageFile({ filePath: "app.js" }),
      coverageFile({ filePath: absoluteAppPath }),
      coverageFile({ filePath: "../outside.js" }),
    ])
  );

  assert.deepEqual(report.errors, [
    "coverage event contains duplicate path server/app.js",
    "coverage path is outside server/: ../outside.js",
  ]);
});

test("coverage parser rejects malformed counters and payloads", () => {
  const invalidCounts = coverageFile({ filePath: "app.js" });
  invalidCounts.coveredLineCount = invalidCounts.totalLineCount + 1;
  const unsafeCounts = coverageFile({ filePath: "auth.js" });
  unsafeCounts.totalBranchCount = Number.MAX_SAFE_INTEGER + 1;

  assert.deepEqual(
    parseCoverageReport(coverageOutput([invalidCounts])).errors,
    ["coverage event has invalid line counts for server/app.js"]
  );
  assert.deepEqual(
    parseCoverageReport(coverageOutput([], { files: null })).errors,
    ["structured coverage event is missing its files array"]
  );
  assert.deepEqual(
    parseCoverageReport(coverageOutput([unsafeCounts])).errors,
    ["coverage event has invalid branch counts for server/auth.js"]
  );
});
