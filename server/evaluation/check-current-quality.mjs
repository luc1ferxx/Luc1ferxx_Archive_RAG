#!/usr/bin/env node

import path from "node:path";
import { readOptionValue } from "./eval-cli.js";
import { resolveEvaluationGitState } from "./eval-evidence.js";
import {
  DEFAULT_CURRENT_QUALITY_MAX_AGE_HOURS,
  buildCurrentQualityGateReport,
  formatCurrentQualityGateMarkdown,
  getCurrentQualityGateExitCode,
  readCurrentQualityCorpusExpectations,
  readCurrentQualityInputs,
  writeCurrentQualityGateReport,
} from "./quality-current-gate.js";

const usage = `Usage: npm run quality:current -- [options]

Options:
  --target-commit <sha>    Commit SHA that every current report must match. Defaults to HEAD.
  --max-age-hours <hours>  Maximum current evidence age. Defaults to ${DEFAULT_CURRENT_QUALITY_MAX_AGE_HOURS}.
  --input-directory <path> Read inputs and write current gate evidence in this directory.
  --require-planner-real   Require a fresh current planner-real report.
  --json                   Print the current quality gate report as JSON.
  --help                   Show this message.
`;

const parseArgs = (args) => {
  const options = {
    help: false,
    inputDirectory: "",
    json: false,
    maxAgeHours: DEFAULT_CURRENT_QUALITY_MAX_AGE_HOURS,
    requirePlannerReal: false,
    targetCommit: "",
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

    if (arg === "--require-planner-real") {
      options.requirePlannerReal = true;
      continue;
    }

    if (
      arg === "--target-commit" ||
      arg.startsWith("--target-commit=") ||
      arg === "--max-age-hours" ||
      arg.startsWith("--max-age-hours=") ||
      arg === "--input-directory" ||
      arg.startsWith("--input-directory=")
    ) {
      const option = arg.startsWith("--target-commit")
        ? "--target-commit"
        : arg.startsWith("--max-age-hours")
          ? "--max-age-hours"
          : "--input-directory";
      const parsed = readOptionValue({ arg, args, index, option });

      if (option === "--target-commit") {
        options.targetCommit = parsed.value;
      } else if (option === "--input-directory") {
        options.inputDirectory = parsed.value;
      } else {
        const maxAgeHours = Number(parsed.value);

        if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
          throw new Error("--max-age-hours must be a positive number.");
        }

        options.maxAgeHours = maxAgeHours;
      }

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

  const currentGitState = await resolveEvaluationGitState({
    targetCommit: options.targetCommit,
  });
  const targetCommit = currentGitState.commitSha;
  const inputDirectory = options.inputDirectory
    ? path.resolve(options.inputDirectory)
    : undefined;
  const { history, inputErrors, reports } = await readCurrentQualityInputs({
    inputDirectory,
  });
  const corpusExpectations = await readCurrentQualityCorpusExpectations();
  const report = buildCurrentQualityGateReport({
    currentGitState,
    expectedCorpusContracts: corpusExpectations.contracts,
    expectedCorpusHashes: corpusExpectations.hashes,
    failOnWarn: true,
    history,
    inputErrors,
    maxAgeHours: options.maxAgeHours,
    reports,
    requirePlannerReal: options.requirePlannerReal,
    targetCommit,
  });
  const paths = await writeCurrentQualityGateReport({
    outputDirectory: inputDirectory,
    report,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCurrentQualityGateMarkdown(report).trimEnd());
    console.log(`JSON: ${paths.jsonPath}`);
    console.log(`Markdown: ${paths.markdownPath}`);
  }

  process.exitCode = getCurrentQualityGateExitCode(report);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
