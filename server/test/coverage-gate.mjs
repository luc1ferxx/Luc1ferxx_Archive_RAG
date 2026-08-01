#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeChildProcessClose } from "./coverage-process-result.mjs";
import {
  isTestCoverageRow,
  parseCoverageReport,
  stripStructuredCoverageEvents,
  summarizeCoverageTotals,
} from "./coverage-report-parser.mjs";
import {
  COVERAGE_GROUPS,
  findMissingEnforcedCoverage,
  findMissingGlobalCoverage,
  GLOBAL_COVERAGE_EXCLUDED_PATHS,
  GLOBAL_GATE,
  isGlobalCoverageSourcePath,
  isReportOnlyCoverageRow,
  summarizeCoverageGroup,
} from "./coverage-policy.mjs";
import { collectTrackedBackendSourcePaths } from "./coverage-source-inventory.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const repositoryDirectory = path.dirname(serverDirectory);
const testDirectory = path.join(serverDirectory, "test");
const coverageReporterPath = path.join(
  testDirectory,
  "coverage-event-reporter.mjs"
);

const parseArgs = () => {
  const args = new Set(process.argv.slice(2));

  return {
    strictTargets: args.has("--strict-targets"),
    help: args.has("--help") || args.has("-h"),
  };
};

const usage = `Usage: npm run coverage:gate -- [options]

Runs backend tests with Node's built-in coverage reporter and checks tiered
coverage gates.

Options:
  --strict-targets  Fail when aspirational targets are missed, not just minimum gates.
  --help            Show this message.
`;

const TEST_FILE_EXCLUDES = new Set([
  "run.test.mjs",
]);

const formatPercent = (value) =>
  Number.isFinite(value) ? `${value.toFixed(2)}%` : "N/A";

const collectTestFiles = async () => {
  const entries = await readdir(testDirectory, {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (fileName) =>
        fileName.endsWith(".test.mjs") && !TEST_FILE_EXCLUDES.has(fileName)
    )
    .sort()
    .map((fileName) => path.join("test", fileName));
};

const runCoverage = async (testFiles) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--test",
        "--experimental-test-coverage",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-reporter=${coverageReporterPath}`,
        "--test-reporter-destination=stdout",
        ...testFiles,
      ],
      {
        cwd: serverDirectory,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("close", (exitCode, signal) => {
      const visibleStdout = stripStructuredCoverageEvents(stdout);
      if (visibleStdout) {
        process.stdout.write(visibleStdout);
      }
      resolve({
        ...normalizeChildProcessClose({ exitCode, signal }),
        output: `${stdout}\n${stderr}`,
      });
    });
  });

const summarizeGlobalCoverage = ({ rows, strictTargets }) => {
  const includedRows = strictTargets
    ? rows.filter((row) => !isReportOnlyCoverageRow(row))
    : rows;

  return summarizeCoverageTotals(includedRows);
};

const metricEntries = [
  ["line", "Line"],
  ["branch", "Branch"],
  ["funcs", "Funcs"],
];

const collectFailures = (summary, thresholds) => {
  const failures = [];

  if (!Number.isInteger(summary.fileCount) || summary.fileCount < 1) {
    failures.push({
      metric: "Files",
      actual: summary.fileCount ?? 0,
      expected: 1,
    });
  }

  failures.push(
    ...metricEntries
      .filter(
        ([key]) =>
          !Number.isFinite(summary[key]) || summary[key] < thresholds[key]
      )
      .map(([key, label]) => ({
        metric: label,
        actual: summary[key],
        expected: thresholds[key],
      }))
  );

  return failures;
};

const renderGateRow = ({ label, summary, thresholds, enforced }) => {
  const failures = collectFailures(summary, thresholds);
  const status = failures.length === 0
    ? "pass"
    : enforced
      ? "fail"
      : "warn";

  return [
    label.padEnd(26),
    String(summary.fileCount ?? 0).padStart(3),
    formatPercent(summary.line).padStart(9),
    `${formatPercent(thresholds.line)}`.padStart(9),
    formatPercent(summary.branch).padStart(9),
    `${formatPercent(thresholds.branch)}`.padStart(9),
    formatPercent(summary.funcs).padStart(9),
    `${formatPercent(thresholds.funcs)}`.padStart(9),
    status,
  ].join("  ");
};

const renderSummary = ({ globalSummary, groupSummaries, strictTargets }) => {
  const lines = [
    "",
    "Coverage gates",
    "Group                       N       Line       Min    Branch       Min     Funcs       Min  Status",
    "-----------------------------------------------------------------------------------------------",
    renderGateRow({
      label: GLOBAL_GATE.label,
      summary: globalSummary,
      thresholds: strictTargets ? GLOBAL_GATE.target : GLOBAL_GATE.minimum,
      enforced: GLOBAL_GATE.enforce,
    }),
  ];

  for (const groupSummary of groupSummaries) {
    const thresholds = strictTargets ? groupSummary.target : groupSummary.minimum;

    lines.push(
      renderGateRow({
        label: groupSummary.label,
        summary: groupSummary,
        thresholds,
        enforced: groupSummary.enforce,
      })
    );
  }

  if (!strictTargets) {
    lines.push(
      "",
      "Targets",
      "Group                       N       Line    Target    Branch    Target     Funcs    Target  Status",
      "-----------------------------------------------------------------------------------------------",
      renderGateRow({
        label: GLOBAL_GATE.label,
        summary: globalSummary,
        thresholds: GLOBAL_GATE.target,
        enforced: false,
      })
    );

    for (const groupSummary of groupSummaries) {
      lines.push(
        renderGateRow({
          label: groupSummary.label,
          summary: groupSummary,
          thresholds: groupSummary.target,
          enforced: false,
        })
      );
    }
  }

  return lines.join("\n");
};

const main = async () => {
  const options = parseArgs();

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const testFiles = await collectTestFiles();
  const coverageResult = await runCoverage(testFiles);

  if (coverageResult.exitCode !== 0) {
    if (coverageResult.signal) {
      console.error(
        `Coverage test process terminated by signal ${coverageResult.signal}.`
      );
    }
    process.exitCode = coverageResult.exitCode;
    return;
  }

  const { rows, errors } = parseCoverageReport(coverageResult.output, {
    serverDirectory,
  });

  if (errors.length > 0) {
    console.error("Coverage report parsing failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const sourceRows = rows.filter((row) => !isTestCoverageRow(row));
  const trackedSourcePaths = await collectTrackedBackendSourcePaths({
    repositoryDirectory,
  });
  const trackedSourceSet = new Set(trackedSourcePaths);
  const staleGlobalExclusions = GLOBAL_COVERAGE_EXCLUDED_PATHS.filter(
    (filePath) => !trackedSourceSet.has(filePath)
  );
  const unexpectedSourcePaths = sourceRows
    .map((row) => row.filePath)
    .filter((filePath) => !trackedSourceSet.has(filePath));
  const missingEnforcedCoverage = findMissingEnforcedCoverage({
    expectedPaths: trackedSourcePaths,
    observedRows: sourceRows,
  });
  const missingEnforcedPaths = new Set(
    missingEnforcedCoverage.map((missing) => missing.filePath)
  );
  const missingGlobalCoverage = findMissingGlobalCoverage({
    expectedPaths: trackedSourcePaths,
    observedRows: sourceRows,
  }).filter((filePath) => !missingEnforcedPaths.has(filePath));

  if (
    unexpectedSourcePaths.length > 0 ||
    staleGlobalExclusions.length > 0 ||
    missingEnforcedCoverage.length > 0 ||
    missingGlobalCoverage.length > 0
  ) {
    console.error("Coverage source inventory failed:");
    for (const filePath of unexpectedSourcePaths) {
      console.error(`- untracked source appeared in coverage: ${filePath}`);
    }
    for (const filePath of staleGlobalExclusions) {
      console.error(`- stale global coverage exclusion: ${filePath}`);
    }
    for (const missing of missingEnforcedCoverage) {
      console.error(
        `- ${missing.groupLabel} is missing tracked source: ${missing.filePath}`
      );
    }
    for (const filePath of missingGlobalCoverage) {
      console.error(`- Global backend is missing tracked source: ${filePath}`);
    }
    process.exitCode = 1;
    return;
  }

  const globalCoverageRows = sourceRows.filter((row) =>
    isGlobalCoverageSourcePath(row.filePath)
  );
  const globalSummary = summarizeGlobalCoverage({
    rows: globalCoverageRows,
    strictTargets: options.strictTargets,
  });
  const groupSummaries = COVERAGE_GROUPS.map((group) =>
    summarizeCoverageGroup(sourceRows, group)
  );
  const enforcedSummaries = [
    {
      ...globalSummary,
      label: GLOBAL_GATE.label,
      thresholds: options.strictTargets ? GLOBAL_GATE.target : GLOBAL_GATE.minimum,
      enforce: true,
    },
    ...groupSummaries.map((summary) => ({
      ...summary,
      thresholds: options.strictTargets ? summary.target : summary.minimum,
      enforce: summary.enforce,
    })),
  ];
  const failures = enforcedSummaries.flatMap((summary) => {
    if (!summary.enforce) {
      return [];
    }

    return collectFailures(summary, summary.thresholds).map((failure) => ({
      group: summary.label,
      ...failure,
    }));
  });

  console.log(
    renderSummary({
      globalSummary,
      groupSummaries,
      strictTargets: options.strictTargets,
    })
  );

  if (failures.length > 0) {
    console.error("\nCoverage gate failed:");
    for (const failure of failures) {
      const actual = failure.metric === "Files"
        ? String(failure.actual)
        : formatPercent(failure.actual);
      const expected = failure.metric === "Files"
        ? String(failure.expected)
        : formatPercent(failure.expected);
      console.error(
        `- ${failure.group} ${failure.metric}: ${actual} < ${expected}`
      );
    }
    process.exitCode = 1;
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
