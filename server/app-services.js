import path from "path";

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
import { listFeedback, recordFeedback } from "./feedback.js";
import { buildHealthReport, runStartupHealthChecks } from "./health.js";
import { createArxivEnrichmentService } from "./rag/arxiv-enrichment.js";
import { createArxivService } from "./rag/arxiv-client.js";
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
import { createAdminActionRegistry } from "./rag/admin-actions.js";
import { createDefaultAdminAuditService } from "./rag/admin-audit-store.js";
import { createAdminStatusService } from "./rag/admin-status.js";
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
  createDefaultWorkspaceArtifactStore,
  createWorkspaceArtifactService,
} from "./rag/workspace-artifacts/index.js";
import {
  getAgentExecutionPlanner,
  getAgentIntentPlanner,
  getAgentPlannerRollout,
} from "./rag/config.js";
import {
  claimUploadSessionFinalization,
  cleanupExpiredUploadSessions,
  clearUploadSession,
  ensureUploadStorage,
  finalizeUploadSession,
  getUploadSessionStatus,
  initializeUploadSession,
  recoverInterruptedUploadFinalizations,
  releaseUploadSessionFinalization,
  removeMergedUpload,
  storeUploadChunk,
} from "./upload-session-store.js";

export const createRolloutPlannerAdapter = ({
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

export const createExecutionPlannerAdapter = () =>
  createRolloutPlannerAdapter({
    configuredPlanner: () =>
      getAgentExecutionPlanner() === "llm"
        ? llmPlannerAdapter
        : deterministicPlannerAdapter,
    deterministicPlanner: deterministicPlannerAdapter,
    llmPlanner: llmPlannerAdapter,
  });

export const createIntentPlannerAdapter = () =>
  createRolloutPlannerAdapter({
    configuredPlanner: () =>
      getAgentIntentPlanner() === "llm"
        ? llmIntentPlannerAdapter
        : deterministicIntentPlannerAdapter,
    deterministicPlanner: deterministicIntentPlannerAdapter,
    llmPlanner: llmIntentPlannerAdapter,
  });

export const buildChatResponse = async ({
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

export const createAppServices = (options = {}, { uploadsDirectory }) => {
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
  const workspaceArtifactStore =
    options.workspaceArtifactStore ?? createDefaultWorkspaceArtifactStore();
  const workspaceArtifactService =
    options.workspaceArtifactService ??
    createWorkspaceArtifactService({
      store: workspaceArtifactStore,
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
      connectorExecutors: options.connectorExecutors,
      connectorRegistry: options.connectorRegistry,
      connectors: options.connectors,
      externalImportService: options.externalImportService,
      ragService,
      recommendationImportService: options.recommendationImportService,
      reportExportService: options.reportExportService,
      taskService,
      webChatService,
      workspaceArtifactService,
    });
  const agentBudget = options.agentBudget ?? {};
  const executionPlannerAdapter =
    options.executionPlannerAdapter ?? createExecutionPlannerAdapter();
  const intentPlannerAdapter =
    options.intentPlannerAdapter ?? createIntentPlannerAdapter();
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
    claimUploadSessionFinalization,
    cleanupExpiredUploadSessions,
    clearUploadSession,
    ensureUploadStorage,
    finalizeUploadSession,
    getUploadSessionStatus,
    initializeUploadSession,
    recoverInterruptedUploadFinalizations,
    releaseUploadSessionFinalization,
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
  const adminStatusService =
    options.adminStatusService ??
    createAdminStatusService({
      agentRunRecoveryActionService,
      agentRunService,
      healthService,
      llmOpsService: options.llmOpsService,
      qualityService,
      taskService,
      triggerRegistry: agentTriggerRegistry,
    });
  const adminActionRegistry =
    options.adminActionRegistry ??
    createAdminActionRegistry({
      agentRunRecoveryActionService,
      jobOrchestrator,
      qualityService,
    });
  const adminAuditService =
    options.adminAuditService ?? createDefaultAdminAuditService();
  const agentExperienceMemoryService = options.agentExperienceMemoryService ?? {
    recordFromFeedback: recordAgentExperienceFromFeedback,
  };

  return {
    adminActionRegistry,
    adminAuditService,
    adminStatusService,
    agentBudget,
    agentExperienceMemoryService,
    agentRunRecoveryActionService,
    agentRunRecoveryService,
    agentRunService,
    agentRunStepExecutor,
    agentTaskRunner,
    agentTaskService,
    agentTriggerDispatcher,
    agentTriggerRegistry,
    arxivEnrichmentService,
    arxivImportService,
    arxivService,
    buildChatResponse,
    capabilityRegistry,
    executionPlannerAdapter,
    feedbackService,
    healthService,
    intentPlannerAdapter,
    jobOrchestrator,
    jobRunners,
    qualityService,
    ragService,
    recommendationTaskService,
    skillRegistry,
    taskService,
    uploadStore,
    uploadsDirectory,
    webChatService,
    workspaceArtifactService,
  };
};
