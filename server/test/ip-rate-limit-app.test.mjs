// The per-IP rate limits (RATE_LIMIT_ENABLED) as createApp wires them: the
// global limit for every request, and on top of it one limiter per cost class
// (chat, ingest, destructive) chosen by classifyTenantLimitRequest
// (rag/tenant-limits.js), so every route of a class is covered, not only a
// few listed path prefixes. The limiters run before API auth, so these tests
// send no credential: a request under its limits is answered 401 by
// requireApiAuth (no handler runs), one over a limit 429 by the limiter.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../app.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";

const ENV_KEYS = [
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "RAG_SHARED_STATE",
  "RATE_LIMIT_CHAT_MAX",
  "RATE_LIMIT_DESTRUCTIVE_MAX",
  "RATE_LIMIT_ENABLED",
  "RATE_LIMIT_GLOBAL_MAX",
  "RATE_LIMIT_UPLOAD_MAX",
  "RBAC_MODE",
  "TENANT_MAX_CONCURRENT_RUNS",
  "TENANT_RATE_LIMIT_ENABLED",
  "TRUST_PROXY",
];

const withEnv = async (values, run) => {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of ENV_KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }

    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const limitEnv = (extra = {}) => ({
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify({ "acme-token": { userId: "alice", workspaceId: "acme" } }),
  RATE_LIMIT_ENABLED: "true",
  ...extra,
});

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const withApp = async (env, run) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ip-rate-limit-app-"));

  try {
    await withEnv(env, async () => {
      const app = await createApp({
        agentRunStore: createInMemoryAgentRunStore(),
        healthService: okHealthService,
        ragService: {
          initializeDocumentRegistry: async () => [],
          initializeLongMemory: async () => true,
          initializeSessionMemory: async () => true,
          listDocuments: () => [],
        },
        taskStore: createInMemoryTaskStore(),
        uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
        uploadsDirectory: path.join(tempRoot, "uploads"),
      });
      const server = createServer(app);

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

      try {
        await run(`http://127.0.0.1:${server.address().port}`);
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        await app.locals.stop?.();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

// "POST /agent-tasks" -> the response of one request without a credential.
const send = (baseUrl, route) => {
  const [method, target] = route.split(" ");

  return fetch(`${baseUrl}${target}`, {
    ...(method === "GET" ? {} : { body: "{}", headers: { "Content-Type": "application/json" } }),
    method,
  });
};

const expectStatus = async (baseUrl, route, status) => {
  const response = await send(baseUrl, route);

  assert.equal(response.status, status, route);
  return response;
};

// Over its limit: the per-IP limiter's answer (no code, unlike the per-tenant
// TENANT_RATE_LIMITED), naming the limit of the class that refused it.
const expectLimited = async (baseUrl, route, limit) => {
  const response = await expectStatus(baseUrl, route, 429);

  assert.equal(response.headers.get("ratelimit-limit"), String(limit), route);
  assert.deepEqual(await response.json(), { error: "Too many requests. Please retry later." });
};

test("RATE_LIMIT_ENABLED unset: no per-IP limiter is mounted", async () => {
  await withApp(limitEnv({ RATE_LIMIT_CHAT_MAX: "1", RATE_LIMIT_ENABLED: undefined }), async (baseUrl) => {
    for (let index = 0; index < 3; index += 1) {
      const response = await expectStatus(baseUrl, "POST /agent-tasks", 401);

      assert.equal(response.headers.get("ratelimit-limit"), null);
    }
  });
});

test("every route that starts or resumes agent work shares the chat-class limit", async () => {
  await withApp(limitEnv({ RATE_LIMIT_CHAT_MAX: "2" }), async (baseUrl) => {
    // Counted before API auth, as the old /chat limiter was.
    for (let index = 0; index < 2; index += 1) {
      const response = await expectStatus(baseUrl, "POST /agent-tasks", 401);

      assert.equal(response.headers.get("ratelimit-limit"), "2");
    }

    for (const route of [
      "POST /agent-tasks",
      "POST /chat",
      // Case and a trailing slash reach the same route in Express.
      "POST /CHAT/STREAM/",
      "POST /tasks/task-1/actions/run",
      "POST /agent-triggers/trigger-1/dispatch",
      "POST /agent-runs/run-1/actions/approve",
      "POST /agent-runs/run-1/steps/step-1/actions/retry",
      "POST /agent-runs/run-1/recovery/actions/resume",
    ]) {
      await expectLimited(baseUrl, route, 2);
    }

    // The other classes keep their own counters.
    await expectStatus(baseUrl, "POST /upload/chunk", 401);
    await expectStatus(baseUrl, "DELETE /documents/doc-1", 401);
    await expectStatus(baseUrl, "GET /agent-runs", 401);

    // GET /chat is no route (asking is POST only): only the global limit
    // counts it.
    const getChat = await expectStatus(baseUrl, "GET /chat?question=hi", 401);

    assert.equal(getChat.headers.get("ratelimit-limit"), "300");
  });
});

test("uploads, upload chunks, replaces, restores and arXiv imports share the ingest-class limit", async () => {
  await withApp(limitEnv({ RATE_LIMIT_UPLOAD_MAX: "2" }), async (baseUrl) => {
    await expectStatus(baseUrl, "POST /upload/chunk", 401);
    await expectStatus(baseUrl, "POST /upload/chunk", 401);

    for (const route of [
      "POST /upload/chunk",
      "POST /upload/init",
      "POST /upload/complete",
      "POST /upload",
      // Every path the old /upload limiter matched stays in the class.
      "GET /upload/status?fileId=file-1",
      "PUT /documents/doc-1",
      "POST /documents/doc-1/restore",
      "POST /arxiv/import",
      "POST /documents/doc-1/arxiv/import",
    ]) {
      await expectLimited(baseUrl, route, 2);
    }

    await expectStatus(baseUrl, "POST /agent-tasks", 401);
    // arXiv search and suggestions are not classified: the global limit only.
    await expectStatus(baseUrl, "GET /arxiv/search?query=rag", 401);
  });
});

test("the documents clear and the tenant erase share the destructive-class limit; a single DELETE does not", async () => {
  await withApp(limitEnv({ RATE_LIMIT_DESTRUCTIVE_MAX: "2" }), async (baseUrl) => {
    await expectStatus(baseUrl, "POST /documents/clear", 401);
    await expectStatus(baseUrl, "POST /admin/tenants/erase", 401);

    for (const route of ["POST /documents/clear", "POST /admin/tenants/erase"]) {
      await expectLimited(baseUrl, route, 2);
    }

    // One DELETE per deleted document or closed session (what the UI sends):
    // only the global limit counts it, as before the classes.
    for (const route of [
      "DELETE /documents/doc-1",
      "DELETE /documents/doc-2",
      "DELETE /memory/memory-1",
      "DELETE /memory",
      "DELETE /sessions/session-1",
      "DELETE /admin/workspaces/acme/members/alice",
      "DELETE /no-such-route",
    ]) {
      const response = await send(baseUrl, route);

      assert.notEqual(response.status, 429, route);
      assert.equal(response.headers.get("ratelimit-limit"), "300", route);
    }

    await expectStatus(baseUrl, "GET /admin/tenants/export", 401);
    await expectStatus(baseUrl, "POST /agent-tasks", 401);
  });
});

test("the tenant erase keeps its own destructive limit", async () => {
  await withApp(limitEnv({ RATE_LIMIT_DESTRUCTIVE_MAX: "2" }), async (baseUrl) => {
    await expectStatus(baseUrl, "POST /admin/tenants/erase", 401);
    await expectStatus(baseUrl, "POST /admin/tenants/erase", 401);
    await expectLimited(baseUrl, "POST /admin/tenants/erase", 2);
    await expectLimited(baseUrl, "POST /Admin/Tenants/Erase/", 2);
  });
});

test("a default-class request sees only the global limit", async () => {
  await withApp(
    limitEnv({
      RATE_LIMIT_CHAT_MAX: "1",
      RATE_LIMIT_DESTRUCTIVE_MAX: "1",
      RATE_LIMIT_GLOBAL_MAX: "4",
      RATE_LIMIT_UPLOAD_MAX: "1",
    }),
    async (baseUrl) => {
      // Global 1 and 2; the second is over the chat-class limit.
      await expectStatus(baseUrl, "POST /agent-tasks", 401);
      await expectLimited(baseUrl, "POST /agent-tasks", 1);

      // Global 3 and 4: only the global limiter counted these.
      for (const route of ["GET /documents", "GET /agent-runs"]) {
        const response = await expectStatus(baseUrl, route, 401);

        assert.equal(response.headers.get("ratelimit-limit"), "4", route);
      }

      await expectLimited(baseUrl, "GET /documents", 4);
      // The probes are mounted before every limiter.
      await expectStatus(baseUrl, "GET /livez", 200);
    }
  );
});
