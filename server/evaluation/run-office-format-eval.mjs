// run-office-format-eval.mjs
//
// Asks the questions of the Office format corpus (build-office-format-corpus.mjs,
// office-format-eval.js) of every document twice: of the Office file, read by
// its own loader, and of the PDF the same application exported, read by
// pdf.js. Both go through ingestDocument, the function behind an upload,
// into one throwaway standalone archive (docIds <id>__native and <id>__pdf);
// each question goes to the single-document QA route of that version.
// Speaker-notes questions are asked of the native deck only, since the PDF
// export carries no notes.
//
// Per question and arm the report keeps whether the system abstained, whether
// the evidence (the sheet row, the slide fact, a gold extractive span) was in
// the chunks the model was shown (none when the QA gate refuses, so it is
// false on every gate refusal), the answer text, and the score: the gold value
// given (sheet, deck) or the QASPER answer F1 with an abstention scored 0
// (word).
// Summaries are native minus PDF with bootstrap 95% intervals by question
// and by document. The manifest's file digests are checked before anything
// is ingested.
//
// Usage (a chat model and embeddings, here Ollama; the answer-side protocol):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_CHAT_MODEL=qwen2.5:7b OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   RAG_EMBEDDING_DIMENSIONS=768 RAG_ANSWER_TEMPERATURE=0 RAG_ANSWER_MAX_TOKENS=1024 \
//   node evaluation/run-office-format-eval.mjs
//     [--manifest evaluation/generated/office-formats/manifest.json] [--corpora word,sheet,deck]
//     [--iterations 10000] [--seed 1] [--concurrency 1] [--latest-name latest-office-formats]

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { useEvaluationDataDirectory } from "./eval-data-directory.mjs";
import {
  describeChunkingConfig,
  describeEvaluationCheckout,
  describePdfConfig,
  describeRetrievalConfig,
  sumTextChars,
} from "./eval-run-config.js";
import {
  OFFICE_FORMAT_ARMS,
  OFFICE_FORMAT_CORPORA,
  formatOfficeFormatMarkdown,
  scoreArmAnswer,
  summarizeOfficeFormatRows,
} from "./office-format-eval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** The arms a question is asked of: notes questions only of the native deck. */
export const armsForQuestion = (question) => (question.group === "notes" ? ["native"] : [...OFFICE_FORMAT_ARMS]);

const parseArgs = (args) => {
  const option = (name, fallback) => {
    const index = args.indexOf(name);

    return index >= 0 ? args[index + 1] : fallback;
  };
  const corpora = String(option("--corpora", OFFICE_FORMAT_CORPORA.join(",")))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const corpus of corpora) {
    if (!OFFICE_FORMAT_CORPORA.includes(corpus)) {
      throw new Error(`--corpora takes ${OFFICE_FORMAT_CORPORA.join(", ")}; got ${corpus}.`);
    }
  }

  return {
    concurrency: Math.max(1, Number.parseInt(option("--concurrency", "1"), 10) || 1),
    corpora,
    iterations: Math.max(100, Number.parseInt(option("--iterations", "10000"), 10) || 10000),
    latestName: option("--latest-name", "latest-office-formats"),
    manifest: path.resolve(
      process.cwd(),
      option("--manifest", path.join(__dirname, "generated", "office-formats", "manifest.json"))
    ),
    seed: Number.parseInt(option("--seed", "1"), 10) || 1,
  };
};

const main = async () => {
  // Only when run as a command (DOTENV_CONFIG_PATH honoured), never when a
  // test imports the module.
  await import("dotenv/config");

  const options = parseArgs(process.argv.slice(2));
  const manifestBytes = await readFile(options.manifest);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const corpusDirectory = path.dirname(options.manifest);
  const documents = manifest.documents.filter((document) => options.corpora.includes(document.corpus));

  // The files must be the ones the manifest describes.
  for (const document of documents) {
    for (const [file, digest] of [
      [document.native, document.nativeSha256],
      [document.pdf, document.pdfSha256],
    ]) {
      if (sha256(await readFile(path.join(corpusDirectory, file))) !== digest) {
        throw new Error(`${file} does not match the manifest's digest.`);
      }
    }
  }

  const git = await describeEvaluationCheckout();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "office-formats-"));

  useEvaluationDataDirectory(path.join(tempRoot, "rag-data"));
  process.env.DOCCOMPARE_STANDALONE = "1";
  Object.assign(process.env, { RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false", RAG_LONG_MEMORY_ENABLED: "false" });

  const { applyStandaloneProfile } = await import("../standalone-profile.js");

  applyStandaloneProfile();

  const rag = await import("../chat.js");
  const ragConfig = await import("../rag/config.js");
  const failures = [];
  const ingested = [];
  const rows = [];
  const accessScope = { authenticated: false, userId: "", workspaceId: "" };

  try {
    await rag.initializeDocumentRegistry();

    for (const document of documents) {
      const arms = {};

      try {
        for (const arm of OFFICE_FORMAT_ARMS) {
          const filePath = path.join(corpusDirectory, arm === "native" ? document.native : document.pdf);
          const result = await rag.ingestDocument({
            docId: `${document.id}__${arm}`,
            fileName: path.basename(filePath),
            filePath,
            formats: [arm === "native" ? document.format : "pdf"],
          });

          arms[arm] = { chunkCount: result.chunkCount ?? null, pageCount: result.pageCount ?? null };
        }
      } catch (error) {
        failures.push({ arm: "ingest", docId: document.id, reason: error?.code ?? error?.message ?? String(error) });
        continue;
      }

      ingested.push({ arms, corpus: document.corpus, id: document.id });
      console.log(`ingested ${document.corpus} ${document.id}`);
    }

    const ingestedIds = new Set(ingested.map((document) => document.id));
    const questions = manifest.questions.filter(
      (question) => options.corpora.includes(question.corpus) && ingestedIds.has(question.docId)
    );
    const rowsByIndex = new Array(questions.length);
    let nextIndex = 0;
    let completed = 0;

    const askQuestion = async (index) => {
      const question = questions[index];
      const row = {
        corpus: question.corpus,
        docId: question.docId,
        gold: question.gold,
        group: question.group,
        id: question.id,
        native: null,
        pdf: null,
        question: question.question,
      };

      for (const arm of armsForQuestion(question)) {
        const result = await rag.default([`${question.docId}__${arm}`], question.question, {
          accessScope,
          includeRetrievedContexts: true,
          sessionId: `office-${question.id}-${arm}`,
        });
        const contexts = (result?.retrievedContexts ?? []).map((entry) => entry.text ?? entry.pageContent ?? "");

        row[arm] = {
          ...scoreArmAnswer({ abstained: result?.abstained, contexts, question, text: result?.text }),
          answer: String(result?.text ?? ""),
          contextChars: sumTextChars(contexts),
        };
      }

      rowsByIndex[index] = row;
      completed += 1;
      console.log(`${String(completed).padStart(4)}/${questions.length} ${question.corpus} ${question.group}`);
    };

    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, questions.length) }, async () => {
        while (nextIndex < questions.length) {
          const index = nextIndex;

          nextIndex += 1;
          await askQuestion(index);
        }
      })
    );
    rows.push(...rowsByIndex);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }

  const report = {
    config: {
      answerMaxTokens: ragConfig.getAnswerMaxTokens(),
      answerTemperature: ragConfig.getAnswerTemperature(),
      chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
      chunking: await describeChunkingConfig(),
      concurrency: options.concurrency,
      corpora: options.corpora,
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? null,
      git,
      iterations: options.iterations,
      manifest: {
        documents: manifest.documents.length,
        file: path.basename(options.manifest),
        generatedAt: manifest.generatedAt,
        office: manifest.office,
        questions: manifest.questions.length,
        seed: manifest.seed,
        sha256: sha256(manifestBytes),
        version: manifest.version,
      },
      pdf: await describePdfConfig(),
      retrieval: await describeRetrievalConfig(),
      seed: options.seed,
    },
    documents: ingested,
    failures,
    generatedAt: new Date().toISOString(),
    reportType: "office-formats",
    rows,
    summary: summarizeOfficeFormatRows(rows, { iterations: options.iterations, seed: options.seed }),
  };

  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, `${options.latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDirectory, `${options.latestName}.md`), `${formatOfficeFormatMarkdown(report)}\n`);
  process.stdout.write(formatOfficeFormatMarkdown(report));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
