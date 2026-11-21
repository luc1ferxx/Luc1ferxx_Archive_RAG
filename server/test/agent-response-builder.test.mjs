import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentResponse,
  buildClarificationResponse,
  buildEvidenceClarification,
} from "../rag/agent-response-builder.js";

test("agent response builder creates document evidence clarification payload", () => {
  const clarification = buildEvidenceClarification({
    reason: "document_follow_up_limit_reached",
    check: {
      reasons: ["claim lacks citation support"],
    },
    gaps: [
      {
        type: "unsupported_claim",
        claim: "Missing support.",
      },
    ],
  });

  assert.equal(clarification.reason, "document_follow_up_limit_reached");
  assert.match(clarification.question, /could not verify/i);
  assert.deepEqual(clarification.detail.reasons, [
    "claim lacks citation support",
  ]);
  assert.equal(clarification.detail.gaps[0].type, "unsupported_claim");
});

test("agent response builder returns stable clarification chat shape", () => {
  const response = buildClarificationResponse({
    clarification: {
      reason: "missing_required_documents",
      summary: "Document context is required.",
      question: "Which document should I use?",
      detail: {
        selectedDocumentCount: 0,
      },
    },
    trace: [
      {
        type: "clarification_gate",
      },
    ],
    agentSkills: [],
    agentObservability: {
      agentMode: "clarification",
    },
    workingMemory: {
      goal: "Question?",
    },
    question: "Question?",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "clarification");
  assert.equal(response.body.agentAnswer, "Which document should I use?");
  assert.equal(response.body.ragAnswer, response.body.agentAnswer);
  assert.equal(response.body.ragAbstained, true);
  assert.equal(response.body.clarification.needed, true);
  assert.equal(response.body.errors.rag, null);
});

test("agent response builder uses finalizer text for finalized document answer", () => {
  const response = buildAgentResponse({
    agentMode: "document",
    baseAgentAnswer: "Supported claim. Unsupported claim.",
    directAnswerModes: new Set(["inventory"]),
    finalizer: {
      text: "Supported claim.",
      abstained: false,
    },
    plan: {
      mode: "document",
    },
    question: "What is supported?",
    ragResult: {
      ok: true,
      value: {
        text: "Supported claim. Unsupported claim.",
        citations: [
          {
            docId: "doc-1",
          },
        ],
        resolvedQuery: "What is supported?",
        memoryApplied: true,
        abstained: false,
      },
    },
    ragSources: [
      {
        docId: "doc-1",
      },
    ],
    skippedWebBecauseBudget: false,
    trace: [],
    agentSkills: [],
    agentObservability: {},
    workingMemory: {},
    webResult: null,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentAnswer, "Supported claim.");
  assert.equal(response.body.ragAnswer, "Supported claim.");
  assert.equal(response.body.ragMemoryApplied, true);
  assert.equal(
    response.body.mcpAnswer,
    "Web search not used: document evidence was sufficient."
  );
});

test("agent response builder reports failed document and web execution as 502", (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  // The model backend's own answer: its text names the endpoint and the key.
  const upstreamError = Object.assign(
    new Error("Incorrect API key sk-live-0123456789abcdef for https://llm.internal.example/v1/chat/completions"),
    { status: 401, upstreamStatus: 401 }
  );
  // chat-mcp.js fails a search with its reason as a 409.
  const webReason = "Web search is not configured: SERPAPI_KEY is not set.";
  const response = buildAgentResponse({
    agentMode: "document_web",
    baseAgentAnswer: "The agent could not complete the request.",
    directAnswerModes: new Set(),
    finalizer: null,
    plan: {
      mode: "document",
    },
    question: "Question?",
    ragResult: {
      ok: false,
      error: upstreamError,
    },
    ragSources: [],
    skippedWebBecauseBudget: false,
    trace: [],
    agentSkills: [],
    agentObservability: {},
    workingMemory: {},
    webResult: {
      ok: false,
      error: Object.assign(new Error(webReason), { status: 409 }),
    },
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.ragAnswer, "RAG unavailable: Unable to answer from the document.");
  assert.equal(response.body.mcpAnswer, `Web search unavailable: ${webReason}`);
  assert.equal(response.body.errors.rag, "Unable to answer from the document.");
  assert.equal(response.body.errors.mcp, webReason);
  assert.doesNotMatch(JSON.stringify(response.body), /sk-live|llm\.internal/);
  assert.deepEqual(logged, [["Unable to answer from the document.", upstreamError]]);
});
