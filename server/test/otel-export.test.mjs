import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { context, trace } from "@opentelemetry/api";
import { getOtlpProtocol, isTracingEnabled, startTracing } from "../otel.js";
import { GEN_AI_ATTRIBUTES, withSpan } from "../rag/tracing.js";

// A stand-in for Phoenix or Langfuse: an OTLP/HTTP receiver that records what
// it was sent. The exporter is configured only through the standard OTEL_*
// variables, which is how a real backend is wired.
const startReceiver = async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ body, headers: request.headers, url: request.url });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
  };
};

const withEnv = (t, values) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

test("tracing is opt-in", (t) => {
  withEnv(t, { OTEL_TRACING_ENABLED: "" });
  assert.equal(isTracingEnabled(), false);
  process.env.OTEL_TRACING_ENABLED = " TRUE ";
  assert.equal(isTracingEnabled(), true);
});

// Each test registers its own global provider; unregister it afterwards so the
// next one is not silently ignored.
const startProvider = (t) => {
  const provider = startTracing();
  t.after(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });
  return provider;
};

test("the OTLP encoding follows the standard protocol variables", (t) => {
  withEnv(t, { OTEL_EXPORTER_OTLP_PROTOCOL: "", OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "" });
  // The spec default, and the only encoding Phoenix accepts.
  assert.equal(getOtlpProtocol(), "http/protobuf");
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  assert.equal(getOtlpProtocol(), "http/json");
  process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
  assert.equal(getOtlpProtocol(), "http/protobuf", "the traces-specific variable wins");
  process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "grpc";
  assert.equal(getOtlpProtocol(), "http/protobuf", "gRPC is not wired; fall back, do not fail");
});

test("by default spans reach an OTLP backend as protobuf", async (t) => {
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  withEnv(t, {
    OTEL_EXPORTER_OTLP_PROTOCOL: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${receiver.url}/v1/traces`,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "",
  });

  const provider = startProvider(t);
  await withSpan("chat protobuf-model", {}, async () => {});
  await provider.forceFlush();

  assert.equal(receiver.requests.length, 1);
  assert.equal(receiver.requests[0].url, "/v1/traces");
  assert.equal(receiver.requests[0].headers["content-type"], "application/x-protobuf");
  // Protobuf stores strings as raw UTF-8, so the span name is in the body.
  assert.ok(receiver.requests[0].body.includes("chat protobuf-model"));
});

test("with http/json, spans reach the backend with the configured headers and service", async (t) => {
  const receiver = await startReceiver();
  t.after(() => receiver.close());
  withEnv(t, {
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic dGVzdDp0ZXN0",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${receiver.url}/v1/traces`,
    OTEL_SERVICE_NAME: "archive-rag-export-test",
  });

  const provider = startProvider(t);

  await withSpan("chat test-model", {
    [GEN_AI_ATTRIBUTES.operationName]: "chat",
    [GEN_AI_ATTRIBUTES.requestModel]: "test-model",
  }, async () => {});
  await provider.forceFlush();

  assert.equal(receiver.requests.length, 1);
  const [request] = receiver.requests;
  assert.equal(request.url, "/v1/traces");
  assert.equal(request.headers.authorization, "Basic dGVzdDp0ZXN0");
  assert.match(request.headers["content-type"], /application\/json/);

  const payload = JSON.parse(request.body);
  const [resourceSpans] = payload.resourceSpans;
  const serviceName = resourceSpans.resource.attributes.find(
    (attribute) => attribute.key === "service.name"
  );
  assert.equal(serviceName.value.stringValue, "archive-rag-export-test");

  const [span] = resourceSpans.scopeSpans[0].spans;
  assert.equal(span.name, "chat test-model");
  assert.ok(
    span.attributes.some(
      (attribute) => attribute.key === "gen_ai.request.model" && attribute.value.stringValue === "test-model"
    )
  );
});
