// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { runAgentRag } from "../rag/agent.js";
import { configureAgentExperienceMemoryStore } from "../rag/agent-experience-memory.js";
import { createAgentRunService, createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { streamAgentRun } from "../rag/langgraph/agent-stream.js";
import { describeAgentRouteError } from "../routes/chat.js";
import { withAgentExperienceMemoryEnabled } from "./agent-experience-memory-test-helpers.mjs";

// The agent's error text follows lib/error-text.js: an error raised for the
// client keeps its message, anything else reaches the server log only.

// One /chat/stream event sequence (the route's own, rag/langgraph/agent-stream.js)
// of a document question whose retrieval call throws `error`, the run it
// recorded, and the server log.
const streamDocumentQuestion = async (t, error) => {
  const logged = [];

  t.mock.method(console, "error", (...args) => logged.push(args));

  const accessScope = { userId: "alice", workspaceId: "workspace-a" };
  const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const events = [];

  for await (const event of streamAgentRun({
    answer: () =>
      runAgentRag({
        accessScope,
        agentBudget: { maxWebSearchCalls: 0 },
        agentRunService,
        docIds: ["doc-1"],
        question: "What does remote work require?",
        ragService: {
          chat: async () => {
            throw error;
          },
          getDocument: (docId) => (docId === "doc-1" ? { docId, fileName: "policy.pdf" } : null),
          listDocuments: () => [{ docId: "doc-1", fileName: "policy.pdf" }],
        },
        sessionId: "session-1",
        userId: "alice",
        webChatService: async () => {
          throw new Error("Web search should not run.");
        },
      }),
    describeError: describeAgentRouteError,
  })) {
    events.push(event);
  }

  const result = events.find((event) => event.type === "result");
  const run = await agentRunService.getRun({ accessScope, runId: result.body.agentRunId });

  return {
    events,
    logged,
    result,
    run,
    step: run.steps.find((step) => step.id === "document_rag:primary"),
    summary: events.find((event) => event.type === "trace_step" && event.step.id === "document_rag:primary")
      ?.step.summary,
  };
};

test("an upstream error inside document RAG reaches no payload, only the server log", async (t) => {
  // The model backend's own answer (rag/openai-client.js): its text names the
  // endpoint and echoes the key.
  const upstream = Object.assign(
    new Error(
      "Incorrect API key provided: sk-live-0123456789abcdef. POST https://llm.internal.example:8443/v1/chat/completions"
    ),
    { status: 401, upstreamStatus: 401 }
  );
  const { events, logged, result, run, step, summary } = await streamDocumentQuestion(t, upstream);

  assert.equal(result.status, 502);
  assert.equal(result.body.errors.rag, "Unable to answer from the document.");
  assert.equal(result.body.ragAnswer, "RAG unavailable: Unable to answer from the document.");
  assert.equal(summary, "Document RAG failed: Unable to answer from the document.");
  assert.deepEqual(step.error, { message: "Unable to answer from the document.", name: "Error" });
  // Every stream event (trace steps, the result) and the run record (steps, events).
  assert.doesNotMatch(JSON.stringify(events), /sk-live-|llm\.internal\.example/);
  assert.doesNotMatch(JSON.stringify(run), /sk-live-|llm\.internal\.example/);
  // Once, though the step summary and record, the Skill runs, errors.rag and
  // ragAnswer all carry it.
  assert.equal(logged.filter((args) => args.includes(upstream)).length, 1);
});

test("a client error inside document RAG keeps its message", async (t) => {
  const message = "Document not found for docId doc-1. Upload the PDF again and use the latest docId.";
  const { result, step, summary } = await streamDocumentQuestion(t, Object.assign(new Error(message), { status: 404 }));

  assert.equal(result.body.errors.rag, message);
  assert.equal(result.body.ragAnswer, `RAG unavailable: ${message}`);
  assert.equal(summary, `Document RAG failed: ${message}`);
  assert.equal(step.error.message, message);
});

test("an experience memory that cannot be read answers load_failed, never the store's error", async (t) => {
  const failStore = () => {
    throw new Error("connect ECONNREFUSED db.internal.example:5432");
  };

  await withAgentExperienceMemoryEnabled(async () => {
    configureAgentExperienceMemoryStore({ delete: failStore, list: failStore, remember: failStore });

    const { result } = await streamDocumentQuestion(
      t,
      Object.assign(new Error("Document not found for docId doc-1."), { status: 404 })
    );

    assert.equal(result.body.agentObservability.experienceMemory.error, "load_failed");
    assert.doesNotMatch(JSON.stringify(result.body), /db\.internal\.example/);
  });
});
