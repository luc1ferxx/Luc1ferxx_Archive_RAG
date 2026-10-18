// The task, trigger and agent-run routes (routes/tasks.js) bound what one
// request may carry, as /chat does (chat-input-bounds.test.mjs): a question by
// CHAT_MAX_QUESTION_CHARS, every id (path parameters, gate, session, user and
// idempotency ids, list filters) by CHAT_MAX_ID_CHARS, an agent task's docIds
// by CHAT_MAX_DOC_IDS, and every free-form JSON body or field by
// TASK_MAX_PAYLOAD_BYTES and MAX_PAYLOAD_DEPTH. A request past one is answered
// 400 { error } before any service sees it; the edge of a split deployment
// runs the same validators.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { AGENT_EDGE_ROUTES } from "../rag/agent-service/edge-router.js";
import { getTaskMaxPayloadBytes } from "../rag/config.js";
import * as tasks from "../routes/tasks.js";
import { MAX_PAYLOAD_DEPTH, measureJsonBytes } from "../routes/validation.js";

const ENV_KEYS = [
  "AGENT_CANCEL_ON_DISCONNECT",
  "AGENT_REQUEST_TIMEOUT_MS",
  "CHAT_MAX_DOC_IDS",
  "CHAT_MAX_ID_CHARS",
  "CHAT_MAX_QUESTION_CHARS",
  "TASK_MAX_PAYLOAD_BYTES",
];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  ENV_KEYS.forEach((key) => delete process.env[key]);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const nest = (depth) => {
  let value = "leaf";

  for (let level = 0; level < depth; level += 1) {
    value = { next: value };
  }

  return value;
};

// The tasks router over stand-in services that record every call they get.
const startTasksServer = async (t) => {
  const calls = [];
  const record = (name, result = {}) => async (input) => {
    calls.push({ input, name });
    return result;
  };
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    req.accessScope = { userId: "alice", workspaceId: "workspace-a" };
    next();
  });
  app.use(
    tasks.createTasksRouter({
      agentRunRecoveryActionService: {
        applyRecoveryAction: record("applyRecoveryAction"),
        listRecoveryRuns: record("listRecoveryRuns", []),
      },
      agentRunService: { getRun: record("getRun", { id: "run" }), listRuns: record("listRuns", []) },
      agentRunStepExecutor: { applyApprovalAction: record("applyApprovalAction"), retryStep: record("retryStep") },
      agentTaskService: { createTask: record("createTask", { id: "task" }) },
      agentTriggerDispatcher: { dispatch: record("dispatch") },
      agentTriggerRegistry: { listPublic: () => [] },
      capabilityRegistry: { list: () => [] },
      jobOrchestrator: { resumeTask: record("resumeTask") },
      taskService: { getTask: record("getTask", { id: "task" }), listTasks: record("listTasks", []) },
    })
  );

  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const send = (path, { body, headers = {}, method = body === undefined ? "GET" : "POST" } = {}) =>
    fetch(`${baseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
      method,
    });
  // A refusal: 400 { error } matching `pattern`, and no service call.
  const refuses = async (pattern, path, options) => {
    const before = calls.length;
    const response = await send(path, options);
    const body = await response.json();

    assert.equal(response.status, 400, `${path}: ${JSON.stringify(body)}`);
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.match(body.error, pattern);
    assert.equal(calls.length, before, `${path} reached a service`);
  };
  const accepts = async (path, options) => {
    const response = await send(path, options);

    assert.ok(response.status < 300, `${path}: ${response.status} ${await response.text()}`);
    return calls.at(-1);
  };

  return { accepts, calls, refuses };
};

test("the payload size and depth helpers", () => {
  assert.equal(getTaskMaxPayloadBytes(), 262144);
  process.env.TASK_MAX_PAYLOAD_BYTES = "";
  assert.equal(getTaskMaxPayloadBytes(), 262144);
  process.env.TASK_MAX_PAYLOAD_BYTES = "0";
  assert.equal(getTaskMaxPayloadBytes(), 0);
  assert.equal(MAX_PAYLOAD_DEPTH, 32);
  assert.equal(measureJsonBytes({ a: "é" }), Buffer.byteLength('{"a":"é"}'));
  assert.equal(measureJsonBytes(undefined), 0);
});

test("POST /agent-tasks bounds the question, the ids, the preferences and the rest of the body", async (t) => {
  process.env.CHAT_MAX_QUESTION_CHARS = "20";
  process.env.CHAT_MAX_DOC_IDS = "2";
  process.env.CHAT_MAX_ID_CHARS = "8";
  process.env.TASK_MAX_PAYLOAD_BYTES = "400";

  const { accepts, refuses } = await startTasksServer(t);
  const post = (body) => ({ body });

  await refuses(/Question is required/, "/agent-tasks", post({}));
  await refuses(/Question must be at most 20 characters/, "/agent-tasks", post({ question: "q".repeat(21) }));
  await refuses(/Too many docIds: the limit is 2/, "/agent-tasks", post({ docIds: ["a", "b", "c"], question: "q" }));
  await refuses(/Each entry of docIds must be at most 8/, "/agent-tasks", post({ docIds: ["a".repeat(9)], question: "q" }));
  await refuses(/docId must be at most 8/, "/agent-tasks", post({ docId: "d".repeat(9), question: "q" }));
  await refuses(/sessionId must be a string/, "/agent-tasks", post({ question: "q", sessionId: 7 }));
  await refuses(/sessionId must be at most 8/, "/agent-tasks", post({ question: "q", sessionId: "s".repeat(9) }));
  await refuses(/userId must be at most 8/, "/agent-tasks", post({ question: "q", userId: "u".repeat(9) }));
  await refuses(/userPreferences must be a list/, "/agent-tasks", post({ question: "q", userPreferences: "terse" }));
  await refuses(/At most 64 userPreferences/, "/agent-tasks", post({ question: "q", userPreferences: Array(65).fill("x") }));
  await refuses(
    /Each user preference must be at most 20/,
    "/agent-tasks",
    post({ question: "q", userPreferences: ["p".repeat(21)] })
  );
  await refuses(/The agent task must be at most 400 bytes/, "/agent-tasks", post({ extra: "x".repeat(400), question: "q" }));
  await refuses(/nested more than 32 levels/, "/agent-tasks", post({ extra: nest(32), question: "q" }));

  const created = await accepts(
    "/agent-tasks",
    post({ docIds: ["a", "b"], extra: nest(31), maxIterations: 3, question: " q ", sessionId: "s1", userPreferences: ["terse"] })
  );

  assert.equal(created.name, "createTask");
  assert.equal(created.input.question, "q");
  assert.deepEqual(created.input.docIds, ["a", "b"]);
  assert.equal(created.input.sessionId, "s1");

  // docIds have their own bounds and do not count toward the payload's bytes.
  process.env.CHAT_MAX_ID_CHARS = "200";
  await accepts("/agent-tasks", post({ docIds: ["a".repeat(200), "b".repeat(200)], question: "q" }));

  // 0 turns the size limit off; the depth limit stays.
  process.env.TASK_MAX_PAYLOAD_BYTES = "0";
  await accepts("/agent-tasks", post({ extra: "x".repeat(10_000), question: "q" }));
  await refuses(/nested more than 32 levels/, "/agent-tasks", post({ extra: nest(40), question: "q" }));
});

test("task, run and trigger ids, list filters and action payloads are bounded", async (t) => {
  process.env.CHAT_MAX_ID_CHARS = "8";
  process.env.TASK_MAX_PAYLOAD_BYTES = "200";

  const { accepts, refuses } = await startTasksServer(t);
  const long = "x".repeat(9);
  const big = { note: "n".repeat(200) };

  // Lists: one short string per filter (a repeated parameter is an array).
  await refuses(/type must be at most 8/, `/tasks?type=${long}`);
  await refuses(/type must be a string/, "/tasks?type=a&type=b");
  await refuses(/status must be at most 8/, `/agent-runs?status=${long}`);
  await refuses(/enabledOnly must be at most 8/, `/agent-triggers?enabledOnly=${long}`);
  assert.equal((await accepts("/tasks?type=arxiv")).input.type, "arxiv");
  assert.equal((await accepts("/agent-runs?status=failed")).input.status, "failed");
  await accepts("/agent-triggers?enabledOnly=true");

  // Path parameters.
  await refuses(/taskId must be at most 8/, `/tasks/${long}`);
  await refuses(/runId must be at most 8/, `/agent-runs/${long}`);
  await refuses(/action must be at most 8/, `/tasks/t1/actions/${long}`, { body: {} });
  await refuses(/stepId must be at most 8/, `/agent-runs/r1/steps/${long}/actions/retry`, { body: {} });
  await refuses(/triggerId must be at most 8/, `/agent-triggers/${long}/dispatch`, { body: {} });
  await accepts("/tasks/t1");
  await accepts("/agent-runs/r1");

  // Action payloads.
  await refuses(/The action payload must be at most 200 bytes/, "/tasks/t1/actions/confirm", { body: big });
  await refuses(/nested more than 32 levels/, "/tasks/t1/actions/confirm", { body: nest(33) });
  await refuses(/The action payload must be at most 200 bytes/, "/agent-runs/r1/recovery/actions/retry", { body: big });
  await refuses(/The action payload must be at most 200 bytes/, "/agent-runs/r1/actions/approve", { body: big });
  await refuses(/gateId must be a string/, "/agent-runs/r1/actions/approve", { body: { gateId: ["g"] } });
  await refuses(/gateId must be at most 8/, "/agent-runs/r1/actions/approve", { body: { gateId: long } });
  await refuses(/The action payload must be at most 200 bytes/, "/agent-runs/r1/steps/s1/actions/retry", { body: big });

  const confirmed = await accepts("/tasks/t1/actions/confirm", { body: { selectedArxivIds: ["2401.1"] } });

  assert.equal(confirmed.name, "resumeTask");
  assert.deepEqual(confirmed.input.payload, { selectedArxivIds: ["2401.1"] });

  const approved = await accepts("/agent-runs/r1/actions/approve", { body: { approvalObjectHash: "h", gateId: "g1" } });

  assert.equal(approved.name, "applyApprovalAction");
  assert.equal(approved.input.gateId, "g1");
  assert.equal((await accepts("/agent-runs/r1/recovery/actions/retry", { body: {} })).name, "applyRecoveryAction");
  assert.equal((await accepts("/agent-runs/r1/steps/s1/actions/retry", { body: {} })).name, "retryStep");
});

test("a trigger dispatch bounds its body, its ids and the idempotency headers", async (t) => {
  process.env.CHAT_MAX_ID_CHARS = "8";
  process.env.TASK_MAX_PAYLOAD_BYTES = "300";

  const { accepts, refuses } = await startTasksServer(t);
  const path = "/agent-triggers/daily/dispatch";
  const long = "k".repeat(9);

  await refuses(/idempotencyKey must be at most 8/, path, { body: { idempotencyKey: long } });
  await refuses(/idempotencyKey must be a string/, path, { body: { idempotencyKey: { id: "k" } } });
  await refuses(/request\.id must be at most 8/, path, { body: { request: { id: long } } });
  await refuses(/request\.id must be a string/, path, { body: { request: { id: ["k"] } } });
  await refuses(/mode must be at most 8/, path, { body: { mode: long } });
  await refuses(/x-idempotency-key must be at most 8/, path, { body: {}, headers: { "x-idempotency-key": long } });
  await refuses(/x-request-id must be at most 8/, path, { body: {}, headers: { "x-request-id": long } });
  await refuses(/The trigger dispatch must be at most 300 bytes/, path, { body: { input: { text: "t".repeat(300) } } });
  await refuses(/nested more than 32 levels/, path, { body: { event: nest(33) } });

  const dispatched = await accepts(path, {
    body: { event: { source: "cron" }, idempotencyKey: 42, input: { question: "q" }, request: "not an object" },
    headers: { "x-request-id": "req-1" },
  });

  assert.equal(dispatched.name, "dispatch");
  assert.equal(dispatched.input.triggerId, "daily");
  assert.equal(dispatched.input.request.id, "42");
});

test("the edge of a split deployment validates every task route with the route's own validator", () => {
  const expected = {
    "get /agent-runs": tasks.validateRunListRequest,
    "get /agent-runs/:runId": tasks.validateRunIdRequest,
    "get /agent-triggers": tasks.validateTriggerListRequest,
    "get /tasks": tasks.validateTaskListRequest,
    "get /tasks/:taskId": tasks.validateTaskIdRequest,
    "post /agent-runs/:runId/actions/:action": tasks.validateRunActionRequest,
    "post /agent-runs/:runId/recovery/actions/:action": tasks.validateRunRecoveryActionRequest,
    "post /agent-runs/:runId/steps/:stepId/actions/retry": tasks.validateRunStepRetryRequest,
    "post /agent-tasks": tasks.validateAgentTaskRequest,
    "post /agent-triggers/:triggerId/dispatch": tasks.validateTriggerDispatchRequest,
    "post /tasks/:taskId/actions/:action": tasks.validateTaskActionRequest,
  };
  const taskRoutes = AGENT_EDGE_ROUTES.filter((route) => !route.path.startsWith("/chat"));

  for (const route of taskRoutes) {
    const key = `${route.method} ${route.path}`;

    // The two routes that read nothing from the request have no check.
    if (key === "get /agent-runs/recovery" || key === "get /capabilities") {
      assert.equal(route.validate, undefined, key);
    } else {
      assert.equal(route.validate, expected[key], key);
    }
  }

  assert.equal(taskRoutes.filter((route) => route.validate).length, Object.keys(expected).length);

  // The validator answers the response it is handed, as the edge expects.
  process.env.TASK_MAX_PAYLOAD_BYTES = "10";

  const sent = {};
  const res = {
    json(body) {
      sent.body = body;
      return this;
    },
    status(code) {
      sent.status = code;
      return this;
    },
  };

  assert.equal(
    tasks.validateTaskActionRequest({ body: { note: "too long" }, params: { action: "confirm", taskId: "t1" } }, res),
    null
  );
  assert.equal(sent.status, 400);
  assert.match(sent.body.error, /at most 10 bytes/);
});
