#!/usr/bin/env node

import "dotenv/config";
import path from "node:path";
import {
  buildRolloutReadinessReportFromResults,
  formatRolloutReadinessReportMarkdown,
  getRolloutReadinessExitCode,
  writeRolloutReadinessReport,
} from "./rollout-readiness-report.js";

const usage = `Usage: npm run rollout:readiness -- [options]

Options:
  --results-directory <path>  Directory containing latest eval reports.
  --json                      Print the readiness report as JSON.
  --no-fail                   Always exit 0 after writing the report.
  --help                      Show this message.
`;

const readOptionValue = ({ arg, args, index, option }) => {
  const inlinePrefix = `${option}=`;
  let value;
  let nextIndex = index;

  if (arg.startsWith(inlinePrefix)) {
    value = arg.slice(inlinePrefix.length);
  } else {
    nextIndex = index + 1;
    value = args[index + 1];
  }

  if (!value || String(value).startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }

  return {
    nextIndex,
    value,
  };
};

const parseArgs = (args) => {
  const options = {
    help: false,
    json: false,
    noFail: false,
    resultsDirectory: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--no-fail") {
      options.noFail = true;
      continue;
    }

    if (
      arg === "--results-directory" ||
      arg.startsWith("--results-directory=")
    ) {
      const parsed = readOptionValue({
        arg,
        args,
        index,
        option: "--results-directory",
      });
      options.resultsDirectory = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const inputDirectory = options.resultsDirectory
    ? path.resolve(options.resultsDirectory)
    : undefined;
  const report = await buildRolloutReadinessReportFromResults({
    inputDirectory,
  });
  const paths = await writeRolloutReadinessReport({
    outputDirectory: inputDirectory,
    report,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (!options.noFail) {
      process.exitCode = getRolloutReadinessExitCode(report);
    }
    return;
  }

  console.log(formatRolloutReadinessReportMarkdown(report).trimEnd());
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`Markdown: ${paths.markdownPath}`);

  if (!options.noFail) {
    process.exitCode = getRolloutReadinessExitCode(report);
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
