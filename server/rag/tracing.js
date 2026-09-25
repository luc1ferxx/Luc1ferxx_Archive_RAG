import {
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
  trace,
} from "@opentelemetry/api";

// OpenTelemetry tracing facade.
//
// Spans follow the OpenTelemetry GenAI semantic conventions (gen_ai.*), so any
// OTLP backend -- Arize Phoenix, Langfuse, Jaeger -- shows one /chat request as
// one trace: the agent run, its planners and tools, and every model and
// embedding call under the step that made it, with model and token usage.
//
// This module only uses @opentelemetry/api. Until an SDK is registered (see
// server/otel.js, started when OTEL_TRACING_ENABLED=true) every tracer is a
// no-op and the helpers cost one function call; nothing here reads the flag.
//
// Prompts, completions, questions, and document text are never recorded: they
// carry user documents, and a trace backend is a new place for them to leak to.
// Attributes are identifiers, model names, counts, and statuses only.

const TRACER_NAME = "luc1ferxx-archive-rag";

export const GEN_AI_ATTRIBUTES = Object.freeze({
  agentName: "gen_ai.agent.name",
  conversationId: "gen_ai.conversation.id",
  inputTokens: "gen_ai.usage.input_tokens",
  operationName: "gen_ai.operation.name",
  outputTokens: "gen_ai.usage.output_tokens",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  toolName: "gen_ai.tool.name",
});

export const GEN_AI_OPERATIONS = Object.freeze({
  chat: "chat",
  embeddings: "embeddings",
  executeTool: "execute_tool",
  invokeAgent: "invoke_agent",
});

export const SPAN_KINDS = Object.freeze({
  client: SpanKind.CLIENT,
  internal: SpanKind.INTERNAL,
});

const cleanAttributes = (attributes = {}) =>
  Object.fromEntries(
    Object.entries(attributes).filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    )
  );

const getTracer = () => trace.getTracer(TRACER_NAME);

/**
 * Runs fn inside an active span, so spans started while it runs -- including
 * model calls deep inside ragService -- become its children. fn receives the
 * span so it can add what it only learns at the end, such as token usage.
 * A thrown error marks the span failed and is rethrown unchanged.
 */
export const withSpan = (name, attributes, fn, { kind = SpanKind.INTERNAL } = {}) =>
  getTracer().startActiveSpan(
    name,
    { attributes: cleanAttributes(attributes), kind },
    async (span) => {
      try {
        // Success leaves the status unset, as the spec asks of
        // instrumentation; setting OK here would also override a failure
        // recorded through markSpanFailed.
        return await fn(span);
      } catch (error) {
        span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(error?.message ?? error).slice(0, 200),
        });
        throw error;
      } finally {
        span.end();
      }
    }
  );

export const setSpanAttributes = (span, attributes) => {
  span?.setAttributes?.(cleanAttributes(attributes));
};

export const setActiveSpanAttributes = (attributes) => {
  setSpanAttributes(trace.getActiveSpan(), attributes);
};

// For work that reports failure in its result instead of throwing, such as a
// Skill result with ok: false.
export const markSpanFailed = (span, message) => {
  span?.setStatus?.({
    code: SpanStatusCode.ERROR,
    message: String(message ?? "failed").slice(0, 200),
  });
};

// Adds an event to whichever span is active: a retry to the model call making
// it, an agent step to the run or tool it happened in.
export const addActiveSpanEvent = (name, attributes) => {
  trace.getActiveSpan()?.addEvent(name, cleanAttributes(attributes));
};

/**
 * The trace id of the active span when it is really being recorded, so a
 * /chat response or run record can point at its trace. Null when tracing is
 * off, which keeps responses unchanged in the default configuration.
 */
export const getActiveTraceId = () => {
  const span = trace.getActiveSpan();

  if (!span?.isRecording?.()) {
    return null;
  }

  const spanContext = span.spanContext();

  return isSpanContextValid(spanContext) ? spanContext.traceId : null;
};
