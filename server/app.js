import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { noStoreTenantData } from "./routes/helpers.js";
import {
  assertApiAuthTokenConfiguration,
  bindDatabaseTenant,
  requireApiAuth,
} from "./auth.js";
import {
  getAgentRunRecoveryMode,
  getLongMemoryScope,
  getPostgresTenantContextMode,
  getQueryEmbeddingCacheScope,
  getTenantEncryptionMode,
  getTenantKmsProviderId,
  getTenantMembershipMode,
  getTenantRegistryCacheScope,
  getTrustProxySetting,
  getUploadSessionCleanupIntervalMs,
  isApiAuthEnabled,
  isRagIngestAsync,
} from "./rag/config.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";
import { stopTenantUsageLedger } from "./rag/tenant-usage.js";
import { stopPdfParsePool } from "./rag/pdf-parse-pool.js";
import {
  configureUploadSessionDirectory,
  startUploadSessionSweeper,
} from "./upload-session-store.js";
import { assertRbacConfiguration, createRbacMiddleware } from "./rag/rbac.js";
import { createDefaultTenantRegistryService } from "./rag/tenant-registry.js";
import { createTenantLimits } from "./rag/tenant-limits.js";
import { createAgentEdgeRouter } from "./rag/agent-service/edge-router.js";
import { stripInternalServiceHeadersMiddleware } from "./rag/service-identity.js";
import {
  hostsServiceTier,
  isRemoteAgentEnabled,
  SERVICE_TIERS,
} from "./rag/service-topology.js";

import { createAppServices } from "./app-services.js";
import { assertDocumentTrashSupported } from "./rag/document-trash.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAdminTenantsRouter } from "./routes/admin-tenants.js";
import { createAdminTenantLifecycleRouter } from "./routes/admin-tenant-lifecycle.js";
import { createAdminUsageRouter } from "./routes/admin-usage.js";
import { createArxivRouter } from "./routes/arxiv.js";
import { createArtifactsRouter } from "./routes/artifacts.js";
import { createAuthConfigRouter } from "./routes/auth-config.js";
import { createAuthMeRouter } from "./routes/auth-me.js";
import { createChatRouter } from "./routes/chat.js";
import { createDocumentsRouter } from "./routes/documents.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createQualityRouter } from "./routes/quality.js";
import { createSystemRouter } from "./routes/system.js";
import { createTasksRouter } from "./routes/tasks.js";
import { createUploadsRouter } from "./routes/uploads.js";
import { resolveDataDirectory } from "./runtime-paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Reads UPLOADS_DIRECTORY as well, so a bundled build can be pointed at a real
// directory without threading an option through every caller of createApp.
const defaultUploadsDirectory = resolveDataDirectory({
  explicitPath: process.env.UPLOADS_DIRECTORY,
  derivedPath: path.join(__dirname, "uploads"),
  fallbackSegments: ["uploads"],
  sourceDirectory: __dirname,
});

// The agent tier (rag/agent-service/app.js) builds the same services over the
// same directory.
export const getDefaultUploadsDirectory = () => defaultUploadsDirectory;

const parseAllowedOrigins = () =>
  String(process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const isRateLimitEnabled = () =>
  String(process.env.RATE_LIMIT_ENABLED ?? "").trim().toLowerCase() === "true";

const toRateLimitMax = (rawValue, fallbackValue) => {
  const parsed = Number.parseInt(String(rawValue ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
};

const createRateLimiter = ({ max }) =>
  rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please retry later." },
  });

export const createApp = async (options = {}) => {
  const uploadsDirectory = options.uploadsDirectory
    ? path.resolve(options.uploadsDirectory)
    : defaultUploadsDirectory;

  if (options.uploadSessionDirectory) {
    configureUploadSessionDirectory(options.uploadSessionDirectory);
  }

  // RBAC_MODE / RBAC_POLICY_JSON / RBAC_POLICY_FILE / RBAC_DEFAULT_ROLE are
  // validated before anything starts: a bad policy refuses the start.
  assertRbacConfiguration();
  // An API_AUTH_TOKENS entry that can act for no tenant refuses the start.
  assertApiAuthTokenConfiguration();
  // An unknown POSTGRES_TENANT_CONTEXT refuses the start here rather than at
  // the first query (every query reads it again).
  getPostgresTenantContextMode();
  // So does an unknown TENANT_MEMBERSHIP (requireApiAuth reads it per request).
  const tenantMembershipMode = getTenantMembershipMode();
  // And an unknown LONG_MEMORY_SCOPE, RAG_EMBEDDING_CACHE_SCOPE or
  // TENANT_REGISTRY_CACHE_SCOPE (read per call; none falls back to its
  // unpartitioned default).
  getLongMemoryScope();
  getQueryEmbeddingCacheScope();
  getTenantRegistryCacheScope();
  // And an unknown TENANT_ENCRYPTION or TENANT_KMS_PROVIDER (every tenant file
  // write and read consults them, rag/tenant-encryption.js).
  getTenantEncryptionMode();
  getTenantKmsProviderId();
  // TRUST_PROXY: an invalid value refuses the start (TRUST_PROXY_INVALID);
  // unset keeps Express's default (req.ip is the socket peer).
  const trustProxy = getTrustProxySetting();

  const services = createAppServices(options, { uploadsDirectory });

  // DOCUMENT_TRASH_RETENTION_HOURS above 0 where the trash cannot work (not
  // pgvector with the PostgreSQL registry) refuses the start
  // (DOCUMENT_TRASH_UNSUPPORTED, rag/document-trash.js).
  assertDocumentTrashSupported({ ragService: services.ragService });

  const {
    adminAuditService,
    agentRunRecoveryService,
    agentRunService,
    healthService,
    ingestJobStore,
    jobOrchestrator,
    ragService,
    taskService,
    uploadStore,
    workspaceArtifactService,
  } = services;

  // ARCHIVE_RAG_ROLE=api (or all with AGENT_SERVICE_URL): this process is the
  // public edge of a split deployment. Agent routes are forwarded to the agent
  // tier (rag/agent-service/edge-router.js), and agent startup recovery and
  // background tasks run there, not here. Without AGENT_SERVICE_URL the
  // monolith keeps everything in process.
  const forwardsAgentWork = isRemoteAgentEnabled();
  const hostsAgentWork = hostsServiceTier(SERVICE_TIERS.agent);

  // The tenant registry (migration 036): the admin routes write it, and
  // requireApiAuth reads it from app.locals under TENANT_MEMBERSHIP=enforce,
  // so both share one instance and its lookup cache -- the one
  // createAppServices built (options.tenantRegistry when given), which the
  // tenant erase and the retention sweep use too.
  const tenantRegistry = services.tenantRegistry ?? createDefaultTenantRegistryService();

  const app = express();

  if (trustProxy !== undefined) {
    // req.ip becomes the client behind the trusted proxies, for the per-IP
    // limiter below and the per-tenant limiter's IP key.
    app.set("trust proxy", trustProxy);
  }

  // server.js starts the ingest worker on these same services, so a worker in
  // the API process shares the routes' job store (the only way the in-memory
  // store works).
  app.locals.services = services;
  app.locals.tenantRegistry = tenantRegistry;
  const allowedOrigins = parseAllowedOrigins();
  const rateLimitEnabled = isRateLimitEnabled();

  if (!isApiAuthEnabled()) {
    console.warn(
      "[security] API authentication is DISABLED (API_AUTH_ENABLED is not true). Every endpoint, including destructive ones, is reachable without credentials. Do not expose this server beyond localhost."
    );
  }

  if (tenantMembershipMode === "enforce" && !isApiAuthEnabled()) {
    console.warn(
      "[security] TENANT_MEMBERSHIP=enforce has no effect while API authentication is disabled: every request acts without a tenant check."
    );
  } else if (tenantMembershipMode === "enforce" && tenantRegistry.store?.backend === "memory") {
    console.warn(
      "[security] TENANT_MEMBERSHIP=enforce with an in-process tenant registry (no database): it starts empty, so every request naming a workspace is refused until workspaces and members are registered through /admin/workspaces in this process."
    );
  }

  if (allowedOrigins.length === 0) {
    console.warn(
      "[security] ALLOWED_ORIGINS is not set; CORS accepts any origin. Set ALLOWED_ORIGINS (comma-separated) for any non-local deployment."
    );
  }

  if (!rateLimitEnabled) {
    console.warn(
      "[security] Rate limiting is disabled. Set RATE_LIMIT_ENABLED=true to protect /chat, uploads, and destructive endpoints."
    );
  }

  // Before anything reads a header: a public client can never present an
  // internal token, deadline, or request id (rag/service-identity.js).
  app.use(stripInternalServiceHeadersMiddleware);

  // frameguard/CSP frame-ancestors and CORP stay off: the workbench iframes
  // PDF previews from a different origin (frontend :3000 -> API :5001).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      frameguard: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(
    cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : true,
      exposedHeaders: ["Content-Disposition"],
    })
  );
  // The single-container deployment (Dockerfile) serves the built frontend
  // from the API origin. Static files carry no archive data, so they are
  // mounted ahead of rate limiting and API auth; the SPA has no client-side
  // routes, so no index.html fallback shadows an API path.
  if (process.env.FRONTEND_BUILD_DIRECTORY) {
    app.use(express.static(path.resolve(process.env.FRONTEND_BUILD_DIRECTORY), { index: "index.html" }));
  }

  app.use(express.json({ limit: "2mb" }));

  await mkdir(uploadsDirectory, { recursive: true });
  await uploadStore.ensureUploadStorage();
  await uploadStore.recoverInterruptedUploadFinalizations?.();
  await uploadStore.cleanupExpiredUploadSessions?.();

  // Start-up is system work: migrations, the process-wide registry and memory
  // stores, the cross-tenant recovery scans (each recovered run or task binds
  // its own scope again) and the start-up health report. Bound explicitly so
  // POSTGRES_TENANT_CONTEXT=strict accepts it; only this block, never the
  // listener, so a request that loses its context later is still unbound.
  await runAsDatabaseSystem(async () => {
    await ragService.initializeDocumentRegistry?.();
    await ragService.initializeLongMemory?.();
    await ragService.initializeSessionMemory?.();
    await taskService.initialize?.();
    await agentRunService.initialize?.();
    await adminAuditService.initialize?.();
    await workspaceArtifactService.initialize?.();

    if (isRagIngestAsync()) {
      await ingestJobStore.initialize?.();
    }

    // Enforcement reads the registry on every request naming a workspace, so
    // its store must be ready before the first one; with the mode off it is
    // initialized lazily by the admin routes.
    if (tenantMembershipMode === "enforce") {
      await tenantRegistry.initialize?.();
    }

    if (hostsAgentWork) {
      await agentRunRecoveryService.recoverOnStartup?.({
        mode: getAgentRunRecoveryMode(),
      });
      await jobOrchestrator.recoverRunnableTasks?.();
    }

    await healthService.runStartupHealthChecks?.();
  });

  // Expired upload sessions are swept again every
  // UPLOAD_SESSION_CLEANUP_INTERVAL_MS while the process runs (the sweep above
  // runs once at start-up), so an abandoned upload frees its disk and its place
  // under the per-tenant session caps without a restart. Started only once
  // start-up has succeeded, so a refused start leaves no timer behind; the
  // graceful shutdown (server.js, rag/agent-service/role-server.js) runs
  // app.locals.stop, which stops it.
  const uploadSessionSweeper = uploadStore.cleanupExpiredUploadSessions
    ? startUploadSessionSweeper({
        cleanup: () => uploadStore.cleanupExpiredUploadSessions(),
        intervalMs: getUploadSessionCleanupIntervalMs(),
      })
    : null;
  app.locals.stop = async () => {
    uploadSessionSweeper?.stop();
    // Writes the usage this process still holds (rag/tenant-usage.js) before
    // the shutdown closes the pool; never fails the shutdown.
    try {
      await stopTenantUsageLedger();
    } catch (error) {
      console.error("Failed to flush tenant usage on shutdown.", error);
    }
    // Ends the pdf.js workers (PDF_PARSE_WORKERS > 0; nothing without them).
    // Requests and the ingest worker have stopped by now; a parse still
    // running fails with PDF_PARSE_POOL_STOPPED (503), which the ingest queue
    // retries.
    await stopPdfParsePool();
  };

  app.use(createSystemRouter(services));
  // Public login configuration for the SPA (OIDC issuer/client id, no secrets).
  app.use(createAuthConfigRouter());

  if (rateLimitEnabled) {
    app.use(
      createRateLimiter({
        max: toRateLimitMax(process.env.RATE_LIMIT_GLOBAL_MAX, 300),
      })
    );
    app.use(
      "/chat",
      createRateLimiter({
        max: toRateLimitMax(process.env.RATE_LIMIT_CHAT_MAX, 30),
      })
    );
    app.use(
      "/upload",
      createRateLimiter({
        max: toRateLimitMax(process.env.RATE_LIMIT_UPLOAD_MAX, 120),
      })
    );
    app.use(
      "/documents/clear",
      createRateLimiter({
        max: toRateLimitMax(process.env.RATE_LIMIT_DESTRUCTIVE_MAX, 5),
      })
    );
    app.use(
      "/admin/tenants/erase",
      createRateLimiter({
        max: toRateLimitMax(process.env.RATE_LIMIT_DESTRUCTIVE_MAX, 5),
      })
    );
  }

  app.use(requireApiAuth);
  app.use(bindDatabaseTenant);
  // Every route below answers for the caller's tenant (documents, chat, runs,
  // tasks, memory, feedback, ingest jobs, admin views), so no shared cache may
  // keep a response or serve it to another credential: private, no-store, and
  // Vary on the identity headers. The static frontend and the probes are
  // mounted above and keep their own headers.
  app.use(noStoreTenantData);
  // TENANT_RATE_LIMIT_ENABLED / TENANT_MAX_CONCURRENT_RUNS (rag/tenant-limits.js):
  // per-tenant request windows and concurrent agent runs, counted once the
  // tenant is known and before RBAC (whose denials write audit records). Off
  // by default, and then nothing is mounted.
  const tenantLimits = createTenantLimits();

  if (tenantLimits.enabled) {
    app.locals.tenantLimits = tenantLimits;
    app.use(tenantLimits.middleware);
  }

  // RBAC_MODE=enforce: every route below needs its RBAC_ROUTE_TABLE
  // permission (rag/rbac.js); off (default) is a no-op. At the edge of a split
  // deployment this runs before agent routes are forwarded.
  app.use(createRbacMiddleware({ auditService: adminAuditService }));
  app.use(createAuthMeRouter());

  const agentEdge = forwardsAgentWork ? createAgentEdgeRouter() : null;

  app.use(createArtifactsRouter(services));
  // Admin actions recover agent tasks and run model evaluations, so at the
  // edge they are authorized and audited here and then run by the agent tier.
  app.use(
    createAdminRouter(
      services,
      agentEdge ? { actionHandler: agentEdge.forwardAdminAction } : {}
    )
  );
  // The tenant registry's admin API (always on the public edge: it writes
  // the registry requireApiAuth reads here).
  app.use(createAdminTenantsRouter(services, { tenantRegistry }));

  // Tenant erase and export (admin.owner, platform principals only). At the
  // edge of a split deployment they run here: every tier shares the one
  // PostgreSQL they erase or export.
  app.use(createAdminTenantLifecycleRouter(services));

  // GET /admin/usage (migration 037's usage ledger): answered here at the
  // edge too, from the shared database.
  app.use(createAdminUsageRouter(services));
  app.use(createDocumentsRouter(services));
  // At the edge one router forwards both the task and the chat routes.
  app.use(agentEdge ? agentEdge.router : createTasksRouter(services));
  app.use(createArxivRouter(services));
  app.use(createMemoryRouter(services));
  app.use(createQualityRouter(services));
  app.use(createUploadsRouter(services));

  if (!agentEdge) {
    app.use(createChatRouter(services));
  }

  return app;
};
