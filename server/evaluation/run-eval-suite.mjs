#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { robustEvalSuite } from "./eval-suite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");

const usage = `Usage: npm run eval:robust-suite -- [options]

Options:
  --suite <name>                  Evaluation suite to run. Defaults to robust.
  --synthetic-provider <mode>     Provider for synthetic answer eval: real or deterministic. Defaults to real.
  --skip-arxiv-build              Reuse evaluation/generated/arxiv-corpus.json instead of rebuilding it.
  --arxiv-skip-download           Pass --skip-download to the arXiv corpus builder.
  --help                          Show this message.
`;

const parseArgs = (argv) => {
  const options = {
    arxivSkipDownload: false,
    help: false,
    skipArxivBuild: false,
    suite: "robust",
    syntheticProvider: "real",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];

    if (rawArg === "--help" || rawArg === "-h") {
      options.help = true;
      continue;
    }

    if (rawArg === "--skip-arxiv-build") {
      options.skipArxivBuild = true;
      continue;
    }

    if (rawArg === "--arxiv-skip-download") {
      options.arxivSkipDownload = true;
      continue;
    }

    const [key, inlineValue] = rawArg.slice(2).split("=", 2);
    const nextValue = argv[index + 1];
    const value = inlineValue ?? nextValue;

    if (!rawArg.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Unknown or incomplete option: ${rawArg}`);
    }

    if (key === "suite") {
      options.suite = value;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (key === "synthetic-provider") {
      options.syntheticProvider = value;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    throw new Error(`Unknown option: ${rawArg}`);
  }

  if (options.suite !== robustEvalSuite.id) {
    throw new Error(`Unknown evaluation suite: ${options.suite}`);
  }

  if (!["deterministic", "real"].includes(options.syntheticProvider)) {
    throw new Error("--synthetic-provider must be either deterministic or real.");
  }

  return options;
};

const runNodeStep = async ({ args, label }) => {
  console.log(`\n==> ${label}`);
  console.log(`node ${args.join(" ")}`);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: serverDirectory,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} failed with exit code ${code}.`));
    });
  });
};

const buildReportSteps = ({ options, report }) => {
  const steps = [];

  if (report.build && !(report.id === "arxiv-real-paper-rerank" && options.skipArxivBuild)) {
    const buildArgs = [report.build.scriptPath];

    if (report.id === "arxiv-real-paper-rerank" && options.arxivSkipDownload) {
      buildArgs.push("--skip-download");
    }

    steps.push({
      label: report.build.label,
      args: buildArgs,
    });
  }

  if (report.reportType === "synthetic") {
    steps.push({
      label: report.label,
      args: [
        "evaluation/run-synthetic-eval.mjs",
        report.corpusPath,
        "--latest-name",
        report.latestName,
        "--openai-provider",
        options.syntheticProvider,
      ],
    });
    return steps;
  }

  if (report.reportType === "rerank") {
    steps.push({
      label: report.label,
      args: [
        "evaluation/run-rerank-eval.mjs",
        report.corpusPath,
        "--latest-name",
        report.latestName,
        "--rerank-provider",
        report.rerankProvider,
      ],
    });
    return steps;
  }

  throw new Error(`Unsupported report type for ${report.id}: ${report.reportType}`);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const steps = robustEvalSuite.reports.flatMap((report) =>
    buildReportSteps({
      options,
      report,
    })
  );

  for (const step of steps) {
    await runNodeStep(step);
  }

  console.log(
    JSON.stringify(
      {
        suite: robustEvalSuite.id,
        reports: robustEvalSuite.reports.map((report) => ({
          id: report.id,
          latestName: report.latestName,
        })),
      },
      null,
      2
    )
  );
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
