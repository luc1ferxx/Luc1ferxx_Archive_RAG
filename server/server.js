import "dotenv/config";

import { createApp } from "./app.js";
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

app.listen(PORT, () => {
  console.log(
    standaloneProfile
      ? `server is running on port ${PORT} (standalone: filesystem document registry, no PostgreSQL)`
      : `server is running on port ${PORT}`
  );
});
