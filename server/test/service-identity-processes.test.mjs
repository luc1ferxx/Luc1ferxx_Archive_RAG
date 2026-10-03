import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateServiceKeyPair } from "../rag/service-identity-keys.js";

// INTERNAL_SERVICE_AUTH=ed25519 across a process boundary: the model gateway
// runs in its own process holding public keys only, and this process calls it
// as the agent tier with the agent's private key, through the real model
// client (openai.js -> model-gateway/client.js -> service-client.js). No model,
// database or network beyond 127.0.0.1.

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverUrl = pathToFileURL(`${serverDirectory}/`).href;
const AGENT = generateServiceKeyPair({ issuer: "agent" });
const API = generateServiceKeyPair({ issuer: "api" });
const TRUSTED = [AGENT, API].map((pair) => pair.trustedEntry).join(",");
const MODELS = { OPENAI_CHAT_MODEL: "proc-chat", OPENAI_EMBEDDING_MODEL: "proc-embed" };
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
          server.close(resolve);
        })
    )
  );
});

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// An OpenAI-compatible fake, the gateway's only upstream.
const startUpstream = async () => {
  const server = http.createServer((req, res) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};

      if (req.url.endsWith("/chat/completions")) {
        sendJson(res, 200, {
          choices: [{ finish_reason: "stop", index: 0, message: { content: "pong", role: "assistant" } }],
          usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
        });
      } else if (req.url.endsWith("/embeddings")) {
        const input = Array.isArray(body.input) ? body.input : [body.input];

        sendJson(res, 200, {
          data: input.map((text, index) => ({ embedding: [String(text).length, index, 1], index })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      } else {
        sendJson(res, 404, { error: { message: "no such route" } });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.add(server);

  return `http://127.0.0.1:${server.address().port}/v1`;
};

// The gateway in a child process, from its app factory (no server/.env).
const startGatewayProcess = async (environment) => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { createModelGatewayApp } = await import(new URL("rag/model-gateway/app.js", ${JSON.stringify(serverUrl)}));
const app = createModelGatewayApp({});
const server = app.listen(0, "127.0.0.1", () => console.log("GATEWAY_LISTENING " + server.address().port));`,
    ],
    { cwd: serverDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";

  children.add(child);

  const port = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;

      const match = output.match(/GATEWAY_LISTENING (\d+)/);

      if (match) {
        resolve(Number(match[1]));
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("exit", (code) => reject(new Error(`The gateway process exited (${code}): ${output.slice(-2000)}`)));
  });

  return `http://127.0.0.1:${port}`;
};

const post = (url, { body, token }) =>
  fetch(url, {
    body,
    headers: { "content-type": "application/json", "x-archive-service-token": token },
    method: "POST",
  }).then(async (response) => ({ json: await response.json(), status: response.status }));

test("a verify-only gateway process accepts the agent's own key and nothing forged", async () => {
  const upstream = await startUpstream();
  const gatewayEnvironment = {
    ...MODELS,
    ARCHIVE_RAG_ROLE: "model-gateway",
    HOME: process.env.HOME ?? "",
    INTERNAL_SERVICE_AUTH: "ed25519",
    INTERNAL_SERVICE_TRUSTED_KEYS: TRUSTED,
    OPENAI_API_KEY: "upstream-test-key",
    OPENAI_BASE_URL: upstream,
    PATH: process.env.PATH ?? "",
    RAG_LLM_REQUEST_TIMEOUT_MS: "5000",
    RAG_OBSERVABILITY_ENABLED: "false",
    RAG_SHARED_STATE: "memory",
    TMPDIR: process.env.TMPDIR ?? "",
  };

  assert.ok(!Object.keys(gatewayEnvironment).some((key) => key.startsWith("INTERNAL_SERVICE_SIGNING")));
  assert.ok(!Object.values(gatewayEnvironment).includes(AGENT.privateKeyBase64));

  const gateway = await startGatewayProcess(gatewayEnvironment);

  // This process is the agent tier: its own private key, the gateway's URL.
  Object.assign(process.env, {
    ...MODELS,
    ARCHIVE_RAG_ROLE: "agent",
    INTERNAL_SERVICE_AUTH: "ed25519",
    INTERNAL_SERVICE_SIGNING_KEY: AGENT.privateKeyBase64,
    INTERNAL_SERVICE_TRUSTED_KEYS: TRUSTED,
    MODEL_GATEWAY_URL: gateway,
    OPENAI_API_KEY: "",
    RAG_OBSERVABILITY_ENABLED: "false",
  });
  delete process.env.INTERNAL_SERVICE_KEYS;
  delete process.env.OPENAI_BASE_URL;

  const { completeTextWithMetadata, embedTexts } = await import("../rag/openai.js");
  const { signServiceToken } = await import("../rag/service-identity.js");

  // Through the real client: bound, freshly signed tokens.
  assert.equal((await completeTextWithMetadata("ping")).text, "pong");
  assert.equal((await completeTextWithMetadata("ping again")).text, "pong");
  assert.deepEqual((await embedTexts(["abc"]))[0], [3, 0, 1]);

  const body = JSON.stringify({ input: ["abc"], model: "proc-embed" });
  const bound = (options = {}) =>
    signServiceToken({
      audience: "model-gateway",
      issuer: "agent",
      request: { body, method: "POST", target: "/v1/embeddings" },
      system: true,
      ...options,
    });
  const embeddings = `${gateway}/v1/embeddings`;

  // A bound token works once; the same token again is a replay.
  const token = bound();

  assert.equal((await post(embeddings, { body, token })).status, 200);
  assert.deepEqual((await post(embeddings, { body, token })).json, {
    code: "SERVICE_TOKEN_REPLAYED",
    error: "Unauthorized.",
  });

  // The agent's key cannot speak for the edge.
  const forged = await post(embeddings, { body, token: bound({ issuer: "api" }) });

  assert.equal(forged.status, 401);
  assert.equal(forged.json.code, "SERVICE_TOKEN_KEY_ISSUER");

  // A token for another route, and an HS256 token, are refused.
  const misrouted = await post(`${gateway}/v1/chat/completions`, { body, token: bound() });

  assert.equal(misrouted.json.code, "SERVICE_TOKEN_REQUEST_MISMATCH");

  const hmac = signServiceToken({
    audience: "model-gateway",
    env: { INTERNAL_SERVICE_KEYS: `h1:${"h".repeat(40)}` },
    issuer: "agent",
    request: { body, method: "POST", target: "/v1/embeddings" },
    system: true,
  });

  assert.equal((await post(embeddings, { body, token: hmac })).json.code, "SERVICE_TOKEN_ALGORITHM");
});
