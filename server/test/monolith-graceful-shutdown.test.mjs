import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";

// Graceful shutdown of the monolith (`node server.js`, ARCHIVE_RAG_ROLE
// unset). It reuses the split roles' drain (createGracefulShutdown in
// rag/agent-service/role-server.js): on SIGTERM the listener closes, an
// in-flight /chat finishes within SERVICE_SHUTDOWN_GRACE_MS and its agent run
// is completed in the run store, and the process exits 0. A request still
// running when the window closes has its connection closed; a second signal
// exits at once with status 1.
//
// Each test starts its own child process on port 0 under the standalone
// profile (filesystem registry, local vector store, in-memory run store; no
// database), against a fake OpenAI-compatible model on 127.0.0.1 that holds
// the chat answer until the test releases it, so "in flight" is a barrier,
// not a timing guess.

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "monolith-graceful-shutdown-"));
const API_TOKEN = `alice-${randomBytes(8).toString("hex")}`;
const QUESTION = "How many paid annual leave days do employees receive?";
const DOCUMENT_LINES = [
  "Program Aster employee handbook.",
  "Employees receive twelve paid annual leave days each year.",
  "Unused leave days carry over until the end of March.",
];
const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
const DRAIN_LOG = /\[service\] all: SIGTERM; no new connections, draining in-flight requests\./u;

const servers = new Set();
const children = new Set();
const releases = new Set();

after(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }

  for (const release of releases) {
    release();
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

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const readBody = async (req) => {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

// Embeddings answer at once (hashed term vectors); chat completions answer the
// load bench's evidence sentence, but once holdChat() is called they wait for
// its release().
const startFakeModel = async () => {
  let hold = null;
  let embeddingHold = null;

  const server = http.createServer(async (req, res) => {
    const payload = JSON.parse((await readBody(req)) || "{}");

    if (req.url.endsWith("/embeddings")) {
      if (embeddingHold) {
        embeddingHold.arrived.resolve();
        await embeddingHold.released.promise;
      }

      if (res.destroyed) {
        return;
      }

      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

      res.writeHead(200, { "content-type": "application/json" });
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

    if (hold) {
      hold.arrived.resolve();
      await hold.released.promise;
    }

    if (res.destroyed) {
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
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

  return {
    // Holds every embedding request (an async ingest job's embed stage) until
    // release().
    holdEmbeddings: () => {
      embeddingHold = { arrived: createDeferred(), released: createDeferred() };
      releases.add(embeddingHold.released.resolve);

      return { arrived: embeddingHold.arrived.promise, release: embeddingHold.released.resolve };
    },
    holdChat: () => {
      hold = { arrived: createDeferred(), released: createDeferred() };
      releases.add(hold.released.resolve);

      return { arrived: hold.arrived.promise, release: hold.released.resolve };
    },
    url: `http://127.0.0.1:${server.address().port}`,
  };
};

const startMonolith = async (modelUrl, { environment = {}, graceMs }) => {
  const directory = mkdtempSync(path.join(tempRoot, "monolith-"));
  const emptyEnvironmentFile = path.join(directory, "empty.env");

  writeFileSync(emptyEnvironmentFile, "", "utf8");

  const child = spawn(process.execPath, [path.join(serverDirectory, "server.js")], {
    cwd: directory,
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
      OPENAI_API_KEY: "graceful-shutdown-key",
      OPENAI_BASE_URL: `${modelUrl}/v1`,
      OPENAI_CHAT_MODEL: "e2e-chat",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      PDF_PARSER: "pdfjs",
      PORT: "0",
      RAG_CLAIM_JUDGE: "off",
      RAG_DATA_DIRECTORY: path.join(directory, "rag-data"),
      RAG_INGEST_MODE: "sync",
      RAG_OBSERVABILITY_ENABLED: "false",
      RAG_RERANK_ENABLED: "false",
      RAG_SEMANTIC_CACHE: "off",
      RAG_SHARED_STATE: "memory",
      RATE_LIMIT_ENABLED: "false",
      SERVICE_SHUTDOWN_GRACE_MS: String(graceMs),
      STARTUP_HEALTH_STRICT: "false",
      UPLOADS_DIRECTORY: path.join(directory, "uploads"),
      VECTOR_STORE_PROVIDER: "local",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const watchers = new Set();
  const onOutput = (chunk) => {
    output += chunk;

    for (const watcher of watchers) {
      watcher();
    }
  };

  children.add(child);
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolve({ at: Date.now(), code, signal });
    });
  });

  const waitForOutput = (pattern) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const match = pattern.exec(output);

        if (match) {
          watchers.delete(check);
          resolve(match);
        }
      };

      watchers.add(check);
      check();
      exited.then(({ code, signal }) => {
        if (watchers.delete(check)) {
          reject(new Error(`server.js exited (${code ?? signal}) before printing ${pattern}:\n${output}`));
        }
      });
    });

  const port = Number((await waitForOutput(/server is running on port (\d+)/u))[1]);

  return { appUrl: `http://127.0.0.1:${port}`, child, exited, output: () => output, port, waitForOutput };
};

const uploadHandbook = (monolith) => {
  const form = new FormData();

  form.append(
    "file",
    new Blob([buildTextPdf({ pages: [DOCUMENT_LINES], title: "Aster handbook" })], { type: "application/pdf" }),
    "aster-handbook.pdf"
  );

  return fetch(`${monolith.appUrl}/upload`, {
    body: form,
    headers: { "x-api-key": API_TOKEN },
    method: "POST",
  });
};

// Uploads the handbook, then starts a /chat and resolves once its answer is
// being generated (the fake model holds it).
const startChatInFlight = async (monolith, model) => {
  const upload = await uploadHandbook(monolith);

  assert.equal(upload.status, 201, await upload.clone().text());

  const { docId } = (await (await fetch(`${monolith.appUrl}/documents`, { headers: { "x-api-key": API_TOKEN } })).json())[0];
  const hold = model.holdChat();
  const chat = fetch(`${monolith.appUrl}/chat`, {
    body: JSON.stringify({ docIds: [docId], question: QUESTION }),
    headers: { "content-type": "application/json", "x-api-key": API_TOKEN },
    method: "POST",
  }).then(async (response) => ({ body: await response.json(), status: response.status }));

  // Observed either way, so a failure before the hold does not go unhandled.
  chat.catch(() => {});
  await Promise.race([hold.arrived, chat.then((result) => assert.fail(`/chat answered before the model: ${JSON.stringify(result)}`))]);

  return { chat, release: hold.release };
};

const connectionRefused = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });

    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
  });

// The drain log is written as the listener starts closing; the socket itself
// closes on a later turn of the event loop, and on Linux a connection that
// was already in the accept backlog can still connect. So poll: within the
// drain, new connections must start being refused while the held request is
// still running.
const becomesConnectionRefused = async (port, { timeoutMs = 3000, intervalMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await connectionRefused(port)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
};

test("SIGTERM drains an in-flight /chat: it answers 200, its run completes, new connections are refused, exit 0", async () => {
  const graceMs = 20_000;
  const model = await startFakeModel();
  const monolith = await startMonolith(model.url, { graceMs });
  const { chat, release } = await startChatInFlight(monolith, model);
  const signalledAt = Date.now();

  monolith.child.kill("SIGTERM");
  await monolith.waitForOutput(DRAIN_LOG);

  // The listener is closed while the request is still running.
  assert.equal(await becomesConnectionRefused(monolith.port), true, "a new connection is refused during the drain");

  release();

  const { body, status } = await chat;

  assert.equal(status, 200, JSON.stringify(body));
  assert.match(body.agentAnswer, /twelve paid annual leave days/u);
  // The run snapshot the run store returned when it committed the completion:
  // not left running for startup recovery or an operator.
  assert.ok(body.agentRunId, "the answer names its agent run");
  assert.equal(body.agentRunStatus, "completed");
  assert.ok(Array.isArray(body.agentRunSteps) && body.agentRunSteps.length > 0);
  assert.deepEqual(
    body.agentRunSteps.filter((step) => step.status === "running" || step.status === "manual_recovery_required"),
    []
  );

  const exit = await monolith.exited;

  assert.equal(exit.code, 0, monolith.output());
  assert.ok(exit.at - signalledAt < graceMs, `exited ${exit.at - signalledAt} ms after SIGTERM, within the drain window`);
  assert.doesNotMatch(monolith.output(), /requests still running after/u);
  assert.match(monolith.output(), /\[service\] all: stopped\./u);
});

test("a /chat still running when the drain window closes loses its connection, and the process exits 0", async () => {
  const graceMs = 400;
  const model = await startFakeModel();
  const monolith = await startMonolith(model.url, { graceMs });
  const { chat } = await startChatInFlight(monolith, model);
  const signalledAt = Date.now();

  monolith.child.kill("SIGTERM");

  const exit = await monolith.exited;

  assert.equal(exit.code, 0, monolith.output());
  // The window, then the finalizers; well inside the 3 s finalizer margin.
  assert.ok(exit.at - signalledAt < graceMs + 3_000, `exited ${exit.at - signalledAt} ms after SIGTERM`);
  assert.match(monolith.output(), new RegExp(`requests still running after ${graceMs} ms; closing their connections`, "u"));
  await assert.rejects(chat, "the held request's connection was closed");
});

test("a second SIGTERM during the drain exits at once with status 1", async () => {
  const graceMs = 20_000;
  const model = await startFakeModel();
  const monolith = await startMonolith(model.url, { graceMs });
  const { chat } = await startChatInFlight(monolith, model);

  monolith.child.kill("SIGTERM");
  await monolith.waitForOutput(DRAIN_LOG);

  const secondAt = Date.now();

  monolith.child.kill("SIGTERM");

  const exit = await monolith.exited;

  assert.equal(exit.code, 1, monolith.output());
  assert.ok(exit.at - secondAt < 5_000, `exited ${exit.at - secondAt} ms after the second SIGTERM`);
  assert.match(monolith.output(), /\[service\] all: second SIGTERM during shutdown; exiting now\./u);
  await assert.rejects(chat, "the held request's connection went with the process");
});

// RAG_INGEST_MODE=async: the in-process ingest worker stops alongside the
// drain; a job still running after the worker's own stop grace (5 s) goes back
// to the queue instead of waiting out its lease. The hard shutdown deadline
// must leave room for that hand-back even when SERVICE_SHUTDOWN_GRACE_MS is
// shorter than the worker's grace, or the process exits 1 with the job still
// claimed.
test("with a short drain window, an in-flight ingest job is handed back before the process exits 0", async () => {
  const graceMs = 500;
  const model = await startFakeModel();
  const monolith = await startMonolith(model.url, {
    environment: { RAG_INGEST_MODE: "async" },
    graceMs,
  });
  const hold = model.holdEmbeddings();
  const upload = await uploadHandbook(monolith);

  assert.equal(upload.status, 202, await upload.clone().text());
  // The worker claimed the job and is waiting in its embed stage.
  await hold.arrived;

  const signalledAt = Date.now();

  monolith.child.kill("SIGTERM");

  const exit = await monolith.exited;

  assert.equal(exit.code, 0, monolith.output());
  assert.doesNotMatch(monolith.output(), /shutdown did not finish within/u);
  assert.match(monolith.output(), /\[service\] all: stopped\./u);
  // The worker waited out its stop grace before handing the job back.
  assert.ok(exit.at - signalledAt >= 4_500, `exited ${exit.at - signalledAt} ms after SIGTERM`);
});
