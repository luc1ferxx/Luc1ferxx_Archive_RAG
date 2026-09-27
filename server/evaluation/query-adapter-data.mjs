// query-adapter-data.mjs
//
// Training data for the query-side embedding adapter (rag/query-adapter.js):
// QASPER questions and every chunk of their papers, embedded exactly as the
// app embeds them -- the ingest chunker (chunkDocumentPages) and embedTexts
// with the document task prefix for chunks, embedQuery with the query task
// prefix for questions, with no adapter. A chunk is a positive for a question
// when its page (one QASPER paragraph) is an annotated evidence paragraph;
// every other chunk of the same paper is a hard negative.
// evaluation/train-query-adapter.py reads the output.
//
// Usage (local Ollama, nothing downloaded):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768 \
//   node evaluation/query-adapter-data.mjs
//     [--corpus evaluation/generated/qasper-train.json]
//     [--out evaluation/generated/query-adapter/qasper-train]
//     [--papers <n>]   first n papers only (smoke runs)
//
// Writes <out>.meta.json plus <out>.chunks.f32 and <out>.questions.f32
// (little-endian float32, one row per chunk / question).

import "dotenv/config";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const QUERY_ADAPTER_DATA_FORMAT = "archive-rag.query-adapter-data/v1";

/** Answerable questions with paragraph-level evidence, as the retrieval eval selects them. */
export const selectAdapterTrainingCases = (corpus) =>
  (corpus?.cases ?? []).filter(
    (testCase) => !testCase.shouldAbstain && testCase.expectedEvidence?.[0]?.pages?.length && testCase.docKeys?.[0]
  );

/**
 * The index the trainer works on. `chunksByPaper` maps a paper key to its
 * chunks' page numbers in embedding order. A question's positives are the
 * chunks on any of its evidence pages; a question none of whose evidence
 * survived chunking is dropped (counted, never silently kept).
 */
export const buildAdapterTrainingIndex = ({ cases, chunksByPaper }) => {
  const papers = [...chunksByPaper.keys()];
  const paperIndex = new Map(papers.map((key, index) => [key, index]));
  const chunkPaper = [];
  const chunkPage = [];
  const firstChunk = new Map();

  for (const [key, pageNumbers] of chunksByPaper) {
    firstChunk.set(key, chunkPaper.length);

    for (const pageNumber of pageNumbers) {
      chunkPaper.push(paperIndex.get(key));
      chunkPage.push(Number(pageNumber));
    }
  }

  const questions = [];
  let dropped = 0;

  for (const testCase of cases) {
    const key = testCase.docKeys[0];

    if (!paperIndex.has(key)) {
      continue;
    }

    const evidence = new Set(testCase.expectedEvidence[0].pages.map(Number));
    const start = firstChunk.get(key);
    const positives = chunksByPaper
      .get(key)
      .map((pageNumber, offset) => (evidence.has(Number(pageNumber)) ? start + offset : -1))
      .filter((index) => index >= 0);

    if (positives.length === 0) {
      dropped += 1;
      continue;
    }

    questions.push({ id: testCase.id, paper: paperIndex.get(key), positives, question: testCase.question });
  }

  return { chunkPage, chunkPaper, dropped, papers, questions };
};

const toFloat32Bytes = (vectors, dimensions) => {
  const array = new Float32Array(vectors.length * dimensions);

  vectors.forEach((vector, row) => {
    if (!Array.isArray(vector) || vector.length !== dimensions) {
      throw new Error(
        `Embedding ${row} has ${vector?.length ?? 0} dimensions but RAG_EMBEDDING_DIMENSIONS resolves to ${dimensions}; set it to the model's width so the adapter matches the configured space.`
      );
    }

    array.set(vector, row * dimensions);
  });

  return Buffer.from(array.buffer);
};

// A local embedding server can restart its runner mid-run and report it as a
// 400; a long export should not be lost to one such blip.
const withAttempts = async (label, action) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= 6) {
        throw error;
      }

      console.warn(`${label} failed (${error.message}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const corpusPath = path.resolve(process.cwd(), option("--corpus", path.join(__dirname, "generated", "qasper-train.json")));
  const outPrefix = path.resolve(
    process.cwd(),
    option("--out", path.join(__dirname, "generated", "query-adapter", "qasper-train"))
  );
  const paperLimit = Number(option("--papers", "0")) || 0;
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

  if (corpus.metadata?.granularity !== "paragraph") {
    throw new Error("Build the corpus with import-qasper.mjs --granularity paragraph so evidence is paragraph-level.");
  }

  // Training vectors are the model's own: never adapted by a previous adapter.
  delete process.env.RAG_EMBEDDING_QUERY_ADAPTER;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "query-adapter-data-"));
  process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");

  try {
    const { chunkDocumentPages } = await import("../rag/index.js");
    const { embedQuery, embedTexts } = await import("../rag/openai.js");
    const config = await import("../rag/config.js");
    const cases = selectAdapterTrainingCases(corpus);
    const wanted = new Set(cases.map((testCase) => testCase.docKeys[0]));
    const documents = corpus.documents.filter((doc) => wanted.has(doc.key)).slice(0, paperLimit || undefined);
    const chunksByPaper = new Map();
    const chunkTexts = [];

    for (const doc of documents) {
      const { documents: chunks } = chunkDocumentPages({
        docId: doc.key,
        fileName: doc.fileName,
        pages: doc.pages.map((text, index) => ({ pageNumber: index + 1, text })),
      });

      chunksByPaper.set(doc.key, chunks.map((chunk) => Number(chunk.metadata.pageNumber)));
      chunkTexts.push(...chunks.map((chunk) => chunk.pageContent));
    }

    const index = buildAdapterTrainingIndex({ cases, chunksByPaper });
    const chunksPath = `${outPrefix}.chunks.f32`;
    const questionsPath = `${outPrefix}.questions.f32`;
    const progressPath = `${outPrefix}.progress.json`;
    const dimensions = config.getEmbeddingDimensions();
    // A long export resumes where an interrupted one stopped, but only onto
    // rows written for the same corpus, chunk list and embedding space.
    const progressKey = JSON.stringify([
      path.basename(corpusPath),
      chunkTexts.length,
      config.getEmbeddingModel(),
      config.getEmbeddingDocumentPrefix(),
      dimensions,
    ]);
    const previous = await readFile(progressPath, "utf8").then(JSON.parse, () => null);
    const writtenBytes = await stat(chunksPath).then((info) => info.size, () => -1);
    let done =
      previous?.key === progressKey && writtenBytes === previous.rows * dimensions * 4 ? previous.rows : 0;

    await mkdir(path.dirname(outPrefix), { recursive: true });

    if (done === 0) {
      await writeFile(chunksPath, Buffer.alloc(0));
    }

    console.log(
      `Embedding ${chunkTexts.length - done} of ${chunkTexts.length} chunks of ${documents.length} papers and ${index.questions.length} questions (${index.dropped} dropped: no evidence chunk)...`
    );

    const startedAt = Date.now();
    const GROUP = 256;

    for (let offset = done; offset < chunkTexts.length; offset += GROUP) {
      const vectors = await withAttempts(`chunks ${offset}`, () => embedTexts(chunkTexts.slice(offset, offset + GROUP)));

      await appendFile(chunksPath, toFloat32Bytes(vectors, dimensions));
      done = offset + vectors.length;
      await writeFile(progressPath, JSON.stringify({ key: progressKey, rows: done }));

      if ((offset / GROUP) % 20 === 0) {
        console.log(`chunks ${done}/${chunkTexts.length} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
      }
    }

    const questionVectors = [];

    for (const [position, question] of index.questions.entries()) {
      questionVectors.push(await withAttempts(`question ${question.id}`, () => embedQuery(question.question)));

      if ((position + 1) % 500 === 0) {
        console.log(`questions ${position + 1}/${index.questions.length}`);
      }
    }

    await writeFile(questionsPath, toFloat32Bytes(questionVectors, dimensions));

    const meta = {
      chunkPage: index.chunkPage,
      chunkPaper: index.chunkPaper,
      corpus: path.basename(corpusPath),
      counts: {
        chunks: chunkTexts.length,
        droppedQuestions: index.dropped,
        papers: index.papers.length,
        questions: index.questions.length,
      },
      embedding: {
        dimensions,
        documentPrefix: config.getEmbeddingDocumentPrefix(),
        identity: config.getEmbeddingIndexIdentity(),
        model: config.getEmbeddingModel(),
        queryPrefix: config.getEmbeddingQueryPrefix(),
      },
      files: { chunks: path.basename(chunksPath), questions: path.basename(questionsPath) },
      format: QUERY_ADAPTER_DATA_FORMAT,
      generatedAt: new Date().toISOString(),
      papers: index.papers,
      questions: index.questions.map(({ id, paper, positives }) => ({ id, paper, positives })),
    };

    await writeFile(`${outPrefix}.meta.json`, `${JSON.stringify(meta)}\n`);
    console.log(`Wrote ${outPrefix}.meta.json (${Math.round((Date.now() - startedAt) / 1000)} s).`);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
