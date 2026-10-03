// A process that only drains the ingest queue (RAG_INGEST_MODE=async), so
// parsing and embedding run apart from the API processes, which then set
// RAG_INGEST_WORKER_ENABLED=false. `npm run worker:ingest`.
//
// It needs PostgreSQL: the queue is the rag_ingest_jobs table every process
// shares. The standalone profile's queue lives in the API process's memory, so
// a separate worker there would never see a job and refuses to start. It also
// refuses VECTOR_STORE_PROVIDER=local, whose index lives in each process's own
// memory and files: the API processes would never search what it indexed.
//
// Everything is imported lazily, after server/.env is loaded when this file is
// the entry point: some modules capture settings at import time (see
// standalone-profile.js), and a test that imports runIngestWorkerProcess must
// not load server/.env at all.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const runIngestWorkerProcess = async ({
  createStore = null,
  environment = process.env,
  exit = (code) => process.exit(code),
  logger = console,
  ragService = null,
  signals = process,
  tempDirectory = null,
} = {}) => {
  const [
    { getVectorStoreProviderConfigStatus, isPostgresDatabaseConfigured },
    { createDefaultIngestJobStore },
    { createIngestWorker },
    { resetPostgresPool },
    { resolveDataDirectory },
    { isStandaloneProfileEnabled },
  ] = await Promise.all([
    import("./rag/config.js"),
    import("./rag/ingest-job-store.js"),
    import("./rag/ingest-worker.js"),
    import("./rag/postgres.js"),
    import("./runtime-paths.js"),
    import("./standalone-profile.js"),
  ]);

  if (isStandaloneProfileEnabled({ environment }) || !isPostgresDatabaseConfigured()) {
    logger.error(
      "[ingest-worker] A dedicated ingest worker needs PostgreSQL (POSTGRES_DATABASE_URL): without it the job queue lives in the API process, whose own worker must run it."
    );
    return null;
  }

  if (getVectorStoreProviderConfigStatus().provider === "local") {
    logger.error(
      "[ingest-worker] A dedicated ingest worker needs a shared vector store (pgvector or qdrant): VECTOR_STORE_PROVIDER=local keeps the index in each process, so the API processes would never search what this worker indexed."
    );
    return null;
  }

  const store = (createStore ?? createDefaultIngestJobStore)();
  const resolvedRagService = ragService ?? (await import("./rag/index.js"));

  await store.initialize?.();

  const worker = createIngestWorker({
    logger,
    ragService: resolvedRagService,
    store,
    // The same directory the API writes uploads to: in the container image it
    // is the one writable volume.
    tempDirectory:
      tempDirectory ??
      resolveDataDirectory({
        explicitPath: environment.UPLOADS_DIRECTORY,
        derivedPath: path.join(__dirname, "uploads"),
        fallbackSegments: ["uploads"],
        sourceDirectory: __dirname,
      }),
  });

  // METRICS_ENABLED=true: /metrics on a listener of its own, with the queue's
  // depth and this worker's stage metrics (rag/metrics-server.js). Started
  // before the worker, so a metrics port that cannot be bound refuses the
  // start before any job is claimed.
  const { startMetricsFromEnv } = await import("./rag/metrics-server.js");
  const metrics = await startMetricsFromEnv({ env: environment, ingestJobStore: store, logger });

  // start() subscribes to enqueues: with PostgreSQL that opens this process's
  // one LISTEN session in the background, so a job is claimed when it is
  // queued rather than at the next poll; stop() closes it before the pool.
  worker.start();
  logger.log(
    `[ingest-worker] ${worker.workerId} is draining the ingest queue (woken on enqueue, polling every ${worker.pollIntervalMs} ms).`
  );

  let stopping = null;
  const shutdown = (signal) => {
    stopping ??= (async () => {
      logger.log(`[ingest-worker] ${signal}: stopping.`);
      await worker.stop();
      await metrics?.close();
      await resetPostgresPool();
      exit(0);
    })();

    return stopping;
  };

  signals.once("SIGTERM", () => void shutdown("SIGTERM"));
  signals.once("SIGINT", () => void shutdown("SIGINT"));

  return { metrics, shutdown, store, worker };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import("dotenv");

  config();

  const started = await runIngestWorkerProcess();

  if (!started) {
    process.exit(1);
  }
}
