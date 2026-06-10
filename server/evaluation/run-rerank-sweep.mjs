#!/usr/bin/env node

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRerankEvaluation } from "./run-rerank-eval.mjs";
import {
  buildRerankSweepReport,
  getRerankSweepVariants,
  renderRerankSweepMarkdown,
} from "./rerank-sweep.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");
const defaultCorpusPath = path.join(__dirname, "generated", "arxiv-corpus.json");
const defaultLatestPrefix = "arxiv-rerank-sweep";

const usage = `Usage: npm run eval:rerank:sweep -- [options]

Options:
  --corpus <path>             Corpus path. Default: evaluation/generated/arxiv-corpus.json.
  --profile <name>            Sweep profile: quick or full. Default: quick.
  --variants <ids>            Comma-separated variant ids from the selected profile.
  --latest-prefix <id>        Output prefix for aggregate latest files. Default: arxiv-rerank-sweep.
  --include-openai            Include OpenAI embedding variants. Requires OPENAI_API_KEY.
  --include-cross-encoder     Include HTTP cross-encoder variants. Requires RAG_CROSS_ENCODER_ENDPOINT.
  --help                      Show this message.
`;

const envKeysToRestore = [
  "RAG_RERANK_ENABLED",
  "RAG_RERANK_PROVIDER",
  "RAG_RERANK_WEIGHT",
  "RAG_CROSS_ENCODER_ENDPOINT",
  "RAG_CROSS_ENCODER_MODEL",
  "RAG_HYBRID_ENABLED",
  "RAG_HYBRID_FUSION",
  "RAG_HYBRID_DENSE_WEIGHT",
  "RAG_HYBRID_SPARSE_WEIGHT",
  "RAG_RRF_K",
  "RAG_SPARSE_TOP_K",
  "VECTOR_STORE_PROVIDER",
];

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

  const latestPrefix = getArgValue("--latest-prefix") ?? defaultLatestPrefix;

  if (!/^[A-Za-z0-9._-]+$/.test(latestPrefix)) {
    throw new Error("--latest-prefix must contain only letters, numbers, dots, underscores, or hyphens.");
  }

  return {
    help: false,
    latestPrefix,
    profile: getArgValue("--profile") ?? "quick",
    corpusPath: path.resolve(process.cwd(), getArgValue("--corpus") ?? defaultCorpusPath),
    variantIds: (getArgValue("--variants") ?? "")
      .split(",")
      .map((variantId) => variantId.trim())
      .filter(Boolean),
    includeOpenAI: process.argv.includes("--include-openai"),
    includeCrossEncoder: process.argv.includes("--include-cross-encoder"),
  };
};

const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const summarizeError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = String(message)
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)[0];

  return firstLine ?? "Evaluation failed.";
};

const withVariantEnv = async (variant, callback) => {
  const keys = new Set([...envKeysToRestore, ...Object.keys(variant.env ?? {})]);
  const previousValues = new Map();

  for (const key of keys) {
    previousValues.set(key, process.env[key]);
  }

  for (const [key, value] of Object.entries(variant.env ?? {})) {
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const runVariant = async ({ variant, corpusPath, latestName }) => {
  console.log(`\n=== Running ${variant.id}: ${variant.label} ===`);

  try {
    const result = await withVariantEnv(variant, () =>
      runRerankEvaluation({
        corpusPath,
        latestName,
        topK: variant.topK,
        topKPerDoc: variant.topKPerDoc,
        candidateMultiplier: variant.candidateMultiplier,
        embeddingProvider: variant.embeddingProvider,
        rerankProvider: variant.env?.RAG_RERANK_PROVIDER,
        rerankWeight: variant.env?.RAG_RERANK_WEIGHT,
      })
    );

    return {
      variantId: variant.id,
      status: "completed",
      summary: result.summary,
    };
  } catch (error) {
    const errorMessage = summarizeError(error);

    console.error(errorMessage);

    return {
      variantId: variant.id,
      status: "failed",
      error: errorMessage,
    };
  }
};

const main = async () => {
  const options = parseArgs();

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const runId = toRunId();
  const variants = getRerankSweepVariants({
    profile: options.profile,
    variantIds: options.variantIds,
    includeOpenAI: options.includeOpenAI,
    includeCrossEncoder: options.includeCrossEncoder,
  });
  const results = [];

  if (variants.length === 0) {
    throw new Error("No rerank sweep variants selected.");
  }

  await mkdir(resultsDirectory, {
    recursive: true,
  });

  for (const variant of variants) {
    results.push(
      await runVariant({
        variant,
        corpusPath: options.corpusPath,
        latestName: `${options.latestPrefix}-${variant.id}`,
      })
    );
  }

  const report = buildRerankSweepReport({
    runId,
    createdAt: new Date().toISOString(),
    corpusPath: options.corpusPath,
    profile: options.profile,
    variants,
    results,
  });
  const markdown = renderRerankSweepMarkdown(report);
  const runJsonPath = path.join(resultsDirectory, `${runId}-rerank-sweep.json`);
  const runMarkdownPath = path.join(resultsDirectory, `${runId}-rerank-sweep.md`);
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
