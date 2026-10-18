import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeedbackCorpusFromSources } from "./feedback-corpus.js";
import { getArgValue } from "./eval-cli.js";
import { getDefaultFeedbackStore, listAllFeedbackAcrossTenants } from "../feedback.js";
import { resetPostgresPool } from "../rag/postgres.js";

// Builds the feedback regression corpus from the seed file plus the runtime
// feedback. Runtime records come from the store the server writes: the
// PostgreSQL feedback table when a database is configured, read on the owner
// path across every tenant (an operator tool writing a local, ignored
// evaluation file, as reading the shared JSONL file always was), otherwise the
// JSONL file under FEEDBACK_DIRECTORY. --input <file> reads that JSONL file
// instead of the store.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultSeedInputPath = path.join(__dirname, "feedback-seed.jsonl");
const defaultOutputPath = path.join(__dirname, "generated", "feedback-corpus.json");

const resolvePathArg = (name, fallbackPath) =>
  path.resolve(process.cwd(), getArgValue(name) ?? fallbackPath);

const hasFlag = (name) => process.argv.includes(name);

const main = async () => {
  const inputPath = getArgValue("--input");
  const seedInputPath = getArgValue("--seed-input");
  const filePaths = hasFlag("--no-seed")
    ? []
    : [path.resolve(process.cwd(), seedInputPath ?? defaultSeedInputPath)];
  const store = inputPath ? null : getDefaultFeedbackStore();

  if (inputPath) {
    filePaths.push(path.resolve(process.cwd(), inputPath));
  }

  const runtimeSource = store ? store.describe() : { backend: "jsonl", path: filePaths.at(-1) };
  const records = store ? await listAllFeedbackAcrossTenants({ store }) : [];
  const outputPath = resolvePathArg("--output", defaultOutputPath);
  const corpus = await buildFeedbackCorpusFromSources({
    inputPaths: filePaths,
    outputPath,
    records,
  });

  console.log(
    JSON.stringify(
      {
        // The seed, then the runtime file when the records came from one.
        inputPaths: runtimeSource.path && store ? [...filePaths, runtimeSource.path] : filePaths,
        runtimeSource,
        ...(store ? { runtimeRecords: records.length } : {}),
        outputPath,
        documents: corpus.documents.length,
        cases: corpus.cases.length,
      },
      null,
      2
    )
  );
};

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await resetPostgresPool();
}
