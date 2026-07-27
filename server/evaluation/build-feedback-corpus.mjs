import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeedbackCorpusFromJsonlFiles } from "./feedback-corpus.js";
import { getArgValue } from "./eval-cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const defaultInputPath = path.join(serverDirectory, "data", "feedback", "feedback.jsonl");
const defaultSeedInputPath = path.join(__dirname, "feedback-seed.jsonl");
const defaultOutputPath = path.join(__dirname, "generated", "feedback-corpus.json");

const resolvePathArg = (name, fallbackPath) =>
  path.resolve(process.cwd(), getArgValue(name) ?? fallbackPath);

const hasFlag = (name) => process.argv.includes(name);

const resolveInputPaths = () => {
  const inputPath = getArgValue("--input");
  const seedInputPath = getArgValue("--seed-input");
  const includeSeed = !hasFlag("--no-seed");
  const runtimeInputPath = path.resolve(process.cwd(), inputPath ?? defaultInputPath);
  const resolvedInputPaths = [];

  if (includeSeed) {
    resolvedInputPaths.push(
      path.resolve(process.cwd(), seedInputPath ?? defaultSeedInputPath)
    );
  }

  resolvedInputPaths.push(runtimeInputPath);

  return resolvedInputPaths;
};

const main = async () => {
  const inputPaths = resolveInputPaths();
  const outputPath = resolvePathArg("--output", defaultOutputPath);
  const corpus = await buildFeedbackCorpusFromJsonlFiles({
    inputPaths,
    outputPath,
  });

  console.log(
    JSON.stringify(
      {
        inputPaths,
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
}
