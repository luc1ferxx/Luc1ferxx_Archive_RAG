import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { getMetricsRegistry, METRICS_CONTENT_TYPE, setMetricsEnabled } from "./metrics.js";
import "./metrics-agent.js";
import { instrumentHttpServer } from "./metrics-http.js";
import { registerIngestQueueMetrics } from "./metrics-ingest.js";
import "./metrics-model.js";
import "./metrics-postgres.js";
import { startProcessMetrics, stopProcessMetrics } from "./metrics-process.js";
import "./metrics-retrieval.js";
import "./metrics-service-client.js";

// GET /metrics on a listener of its own, in every role (server.js for the
// monolith, rag/agent-service/role-server.js for the split roles):
//
//   METRICS_ENABLED  true to record and serve metrics (default false: every
//                    recording hook is a no-op and nothing listens)
//   METRICS_PORT     the listener's port (default 9464; 0 = OS-assigned, the
//                    start-up line names the port)
//   METRICS_HOST     the address it binds (default 127.0.0.1). In a container
//                    Prometheus usually scrapes from another network
//                    namespace: bind 0.0.0.0 there and set METRICS_TOKEN.
//   METRICS_TOKEN    when set, a scrape must send `Authorization: Bearer
//                    <token>`; otherwise it gets 401.
//
// Never on the public app port: the app answers /metrics like any unknown
// path. Series carry no role or instance label; the scrape configuration adds
// both as target labels (deploy/prometheus/prometheus.example.yml).
//
// Importing this module registers every metric family, so each serving
// process exposes the whole catalogue (families it never records stay empty).

export const DEFAULT_METRICS_PORT = 9464;
export const DEFAULT_METRICS_HOST = "127.0.0.1";
export const METRICS_PATH = "/metrics";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const parsePort = (value) => {
  const text = String(value ?? "").trim();

  if (!text) {
    return DEFAULT_METRICS_PORT;
  }

  const port = Number(text);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("METRICS_PORT must be an integer from 0 to 65535.");
  }

  return port;
};

/**
 * { enabled, host, port, token } from the METRICS_* variables. A bad port
 * throws, but only when metrics are on: with them off nothing is read.
 */
export const getMetricsServerConfig = (env = process.env) => {
  const enabled = String(env.METRICS_ENABLED ?? "").trim().toLowerCase() === "true";

  return {
    enabled,
    host: String(env.METRICS_HOST ?? "").trim() || DEFAULT_METRICS_HOST,
    port: enabled ? parsePort(env.METRICS_PORT) : null,
    token: String(env.METRICS_TOKEN ?? "").trim() || null,
  };
};

const digest = (value) => createHash("sha256").update(String(value)).digest();

/** Whether `authorization` carries `token` as a bearer token (constant time). */
export const isAuthorizedScrape = (authorization, token) => {
  if (!token) {
    return true;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(String(authorization ?? "").trim());

  return Boolean(match) && timingSafeEqual(digest(match[1].trim()), digest(token));
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
};

/** The request handler of the metrics listener, over `registry`. */
export const createMetricsRequestHandler = ({ registry = getMetricsRegistry(), token = null } = {}) =>
  async (req, res) => {
    const path = String(req.url ?? "").split("?")[0];

    if (path !== METRICS_PATH) {
      send(res, 404, "Not found.\n");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "Method not allowed.\n", { allow: "GET, HEAD" });
      return;
    }

    if (!isAuthorizedScrape(req.headers.authorization, token)) {
      send(res, 401, "Unauthorized.\n", { "www-authenticate": 'Bearer realm="metrics"' });
      return;
    }

    let body;

    try {
      body = await registry.expose();
    } catch (error) {
      // Name only: nothing about the request or the process's data.
      console.error(`[metrics] exposition failed (${error?.name ?? "Error"}).`);
      send(res, 500, "Metrics collection failed.\n");
      return;
    }

    res.writeHead(200, { "cache-control": "no-store", "content-type": METRICS_CONTENT_TYPE });
    res.end(req.method === "HEAD" ? undefined : body);
  };

/**
 * Listens for scrapes on host:port and resolves { server, host, port, close }
 * once listening (port 0 resolves to the port the OS assigned). Rejects when
 * the port cannot be bound.
 */
export const startMetricsServer = ({
  host = DEFAULT_METRICS_HOST,
  port = DEFAULT_METRICS_PORT,
  registry = getMetricsRegistry(),
  token = null,
} = {}) =>
  new Promise((resolve, reject) => {
    const server = http.createServer(createMetricsRequestHandler({ registry, token }));

    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);

      const address = server.address();

      resolve({
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
        host,
        port: typeof address === "object" && address ? address.port : port,
        server,
      });
    });
  });

/**
 * What server.js and role-server.js call once their app listens. With
 * METRICS_ENABLED unset it returns null and changes nothing. Otherwise it
 * turns recording on, records `httpServer`'s requests, reports
 * `ingestJobStore`'s queue (pass it only where the queue is hosted), samples
 * the event loop, and serves /metrics. Resolves { close, host, port, server };
 * a port that cannot be bound rejects, so an operator who asked for metrics
 * learns at start-up that there are none.
 */
export const startMetricsFromEnv = async ({
  env = process.env,
  httpServer = null,
  ingestJobStore = null,
  logger = console,
} = {}) => {
  const config = getMetricsServerConfig(env);

  if (!config.enabled) {
    return null;
  }

  setMetricsEnabled(true);
  startProcessMetrics();

  const stopHttp = instrumentHttpServer(httpServer);

  if (ingestJobStore) {
    registerIngestQueueMetrics(ingestJobStore);
  }

  let listener;

  try {
    listener = await startMetricsServer({ host: config.host, port: config.port, token: config.token });
  } catch (error) {
    stopHttp();
    stopProcessMetrics();
    throw new Error(
      `Metrics listener could not bind ${config.host}:${config.port} (${error?.code ?? error?.name ?? "error"}); set METRICS_PORT to a free port, or 0.`
    );
  }

  logger.log(
    `[metrics] serving ${METRICS_PATH} on http://${listener.host.includes(":") ? `[${listener.host}]` : listener.host}:${listener.port}${config.token ? " (bearer token required)" : ""}`
  );

  if (!LOOPBACK_HOSTS.has(config.host) && !config.token) {
    logger.warn(
      "[metrics] METRICS_HOST is not a loopback address and METRICS_TOKEN is unset: anyone who can reach that port can read /metrics."
    );
  }

  return {
    close: async () => {
      stopHttp();
      stopProcessMetrics();
      await listener.close();
    },
    host: listener.host,
    port: listener.port,
    server: listener.server,
  };
};
