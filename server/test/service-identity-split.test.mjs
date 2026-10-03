import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";
import { generateServiceKeyPair } from "../rag/service-identity-keys.js";
import { signServiceToken } from "../rag/service-identity.js";

// INTERNAL_SERVICE_AUTH=ed25519 through the whole split deployment, every
// tier in its own process with only its own private key:
//
//   client -> api -> agent -> retrieval -> model-gateway -> fake model
//                        \______________________/^
//
// api, agent and model-gateway start through `node server.js` with their
// role, the retrieval tier from its app factory (its entry points refuse the
// local vector store this test uses to need no database). The gateway holds
// no private key at all. Request binding and the replay cache run at their
// ed25519 defaults (required, on). Taps in this process forward each internal
// hop and keep the token that crossed it, so the test can check who signed
// what and replay a captured token against the tier it was meant for.
//
// No model, database or network beyond 127.0.0.1.

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverUrl = pathToFileURL(`${serverDirectory}/`).href;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "service-identity-split-"));
const EMBEDDING_DIMENSIONS = 64;
const TOKEN = `alice-${randomBytes(8).toString("hex")}`;
const QUESTION = "How many paid annual leave days do employees receive?";
const KEYS = {
  agent: generateServiceKeyPair({ issuer: "agent" }),
  api: generateServiceKeyPair({ issuer: "api" }),
  retrieval: generateServiceKeyPair({ issuer: "retrieval" }),
};
const TRUSTED = Object.values(KEYS)
  .map((pair) => pair.trustedEntry)
  .join(",");

const children = new Set();
const servers = new Set();

after(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }

  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  rmSync(tempRoot, { force: true, recursive: true });
});

const startHttpServer = async (handler) => {
  const server = http.createServer(handler);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.add(server);

  return { url: `http://127.0.0.1:${server.address().port}` };
};

const readBody = async (req) => {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

// OpenAI-compatible chat (JSON or SSE) and embeddings, as the load bench answers.
const startFakeModel = () =>
  startHttpServer(async (req, res) => {
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

    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }], model: payload.model })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], model: payload.model, usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });

const decodeSegment = (segment) => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

// A transparent forwarder in front of one tier that keeps every token and body
// it forwards. It answers 503 until the tier is up (the edge's startup probe).
const startTap = async () => {
  const hops = [];
  let targetPort = null;
  const tap = await startHttpServer(async (req, res) => {
    const body = await readBody(req);
    const token = req.headers["x-archive-service-token"] ?? null;
    const [header, payload] = String(token ?? "").split(".");

    hops.push({ body, header: decodeSegment(header), method: req.method, payload: decodeSegment(payload), target: req.url, token });

    if (targetPort === null) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not started." }));
      return;
    }

    const upstream = http.request({ headers: req.headers, host: "127.0.0.1", method: req.method, path: req.url, port: targetPort }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });

    upstream.on("error", () => res.destroy());
    upstream.end(body);
  });

  return {
    ...tap,
    hops,
    setTarget: (port) => {
      targetPort = port;
    },
  };
};

const spawnTier = async ({ args, environment, name }) => {
  const child = spawn(process.execPath, args, { cwd: tempRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";

  children.add(child);
  child.stderr.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-6000);
  });

  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-6000);

      const match = /(?:is running on port|SPLIT_LISTENING) (\d+)/u.exec(output);

      if (match) {
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code, signal) => reject(new Error(`${name} exited (${code ?? signal}) before listening:\n${output}`)));
  });

  return { port, url: `http://127.0.0.1:${port}` };
};

// Nothing from the developer's shell or server/.env reaches a tier.
const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

writeFileSync(emptyEnvironmentFile, "", "utf8");

const tierEnvironment = ({ role, signingKey, ...rest }) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
  AGENT_EXECUTION_PLANNER: "deterministic",
  AGENT_INTENT_PLANNER: "deterministic",
  AGENT_PLANNER_ROLLOUT: "deterministic",
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify({ [TOKEN]: { userId: "alice", workspaceId: "ws-a" } }),
  ARCHIVE_RAG_ROLE: role,
  DOCCOMPARE_STANDALONE: "1",
  DOTENV_CONFIG_PATH: emptyEnvironmentFile,
  DOTENV_CONFIG_QUIET: "true",
  INTERNAL_SERVICE_AUTH: "ed25519",
  ...(signingKey ? { INTERNAL_SERVICE_SIGNING_KEY: signingKey.privateKeyBase64 } : {}),
  INTERNAL_SERVICE_TRUSTED_KEYS: TRUSTED,
  OPENAI_CHAT_MODEL: "split-chat",
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
  ...rest,
});

const RETRIEVAL_HARNESS = [
  "--input-type=module",
  "-e",
  `const root = ${JSON.stringify(serverUrl)};
const { applyStandaloneProfile } = await import(new URL("standalone-profile.js", root));
applyStandaloneProfile();
const { createRetrievalApp } = await import(new URL("rag/retrieval-service/app.js", root));
const app = createRetrievalApp({});
const server = app.listen(0, "127.0.0.1", () => console.log("SPLIT_LISTENING " + server.address().port));`,
];
const SERVER_ENTRY = [path.join(serverDirectory, "server.js")];

const post = async (url, { body, headers = {} }) => {
  const response = await fetch(url, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
  const text = await response.text();
  const isJson = /^application\/json/u.test(response.headers.get("content-type") ?? "");

  return { json: isJson && text ? JSON.parse(text) : null, status: response.status, text };
};

test("ed25519 split: every hop is signed by its own tier, bound, and accepted once", async () => {
  const model = await startFakeModel();
  const taps = { agent: await startTap(), modelGateway: await startTap(), retrieval: await startTap() };

  const gateway = await spawnTier({
    args: SERVER_ENTRY,
    environment: tierEnvironment({
      MODEL_GATEWAY_CHAT_UPSTREAMS: `${model.url}/v1`,
      MODEL_GATEWAY_EMBEDDING_UPSTREAMS: `${model.url}/v1`,
      MODEL_GATEWAY_PORT: "0",
      OPENAI_API_KEY: "split-gateway-key",
      role: "model-gateway",
    }),
    name: "model-gateway",
  });

  taps.modelGateway.setTarget(gateway.port);

  const api = await spawnTier({
    args: SERVER_ENTRY,
    environment: tierEnvironment({
      AGENT_SERVICE_URL: taps.agent.url,
      MODEL_GATEWAY_URL: taps.modelGateway.url,
      PORT: "0",
      role: "api",
      signingKey: KEYS.api,
    }),
    name: "api",
  });

  // The upload stays at the edge; its chunks are embedded through the gateway
  // under the edge's own key.
  const form = new FormData();

  form.append(
    "file",
    new Blob(
      [
        buildTextPdf({
          pages: [["Program Aster employee handbook.", "Employees receive twelve paid annual leave days each year."]],
          title: "Aster handbook",
        }),
      ],
      { type: "application/pdf" }
    ),
    "aster-handbook.pdf"
  );

  const upload = await fetch(`${api.url}/upload`, { body: form, headers: { "x-api-key": TOKEN }, method: "POST" });

  assert.equal(upload.status, 201, await upload.clone().text());

  const docId = (await upload.json()).docId ?? (await (await fetch(`${api.url}/documents`, { headers: { "x-api-key": TOKEN } })).json())[0]?.docId;

  assert.ok(docId);

  const [retrieval, agent] = await Promise.all([
    spawnTier({
      args: RETRIEVAL_HARNESS,
      environment: tierEnvironment({ MODEL_GATEWAY_URL: taps.modelGateway.url, role: "retrieval", signingKey: KEYS.retrieval }),
      name: "retrieval",
    }),
    spawnTier({
      args: SERVER_ENTRY,
      environment: tierEnvironment({
        MODEL_GATEWAY_URL: taps.modelGateway.url,
        PORT: "0",
        RETRIEVAL_SERVICE_URL: taps.retrieval.url,
        role: "agent",
        signingKey: KEYS.agent,
      }),
      name: "agent",
    }),
  ]);

  taps.retrieval.setTarget(retrieval.port);
  taps.agent.setTarget(agent.port);

  const chatBody = { docIds: [docId], question: QUESTION };
  const answer = await post(`${api.url}/chat`, { body: chatBody, headers: { "x-api-key": TOKEN } });

  assert.equal(answer.status, 200, answer.text);
  assert.match(answer.json.agentAnswer, /twelve paid annual leave days/u);

  const stream = await post(`${api.url}/chat/stream`, { body: chatBody, headers: { "x-api-key": TOKEN } });

  assert.equal(stream.status, 200);
  assert.match(stream.text, /event: result/u);
  assert.match(stream.text, /twelve paid annual leave days/u);

  // Every hop that carried a token: EdDSA, the hop's own issuer and key, and
  // bound to the request it travelled with. Each tier signed with its own key.
  const expectedIssuers = { agent: ["api"], modelGateway: ["agent", "api", "retrieval"], retrieval: ["agent"] };

  for (const [tier, tap] of Object.entries(taps)) {
    const signed = tap.hops.filter((hop) => hop.token);
    const issuers = new Set();

    assert.ok(signed.length > 0, `${tier} saw signed calls`);

    for (const hop of signed) {
      assert.equal(hop.header.alg, "EdDSA", tier);
      assert.equal(hop.header.kid, KEYS[hop.payload.iss].keyId, `${tier}: ${hop.payload.iss} signs with its own key`);
      assert.equal(hop.payload.htm, hop.method, tier);
      assert.equal(typeof hop.payload.htu, "string", tier);
      assert.equal(Boolean(hop.payload.bdh), hop.body.length > 0, tier);
      issuers.add(hop.payload.iss);
    }

    assert.deepEqual([...issuers].sort(), expectedIssuers[tier], tier);
  }

  // A token that already crossed a hop is refused when replayed straight to
  // its tier, with its own request and body.
  const forwardedChat = taps.agent.hops.find((hop) => hop.method === "POST" && hop.target === "/chat" && hop.token);
  const replayed = await post(`${agent.url}/chat`, {
    body: forwardedChat.body,
    headers: { "x-archive-service-token": forwardedChat.token },
  });

  assert.equal(replayed.status, 401);
  assert.equal(replayed.json.code, "SERVICE_TOKEN_REPLAYED");

  const embedding = taps.modelGateway.hops.find((hop) => hop.payload?.iss === "retrieval" && hop.body);
  const replayedEmbedding = await post(`${gateway.url}${embedding.target}`, {
    body: embedding.body,
    headers: { "x-archive-service-token": embedding.token },
  });

  assert.equal(replayedEmbedding.status, 401);
  assert.equal(replayedEmbedding.json.code, "SERVICE_TOKEN_REPLAYED");

  // The retrieval tier's key cannot speak for the edge, and the agent's key
  // reaches the agent tier under no issuer: the policy has no agent -> agent.
  const body = JSON.stringify(chatBody);
  const signAs = (keys, issuer) =>
    signServiceToken({
      accessScope: { authenticated: true, userId: "alice", workspaceId: "ws-a" },
      audience: "agent",
      env: { INTERNAL_SERVICE_AUTH: "ed25519", INTERNAL_SERVICE_SIGNING_KEY: keys.privateKeyBase64 },
      issuer,
      request: { body, method: "POST", target: "/chat" },
    });
  const forged = await post(`${agent.url}/chat`, { body, headers: { "x-archive-service-token": signAs(KEYS.retrieval, "api") } });
  const sideways = await post(`${agent.url}/chat`, { body, headers: { "x-archive-service-token": signAs(KEYS.agent, "agent") } });

  assert.equal(forged.status, 401);
  assert.equal(forged.json.code, "SERVICE_TOKEN_KEY_ISSUER");
  assert.equal(sideways.status, 403);
  assert.equal(sideways.json.code, "SERVICE_TOKEN_ISSUER");
});
