import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { bindDatabaseTenant, requireApiAuth } from "./auth.js";
import {
  getAgentRunRecoveryMode,
  isApiAuthEnabled,
  isRagIngestAsync,
} from "./rag/config.js";
import { configureUploadSessionDirectory } from "./upload-session-store.js";
import { createAgentEdgeRouter } from "./rag/agent-service/edge-router.js";
import { stripInternalServiceHeadersMiddleware } from "./rag/service-identity.js";
import {
  hostsServiceTier,
  isRemoteAgentEnabled,
  SERVICE_TIERS,
} from "./rag/service-topology.js";

import { createAppServices } from "./app-services.js";
import { createAdminRouter } from "./routes/admin.js";
import { createArxivRouter } from "./routes/arxiv.js";
import { createArtifactsRouter } from "./routes/artifacts.js";
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

  const services = createAppServices(options, { uploadsDirectory });

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

  const app = express();
  // server.js starts the ingest worker on these same services, so a worker in
  // the API process shares the routes' job store (the only way the in-memory
  // store works).
  app.locals.services = services;
  const allowedOrigins = parseAllowedOrigins();
  const rateLimitEnabled = isRateLimitEnabled();

  if (!isApiAuthEnabled()) {
    console.warn(
      "[security] API authentication is DISABLED (API_AUTH_ENABLED is not true). Every endpoint, including destructive ones, is reachable without credentials. Do not expose this server beyond localhost."
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

  if (hostsAgentWork) {
    await agentRunRecoveryService.recoverOnStartup?.({
      mode: getAgentRunRecoveryMode(),
    });
    await jobOrchestrator.recoverRunnableTasks?.();
  }

  await healthService.runStartupHealthChecks?.();

  app.use(createSystemRouter(services));

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
  }

  app.use(requireApiAuth);
  app.use(bindDatabaseTenant);

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
