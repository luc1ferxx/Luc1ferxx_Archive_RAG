#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const testDirectory = path.join(serverDirectory, "test");

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

const COVERAGE_GROUPS = [
  {
    id: "rag_agent_core",
    label: "RAG / AgentRAG core",
    enforce: true,
    include: [
      /^server\/rag\/agent(?:-|\.js)/,
      /^server\/rag\/comparison-engine\.js$/,
      /^server\/rag\/evidence-aligner\.js$/,
      /^server\/rag\/evidence-summary\.js$/,
      /^server\/rag\/query-decomposer\.js$/,
      /^server\/rag\/query-router\.js$/,
      /^server\/rag\/research-brief\.js$/,
      /^server\/rag\/skills\/registry\.js$/,
      /^server\/rag\/skills\/custom\//,
    ],
    minimum: {
      line: 90,
      branch: 75,
      funcs: 80,
    },
    target: {
      line: 95,
      branch: 80,
      funcs: 90,
    },
  },
  {
    id: "rerank_retrieval",
    label: "Rerank / retrieval",
    enforce: true,
    include: [
      /^server\/rag\/reranker\.js$/,
      /^server\/rag\/retrievers\//,
      /^server\/rag\/vector-store(?:-|\.js)/,
      /^server\/rag\/sparse-store\.js$/,
      /^server\/rag\/text-utils\.js$/,
      /^server\/rag\/chunker\.js$/,
      /^server\/rag\/citations\.js$/,
      /^server\/rag\/confidence\.js$/,
    ],
    exclude: [
      /^server\/rag\/vector-store-local\.js$/,
      /^server\/rag\/vector-store-qdrant\.js$/,
    ],
    minimum: {
      line: 80,
      branch: 65,
      funcs: 80,
    },
    target: {
      line: 95,
      branch: 85,
      funcs: 95,
    },
  },
  {
    id: "api_routes",
    label: "API routes",
    enforce: true,
    include: [
      /^server\/app\.js$/,
      /^server\/auth\.js$/,
    ],
    minimum: {
      line: 70,
      branch: 45,
      funcs: 70,
    },
    target: {
      line: 85,
      branch: 70,
      funcs: 85,
    },
  },
  {
    id: "infra_external_cli",
    label: "DB / OpenAI / CLI scripts",
    enforce: false,
    include: [
      /^server\/rag\/openai\.js$/,
      /^server\/rag\/postgres\.js$/,
      /^server\/rag\/db-migrations\.js$/,
      /^server\/rag\/vector-store-local\.js$/,
      /^server\/rag\/vector-store-qdrant\.js$/,
      /^server\/rag\/doc-registry\.js$/,
      /^server\/rag\/long-memory\.js$/,
      /^server\/rag\/memory\.js$/,
      /^server\/health\.js$/,
      /^server\/chat-mcp\.js$/,
      /^server\/feedback\.js$/,
      /^server\/upload-session-store\.js$/,
      /^server\/evaluation\/run-/,
      /^server\/evaluation\/eval-store-overrides\.js$/,
    ],
    minimum: {
      line: 0,
      branch: 0,
      funcs: 0,
    },
    target: {
      line: 70,
      branch: 70,
      funcs: 70,
    },
  },
];

const GLOBAL_GATE = {
  label: "Global backend",
  enforce: true,
  minimum: {
    line: 78,
    branch: 65,
    funcs: 80,
  },
  target: {
    line: 85,
    branch: 75,
    funcs: 90,
  },
};

const round = (value) =>
  Number.isFinite(value) ? Number(value.toFixed(2)) : null;

const formatPercent = (value) =>
  Number.isFinite(value) ? `${value.toFixed(2)}%` : "N/A";

const average = (values) => {
  const safeValues = values.filter((value) => Number.isFinite(value));

  if (safeValues.length === 0) {
    return null;
  }

  return round(safeValues.reduce((sum, value) => sum + value, 0) / safeValues.length);
};

const parsePercentColumn = (value) => {
  const trimmedValue = String(value ?? "").trim();

  if (!trimmedValue) {
    return null;
  }

  const parsedValue = Number(trimmedValue);

  return Number.isFinite(parsedValue) ? parsedValue : null;
};

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
      ["--test", "--experimental-test-coverage", ...testFiles],
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
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        output: `${stdout}\n${stderr}`,
      });
    });
  });

const parseCoverageReport = (output) => {
  const rows = [];
  const stack = [];
  let allFilesSummary = null;

  for (const rawLine of output.split(/\r?\n/g)) {
    const line = rawLine.replace(/^ℹ\s?/, "");

    if (!line.includes("|")) {
      continue;
    }

    const columns = line.split("|");

    if (columns.length < 4) {
      continue;
    }

    const rawNameColumn = columns[0];
    const name = rawNameColumn.trim();

    if (!name || name === "file" || /^-+$/.test(name)) {
      continue;
    }

    const linePercent = parsePercentColumn(columns[1]);
    const branchPercent = parsePercentColumn(columns[2]);
    const funcsPercent = parsePercentColumn(columns[3]);
    const indent = rawNameColumn.search(/\S/);

    if (name === "all files") {
      allFilesSummary = {
        fileCount: null,
        line: linePercent,
        branch: branchPercent,
        funcs: funcsPercent,
      };
      continue;
    }

    if (!Number.isFinite(linePercent)) {
      stack[indent] = name;
      stack.length = indent + 1;
      continue;
    }

    const parentPath = stack
      .slice(0, indent)
      .filter(Boolean)
      .join("/");
    const filePath = [parentPath, name].filter(Boolean).join("/");
    const normalizedFilePath = filePath.startsWith("server/")
      ? filePath
      : `server/${filePath}`;

    rows.push({
      filePath: normalizedFilePath,
      line: linePercent,
      branch: branchPercent,
      funcs: funcsPercent,
    });
  }

  return {
    rows,
    allFilesSummary,
  };
};

const matchesGroup = (row, group) =>
  group.include.some((pattern) => pattern.test(row.filePath)) &&
  !(group.exclude ?? []).some((pattern) => pattern.test(row.filePath));

const summarizeRows = (rows) => ({
  fileCount: rows.length,
  line: average(rows.map((row) => row.line)),
  branch: average(rows.map((row) => row.branch)),
  funcs: average(rows.map((row) => row.funcs)),
});

const isReportOnlyRow = (row) =>
  COVERAGE_GROUPS.some((group) => !group.enforce && matchesGroup(row, group));

const summarizeGlobalCoverage = ({ rows, allFilesSummary, strictTargets }) => {
  if (!strictTargets && allFilesSummary) {
    return {
      ...allFilesSummary,
      fileCount: rows.length,
    };
  }

  const includedRows = strictTargets
    ? rows.filter((row) => !isReportOnlyRow(row))
    : rows;

  return summarizeRows(includedRows);
};

const summarizeGroup = (rows, group) => ({
  id: group.id,
  label: group.label,
  enforce: group.enforce,
  minimum: group.minimum,
  target: group.target,
  ...summarizeRows(rows.filter((row) => matchesGroup(row, group))),
});

const metricEntries = [
  ["line", "Line"],
  ["branch", "Branch"],
  ["funcs", "Funcs"],
];

const collectFailures = (summary, thresholds) =>
  metricEntries
    .filter(([key]) => Number(summary[key]) < thresholds[key])
    .map(([key, label]) => ({
      metric: label,
      actual: summary[key],
      expected: thresholds[key],
    }));

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
    process.exitCode = coverageResult.exitCode;
    return;
  }

  const { rows, allFilesSummary } = parseCoverageReport(coverageResult.output);
  const globalSummary = summarizeGlobalCoverage({
    rows,
    allFilesSummary,
    strictTargets: options.strictTargets,
  });
  const groupSummaries = COVERAGE_GROUPS.map((group) =>
    summarizeGroup(rows, group)
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
      console.error(
        `- ${failure.group} ${failure.metric}: ${formatPercent(failure.actual)} < ${formatPercent(failure.expected)}`
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
