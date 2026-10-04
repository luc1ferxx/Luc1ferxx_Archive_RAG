import "dotenv/config";

import { createApp } from "./app.js";
import {
  getServiceShutdownGraceMs,
  getVectorStoreProviderConfigStatus,
  isRagIngestAsync,
  isRagIngestWorkerEnabled,
} from "./rag/config.js";
import { createIngestWorker, resolveApiIngestWorkerPlan } from "./rag/ingest-worker.js";
import { startMetricsFromEnv } from "./rag/metrics-server.js";
import { resetPostgresPool } from "./rag/postgres.js";
import {
  DEFAULT_SERVICE_ROLE,
  getServiceRole,
  validateServiceTopology,
} from "./rag/service-topology.js";
import {
  applyStandaloneProfile,
  isStandaloneProfileEnabled,
} from "./standalone-profile.js";

// Applied before createApp() because createApp initializes the document registry
// while booting (app.js:118). Without the profile that call runs the PostgreSQL
// store's initialize(), which reaches runPostgresMigrations() and throws
// "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is required" -- so with no
// database the server does not start at all, rather than starting degraded.
//
// After "dotenv/config" on purpose: an explicit DOCCOMPARE_STANDALONE=1 should
// win over whatever .env says about PostgreSQL, not the other way round.
const standaloneProfile = isStandaloneProfileEnabled()
  ? applyStandaloneProfile()
  : null;

// ARCHIVE_RAG_ROLE picks what this process runs (rag/service-topology.js). An
// unknown value throws here, before anything starts. Every role other than the
// default `all` starts through rag/agent-service/role-server.js, which
// validates the topology, listens, and shuts down gracefully.
const serviceRole = getServiceRole();

// The SDK is loaded only when tracing is on; otherwise the tracing API the app
// calls stays a no-op. Started before createApp so the first request is traced.
// Every role, the monolith included, flushes the spans at the end of its
// graceful shutdown (a finalizer), never on the signal itself: exiting on the
// signal would cut off the requests the drain is waiting for.
const tracingFinalizers = [];

if (String(process.env.OTEL_TRACING_ENABLED ?? "").trim().toLowerCase() === "true") {
  const { createTracingShutdownFinalizer, startTracing } = await import("./otel.js");

  tracingFinalizers.push(createTracingShutdownFinalizer(startTracing()));
  console.log("[tracing] OpenTelemetry tracing enabled (OTLP/HTTP export).");
}

// How long past the drain window the finalizers (span flush, metrics
// listener, database pool) may take before the process exits anyway. The
// drain window plus this stays under the app's stop_grace_period in
// docker-compose.yml (25 s + 3 s < 30 s), so docker's SIGKILL never lands
// first with the defaults.
const SHUTDOWN_FINALIZER_MARGIN_MS = 3_000;

// How long the in-process ingest worker's running jobs may finish after the
// signal before it hands them back to the queue (createIngestWorker's
// shutdownGraceMs). The worker stops alongside the drain, so the hard
// deadline below counts from the longer of the two windows: a drain window
// shorter than this must not cut the hand-back and leave the jobs claimed
// until their lease runs out.
const INGEST_WORKER_STOP_GRACE_MS = 5_000;

// The monolith's signal handling: the first SIGTERM or SIGINT starts the
// graceful shutdown; a second one, or the drain window (or the ingest
// worker's stop grace, when longer) plus the finalizer margin running out,
// exits at once with status 1 (an operator pressing Ctrl+C twice, or a
// finalizer that hangs).
const handleShutdownSignals = ({ graceMs, shutdown }) => {
  let shuttingDown = false;

  const onSignal = (signal) => {
    if (shuttingDown) {
      console.warn(`[service] all: second ${signal} during shutdown; exiting now.`);
      process.exit(1);
    }

    shuttingDown = true;

    const deadline = setTimeout(() => {
      console.error(
        `[service] all: shutdown did not finish within ${graceMs + SHUTDOWN_FINALIZER_MARGIN_MS} ms; exiting now.`
      );
      process.exit(1);
    }, graceMs + SHUTDOWN_FINALIZER_MARGIN_MS);

    deadline.unref();
    void shutdown(signal);
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
};

// An empty PORT= counts as unset (it used to parse to NaN and fail listen).
const PORT = Number.parseInt(String(process.env.PORT ?? "").trim() || "5001", 10);

// The monolith: today's start-up. With AGENT_SERVICE_URL set it also acts as
// the public edge (app.js forwards agent work), so the topology is checked
// here too; with no service settings the check finds nothing and says nothing.
const startMonolith = async () => {
  const topology = validateServiceTopology();

  if (topology.errors.length > 0) {
    throw new Error(`Role all cannot start: ${topology.errors.join(" ")}`);
  }

  topology.warnings.forEach((line) => console.warn(`[service] ${line}`));

  const app = await createApp();

  // RAG_INGEST_MODE=async: every API process also drains the ingest queue unless
  // RAG_INGEST_WORKER_ENABLED=false moves that to `npm run worker:ingest`
  // processes (ignored, with an error, where the queue or the index is per
  // process). It runs on the app's own services, so it shares the routes' job
  // store and writes its temporary files beside the uploads.
  const ingestWorkerPlan = resolveApiIngestWorkerPlan({
    storeBackend: app.locals.services.ingestJobStore?.backend,
    vectorStoreProvider: getVectorStoreProviderConfigStatus().provider,
    workerEnabled: isRagIngestWorkerEnabled(),
  });

  ingestWorkerPlan.errors.forEach((line) => console.error(line));
  ingestWorkerPlan.warnings.forEach((line) => console.warn(line));

  const ingestWorker = ingestWorkerPlan.start
    ? createIngestWorker({
        ragService: app.locals.services.ragService,
        shutdownGraceMs: INGEST_WORKER_STOP_GRACE_MS,
        store: app.locals.services.ingestJobStore,
        tempDirectory: app.locals.services.uploadsDirectory,
      })
    : null;

  const server = app.listen(PORT, () => {
    // The port actually bound, so PORT=0 names the one the OS assigned.
    const port = server.address()?.port ?? PORT;

    console.log(
      standaloneProfile
        ? `server is running on port ${port} (standalone: filesystem document registry, no PostgreSQL)`
        : `server is running on port ${port}`
    );
  });

  // METRICS_ENABLED=true: /metrics on its own listener (METRICS_PORT), never
  // on PORT. This process hosts the ingest queue, so it reports its depth.
  const metrics = await startMetricsFromEnv({
    httpServer: server,
    ingestJobStore: isRagIngestAsync() ? app.locals.services.ingestJobStore : null,
  });

  if (ingestWorker) {
    ingestWorker.start();
    console.log(
      `[ingest-worker] ${ingestWorker.workerId} is draining the ingest queue (woken on enqueue, polling every ${ingestWorker.pollIntervalMs} ms).`
    );
  }

  // The split roles' graceful shutdown (rag/agent-service/role-server.js):
  // stop accepting connections, let in-flight requests finish within
  // SERVICE_SHUTDOWN_GRACE_MS (an interrupted document_rag step cannot be
  // replayed, so a cut /chat would leave its run for manual recovery), stop
  // the ingest worker alongside (running jobs get a short grace, the rest go
  // back to the queue instead of waiting out their lease), then flush spans,
  // close the metrics listener and the database pool, and exit 0.
  const { createGracefulShutdown } = await import("./rag/agent-service/role-server.js");
  const graceMs = getServiceShutdownGraceMs();
  const appStop = typeof app.locals?.stop === "function" ? [() => app.locals.stop()] : [];
  const shutdown = createGracefulShutdown({
    finalizers: [
      ...appStop,
      ...tracingFinalizers,
      ...(metrics ? [() => metrics.close()] : []),
      resetPostgresPool,
    ],
    graceMs,
    role: DEFAULT_SERVICE_ROLE,
    server,
    stoppers: ingestWorker ? [() => ingestWorker.stop()] : [],
  });

  handleShutdownSignals({
    graceMs: Math.max(graceMs, ingestWorker ? INGEST_WORKER_STOP_GRACE_MS : 0),
    shutdown,
  });
};

if (serviceRole === DEFAULT_SERVICE_ROLE) {
  await startMonolith();
} else {
  const { startServiceRole } = await import("./rag/agent-service/role-server.js");

  // Each role picks its port (PORT, or the tier's own default; see
  // resolveRolePort), as its dedicated entry point would.
  await startServiceRole({
    role: serviceRole,
    shutdownFinalizers: tracingFinalizers,
  });
}
