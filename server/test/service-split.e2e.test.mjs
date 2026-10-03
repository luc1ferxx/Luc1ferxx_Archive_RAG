import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";

// The split deployment end to end, every tier in its own process:
//
//   client -> api -> agent -> retrieval -> model-gateway -> fake model
//                        \______________________/^
//
// api, agent and model-gateway start through `node server.js` with their
// ARCHIVE_RAG_ROLE, exactly as the image does. The retrieval tier's own entry
// points refuse VECTOR_STORE_PROVIDER=local (its index would be a per-process
// copy), so it starts from a two-line harness over the same app factory after
// the document is uploaded, when the copy on disk is complete. Every tier
// listens on port 0; the internal URLs point at taps in this process that
// forward to the tier once its port is known and record what arrives at each
// hop (trace context, token issuer and audience, tenant), never bodies.
//
// A monolith over the same data directory answers the same questions first;
// the split deployment must answer them identically, and one trace id must
// cover every tier. The model gateway then gets SIGTERM while a model answer
// is in flight, and must finish it before it exits (tracing on). Then the
// gateway, the retrieval tier and the agent tier are down in turn while the
// edge keeps serving GET /documents: /chat answers the first two as a
// dependency outage (503 with a stable code and Retry-After, the run failed
// and retryable, its document RAG step failed with the stable error), as the
// monolith answers its own model or database being down, and the edge answers
// the third with a 503.
//
// No model, database or network beyond 127.0.0.1. Nothing waits on a timer:
// readiness is each process's listening line, and the span export (every 5 s
// in the batch processor) settles a waiter as it arrives.

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverUrl = pathToFileURL(`${serverDirectory}/`).href;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "service-split-e2e-"));
const SECRET = randomBytes(32).toString("hex");
const EMBEDDING_DIMENSIONS = 64;
const TOKENS = {
  alice: `alice-${randomBytes(8).toString("hex")}`,
  bob: `bob-${randomBytes(8).toString("hex")}`,
};
const QUESTION = "How many paid annual leave days do employees receive?";
const DOCUMENT_LINES = [
  "Program Aster employee handbook.",
  "Employees receive twelve paid annual leave days each year.",
  "Unused leave days carry over until the end of March.",
  "Remote work needs written approval from a manager.",
];

const children = new Set();
const servers = new Set();

after(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }

  await Promise.all([...servers].map((server) => server.stop()));
  rmSync(tempRoot, { force: true, recursive: true });
});

const startHttpServer = async (handler) => {
  const server = http.createServer(handler);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const entry = {
    port: server.address().port,
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
// deterministic answers (the best evidence sentence with its source label) and
// hashed term vectors. It records which key called, to prove only the gateway
// and the monolith ever reach it. holdNextChat() keeps the next chat answer
// back until release(); `arrived` settles when that request is in.
const startFakeModel = async () => {
  const calls = [];
  const holds = [];
  const server = await startHttpServer(async (req, res) => {
    const payload = JSON.parse((await readBody(req)) || "{}");
    const kind = req.url.endsWith("/embeddings") ? "embeddings" : req.url.endsWith("/chat/completions") ? "chat" : null;

    if (kind === "chat" && holds.length > 0) {
      const hold = holds.shift();

      hold.arrive();
      await hold.released;
    }

    calls.push({ authorization: req.headers.authorization ?? null, kind });

    if (kind === "embeddings") {
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: inputs.map((input, index) => ({
            embedding: hashEmbedding(input, EMBEDDING_DIMENSIONS),
            index,
            object: "embedding",
          })),
          model: payload.model,
          object: "list",
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
      );
      return;
    }

    if (kind !== "chat") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No such route." } }));
      return;
    }

    const content = buildFakeChatAnswer(payload);
    const usage = { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 };

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

    // Three pieces, so a sentence and its source label arrive separately.
    const cut = [Math.floor(content.length / 3), Math.floor((2 * content.length) / 3)];
    const pieces = [content.slice(0, cut[0]), content.slice(cut[0], cut[1]), content.slice(cut[1])];

    res.writeHead(200, { "content-type": "text/event-stream" });

    for (const piece of pieces) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, index: 0 }], model: payload.model })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ choices: [], model: payload.model, usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });

  const holdNextChat = () => {
    const hold = {};

    hold.arrived = new Promise((resolve) => {
      hold.arrive = resolve;
    });
    hold.released = new Promise((resolve) => {
      hold.release = resolve;
    });
    holds.push(hold);

    return hold;
  };

  return { ...server, calls, holdNextChat };
};

// An OTLP/HTTP JSON collector: the trace id and service of every span.
// waitFor(predicate, timeoutMs) settles as soon as an export makes the
// predicate true (true), or at the deadline (false).
const startCollector = async () => {
  const spans = [];
  const waiters = new Set();
  const notify = () => {
    for (const waiter of waiters) {
      if (waiter.predicate()) {
        waiter.settle(true);
      }
    }
  };
  const waitFor = (predicate, timeoutMs) =>
    new Promise((resolve) => {
      if (predicate()) {
        resolve(true);
        return;
      }

      const waiter = {
        predicate,
        settle: (outcome) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(outcome);
        },
      };
      const timer = setTimeout(() => waiter.settle(false), timeoutMs);

      waiters.add(waiter);
    });
  const server = await startHttpServer(async (req, res) => {
    const payload = JSON.parse((await readBody(req)) || "{}");

    for (const resourceSpans of payload.resourceSpans ?? []) {
      const service = (resourceSpans.resource?.attributes ?? []).find((entry) => entry.key === "service.name")
        ?.value?.stringValue;

      for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
        for (const span of scopeSpans.spans ?? []) {
          spans.push({ name: span.name, service, traceId: span.traceId });
        }
      }
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    notify();
  });

  return { ...server, spans, waitFor };
};

const decodeTokenClaims = (token) => {
  if (typeof token !== "string") {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

    return {
      audience: payload.aud,
      issuer: payload.iss,
      system: payload.sys === true,
      userId: payload.scope?.userId ?? null,
    };
  } catch {
    return null;
  }
};

// A transparent forwarder in front of one tier. Until the tier is up it
// answers 503 (the edge's startup probe); stop() closes it, so a caller then
// gets a refused connection, exactly as from a stopped tier.
const startTap = async (tier) => {
  const hops = [];
  let targetPort = null;
  const server = await startHttpServer((req, res) => {
    hops.push({
      method: req.method,
      path: req.url.split("?")[0],
      requestId: req.headers["x-archive-service-request-id"] ?? null,
      tier,
      token: decodeTokenClaims(req.headers["x-archive-service-token"]),
      traceparent: req.headers.traceparent ?? null,
    });

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
    ...server,
    hops,
    setTarget: (port) => {
      targetPort = port;
    },
  };
};

const spawnTier = async ({ args, environment, name }) => {
  const child = spawn(process.execPath, args, {
    cwd: tempRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = [];
  const watchers = new Set();
  const keep = (chunk) => {
    tail.push(...String(chunk).split("\n").filter(Boolean));
    tail.splice(0, Math.max(0, tail.length - 60));

    for (const watcher of watchers) {
      if (watcher.pattern.test(tail.join("\n"))) {
        watchers.delete(watcher);
        watcher.resolve();
      }
    }
  };

  children.add(child);
  child.stderr.on("data", keep);

  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      keep(chunk);
      const match = /(?:is running on port|E2E_LISTENING) (\d+)/u.exec(tail.join("\n"));

      if (match) {
        resolve(Number(match[1]));
      }
    });
    exited.then(({ code, signal }) =>
      reject(new Error(`${name} exited (${code ?? signal}) before listening:\n${tail.join("\n")}`))
    );
  });

  return {
    child,
    exited,
    logs: () => tail.join("\n"),
    name,
    // Settles once the process has printed a line matching `pattern`.
    output: (pattern) =>
      new Promise((resolve) => {
        if (pattern.test(tail.join("\n"))) {
          resolve();
        } else {
          watchers.add({ pattern, resolve });
        }
      }),
    port,
    stop: async () => {
      child.kill("SIGTERM");
      const outcome = await exited;
      children.delete(child);
      return outcome;
    },
    url: `http://127.0.0.1:${port}`,
  };
};

// Only what a process needs to run; nothing from the developer's shell or
// server/.env (DOTENV_CONFIG_PATH names an empty file, and the working
// directory is the temp root) can point a tier elsewhere.
const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

writeFileSync(emptyEnvironmentFile, "", "utf8");

const commonEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
  AGENT_EXECUTION_PLANNER: "deterministic",
  AGENT_INTENT_PLANNER: "deterministic",
  AGENT_PLANNER_ROLLOUT: "deterministic",
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify({
    [TOKENS.alice]: { userId: "alice", workspaceId: "ws-a" },
    [TOKENS.bob]: { userId: "bob", workspaceId: "ws-b" },
  }),
  DOCCOMPARE_STANDALONE: "1",
  DOTENV_CONFIG_PATH: emptyEnvironmentFile,
  DOTENV_CONFIG_QUIET: "true",
  OPENAI_CHAT_MODEL: "e2e-chat",
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
  PDF_PARSER: "pdfjs",
  RAG_CLAIM_JUDGE: "off",
  RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
  RAG_INGEST_MODE: "sync",
  RAG_OBSERVABILITY_ENABLED: "false",
  RAG_RERANK_ENABLED: "false",
  RAG_SEMANTIC_CACHE: "off",
  RAG_SHARED_STATE: "memory",
  RATE_LIMIT_ENABLED: "false",
  STARTUP_HEALTH_STRICT: "false",
  UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
  VECTOR_STORE_PROVIDER: "local",
});

// The split tiers share one keyring and export spans to the collector; only
// the gateway holds a model key.
const splitEnvironment = ({ collector, role, ...rest }) => ({
  ...commonEnvironment(),
  ARCHIVE_RAG_ROLE: role,
  INTERNAL_SERVICE_KEYS: `e2e:${SECRET}`,
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/v1/traces`,
  OTEL_SERVICE_NAME: `archive-rag-${role}`,
  OTEL_TRACING_ENABLED: "true",
  ...rest,
});

const harness = (body) => [
  "--input-type=module",
  "-e",
  `const root = ${JSON.stringify(serverUrl)};
const { applyStandaloneProfile } = await import(new URL("standalone-profile.js", root));
applyStandaloneProfile();
if (process.env.OTEL_TRACING_ENABLED === "true") {
  const { startTracing } = await import(new URL("otel.js", root));
  startTracing();
}
${body}
const server = app.listen(0, "127.0.0.1", () => console.log("E2E_LISTENING " + server.address().port));
process.once("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});`,
];

const RETRIEVAL_HARNESS = harness(
  `const { createRetrievalApp } = await import(new URL("rag/retrieval-service/app.js", root));
const app = createRetrievalApp({});`
);
const MONOLITH_HARNESS = harness(
  `const { createApp } = await import(new URL("app.js", root));
const app = await createApp();`
);
const SERVER_ENTRY = [path.join(serverDirectory, "server.js")];

const request = async (baseUrl, route, { body, method = "GET", token } = {}) => {
  const response = await fetch(`${baseUrl}${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { "x-api-key": token } : {}),
    },
    method,
  });
  const text = await response.text();

  return {
    json: text ? JSON.parse(text) : null,
    retryAfter: response.headers.get("retry-after"),
    status: response.status,
    text,
  };
};

const readStream = async (baseUrl, body, token) => {
  const response = await fetch(`${baseUrl}/chat/stream`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-api-key": token },
    method: "POST",
  });
  const text = await response.text();
  const events = text
    .split("\n\n")
    .map((block) => ({
      data: /^data: (.*)$/mu.exec(block)?.[1],
      event: /^event: (.*)$/mu.exec(block)?.[1],
    }))
    .filter((entry) => entry.event)
    .map((entry) => ({ data: entry.data ? JSON.parse(entry.data) : null, event: entry.event }));

  return { events, status: response.status };
};

const drafts = (events) => events.filter((entry) => entry.event === "answer_draft").map((entry) => entry.data.text);
const resultOf = (events) => events.find((entry) => entry.event === "result")?.data;
const traceIdOf = (traceparent) => /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/u.exec(traceparent ?? "")?.[1] ?? null;

test("api -> agent -> retrieval -> model-gateway answers as the monolith does, and each stopped tier fails cleanly", async () => {
  const model = await startFakeModel();
  const collector = await startCollector();
  const taps = {
    agent: await startTap("agent"),
    modelGateway: await startTap("model-gateway"),
    retrieval: await startTap("retrieval"),
  };
  const tapped = () => [...taps.agent.hops, ...taps.retrieval.hops, ...taps.modelGateway.hops];
  const clearHops = () => Object.values(taps).forEach((tap) => tap.hops.splice(0));

  const gateway = await spawnTier({
    args: SERVER_ENTRY,
    environment: splitEnvironment({
      collector,
      MODEL_GATEWAY_CHAT_UPSTREAMS: `${model.url}/v1`,
      MODEL_GATEWAY_EMBEDDING_UPSTREAMS: `${model.url}/v1`,
      MODEL_GATEWAY_PORT: "0",
      OPENAI_API_KEY: "e2e-gateway-key",
      role: "model-gateway",
    }),
    name: "model-gateway",
  });

  taps.modelGateway.setTarget(gateway.port);

  const api = await spawnTier({
    args: SERVER_ENTRY,
    environment: splitEnvironment({
      AGENT_SERVICE_URL: taps.agent.url,
      collector,
      MODEL_GATEWAY_URL: taps.modelGateway.url,
      PORT: "0",
      role: "api",
    }),
    name: "api",
  });

  // Uploads stay at the edge; the chunks are embedded through the gateway.
  const form = new FormData();

  form.append(
    "file",
    new Blob([buildTextPdf({ pages: [DOCUMENT_LINES], title: "Aster handbook" })], { type: "application/pdf" }),
    "aster-handbook.pdf"
  );

  const upload = await fetch(`${api.url}/upload`, {
    body: form,
    headers: { "x-api-key": TOKENS.alice },
    method: "POST",
  });

  assert.equal(upload.status, 201, await upload.clone().text());

  const listed = await request(api.url, "/documents", { token: TOKENS.alice });
  const docId = listed.json?.[0]?.docId;

  assert.equal(listed.status, 200);
  assert.ok(docId, listed.text);
  assert.ok(
    taps.modelGateway.hops.some(
      (hop) => hop.path === "/v1/embeddings" && hop.token?.issuer === "api" && hop.token?.userId === "alice"
    ),
    "the upload's embeddings went through the gateway as the uploading tenant"
  );

  // The document is on disk now, so every later process reads it at start.
  const [retrieval, agent, monolith] = await Promise.all([
    spawnTier({
      args: RETRIEVAL_HARNESS,
      environment: splitEnvironment({ collector, MODEL_GATEWAY_URL: taps.modelGateway.url, role: "retrieval" }),
      name: "retrieval",
    }),
    spawnTier({
      args: SERVER_ENTRY,
      environment: splitEnvironment({
        collector,
        MODEL_GATEWAY_URL: taps.modelGateway.url,
        PORT: "0",
        RETRIEVAL_SERVICE_URL: taps.retrieval.url,
        role: "agent",
      }),
      name: "agent",
    }),
    spawnTier({
      args: MONOLITH_HARNESS,
      environment: {
        ...commonEnvironment(),
        OPENAI_API_KEY: "e2e-monolith-key",
        OPENAI_BASE_URL: `${model.url}/v1`,
      },
      name: "monolith",
    }),
  ]);

  taps.retrieval.setTarget(retrieval.port);
  taps.agent.setTarget(agent.port);

  const chatBody = { docIds: [docId], question: QUESTION };

  // What one process answers.
  const expected = await request(monolith.url, "/chat", { body: chatBody, method: "POST", token: TOKENS.alice });
  const expectedStream = await readStream(monolith.url, chatBody, TOKENS.alice);
  const expectedForeign = await request(monolith.url, "/chat", { body: chatBody, method: "POST", token: TOKENS.bob });

  assert.equal(expected.status, 200, expected.text);
  assert.match(expected.json.agentAnswer, /twelve paid annual leave days/u);

  // The same question through the split deployment.
  const modelCallsBefore = model.calls.length;

  clearHops();

  const actual = await request(api.url, "/chat", { body: chatBody, method: "POST", token: TOKENS.alice });

  assert.equal(actual.status, 200, actual.text);
  assert.equal(actual.json.agentAnswer, expected.json.agentAnswer);
  assert.equal(actual.json.agentMode, expected.json.agentMode);
  assert.equal(actual.json.ragAnswer, expected.json.ragAnswer);
  assert.equal(actual.json.ragAbstained, expected.json.ragAbstained);
  assert.deepEqual(actual.json.ragSources, expected.json.ragSources);

  // Every hop was taken, by the tier that should take it, for alice.
  const hops = tapped();
  const hopSignature = (hop) => `${hop.token?.issuer}->${hop.tier}`;

  for (const signature of ["api->agent", "agent->retrieval", "retrieval->model-gateway", "agent->model-gateway"]) {
    assert.ok(hops.some((hop) => hopSignature(hop) === signature), `hop ${signature}: ${hops.map(hopSignature)}`);
  }

  assert.ok(hops.every((hop) => hop.token?.audience === hop.tier && hop.token.userId === "alice"));
  assert.ok(hops.every((hop) => hop.requestId), "every hop carries a service request id");

  // One trace: the trace context arrives at each hop with the edge's trace id.
  const traceIds = new Set(hops.map((hop) => traceIdOf(hop.traceparent)));

  assert.equal(traceIds.size, 1, [...traceIds].join(", "));
  const [traceId] = traceIds;

  assert.ok(traceId, "a traceparent at every hop");

  // Only the gateway talks to the model.
  assert.ok(model.calls.length > modelCallsBefore);
  assert.ok(
    model.calls.slice(modelCallsBefore).every((call) => call.authorization === "Bearer e2e-gateway-key"),
    "no tier but the gateway called the model"
  );

  // /chat/stream: the same events' answer drafts and the same result.
  const actualStream = await readStream(api.url, chatBody, TOKENS.alice);

  assert.equal(actualStream.status, 200);
  assert.equal(actualStream.events.at(-1)?.event, "done");
  assert.equal(resultOf(actualStream.events)?.status, 200);
  assert.equal(resultOf(actualStream.events).body.agentAnswer, expected.json.agentAnswer);
  assert.equal(resultOf(expectedStream.events).body.agentAnswer, expected.json.agentAnswer);
  assert.ok(drafts(expectedStream.events).length > 0, "the monolith streamed answer drafts");
  assert.deepEqual(drafts(actualStream.events), drafts(expectedStream.events));

  // Tenant isolation holds across the hops: bob cannot ask about alice's
  // document, and is told exactly what the monolith tells him.
  const foreign = await request(api.url, "/chat", { body: chatBody, method: "POST", token: TOKENS.bob });

  assert.notEqual(expectedForeign.status, 200);
  assert.equal(foreign.status, expectedForeign.status);
  assert.deepEqual(foreign.json, expectedForeign.json);

  // Each tier exported its spans under the edge's trace id (the batch span
  // processor exports every 5 s, so this waits for the next export).
  const services = ["archive-rag-api", "archive-rag-agent", "archive-rag-retrieval", "archive-rag-model-gateway"];
  const tracedServices = () =>
    new Set(collector.spans.filter((span) => span.traceId === traceId).map((span) => span.service));

  await collector.waitFor(() => services.every((service) => tracedServices().has(service)), 30_000);
  assert.deepEqual(
    services.filter((service) => !tracedServices().has(service)),
    [],
    "every tier exported spans under the one trace id"
  );

  // Stop the model gateway. The agent treats a document RAG step that failed
  // on a dependency the way the monolith treats one whose model or database
  // is down: the step fails with a stable, secret-free error, the run fails
  // retryable, and /chat answers 503 with a stable code and Retry-After --
  // never a clarification offering a Web search instead. The edge keeps
  // serving documents.
  const failedDocumentRag = (body) =>
    body?.steps?.find((step) => step.type === "document_rag" && step.status === "failed")?.error ?? null;
  const readRun = async (runId) => {
    const run = await request(api.url, `/agent-runs/${runId}`, { token: TOKENS.alice });

    assert.equal(run.status, 200, run.text);
    return run.json;
  };
  const assertOutage = async (answer, { causeCode, dependency, stepError }) => {
    assert.equal(answer.status, 503, answer.text);
    assert.equal(answer.retryAfter, "5");
    assert.equal(answer.json.code, "AGENT_DEPENDENCY_UNAVAILABLE");
    assert.equal(answer.json.causeCode, causeCode);
    assert.equal(answer.json.dependency, dependency);
    assert.equal(answer.json.retryable, true);
    assert.equal(answer.json.clarification, undefined);

    const run = await readRun(answer.json.agentRunId);

    assert.equal(run.status, "failed");
    assert.equal(run.error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
    assert.equal(run.error.reason, "dependency_unavailable");
    assert.equal(run.error.retryable, true);
    assert.deepEqual(failedDocumentRag(run), stepError);
  };
  const assertNothingInternal = (answer) => {
    for (const secret of ["127.0.0.1", SECRET, "e2e-gateway-key", TOKENS.alice]) {
      assert.ok(!answer.text.includes(secret), answer.text);
    }
  };
  const assertDocumentsStillServed = async () => {
    const documents = await request(api.url, "/documents", { token: TOKENS.alice });

    assert.equal(documents.status, 200);
    assert.ok(documents.text.includes(docId));
  };

  // SIGTERM while a model answer is in flight: the gateway stops taking
  // connections but finishes that answer before it exits, with tracing on.
  const held = model.holdNextChat();
  const answeredDuringDrain = request(api.url, "/chat", { body: chatBody, method: "POST", token: TOKENS.alice });

  await held.arrived;
  gateway.child.kill("SIGTERM");
  await gateway.output(/model-gateway: SIGTERM; no new connections/u);
  held.release();

  const drained = await answeredDuringDrain;

  assert.equal(drained.status, 200, drained.text);
  assert.equal(drained.json.agentAnswer, expected.json.agentAnswer, gateway.logs());
  assert.equal((await gateway.exited).code, 0, gateway.logs());
  children.delete(gateway.child);
  await taps.modelGateway.stop();

  const withoutGateway = await request(api.url, "/chat", { body: chatBody, method: "POST", token: TOKENS.alice });

  await assertOutage(withoutGateway, {
    causeCode: "MODEL_GATEWAY_UNAVAILABLE",
    dependency: "model",
    stepError: {
      message: "Model gateway: the gateway is unavailable.",
      name: "ModelGatewayError",
    },
  });
  assertNothingInternal(withoutGateway);
  await assertDocumentsStillServed();

  // Stop the retrieval tier as well: the agent cannot reach it.
  assert.equal((await retrieval.stop()).code, 0, retrieval.logs());
  await taps.retrieval.stop();

  const withoutRetrieval = await request(api.url, "/chat", { body: chatBody, method: "POST", token: TOKENS.alice });

  await assertOutage(withoutRetrieval, {
    causeCode: "SERVICE_UNREACHABLE",
    dependency: "retrieval",
    stepError: {
      message: "The retrieval service is unreachable.",
      name: "ServiceUnavailableError",
    },
  });
  assertNothingInternal(withoutRetrieval);
  await assertDocumentsStillServed();

  // Stop the agent tier: the edge itself answers a clean 503, for /chat and
  // /chat/stream alike, and still serves documents.
  assert.equal((await agent.stop()).code, 0, agent.logs());
  await taps.agent.stop();

  const withoutAgent = await request(api.url, "/chat", { body: chatBody, method: "POST", token: TOKENS.alice });
  const withoutAgentStream = await fetch(`${api.url}/chat/stream`, {
    body: JSON.stringify(chatBody),
    headers: { "content-type": "application/json", "x-api-key": TOKENS.alice },
    method: "POST",
  });
  const unreachable = { code: "SERVICE_UNREACHABLE", error: "The agent service is unreachable.", service: "agent" };

  assert.equal(withoutAgent.status, 503);
  assert.deepEqual(withoutAgent.json, unreachable);
  assert.equal(withoutAgentStream.status, 503);
  assert.deepEqual(await withoutAgentStream.json(), unreachable);
  await assertDocumentsStillServed();

  // The remaining tiers stop cleanly on SIGTERM.
  for (const tier of [api, monolith]) {
    assert.equal((await tier.stop()).code, 0, `${tier.name}:\n${tier.logs()}`);
  }
});
