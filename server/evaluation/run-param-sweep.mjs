#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildParamSweepReport,
  getParamSweepVariants,
  renderParamSweepMarkdown,
} from "./param-sweep.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const resultsDirectory = path.join(__dirname, "results");
const defaultCorpusPath = path.join(__dirname, "synthetic-corpus-near-duplicate.json");
const defaultLatestPrefix = "param-sweep";

const usage = `Usage: npm run eval:param-sweep -- [options]

Options:
  --corpus <path>       Synthetic corpus path. Default: evaluation/synthetic-corpus-near-duplicate.json.
  --profile <name>      Sweep profile: quick or full. Default: quick.
  --variants <ids>      Comma-separated variant ids from the selected profile.
  --latest-prefix <id>  Output prefix for aggregate latest files. Default: param-sweep.
  --help                Show this message.
`;

const toRunId = () => new Date().toISOString().replace(/[:.]/g, "-");

const getArgValue = (name) => {
  const inlinePrefix = `${name}=`;
  const inlineValue = process.argv.find((arg) => arg.startsWith(inlinePrefix));

  if (inlineValue) {
    return inlineValue.slice(inlinePrefix.length);
  }

  const index = process.argv.indexOf(name);

  return index >= 0 ? process.argv[index + 1] : null;
};

const parseArgs = () => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    return {
      help: true,
    };
  }

  const profile = getArgValue("--profile") ?? "quick";
  const latestPrefix = getArgValue("--latest-prefix") ?? defaultLatestPrefix;

  if (!/^[A-Za-z0-9._-]+$/.test(latestPrefix)) {
    throw new Error("--latest-prefix must contain only letters, numbers, dots, underscores, or hyphens.");
  }

  return {
    help: false,
    profile,
    latestPrefix,
    corpusPath: path.resolve(process.cwd(), getArgValue("--corpus") ?? defaultCorpusPath),
    variantIds: (getArgValue("--variants") ?? "")
      .split(",")
      .map((variantId) => variantId.trim())
      .filter(Boolean),
  };
};

const runCommand = ({ command, args, env }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: serverDirectory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr,
      });
    });
  });

const summarizeCommandError = (stderr = "", fallbackMessage = "Evaluation failed.") => {
  const lines = String(stderr ?? "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstMeaningfulLine = lines.find((line) =>
    /Error:|AuthenticationError|APIConnectionError|Embedding request failed|Chat request failed/i.test(line)
  );

  return firstMeaningfulLine ?? lines[0] ?? fallbackMessage;
};

const readVariantSummary = async (latestName) => {
  const resultPath = path.join(resultsDirectory, `${latestName}.json`);
  const payload = JSON.parse(await readFile(resultPath, "utf8"));

  return {
    summary: payload.summary,
  };
};

const runVariant = async ({ variant, corpusPath, latestName }) => {
  console.log(`\n=== Running ${variant.id}: ${variant.label} ===`);

  const commandResult = await runCommand({
    command: process.execPath,
    args: [
      "evaluation/run-synthetic-eval.mjs",
      corpusPath,
      "--latest-name",
      latestName,
    ],
    env: {
      ...process.env,
      ...variant.env,
    },
  });

  if (commandResult.exitCode !== 0) {
    return {
      variantId: variant.id,
      status: "failed",
      error: summarizeCommandError(
        commandResult.stderr,
        `Exited with code ${commandResult.exitCode}`
      ),
    };
  }

  return {
    variantId: variant.id,
    status: "completed",
    ...(await readVariantSummary(latestName)),
  };
};

const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const main = async () => {
  const options = parseArgs();

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const runId = toRunId();
  const variants = getParamSweepVariants({
    profile: options.profile,
    variantIds: options.variantIds,
  });
  const results = [];

  if (variants.length === 0) {
    throw new Error("No param sweep variants selected.");
  }

  await mkdir(resultsDirectory, {
    recursive: true,
  });

  for (const variant of variants) {
    const latestName = `${options.latestPrefix}-${variant.id}`;

    results.push(
      await runVariant({
        variant,
        corpusPath: options.corpusPath,
        latestName,
      })
    );
  }

  const report = buildParamSweepReport({
    runId,
    createdAt: new Date().toISOString(),
    corpusPath: options.corpusPath,
    profile: options.profile,
    variants,
    results,
  });
  const markdown = renderParamSweepMarkdown(report);
  const runJsonPath = path.join(resultsDirectory, `${runId}-param-sweep.json`);
  const runMarkdownPath = path.join(resultsDirectory, `${runId}-param-sweep.md`);
  const latestJsonPath = path.join(resultsDirectory, `${options.latestPrefix}-latest.json`);
  const latestMarkdownPath = path.join(resultsDirectory, `${options.latestPrefix}-latest.md`);

  await writeJson(runJsonPath, report);
  await writeFile(runMarkdownPath, markdown, "utf8");
  await writeJson(latestJsonPath, report);
  await writeFile(latestMarkdownPath, markdown, "utf8");

  console.log(
    JSON.stringify(
      {
        runId,
        bestVariantId: report.bestVariantId,
        latestJsonPath,
        latestMarkdownPath,
        completedCount: report.summary.completedCount,
        failedCount: report.summary.failedCount,
      },
      null,
      2
    )
  );

  if (report.summary.completedCount === 0) {
    process.exitCode = 1;
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
