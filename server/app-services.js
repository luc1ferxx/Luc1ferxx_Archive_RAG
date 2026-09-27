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
  isDocumentRegistryShared,
  listDocuments,
  listLongMemories,
  loadDocumentsFromStore,
  refreshDocumentRegistry,
  rememberLongMemory,
  resyncDocument,
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
import { resumeAgentExecutionGraphRun, runAgentRag } from "./rag/agent.js";
import { deterministicPlannerAdapter } from "./rag/agent-execution-plan.js";
import {
  DAG_PLANNER_IDS,
  dagPlannerAdapter,
  deterministicDagPlannerAdapter,
} from "./rag/agent-dag-planner-adapter.js";
import { replanAdapter } from "./rag/agent-replan-adapter.js";
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
import { createDefaultIngestJobStore } from "./rag/ingest-job-store.js";
import {
  loadDocumentsIngestedElsewhere,
  refreshDocumentsIngestedElsewhere,
} from "./rag/ingest-worker.js";
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

// Planning a typed DAG is still execution planning, so it reads the dial the
// operator already set for V1 rather than adding a second switch that could be
// pointed somewhere else by accident. Under the `shadow` rollout the
// deterministic graph stays primary and the model plans beside it, which is the
// same bargain the V1 planner makes.
export const createDagPlannerAdapter = () =>
  createRolloutPlannerAdapter({
    configuredPlanner: () =>
      getAgentExecutionPlanner() === "llm"
        ? dagPlannerAdapter
        : deterministicDagPlannerAdapter,
    deterministicPlanner: deterministicDagPlannerAdapter,
    llmPlanner: dagPlannerAdapter,
  });

/**
 * The replanner exists only where a model is already planning for real.
 *
 * There is no deterministic replanner to fall back to, so wherever the operator
 * has pinned planning to the deterministic graph -- or kept the model in shadow
 * -- a replan would be the one path that let a model shape an executed plan
 * anyway. Reading the resolved planner's id keeps that decision in one place
 * instead of restating the rollout branches here.
 */
export const createReplanAdapter = (
  resolvedDagPlannerAdapter = createDagPlannerAdapter()
) => (resolvedDagPlannerAdapter?.id === DAG_PLANNER_IDS.llm ? replanAdapter : null);

export const buildChatResponse = async ({
  agentBudget,
  agentRunService,
  arxivImportService,
  capabilityRegistry,
  dagPlannerAdapter: requestDagPlannerAdapter,
  executionPlannerAdapter,
  intentPlannerAdapter,
  ragService,
  replanAdapter: requestReplanAdapter,
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
  unifiedGraphPlannerAdapter,
}) => {
  const findMissingDocIds = () =>
    docIds.filter((docId) => !ragService.getDocument(docId, accessScope));

  // With a PostgreSQL registry other API instances and ingest workers add and
  // delete documents behind this process's map. The run starts from the
  // tenant's rows as the store has them, so the 404 check below and every
  // listing inside the run (skills, capabilities, the workspace inventory) see
  // another instance's upload and do not offer a document it deleted. A miss
  // left after that (a document outside the tenant's listing) is read by id.
  // Neither reads anything with a single-writer registry (ingest-worker.js).
  await refreshDocumentsIngestedElsewhere(ragService, accessScope);
  let missingDocIds = findMissingDocIds();

  if (missingDocIds.length > 0) {
    await loadDocumentsIngestedElsewhere(ragService, missingDocIds);
    missingDocIds = findMissingDocIds();
  }

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
    dagPlannerAdapter: requestDagPlannerAdapter,
    replanAdapter: requestReplanAdapter,
    skillRegistry,
    unifiedGraphPlannerAdapter,
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
    isDocumentRegistryShared,
    listDocuments,
    listLongMemories,
    loadDocumentsFromStore,
    refreshDocumentRegistry,
    rememberLongMemory,
    resyncDocument,
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
  const resolvedDagPlannerAdapter =
    options.dagPlannerAdapter ?? createDagPlannerAdapter();
  const resolvedReplanAdapter =
    options.replanAdapter ?? createReplanAdapter(resolvedDagPlannerAdapter);
  // No implicit model route for the all-stage graph while its production
  // execution/recovery path is incomplete. Tests and later rollout wiring may
  // supply an explicit proposal adapter for shadow observation.
  const unifiedGraphPlannerAdapter = options.unifiedGraphPlannerAdapter ?? null;
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
          dagPlannerAdapter: resolvedDagPlannerAdapter,
          docIds,
          executionPlannerAdapter,
          intentPlannerAdapter,
          question,
          ragService,
          replanAdapter: resolvedReplanAdapter,
          sessionId,
          skillRegistry,
          taskMemory,
          unifiedGraphPlannerAdapter,
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
      resumeExecutionGraph: ({ accessScope, checkpoint, run, runId }) =>
        resumeAgentExecutionGraphRun({
          accessScope,
          agentRunService,
          checkpoint,
          ragService,
          replanAdapter: resolvedReplanAdapter,
          run,
          runId,
          skillRegistry,
        }),
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
  // Shared by the upload routes and, in this process, the worker server.js
  // starts; the in-memory store (no PostgreSQL) only works that way.
  const ingestJobStore = options.ingestJobStore ?? createDefaultIngestJobStore();
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
    dagPlannerAdapter: resolvedDagPlannerAdapter,
    executionPlannerAdapter,
    feedbackService,
    healthService,
    ingestJobStore,
    intentPlannerAdapter,
    jobOrchestrator,
    jobRunners,
    qualityService,
    ragService,
    recommendationTaskService,
    replanAdapter: resolvedReplanAdapter,
    skillRegistry,
    taskService,
    unifiedGraphPlannerAdapter,
    uploadStore,
    uploadsDirectory,
    webChatService,
    workspaceArtifactService,
  };
};
