import { createApp } from "../../app.js";
import { isStandaloneProfileEnabled } from "../../standalone-profile.js";
import {
  getModelGatewayPort,
  getServiceShutdownGraceMs,
  getVectorStoreProviderConfigStatus,
  isPostgresDatabaseConfigured,
  isRagIngestAsync,
  isRagIngestWorkerEnabled,
  isStartupHealthStrict,
} from "../config.js";
import { createIngestWorker, resolveApiIngestWorkerPlan } from "../ingest-worker.js";
import { startMetricsFromEnv } from "../metrics-server.js";
import { resetPostgresPool } from "../postgres.js";
import { resetSharedState } from "../shared-state.js";
import { validateServiceTopology } from "../service-topology.js";

import { createAgentApp } from "./app.js";

// Start-up for every ARCHIVE_RAG_ROLE except `all` (server.js keeps the
// monolith's start-up unchanged). One image, one entry point: `node server.js`
// with the role in the environment.
//
//   api            the public edge: createApp() forwards agent work to
//                  AGENT_SERVICE_URL and keeps uploads, documents, ingest jobs
//                  and admin; it drains the ingest queue as the monolith does.
//   agent          createAgentApp(): agent routes behind internal identity,
//                  startup recovery, background tasks.
//   retrieval      createRetrievalApp() from rag/retrieval-service/app.js,
//                  after the checks retrieval-service.mjs runs first.
//   model-gateway  createModelGatewayApp() from rag/model-gateway/app.js.
//
// The topology is validated first and any error refuses the start, so a typo
// never silently turns a split deployment into something else. On SIGTERM or
// SIGINT the server stops accepting connections, gives in-flight requests
// SERVICE_SHUTDOWN_GRACE_MS to finish while its workers stop, closes what is
// left, and exits. An app may expose an async app.locals.stop(), which runs
// after the drain.

// What `node retrieval-service.mjs` refuses is refused here too, so starting
// the tier through server.js is no looser than its own entry point: without
// PostgreSQL (or under the standalone profile) its document registry, and with
// VECTOR_STORE_PROVIDER=local its index, would be this process's own copy, and
// documents uploaded at the edge would stay invisible to every search. Its
// start-up health report is logged, and stops the start under
// STARTUP_HEALTH_STRICT=true.
const preflightRetrievalRole = async ({ logger, module }) => {
  if (isStandaloneProfileEnabled() || !isPostgresDatabaseConfigured()) {
    throw new Error(
      "Role retrieval cannot start: it needs PostgreSQL (POSTGRES_DATABASE_URL), or documents uploaded through the API would stay invisible to its searches."
    );
  }

  if (getVectorStoreProviderConfigStatus().provider === "local") {
    throw new Error(
      "Role retrieval cannot start: VECTOR_STORE_PROVIDER=local keeps the index in each process, so this one would search a stale copy; use pgvector or qdrant."
    );
  }

  if (typeof module.buildRetrievalHealthReport !== "function") {
    return;
  }

  const report = await module.buildRetrievalHealthReport({ env: process.env });
  const summary = Object.entries(report?.checks ?? {})
    .map(([name, entry]) => `${name}=${entry?.status}`)
    .join(" ");

  if (report?.status === "ok") {
    logger.log(`[service] retrieval: startup health ok: ${summary}`);
    return;
  }

  logger.warn(`[service] retrieval: startup health error: ${summary}`);

  if (isStartupHealthStrict()) {
    throw new Error(`Role retrieval cannot start: its startup health check failed (${summary}).`);
  }
};

const ROLE_APP_MODULES = Object.freeze({
  "model-gateway": {
    exportName: "createModelGatewayApp",
    load: () => import("../model-gateway/app.js"),
    modulePath: "rag/model-gateway/app.js",
  },
  retrieval: {
    exportName: "createRetrievalApp",
    load: () => import("../retrieval-service/app.js"),
    modulePath: "rag/retrieval-service/app.js",
    preflight: preflightRetrievalRole,
  },
});

const isMissingModule = (error, modulePath) =>
  error?.code === "ERR_MODULE_NOT_FOUND" &&
  String(error?.message ?? "").includes(modulePath.replace(/^rag\//u, ""));

/**
 * Loads a tier app that lives in its own module, imported only when that role
 * starts so a monolith never depends on it. `loaders` replaces the imports in
 * tests.
 */
const loadTierApp = async (role, { appOptions, loaders = {}, logger = console }) => {
  const entry = ROLE_APP_MODULES[role];
  let module;

  try {
    module = await (loaders[role] ?? entry.load)();
  } catch (error) {
    if (isMissingModule(error, entry.modulePath)) {
      throw new Error(`Role ${role} is not available in this build (${entry.modulePath} is missing).`);
    }

    throw error;
  }

  if (typeof module?.[entry.exportName] !== "function") {
    throw new Error(`${entry.modulePath} does not export ${entry.exportName}().`);
  }

  await entry.preflight?.({ logger, module });

  return module[entry.exportName](appOptions);
};

// The ingest queue is drained where uploads are accepted, exactly as
// server.js does for the monolith (RAG_INGEST_MODE=async, unless
// RAG_INGEST_WORKER_ENABLED=false hands it to `npm run worker:ingest`).
const startEdgeIngestWorker = ({ app, logger }) => {
  const plan = resolveApiIngestWorkerPlan({
    storeBackend: app.locals.services.ingestJobStore?.backend,
    vectorStoreProvider: getVectorStoreProviderConfigStatus().provider,
    workerEnabled: isRagIngestWorkerEnabled(),
  });

  plan.errors.forEach((line) => logger.error(line));
  plan.warnings.forEach((line) => logger.warn(line));

  if (!plan.start) {
    return null;
  }

  const worker = createIngestWorker({
    ragService: app.locals.services.ragService,
    store: app.locals.services.ingestJobStore,
    tempDirectory: app.locals.services.uploadsDirectory,
  });

  worker.start();
  logger.log(
    `[ingest-worker] ${worker.workerId} is draining the ingest queue (woken on enqueue, polling every ${worker.pollIntervalMs} ms).`
  );

  return worker;
};

// The port each role listens on when the caller names none: PORT for the edge
// and the agent tier (5001, as the monolith), and the defaults of the tiers'
// own entry points (retrieval-service.mjs, model-gateway.mjs) for the others,
// so both ways of starting a tier bind the same port.
export const resolveRolePort = (role, env = process.env) => {
  const port = Number.parseInt(String(env.PORT ?? "").trim(), 10);
  const explicit = Number.isInteger(port) && port >= 0 ? port : null;

  switch (role) {
    case "model-gateway":
      return getModelGatewayPort();
    case "retrieval":
      return explicit ?? 5002;
    default:
      return explicit ?? 5001;
  }
};

/**
 * Builds the app for one role and what must stop with it:
 * { app, stoppers, finalizers }. Stoppers run alongside the drain (workers);
 * finalizers run after it, before the database pool closes.
 */
export const createRoleApp = async ({ appOptions = {}, loaders, logger = console, role }) => {
  switch (role) {
    case "api": {
      const app = await createApp(appOptions);
      const worker = startEdgeIngestWorker({ app, logger });

      return { app, finalizers: [], stoppers: worker ? [() => worker.stop()] : [] };
    }
    case "agent":
      return { app: await createAgentApp(appOptions), finalizers: [], stoppers: [] };
    case "retrieval":
      return {
        app: await loadTierApp(role, { appOptions, loaders, logger }),
        finalizers: [],
        stoppers: [],
      };
    case "model-gateway": {
      const app = await loadTierApp(role, { appOptions, loaders, logger });

      // What model-gateway.mjs does on shutdown: close the upstream pools and
      // the shared-state connection.
      return {
        app,
        finalizers: [async () => app.locals?.modelGateway?.close?.(), resetSharedState],
        stoppers: [],
      };
    }
    default:
      throw new TypeError(
        role === "all"
          ? "Role all is the monolith; server.js starts it."
          : `Unknown service role "${role}".`
      );
  }
};

const IDLE_SWEEP_INTERVAL_MS = 50;

const listen = (app, { host, port }) =>
  new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });

    server.once("error", reject);
  });

/**
 * Graceful shutdown for one server: stop accepting, let in-flight requests
 * finish within `graceMs` (then close the connections still open), stop the
 * workers alongside, run the finalizers in order, and exit(0).
 * Idempotent: a second signal waits for the first shutdown.
 */
export const createGracefulShutdown = ({
  exit = (code) => process.exit(code),
  finalizers = [resetPostgresPool],
  graceMs = getServiceShutdownGraceMs(),
  logger = console,
  role,
  server,
  stoppers = [],
}) => {
  let stopping = null;

  const runQuietly = async (step, label) => {
    try {
      await step();
    } catch (error) {
      logger.error(`[service] ${role}: ${label} failed during shutdown (${error?.name ?? "Error"}).`);
    }
  };

  const drain = async () => {
    const closed = new Promise((resolve) => server.close(() => resolve("drained")));
    let timer = null;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve("expired"), graceMs);
      timer.unref?.();
    });

    // Idle keep-alive connections would otherwise hold close() open until the
    // client's keep-alive timer ran out; a connection whose request finishes
    // during the drain turns idle later, so this repeats until close() settles.
    server.closeIdleConnections?.();
    const sweeper = setInterval(() => server.closeIdleConnections?.(), IDLE_SWEEP_INTERVAL_MS);
    sweeper.unref?.();

    const outcome = await Promise.race([closed, expired]);
    clearTimeout(timer);
    clearInterval(sweeper);

    if (outcome === "expired") {
      logger.warn(
        `[service] ${role}: requests still running after ${graceMs} ms; closing their connections.`
      );
      server.closeAllConnections?.();
      await closed;
    }
  };

  return (signal = "shutdown") => {
    stopping ??= (async () => {
      logger.log(`[service] ${role}: ${signal}; no new connections, draining in-flight requests.`);
      await Promise.all([
        drain(),
        ...stoppers.map((stop) => runQuietly(stop, "a worker")),
      ]);

      for (const finalize of finalizers) {
        await runQuietly(finalize, "a finalizer");
      }

      logger.log(`[service] ${role}: stopped.`);
      exit(0);
    })();

    return stopping;
  };
};

/**
 * Starts one split-deployment role and returns { app, server, port, shutdown,
 * metrics } (metrics: the /metrics listener's { host, port, close }, or null
 * without METRICS_ENABLED).
 * Throws before listening when the topology has errors (the messages are the
 * validator's, secret-free). Without `port` it listens on resolveRolePort().
 * `shutdownFinalizers` run after the role's own finalizers, once the requests
 * have drained and before the database pool closes (server.js flushes its
 * spans there). `handleSignals: false`, `exit`, `loaders` and `appOptions` are
 * for tests.
 */
export const startServiceRole = async ({
  appOptions = {},
  env = process.env,
  exit,
  graceMs,
  handleSignals = true,
  host,
  loaders,
  logger = console,
  port,
  role,
  shutdownFinalizers = [],
  signals = process,
}) => {
  const { errors, warnings } = validateServiceTopology(env);

  if (errors.length > 0) {
    throw new Error(`Role ${role} cannot start: ${errors.join(" ")}`);
  }

  warnings.forEach((line) => logger.warn(`[service] ${line}`));

  const { app, finalizers, stoppers } = await createRoleApp({ appOptions, loaders, logger, role });
  const server = await listen(app, { host, port: port ?? resolveRolePort(role, env) });
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  // METRICS_ENABLED=true: /metrics on its own listener, in every role. Only
  // the edge drains the ingest queue, so only it reports the queue's depth.
  // A metrics port that cannot be bound refuses the start.
  const metrics = await startMetricsFromEnv({
    env,
    httpServer: server,
    ingestJobStore: role === "api" && isRagIngestAsync() ? app.locals.services?.ingestJobStore : null,
    logger,
  }).catch((error) => {
    server.close();
    throw error;
  });
  // app.locals.stop runs once the requests have drained, before the pool
  // closes, so nothing in flight loses what it depends on.
  const appStop = typeof app.locals?.stop === "function" ? [() => app.locals.stop()] : [];
  const metricsStop = metrics ? [() => metrics.close()] : [];
  const shutdown = createGracefulShutdown({
    exit,
    finalizers: [...appStop, ...finalizers, ...shutdownFinalizers, ...metricsStop, resetPostgresPool],
    graceMs,
    logger,
    role,
    server,
    stoppers,
  });

  if (handleSignals) {
    signals.once("SIGTERM", () => void shutdown("SIGTERM"));
    signals.once("SIGINT", () => void shutdown("SIGINT"));
  }

  logger.log(`[service] role ${role} is running on port ${listeningPort}.`);

  return { app, metrics, port: listeningPort, server, shutdown };
};
