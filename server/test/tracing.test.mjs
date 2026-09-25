import assert from "node:assert/strict";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { startTracing } from "../otel.js";
import { markSpanFailed, withSpan } from "../rag/tracing.js";
import { runAgentRag } from "../rag/agent.js";
import {
  completeTextWithMetadata,
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";
import {
  buildScopedRagService,
  buildSource,
  createEvalTelemetry,
} from "../evaluation/agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  sameTrajectoryScope as sameScope,
} from "../evaluation/trajectory/checks.js";

const QUESTION = "Review this contract for risks and key terms.";
const EXCERPT =
  "Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice.";
const MODEL_ANSWER = "Secret-looking model answer text.";

const runContractReview = async () => {
  const citation = buildSource({
    docId: "contract-1",
    excerpt: EXCERPT,
    fileName: "services-agreement.pdf",
    pageNumber: 3,
  });
  const ragService = buildScopedRagService({
    chat: async ({ question }) => {
      await completeTextWithMetadata(question);

      return {
        abstained: false,
        citations: [citation],
        memoryApplied: false,
        resolvedQuery: question,
        text: "- Renewal: The agreement renews every 12 months. [Source 1]",
      };
    },
    documents: [{ docId: "contract-1", fileName: "services-agreement.pdf" }],
    sameScope,
    telemetry: createEvalTelemetry(),
  });

  return runAgentRag({
    accessScope: DEFAULT_ACCESS_SCOPE,
    docIds: ["contract-1"],
    question: QUESTION,
    ragService,
    sessionId: "tracing-session",
    userId: DEFAULT_ACCESS_SCOPE.userId,
    webChatService: async () => ({ text: "web should not run" }),
  });
};

const withGuardedGraph = async (t) => {
  const previous = process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  process.env.AGENT_SKILL_GRAPH_ROLLOUT = "guarded";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    else process.env.AGENT_SKILL_GRAPH_ROLLOUT = previous;
  });
  configureOpenAIProvider({ completeText: async () => MODEL_ANSWER });
  t.after(() => resetOpenAIProvider());
};

// Runs first, before any SDK is registered in this process.
test("without a tracing SDK the response carries no trace id", async (t) => {
  await withGuardedGraph(t);

  const response = await runContractReview();

  assert.equal(response.status, 200);
  assert.equal("traceId" in response.body.agentObservability, false);
});

test("one agent run is one trace: planners, tools, and model calls nest under it", async (t) => {
  const exporter = new InMemorySpanExporter();
  const provider = startTracing({ batch: false, exporters: [exporter] });
  t.after(() => provider.shutdown());
  await withGuardedGraph(t);

  const response = await runContractReview();
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  const byName = (name) => spans.filter((span) => span.name === name);
  const parentOf = (span) => span.parentSpanContext?.spanId ?? span.parentSpanId;

  const [root] = byName("invoke_agent archive_rag");
  assert.ok(root, "the run span exists");
  assert.equal(parentOf(root), undefined);
  assert.equal(root.attributes["gen_ai.operation.name"], "invoke_agent");
  assert.equal(root.attributes["gen_ai.conversation.id"], "tracing-session");
  assert.equal(root.attributes["agent.mode"], response.body.agentMode);
  assert.equal(root.attributes["agent.usage.model_calls"], 2);
  assert.ok(root.attributes["agent.usage.tokens"] > 0);

  // Every span belongs to the run's trace, and the response points at it.
  const traceId = root.spanContext().traceId;
  assert.ok(spans.every((span) => span.spanContext().traceId === traceId));
  assert.equal(response.body.agentObservability.traceId, traceId);

  for (const planner of ["agent.plan intent", "agent.plan execution", "agent.plan skill_graph"]) {
    assert.equal(byName(planner).length, 1, planner);
  }
  assert.equal(byName("agent.plan skill_graph")[0].attributes["agent.graph.accepted"], true);

  // Each Skill is an execute_tool span, and the model call it made is its child.
  const tools = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "execute_tool");
  assert.deepEqual(
    tools.map((span) => span.attributes["gen_ai.tool.name"]).sort(),
    ["risk_review", "summarize_contract"]
  );
  const chats = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "chat");
  assert.equal(chats.length, 2);

  for (const chat of chats) {
    assert.ok(tools.some((tool) => tool.spanContext().spanId === parentOf(chat)));
    assert.equal(chat.kind, 2 /* SpanKind.CLIENT */);
    assert.ok(chat.attributes["gen_ai.usage.input_tokens"] > 0);
    assert.equal(chat.attributes["llmops.token_source"], "estimated");
  }

  // Agent steps are events, not spans, carrying only type, label and status.
  const stepEvents = spans.flatMap((span) => span.events.filter((event) => event.name === "agent.step"));
  assert.ok(stepEvents.some((event) => event.attributes["agent.step.type"] === "custom_skill"));

  // Nothing from the question, the document, or the model output is recorded.
  const recorded = JSON.stringify(
    spans.map((span) => ({
      attributes: span.attributes,
      events: span.events.map((event) => event.attributes),
      status: span.status,
    }))
  );

  for (const secret of [QUESTION, EXCERPT, MODEL_ANSWER, "renews every 12 months"]) {
    assert.equal(recorded.includes(secret), false, `leaked: ${secret}`);
  }

  // Success leaves the status unset; a result-level failure and a throw both
  // mark the span failed, and neither changes what the caller gets back.
  assert.ok(spans.every((span) => span.status.code === SpanStatusCode.UNSET));
  exporter.reset();
  const failedResult = await withSpan("execute_tool broken", {}, async (span) => {
    markSpanFailed(span, "skill failed");
    return { ok: false };
  });
  await assert.rejects(
    withSpan("chat broken", {}, async () => {
      throw new Error("upstream 503");
    }),
    /upstream 503/
  );
  await provider.forceFlush();

  assert.deepEqual(failedResult, { ok: false });
  assert.deepEqual(
    exporter.getFinishedSpans().map((span) => [span.name, span.status.code, span.events.length]),
    [
      ["execute_tool broken", SpanStatusCode.ERROR, 0],
      ["chat broken", SpanStatusCode.ERROR, 1 /* the recorded exception */],
    ]
  );
});
