// The retrieval tier of a split deployment (ARCHIVE_RAG_ROLE=retrieval):
// query embedding, dense and sparse search, fusion and rerank for the agent
// tier (or a monolith with RETRIEVAL_SERVICE_URL set), behind signed internal
// identities. `node retrieval-service.mjs`; see rag/retrieval-service/app.js
// for the endpoints and rag/retrieval-service/remote-retrieval.js for the
// caller.
//
// It listens on PORT (default 5002) and refuses to start when:
//   - ARCHIVE_RAG_ROLE is not `retrieval`, or the topology has errors
//     (service-topology.js validateServiceTopology: no usable
//     INTERNAL_SERVICE_KEYS, an invalid URL);
//   - there is no PostgreSQL (POSTGRES_DATABASE_URL) or the standalone
//     profile is on: the document registry would then be this process's own
//     copy, so documents uploaded through the API would stay invisible here;
//   - VECTOR_STORE_PROVIDER=local, whose index lives in each process's own
//     memory and files: this process would search a stale copy.
// With STARTUP_HEALTH_STRICT=true a failing health report (vector store,
// index versions, query adapter) also stops it; otherwise it is logged.
//
// Everything is imported lazily, after server/.env is loaded when this file is
// the entry point: some modules capture settings at import time (see
// standalone-profile.js), and a test that imports runRetrievalServiceProcess
// must not load server/.env at all.

import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 5002;

const resolvePort = (environment) => {
  const parsed = Number.parseInt(String(environment.PORT ?? "").trim(), 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT;
};

export const runRetrievalServiceProcess = async ({
  environment = process.env,
  exit = (code) => process.exit(code),
  logger = console,
  port = resolvePort(environment),
  signals = process,
} = {}) => {
  const [
    { getVectorStoreProviderConfigStatus, isPostgresDatabaseConfigured, isStartupHealthStrict },
    { getServiceRole, validateServiceTopology },
    { isStandaloneProfileEnabled },
  ] = await Promise.all([
    import("./rag/config.js"),
    import("./rag/service-topology.js"),
    import("./standalone-profile.js"),
  ]);

  let role;

  try {
    role = getServiceRole(environment);
  } catch (error) {
    logger.error(`[retrieval-service] ${error.message}`);
    return null;
  }

  if (role !== "retrieval") {
    logger.error(
      `[retrieval-service] ARCHIVE_RAG_ROLE is "${role}"; the retrieval service runs only as ARCHIVE_RAG_ROLE=retrieval.`
    );
    return null;
  }

  const topology = validateServiceTopology(environment);

  topology.warnings.forEach((line) => logger.warn(`[retrieval-service] ${line}`));

  if (topology.errors.length > 0) {
    topology.errors.forEach((line) => logger.error(`[retrieval-service] ${line}`));
    return null;
  }

  if (isStandaloneProfileEnabled({ environment }) || !isPostgresDatabaseConfigured()) {
    logger.error(
      "[retrieval-service] The retrieval service needs PostgreSQL (POSTGRES_DATABASE_URL): its document registry must be the one the API writes, or documents uploaded there would stay invisible here."
    );
    return null;
  }

  if (getVectorStoreProviderConfigStatus().provider === "local") {
    logger.error(
      "[retrieval-service] The retrieval service needs a shared vector store (pgvector or qdrant): VECTOR_STORE_PROVIDER=local keeps the index in each process, so this one would search a stale copy."
    );
    return null;
  }

  if (String(environment.OTEL_TRACING_ENABLED ?? "").trim().toLowerCase() === "true") {
    const { shutdownTracingOnExit, startTracing } = await import("./otel.js");

    shutdownTracingOnExit(
      startTracing({ serviceName: environment.OTEL_SERVICE_NAME || "luc1ferxx-archive-rag-retrieval" })
    );
    logger.log("[tracing] OpenTelemetry tracing enabled (OTLP/HTTP export).");
  }

  const [{ buildRetrievalHealthReport, createRetrievalApp }, { resetPostgresPool }] = await Promise.all([
    import("./rag/retrieval-service/app.js"),
    import("./rag/postgres.js"),
  ]);
  const report = await buildRetrievalHealthReport({ env: environment });
  const summary = Object.entries(report.checks)
    .map(([name, entry]) => `${name}=${entry.status}`)
    .join(" ");

  if (report.status !== "ok") {
    logger.warn(`[retrieval-service] Startup health error: ${summary}`);

    if (isStartupHealthStrict()) {
      await resetPostgresPool();
      return null;
    }
  } else {
    logger.log(`[retrieval-service] Startup health ok: ${summary}`);
  }

  const app = createRetrievalApp({ env: environment, logger });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(port, () => resolve(listening));

    listening.once("error", reject);
  });

  logger.log(`[retrieval-service] listening on port ${server.address().port}`);

  let stopping = null;
  const shutdown = (signal) => {
    stopping ??= (async () => {
      logger.log(`[retrieval-service] ${signal}: stopping.`);
      await new Promise((resolve) => server.close(() => resolve()));
      await resetPostgresPool();
      exit(0);
    })();

    return stopping;
  };

  signals.once("SIGTERM", () => void shutdown("SIGTERM"));
  signals.once("SIGINT", () => void shutdown("SIGINT"));

  return { app, server, shutdown };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import("dotenv");

  config();

  const started = await runRetrievalServiceProcess();

  if (!started) {
    process.exit(1);
  }
}
