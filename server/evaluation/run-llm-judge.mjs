// run-llm-judge.mjs
//
// LLM-as-judge for answer quality, with a calibration step. The lexical claim
// check in rag/self-check cannot tell whether a paraphrase is equivalent; a
// model judge can, but a judge is only worth quoting once its agreement with
// human labels is measured, so this runner reports that agreement whenever a
// label file is supplied.
//
// Input: a JSON array (or { items: [...] }) of
//   { id, question, answer, referenceAnswer?, evidence?: [string] }
// Labels (optional): a JSON array of { id, verdict } written by a person, using
// the same verdict vocabulary as the judge.
//
// The judge runs on the chat route, so point OPENAI_CHAT_MODEL at a different
// model than the one that wrote the answers: a model grading its own output is
// biased toward it.
//
// Usage:
//   node evaluation/run-llm-judge.mjs --input <answers.json> [--labels <labels.json>]
//     [--latest-name latest-llm-judge]

import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { completeTextWithMetadata } from "../rag/openai.js";
import {
  boundedString,
  buildJsonSchemaResponseFormat,
  parseFirstJsonValue,
  strictObject,
  stringEnum,
} from "../rag/structured-output.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

export const JUDGE_VERDICTS = Object.freeze([
  "correct",
  "partially_correct",
  "incorrect",
  "correct_abstention",
  "wrong_abstention",
]);
export const JUDGE_FAITHFULNESS = Object.freeze(["supported", "partially_supported", "unsupported", "not_applicable"]);

const JUDGE_RESPONSE_FORMAT = buildJsonSchemaResponseFormat({
  name: "answer_judgment",
  schema: strictObject({
    verdict: stringEnum(JUDGE_VERDICTS),
    faithfulness: stringEnum(JUDGE_FAITHFULNESS),
    rationale: boundedString(300),
  }),
});

export const buildJudgePrompt = ({ answer, evidence = [], question, referenceAnswer = null }) =>
  [
    "You grade one answer produced by a document question-answering system.",
    "Return only JSON with verdict, faithfulness, and a one-sentence rationale.",
    "verdict:",
    "- correct: states what the reference states, in any wording; extra correct detail is fine.",
    "- partially_correct: right in part, but misses or contradicts part of the reference.",
    "- incorrect: contradicts the reference or answers a different question.",
    "- correct_abstention: declines to answer, and the reference is absent (the question is unanswerable from the documents).",
    "- wrong_abstention: declines to answer although a reference answer exists.",
    "faithfulness: whether every factual claim in the answer is supported by the evidence passages; use not_applicable when no evidence is given or the answer abstains.",
    "Judge meaning, not wording: a paraphrase of the reference is correct.",
    "Input:",
    JSON.stringify({
      answer: String(answer ?? ""),
      evidence: evidence.map((passage) => String(passage).slice(0, 2000)).slice(0, 8),
      question: String(question ?? ""),
      referenceAnswer,
    }),
  ].join("\n");

export const judgeAnswer = async (item) => {
  const completion = await completeTextWithMetadata(buildJudgePrompt(item), {
    responseFormat: JUDGE_RESPONSE_FORMAT,
  });
  const judgment = parseFirstJsonValue(completion.text);

  if (!JUDGE_VERDICTS.includes(judgment?.verdict)) {
    return { error: "unparseable_judgment", id: item.id, raw: completion.text.slice(0, 300) };
  }

  return {
    faithfulness: judgment.faithfulness,
    id: item.id,
    rationale: judgment.rationale,
    verdict: judgment.verdict,
  };
};

// Observed agreement plus Cohen's kappa, which discounts the agreement two
// raters would reach by chance given how often each uses each verdict.
export const measureJudgeAgreement = ({ judgments = [], labels = [] }) => {
  const labelById = new Map(labels.map((label) => [label.id, label.verdict]));
  const pairs = judgments
    .filter((judgment) => judgment.verdict && labelById.has(judgment.id))
    .map((judgment) => [judgment.verdict, labelById.get(judgment.id)]);

  if (pairs.length === 0) {
    return null;
  }

  const observed = pairs.filter(([judge, human]) => judge === human).length / pairs.length;
  const share = (index, verdict) =>
    pairs.filter((pair) => pair[index] === verdict).length / pairs.length;
  const expected = JUDGE_VERDICTS.reduce(
    (sum, verdict) => sum + share(0, verdict) * share(1, verdict),
    0
  );

  return {
    agreement: Number(observed.toFixed(4)),
    cohensKappa: expected === 1 ? null : Number(((observed - expected) / (1 - expected)).toFixed(4)),
    labeledItems: pairs.length,
  };
};

const readItems = async (filePath) => {
  const parsed = JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8"));
  return Array.isArray(parsed) ? parsed : parsed?.items ?? [];
};

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) {
      args[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    throw new Error("--input <answers.json> is required.");
  }

  const items = await readItems(args.input);
  const judgments = [];

  for (const item of items) {
    judgments.push(await judgeAnswer(item));
  }

  const labels = args.labels ? await readItems(args.labels) : [];
  const report = {
    agreement: measureJudgeAgreement({ judgments, labels }),
    generatedAt: new Date().toISOString(),
    judgments,
    reportType: "llm-judge",
    verdictCounts: Object.fromEntries(
      [...JUDGE_VERDICTS, "unparseable"].map((verdict) => [
        verdict,
        judgments.filter((judgment) => (judgment.verdict ?? "unparseable") === verdict).length,
      ])
    ),
  };
  const latestName = args["latest-name"] ?? "latest-llm-judge";

  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ agreement: report.agreement, verdictCounts: report.verdictCounts }, null, 2));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
