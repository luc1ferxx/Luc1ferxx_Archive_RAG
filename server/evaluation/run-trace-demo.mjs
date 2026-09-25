// run-trace-demo.mjs
//
// Runs one contract-review agent request with OpenTelemetry on and prints the
// trace it produced as a tree: the invoke_agent span, the planners, each Skill
// as an execute_tool span, and every model call under the Skill that made it,
// with durations, token usage, and the step events.
//
// By default the model is a local stand-in, so the demo needs no key and no
// network. With --real, model calls go to the configured OpenAI-compatible
// endpoint (OPENAI_BASE_URL / OPENAI_CHAT_MODEL, e.g. local Ollama), so the
// token counts and latencies are real. With --otlp the same spans are also
// exported to OTEL_EXPORTER_OTLP_ENDPOINT (Phoenix, Langfuse; see
// docs/configuration.md). Documents are a fixed in-memory contract, so no
// database is needed either way.
//
// Usage:
//   node evaluation/run-trace-demo.mjs [--real] [--otlp]

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { createOtlpExporter, startTracing } from "../otel.js";

const DOCUMENT = {
  docId: "demo-contract",
  excerpt:
    "Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice. Late notice creates renewal risk.",
  fileName: "services-agreement.pdf",
};

const durationMs = (span) =>
  (span.endTime[0] - span.startTime[0]) * 1000 + (span.endTime[1] - span.startTime[1]) / 1e6;

const SHOWN_ATTRIBUTES = [
  "gen_ai.request.model",
  "gen_ai.tool.name",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "llmops.token_source",
  "agent.planner.id",
  "agent.planner.fallback",
  "agent.graph.node_count",
  "agent.skill.ok",
  "agent.skill.citation_count",
  "agent.mode",
  "agent.usage.tokens",
  "agent.usage.model_calls",
];

/**
 * Renders finished spans as an indented tree, parents before children and
 * siblings in start order. Exported for the test.
 */
export const formatSpanTree = (spans) => {
  const ids = new Set(spans.map((span) => span.spanContext().spanId));
  // A span whose parent was not captured is shown as a root.
  const parentOf = (span) => {
    const parentId = span.parentSpanContext?.spanId ?? span.parentSpanId ?? null;
    return parentId && ids.has(parentId) ? parentId : null;
  };
  const byStart = (left, right) =>
    left.startTime[0] - right.startTime[0] || left.startTime[1] - right.startTime[1];
  const childrenOf = (spanId) =>
    spans.filter((span) => parentOf(span) === spanId).sort(byStart);
  const lines = [];

  const visit = (span, depth) => {
    const attributes = SHOWN_ATTRIBUTES.filter((key) => span.attributes[key] !== undefined)
      .map((key) => `${key.replace(/^(gen_ai|agent|llmops)\./, "")}=${span.attributes[key]}`)
      .join(" ");
    const failed = span.status.code === 2 ? " [ERROR]" : "";
    lines.push(
      `${"  ".repeat(depth)}${span.name}  ${Math.round(durationMs(span))}ms${failed}${attributes ? `  ${attributes}` : ""}`
    );

    for (const event of span.events) {
      if (event.name === "agent.step") {
        lines.push(
          `${"  ".repeat(depth + 1)}· step ${event.attributes["agent.step.type"]} (${event.attributes["agent.step.status"]})`
        );
      } else {
        lines.push(`${"  ".repeat(depth + 1)}· ${event.name}`);
      }
    }

    for (const child of childrenOf(span.spanContext().spanId)) {
      visit(child, depth + 1);
    }
  };

  for (const root of childrenOf(null)) {
    visit(root, 0);
  }

  return lines.join("\n");
};

const main = async () => {
  const args = new Set(process.argv.slice(2));
  const exporter = new InMemorySpanExporter();
  // The in-memory exporter feeds the printed tree; --otlp exports the same
  // spans to a backend as well.
  const provider = startTracing({
    batch: false,
    exporters: args.has("--otlp") ? [exporter, createOtlpExporter()] : [exporter],
  });

  // Pinned rather than read from .env: the demo shows the default executor (the
  // typed DAG, so the graph planner span appears) and must not depend on a
  // memory database being up.
  Object.assign(process.env, {
    AGENT_SKILL_GRAPH_ROLLOUT: "guarded",
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_LONG_MEMORY_ENABLED: "false",
  });
  const { runAgentRag } = await import("../rag/agent.js");
  const { completeTextWithMetadata, configureOpenAIProvider } = await import("../rag/openai.js");
  const { buildScopedRagService, buildSource, createEvalTelemetry } = await import(
    "./agent-eval-harness.js"
  );
  const { DEFAULT_ACCESS_SCOPE, sameTrajectoryScope } = await import("./trajectory/checks.js");

  if (!args.has("--real")) {
    configureOpenAIProvider({
      completeText: async () => "- Renewal: The agreement renews every 12 months. [Source 1]",
    });
  }

  const citation = buildSource({ ...DOCUMENT, pageNumber: 3 });
  const ragService = buildScopedRagService({
    chat: async ({ question }) => {
      const completion = await completeTextWithMetadata(
        `Answer from this excerpt only and cite it as [Source 1].\n\nExcerpt: ${DOCUMENT.excerpt}\n\nQuestion: ${question}`
      );

      return {
        abstained: false,
        citations: [citation],
        memoryApplied: false,
        resolvedQuery: question,
        text: completion.text,
      };
    },
    documents: [{ docId: DOCUMENT.docId, fileName: DOCUMENT.fileName }],
    sameScope: sameTrajectoryScope,
    telemetry: createEvalTelemetry(),
  });

  const response = await runAgentRag({
    accessScope: DEFAULT_ACCESS_SCOPE,
    docIds: [DOCUMENT.docId],
    question: "Review this contract for risks and key terms.",
    ragService,
    sessionId: "trace-demo",
    userId: DEFAULT_ACCESS_SCOPE.userId,
    webChatService: async () => ({ text: "" }),
  });
  await provider.forceFlush();

  console.log(formatSpanTree(exporter.getFinishedSpans()));
  console.log(`\ntraceId (also in agentObservability.traceId): ${response.body.agentObservability.traceId}`);
  console.log(
    args.has("--otlp")
      ? `Exported to ${process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces"}.`
      : "Add --otlp to also send these spans to OTEL_EXPORTER_OTLP_ENDPOINT."
  );

  await provider.shutdown();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
