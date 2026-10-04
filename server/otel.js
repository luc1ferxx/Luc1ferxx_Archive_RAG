import { OTLPTraceExporter as OTLPJsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPProtobufTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

// Starts the OpenTelemetry SDK so the spans rag/tracing.js creates are
// recorded and exported. Nothing else in the app imports the SDK; without this
// the tracing API stays a no-op.
//
// The OTLP/HTTP exporters read the standard variables themselves:
// OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) and
// OTEL_EXPORTER_OTLP_HEADERS. Phoenix and Langfuse both accept OTLP; see
// docs/configuration.md for their endpoints.

export const isTracingEnabled = () =>
  String(process.env.OTEL_TRACING_ENABLED ?? "").trim().toLowerCase() === "true";

/**
 * OTLP/HTTP encoding from the standard protocol variables. http/protobuf is the
 * spec default and the only encoding Phoenix accepts (it answers JSON with a
 * 415); http/json is available for backends and debugging that want it.
 * gRPC is not wired here, so it falls back to http/protobuf with a warning.
 */
export const getOtlpProtocol = () => {
  const requested = String(
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ||
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL ||
      "http/protobuf"
  )
    .trim()
    .toLowerCase();

  if (requested === "http/json" || requested === "http/protobuf") {
    return requested;
  }

  console.warn(
    `[tracing] OTLP protocol "${requested}" is not supported; using http/protobuf.`
  );
  return "http/protobuf";
};

export const createOtlpExporter = () =>
  getOtlpProtocol() === "http/json"
    ? new OTLPJsonTraceExporter()
    : new OTLPProtobufTraceExporter();

/**
 * Registers a global tracer provider. `exporters` defaults to one OTLP/HTTP
 * exporter in the configured encoding; `batch: false` exports each span as it ends, for tests and demos
 * that read spans back immediately. Returns the provider so the caller can
 * flush and shut it down.
 */
export const startTracing = ({
  batch = true,
  exporters = [createOtlpExporter()],
  serviceName = process.env.OTEL_SERVICE_NAME || "luc1ferxx-archive-rag",
} = {}) => {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "1.0.0",
    }),
    spanProcessors: exporters.map((exporter) =>
      batch ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter)
    ),
  });

  // Also installs the AsyncLocalStorage context manager, which is what makes a
  // model call made deep inside ragService a child of the step that caused it.
  provider.register();

  return provider;
};

/**
 * A graceful-shutdown finalizer that flushes buffered spans, so the last
 * requests before a restart still reach the backend. server.js runs it after
 * the in-flight requests have drained (createGracefulShutdown in
 * rag/agent-service/role-server.js), for the monolith and every split role,
 * so the spans of the drained requests are flushed too. A failed flush is
 * logged and does not stop the rest of the shutdown.
 */
export const createTracingShutdownFinalizer = (provider) => async () => {
  try {
    await provider.shutdown();
  } catch (error) {
    console.error("[tracing] failed to flush spans on shutdown.", error);
  }
};

/**
 * Flushes buffered spans and exits on SIGTERM/SIGINT. It exits as soon as the
 * flush settles, so next to a graceful drain it races the drain and cuts off
 * the requests the drain waits for; server.js therefore uses
 * createTracingShutdownFinalizer. retrieval-service.mjs and model-gateway.mjs
 * still register this next to their own close handlers.
 */
export const shutdownTracingOnExit = (provider) => {
  const shutdown = async () => {
    try {
      await provider.shutdown();
    } catch (error) {
      console.error("[tracing] failed to flush spans on shutdown.", error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
};
