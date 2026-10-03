import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import express from "express";

import { startServiceRole } from "../rag/agent-service/role-server.js";
import { getMetricsRegistry, setMetricsEnabled } from "../rag/metrics.js";
import {
  KNOWN_UNROUTED_PATHS,
  resolveRouteLabel,
  toMethodLabel,
  toStatusClass,
} from "../rag/metrics-http.js";
import {
  DEFAULT_METRICS_HOST,
  DEFAULT_METRICS_PORT,
  getMetricsServerConfig,
  isAuthorizedScrape,
  startMetricsFromEnv,
  startMetricsServer,
} from "../rag/metrics-server.js";
import { checkHistogram, parseExposition, sampleValue } from "./metrics-exposition.mjs";

// The /metrics listener (rag/metrics-server.js) and HTTP RED recording
// (rag/metrics-http.js): metrics live on a listener of their own, never on
// the app port; a token, when set, is required; route labels are Express
// templates, never raw paths. Everything listens on 127.0.0.1 port 0.

const TOKEN = "metrics-test-token-0123456789";
const quietLogger = { error() {}, log() {}, warn() {} };
const cleanups = [];

after(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }

  setMetricsEnabled(null);
});

const listen = (app) =>
  new Promise((resolve) => {
    const server = http.createServer(app);

    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const closeServer = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

const scrape = async (port, token = TOKEN) => {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  assert.equal(response.status, 200);
  return parseExposition(await response.text());
};

test("the listener serves /metrics only, in format 0.0.4, and only with the bearer token", async () => {
  const listener = await startMetricsServer({ host: "127.0.0.1", port: 0, token: TOKEN });

  cleanups.push(() => listener.close());

  const base = `http://127.0.0.1:${listener.port}`;

  assert.notEqual(listener.port, 0, "port 0 resolves to the assigned port");

  const missing = await fetch(`${base}/metrics`);

  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="metrics"');
  assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: `Basic ${TOKEN}` } })).status, 401);

  const ok = await fetch(`${base}/metrics?x=1`, { headers: { authorization: `Bearer ${TOKEN}` } });

  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
  parseExposition(await ok.text());

  const head = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` }, method: "HEAD" });

  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 404);

  const post = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` }, method: "POST" });

  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");

  assert.equal(isAuthorizedScrape(undefined, null), true);
  assert.equal(isAuthorizedScrape(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(isAuthorizedScrape(`Bearer ${TOKEN}x`, TOKEN), false);
});

test("the configuration defaults to off, 127.0.0.1:9464, no token; a bad port fails only when enabled", () => {
  assert.deepEqual(getMetricsServerConfig({}), {
    enabled: false,
    host: DEFAULT_METRICS_HOST,
    port: null,
    token: null,
  });
  assert.equal(DEFAULT_METRICS_HOST, "127.0.0.1");
  assert.equal(DEFAULT_METRICS_PORT, 9464);
  assert.deepEqual(getMetricsServerConfig({ METRICS_ENABLED: "TRUE" }), {
    enabled: true,
    host: "127.0.0.1",
    port: 9464,
    token: null,
  });
  assert.deepEqual(
    getMetricsServerConfig({ METRICS_ENABLED: "true", METRICS_HOST: "0.0.0.0", METRICS_PORT: "0", METRICS_TOKEN: " t " }),
    { enabled: true, host: "0.0.0.0", port: 0, token: "t" }
  );
  assert.equal(getMetricsServerConfig({ METRICS_PORT: "nope" }).port, null);
  assert.throws(() => getMetricsServerConfig({ METRICS_ENABLED: "true", METRICS_PORT: "nope" }), /METRICS_PORT/u);
  assert.throws(() => getMetricsServerConfig({ METRICS_ENABLED: "true", METRICS_PORT: "70000" }), /METRICS_PORT/u);
});

test("without METRICS_ENABLED nothing starts and an app server is left alone", async () => {
  const server = await listen(express());

  cleanups.push(() => closeServer(server));

  assert.equal(await startMetricsFromEnv({ env: {}, httpServer: server, logger: quietLogger }), null);
  assert.equal(server.listeners("request").length, 1, "no request listener was added");
});

test("HTTP requests are recorded by method, route template and status class on the separate listener", async () => {
  const app = express();
  let releaseSlow = null;

  app.get("/items/:itemId", (req, res) => res.json({ ok: true }));
  app.post("/fail", (req, res) => res.status(503).json({ error: "down" }));
  app.get("/limited", (req, res) => res.status(429).json({ error: "slow down" }));
  app.get("/slow", (req) => {
    releaseSlow = () => req.socket.destroy();
  });
  app.use((req, res) => res.status(404).json({ error: "Not found." }));

  const server = await listen(app);
  const lines = [];
  const metrics = await startMetricsFromEnv({
    env: { METRICS_ENABLED: "true", METRICS_PORT: "0", METRICS_TOKEN: TOKEN },
    httpServer: server,
    logger: { ...quietLogger, log: (line) => lines.push(line) },
  });

  cleanups.push(() => closeServer(server));
  cleanups.push(() => metrics.close());

  const appBase = `http://127.0.0.1:${server.address().port}`;

  assert.match(lines.join("\n"), new RegExp(`\\[metrics\\] serving /metrics on http://127\\.0\\.0\\.1:${metrics.port} \\(bearer token required\\)`, "u"));
  assert.notEqual(metrics.port, server.address().port);

  const before = await scrape(metrics.port);

  await fetch(`${appBase}/items/secret-document-42`);
  await fetch(`${appBase}/items/another-id`);
  await fetch(`${appBase}/fail`, { method: "POST" });
  await fetch(`${appBase}/limited`);
  await fetch(`${appBase}/no/such/path/user-7`);
  await fetch(`${appBase}/chat?question=hidden`);

  // The app port does not serve metrics: /metrics there is an unknown path.
  const onAppPort = await fetch(`${appBase}/metrics`);

  assert.equal(onAppPort.status, 404);

  // A client that leaves before the answer: recorded as aborted.
  const controller = new AbortController();
  const slow = fetch(`${appBase}/slow`, { signal: controller.signal }).catch(() => null);

  while (!releaseSlow) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  controller.abort();
  await slow;

  let after = await scrape(metrics.port);

  for (let attempt = 0; attempt < 200 && sampleValue(after, "archive_rag_http_requests_total", { route: "/slow" }) === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    after = await scrape(metrics.port);
  }

  const delta = (labels) =>
    sampleValue(after, "archive_rag_http_requests_total", labels) -
    sampleValue(before, "archive_rag_http_requests_total", labels);

  assert.equal(delta({ method: "GET", route: "/items/:itemId", status_class: "2xx" }), 2);
  assert.equal(delta({ method: "POST", route: "/fail", status_class: "5xx" }), 1);
  assert.equal(delta({ method: "GET", route: "/limited", status_class: "429" }), 1);
  assert.equal(delta({ method: "GET", route: "unmatched", status_class: "4xx" }), 2, "the unknown path and /metrics on the app port");
  assert.equal(delta({ method: "GET", route: "/chat", status_class: "4xx" }), 1, "a known path no route answered keeps its path");
  assert.equal(delta({ method: "GET", route: "/slow", status_class: "aborted" }), 1);
  assert.equal(sampleValue(after, "archive_rag_http_requests_in_flight"), 0);

  // No raw path, id or query string became a label value.
  const exposition = await (await fetch(`http://127.0.0.1:${metrics.port}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();

  for (const leaked of ["secret-document-42", "another-id", "user-7", "hidden", "/no/such"]) {
    assert.equal(exposition.includes(leaked), false, leaked);
  }

  const durations = checkHistogram(after.get("archive_rag_http_request_duration_seconds"));

  assert.ok([...durations.values()].some((entry) => entry.labels.route === "/items/:itemId" && entry.count >= 2));

  // Process metrics are sampled once the listener runs.
  assert.ok(sampleValue(after, "process_resident_memory_bytes") > 0);
  assert.ok(sampleValue(after, "process_cpu_seconds_total") > 0);
  assert.ok(sampleValue(after, "nodejs_heap_size_used_bytes") > 0);
});

test("a metrics port that is taken refuses the start with the variable to change", async () => {
  const taken = await listen(express());

  cleanups.push(() => closeServer(taken));

  await assert.rejects(
    startMetricsFromEnv({
      env: { METRICS_ENABLED: "true", METRICS_PORT: String(taken.address().port) },
      logger: quietLogger,
    }),
    /Metrics listener could not bind 127\.0\.0\.1:\d+ \(EADDRINUSE\); set METRICS_PORT/u
  );
});

test("route, method and status labels come from fixed vocabularies", () => {
  assert.equal(resolveRouteLabel({ baseUrl: "", route: { path: "/agent-runs/:runId" } }), "/agent-runs/:runId");
  assert.equal(resolveRouteLabel({ baseUrl: "/v1", route: { path: "/items" } }), "/v1/items");
  assert.equal(resolveRouteLabel({ route: { path: /^\/regex/u } }), "pattern");
  assert.equal(resolveRouteLabel({ originalUrl: "/chat/stream?x=1" }), "/chat/stream");
  assert.equal(resolveRouteLabel({ originalUrl: "/documents/doc-123" }), "unmatched");
  assert.ok(KNOWN_UNROUTED_PATHS.has("/upload"));
  assert.equal(toStatusClass(200), "2xx");
  assert.equal(toStatusClass(429), "429");
  assert.equal(toStatusClass(404), "4xx");
  assert.equal(toStatusClass(503), "5xx");
  assert.equal(toStatusClass(0), "other");
  assert.equal(toMethodLabel("post"), "POST");
  assert.equal(toMethodLabel("PROPFIND"), "OTHER");
});

test("a split role serves /metrics on its own listener and closes it on shutdown", async () => {
  const tierApp = express();

  tierApp.get("/livez", (req, res) => res.json({ status: "ok" }));

  const exits = [];
  const started = await startServiceRole({
    env: {
      ARCHIVE_RAG_ROLE: "model-gateway",
      INTERNAL_SERVICE_KEYS: `metrics-test:${"k".repeat(48)}`,
      METRICS_ENABLED: "true",
      METRICS_PORT: "0",
      METRICS_TOKEN: TOKEN,
    },
    exit: (code) => exits.push(code),
    graceMs: 1000,
    handleSignals: false,
    host: "127.0.0.1",
    loaders: { "model-gateway": async () => ({ createModelGatewayApp: () => tierApp }) },
    logger: quietLogger,
    port: 0,
    role: "model-gateway",
  });

  assert.ok(started.metrics, "the role started a metrics listener");
  assert.notEqual(started.metrics.port, started.port);

  const before = await scrape(started.metrics.port);

  assert.equal((await fetch(`http://127.0.0.1:${started.port}/livez`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${started.port}/metrics`)).status, 404);

  const after = await scrape(started.metrics.port);

  assert.equal(
    sampleValue(after, "archive_rag_http_requests_total", { route: "/livez", status_class: "2xx" }) -
      sampleValue(before, "archive_rag_http_requests_total", { route: "/livez", status_class: "2xx" }),
    1
  );

  await started.shutdown("test");

  assert.deepEqual(exits, [0]);
  await assert.rejects(fetch(`http://127.0.0.1:${started.metrics.port}/metrics`));
});

test("every series of the default registry stays within its family's label-set cap", async () => {
  const families = parseExposition(await getMetricsRegistry().expose());

  for (const family of families.values()) {
    const labelSets = new Set(
      family.samples.map((sample) =>
        JSON.stringify(Object.entries(sample.labels).filter(([name]) => name !== "le"))
      )
    );

    assert.ok(labelSets.size <= getMetricsRegistry().maxSeriesPerMetric, family.name);
  }
});
