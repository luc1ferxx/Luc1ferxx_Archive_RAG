import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

import { createApp } from "../app.js";
import { startTracing } from "../otel.js";
import { createAgentApp } from "../rag/agent-service/app.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { resetServiceClients } from "../rag/service-client.js";

// One /chat through the edge and the agent tier is one trace: the edge's
// forwarding span is the parent of the agent run, across the HTTP hop. Its own
// file because it registers a tracing SDK for the whole process.

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";
process.env.INTERNAL_SERVICE_KEYS = `roles-tracing:${"t".repeat(48)}`;

const QUESTION = "What is the tracing allocation amount?";

const options = () => {
  const documents = new Map([["doc-1", { docId: "doc-1", fileName: "notes.pdf" }]]);

  return {
    chatMcp: async () => ({ text: "web" }),
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService: {
      buildHealthReport: async () => ({ checks: {}, status: "ok" }),
      runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
    },
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService: {
      chat: async () => ({ citations: [], text: "The amount is 5 [Source 1]." }),
      getDocument: (docId) => documents.get(docId) ?? null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [...documents.values()],
    },
  };
};

const listen = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return server;
};

const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

test("the edge's forwarding span is the parent of the agent run across the hop", async (t) => {
  const exporter = new InMemorySpanExporter();
  const provider = startTracing({ batch: false, exporters: [exporter] });
  t.after(() => provider.shutdown());

  const agentServer = await listen(await createAgentApp(options()));
  const previous = {
    AGENT_SERVICE_URL: process.env.AGENT_SERVICE_URL,
    ARCHIVE_RAG_ROLE: process.env.ARCHIVE_RAG_ROLE,
  };

  process.env.AGENT_SERVICE_URL = `http://127.0.0.1:${agentServer.address().port}`;
  process.env.ARCHIVE_RAG_ROLE = "api";
  resetServiceClients();

  let edgeServer;

  try {
    edgeServer = await listen(await createApp(options()));

    const response = await fetch(`http://127.0.0.1:${edgeServer.address().port}/chat`, {
      body: JSON.stringify({ docId: "doc-1", question: QUESTION }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    assert.equal(response.status, 200);
    await response.json();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const [forward] = spans.filter((span) => span.name === "POST /chat");
    const [run] = spans.filter((span) => span.name === "invoke_agent archive_rag");

    assert.ok(forward, "the edge records its forwarding span");
    assert.ok(run, "the agent tier records the run");
    assert.equal(forward.kind, 2 /* SpanKind.CLIENT */);
    assert.equal(forward.attributes["url.template"], "/chat");
    assert.equal(forward.attributes["http.response.status_code"], 200);
    assert.equal(run.spanContext().traceId, forward.spanContext().traceId);
    assert.equal(
      run.parentSpanContext?.spanId ?? run.parentSpanId,
      forward.spanContext().spanId
    );

    // Identifiers and statuses only: the question never becomes an attribute.
    for (const span of spans) {
      assert.equal(JSON.stringify(span.attributes).includes("tracing allocation"), false);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    if (edgeServer) {
      await close(edgeServer);
    }

    await close(agentServer);
  }
});
