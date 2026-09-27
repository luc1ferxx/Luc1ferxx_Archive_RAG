import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { configureEmbeddingDimensions } from "../rag/config.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import {
  configurePgvectorRuntime,
  resetPgvectorRuntime,
  resetPgvectorVectorStore,
} from "../rag/vector-store-pgvector.js";
import { main, parseArgs } from "../vector-index.mjs";
import { createFakeVersionDatabase } from "./pgvector-version-fake-database.mjs";

// `npm run vector:index` end to end on the fake database: argument parsing,
// every command's output, and the exit code of a failed validation. The
// stored "PDFs" are real ones, so a CLI build parses them with the same loader
// ingest uses.

const MODEL = "cli-embed-a";
const NEW_MODEL = "cli-embed-b";
const ENV_KEYS = [
  "OPENAI_EMBEDDING_MODEL",
  "RAG_INDEX_VERSION_POINTER_TTL_MS",
  "RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS",
  "RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS",
  "VECTOR_STORE_PROVIDER",
];
let savedEnv;
let tempDirectory;

const embedTopic = (text, dimensions) =>
  Array.from({ length: dimensions }, (_, index) =>
    String(text).toLowerCase().includes(["alpha", "beta", "gamma", "delta"][index] ?? "~") ? 1 : 0.01
  );

const capture = () => {
  const chunks = [];

  return { stdout: { write: (text) => chunks.push(String(text)) }, text: () => chunks.join("") };
};

const run = async (argv) => {
  const output = capture();
  const result = await main({ argv, stdout: output.stdout });

  return { output: output.text(), result };
};

const useDatabase = () => {
  const database = createFakeVersionDatabase();

  configurePgvectorRuntime(database.runtime);

  for (const [docId, sentence] of [["doc-a", "Alpha policy needs approval."], ["doc-b", "Beta budget caps meals."]]) {
    database.state.documents.set(docId, {
      doc_id: docId,
      file_bytes: buildTextPdf({ pages: [[sentence]] }),
      file_name: `${docId}.pdf`,
      owner_user_id: "alice",
      profile: {},
      uploaded_at: "2026-01-01 00:00:00+00",
      workspace_id: "",
    });
    database.state.tables.get("rag_document_chunks").rows.set(`${docId}:0`, {
      chunk_id: `${docId}:0`,
      content: sentence,
      doc_id: docId,
      embedding: `[${embedTopic(sentence, 4).join(",")}]`,
      embedding_dimensions: 4,
      embedding_model: MODEL,
      search_text: sentence,
    });
  }

  return database;
};

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.OPENAI_EMBEDDING_MODEL = MODEL;
  process.env.RAG_INDEX_VERSION_POINTER_TTL_MS = "1000";
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  configureEmbeddingDimensions(4);
  resetPgvectorVectorStore();
  configureOpenAIProvider({
    embedQuery: async (text, options) => embedTopic(text, options?.embeddingSpace?.dimensions ?? 4),
    embedTexts: async (texts, options) =>
      texts.map((text) => embedTopic(text, options?.embeddingSpace?.dimensions ?? 4)),
  });
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vector-index-cli-"));
});

afterEach(async () => {
  resetPgvectorRuntime();
  resetPgvectorVectorStore();
  resetOpenAIProvider();
  configureEmbeddingDimensions(null);
  process.exitCode = undefined;
  await rm(tempDirectory, { force: true, recursive: true });

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("parseArgs reads commands, numbers and --key=value, and rejects what it does not know", () => {
  assert.deepEqual(parseArgs([]), {
    allowChunkCountDrift: false,
    allowUnreadableActive: false,
    command: "status",
    force: false,
    help: false,
    json: false,
    versionId: null,
  });

  const build = parseArgs([
    "build",
    "--model",
    "nomic-embed-text",
    "--dimensions=768",
    "--document-prefix",
    "search_document: ",
    "--index-type",
    "ivfflat",
    "--ivfflat-lists",
    "50",
    "--batch-size",
    "8",
    "--concurrency",
    "6",
    "--json",
  ]);

  assert.equal(build.command, "build");
  assert.equal(build.model, "nomic-embed-text");
  assert.equal(build.dimensions, 768);
  assert.equal(build.documentPrefix, "search_document: ");
  assert.equal(build.indexType, "ivfflat");
  assert.equal(build.ivfflatLists, 50);
  assert.equal(build.batchSize, 8);
  assert.equal(build.concurrency, 6);
  assert.equal(build.json, true);

  const activate = parseArgs(["activate", "3", "--probe-sample", "20", "--min-recall", "0.9", "--allow-chunk-count-drift"]);

  assert.equal(activate.versionId, 3);
  assert.equal(activate.probeSample, 20);
  assert.equal(activate.minRecall, 0.9);
  assert.equal(activate.allowChunkCountDrift, true);
  assert.equal(parseArgs(["retire", "2", "--force"]).force, true);
  assert.equal(parseArgs(["rollback", "--active-unreadable"]).allowUnreadableActive, true);
  assert.equal(parseArgs(["nonsense", "--help"]).help, true, "--help wins over everything else");

  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
  assert.throws(() => parseArgs(["launch"]), /Unknown command "launch"/);
  assert.throws(() => parseArgs(["build", "--model"]), /--model needs a value/);
  assert.throws(() => parseArgs(["build", "--dimensions", "-3"]), /non-negative number/);
  assert.throws(() => parseArgs(["activate"]), /activate needs a version id/);
  assert.throws(() => parseArgs(["retire", "two"]), /retire needs a version id/);
  assert.throws(() => parseArgs(["status", "2"]), /status takes no version id/);
  assert.throws(() => parseArgs(["activate", "2", "3"]), /Unexpected argument: 3/);
  assert.throws(() => parseArgs(["build", "--index-type", "flat"]), /hnsw or ivfflat/);
  assert.throws(() => parseArgs(["activate", "2", "--min-recall", "80"]), /between 0 and 1/);
});

test("--help prints the usage without touching the database; other providers are refused", async () => {
  const { output } = await run(["--help"]);

  assert.match(output, /Usage: node vector-index.mjs <command>/);
  assert.match(output, /vector:reindex rewrites in place/);

  process.env.VECTOR_STORE_PROVIDER = "qdrant";
  await assert.rejects(run(["status"]), { code: "INDEX_VERSION_UNSUPPORTED_PROVIDER" });
});

test("build, validate, activate, rollback, retire and status through the CLI", async () => {
  const database = useDatabase();

  // One document at a time, so the progress line of each one-document batch is
  // its own (with several in flight a batch reports the running totals).
  const built = await run([
    "build", "--model", NEW_MODEL, "--dimensions", "3", "--batch-size", "1", "--concurrency", "1", "--hnsw-m", "20",
  ]);

  assert.match(built.output, /version 2: 1 indexed/);
  assert.match(built.output, /Version 2 is ready: 2 document\(s\) indexed, 0 deleted during the build, 0 failed/);
  assert.equal(database.state.versions.get(2).index_params.hnswM, 20);
  assert.equal(database.state.tables.get("rag_document_chunks_v2").rows.size, 2);

  const validated = await run(["validate", "2"]);

  assert.match(validated.output, /Version 2 against active version 1: PASS/);
  assert.match(validated.output, /2 document\(s\); 2 chunk\(s\) active, 2 in version 2; 0 document\(s\) with a different chunk count/);
  assert.equal(process.exitCode, undefined);

  const queriesFile = path.join(tempDirectory, "queries.json");

  await writeFile(queriesFile, JSON.stringify({ queries: ["alpha approval", { query: "beta meals" }] }));

  const activated = await run([
    "activate",
    "2",
    "--probe-sample",
    "2",
    "--probe-queries",
    queriesFile,
    "--probe-top-k",
    "1",
    "--min-recall",
    "0.5",
    "--grace-ms",
    "60000",
  ]);

  assert.match(activated.output, /self-retrieval recall@1: 1 over 2 chunk\(s\)/);
  assert.match(activated.output, /agreement@1 with the active version: 1 over 2 quer\(ies\)/);
  assert.match(activated.output, /Active version is now 2 \(was 1; it keeps receiving writes until /);

  const status = await run(["status"]);

  assert.match(status.output, /Active version: 2 \(pointer generation 2/);
  assert.match(status.output, /Previous version: 1/);
  assert.match(status.output, /\s+2\s+active\s+rag_document_chunks_v2\s+cli-embed-b\/3 \(pinned\)\s+chunks=2/);
  assert.match(status.output, /WARNING configuration_differs_from_active/);

  const statusJson = JSON.parse((await run(["status", "--json"])).output);

  assert.equal(statusJson.active.versionId, 2);

  const rolledBack = await run(["rollback", "--json"]);

  assert.equal(JSON.parse(rolledBack.output).activeVersionId, 1);

  database.clock.now += 2001;

  const retired = await run(["retire", "2", "--force"]);

  assert.match(retired.output, /Version 2 retired \(dropped rag_document_chunks_v2 and its sparse-rank function\)/);
  await assert.rejects(run(["resume"]), { code: "INDEX_VERSION_NOT_FOUND" });
});

test("a retire whose drop cannot get its lock says so, fails the exit code, and a second retire finishes it", async () => {
  const database = useDatabase();

  await run(["build", "--model", NEW_MODEL, "--dimensions", "3", "--json"]);
  database.state.lockedTables = new Set(["rag_document_chunks_v2"]);
  process.env.RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS = "2";
  process.env.RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS = "1";

  const pending = await run(["retire", "2"]);

  assert.match(pending.output, /Version 2 retired: it takes no writes\. Dropping rag_document_chunks_v2 did not get its lock .* run retire 2 again to finish/);
  assert.equal(process.exitCode, 1);
  assert.equal(database.state.versions.get(2).status, "retired");

  process.exitCode = undefined;
  database.state.lockedTables.clear();

  const finished = await run(["retire", "2"]);

  assert.match(finished.output, /Version 2 retired \(dropped rag_document_chunks_v2/);
  assert.equal(process.exitCode, undefined);
});

test("a failed validation prints its reasons and sets a failing exit code", async () => {
  const database = useDatabase();

  await run(["build", "--model", NEW_MODEL, "--dimensions", "3", "--json"]);
  database.state.tables.get("rag_document_chunks_v2").rows.clear();

  const { output, result } = await run(["validate", "2"]);

  assert.equal(result.ok, false);
  assert.match(output, /FAIL/);
  assert.match(output, /- 2 document\(s\) have a different chunk count/);
  assert.equal(process.exitCode, 1);
});

test("a stalled build shows in the status and resumes through the CLI", async () => {
  const database = useDatabase();

  database.addDocument({ docId: "doc-c", pages: "no pdf" });
  database.state.versions.set(2, {
    build_documents_done: 0,
    build_documents_failed: 0,
    build_documents_total: 3,
    builder_id: "gone",
    chunk_table: "rag_document_chunks_v2",
    dual_write_until: null,
    embedding_dimensions: 3,
    embedding_document_prefix: "",
    embedding_identity: NEW_MODEL,
    embedding_model: NEW_MODEL,
    embedding_query_prefix: "",
    embedding_space_source: "pinned",
    index_params: {},
    lease_expires_at: new Date(database.clock.now - 1),
    sparse_rank_function: "rag_document_chunks_v2_sparse_rank",
    status: "building",
    version_id: 2,
  });
  database.state.tables.set("rag_document_chunks_v2", { dimensions: 3, rows: new Map() });

  const status = await run(["status"]);

  assert.match(status.output, /Building: version 2 -- 0\/3 document\(s\), 0 failed, builder gone \(lease expired\)/);
  assert.match(status.output, /WARNING build_stalled/);

  const resumed = await run(["resume", "--json"]);
  const summary = JSON.parse(resumed.output);

  assert.equal(summary.indexed, 2);
  assert.equal(summary.failed, 1, "the document whose bytes are not a PDF");

  const absent = createFakeVersionDatabase({ registry: false });

  configurePgvectorRuntime(absent.runtime);
  assert.match((await run(["status"])).output, /Index version registry: absent/);
});

test("probe queries must be a JSON array", async () => {
  useDatabase();

  const queriesFile = path.join(tempDirectory, "queries.json");

  await writeFile(queriesFile, JSON.stringify({ questions: "alpha" }));
  await assert.rejects(run(["validate", "2", "--probe-queries", queriesFile]), /must hold a JSON array of queries/);
});
