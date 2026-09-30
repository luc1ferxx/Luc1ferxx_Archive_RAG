import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

// One trace across tiers: the remote retrieval call's client span and the
// retrieval tier's server span share a trace, the server span is the client
// span's child, and neither carries query or document text.

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "retrieval-tracing-test-"));
process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");

const SECRET = "t".repeat(24) + "-tracing-secret-0123456789";
const ENVIRONMENT = {
  INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
  OPENAI_EMBEDDING_MODEL: "retrieval-tracing-test-model",
  RAG_HYBRID_ENABLED: "true",
  RAG_OBSERVABILITY_ENABLED: "false",
  RAG_RERANK_ENABLED: "false",
  VECTOR_STORE_PROVIDER: "local",
};
const savedEnvironment = Object.fromEntries(
  [...Object.keys(ENVIRONMENT), "ARCHIVE_RAG_ROLE", "RETRIEVAL_SERVICE_URL"].map((key) => [key, process.env[key]])
);

Object.assign(process.env, ENVIRONMENT);
delete process.env.ARCHIVE_RAG_ROLE;

const { startTracing } = await import("../otel.js");
const { withSpan } = await import("../rag/tracing.js");
const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const { configureDocumentRegistryStore, resetDocumentRegistry, resetDocumentRegistryStore } = await import(
  "../rag/doc-registry.js"
);
const { createFileDocumentRegistryStore } = await import("../rag/doc-registry-file.js");
const ragIndex = await import("../rag/index.js");
const { resetVectorStore } = await import("../rag/vector-store.js");
const { resetServiceClients } = await import("../rag/service-client.js");
const { createRetrievalApp } = await import("../rag/retrieval-service/app.js");
const { retrieveGlobalContextRemotely } = await import("../rag/retrieval-service/remote-retrieval.js");

const QUESTION = "confidential question about annual leave days";
const CHUNK_TEXT = "Confidential chunk: employees receive ten paid annual leave days each year.";
const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-a" };

after(async () => {
  resetOpenAIProvider();
  resetServiceClients();
  resetVectorStore();
  await resetDocumentRegistryStore();

  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  rmSync(tempRoot, { force: true, recursive: true });
});

test("a remote retrieval continues the caller's trace, with counts and ids only on its spans", async (t) => {
  const exporter = new InMemorySpanExporter();
  const provider = startTracing({ batch: false, exporters: [exporter] });

  t.after(() => provider.shutdown());

  await resetDocumentRegistryStore();
  await resetDocumentRegistry();
  configureDocumentRegistryStore(createFileDocumentRegistryStore());
  resetVectorStore();
  configureOpenAIProvider({
    completeText: async () => "unused",
    embedQuery: async (query) => [query.length % 7, 1, 0.5],
    embedTexts: async (texts) => texts.map((text) => [text.length % 7, 1, 0.5]),
  });

  const fixtureFile = path.join(tempRoot, "fixture.pdf");

  writeFileSync(fixtureFile, "fixture", "utf8");
  await ragIndex.ingestDocumentPages({
    docId: "leave-policy",
    fileName: "leave-policy.pdf",
    filePath: fixtureFile,
    ownerUserId: ALICE.userId,
    pages: [{ pageNumber: 1, text: CHUNK_TEXT }],
    workspaceId: ALICE.workspaceId,
  });

  const server = http.createServer(createRetrievalApp({ logger: { error() {}, log() {}, warn() {} } }));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  process.env.RETRIEVAL_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  resetServiceClients();

  const search = await withSpan("test.agent_step", {}, () =>
    retrieveGlobalContextRemotely({
      accessScope: ALICE,
      docIds: ["leave-policy"],
      retrievalQueries: [{ id: "primary", primary: true, query: QUESTION }],
    })
  );

  assert.ok(search.results.length > 0);

  const spans = exporter.getFinishedSpans();
  const root = spans.find((span) => span.name === "test.agent_step");
  const client = spans.find((span) => span.name === "retrieval.remote global");
  const serverSpan = spans.find((span) => span.name === "retrieval global");

  assert.ok(root && client && serverSpan, spans.map((span) => span.name).join(", "));
  assert.equal(client.kind, SpanKind.CLIENT);
  assert.equal(serverSpan.kind, SpanKind.SERVER);

  const traceId = root.spanContext().traceId;
  const parentOf = (span) => span.parentSpanContext?.spanId ?? span.parentSpanId;

  assert.equal(client.spanContext().traceId, traceId);
  assert.equal(serverSpan.spanContext().traceId, traceId, "the retrieval tier joined the caller's trace");
  assert.equal(parentOf(client), root.spanContext().spanId);
  assert.equal(parentOf(serverSpan), client.spanContext().spanId);
  assert.equal(serverSpan.attributes["retrieval.document_count"], 1);
  assert.equal(serverSpan.attributes["retrieval.query_count"], 1);
  assert.equal(serverSpan.attributes["retrieval.result_count"], search.results.length);
  assert.equal(client.attributes["http.response.status_code"], 200);

  // Spans under the retrieval tier's span (the query embedding) share its trace.
  const embeddingSpans = spans.filter((span) => parentOf(span) === serverSpan.spanContext().spanId);

  assert.ok(embeddingSpans.every((span) => span.spanContext().traceId === traceId));

  const recorded = JSON.stringify(
    spans.map((span) => ({ attributes: span.attributes, events: span.events, name: span.name }))
  );

  for (const secretText of [QUESTION, "confidential", "Confidential chunk", SECRET, "alice"]) {
    assert.ok(!recorded.includes(secretText), `span data never carries ${JSON.stringify(secretText)}`);
  }
});
