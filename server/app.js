import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { requireApiAuth } from "./auth.js";
import { getAgentRunRecoveryMode, isApiAuthEnabled } from "./rag/config.js";
import { configureUploadSessionDirectory } from "./upload-session-store.js";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultUploadsDirectory = path.join(__dirname, "uploads");

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
    jobOrchestrator,
    ragService,
    taskService,
    uploadStore,
    workspaceArtifactService,
  } = services;

  const app = express();
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
  await agentRunRecoveryService.recoverOnStartup?.({
    mode: getAgentRunRecoveryMode(),
  });
  await jobOrchestrator.recoverRunnableTasks?.();
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

  app.use(createArtifactsRouter(services));
  app.use(createAdminRouter(services));
  app.use(createDocumentsRouter(services));
  app.use(createTasksRouter(services));
  app.use(createArxivRouter(services));
  app.use(createMemoryRouter(services));
  app.use(createQualityRouter(services));
  app.use(createUploadsRouter(services));
  app.use(createChatRouter(services));

  return app;
};
