// A dispatched agent trigger acts for the request's user, never for a userId
// nested in the dispatch payload (POST /agent-triggers/:triggerId/dispatch with
// {"payload": {"userId": ...}} or {"input": {"userId": ...}}). requireApiAuth
// refuses a client userId only at the top level of the body, and the built-in
// research_dossier trigger allows a "userId" payload field, so an
// API_AUTH_TOKENS entry without a userId could create a task (and its
// long-term memory reads and writes) as any user by nesting the field. The
// rule is the one routes follow through resolveRequestUserId: an authenticated
// scope's user only; without authentication, the scope's user, else the
// payload's, as before.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { createApp } from "../app.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createAgentTriggerDispatcher } from "../rag/agent-trigger-dispatcher.js";

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const AUTH_ENV_KEYS = [
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_REQUIRE_WORKSPACE",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "RBAC_MODE",
];

const withEnv = async (values, run) => {
  const original = new Map(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of AUTH_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return await run();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const createRecordingDispatcher = () => {
  const createTaskCalls = [];
  const dispatcher = createAgentTriggerDispatcher({
    agentTaskService: {
      createTask: async (request) => {
        createTaskCalls.push(request);
        return { id: `task-${createTaskCalls.length}`, status: "queued" };
      },
    },
  });

  return { createTaskCalls, dispatcher };
};

const dispatchAsMallory = (dispatcher, accessScope, envelope) =>
  dispatcher.dispatch({
    accessScope,
    request: { id: `request-${envelope}` },
    triggerId: "research_dossier_manual",
    ...(envelope === "payload"
      ? { payload: { question: "Build a report", userId: "victim" } }
      : { input: { question: "Build a report", userId: "victim" } }),
  });

test("an authenticated scope without a user never takes a payload userId", async () => {
  for (const envelope of ["payload", "input"]) {
    const { createTaskCalls, dispatcher } = createRecordingDispatcher();

    await assert.rejects(
      () =>
        dispatchAsMallory(
          dispatcher,
          { authenticated: true, userId: "", workspaceId: "ws-a" },
          envelope
        ),
      (error) => error.status === 403 && /requires a user scope/.test(error.message)
    );
    assert.equal(createTaskCalls.length, 0, envelope);
  }
});

test("an authenticated scope with a user acts as that user, not the payload's", async () => {
  for (const envelope of ["payload", "input"]) {
    const { createTaskCalls, dispatcher } = createRecordingDispatcher();

    await dispatchAsMallory(
      dispatcher,
      { authenticated: true, userId: "mallory", workspaceId: "ws-a" },
      envelope
    );
    assert.equal(createTaskCalls.length, 1, envelope);
    assert.equal(createTaskCalls[0].userId, "mallory", envelope);
  }
});

test("without authentication a payload userId still fills an empty scope user", async () => {
  const { createTaskCalls, dispatcher } = createRecordingDispatcher();

  await dispatchAsMallory(
    dispatcher,
    { authenticated: false, userId: "", workspaceId: "ws-a" },
    "payload"
  );
  assert.equal(createTaskCalls[0].userId, "victim");
});

const postJson = (baseUrl, path, { body, headers = {} }) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      `${baseUrl}${path}`,
      {
        headers: {
          "content-length": Buffer.byteLength(payload),
          "content-type": "application/json",
          ...headers,
        },
        method: "POST",
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ body: text ? JSON.parse(text) : null, status: response.status ?? response.statusCode });
        });
      }
    );
    request.on("error", reject);
    request.end(payload);
  });

test("POST /agent-triggers/:id/dispatch: a workspace token cannot run a task as another user", async () => {
  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKENS: JSON.stringify({ "workspace-token": { workspaceId: "ws-a" } }),
    },
    async () => {
      const createTaskCalls = [];
      const app = await createApp({
        agentTaskService: {
          createTask: async (request) => {
            createTaskCalls.push(request);
            return { id: "task-1", status: "queued" };
          },
        },
        executionPlannerAdapter: deterministicPlannerAdapter,
        healthService: {
          buildHealthReport: async () => ({ checks: {}, status: "ok" }),
          runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
        },
        intentPlannerAdapter: deterministicIntentPlannerAdapter,
        ragService: {
          initializeDocumentRegistry: async () => [],
          initializeSessionMemory: async () => true,
          listDocuments: () => [],
        },
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      try {
        for (const body of [
          { payload: { question: "Build a report", userId: "victim" }, request: { id: "r1" } },
          { input: { question: "Build a report", userId: "victim" }, request: { id: "r2" } },
        ]) {
          const response = await postJson(
            baseUrl,
            "/agent-triggers/research_dossier_manual/dispatch",
            { body, headers: { "x-api-key": "workspace-token" } }
          );

          assert.equal(response.status, 403, JSON.stringify(response.body));
        }

        assert.deepEqual(
          createTaskCalls.map((call) => call.userId),
          [],
          "no task may be created for the nested userId"
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  );
});
