import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";
import { checkHistogram, parseExposition, sampleValue } from "./metrics-exposition.mjs";

// One monolith (`node server.js`, ARCHIVE_RAG_ROLE unset) with
// METRICS_ENABLED=true, a fake OpenAI-compatible model on 127.0.0.1 and the
// standalone profile (filesystem registry, local vector store; no database).
// After an upload and one /chat, a scrape of the separate metrics listener
// shows the HTTP, agent, model and retrieval series moved, every histogram is
// consistent, and nothing that identifies the tenant, the document or the
// question appears in it. The app port does not serve /metrics, and the
// listener refuses a scrape without its token.

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "metrics-monolith-e2e-"));
const METRICS_TOKEN = randomBytes(16).toString("hex");
const API_TOKEN = `alice-${randomBytes(8).toString("hex")}`;
const QUESTION = "How many paid annual leave days do employees receive?";
const DOCUMENT_LINES = [
  "Program Aster employee handbook.",
  "Employees receive twelve paid annual leave days each year.",
  "Unused leave days carry over until the end of March.",
];
const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;

const servers = new Set();
const children = new Set();

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

const readBody = async (req) => {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

// OpenAI-compatible chat and embeddings: the load bench's deterministic
// answer (the best evidence sentence with its source label) and hashed term
// vectors.
const startFakeModel = async () => {
  const server = http.createServer(async (req, res) => {
    const payload = JSON.parse((await readBody(req)) || "{}");

    res.writeHead(200, { "content-type": "application/json" });

    if (req.url.endsWith("/embeddings")) {
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

      res.end(
        JSON.stringify({
          data: inputs.map((input, index) => ({ embedding: hashEmbedding(input, 64), index, object: "embedding" })),
          model: payload.model,
          object: "list",
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
      );
      return;
    }

    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: buildFakeChatAnswer(payload), role: "assistant" } }],
        model: payload.model,
        object: "chat.completion",
        usage: { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 },
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.add(server);

  return `http://127.0.0.1:${server.address().port}`;
};

const startMonolith = async (modelUrl) => {
  const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

  writeFileSync(emptyEnvironmentFile, "", "utf8");

  const child = spawn(process.execPath, [path.join(serverDirectory, "server.js")], {
    cwd: tempRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
      AGENT_EXECUTION_PLANNER: "deterministic",
      AGENT_INTENT_PLANNER: "deterministic",
      AGENT_PLANNER_ROLLOUT: "deterministic",
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKENS: JSON.stringify({ [API_TOKEN]: { userId: "alice", workspaceId: "ws-a" } }),
      DOCCOMPARE_STANDALONE: "1",
      DOTENV_CONFIG_PATH: emptyEnvironmentFile,
      DOTENV_CONFIG_QUIET: "true",
      METRICS_ENABLED: "true",
      METRICS_PORT: "0",
      METRICS_TOKEN,
      OPENAI_API_KEY: "metrics-e2e-key",
      OPENAI_BASE_URL: `${modelUrl}/v1`,
      OPENAI_CHAT_MODEL: "e2e-chat",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      PDF_PARSER: "pdfjs",
      PORT: "0",
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";

  children.add(child);
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;

      const appPort = /server is running on port (\d+)/u.exec(output)?.[1];
      const metricsPort = /\[metrics\] serving \/metrics on http:\/\/127\.0\.0\.1:(\d+) \(bearer token required\)/u.exec(output)?.[1];

      if (appPort && metricsPort) {
        resolve({ appUrl: `http://127.0.0.1:${appPort}`, child, metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`, output: () => output });
      }
    });
    child.once("exit", (code, signal) => reject(new Error(`server.js exited (${code ?? signal}):\n${output}`)));
  });
};

const scrape = async (metricsUrl) => {
  const response = await fetch(metricsUrl, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });

  assert.equal(response.status, 200);

  const text = await response.text();

  return { families: parseExposition(text), text };
};

test("a monolith's /metrics shows the HTTP, agent, model and retrieval series move after a /chat", async () => {
  const modelUrl = await startFakeModel();
  const monolith = await startMonolith(modelUrl);
  const form = new FormData();

  form.append(
    "file",
    new Blob([buildTextPdf({ pages: [DOCUMENT_LINES], title: "Aster handbook" })], { type: "application/pdf" }),
    "aster-handbook.pdf"
  );

  const upload = await fetch(`${monolith.appUrl}/upload`, {
    body: form,
    headers: { "x-api-key": API_TOKEN },
    method: "POST",
  });

  assert.equal(upload.status, 201, await upload.clone().text());

  const { docId } = (await (await fetch(`${monolith.appUrl}/documents`, { headers: { "x-api-key": API_TOKEN } })).json())[0];

  // Not on the app port, and not without the token.
  assert.equal((await fetch(`${monolith.appUrl}/metrics`, { headers: { "x-api-key": API_TOKEN } })).status, 404);
  assert.equal((await fetch(monolith.metricsUrl)).status, 401);

  const before = await scrape(monolith.metricsUrl);

  assert.ok(sampleValue(before.families, "archive_rag_http_requests_total", { method: "POST", route: "/upload", status_class: "2xx" }) >= 1);

  const chat = await fetch(`${monolith.appUrl}/chat`, {
    body: JSON.stringify({ docIds: [docId], question: QUESTION }),
    headers: { "content-type": "application/json", "x-api-key": API_TOKEN },
    method: "POST",
  });
  const answer = await chat.json();

  assert.equal(chat.status, 200, JSON.stringify(answer));
  assert.match(answer.agentAnswer, /twelve paid annual leave days/u);

  const afterChat = await scrape(monolith.metricsUrl);
  const delta = (name, labels = {}) =>
    sampleValue(afterChat.families, name, labels) - sampleValue(before.families, name, labels);

  // RED: the /chat route template, its status class and its duration.
  assert.equal(delta("archive_rag_http_requests_total", { method: "POST", route: "/chat", status_class: "2xx" }), 1);
  assert.equal(delta("archive_rag_http_request_duration_seconds_count", { method: "POST", route: "/chat" }), 1);
  assert.equal(sampleValue(afterChat.families, "archive_rag_http_requests_in_flight"), 0);

  // The agent run and its steps.
  assert.equal(delta("archive_rag_agent_runs_total", { outcome: "completed" }), 1);
  assert.equal(delta("archive_rag_agent_run_duration_seconds_count", { outcome: "completed" }), 1);
  assert.ok(delta("archive_rag_agent_steps_total") > 0);

  // Model calls made in this process (no gateway): the answer and the query
  // embedding, with the fake model's token counts.
  assert.ok(delta("archive_rag_model_calls_total", { metering: "direct", operation: "llm_completion", status: "ok" }) >= 1);
  assert.ok(delta("archive_rag_model_calls_total", { metering: "direct", operation: "embedding", status: "ok" }) >= 1);
  assert.ok(delta("archive_rag_model_tokens_total", { direction: "input", operation: "llm_completion" }) >= 400);
  assert.ok(delta("archive_rag_model_call_duration_seconds_count", { operation: "llm_completion" }) >= 1);

  // Retrieval routes.
  assert.ok(delta("archive_rag_retrieval_route_duration_seconds_count", { outcome: "ok", route: "dense" }) >= 1);
  assert.ok(delta("archive_rag_retrieval_route_candidates_count", { route: "dense" }) >= 1);

  // Process metrics, and every histogram is internally consistent.
  assert.ok(sampleValue(afterChat.families, "process_resident_memory_bytes") > 0);

  for (const family of afterChat.families.values()) {
    if (family.type === "histogram") {
      checkHistogram(family);
    }
  }

  // Nothing identifying the tenant, the document, the question or a secret.
  for (const leaked of [docId, "alice", "ws-a", API_TOKEN, METRICS_TOKEN, "annual leave", "Aster", "aster-handbook", modelUrl]) {
    assert.equal(afterChat.text.includes(leaked), false, `the exposition contains ${leaked}`);
  }
});
