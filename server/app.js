import express from "express";
import cors from "cors";
import { mkdir, rm } from "fs/promises";
import multer from "multer";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { getRequestAccessScope, requireApiAuth } from "./auth.js";
import chat, {
  clearDocuments,
  clearLongMemories,
  clearSessionMemory,
  deleteLongMemory,
  deleteDocument,
  getDocument,
  getDocumentFile,
  ingestDocument,
  initializeDocumentRegistry,
  initializeLongMemory,
  initializeSessionMemory,
  listDocuments,
  listLongMemories,
  rememberLongMemory,
} from "./chat.js";
import chatMCP from "./chat-mcp.js";
import {
  readLatestQualityReport,
  readQualityHistory,
  runSyntheticQualityEvaluation,
} from "./evaluation/quality-report.js";
import {
  buildFeedbackRecord,
  listFeedback,
  recordFeedback,
} from "./feedback.js";
import { buildHealthReport, runStartupHealthChecks } from "./health.js";
import { createArxivEnrichmentService } from "./rag/arxiv-enrichment.js";
import { createArxivService, normalizeArxivMaxResults } from "./rag/arxiv-client.js";
import { createArxivImportService } from "./rag/arxiv-importer.js";
import { createJobOrchestrator } from "./rag/job-orchestrator.js";
import { createDefaultAgentRunStore } from "./rag/agent-run-store.js";
import { createAgentRunRecoveryActionService } from "./rag/agent-run-recovery-actions.js";
import { createAgentRunRecoveryService } from "./rag/agent-run-recovery.js";
import { createAgentRunService } from "./rag/agent-runs.js";
import { createAgentRunStepExecutor } from "./rag/agent-run-step-executor.js";
import {
  createCustomSkillStepExecutor,
  createDocumentRagStepExecutor,
  createResearchQuestionStepExecutor,
} from "./rag/agent-run-step-handlers/index.js";
import { createRecommendationTaskService } from "./rag/recommendation-tasks.js";
import { createDefaultTaskStore } from "./rag/task-store.js";
import { createTaskService } from "./rag/tasks.js";
import {
  createAgentTaskRunner,
  createAgentTaskService,
} from "./rag/agent-tasks.js";
import { createAgentTriggerDispatcher } from "./rag/agent-trigger-dispatcher.js";
import { createDefaultAgentTriggerRegistry } from "./rag/agent-triggers/registry.js";
import { runAgentRag } from "./rag/agent.js";
import { deterministicPlannerAdapter } from "./rag/agent-execution-plan.js";
import { llmPlannerAdapter } from "./rag/agent-llm-planner-adapter.js";
import {
  deterministicIntentPlannerAdapter,
  llmIntentPlannerAdapter,
} from "./rag/agent-intent-planner.js";
import {
  withPlannerRollout,
  withShadowPlanner,
} from "./rag/agent-planner-shadow.js";
import { recordAgentExperienceFromFeedback } from "./rag/agent-experience-memory.js";
import { createDefaultCapabilityRegistry } from "./rag/capabilities/index.js";
import {
  getAgentExecutionPlanner,
  getAgentIntentPlanner,
  getAgentPlannerRollout,
  getAgentRunRecoveryMode,
} from "./rag/config.js";
import {
  clearUploadSession,
  configureUploadSessionDirectory,
  ensureUploadStorage,
  finalizeUploadSession,
  getUploadSessionStatus,
  initializeUploadSession,
  removeMergedUpload,
  storeUploadChunk,
} from "./upload-session-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultUploadsDirectory = path.join(__dirname, "uploads");

const DEFAULT_UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_DIRECT_UPLOAD_SIZE = 50 * 1024 * 1024;
const MAX_CHUNK_UPLOAD_SIZE = 5 * 1024 * 1024;

const createRolloutPlannerAdapter = ({
  configuredPlanner,
  deterministicPlanner,
  llmPlanner,
} = {}) => {
  const rollout = getAgentPlannerRollout();

  if (rollout === "shadow") {
    return withPlannerRollout(
      withShadowPlanner(deterministicPlanner, llmPlanner),
      rollout
    );
  }

  if (rollout === "guarded_llm" || rollout === "llm") {
    return withPlannerRollout(llmPlanner, rollout);
  }

  if (rollout === "deterministic") {
    return withPlannerRollout(deterministicPlanner, rollout);
  }

  return configuredPlanner();
};

const createExecutionPlannerAdapter = () =>
  createRolloutPlannerAdapter({
    configuredPlanner: () =>
      getAgentExecutionPlanner() === "llm"
        ? llmPlannerAdapter
        : deterministicPlannerAdapter,
    deterministicPlanner: deterministicPlannerAdapter,
    llmPlanner: llmPlannerAdapter,
  });

const createIntentPlannerAdapter = () =>
  createRolloutPlannerAdapter({
    configuredPlanner: () =>
      getAgentIntentPlanner() === "llm"
        ? llmIntentPlannerAdapter
        : deterministicIntentPlannerAdapter,
    deterministicPlanner: deterministicIntentPlannerAdapter,
    llmPlanner: llmIntentPlannerAdapter,
  });

const parseDocIds = (rawDocIds, fallbackDocId) => {
  if (Array.isArray(rawDocIds)) {
    return [...new Set(rawDocIds.map((docId) => docId?.trim()).filter(Boolean))];
  }

  if (typeof rawDocIds === "string" && rawDocIds.trim()) {
    return [
      ...new Set(
        rawDocIds
          .split(",")
          .map((docId) => docId.trim())
          .filter(Boolean)
      ),
    ];
  }

  if (typeof fallbackDocId === "string" && fallbackDocId.trim()) {
    return [fallbackDocId.trim()];
  }

  return [];
};

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

const normalizeBooleanQuery = (value) =>
  String(value ?? "").trim().toLowerCase() === "true";

const buildTriggerDispatchRequest = (req) => {
  const payload = req.body ?? {};
  const request = {
    ...(payload.request && typeof payload.request === "object"
      ? payload.request
      : {}),
  };
  const idempotencyKey =
    request.id ??
    payload.idempotencyKey ??
    req.get("x-idempotency-key") ??
    req.get("x-request-id");

  if (idempotencyKey !== undefined) {
    request.id = String(idempotencyKey).trim();
  }

  return {
    event: payload.event,
    input: payload.input ?? payload.payload ?? payload,
    mode: payload.mode,
    payload: payload.payload,
    request,
  };
};

const cleanupUploadedFile = async (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    await rm(filePath, { force: true });
  } catch (cleanupError) {
    console.error(`Failed to remove uploaded file at ${filePath}.`, cleanupError);
  }
};

const createStoredFileName = (originalFileName) => {
  const extension = path.extname(originalFileName);
  const baseName = path.basename(originalFileName, extension);
  return `${baseName}-${randomUUID()}${extension}`;
};

const isPdfFile = (file) => {
  const extension = path.extname(file.originalname ?? "").toLowerCase();
  const mimeType = String(file.mimetype ?? "").toLowerCase();

  return extension === ".pdf" || mimeType === "application/pdf";
};

const buildContentDisposition = (fileName = "document.pdf") =>
  `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;

const sendBufferedFile = ({ req, res, fileBuffer, fileName, mimeType }) => {
  const totalSize = fileBuffer.byteLength;
  const rangeHeader = req.headers.range?.trim();

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mimeType || "application/pdf");
  res.setHeader("Content-Disposition", buildContentDisposition(fileName));
  res.setHeader("Cache-Control", "private, max-age=300");

  if (!rangeHeader) {
    res.setHeader("Content-Length", String(totalSize));
    res.status(200).end(fileBuffer);
    return;
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);

  if (!match) {
    res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
    return;
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalSize
  ) {
    res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
    return;
  }

  const safeEnd = Math.min(end, totalSize - 1);
  const chunk = fileBuffer.subarray(start, safeEnd + 1);

  res.status(206);
  res.setHeader("Content-Length", String(chunk.byteLength));
  res.setHeader("Content-Range", `bytes ${start}-${safeEnd}/${totalSize}`);
  res.end(chunk);
};

const resolveScopedUserId = (req, rawUserId) =>
  getRequestAccessScope(req).userId || rawUserId?.trim() || "";

const buildChatResponse = async ({
  agentBudget,
  agentRunService,
  arxivImportService,
  capabilityRegistry,
  executionPlannerAdapter,
  intentPlannerAdapter,
  ragService,
  webChatService,
  question,
  docIds,
  sessionId,
  userId,
  accessScope,
  agentRunId,
  capabilityApprovals,
  taskMemory,
  skillRegistry,
}) => {
  const missingDocIds = docIds.filter(
    (docId) => !ragService.getDocument(docId, accessScope)
  );

  if (missingDocIds.length > 0) {
    const error = new Error(
      `Document not found for docId(s): ${missingDocIds.join(
        ", "
      )}. Upload the PDF again and use the latest docId.`
    );
    error.status = 404;
    throw error;
  }

  return runAgentRag({
    agentBudget,
    agentRunService,
    arxivImportService,
    capabilityRegistry,
    ragService,
    webChatService,
    question,
    docIds,
    sessionId,
    userId,
    accessScope,
    agentRunId,
    capabilityApprovals,
    taskMemory,
    executionPlannerAdapter,
    intentPlannerAdapter,
    skillRegistry,
  });
};

export const createApp = async (options = {}) => {
  const uploadsDirectory = options.uploadsDirectory
    ? path.resolve(options.uploadsDirectory)
    : defaultUploadsDirectory;

  if (options.uploadSessionDirectory) {
    configureUploadSessionDirectory(options.uploadSessionDirectory);
  }

  const ragService = {
    chat,
    clearDocuments,
    clearLongMemories,
    clearSessionMemory,
    deleteLongMemory,
    deleteDocument,
    getDocument,
    getDocumentFile,
    ingestDocument,
    initializeDocumentRegistry,
    initializeLongMemory,
    initializeSessionMemory,
    listDocuments,
    listLongMemories,
    rememberLongMemory,
    ...(options.ragService ?? {}),
  };
  const webChatService = options.chatMcp ?? chatMCP;
  const arxivService = options.arxivService ?? createArxivService();
  const arxivImportService = options.arxivImportService ?? createArxivImportService({
    arxivService,
    ragService,
    tempDirectory: path.join(uploadsDirectory, "arxiv-imports"),
  });
  const taskStore = options.taskStore ?? createDefaultTaskStore();
  const taskService = options.taskService ?? createTaskService({
    taskStore,
  });
  const agentRunStore =
    options.agentRunStore ?? createDefaultAgentRunStore();
  const agentRunService =
    options.agentRunService ??
    createAgentRunService({
      agentRunStore,
    });
  const configuredAgentRunRecoveryService = options.agentRunRecoveryService;
  const recommendationTaskService =
    options.recommendationTaskService ??
    createRecommendationTaskService({
      taskService,
    });
  const arxivEnrichmentService =
    options.arxivEnrichmentService ??
    createArxivEnrichmentService({
      arxivImportService,
      arxivService,
      ragService,
      recommendationTaskService,
      recommendationSnapshotStore: options.recommendationSnapshotStore,
    });
  const skillRegistry = options.skillRegistry ?? null;
  const capabilityRegistry =
    options.capabilityRegistry ??
    createDefaultCapabilityRegistry({
      actionTaskService: options.actionTaskService,
      arxivEnrichmentService,
      arxivImportService,
      externalImportService: options.externalImportService,
      ragService,
      recommendationImportService: options.recommendationImportService,
      reportExportService: options.reportExportService,
      taskService,
      webChatService,
    });
  const agentTaskRunner =
    options.agentTaskRunner ??
    createAgentTaskRunner({
      capabilityRegistry,
      runAgentTask: ({
        accessScope,
        agentRunId,
        capabilityApprovals,
        docIds,
        question,
        sessionId,
        taskMemory,
        userId,
      }) =>
        buildChatResponse({
          accessScope,
          agentBudget,
          agentRunId,
          agentRunService,
          arxivImportService,
          capabilityApprovals,
          capabilityRegistry,
          docIds,
          executionPlannerAdapter,
          intentPlannerAdapter,
          question,
          ragService,
          sessionId,
          skillRegistry,
          taskMemory,
          userId,
          webChatService,
        }),
    });
  const jobRunners = {
    ...(arxivEnrichmentService.importJobRunner?.id
      ? {
          [arxivEnrichmentService.importJobRunner.id]:
            arxivEnrichmentService.importJobRunner,
        }
      : {}),
    ...(agentTaskRunner.id
      ? {
          [agentTaskRunner.id]: agentTaskRunner,
        }
      : {}),
    ...(options.jobRunners ?? {}),
  };
  const jobOrchestrator =
    options.jobOrchestrator ??
    createJobOrchestrator({
      runners: jobRunners,
      schedule: options.jobSchedule,
      taskService,
    });
  const agentTaskService =
    options.agentTaskService ??
    createAgentTaskService({
      createTaskId: options.createAgentTaskId,
      jobOrchestrator,
      taskService,
    });
  const agentTriggerRegistry =
    options.agentTriggerRegistry ?? createDefaultAgentTriggerRegistry();
  const agentTriggerDispatcher =
    options.agentTriggerDispatcher ??
    createAgentTriggerDispatcher({
      agentTaskService,
      triggerRegistry: agentTriggerRegistry,
    });
  const agentRunStepExecutor =
    options.agentRunStepExecutor ??
    createAgentRunStepExecutor({
      agentRunService,
      capabilityRegistry,
      executeCustomSkillStep: createCustomSkillStepExecutor({
        ragService,
        skillRegistry,
      }),
      executeDocumentRagStep: createDocumentRagStepExecutor({
        ragService,
      }),
      executeResearchQuestionStep: createResearchQuestionStepExecutor({
        ragService,
      }),
    });
  const agentRunRecoveryService =
    configuredAgentRunRecoveryService ??
    createAgentRunRecoveryService({
      agentRunService,
      agentRunStepExecutor,
    });
  const agentRunRecoveryActionService =
    options.agentRunRecoveryActionService ??
    createAgentRunRecoveryActionService({
      agentRunService,
      agentRunStepExecutor,
    });
  const uploadStore = options.uploadStore ?? {
    clearUploadSession,
    ensureUploadStorage,
    finalizeUploadSession,
    getUploadSessionStatus,
    initializeUploadSession,
    removeMergedUpload,
    storeUploadChunk,
  };
  const healthService = options.healthService ?? {
    buildHealthReport,
    runStartupHealthChecks,
  };
  const qualityService = options.qualityService ?? {
    readLatestQualityReport,
    readQualityHistory,
    runSyntheticQualityEvaluation,
  };
  const feedbackService = options.feedbackService ?? {
    listFeedback,
    recordFeedback,
  };
  const agentExperienceMemoryService = options.agentExperienceMemoryService ?? {
    recordFromFeedback: recordAgentExperienceFromFeedback,
  };
  const agentBudget = options.agentBudget ?? {};
  const executionPlannerAdapter =
    options.executionPlannerAdapter ?? createExecutionPlannerAdapter();
  const intentPlannerAdapter =
    options.intentPlannerAdapter ?? createIntentPlannerAdapter();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDirectory);
    },
    filename: (req, file, cb) => {
      cb(null, createStoredFileName(file.originalname));
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: MAX_DIRECT_UPLOAD_SIZE,
    },
    fileFilter: (req, file, cb) => {
      cb(null, isPdfFile(file));
    },
  });
  const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_CHUNK_UPLOAD_SIZE,
    },
  });

  await mkdir(uploadsDirectory, { recursive: true });
  await uploadStore.ensureUploadStorage();
  await ragService.initializeDocumentRegistry?.();
  await ragService.initializeLongMemory?.();
  await ragService.initializeSessionMemory?.();
  await taskService.initialize?.();
  await agentRunService.initialize?.();
  await agentRunRecoveryService.recoverOnStartup?.({
    mode: getAgentRunRecoveryMode(),
  });
  await jobOrchestrator.recoverRunnableTasks?.();
  await healthService.runStartupHealthChecks?.();

  app.get("/health", async (req, res) => {
    try {
      const report = await healthService.buildHealthReport();
      return res.json(report);
    } catch (error) {
      return res.status(500).json({
        status: "error",
        error: serializeError(error, "Failed to collect health status."),
      });
    }
  });

  app.get("/ready", async (req, res) => {
    try {
      const report = await healthService.buildHealthReport();

      return res.status(report.status === "ok" ? 200 : 503).json(report);
    } catch (error) {
      return res.status(503).json({
        status: "error",
        error: serializeError(error, "Readiness check failed."),
      });
    }
  });

  app.use(requireApiAuth);
  app.use("/uploads", express.static(uploadsDirectory));

  app.get("/documents/:docId/file", async (req, res) => {
    const docId = req.params.docId?.trim();

    if (!docId) {
      return res.status(400).json({
        error: "docId is required.",
      });
    }

    try {
      const storedFile = await ragService.getDocumentFile?.(
        docId,
        getRequestAccessScope(req)
      );

      if (!storedFile) {
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      sendBufferedFile({
        req,
        res,
        fileBuffer: storedFile.fileBuffer,
        fileName: storedFile.fileName,
        mimeType: storedFile.mimeType,
      });
      return;
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to stream the document."),
      });
    }
  });

  app.get("/documents", (req, res) => {
    return res.json(ragService.listDocuments(getRequestAccessScope(req)));
  });

  app.get("/tasks", async (req, res) => {
    try {
      return res.json(
        await taskService.listTasks({
          accessScope: getRequestAccessScope(req),
          type: req.query.type,
        })
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to list tasks."),
      });
    }
  });

  app.get("/tasks/:taskId", async (req, res) => {
    const taskId = req.params.taskId?.trim();

    if (!taskId) {
      return res.status(400).json({
        error: "taskId is required.",
      });
    }

    try {
      const task = await taskService.getTask({
        accessScope: getRequestAccessScope(req),
        taskId,
      });

      if (!task) {
        return res.status(404).json({
          error: "Task not found.",
        });
      }

      return res.json(task);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to read task."),
      });
    }
  });

  app.post("/agent-tasks", async (req, res) => {
    const payload = req.body ?? {};
    const question = payload.question?.trim();

    if (!question) {
      return res.status(400).json({
        error: "Question is required.",
      });
    }

    try {
      const task = await agentTaskService.createTask({
        accessScope: getRequestAccessScope(req),
        docIds: parseDocIds(payload.docIds, payload.docId),
        maxIterations: payload.maxIterations,
        question,
        sessionId: payload.sessionId?.trim() || null,
        userPreferences: payload.userPreferences,
        userId: resolveScopedUserId(req, payload.userId),
      });

      return res.status(202).json({
        task,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to create agent task."),
      });
    }
  });

  app.get("/agent-triggers", async (req, res) => {
    try {
      return res.json({
        triggers: agentTriggerRegistry.listPublic({
          enabledOnly: normalizeBooleanQuery(req.query.enabledOnly),
        }),
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to list agent triggers."),
      });
    }
  });

  app.post("/agent-triggers/:triggerId/dispatch", async (req, res) => {
    const triggerId = req.params.triggerId?.trim();

    if (!triggerId) {
      return res.status(400).json({
        error: "triggerId is required.",
      });
    }

    try {
      const result = await agentTriggerDispatcher.dispatch({
        accessScope: getRequestAccessScope(req),
        triggerId,
        ...buildTriggerDispatchRequest(req),
      });

      return res.status(202).json(result);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to dispatch agent trigger."),
      });
    }
  });

  app.get("/agent-runs", async (req, res) => {
    try {
      return res.json(
        await agentRunService.listRuns({
          accessScope: getRequestAccessScope(req),
          status: req.query.status,
        })
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to list agent runs."),
      });
    }
  });

  app.get("/agent-runs/recovery", async (req, res) => {
    try {
      return res.json(
        await agentRunRecoveryActionService.listRecoveryRuns({
          accessScope: getRequestAccessScope(req),
        })
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to list recoverable agent runs."),
      });
    }
  });

  app.get("/agent-runs/:runId", async (req, res) => {
    const runId = req.params.runId?.trim();

    if (!runId) {
      return res.status(400).json({
        error: "runId is required.",
      });
    }

    try {
      const run = await agentRunService.getRun({
        accessScope: getRequestAccessScope(req),
        runId,
      });

      if (!run) {
        return res.status(404).json({
          error: "Agent run not found.",
        });
      }

      return res.json(run);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to read agent run."),
      });
    }
  });

  app.post(
    "/agent-runs/:runId/recovery/actions/:action",
    async (req, res) => {
      const runId = req.params.runId?.trim();
      const action = req.params.action?.trim();

      if (!runId) {
        return res.status(400).json({
          error: "runId is required.",
        });
      }

      if (!action) {
        return res.status(400).json({
          error: "action is required.",
        });
      }

      try {
        const result = await agentRunRecoveryActionService.applyRecoveryAction({
          accessScope: getRequestAccessScope(req),
          action,
          payload: req.body,
          runId,
        });

        return res.json(result);
      } catch (error) {
        return res.status(error.status ?? 500).json({
          error: serializeError(error, "Failed to recover agent run."),
        });
      }
    }
  );

  app.post("/agent-runs/:runId/actions/:action", async (req, res) => {
    const runId = req.params.runId?.trim();
    const action = req.params.action?.trim();

    if (!runId) {
      return res.status(400).json({
        error: "runId is required.",
      });
    }

    if (!action) {
      return res.status(400).json({
        error: "action is required.",
      });
    }

    try {
      const result = await agentRunStepExecutor.applyApprovalAction({
        accessScope: getRequestAccessScope(req),
        action,
        gateId: req.body.gateId,
        payload: req.body,
        runId,
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to update agent run."),
      });
    }
  });

  app.post("/agent-runs/:runId/steps/:stepId/actions/retry", async (req, res) => {
    const runId = req.params.runId?.trim();
    const stepId = req.params.stepId?.trim();

    if (!runId) {
      return res.status(400).json({
        error: "runId is required.",
      });
    }

    if (!stepId) {
      return res.status(400).json({
        error: "stepId is required.",
      });
    }

    try {
      const result = await agentRunStepExecutor.retryStep({
        accessScope: getRequestAccessScope(req),
        runId,
        stepId,
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to retry agent run step."),
      });
    }
  });

  app.get("/capabilities", (req, res) =>
    res.json({
      capabilities: capabilityRegistry.list?.() ?? [],
    })
  );

  app.post("/tasks/:taskId/actions/:action", async (req, res) => {
    const taskId = req.params.taskId?.trim();
    const action = req.params.action?.trim();

    if (!taskId) {
      return res.status(400).json({
        error: "taskId is required.",
      });
    }

    if (!action) {
      return res.status(400).json({
        error: "action is required.",
      });
    }

    try {
      const task = await jobOrchestrator.resumeTask({
        accessScope: getRequestAccessScope(req),
        action,
        payload: req.body,
        taskId,
      });

      return res.status(202).json({
        task,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to update task."),
      });
    }
  });

  app.delete("/documents/:docId", async (req, res) => {
    const docId = req.params.docId?.trim();

    if (!docId) {
      return res.status(400).json({
        error: "docId is required.",
      });
    }

    try {
      const document = await ragService.deleteDocument(docId, {
        accessScope: getRequestAccessScope(req),
      });

      if (!document) {
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      return res.json({
        deleted: true,
        document,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to delete the document."),
      });
    }
  });

  app.post("/documents/clear", async (req, res) => {
    try {
      const documents = await ragService.clearDocuments({
        accessScope: getRequestAccessScope(req),
      });
      return res.json({
        deletedCount: documents.length,
        documents,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to clear documents."),
      });
    }
  });

  app.get("/arxiv/search", async (req, res) => {
    const topic = req.query.topic?.trim();

    if (!topic) {
      return res.status(400).json({
        error: "topic is required.",
      });
    }

    try {
      const papers = await arxivService.search({
        topic,
        maxResults: normalizeArxivMaxResults(req.query.maxResults),
      });

      return res.json({
        topic,
        papers,
      });
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to search arXiv."),
      });
    }
  });

  app.post("/arxiv/import", async (req, res) => {
    const topic = req.body.topic?.trim();

    if (!topic) {
      return res.status(400).json({
        error: "topic is required.",
      });
    }

    try {
      const result = await arxivImportService.importTopic({
        accessScope: getRequestAccessScope(req),
        topic,
        maxResults: normalizeArxivMaxResults(req.body.maxResults),
      });

      return res.status(201).json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to import arXiv papers."),
      });
    }
  });

  app.get("/documents/:docId/arxiv/suggestions", async (req, res) => {
    const docId = req.params.docId?.trim();

    if (!docId) {
      return res.status(400).json({
        error: "docId is required.",
      });
    }

    try {
      const result = await arxivEnrichmentService.suggestForDocument({
        accessScope: getRequestAccessScope(req),
        docId,
        maxResults: normalizeArxivMaxResults(req.query.maxResults),
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to find arXiv suggestions."),
      });
    }
  });

  app.get("/documents/arxiv/suggestions", async (req, res) => {
    try {
      const result = arxivEnrichmentService.listSavedSuggestions({
        accessScope: getRequestAccessScope(req),
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to list saved arXiv suggestions."),
      });
    }
  });

  app.get("/documents/:docId/arxiv/suggestions/saved", async (req, res) => {
    const docId = req.params.docId?.trim();

    if (!docId) {
      return res.status(400).json({
        error: "docId is required.",
      });
    }

    try {
      const result = arxivEnrichmentService.getSavedSuggestionForDocument({
        accessScope: getRequestAccessScope(req),
        docId,
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to load saved arXiv suggestions."),
      });
    }
  });

  app.post("/documents/:docId/arxiv/import", async (req, res) => {
    const docId = req.params.docId?.trim();

    if (!docId) {
      return res.status(400).json({
        error: "docId is required.",
      });
    }

    try {
      const result = await arxivEnrichmentService.importForDocument({
        accessScope: getRequestAccessScope(req),
        docId,
        selectedArxivIds: req.body.selectedArxivIds,
        selectionToken: req.body.selectionToken,
      });

      return res.status(201).json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to import arXiv suggestions."),
      });
    }
  });

  app.delete("/sessions/:sessionId", async (req, res) => {
    const sessionId = req.params.sessionId?.trim();

    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId is required.",
      });
    }

    try {
      return res.json({
        cleared: await ragService.clearSessionMemory(sessionId),
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to clear session memory."),
      });
    }
  });

  app.get("/memory", async (req, res) => {
    const userId = resolveScopedUserId(req, req.query.userId);
    const limit = Number.parseInt(req.query.limit ?? "50", 10);

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    try {
      const memories = await ragService.listLongMemories({
        userId,
        limit,
      });

      return res.json({
        memories,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load long-term memories."),
      });
    }
  });

  app.post("/memory", async (req, res) => {
    const userId = resolveScopedUserId(req, req.body.userId);
    const text = req.body.text?.trim();

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    if (!text) {
      return res.status(400).json({
        error: "text is required.",
      });
    }

    try {
      const memory = await ragService.rememberLongMemory({
        userId,
        category: req.body.category,
        memoryKey: req.body.memoryKey,
        memoryValue: req.body.memoryValue,
        text,
        source: req.body.source,
        confidence: req.body.confidence,
      });

      return res.status(201).json({
        memory,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to store long-term memory."),
      });
    }
  });

  app.delete("/memory/:memoryId", async (req, res) => {
    const userId = resolveScopedUserId(req, req.query.userId);
    const memoryId = req.params.memoryId?.trim();

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    if (!memoryId) {
      return res.status(400).json({
        error: "memoryId is required.",
      });
    }

    try {
      const memory = await ragService.deleteLongMemory({
        userId,
        memoryId,
      });

      if (!memory) {
        return res.status(404).json({
          error: "Memory not found.",
        });
      }

      return res.json({
        deleted: true,
        memory,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to delete long-term memory."),
      });
    }
  });

  app.delete("/memory", async (req, res) => {
    const userId = resolveScopedUserId(req, req.query.userId);

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    try {
      const deletedCount = await ragService.clearLongMemories({
        userId,
      });

      return res.json({
        deletedCount,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to clear long-term memories."),
      });
    }
  });

  app.get("/quality/latest", async (req, res) => {
    try {
      return res.json(await qualityService.readLatestQualityReport());
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load the latest quality report."),
      });
    }
  });

  app.post("/quality/synthetic", async (req, res) => {
    try {
      return res.json(
        await qualityService.runSyntheticQualityEvaluation({
          corpusPath: req.body.corpusPath,
        })
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to run synthetic evaluation."),
      });
    }
  });

  app.get("/quality/history", async (req, res) => {
    try {
      return res.json(await qualityService.readQualityHistory());
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load quality history."),
      });
    }
  });

  app.get("/feedback", async (req, res) => {
    const limit = Number.parseInt(req.query.limit ?? "25", 10);

    try {
      const feedback = await feedbackService.listFeedback({
        accessScope: getRequestAccessScope(req),
        limit,
      });

      return res.json({
        feedback,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load answer feedback."),
      });
    }
  });

  app.post("/feedback", async (req, res) => {
    try {
      const feedback = buildFeedbackRecord({
        payload: req.body,
        accessScope: getRequestAccessScope(req),
      });
      const storedFeedback = await feedbackService.recordFeedback(feedback);
      let agentExperienceMemory = null;

      try {
        const writeResult = await agentExperienceMemoryService.recordFromFeedback?.({
          feedback: storedFeedback,
        });
        agentExperienceMemory = writeResult?.observability ?? null;
      } catch (error) {
        console.error("Failed to record agent experience from feedback.", error);
        agentExperienceMemory = {
          error: error instanceof Error ? error.message : "write_failed",
          status: "error",
          writeAttempted: true,
        };
      }

      return res.status(201).json({
        agentExperienceMemory,
        feedback: storedFeedback,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to store answer feedback."),
      });
    }
  });

  app.post("/upload/init", async (req, res) => {
    try {
      const session = await uploadStore.initializeUploadSession({
        fileId: req.body.fileId,
        fileName: req.body.fileName,
        fileSize: req.body.fileSize,
        lastModified: req.body.lastModified,
        totalChunks: req.body.totalChunks,
        chunkSize: req.body.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE,
      });

      return res.status(201).json(session);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to initialize the upload session."),
      });
    }
  });

  app.get("/upload/status", async (req, res) => {
    const fileId = req.query.fileId?.trim();

    if (!fileId) {
      return res.status(400).json({
        error: "fileId is required.",
      });
    }

    try {
      const session = await uploadStore.getUploadSessionStatus(fileId);

      if (!session) {
        return res.status(404).json({
          error: "Upload session not found.",
        });
      }

      return res.json(session);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to read the upload session status."),
      });
    }
  });

  app.post("/upload/chunk", chunkUpload.single("chunk"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "No chunk uploaded.",
      });
    }

    try {
      const chunkIndex = Number.parseInt(req.body.chunkIndex, 10);
      const totalChunks = Number.parseInt(req.body.totalChunks, 10);
      const fileId = req.body.fileId?.trim();

      if (!fileId) {
        return res.status(400).json({
          error: "fileId is required.",
        });
      }

      const result = await uploadStore.storeUploadChunk({
        fileId,
        chunkIndex,
        totalChunks,
        chunkBuffer: req.file.buffer,
      });

      return res.status(201).json(result);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to store the uploaded chunk."),
      });
    }
  });

  app.post("/upload/complete", async (req, res) => {
    const fileId = req.body.fileId?.trim();

    if (!fileId) {
      return res.status(400).json({
        error: "fileId is required.",
      });
    }

    let mergedFilePath = null;

    try {
      const session = await uploadStore.getUploadSessionStatus(fileId);

      if (!session) {
        return res.status(404).json({
          error: "Upload session not found.",
        });
      }

      const storedFileName = createStoredFileName(session.fileName);
      mergedFilePath = path.join(uploadsDirectory, storedFileName);
      const accessScope = getRequestAccessScope(req);

      await uploadStore.finalizeUploadSession({
        fileId,
        destinationPath: mergedFilePath,
      });

      const document = await ragService.ingestDocument({
        docId: randomUUID(),
        filePath: mergedFilePath,
        fileName: session.fileName,
        ownerUserId: accessScope.userId,
        workspaceId: accessScope.workspaceId,
      });

      await cleanupUploadedFile(mergedFilePath);
      mergedFilePath = null;
      await uploadStore.clearUploadSession(fileId);

      return res.status(201).json(document);
    } catch (error) {
      await uploadStore.removeMergedUpload(mergedFilePath);

      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to finalize the uploaded PDF."),
      });
    }
  });

  app.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "A PDF file is required.",
      });
    }

    try {
      const accessScope = getRequestAccessScope(req);
      const document = await ragService.ingestDocument({
        docId: randomUUID(),
        filePath: req.file.path,
        fileName: req.file.originalname,
        ownerUserId: accessScope.userId,
        workspaceId: accessScope.workspaceId,
      });

      await cleanupUploadedFile(req.file.path);
      return res.status(201).json(document);
    } catch (error) {
      await cleanupUploadedFile(req.file.path);

      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to ingest uploaded PDF."),
      });
    }
  });

  const handleChatRequest = async (req, res) => {
    const payload = req.method === "GET" ? req.query : req.body;
    const question = payload.question?.trim();
    const docIds = parseDocIds(payload.docIds, payload.docId);
    const sessionId = payload.sessionId?.trim() || null;
    const accessScope = getRequestAccessScope(req);
    const userId = accessScope.userId || payload.userId?.trim() || null;

    if (!question) {
      return res.status(400).json({
        error: "Question is required.",
      });
    }

    try {
      const response = await buildChatResponse({
        agentBudget,
        agentRunService,
        arxivImportService,
        capabilityRegistry,
        ragService,
        webChatService,
        question,
        docIds,
        sessionId,
        userId,
        accessScope,
        executionPlannerAdapter,
        intentPlannerAdapter,
        skillRegistry,
      });

      return res.status(response.status).json(response.body);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to answer the question."),
      });
    }
  };

  app.get("/chat", handleChatRequest);
  app.post("/chat", handleChatRequest);

  return app;
};
