import "dotenv/config";

import { createApp } from "./app.js";
import { getVectorStoreProviderConfigStatus, isRagIngestWorkerEnabled } from "./rag/config.js";
import { createIngestWorker, resolveApiIngestWorkerPlan } from "./rag/ingest-worker.js";
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

// The SDK is loaded only when tracing is on; otherwise the tracing API the app
// calls stays a no-op. Started before createApp so the first request is traced.
if (String(process.env.OTEL_TRACING_ENABLED ?? "").trim().toLowerCase() === "true") {
  const { shutdownTracingOnExit, startTracing } = await import("./otel.js");
  shutdownTracingOnExit(startTracing());
  console.log("[tracing] OpenTelemetry tracing enabled (OTLP/HTTP export).");
}

const PORT = Number.parseInt(process.env.PORT ?? "5001", 10);
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
      store: app.locals.services.ingestJobStore,
      tempDirectory: app.locals.services.uploadsDirectory,
    })
  : null;

const server = app.listen(PORT, () => {
  console.log(
    standaloneProfile
      ? `server is running on port ${PORT} (standalone: filesystem document registry, no PostgreSQL)`
      : `server is running on port ${PORT}`
  );
});

if (ingestWorker) {
  ingestWorker.start();
  console.log(`[ingest-worker] ${ingestWorker.workerId} is draining the ingest queue.`);

  // Without a worker the default signal handling (exit at once) is unchanged.
  // With one, running jobs get a short grace period and the rest go back to
  // the queue instead of waiting out their lease.
  const shutdown = async (signal) => {
    console.log(`[ingest-worker] ${signal}: stopping.`);
    server.close();
    await ingestWorker.stop();
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
