// archive-ingest.mjs with Word, PowerPoint and Excel files: the command runs
// as a child process in standalone mode (file registry, local index) against
// the demo's fake embedding model, with an empty dotenv file so no server/.env
// reaches it. With the default RAG_DOCUMENT_FORMATS it ingests a .docx, a
// .pptx and a PDF side by side and records each one's MIME type and located
// chunks; a refused file says why with its code and the rest still ingest;
// RAG_DOCUMENT_FORMATS=pdf restores the PDF-only checks and messages; an
// invalid setting ends the command before any file is read.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEMO_FAKE_MODEL_DIMENSIONS, startDemoFakeModel } from "../demo/fake-model.js";
import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildDocx, buildOle2Bytes, buildPptx } from "./office-fixture-builder.mjs";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
const MIME = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});

let tempRoot;
let model;
let emptyEnvironmentFile;
let runCount = 0;

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "archive-ingest-office-"));
  emptyEnvironmentFile = path.join(tempRoot, "empty.env");
  await writeFile(emptyEnvironmentFile, "", "utf8");
  model = await startDemoFakeModel({ port: 0 });

  for (const [name, bytes] of Object.entries({
    "deck.pptx": buildPptx({
      slides: [
        { shapes: [{ paragraphs: ["Budget approved for the pilot program."], x: 1, y: 2 }], title: "Kickoff" },
        { shapes: [{ paragraphs: ["The rollout starts in May."], x: 1, y: 2 }], title: "Plan" },
      ],
    }),
    "policy.pdf": buildTextPdf({ pages: [["The travel policy needs manager approval."]] }),
    "protected.docx": buildOle2Bytes(),
    "report.docx": buildDocx({
      blocks: [
        { heading: 1, text: "Retention" },
        { text: "Signed contracts are kept for seven years after they end." },
      ],
    }),
    "word-bytes.pdf": buildDocx({ blocks: [{ text: "A Word document under a PDF name." }] }),
  })) {
    await writeFile(path.join(tempRoot, name), bytes);
  }
});

after(async () => {
  await new Promise((resolve) => (model ? model.server.close(resolve) : resolve()));
  await rm(tempRoot, { force: true, recursive: true });
});

// One run of the command in a data directory of its own. The fake model
// answers in this process, so the child is awaited, never run synchronously.
const runArchiveIngest = async (files, env = {}) => {
  runCount += 1;

  const dataDirectory = path.join(tempRoot, `rag-data-${runCount}`);
  const child = spawn(
    process.execPath,
    [path.join(serverDirectory, "archive-ingest.mjs"), ...files.map((name) => path.join(tempRoot, name))],
    {
      cwd: tempRoot,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
        DOCCOMPARE_STANDALONE: "1",
        DOTENV_CONFIG_PATH: emptyEnvironmentFile,
        DOTENV_CONFIG_QUIET: "true",
        OPENAI_API_KEY: "archive-ingest-office-test",
        OPENAI_BASE_URL: model.url,
        OPENAI_EMBEDDING_MODEL: "archive-ingest-fake-embed",
        RAG_DATA_DIRECTORY: dataDirectory,
        RAG_EMBEDDING_DIMENSIONS: String(DEMO_FAKE_MODEL_DIMENSIONS),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const status = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));

  return { dataDirectory, status, stderr, stdout };
};

const readJsonFile = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

test("archive-ingest ingests a .docx and a .pptx beside a PDF, each with its MIME type and located chunks", async () => {
  const run = await runArchiveIngest(["report.docx", "deck.pptx", "policy.pdf", "protected.docx"]);

  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  // The legacy file says why, with its code; the others are ingested anyway.
  assert.match(
    run.stderr,
    /Failed: protected\.docx -- protected\.docx: Legacy or password-protected Office files are not supported; .* \(DOCUMENT_FORMAT_LEGACY_OFFICE\)/
  );
  assert.match(run.stderr, /1 of 4 file\(s\) failed to ingest\./);

  const registered = await readJsonFile(path.join(run.dataDirectory, "documents.json"));
  const byName = Object.fromEntries(registered.map((document) => [document.fileName, document]));

  assert.deepEqual(Object.keys(byName).sort(), ["deck.pptx", "policy.pdf", "report.docx"]);
  assert.equal(byName["report.docx"].mimeType, MIME.docx);
  assert.equal(byName["deck.pptx"].mimeType, MIME.pptx);
  assert.equal(byName["policy.pdf"].mimeType, MIME.pdf);

  const chunks = await readJsonFile(path.join(run.dataDirectory, "vector-index.json"));
  const unitsOf = (fileName) =>
    [...new Set(chunks.filter((chunk) => chunk.metadata.docId === byName[fileName].docId).map((chunk) => chunk.metadata.locationUnit))];

  assert.deepEqual(unitsOf("report.docx"), ["section"]);
  assert.deepEqual(unitsOf("deck.pptx"), ["slide"]);
  assert.deepEqual(unitsOf("policy.pdf"), [undefined], "a PDF's chunks carry no location");
});

test("archive-ingest under RAG_DOCUMENT_FORMATS=pdf checks and answers exactly as before Office formats", async () => {
  const run = await runArchiveIngest(["report.docx", "word-bytes.pdf"], { RAG_DOCUMENT_FORMATS: "pdf" });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /Failed: report\.docx -- Not an acceptable PDF file name: report\.docx/);
  assert.match(run.stderr, /Failed: word-bytes\.pdf -- word-bytes\.pdf does not contain a %PDF header, so it is not a PDF\./);
  assert.match(run.stderr, /2 of 2 file\(s\) failed to ingest\./);

  // With Office formats the same Word bytes under a PDF name are a Word document.
  const office = await runArchiveIngest(["word-bytes.pdf"]);

  assert.equal(office.status, 0, `${office.stdout}\n${office.stderr}`);
  assert.equal((await readJsonFile(path.join(office.dataDirectory, "documents.json")))[0].mimeType, MIME.docx);
});

test("archive-ingest refuses an invalid RAG_DOCUMENT_FORMATS before it reads any file", async () => {
  const run = await runArchiveIngest(["report.docx"], { RAG_DOCUMENT_FORMATS: "pdf,odt" });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /RAG_DOCUMENT_FORMATS must be a comma list of pdf, docx, pptx, xlsx/);
  assert.doesNotMatch(run.stderr, /Failed: /);
  assert.equal(run.stdout, "");
});
