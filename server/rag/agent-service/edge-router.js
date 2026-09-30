import { Router } from "express";

import { getRequestAccessScope } from "../../auth.js";
import { validateChatRequest } from "../../routes/chat.js";
import {
  agentTaskBodySchema,
  runActionSchema,
  runIdSchema,
  runStepRetrySchema,
  taskActionSchema,
  taskIdSchema,
  triggerIdSchema,
} from "../../routes/tasks.js";
import { parseOrRespond } from "../../routes/validation.js";
import { getAdminActionPermissionForRequest } from "../admin-authorization.js";
import { getAgentServiceTimeoutMs } from "../config.js";
import { getServiceClient, ServiceUnavailableError } from "../service-client.js";
import {
  SERVICE_IDENTITY_ERROR_CODES,
  ServiceIdentityError,
} from "../service-identity.js";
import { SERVICE_TIERS } from "../service-topology.js";
import { markSpanFailed, setSpanAttributes, SPAN_KINDS, withSpan } from "../tracing.js";

import { ADMIN_PERMISSION_CLAIM, AGENT_EDGE_ERROR_CODES } from "./contract.js";

// The public edge's half of a split deployment: every route that runs the agent
// or a model (chat, chat/stream, tasks, triggers, agent runs and their actions)
// is validated here exactly as the monolith validates it, then forwarded to the
// agent tier (AGENT_SERVICE_URL) with a signed internal identity carrying the
// access scope requireApiAuth resolved for the caller. The agent tier never
// sees the public credential, and nothing the client sends can name another
// tenant: the scope travels only inside the token.
//
// What crosses the hop:
//   - request: method, path and query, the JSON body the edge already parsed
//     (so the edge's 2 MB limit applies), and a short allowlist of headers.
//     Hop-by-hop and x-archive-service-* headers never do.
//   - answer: status and body unchanged, plus an allowlist of headers; CORS
//     and security headers stay the edge's own.
//   - failures: an agent tier that cannot be reached answers 503 (504 when
//     the budget ran out) with a stable code from service-client.js, while
//     the routes that stay at the edge keep working. Only idempotent requests
//     are retried on another replica; a /chat is never run twice.
//   - /chat/stream: events are relayed as they arrive (framed at event
//     boundaries, so a broken upstream never delivers half an event). A client
//     that disconnects aborts the upstream request; an upstream that stops
//     early ends the client's stream with an error event and done.

const REQUEST_HEADERS_FORWARDED = Object.freeze([
  "accept",
  "accept-language",
  // buildTriggerDispatchRequest reads both as the dispatch idempotency key.
  "x-idempotency-key",
  "x-request-id",
]);
const RESPONSE_HEADERS_FORWARDED = Object.freeze([
  "cache-control",
  "content-disposition",
  "content-language",
  "content-type",
  "etag",
  "last-modified",
  "location",
  "retry-after",
]);
const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const INTERNAL_IDENTITY_CODES = new Set(Object.values(SERVICE_IDENTITY_ERROR_CODES));
const EVENT_BOUNDARY = Buffer.from("\n\n");
const DONE_EVENT_PATTERN = /(?:^|\n)event: done\n/u;
// An upstream event larger than this without a boundary is relayed as it is
// rather than held in memory; the agent's largest event (the result) is far
// smaller.
const MAX_PENDING_EVENT_BYTES = 16 * 1024 * 1024;

const validateParams = (schema) => (req, res) => parseOrRespond(schema, req.params, res);

/**
 * Every route the agent tier serves, with the check the edge runs before
 * forwarding it. It mirrors routes/chat.js and routes/tasks.js; a test fails
 * when either gains a route this table does not forward. `idempotent: false`
 * marks a GET that is not a read: GET /chat runs the agent (a run record,
 * session and long-term memory writes), so it is never sent to a second
 * replica, whatever the first one answered.
 */
export const AGENT_EDGE_ROUTES = Object.freeze([
  { idempotent: false, method: "get", path: "/chat", validate: validateChatRequest },
  { method: "post", path: "/chat", validate: validateChatRequest },
  { method: "post", path: "/chat/stream", stream: true, validate: validateChatRequest },
  { method: "get", path: "/tasks" },
  { method: "get", path: "/tasks/:taskId", validate: validateParams(taskIdSchema) },
  {
    method: "post",
    path: "/tasks/:taskId/actions/:action",
    validate: validateParams(taskActionSchema),
  },
  {
    method: "post",
    path: "/agent-tasks",
    validate: (req, res) => parseOrRespond(agentTaskBodySchema, req.body ?? {}, res),
  },
  { method: "get", path: "/agent-triggers" },
  {
    method: "post",
    path: "/agent-triggers/:triggerId/dispatch",
    validate: validateParams(triggerIdSchema),
  },
  { method: "get", path: "/agent-runs" },
  { method: "get", path: "/agent-runs/recovery" },
  { method: "get", path: "/agent-runs/:runId", validate: validateParams(runIdSchema) },
  {
    method: "post",
    path: "/agent-runs/:runId/recovery/actions/:action",
    validate: validateParams(runActionSchema),
  },
  {
    method: "post",
    path: "/agent-runs/:runId/actions/:action",
    validate: validateParams(runActionSchema),
  },
  {
    method: "post",
    path: "/agent-runs/:runId/steps/:stepId/actions/retry",
    validate: validateParams(runStepRetrySchema),
  },
  { method: "get", path: "/capabilities" },
]);

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const pickRequestHeaders = (req) => {
  const headers = {};

  for (const name of REQUEST_HEADERS_FORWARDED) {
    const value = req.get(name);

    if (value !== undefined && value !== "") {
      headers[name] = value;
    }
  }

  return headers;
};

const readForwardBody = (req) =>
  METHODS_WITHOUT_BODY.has(req.method) || req.body === undefined ? undefined : req.body;

// Node accepts a raw backslash in the request target (GET /chat?question=C:\x),
// which fetch would turn into a slash in the path and service-client.js
// refuses; percent-encoded it reaches the agent's routes and query parser as
// the same backslash the monolith reads.
const toForwardPath = (originalUrl) => String(originalUrl ?? "").replace(/\\/gu, "%5C");

// service-client.js refuses such a path with a TypeError; answering 400 here
// keeps that refusal the client's, not a forwarding failure.
const isForwardablePath = (path) =>
  typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !/[\s\\]/u.test(path);

const clientDisconnected = () =>
  new DOMException("The public client disconnected.", "AbortError");

const isIdentityRejection = ({ json, status }) =>
  [401, 403, 500].includes(status) && INTERNAL_IDENTITY_CODES.has(json?.code);

const createResponder = ({ logger }) => {
  const sendIdentityRejected = (res, code) => {
    // The public caller authenticated fine; the tiers disagree about keys.
    logger.error(`[agent-edge] The agent service refused this service's identity (${code}).`);

    return res.status(502).json({
      code: AGENT_EDGE_ERROR_CODES.identityRejected,
      error: "The agent service did not accept this service's identity.",
      service: SERVICE_TIERS.agent,
    });
  };

  const sendAnswer = (res, answer) => {
    if (isIdentityRejection(answer)) {
      return sendIdentityRejected(res, answer.json.code);
    }

    for (const name of RESPONSE_HEADERS_FORWARDED) {
      const value = answer.headers?.[name];

      if (value !== undefined && value !== null) {
        res.setHeader(name, value);
      }
    }

    res.status(answer.status);

    if (NULL_BODY_STATUSES.has(answer.status)) {
      return res.end();
    }

    return res.send(answer.text ?? "");
  };

  const sendForwardError = (res, error) => {
    if (res.headersSent) {
      return res.end();
    }

    if (error instanceof ServiceUnavailableError) {
      // Every replica tried answered 502/503/504 itself with a JSON body: that
      // is the agent tier's own answer (a model circuit that is open, an admin
      // action that is unavailable), passed through unchanged.
      if (error.remoteStatus && isPlainObject(error.remoteBody)) {
        return res.status(error.remoteStatus).json(error.remoteBody);
      }

      logger.warn(
        `[agent-edge] ${error.code} after ${error.attempts} attempt(s)${
          error.causeCode ? ` (${error.causeCode})` : ""
        }.`
      );

      return res.status(error.status).json(error.toResponseBody());
    }

    if (error instanceof ServiceIdentityError) {
      logger.error(`[agent-edge] Cannot sign the internal identity (${error.code}).`);

      return res.status(500).json({
        code: error.code,
        error: "Internal service identity is not configured.",
      });
    }

    logger.error(
      `[agent-edge] Forwarding failed (${error?.name ?? "Error"}${error?.code ? ` ${error.code}` : ""}).`
    );

    return res.status(502).json({
      code: AGENT_EDGE_ERROR_CODES.forwardFailed,
      error: "The request could not be forwarded to the agent service.",
      service: SERVICE_TIERS.agent,
    });
  };

  return { sendAnswer, sendForwardError };
};

const spanAttributes = (req, route) => ({
  "archive_rag.service.target": SERVICE_TIERS.agent,
  "http.request.method": req.method,
  "url.template": route,
});

// Resolves once the response can take more bytes or is gone. A response that
// is already gone emits neither event again, so it resolves at once.
const waitForDrain = (res) =>
  new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) {
      resolve();
      return;
    }

    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };

    res.on("drain", done);
    res.on("close", done);
  });

const toBuffer = (chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

const writeEvent = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

/**
 * Relays an upstream event stream to the public client, event by event. On an
 * upstream failure before its done event the client gets an error event (the
 * shape routes/chat.js sends, plus a code) and done, so a client waiting for
 * done never hangs.
 */
const relayEventStream = async ({ isClientClosed, res, span, upstream }) => {
  res.status(upstream.status);
  res.set({
    "Cache-Control": upstream.headers.get("cache-control") ?? "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": upstream.headers.get("content-type"),
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const reader = upstream.body.getReader();
  let pending = null;
  let sawDone = false;
  const flush = async (chunk) => {
    // The client left while this relay waited for a drain (or between reads,
    // with an event already buffered): writing would return false forever and
    // the wait would never end, so the upstream is cancelled instead.
    if (isClientClosed() || res.destroyed) {
      throw clientDisconnected();
    }

    if (DONE_EVENT_PATTERN.test(chunk.toString("utf8"))) {
      sawDone = true;
    }

    if (!res.write(chunk)) {
      await waitForDrain(res);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      pending = pending ? Buffer.concat([pending, toBuffer(value)]) : toBuffer(value);
      const boundary = pending.lastIndexOf(EVENT_BOUNDARY);

      if (boundary === -1) {
        if (pending.length > MAX_PENDING_EVENT_BYTES) {
          const oversized = pending;
          pending = null;
          await flush(oversized);
        }

        continue;
      }

      const end = boundary + EVENT_BOUNDARY.length;
      const complete = pending.subarray(0, end);
      pending = end < pending.length ? pending.subarray(end) : null;
      await flush(complete);
    }

    // A clean end: whatever is left is the upstream's own last bytes.
    if (pending) {
      await flush(pending);
    }

    res.end();
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Already errored or cancelled.
    }

    if (isClientClosed() || res.destroyed) {
      return;
    }

    const timedOut = error?.name === "TimeoutError";
    const code = timedOut
      ? "SERVICE_TIMEOUT"
      : AGENT_EDGE_ERROR_CODES.streamInterrupted;
    markSpanFailed(span, code);

    if (!sawDone) {
      writeEvent(res, "error", {
        code,
        error: timedOut
          ? "The agent service did not finish within the time allowed."
          : "The agent service stopped before the answer was complete.",
        status: timedOut ? 504 : 502,
      });
      writeEvent(res, "done", {});
    }

    res.end();
  }
};

/**
 * The edge's agent routes. Returns { router, forwardAdminAction }:
 *   router              every route in AGENT_EDGE_ROUTES, mounted where the
 *                       monolith mounts routes/tasks.js and routes/chat.js;
 *   forwardAdminAction  the POST /admin/actions/:action handler for
 *                       createAdminRouter, run after the edge's permission
 *                       check, which it hands on as a signed claim.
 * `client` defaults to the process-wide agent client (service-client.js);
 * `timeoutMs` bounds one forwarded answer and `streamDeadlineMs` one forwarded
 * stream (AGENT_SERVICE_TIMEOUT_MS for both).
 */
export const createAgentEdgeRouter = ({
  client = getServiceClient(SERVICE_TIERS.agent),
  logger = console,
  streamDeadlineMs = getAgentServiceTimeoutMs(),
  timeoutMs = getAgentServiceTimeoutMs(),
} = {}) => {
  const router = Router();
  const { sendAnswer, sendForwardError } = createResponder({ logger });

  // Watches for the public client going away before the answer is complete,
  // and aborts the upstream request when it does.
  const watchClient = (res) => {
    const controller = new AbortController();
    let closed = false;
    const onClose = () => {
      if (!res.writableFinished) {
        closed = true;
        controller.abort(clientDisconnected());
      }
    };

    res.on("close", onClose);

    return {
      isClosed: () => closed,
      release: () => res.off("close", onClose),
      signal: controller.signal,
    };
  };

  const forward = async (req, res, { claims, idempotent, route }) => {
    const path = toForwardPath(req.originalUrl);

    if (!isForwardablePath(path)) {
      return res.status(400).json({ error: "Invalid request path." });
    }

    const watcher = watchClient(res);

    try {
      await withSpan(
        `${req.method} ${route}`,
        spanAttributes(req, route),
        async (span) => {
          let answer;

          try {
            answer = await client.request({
              accessScope: getRequestAccessScope(req),
              body: readForwardBody(req),
              claims,
              headers: pickRequestHeaders(req),
              idempotent,
              method: req.method,
              path,
              signal: watcher.signal,
              timeoutMs,
            });
          } catch (error) {
            if (watcher.isClosed()) {
              return;
            }

            markSpanFailed(span, error?.code ?? error?.name);
            sendForwardError(res, error);
            return;
          }

          setSpanAttributes(span, { "http.response.status_code": answer.status });

          if (!watcher.isClosed()) {
            sendAnswer(res, answer);
          }
        },
        { kind: SPAN_KINDS.client }
      );
    } finally {
      watcher.release();
    }
  };

  const forwardStream = async (req, res, { route }) => {
    const path = toForwardPath(req.originalUrl);

    if (!isForwardablePath(path)) {
      return res.status(400).json({ error: "Invalid request path." });
    }

    const watcher = watchClient(res);

    try {
      await withSpan(
        `${req.method} ${route}`,
        spanAttributes(req, route),
        async (span) => {
          let upstream;

          try {
            // timeoutMs is left to the client default: it bounds only the wait
            // for headers, which the agent sends before the run starts.
            upstream = await client.stream({
              accessScope: getRequestAccessScope(req),
              body: readForwardBody(req),
              deadlineMs: streamDeadlineMs,
              headers: { ...pickRequestHeaders(req), accept: "text/event-stream" },
              method: req.method,
              path,
              signal: watcher.signal,
            });
          } catch (error) {
            if (!watcher.isClosed()) {
              markSpanFailed(span, error?.code ?? error?.name);
              sendForwardError(res, error);
            }

            return;
          }

          setSpanAttributes(span, { "http.response.status_code": upstream.status });

          if (!/^text\/event-stream/iu.test(upstream.headers.get("content-type") ?? "")) {
            // Refused before the stream began (identity, validation): relay it
            // as an ordinary answer.
            let text;

            try {
              text = await upstream.text();
            } catch (error) {
              if (!watcher.isClosed()) {
                sendForwardError(res, error);
              }

              return;
            }

            if (!watcher.isClosed()) {
              sendAnswer(res, {
                headers: Object.fromEntries(upstream.headers.entries()),
                json: parseJson(text),
                status: upstream.status,
                text,
              });
            }

            return;
          }

          if (watcher.isClosed()) {
            await upstream.body?.cancel().catch(() => {});
            return;
          }

          await relayEventStream({
            isClientClosed: watcher.isClosed,
            res,
            span,
            upstream,
          });
        },
        { kind: SPAN_KINDS.client }
      );
    } finally {
      watcher.release();
    }
  };

  for (const route of AGENT_EDGE_ROUTES) {
    router[route.method](route.path, async (req, res) => {
      if (route.validate && !route.validate(req, res)) {
        return;
      }

      return route.stream
        ? forwardStream(req, res, { route: route.path })
        : forward(req, res, { idempotent: route.idempotent, route: route.path });
    });
  }

  const forwardAdminAction = (req, res) =>
    forward(req, res, {
      claims: {
        [ADMIN_PERMISSION_CLAIM]: String(getAdminActionPermissionForRequest(req) ?? ""),
      },
      route: "/admin/actions/:action",
    });

  return { forwardAdminAction, router };
};
