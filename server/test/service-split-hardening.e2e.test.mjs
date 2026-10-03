import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";
import { generateServiceKeyPair } from "../rag/service-identity-keys.js";
import { parseExposition, sampleValue } from "./metrics-exposition.mjs";

// The four hardening features together, in the split deployment, every tier
// in its own process:
//
//   client -> api -> agent -> retrieval -> model-gateway -> fake model
//                        \______________________/^
//
//   - identity: INTERNAL_SERVICE_AUTH=ed25519, each tier signing with only its
//     own private key (the gateway holds none), binding and replay cache at
//     their ed25519 defaults;
//   - metrics: METRICS_ENABLED=true with a token in every tier, each on its
//     own OS-assigned port;
//   - deadlines: a second edge with AGENT_SERVICE_TIMEOUT_MS=1000 in front of
//     the same agent tier;
//   - read replica: with PGVECTOR_TEST_DATABASE_URL and
//     PGVECTOR_TEST_REPLICA_URL (scripts/run-pgvector-replica-integration.sh
//     provisions a primary and a streaming standby) the same run goes over
//     pgvector with POSTGRES_READ_REPLICA_URLS handed to every tier, as a
//     shared server/.env would. Without both it is reported as skipped. The
//     local variant (no database) always runs.
//
// Each variant checks: /chat through the edge answers what a monolith over
// the same data answers; every internal hop carried an EdDSA token signed by
// its own tier; each tier's /metrics shows its hops (the edge's call to the
// agent, the agent's to retrieval and the gateway, the retrieval tier's to
// the gateway and, with the replica, its search on the standby, the
// gateway's model calls) and nothing identifying the tenant, the document or
// the question; the short edge times out with 504 and the agent run ends
// failed with deadline_exceeded; with the retrieval tier down /chat answers
// 503 AGENT_DEPENDENCY_UNAVAILABLE.
//
// No model or network beyond 127.0.0.1; no database unless the two URLs name
// disposable clusters.

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverUrl = pathToFileURL(`${serverDirectory}/`).href;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "service-split-hardening-"));
const EMBEDDING_DIMENSIONS = 64;
const EMBEDDING_MODEL = "text-embedding-3-small";
const METRICS_TOKEN = randomBytes(16).toString("hex");
const TOKEN = `alice-${randomBytes(8).toString("hex")}`;
const QUESTION = "How many paid annual leave days do employees receive?";
const DOCUMENT_TITLE = "aster-handbook";
const DOCUMENT_LINES = [
  "Program Aster employee handbook.",
  "Employees receive twelve paid annual leave days each year.",
  "Unused leave days carry over until the end of March.",
];
const SHORT_EDGE_TIMEOUT_MS = 1000;
const KEYS = {
  agent: generateServiceKeyPair({ issuer: "agent" }),
  api: generateServiceKeyPair({ issuer: "api" }),
  retrieval: generateServiceKeyPair({ issuer: "retrieval" }),
};
const TRUSTED = Object.values(KEYS)
  .map((pair) => pair.trustedEntry)
  .join(",");

const adminPrimaryUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();
const adminReplicaUrl = String(process.env.PGVECTOR_TEST_REPLICA_URL ?? "").trim();

const children = new Set();
const servers = new Set();
const cleanups = [];

after(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }

  await Promise.all([...servers].map((server) => server.stop()));

  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch(() => {});
  }

  rmSync(tempRoot, { force: true, recursive: true });
});

const startHttpServer = async (handler) => {
  const server = http.createServer(handler);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const entry = {
    stop: () =>
      new Promise((resolve) => {
        servers.delete(entry);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    url: `http://127.0.0.1:${server.address().port}`,
  };

  servers.add(entry);

  return entry;
};

const readBody = async (req) => {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

// OpenAI-compatible chat (JSON or SSE) and embeddings: the load bench's
// deterministic answer and hashed term vectors. holdNextChat() keeps the next
// chat answer back until releaseHeld().
const startFakeModel = async () => {
  const holds = [];
  const held = [];
  const server = await startHttpServer(async (req, res) => {
    const payload = JSON.parse((await readBody(req)) || "{}");

    if (req.url.endsWith("/embeddings")) {
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: inputs.map((input, index) => ({ embedding: hashEmbedding(input, EMBEDDING_DIMENSIONS), index, object: "embedding" })),
          model: payload.model,
          object: "list",
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
      );
      return;
    }

    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No such route." } }));
      return;
    }

    if (holds.length > 0) {
      holds.shift();
      await new Promise((resolve) => held.push(resolve));
    }

    const content = buildFakeChatAnswer(payload);
    const usage = { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 };

    if (res.destroyed) {
      return;
    }

    if (!payload.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
          model: payload.model,
          object: "chat.completion",
          usage,
        })
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }], model: payload.model })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], model: payload.model, usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });

  return {
    ...server,
    holdNextChat: () => holds.push(true),
    releaseHeld: () => {
      holds.splice(0);
      held.splice(0).forEach((release) => release());
    },
  };
};

const decodeSegment = (segment) => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

// A transparent forwarder in front of one tier that keeps the token header
// and claims of every hop (never a body). It answers 503 until the tier is up
// (the edge's start-up probe); stop() closes it, so a caller then gets a
// refused connection, as from a stopped tier.
const startTap = async (tier) => {
  const hops = [];
  let targetPort = null;
  const tap = await startHttpServer((req, res) => {
    const [header, payload] = String(req.headers["x-archive-service-token"] ?? "").split(".");

    hops.push({ header: decodeSegment(header), payload: decodeSegment(payload), tier });

    if (targetPort === null) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not started." }));
      return;
    }

    const upstream = http.request(
      { headers: req.headers, host: "127.0.0.1", method: req.method, path: req.url, port: targetPort },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      }
    );

    upstream.on("error", () => res.destroy());
    res.on("close", () => {
      if (!res.writableFinished) {
        upstream.destroy();
      }
    });
    req.pipe(upstream);
  });

  return {
    ...tap,
    hops,
    setTarget: (port) => {
      targetPort = port;
    },
  };
};

// Resolves once the process has printed both its app port and its metrics
// port (every process here runs with METRICS_ENABLED=true).
const spawnTier = async ({ args, environment, name }) => {
  const child = spawn(process.execPath, args, { cwd: tempRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";

  children.add(child);

  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ports = await new Promise((resolve, reject) => {
    const keep = (chunk) => {
      output = `${output}${chunk}`.slice(-12000);

      const appPort = /(?:is running on port|HARDENING_LISTENING) (\d+)/u.exec(output)?.[1];
      const metricsPort = /\[metrics\] serving \/metrics on http:\/\/127\.0\.0\.1:(\d+) \(bearer token required\)/u.exec(output)?.[1];

      if (appPort && metricsPort) {
        resolve({ appPort: Number(appPort), metricsPort: Number(metricsPort) });
      }
    };

    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    exited.then(({ code, signal }) => reject(new Error(`${name} exited (${code ?? signal}) before listening:\n${output}`)));
  });

  return {
    logs: () => output,
    metricsUrl: `http://127.0.0.1:${ports.metricsPort}/metrics`,
    name,
    port: ports.appPort,
    stop: async () => {
      child.kill("SIGTERM");
      const outcome = await exited;
      children.delete(child);
      return outcome;
    },
    url: `http://127.0.0.1:${ports.appPort}`,
  };
};

// Nothing from the developer's shell or server/.env reaches a process.
const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

writeFileSync(emptyEnvironmentFile, "", "utf8");

const baseEnvironment = (storage) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
  AGENT_EXECUTION_PLANNER: "deterministic",
  AGENT_INTENT_PLANNER: "deterministic",
  AGENT_PLANNER_ROLLOUT: "deterministic",
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify({ [TOKEN]: { userId: "alice", workspaceId: "ws-a" } }),
  DOTENV_CONFIG_PATH: emptyEnvironmentFile,
  DOTENV_CONFIG_QUIET: "true",
  METRICS_ENABLED: "true",
  METRICS_PORT: "0",
  METRICS_TOKEN,
  OPENAI_CHAT_MODEL: "hardening-chat",
  OPENAI_EMBEDDING_MODEL: EMBEDDING_MODEL,
  PDF_PARSER: "pdfjs",
  RAG_CLAIM_JUDGE: "off",
  RAG_INGEST_MODE: "sync",
  RAG_OBSERVABILITY_ENABLED: "false",
  RAG_RERANK_ENABLED: "false",
  RAG_SEMANTIC_CACHE: "off",
  RAG_SHARED_STATE: "memory",
  RATE_LIMIT_ENABLED: "false",
  STARTUP_HEALTH_STRICT: "false",
  ...storage,
});

const tierEnvironment = (storage, { role, signingKey, ...rest }) => ({
  ...baseEnvironment(storage),
  ARCHIVE_RAG_ROLE: role,
  INTERNAL_SERVICE_AUTH: "ed25519",
  ...(signingKey ? { INTERNAL_SERVICE_SIGNING_KEY: signingKey.privateKeyBase64 } : {}),
  INTERNAL_SERVICE_TRUSTED_KEYS: TRUSTED,
  ...rest,
});

// The retrieval tier's entry points refuse VECTOR_STORE_PROVIDER=local (its
// index would be a per-process copy), so the local variant starts it from its
// app factory, with the metrics listener server.js would add.
const LOCAL_RETRIEVAL_HARNESS = [
  "--input-type=module",
  "-e",
  `const root = ${JSON.stringify(serverUrl)};
const { applyStandaloneProfile } = await import(new URL("standalone-profile.js", root));
applyStandaloneProfile();
const { createRetrievalApp } = await import(new URL("rag/retrieval-service/app.js", root));
const { startMetricsFromEnv } = await import(new URL("rag/metrics-server.js", root));
const app = createRetrievalApp({});
const server = app.listen(0, "127.0.0.1", async () => {
  console.log("HARDENING_LISTENING " + server.address().port);
  await startMetricsFromEnv({ httpServer: server });
});
process.once("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});`,
];
const SERVER_ENTRY = [path.join(serverDirectory, "server.js")];

const request = async (baseUrl, route, { body, form, method = "GET" } = {}) => {
  const response = await fetch(`${baseUrl}${route}`, {
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-api-key": TOKEN },
    method,
  });
  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { json, retryAfter: response.headers.get("retry-after"), status: response.status, text };
};

// A session of its own per question, so no earlier answer reaches a prompt.
const chat = (baseUrl, docId) =>
  request(baseUrl, "/chat", {
    body: { docIds: [docId], question: QUESTION, sessionId: `hardening-${randomBytes(6).toString("hex")}` },
    method: "POST",
  });

const scrape = async (tier) => {
  const response = await fetch(tier.metricsUrl, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  const text = await response.text();

  assert.equal(response.status, 200, `${tier.name} /metrics: ${text}`);

  return { families: parseExposition(text), text };
};

const scrapeAll = async (tiers) =>
  Object.fromEntries(await Promise.all(Object.entries(tiers).map(async ([name, tier]) => [name, await scrape(tier)])));

const delta = (before, afterScrape, name, labels = {}) =>
  sampleValue(afterScrape.families, name, labels) - sampleValue(before.families, name, labels);

const waitFor = async (label, check, { intervalMs = 50, timeoutMs = 20_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    last = await check().catch((error) => error);

    if (last && !(last instanceof Error)) {
      return last;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
};

const runSplitDeployment = async ({ replica = null, storage }) => {
  const model = await startFakeModel();
  const taps = {
    agent: await startTap("agent"),
    modelGateway: await startTap("model-gateway"),
    retrieval: await startTap("retrieval"),
  };
  const sharedTierSettings = replica ? { ...replica.environment } : {};
  const spawned = [];
  const spawnTracked = async (options) => {
    const tier = await spawnTier(options);

    spawned.push(tier);
    return tier;
  };

  try {
    // The edge first: on pgvector it migrates the database before anyone else.
    const api = await spawnTracked({
      args: SERVER_ENTRY,
      environment: tierEnvironment(storage, {
        ...sharedTierSettings,
        AGENT_SERVICE_URL: taps.agent.url,
        MODEL_GATEWAY_URL: taps.modelGateway.url,
        PORT: "0",
        role: "api",
        signingKey: KEYS.api,
      }),
      name: "api",
    });
    const gateway = await spawnTracked({
      args: SERVER_ENTRY,
      environment: tierEnvironment(storage, {
        ...sharedTierSettings,
        MODEL_GATEWAY_CHAT_UPSTREAMS: `${model.url}/v1`,
        MODEL_GATEWAY_EMBEDDING_UPSTREAMS: `${model.url}/v1`,
        MODEL_GATEWAY_PORT: "0",
        OPENAI_API_KEY: "hardening-gateway-key",
        role: "model-gateway",
      }),
      name: "model-gateway",
    });

    taps.modelGateway.setTarget(gateway.port);

    const form = new FormData();

    form.append(
      "file",
      new Blob([buildTextPdf({ pages: [DOCUMENT_LINES], title: "Aster handbook" })], { type: "application/pdf" }),
      `${DOCUMENT_TITLE}.pdf`
    );

    const upload = await request(api.url, "/upload", { form, method: "POST" });

    assert.equal(upload.status, 201, upload.text);

    const docId = upload.json?.docId ?? upload.json?.document?.docId;

    assert.ok(docId, upload.text);
    await replica?.caughtUp();

    // The document is stored now (on disk for the local variant, whose
    // retrieval tier reads it at start).
    const [retrieval, agent, shortEdge, monolith] = await Promise.all([
      spawnTracked({
        args: replica ? SERVER_ENTRY : LOCAL_RETRIEVAL_HARNESS,
        environment: tierEnvironment(storage, {
          ...sharedTierSettings,
          MODEL_GATEWAY_URL: taps.modelGateway.url,
          PORT: "0",
          role: "retrieval",
          signingKey: KEYS.retrieval,
        }),
        name: "retrieval",
      }),
      spawnTracked({
        args: SERVER_ENTRY,
        environment: tierEnvironment(storage, {
          ...sharedTierSettings,
          MODEL_GATEWAY_URL: taps.modelGateway.url,
          PORT: "0",
          RETRIEVAL_SERVICE_URL: taps.retrieval.url,
          role: "agent",
          signingKey: KEYS.agent,
        }),
        name: "agent",
      }),
      spawnTracked({
        args: SERVER_ENTRY,
        environment: tierEnvironment(storage, {
          ...sharedTierSettings,
          AGENT_SERVICE_TIMEOUT_MS: String(SHORT_EDGE_TIMEOUT_MS),
          AGENT_SERVICE_URL: taps.agent.url,
          MODEL_GATEWAY_URL: taps.modelGateway.url,
          PORT: "0",
          role: "api",
          signingKey: KEYS.api,
        }),
        name: "short-edge",
      }),
      // The reference: one process over the same data, calling the model
      // itself, without a replica.
      spawnTracked({
        args: SERVER_ENTRY,
        environment: {
          ...baseEnvironment(storage),
          OPENAI_API_KEY: "hardening-monolith-key",
          OPENAI_BASE_URL: `${model.url}/v1`,
          PORT: "0",
        },
        name: "monolith",
      }),
    ]);

    taps.retrieval.setTarget(retrieval.port);
    taps.agent.setTarget(agent.port);

    const tiers = { agent, api, gateway, retrieval };

    if (replica) {
      // Reading the routing snapshot (a scrape of the retrieval tier) starts
      // its lag monitor; wait until it has measured the standby.
      await waitFor("the retrieval tier to measure the replica", async () => {
        const { families } = await scrape(retrieval);

        return families.has("archive_rag_postgres_replica_lag_seconds") &&
          sampleValue(families, "archive_rag_postgres_replica_lag_seconds", { replica: "replica-0" }) >= 0
          ? true
          : null;
      });
    }

    // ---- /chat answers as the monolith does --------------------------------
    const expected = await chat(monolith.url, docId);

    assert.equal(expected.status, 200, expected.text);
    assert.match(expected.json.agentAnswer, /twelve paid annual leave days/u);

    const before = await scrapeAll(tiers);
    const actual = await chat(api.url, docId);

    assert.equal(actual.status, 200, actual.text);

    for (const field of ["agentAnswer", "agentMode", "ragAnswer", "ragAbstained"]) {
      assert.equal(actual.json[field], expected.json[field], field);
    }

    assert.deepEqual(actual.json.ragSources, expected.json.ragSources);

    // ---- every internal hop: EdDSA, the issuer's own key, the policy -------
    const expectedIssuers = { agent: ["api"], "model-gateway": ["agent", "api", "retrieval"], retrieval: ["agent"] };

    for (const tap of Object.values(taps)) {
      const signed = tap.hops.filter((hop) => hop.header);
      const issuers = new Set(signed.map((hop) => hop.payload?.iss));

      assert.ok(signed.length > 0, `${tap.hops[0]?.tier} saw signed calls`);

      for (const hop of signed) {
        assert.equal(hop.header.alg, "EdDSA", hop.tier);
        assert.equal(hop.header.kid, KEYS[hop.payload.iss].keyId, `${hop.tier}: ${hop.payload.iss} signs with its own key`);
        assert.equal(hop.payload.aud, hop.tier);
        assert.equal(typeof hop.payload.htu, "string", "bound to its request");
      }

      assert.deepEqual([...issuers].sort(), expectedIssuers[signed[0].tier], signed[0].tier);
    }

    // ---- the scrape shows the hops ----------------------------------------
    const afterChat = await scrapeAll(tiers);
    const moved = (tier, name, labels) => delta(before[tier], afterChat[tier], name, labels);

    assert.equal(moved("api", "archive_rag_http_requests_total", { method: "POST", route: "/chat", status_class: "2xx" }), 1);
    assert.ok(moved("api", "archive_rag_service_client_calls_total", { code: "2xx", tier: "agent" }) >= 1, "edge -> agent");
    assert.equal(moved("agent", "archive_rag_http_requests_total", { method: "POST", route: "/chat", status_class: "2xx" }), 1);
    assert.equal(moved("agent", "archive_rag_agent_runs_total", { outcome: "completed" }), 1);
    assert.ok(moved("agent", "archive_rag_service_client_calls_total", { code: "2xx", tier: "retrieval" }) >= 1, "agent -> retrieval");
    assert.ok(moved("agent", "archive_rag_service_client_calls_total", { code: "2xx", tier: "model-gateway" }) >= 1, "agent -> gateway");
    assert.ok(moved("agent", "archive_rag_model_calls_total", { metering: "mirror", operation: "llm_completion" }) >= 1);
    assert.ok(moved("retrieval", "archive_rag_http_requests_total", { status_class: "2xx" }) >= 1);
    assert.ok(moved("retrieval", "archive_rag_retrieval_route_duration_seconds_count", { route: "dense" }) >= 1);
    assert.ok(moved("retrieval", "archive_rag_service_client_calls_total", { code: "2xx", tier: "model-gateway" }) >= 1, "retrieval -> gateway");
    assert.ok(moved("gateway", "archive_rag_model_calls_total", { metering: "gateway", operation: "llm_completion", status: "ok" }) >= 1);
    assert.ok(moved("gateway", "archive_rag_model_calls_total", { metering: "gateway", operation: "embedding", status: "ok" }) >= 1);

    if (replica) {
      assert.ok(
        moved("retrieval", "archive_rag_postgres_reads_total", { target: "replica" }) >= 1,
        `the search ran on the standby: ${afterChat.retrieval.text.split("\n").filter((line) => line.startsWith("archive_rag_postgres_r")).join("\n")}`
      );

      // Only the process that retrieves reads the routing snapshot (which
      // starts the lag monitor), although every tier was handed the replica
      // URL: the others export the families without samples.
      for (const name of ["api", "agent", "gateway"]) {
        for (const family of ["archive_rag_postgres_replica_lag_seconds", "archive_rag_postgres_reads_total"]) {
          assert.deepEqual(
            afterChat[name].text.split("\n").filter((line) => line.startsWith(family)),
            [],
            `${name} reports ${family}`
          );
        }
      }
    }

    for (const [name, { text }] of Object.entries(afterChat)) {
      for (const leaked of [docId, "alice", "ws-a", TOKEN, METRICS_TOKEN, "annual leave", "Aster", DOCUMENT_TITLE, model.url, ...(replica?.secrets ?? [])]) {
        assert.equal(text.includes(leaked), false, `${name}'s exposition contains ${leaked}`);
      }
    }

    // ---- a short edge timeout cancels the agent run ------------------------
    model.holdNextChat();

    const deadlineBefore = await scrape(agent);
    const timedOut = await chat(shortEdge.url, docId);

    assert.equal(timedOut.status, 504, timedOut.text);
    assert.ok(["SERVICE_TIMEOUT", "AGENT_DEADLINE_EXCEEDED"].includes(timedOut.json?.code), timedOut.text);

    const cancelledRun = await waitFor("the agent run to end with the deadline", async () => {
      const runs = await request(api.url, "/agent-runs");

      return runs.json?.runs?.find((run) => run.error?.code === "AGENT_DEADLINE_EXCEEDED") ?? null;
    });

    assert.equal(cancelledRun.status, "failed");
    assert.equal(cancelledRun.error.reason, "deadline_exceeded");
    assert.equal(cancelledRun.error.retryable, true);
    await waitFor("the agent's metrics to count it", async () =>
      delta(deadlineBefore, await scrape(agent), "archive_rag_agent_runs_total", { outcome: "failed", reason: "deadline_exceeded" }) === 1
        ? true
        : null
    );
    model.releaseHeld();

    // ---- the retrieval tier down: a dependency outage, 503 -----------------
    assert.equal((await retrieval.stop()).code, 0, retrieval.logs());
    spawned.splice(spawned.indexOf(retrieval), 1);
    await taps.retrieval.stop();

    const outageBefore = await scrapeAll({ agent, api });
    const withoutRetrieval = await chat(api.url, docId);

    assert.equal(withoutRetrieval.status, 503, withoutRetrieval.text);
    assert.equal(withoutRetrieval.retryAfter, "5");
    assert.equal(withoutRetrieval.json.code, "AGENT_DEPENDENCY_UNAVAILABLE");
    assert.equal(withoutRetrieval.json.dependency, "retrieval");
    assert.equal(withoutRetrieval.json.causeCode, "SERVICE_UNREACHABLE");
    assert.equal(withoutRetrieval.json.retryable, true);

    const afterOutage = await scrapeAll({ agent, api });

    assert.equal(
      delta(outageBefore.agent, afterOutage.agent, "archive_rag_agent_runs_total", { outcome: "failed", reason: "dependency_retrieval" }),
      1
    );
    assert.ok(
      delta(outageBefore.agent, afterOutage.agent, "archive_rag_service_client_calls_total", { code: "SERVICE_UNREACHABLE", tier: "retrieval" }) >= 1
    );
    assert.equal(
      delta(outageBefore.api, afterOutage.api, "archive_rag_http_requests_total", { method: "POST", route: "/chat", status_class: "5xx" }),
      1
    );

    // The split roles drain and exit 0 on SIGTERM; the monolith's server.js
    // installs no handler and ends by the signal itself.
    for (const tier of [api, agent, gateway, shortEdge]) {
      assert.equal((await tier.stop()).code, 0, `${tier.name}:\n${tier.logs()}`);
      spawned.splice(spawned.indexOf(tier), 1);
    }

    await monolith.stop();
    spawned.splice(spawned.indexOf(monolith), 1);
  } catch (error) {
    for (const tier of spawned) {
      console.error(`--- ${tier.name} log tail ---\n${tier.logs()}`);
    }

    throw error;
  } finally {
    model.releaseHeld();
  }
};

test("split with ed25519, metrics and deadlines (local vector store): answers as the monolith, the scrape shows the hops, a short edge cancels the run, a down retrieval tier is a 503", { timeout: 180_000 }, async () => {
  await runSplitDeployment({
    storage: {
      DOCCOMPARE_STANDALONE: "1",
      RAG_DATA_DIRECTORY: path.join(tempRoot, "local-rag-data"),
      UPLOADS_DIRECTORY: path.join(tempRoot, "local-uploads"),
      VECTOR_STORE_PROVIDER: "local",
    },
  });
});

const replicaSkip =
  adminPrimaryUrl && adminReplicaUrl
    ? false
    : "PGVECTOR_TEST_DATABASE_URL and PGVECTOR_TEST_REPLICA_URL are not both set; run `bash scripts/run-pgvector-replica-integration.sh`";

test("split with ed25519, metrics, deadlines and a read replica (pgvector): the retrieval tier searches on the standby", { skip: replicaSkip, timeout: 240_000 }, async () => {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `hardening_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `hardening_tenant_${suffix}`;
  const databaseName = `hardening_${suffix}`;
  const withDatabase = (url, { password, user } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${databaseName}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const adminQuery = async (url, sql) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  };
  const lsnOf = (text) => {
    const [high, low] = String(text).split("/");

    return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  };
  const caughtUp = async () => {
    const primaryLsn = (await adminQuery(withDatabase(adminPrimaryUrl), "SELECT pg_current_wal_flush_lsn()::text AS lsn")).rows[0].lsn;

    await waitFor("the replica to replay the primary's WAL", async () => {
      const replayLsn = (await adminQuery(withDatabase(adminReplicaUrl), "SELECT pg_last_wal_replay_lsn()::text AS lsn")).rows[0].lsn;

      return lsnOf(replayLsn) >= lsnOf(primaryLsn) ? true : null;
    });
  };

  cleanups.push(async () => {
    await adminQuery(adminPrimaryUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await adminQuery(adminPrimaryUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
    await adminQuery(adminPrimaryUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
  });
  await adminQuery(adminPrimaryUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
  await adminQuery(adminPrimaryUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
  await adminQuery(withDatabase(adminPrimaryUrl), "CREATE EXTENSION IF NOT EXISTS vector");
  await caughtUp();

  const ownerReplicaUrl = withDatabase(adminReplicaUrl, { password: ownerPassword, user: ownerRole });

  await runSplitDeployment({
    replica: {
      caughtUp,
      environment: {
        POSTGRES_READ_REPLICA_LAG_POLL_MS: "50",
        // Generous: this run checks routing across the tiers, not the lag limit.
        POSTGRES_READ_REPLICA_MAX_LAG_MS: "600000",
        POSTGRES_READ_REPLICA_URLS: ownerReplicaUrl,
      },
      secrets: [ownerPassword, ownerReplicaUrl],
    },
    storage: {
      POSTGRES_DATABASE_URL: withDatabase(adminPrimaryUrl, { password: ownerPassword, user: ownerRole }),
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_DATA_DIRECTORY: path.join(tempRoot, "pg-rag-data"),
      RAG_EMBEDDING_DIMENSIONS: String(EMBEDDING_DIMENSIONS),
      RAG_LONG_MEMORY_ENABLED: "false",
      UPLOADS_DIRECTORY: path.join(tempRoot, "pg-uploads"),
      VECTOR_STORE_PROVIDER: "pgvector",
    },
  });
});
