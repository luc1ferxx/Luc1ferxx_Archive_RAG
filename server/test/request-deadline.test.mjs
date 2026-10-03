import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  classifyDependencyOutage,
  DEFAULT_OUTAGE_RETRY_AFTER_SECONDS,
  DependencyOutageError,
  describeAgentRequestFailure,
  resolveAgentRunTermination,
  toDependencyOutageError,
} from "../rag/dependency-outage.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import { resetModelGatewayClient } from "../rag/model-gateway/client.js";
import { MODEL_GATEWAY_ERROR_CODES } from "../rag/model-gateway/protocol.js";
import { completeText, resetOpenAIProvider } from "../rag/openai.js";
import { requestCrossEncoderScores } from "../rag/reranker.js";
import {
  CLIENT_CLOSED_REQUEST_STATUS,
  createRequestCancellation,
  getAgentRequestTimeoutMs,
  getRequestBudgetMs,
  getRequestCallOptions,
  getRequestCancellation,
  getRequestDeadline,
  getRequestSignal,
  isAgentCancelOnDisconnectEnabled,
  REQUEST_CANCELLATION_CODES,
  REQUEST_CANCELLATION_REASONS,
  RequestCancelledError,
  resolveAgentRequestDeadline,
  runAgentRequestWithCancellation,
  runOutsideRequestDeadline,
  runWithRequestCancellation,
  runWithRequestDeadline,
  throwIfRequestCancelled,
  withRequestSignal,
} from "../rag/request-deadline.js";
import {
  bindServiceCallDeadline,
  getServiceCallBudgetMs,
  getServiceCallDeadline,
  runWithServiceCallDeadline,
} from "../rag/retrieval-service/call-deadline.js";
import {
  retrieveGlobalContextRemotely,
  RetrievalServiceError,
} from "../rag/retrieval-service/remote-retrieval.js";
import {
  resetServiceClients,
  ServiceTimeoutError,
  ServiceUnavailableError,
} from "../rag/service-client.js";
import { createTaskService, TASK_STATUSES } from "../rag/tasks.js";

// The request-scoped deadline and cancellation signal (rag/request-deadline.js)
// and the outage classification (rag/dependency-outage.js), unit by unit:
// the store and its budgets, the binding the agent routes use, background
// work detached from it, and every outbound client that reads it -- a direct
// model call, the model gateway, the retrieval tier, the cross-encoder -- each
// against a local server that never answers, so the abort is observable.

const SECRET = `${"d".repeat(24)}-deadline-secret-0123456789`;

const withEnv = (t, values) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

// A server that takes every request and never answers. Each request is
// recorded with its headers and a promise that settles when the caller drops
// the connection.
const startHangingServer = async (t) => {
  const requests = [];
  const open = new Set();
  const server = http.createServer((req, res) => {
    const closed = createDeferred();
    const entry = { closed: closed.promise, closedAt: null, headers: req.headers, path: req.url };

    open.add(res);
    requests.push(entry);
    req.resume();
    res.on("close", () => {
      entry.closedAt = Date.now();
      open.delete(res);
      closed.resolve();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const res of open) res.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return { requests, url: `http://127.0.0.1:${server.address().port}` };
};

test("outside a bound request nothing is bound, and every budget is the caller's own", async () => {
  assert.equal(getRequestDeadline(), null);
  assert.equal(getRequestSignal(), null);
  assert.equal(getRequestBudgetMs(1234), 1234);
  assert.equal(getRequestCancellation(), null);
  assert.equal(withRequestSignal(undefined), undefined);
  assert.equal(getRequestCallOptions(60_000), undefined);
  assert.doesNotThrow(() => throwIfRequestCancelled());

  const own = new AbortController().signal;

  assert.equal(withRequestSignal(own), own);
  assert.equal(getServiceCallDeadline(), null);
  assert.equal(runWithServiceCallDeadline(null, () => getServiceCallBudgetMs(1234)), 1234);

  // With neither AGENT_REQUEST_TIMEOUT_MS nor AGENT_CANCEL_ON_DISCONNECT the
  // routes run the work unbound.
  const env = {};
  const res = new EventEmitter();
  const seen = await runAgentRequestWithCancellation({}, res, async () => ({
    deadline: getRequestDeadline(),
    signal: getRequestSignal(),
  }), { env });

  assert.deepEqual(seen, { deadline: null, signal: null });
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(getAgentRequestTimeoutMs(env), 0);
  assert.equal(isAgentCancelOnDisconnectEnabled(env), false);
});

test("a bound deadline caps budgets, aborts its signal when it passes, and is a cancellation from then on", async () => {
  const startedAt = Date.now();

  await runWithRequestDeadline({ deadlineAt: startedAt + 60 }, async () => {
    const budget = getRequestBudgetMs(10_000);

    assert.ok(budget > 0 && budget <= 60, `budget ${budget}`);
    assert.equal(getRequestBudgetMs(10), 10, "a shorter own timeout stays");
    assert.ok(getRequestBudgetMs(0) <= 60, "no own timeout: what is left");
    assert.equal(getRequestCancellation(), null);
    assert.deepEqual(Object.keys(getRequestCallOptions(60_000)).sort(), ["signal", "timeout"]);

    const signal = getRequestSignal();

    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));

    assert.ok(Date.now() >= startedAt + 60, "never a millisecond early");
    assert.ok(signal.reason instanceof RequestCancelledError);
    assert.equal(signal.reason.reason, REQUEST_CANCELLATION_REASONS.deadlineExceeded);
    assert.equal(signal.reason.code, REQUEST_CANCELLATION_CODES.deadlineExceeded);
    assert.equal(signal.reason.status, 504);
    assert.deepEqual(signal.reason.runFailure, {
      code: "AGENT_DEADLINE_EXCEEDED",
      reason: "deadline_exceeded",
      retryable: true,
    });
    assert.equal(getRequestBudgetMs(10_000), 0);
    assert.throws(() => throwIfRequestCancelled(), RequestCancelledError);
  });

  // A deadline that already passed is a cancellation before its timer fires.
  runWithRequestDeadline({ deadlineAt: Date.now() - 1 }, () => {
    assert.equal(getRequestCancellation()?.reason, REQUEST_CANCELLATION_REASONS.deadlineExceeded);
  });

  // A client cancellation keeps its own reason, status and retryable flag.
  const cancellation = createRequestCancellation();

  runWithRequestCancellation(cancellation, () => {
    cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);
    const error = getRequestCancellation();

    assert.equal(error.reason, REQUEST_CANCELLATION_REASONS.clientCancelled);
    assert.equal(error.code, REQUEST_CANCELLATION_CODES.clientCancelled);
    assert.equal(error.status, CLIENT_CLOSED_REQUEST_STATUS);
    assert.equal(error.retryable, false);
  });
  cancellation.dispose();
});

test("the agent routes bind the calling tier's deadline or AGENT_REQUEST_TIMEOUT_MS, whichever comes first", () => {
  const arrivedAt = 1_000_000;

  assert.equal(resolveAgentRequestDeadline({}, { arrivedAt, env: {} }), null);
  assert.equal(
    resolveAgentRequestDeadline({}, { arrivedAt, env: { AGENT_REQUEST_TIMEOUT_MS: "250" } }),
    arrivedAt + 250
  );
  assert.equal(
    resolveAgentRequestDeadline({ serviceIdentity: { deadlineAt: arrivedAt + 900 } }, { arrivedAt, env: {} }),
    arrivedAt + 900
  );
  assert.equal(
    resolveAgentRequestDeadline(
      { serviceIdentity: { deadlineAt: arrivedAt + 900 } },
      { arrivedAt, env: { AGENT_REQUEST_TIMEOUT_MS: "250" } }
    ),
    arrivedAt + 250
  );

  for (const value of ["", "0", "-5", "soon"]) {
    assert.equal(getAgentRequestTimeoutMs({ AGENT_REQUEST_TIMEOUT_MS: value }), 0, value);
  }

  for (const value of ["on", "true", "1", "ON"]) {
    assert.equal(isAgentCancelOnDisconnectEnabled({ AGENT_CANCEL_ON_DISCONNECT: value }), true, value);
  }

  for (const value of [undefined, "", "off", "false", "0"]) {
    assert.equal(isAgentCancelOnDisconnectEnabled({ AGENT_CANCEL_ON_DISCONNECT: value }), false, String(value));
  }
});

const createFakeResponse = () => {
  const res = new EventEmitter();

  res.writableFinished = false;
  return res;
};

test("with AGENT_CANCEL_ON_DISCONNECT on a client that leaves cancels the request; off, it does not", async () => {
  const leaving = createFakeResponse();
  const aborted = await runAgentRequestWithCancellation(
    {},
    leaving,
    async () => {
      const signal = getRequestSignal();

      leaving.emit("close");
      return signal.reason;
    },
    { env: { AGENT_CANCEL_ON_DISCONNECT: "on" } }
  );

  assert.equal(aborted.reason, REQUEST_CANCELLATION_REASONS.clientCancelled);
  assert.equal(leaving.listenerCount("close"), 0, "the listener goes with the request");

  // An answer that was written is not a disconnect.
  const answered = createFakeResponse();
  let signal = null;

  await runAgentRequestWithCancellation(
    {},
    answered,
    async () => {
      signal = getRequestSignal();
    },
    { env: { AGENT_CANCEL_ON_DISCONNECT: "on" } }
  );
  answered.writableFinished = true;
  answered.emit("close");
  assert.equal(signal.aborted, false);

  // Off (with a deadline bound), a client that leaves changes nothing.
  const ignored = createFakeResponse();
  const stillRunning = await runAgentRequestWithCancellation(
    {},
    ignored,
    async () => {
      ignored.emit("close");
      return getRequestSignal().aborted;
    },
    { env: { AGENT_REQUEST_TIMEOUT_MS: "60000" } }
  );

  assert.equal(stillRunning, false);
});

test("a deadline further away than setTimeout can wait (AGENT_REQUEST_TIMEOUT_MS has no cap) does not cancel at once", async () => {
  // Node fires a timer longer than 2^31 - 1 ms after 1 ms. 30 days, as an
  // operator might set to mean "practically no limit".
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const cancellation = createRequestCancellation({ deadlineAt: Date.now() + thirtyDaysMs });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cancellation.signal.aborted, false);
  cancellation.dispose();

  const aborted = await runAgentRequestWithCancellation(
    {},
    createFakeResponse(),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { aborted: getRequestSignal().aborted, budget: getRequestBudgetMs(60_000) };
    },
    { env: { AGENT_REQUEST_TIMEOUT_MS: String(thirtyDaysMs) } }
  );

  assert.deepEqual(aborted, { aborted: false, budget: 60_000 });
});

test("with AGENT_CANCEL_ON_DISCONNECT on, a client that left before the route bound its run cancels it from the start", async (t) => {
  // The route binds after the middleware chain; a client that leaves while an
  // earlier middleware still awaits (auth, rate limiting) has closed the
  // response already, and close is never emitted again.
  const received = createDeferred();
  const seen = createDeferred();
  const server = http.createServer((req, res) => {
    req.resume();
    received.resolve();
    res.once("close", () =>
      setImmediate(() =>
        runAgentRequestWithCancellation(req, res, async () => getRequestSignal()?.reason ?? null, {
          env: { AGENT_CANCEL_ON_DISCONNECT: "on" },
        }).then(seen.resolve, seen.resolve)
      )
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  const socket = net.connect(server.address().port, "127.0.0.1");

  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write("POST /chat HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}");
  await received.promise;
  socket.destroy();

  const reason = await seen.promise;

  assert.ok(reason instanceof RequestCancelledError, String(reason));
  assert.equal(reason.reason, REQUEST_CANCELLATION_REASONS.clientCancelled);
});

test("bindServiceCallDeadline binds the caller's deadline for the rest of the request and clears it on close", async () => {
  const res = new EventEmitter();
  const deadlineAt = Date.now() + 5_000;
  const seen = await new Promise((resolve) => {
    bindServiceCallDeadline({ serviceIdentity: { deadlineAt } }, res, () => {
      setImmediate(() => resolve({ budget: getServiceCallBudgetMs(60_000), deadline: getServiceCallDeadline() }));
    });
  });

  assert.equal(seen.deadline, deadlineAt);
  assert.ok(seen.budget <= 5_000 && seen.budget > 0);
  res.emit("close");
});

test("a task scheduled from inside a request runs without the request's deadline or signal", async () => {
  const accessScope = { userId: "alice", workspaceId: "ws-a" };
  const taskService = createTaskService();
  const ran = createDeferred();
  const orchestrator = createJobOrchestrator({
    runners: {
      probe: {
        id: "probe",
        run: async () => {
          ran.resolve({ deadline: getRequestDeadline(), signal: getRequestSignal() });
          return {};
        },
      },
    },
    taskService,
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "probe-task",
      input: {},
      payload: {},
      runnerId: "probe",
      status: TASK_STATUSES.queued,
      type: "probe",
    },
  });

  const inherited = createDeferred();

  await runWithRequestDeadline({ deadlineAt: Date.now() + 20 }, async () => {
    // A plain timer would inherit the request (the control) ...
    setTimeout(() => inherited.resolve(getRequestDeadline()), 0);
    // ... the job orchestrator's scheduled run does not, even after the
    // request's deadline has passed.
    orchestrator.scheduleTaskRun({ accessScope, delayMs: 40, taskId: "probe-task" });
  });

  assert.notEqual(await inherited.promise, null);
  assert.deepEqual(await ran.promise, { deadline: null, signal: null });
  assert.equal(
    runWithRequestDeadline({ deadlineAt: Date.now() + 1_000 }, () =>
      runOutsideRequestDeadline(() => getRequestSignal())
    ),
    null
  );
});

test("dependency outages are classified by code and status, never by message", () => {
  const cases = [
    [new ServiceUnavailableError("x", { code: "SERVICE_UNREACHABLE", service: "retrieval" }), 503, "retrieval", "SERVICE_UNREACHABLE"],
    [new ServiceUnavailableError("x", { code: "SERVICE_UNAVAILABLE", service: "agent" }), 503, "service", "SERVICE_UNAVAILABLE"],
    [new ServiceTimeoutError("x", { service: "retrieval" }), 504, "retrieval", "SERVICE_TIMEOUT"],
    [Object.assign(new Error("x"), { code: "MODEL_GATEWAY_UNAVAILABLE", status: 503 }), 503, "model", "MODEL_GATEWAY_UNAVAILABLE"],
    [Object.assign(new Error("x"), { code: "MODEL_GATEWAY_TIMEOUT", status: 504 }), 504, "model", "MODEL_GATEWAY_TIMEOUT"],
    [Object.assign(new Error("x"), { code: "CIRCUIT_OPEN", status: 503 }), 503, "model", "CIRCUIT_OPEN"],
    [new RetrievalServiceError("x", { code: "MODEL_GATEWAY_UNAVAILABLE", status: 503 }), 503, "retrieval", "MODEL_GATEWAY_UNAVAILABLE"],
    [new RetrievalServiceError("x", { code: "SERVICE_TIMEOUT", status: 504 }), 504, "retrieval", "SERVICE_TIMEOUT"],
    [Object.assign(new Error("x"), { status: 502, upstreamStatus: 502 }), 503, "model", "HTTP_502"],
    [Object.assign(new Error("x"), { status: 408, upstreamStatus: 408 }), 504, "model", "HTTP_408"],
    [Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("y"), { code: "ECONNREFUSED" }) }), 503, "dependency", "ECONNREFUSED"],
    [Object.assign(new Error("x"), { code: "57P01" }), 503, "database", "57P01"],
    [Object.assign(new Error("x"), { code: "08006" }), 503, "database", "08006"],
    [new Error("Connection terminated unexpectedly"), 503, "database", null],
  ];

  for (const [error, status, dependency, causeCode] of cases) {
    const outage = toDependencyOutageError(error);

    assert.ok(outage instanceof DependencyOutageError, `${error.name} ${error.code ?? ""}`);
    assert.equal(outage.status, status, String(causeCode));
    assert.equal(outage.dependency, dependency, String(causeCode));
    assert.equal(outage.causeCode, causeCode);
    assert.equal(outage.retryable, true);
    assert.equal(outage.cause, error);
  }

  for (const error of [
    new Error("plain"),
    Object.assign(new Error("x"), { status: 503 }),
    Object.assign(new Error("x"), { status: 400 }),
    Object.assign(new Error("x"), { status: 429, upstreamStatus: 429 }),
    Object.assign(new Error("x"), { code: "MODEL_GATEWAY_PROTOCOL_ERROR", status: 502 }),
    new RetrievalServiceError("x", { code: "RETRIEVAL_RESPONSE_INVALID", status: 502 }),
    new RetrievalServiceError("x", { code: "RETRIEVAL_FAILED", status: 500 }),
    new RequestCancelledError(),
    null,
  ]) {
    assert.equal(classifyDependencyOutage(error), null, String(error?.code ?? error?.message));
  }

  // A cause's Retry-After becomes the answer's; otherwise the default.
  assert.equal(
    toDependencyOutageError(Object.assign(new Error("x"), { code: "CIRCUIT_OPEN", retryAfterMs: 2500 })).retryAfterSeconds,
    3
  );
  assert.equal(
    toDependencyOutageError(Object.assign(new Error("x"), { code: "CIRCUIT_OPEN" })).retryAfterSeconds,
    DEFAULT_OUTAGE_RETRY_AFTER_SECONDS
  );
});

test("an outage or a cancellation is answered with a stable code, never the cause's message", () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:5432 password=hunter2"), {
    code: "ECONNREFUSED",
  });
  const outage = toDependencyOutageError(cause);

  outage.agentRunId = "run-1";

  const answer = describeAgentRequestFailure(outage);

  assert.equal(answer.status, 503);
  assert.deepEqual(answer.headers, { "Retry-After": "5" });
  assert.deepEqual(answer.body, {
    agentRunId: "run-1",
    causeCode: "ECONNREFUSED",
    code: "AGENT_DEPENDENCY_UNAVAILABLE",
    dependency: "dependency",
    error: "A service this answer depends on is unavailable (ECONNREFUSED). Try again shortly.",
    retryAfterSeconds: 5,
    retryable: true,
  });
  assert.ok(!JSON.stringify(answer).includes("10.0.0.7"));
  assert.ok(!JSON.stringify(answer).includes("hunter2"));
  assert.deepEqual(outage.runFailure, {
    causeCode: "ECONNREFUSED",
    code: "AGENT_DEPENDENCY_UNAVAILABLE",
    dependency: "dependency",
    reason: "dependency_unavailable",
    retryable: true,
  });

  const deadline = describeAgentRequestFailure(new RequestCancelledError());

  assert.equal(deadline.status, 504);
  assert.deepEqual(deadline.headers, {});
  assert.equal(deadline.body.code, "AGENT_DEADLINE_EXCEEDED");
  assert.equal(deadline.body.reason, "deadline_exceeded");
  assert.equal(deadline.body.retryable, true);
  assert.equal(describeAgentRequestFailure(new Error("plain")), null);

  // Inside a cancelled request, whatever surfaced, the run ends with the
  // cancellation; outside one, an outage stays an outage.
  runWithRequestDeadline({ deadlineAt: Date.now() - 1 }, () => {
    assert.equal(resolveAgentRunTermination(new ServiceTimeoutError("x", { service: "retrieval" })).reason, "deadline_exceeded");
  });
  assert.equal(resolveAgentRunTermination(new ServiceTimeoutError("x", { service: "retrieval" })).code, "AGENT_DEPENDENCY_TIMEOUT");
  assert.equal(resolveAgentRunTermination(new Error("plain")), null);
});

const MODEL_ENV = {
  ARCHIVE_RAG_ROLE: undefined,
  MODEL_GATEWAY_URL: undefined,
  OPENAI_API_BASE: undefined,
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_FALLBACK_MODEL: "",
  OPENAI_CHAT_MODEL: "deadline-chat",
  RAG_LLM_REQUEST_TIMEOUT_MS: "10000",
  RAG_OBSERVABILITY_ENABLED: "false",
  RAG_SHARED_STATE: "memory",
};

test("a direct model call is aborted when the request's deadline passes, and is not retried", { timeout: 15_000 }, async (t) => {
  const model = await startHangingServer(t);

  withEnv(t, { ...MODEL_ENV, OPENAI_BASE_URL: `${model.url}/v1` });
  resetOpenAIProvider();
  t.after(() => resetOpenAIProvider());

  const startedAt = Date.now();

  await assert.rejects(
    runWithRequestDeadline({ deadlineAt: startedAt + 150 }, () => completeText("Say hello.")),
    (error) => error instanceof RequestCancelledError && error.reason === "deadline_exceeded"
  );

  await model.requests[0].closed;
  assert.equal(model.requests.length, 1, "no retry after the abort");
  assert.ok(model.requests[0].closedAt - startedAt < 2_000, "cut at the deadline, not the 10 s request timeout");
});

test("a model backend down without a Retry-After is answered with the default Retry-After, not 1 s", { timeout: 15_000 }, async (t) => {
  // A real 503 with no Retry-After header: openai-client.js records
  // retryAfterMs as null ("not said"), which must not read as 0 s.
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "overloaded" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  withEnv(t, {
    ...MODEL_ENV,
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    // The breaker off: the error under test is the backend's own 503.
    RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "0",
  });
  resetOpenAIProvider();
  t.after(() => resetOpenAIProvider());

  const error = await completeText("Say hello.").then(
    () => assert.fail("the model is down"),
    (rejection) => rejection
  );

  assert.ok(requests > 1, "retried before giving up");
  assert.equal(error.upstreamStatus, 503);
  assert.equal(error.retryAfterMs, null);

  const answer = describeAgentRequestFailure(error);

  assert.equal(answer.status, 503);
  assert.deepEqual(answer.headers, { "Retry-After": String(DEFAULT_OUTAGE_RETRY_AFTER_SECONDS) });
  assert.equal(answer.body.retryAfterSeconds, DEFAULT_OUTAGE_RETRY_AFTER_SECONDS);
  assert.equal(answer.body.causeCode, "HTTP_503");
  assert.equal(
    toDependencyOutageError(Object.assign(new Error("x"), { code: "CIRCUIT_OPEN", retryAfterMs: null }))
      .retryAfterSeconds,
    DEFAULT_OUTAGE_RETRY_AFTER_SECONDS
  );
});

test("a gateway call spends what is left of the deadline, and a cut call is MODEL_GATEWAY_TIMEOUT", { timeout: 15_000 }, async (t) => {
  const gateway = await startHangingServer(t);

  withEnv(t, {
    ...MODEL_ENV,
    ARCHIVE_RAG_ROLE: "agent",
    INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
    MODEL_GATEWAY_TIMEOUT_MS: undefined,
    MODEL_GATEWAY_URL: gateway.url,
    OPENAI_BASE_URL: undefined,
  });
  resetOpenAIProvider();
  resetModelGatewayClient();
  t.after(() => {
    resetOpenAIProvider();
    resetModelGatewayClient();
  });

  const startedAt = Date.now();

  await assert.rejects(
    runWithRequestDeadline({ deadlineAt: startedAt + 200 }, () => completeText("Say hello.")),
    (error) => {
      assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.timeout);
      assert.equal(error.status, 504);
      return true;
    }
  );

  const [call] = gateway.requests;

  await call.closed;
  assert.ok(
    Number(call.headers["x-archive-service-deadline-ms"]) <= 200,
    "the gateway got the request's remaining time, not MODEL_GATEWAY_TIMEOUT_MS"
  );
  assert.ok(call.closedAt - startedAt < 2_000);

  // A client that leaves aborts the call with its own reason.
  const cancellation = createRequestCancellation();
  const pending = runWithRequestCancellation(cancellation, () => completeText("Say hello again."));

  while (gateway.requests.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);
  await assert.rejects(pending, (error) => error instanceof RequestCancelledError && error.reason === "client_cancelled");
  await gateway.requests[1].closed;
});

test("a remote retrieval call is cut at the deadline as SERVICE_TIMEOUT, and a client that leaves aborts it", { timeout: 15_000 }, async (t) => {
  const retrieval = await startHangingServer(t);

  withEnv(t, {
    ARCHIVE_RAG_ROLE: "agent",
    INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
    RETRIEVAL_SERVICE_TIMEOUT_MS: undefined,
    RETRIEVAL_SERVICE_URL: retrieval.url,
  });
  resetServiceClients();
  t.after(() => resetServiceClients());

  const retrieve = () =>
    retrieveGlobalContextRemotely({
      accessScope: { authenticated: true, userId: "alice", workspaceId: "ws-a" },
      docIds: ["doc-1"],
      retrievalQueries: [{ id: "primary", primary: true, query: "leave days" }],
    });
  const startedAt = Date.now();

  await assert.rejects(
    runWithRequestDeadline({ deadlineAt: startedAt + 150 }, retrieve),
    (error) => error instanceof ServiceTimeoutError && error.code === "SERVICE_TIMEOUT"
  );
  await retrieval.requests[0].closed;
  assert.ok(Number(retrieval.requests[0].headers["x-archive-service-deadline-ms"]) <= 150);

  const cancellation = createRequestCancellation();
  const pending = runWithRequestCancellation(cancellation, retrieve);

  while (retrieval.requests.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);
  await assert.rejects(pending, (error) => error instanceof RequestCancelledError && error.reason === "client_cancelled");
  await retrieval.requests[1].closed;
});

test("a cross-encoder request is aborted by the request's signal before its own timeout", { timeout: 15_000 }, async (t) => {
  const reranker = await startHangingServer(t);

  withEnv(t, { RAG_CROSS_ENCODER_TIMEOUT_MS: "10000" });

  const startedAt = Date.now();

  await assert.rejects(
    runWithRequestDeadline({ deadlineAt: startedAt + 120 }, () =>
      requestCrossEncoderScores({ endpoint: `${reranker.url}/rerank`, queryText: "q", texts: ["a"] })
    ),
    (error) => error instanceof RequestCancelledError
  );
  await reranker.requests[0].closed;
  assert.ok(reranker.requests[0].closedAt - startedAt < 2_000);
});
