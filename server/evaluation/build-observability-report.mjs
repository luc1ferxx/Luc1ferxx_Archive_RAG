#!/usr/bin/env node
import {
  buildObservabilityReportFromPath,
  formatObservabilityReport,
  getDefaultObservabilityPath,
} from "./observability-report.js";

const printUsage = () => {
  console.log([
    "Usage: node evaluation/build-observability-report.mjs [--input <path>] [--json]",
    "",
    "Options:",
    "  --input <path>  JSONL file or directory of *.jsonl files.",
    "  --json          Print the normalized report payload as JSON.",
  ].join("\n"));
};

const parseArgs = (argv) => {
  const args = {
    inputPath: null,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--input") {
      args.inputPath = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--input=")) {
      args.inputPath = arg.slice("--input=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const report = await buildObservabilityReportFromPath(
    args.inputPath ?? getDefaultObservabilityPath()
  );

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatObservabilityReport(report));

  if (report.invalidLineCount > 0) {
    console.error(
      `Skipped ${report.invalidLineCount} invalid JSONL line${
        report.invalidLineCount === 1 ? "" : "s"
      }.`
    );
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
