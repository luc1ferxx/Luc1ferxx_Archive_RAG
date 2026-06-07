import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeedbackCorpusFromJsonlFile } from "./feedback-corpus.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const defaultInputPath = path.join(serverDirectory, "data", "feedback", "feedback.jsonl");
const defaultOutputPath = path.join(__dirname, "generated", "feedback-corpus.json");

const getArgValue = (name) => {
  const inlinePrefix = `${name}=`;
  const inlineValue = process.argv.find((arg) => arg.startsWith(inlinePrefix));

  if (inlineValue) {
    return inlineValue.slice(inlinePrefix.length);
  }

  const index = process.argv.indexOf(name);

  return index >= 0 ? process.argv[index + 1] : null;
};

const resolvePathArg = (name, fallbackPath) =>
  path.resolve(process.cwd(), getArgValue(name) ?? fallbackPath);

const main = async () => {
  const inputPath = resolvePathArg("--input", defaultInputPath);
  const outputPath = resolvePathArg("--output", defaultOutputPath);
  const corpus = await buildFeedbackCorpusFromJsonlFile({
    inputPath,
    outputPath,
  });

  console.log(
    JSON.stringify(
      {
        inputPath,
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
