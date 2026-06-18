#!/usr/bin/env node

import path from "node:path";
import {
  buildRequiredPlannerProviderGate,
  readLatestPlannerProviderReport,
} from "./planner-provider-gate.js";

const usage = `Usage: npm run planner:gate -- [options]

Options:
  --provider <name>                         Required provider report to check. Default: real.
  --compare-provider <name>                 Compare planner signatures against another provider. Default: mock for real.
  --no-compare                              Disable provider divergence checks.
  --max-unexpected-fallback-rate <number>   Max unexpected fallback ratio. Default: 0.
  --max-divergence-count <number>           Max allowed provider divergences. Default: 0.
  --results-directory <path>                Override evaluation results directory.
  --json                                    Print full gate payload as JSON.
  --help                                    Show this message.
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

const parseNumberOption = ({ name, value }) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return parsed;
};

const parseArgs = (args) => {
  const options = {
    compareProvider: null,
    help: false,
    json: false,
    maxDivergenceCount: 0,
    maxUnexpectedFallbackRate: 0,
    provider: "real",
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

    if (arg === "--no-compare") {
      options.compareProvider = "";
      continue;
    }

    if (arg === "--provider" || arg.startsWith("--provider=")) {
      const parsed = readOptionValue({
        arg,
        args,
        index,
        option: "--provider",
      });
      options.provider = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (
      arg === "--compare-provider" ||
      arg.startsWith("--compare-provider=")
    ) {
      const parsed = readOptionValue({
        arg,
        args,
        index,
        option: "--compare-provider",
      });
      options.compareProvider = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (
      arg === "--max-unexpected-fallback-rate" ||
      arg.startsWith("--max-unexpected-fallback-rate=")
    ) {
      const parsed = readOptionValue({
        arg,
        args,
        index,
        option: "--max-unexpected-fallback-rate",
      });
      options.maxUnexpectedFallbackRate = parseNumberOption({
        name: "--max-unexpected-fallback-rate",
        value: parsed.value,
      });
      index = parsed.nextIndex;
      continue;
    }

    if (
      arg === "--max-divergence-count" ||
      arg.startsWith("--max-divergence-count=")
    ) {
      const parsed = readOptionValue({
        arg,
        args,
        index,
        option: "--max-divergence-count",
      });
      options.maxDivergenceCount = parseNumberOption({
        name: "--max-divergence-count",
        value: parsed.value,
      });
      index = parsed.nextIndex;
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

  if (options.compareProvider === null) {
    options.compareProvider = options.provider === "real" ? "mock" : "";
  }

  return options;
};

const formatPercent = (value) =>
  typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "N/A";

const printTextReport = (gate) => {
  console.log(`Planner provider gate: ${gate.status.toUpperCase()}`);
  console.log(gate.summary);
  console.log(`Provider: ${gate.provider}`);
  console.log(`Report provider: ${gate.reportProvider ?? "missing"}`);
  console.log(
    `Unexpected fallback: ${gate.unexpectedFallbackCount ?? 0}/${
      gate.caseCount ?? 0
    } (${formatPercent(gate.unexpectedFallbackRate)})`
  );

  if (gate.compareProvider) {
    console.log(
      `Divergence vs ${gate.compareProvider}: ${gate.divergenceCount ?? 0}`
    );
  }

  for (const failedCase of gate.providerGate?.failedCases ?? []) {
    const failedCheckLabels = (failedCase.failedChecks ?? [])
      .map((check) => check.label)
      .join(", ");
    console.log(
      `- ${failedCase.id}: ${
        failedCheckLabels || `${failedCase.failedCheckCount ?? 0} failed checks`
      }`
    );
  }

  for (const divergence of gate.divergences ?? []) {
    console.log(`- divergence ${divergence.id}: ${divergence.reason}`);
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const resultsDirectory = options.resultsDirectory
    ? path.resolve(options.resultsDirectory)
    : undefined;
  const payload = await readLatestPlannerProviderReport({
    provider: options.provider,
    resultsDirectory,
  });
  const comparePayload = options.compareProvider
    ? await readLatestPlannerProviderReport({
        provider: options.compareProvider,
        resultsDirectory,
      })
    : null;
  const gate = buildRequiredPlannerProviderGate({
    comparePayload,
    compareProvider: options.compareProvider,
    maxDivergenceCount: options.maxDivergenceCount,
    maxUnexpectedFallbackRate: options.maxUnexpectedFallbackRate,
    payload,
    provider: options.provider,
    requireCompare: Boolean(options.compareProvider),
  });

  if (options.json) {
    console.log(JSON.stringify(gate, null, 2));
  } else {
    printTextReport(gate);
  }

  process.exitCode = gate.status === "pass" ? 0 : 1;
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
