#!/usr/bin/env node

import path from "node:path";
import { readOptionValue } from "./eval-cli.js";
import { buildRobustSuiteGate } from "./quality-robust-suite-gate.js";
import { readLatestRobustPayloads } from "./robust-suite-result-reader.js";

const usage = `Usage: npm run robust:gate -- [options]

Reads only the three latest robust-suite reports. It does not evaluate
historical synthetic, feedback, planner, trajectory, or recovery reports.

Options:
  --input-directory <path>  Read robust reports from this directory.
  --json                    Print the scoped robust gate as JSON.
  --fail-on-warn            Treat warning-level robust results as failures.
  --help                    Show this message.
`;

const parseArgs = (args) => {
  const options = {
    failOnWarn: false,
    help: false,
    inputDirectory: "",
    json: false,
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

    if (arg === "--fail-on-warn") {
      options.failOnWarn = true;
      continue;
    }

    if (arg === "--input-directory" || arg.startsWith("--input-directory=")) {
      const parsed = readOptionValue({
        arg,
        args,
        index,
        option: "--input-directory",
      });
      options.inputDirectory = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
};

const getExitCode = ({ failOnWarn, gate }) =>
  gate.status === "fail" || (failOnWarn && gate.status === "warn") ? 1 : 0;

const printTextReport = ({ exitCode, failOnWarn, gate }) => {
  const displayedStatus = exitCode === 0 ? gate.status : "fail";
  console.log(`Robust eval suite: ${displayedStatus.toUpperCase()}`);
  console.log(
    "Evidence scope: latest_reports_unverified (use release:gate for commit, freshness, and suite-lineage verification)."
  );
  console.log(gate.summary);

  if (gate.status === "warn" && failOnWarn) {
    console.log("Warnings are failures because --fail-on-warn is enabled.");
  }

  for (const report of gate.reports ?? []) {
    console.log(`- ${report.label}: ${report.status}`);

    for (const check of report.checks ?? []) {
      if (check.status === "pass") {
        continue;
      }

      const reasonCode = check.detail?.reasonCode;
      console.log(
        `  - ${check.label}: ${check.status}${
          reasonCode ? ` (${reasonCode})` : ""
        }`
      );
    }
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const inputDirectory = options.inputDirectory
    ? path.resolve(options.inputDirectory)
    : undefined;
  const latestRobustPayloads = await readLatestRobustPayloads({
    inputDirectory,
  });
  const gate = buildRobustSuiteGate({
    latestRobustPayloads,
    requireRobustSuite: true,
  });
  const exitCode = getExitCode({
    failOnWarn: options.failOnWarn,
    gate,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          decision: {
            authoritativeForCurrentCommit: false,
            currentCommitVerified: false,
            evidenceScope: "latest_reports_unverified",
            exitCode,
            failOnWarn: options.failOnWarn,
            scope: "robust_suite_only",
            status: exitCode === 0 ? gate.status : "fail",
          },
          gate,
        },
        null,
        2
      )
    );
  } else {
    printTextReport({
      exitCode,
      failOnWarn: options.failOnWarn,
      gate,
    });
  }

  process.exitCode = exitCode;
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
