import { getMetricsRegistry, isMetricsEnabled, secondsSince } from "./metrics.js";

// HTTP rate, errors and duration for every role, recorded at the HTTP server
// rather than inside an app: server.js and role-server.js hand their listening
// server to instrumentHttpServer, whose listener is prepended so it sees each
// request before the Express app does and needs no middleware in any app.
//
// The route label is the Express route template that answered (`/chat`,
// `/agent-runs/:runId`), read when the response ends. A request no route
// answered -- a rate limiter's 429 or an auth 401 ahead of the routers, a 404,
// a static file -- is labelled with its path only when that path is one of
// KNOWN_UNROUTED_PATHS, and `unmatched` otherwise, so a raw path or an id
// never becomes a label value.
//
// status_class is 1xx..5xx, with 429 apart (the /chat availability SLI
// excludes it) and `aborted` for a response the client left before it ended.

export const HTTP_DURATION_BUCKETS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120,
]);

const KNOWN_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

// Paths a request can reach before any route matched it (rate limiting and
// authentication run ahead of the routers). Only exact, parameter-free paths.
export const KNOWN_UNROUTED_PATHS = Object.freeze(
  new Set([
    "/chat",
    "/chat/stream",
    "/documents",
    "/documents/clear",
    "/health",
    "/livez",
    "/ready",
    "/upload",
    "/upload/complete",
  ])
);

const MAX_ROUTE_LENGTH = 120;

const registry = getMetricsRegistry();

const requests = registry.counter({
  help: "HTTP requests answered by this process, by method, Express route template and status class (429 and aborted apart).",
  labelNames: ["method", "route", "status_class"],
  name: "archive_rag_http_requests_total",
});
const duration = registry.histogram({
  buckets: HTTP_DURATION_BUCKETS,
  help: "Time from the request's arrival to the end of its response (a stream counts until it ends), in seconds.",
  labelNames: ["method", "route", "status_class"],
  name: "archive_rag_http_request_duration_seconds",
});
const inFlight = registry.gauge({
  help: "HTTP requests this process has received and not yet answered.",
  name: "archive_rag_http_requests_in_flight",
});

export const toStatusClass = (statusCode) => {
  const code = Number(statusCode);

  if (code === 429) {
    return "429";
  }

  return Number.isInteger(code) && code >= 100 && code < 600 ? `${Math.floor(code / 100)}xx` : "other";
};

export const toMethodLabel = (method) => {
  const upper = String(method ?? "").toUpperCase();

  return KNOWN_METHODS.has(upper) ? upper : "OTHER";
};

/** The route label of a finished request; never a raw path outside KNOWN_UNROUTED_PATHS. */
export const resolveRouteLabel = (req) => {
  const template = req?.route?.path;

  if (typeof template === "string" && template) {
    const route = `${typeof req.baseUrl === "string" ? req.baseUrl : ""}${template}`;

    return route.length > MAX_ROUTE_LENGTH ? route.slice(0, MAX_ROUTE_LENGTH) : route;
  }

  if (template !== undefined && template !== null) {
    // A RegExp or array route: its source would be a label nobody can query.
    return "pattern";
  }

  const path = String(req?.originalUrl ?? req?.url ?? "").split("?")[0];

  return KNOWN_UNROUTED_PATHS.has(path) ? path : "unmatched";
};

/**
 * The `request` listener: counts the request in flight and records it once
 * its response ends (`finish`) or its connection closes first (`aborted`).
 * It runs outside the app's error handling, so it never lets an error out.
 */
export const observeHttpRequest = (req, res) => {
  if (!isMetricsEnabled()) {
    return;
  }

  const startedAt = performance.now();
  let settled = false;
  const settle = (aborted) => {
    if (settled) {
      return;
    }

    settled = true;

    try {
      inFlight.dec();

      const labels = {
        method: toMethodLabel(req.method),
        route: resolveRouteLabel(req),
        status_class: aborted ? "aborted" : toStatusClass(res.statusCode),
      };

      requests.inc(labels);
      duration.observe(labels, secondsSince(startedAt));
    } catch {
      // A metric is never worth a failed request.
    }
  };

  inFlight.inc();
  res.once("finish", () => settle(false));
  res.once("close", () => settle(!res.writableFinished));
};

/**
 * Records every request `server` receives from now on. Returns a function
 * that stops recording. A no-op while metrics are off.
 */
export const instrumentHttpServer = (server) => {
  if (!isMetricsEnabled() || typeof server?.prependListener !== "function") {
    return () => {};
  }

  server.prependListener("request", observeHttpRequest);
  return () => server.off("request", observeHttpRequest);
};
