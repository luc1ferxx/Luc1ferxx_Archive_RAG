// The model gateway process (ARCHIVE_RAG_ROLE=model-gateway):
// `node model-gateway.mjs`. An OpenAI-compatible service in front of the chat,
// embedding and rerank backends; see rag/model-gateway/app.js. Other tiers use
// it by setting MODEL_GATEWAY_URL (one or more replicas of this process).
//
// It runs as role model-gateway or not at all: with ARCHIVE_RAG_ROLE unset it
// takes that role, and any other role is refused, because a process of another
// role that sees MODEL_GATEWAY_URL would send its model calls to the gateway --
// which, for the gateway, would be itself.
//
// Everything is imported lazily, after server/.env is loaded when this file is
// the entry point, so a test that imports runModelGatewayProcess never loads
// server/.env.

import { pathToFileURL } from "node:url";

export const runModelGatewayProcess = async ({
  environment = process.env,
  exit = (code) => process.exit(code),
  listen = true,
  logger = console,
  signals = process,
} = {}) => {
  const role = String(environment.ARCHIVE_RAG_ROLE ?? "").trim().toLowerCase();

  if (!role) {
    environment.ARCHIVE_RAG_ROLE = "model-gateway";
  } else if (role !== "model-gateway") {
    logger.error(
      `[model-gateway] ARCHIVE_RAG_ROLE is "${role}"; the model gateway runs only as role model-gateway.`
    );
    return null;
  }

  const [
    { validateServiceTopology },
    { getModelGatewayPort },
    { createModelGatewayApp },
    { resetSharedState },
  ] = await Promise.all([
    import("./rag/service-topology.js"),
    import("./rag/config.js"),
    import("./rag/model-gateway/app.js"),
    import("./rag/shared-state.js"),
  ]);
  const { errors, warnings } = validateServiceTopology(environment);

  warnings.forEach((warning) => logger.warn(`[model-gateway] ${warning}`));

  if (errors.length > 0) {
    errors.forEach((error) => logger.error(`[model-gateway] ${error}`));
    return null;
  }

  let app;

  try {
    app = createModelGatewayApp({ env: environment });
  } catch (error) {
    // Upstream lists are validated here; the message names the variable only.
    logger.error(`[model-gateway] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  if (!listen) {
    return { app };
  }

  const port = getModelGatewayPort();
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(port, () => resolve(listening));

    listening.once("error", reject);
  });

  logger.log(`[model-gateway] listening on port ${server.address().port}.`);

  let stopping = null;
  const shutdown = (signal) => {
    stopping ??= (async () => {
      logger.log(`[model-gateway] ${signal}: stopping.`);
      await new Promise((resolve) => server.close(resolve));
      app.locals.modelGateway.close();
      await resetSharedState();
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

  // Started before the app so the first request is traced, as server.js does.
  if (String(process.env.OTEL_TRACING_ENABLED ?? "").trim().toLowerCase() === "true") {
    const { shutdownTracingOnExit, startTracing } = await import("./otel.js");

    shutdownTracingOnExit(startTracing());
  }

  const started = await runModelGatewayProcess();

  if (!started) {
    process.exit(1);
  }
}
