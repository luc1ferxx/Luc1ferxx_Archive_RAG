#!/usr/bin/env node

import path from "node:path";
import {
  DEFAULT_RELEASE_EVIDENCE_MAX_AGE_HOURS,
} from "./eval-evidence-policy.js";
import { resolveEvaluationGitState } from "./eval-evidence.js";
import {
  buildReleaseEvidenceReport,
  formatReleaseEvidenceReportMarkdown,
  getReleaseEvidenceExitCode,
  readReleaseCorpusHashes,
  readReleaseEvidenceInputs,
  writeReleaseEvidenceReport,
} from "./release-evidence-gate.js";

const usage = `Usage: npm run release:gate -- [options]

Options:
  --target-commit <sha>    Commit SHA that every report must match. Defaults to HEAD.
  --max-age-hours <hours>  Maximum evidence age. Defaults to ${DEFAULT_RELEASE_EVIDENCE_MAX_AGE_HOURS}.
  --input-directory <path> Read inputs and write release evidence in this directory.
  --json                   Print the release evidence report as JSON.
  --no-fail                Always exit 0 without changing the report status.
  --help                   Show this message.
`;

const readOptionValue = ({ arg, args, index, option }) => {
  const inlinePrefix = `${option}=`;
  const inline = arg.startsWith(inlinePrefix);
  const value = inline ? arg.slice(inlinePrefix.length) : args[index + 1];

  if (!value || String(value).startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }

  return {
    nextIndex: inline ? index : index + 1,
    value,
  };
};

const parseArgs = (args) => {
  const options = {
    help: false,
    inputDirectory: "",
    json: false,
    maxAgeHours: DEFAULT_RELEASE_EVIDENCE_MAX_AGE_HOURS,
    noFail: false,
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

    if (arg === "--no-fail") {
      options.noFail = true;
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

  const gitState = await resolveEvaluationGitState({
    targetCommit: options.targetCommit,
  });
  const targetCommit = gitState.commitSha;
  const inputDirectory = options.inputDirectory
    ? path.resolve(options.inputDirectory)
    : undefined;
  const reports = await readReleaseEvidenceInputs({ inputDirectory });
  const expectedCorpusHashes = await readReleaseCorpusHashes();
  const report = buildReleaseEvidenceReport({
    expectedCorpusHashes,
    maxAgeHours: options.maxAgeHours,
    reports,
    targetCommit,
  });
  const paths = await writeReleaseEvidenceReport({
    outputDirectory: inputDirectory,
    report,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReleaseEvidenceReportMarkdown(report).trimEnd());
    console.log(`JSON: ${paths.jsonPath}`);
    console.log(`Markdown: ${paths.markdownPath}`);
  }

  process.exitCode = getReleaseEvidenceExitCode(report, {
    noFail: options.noFail,
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
