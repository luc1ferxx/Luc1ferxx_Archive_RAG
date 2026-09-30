import express from "express";
import { mkdir } from "fs/promises";
import path from "path";

import { getDefaultUploadsDirectory } from "../../app.js";
import { createAppServices } from "../../app-services.js";
import { bindDatabaseTenant } from "../../auth.js";
import { getAdminActionPermissionForRequest } from "../admin-authorization.js";
import { getAgentRunRecoveryMode } from "../config.js";
import { createAdminActionHandler } from "../../routes/admin.js";
import { createChatRouter } from "../../routes/chat.js";
import { createSystemRouter } from "../../routes/system.js";
import { createTasksRouter } from "../../routes/tasks.js";
import { bindServiceTraceContext } from "../service-client.js";
import { requireServiceIdentity } from "../service-identity.js";
import { SERVICE_TIERS } from "../service-topology.js";

import {
  ADMIN_PERMISSION_CLAIM,
  AGENT_SERVICE_CALLER_ROLES,
  AGENT_SERVICE_PING_PATH,
} from "./contract.js";

// The agent tier of a split deployment (ARCHIVE_RAG_ROLE=agent): agent
// orchestration behind the public edge (rag/agent-service/edge-router.js).
//
// It serves the same chat, task, trigger, and agent-run routes as the monolith,
// built from the same routers and services, so a forwarded request is answered
// by the code that answers it in one process. What differs is who may ask:
// there is no public authentication, CORS, or rate limiting here. Every route
// except liveness and health needs a signed internal token for the `agent`
// audience from the edge (AGENT_SERVICE_CALLER_ROLES); a public API token is
// refused like no token at all. The token's access scope becomes req.accessScope
// in exactly the shape requireApiAuth sets, and bindDatabaseTenant then runs
// the request as that tenant, as in the monolith.
//
// This tier owns the background agent work: startup recovery of interrupted
// runs and tasks, and every task the job orchestrator schedules. Retrieval and
// model calls go to RETRIEVAL_SERVICE_URL and MODEL_GATEWAY_URL when set, and
// run in process otherwise.

/**
 * Runs the forwarded admin action only when the edge's signed claim grants
 * exactly this action's permission (the edge checked and audited it).
 */
const requireEdgeAdminAuthorization = (req, res, next) => {
  const granted = req.serviceIdentity?.claims?.[ADMIN_PERMISSION_CLAIM];
  const required = String(getAdminActionPermissionForRequest(req) ?? "");

  if (typeof granted !== "string" || granted !== required) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }

  next();
};

/**
 * Builds the agent tier's Express app over createAppServices(options), the
 * same services the monolith uses (tests inject stubs the same way). It
 * initializes the stores the agent reads, recovers interrupted agent runs and
 * runnable tasks, runs the startup health checks, and returns the app; the
 * caller listens.
 */
export const createAgentApp = async (options = {}) => {
  const uploadsDirectory = options.uploadsDirectory
    ? path.resolve(options.uploadsDirectory)
    : getDefaultUploadsDirectory();
  const services = createAppServices(options, { uploadsDirectory });
  const {
    adminAuditService,
    agentRunRecoveryService,
    agentRunService,
    healthService,
    jobOrchestrator,
    ragService,
    taskService,
    workspaceArtifactService,
  } = services;
  const app = express();

  app.locals.services = services;
  app.disable("x-powered-by");

  // arXiv import tasks write their downloads below the uploads directory.
  await mkdir(uploadsDirectory, { recursive: true });
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

  // Liveness and health stay unauthenticated, as in the monolith, so an
  // orchestrator can probe them without a key.
  app.use(createSystemRouter(services));

  const identityOptions = {
    audience: SERVICE_TIERS.agent,
    issuers: AGENT_SERVICE_CALLER_ROLES,
  };

  app.get(
    AGENT_SERVICE_PING_PATH,
    requireServiceIdentity({ ...identityOptions, allowSystem: true }),
    (req, res) => res.json({ role: SERVICE_TIERS.agent, status: "ok" })
  );

  // Identity first, so nobody without a key gets a body parsed. The JSON
  // parser resumes the chain from a stream callback, which drops async
  // context, so the tenant and trace bindings come after it (as in app.js).
  // The public 2 MB limit is the edge's; the edge re-serializes the body it
  // parsed, which can come out longer (1e9 becomes 1000000000), so the limit
  // here only guards against a runaway caller that already holds a key.
  app.use(requireServiceIdentity(identityOptions));
  app.use(express.json({ limit: "8mb" }));
  app.use(bindDatabaseTenant);
  app.use(bindServiceTraceContext);

  app.post(
    "/admin/actions/:action",
    requireEdgeAdminAuthorization,
    createAdminActionHandler(services)
  );
  app.use(createTasksRouter(services));
  app.use(createChatRouter(services));

  app.use((req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  return app;
};
