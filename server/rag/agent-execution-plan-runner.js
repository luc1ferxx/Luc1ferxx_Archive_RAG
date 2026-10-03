import { runDocumentRagLoop } from "./agent-document-loop.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import {
  AGENT_EXECUTION_STEP_IDS,
  createDeterministicAgentExecutionPlan,
  validateAgentExecutionPlan,
} from "./agent-execution-plan.js";
import {
  runArxivImportSkill,
  runDocumentDiscoverySkill,
  runInventorySkill,
  runResearchBriefSkill,
  runWorkspaceActionSkill,
} from "./agent-built-in-skill-runners.js";
import { runCustomSkillStage } from "./agent-custom-skill-stage.js";
import { runWebSearchSkill } from "./agent-web-runner.js";
import { toDependencyOutageError } from "./dependency-outage.js";
import { throwIfRequestCancelled } from "./request-deadline.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";

const getCustomSkills = (selectedSkills = []) =>
  selectedSkills.filter((skill) => skill.kind === "custom");

// A stage whose every Skill failed because a dependency is down produced
// nothing to answer with: the run ends with that outage (dependency-outage.js)
// instead of finalizing an empty answer.
const findWholeStageOutage = (results = []) => {
  if (results.length === 0 || results.some((result) => result?.ok !== false)) {
    return null;
  }

  const outages = results.map((result) => toDependencyOutageError(result.error));

  return outages.every(Boolean) ? outages[0] : null;
};

export const runAgentExecutionPlan = async ({
  accessScope,
  addBudgetLimitTrace,
  addTraceStep,
  agentRunId,
  authorizedCustomSkills = null,
  arxivImportService,
  budgetState,
  buildSkillTraceDetail,
  capabilityRegistry,
  dagPlannerAdapter = null,
  docIds,
  executeObservedSkill,
  executionLoop,
  executionPlan = createDeterministicAgentExecutionPlan(),
  getSelectedSkill,
  loadExecutionGraphCheckpoint = null,
  plan,
  question,
  ragService,
  recordExecutionGaps,
  recordExecutionGraph,
  recordSkippedSkill,
  recordSkillResult,
  recordWorkingMemoryClaimSupport,
  recordWorkingMemoryGaps,
  registry,
  replanAdapter = null,
  resolveWorkingMemoryGaps,
  retrievalPlan,
  returnClarification,
  selectedSkills = [],
  sessionId,
  saveExecutionGraphCheckpoint = null,
  skillGraphMode,
  stepLifecycle,
  taskMemory = null,
  userId,
  webChatService,
} = {}) => {
  const validatedExecutionPlan = validateAgentExecutionPlan({
    accessScope,
    authorizedCustomSkills: authorizedCustomSkills ?? [],
    executionPlan,
    registry,
    selectedSkills,
  });
  const state = {
    arxivImportAnswer: null,
    actionAnswer: null,
    customSkillResults: [],
    customSkillGraphExecuted: false,
    customSkills: getCustomSkills(selectedSkills),
    discoveryAnswer: null,
    documentEvidenceClarification: null,
    documentRagSkill: null,
    inventoryAnswer: null,
    ragResult: null,
    researchBrief: null,
    response: null,
    shouldRunWeb: false,
    skippedWebBecauseBudget: false,
    webResult: null,
  };

  const stepHandlers = {
    [AGENT_EXECUTION_STEP_IDS.arxivImport]: async () => {
      const arxivImportSkill = getSelectedSkill(AGENT_SKILL_IDS.arxivImport);

      state.arxivImportAnswer = await runArxivImportSkill({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        arxivImportService,
        arxivImportSkill,
        budgetState,
        buildSkillTraceDetail,
        capabilityRegistry,
        executeObservedSkill,
        question,
        recordSkippedSkill,
        recordSkillResult,
        stepLifecycle,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.workspaceAction]: async () => {
      const workspaceActionSkill = getSelectedSkill(
        AGENT_SKILL_IDS.workspaceAction
      );

      state.actionAnswer = await runWorkspaceActionSkill({
        accessScope,
        addTraceStep,
        agentRunId,
        buildSkillTraceDetail,
        capabilityRegistry,
        docIds,
        executeObservedSkill,
        plan,
        question,
        recordSkillResult,
        workspaceActionSkill,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.researchBrief]: async () => {
      const researchSkill = getSelectedSkill(AGENT_SKILL_IDS.researchBrief);

      state.researchBrief = await runResearchBriefSkill({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        docIds,
        executeObservedSkill,
        question,
        ragService,
        recordSkillResult,
        researchSkill,
        sessionId,
        stepLifecycle,
        userId,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.inventory]: async () => {
      const inventorySkill = getSelectedSkill(AGENT_SKILL_IDS.inventory);

      state.inventoryAnswer = await runInventorySkill({
        accessScope,
        addTraceStep,
        buildSkillTraceDetail,
        capabilityRegistry,
        executeObservedSkill,
        inventorySkill,
        ragService,
        recordSkillResult,
        stepLifecycle,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.documentDiscovery]: async () => {
      const discoverySkill = getSelectedSkill(AGENT_SKILL_IDS.documentDiscovery);

      state.discoveryAnswer = await runDocumentDiscoverySkill({
        accessScope,
        addTraceStep,
        buildSkillTraceDetail,
        capabilityRegistry,
        discoverySkill,
        docIds,
        executeObservedSkill,
        question,
        ragService,
        recordSkillResult,
        stepLifecycle,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.customSkills]: async () => {
      // Still one stage, still custom_skill steps, still a flat result array.
      // Everything the rollout dial changes happens inside runCustomSkillStage,
      // so this call site does not learn whether a chain or a graph ran.
      state.customSkillResults = await runCustomSkillStage({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        authorizedCustomSkills,
        customSkills: state.customSkills,
        docIds,
        executeObservedSkill,
        loadExecutionGraphCheckpoint,
        plan,
        plannerAdapter: dagPlannerAdapter,
        question,
        ragService,
        recordExecutionGraph: (event) => {
          state.customSkillGraphExecuted =
            event?.mode === "guarded" && event?.executed === true;
          return recordExecutionGraph?.(event);
        },
        recordSkippedSkill,
        recordSkillResult,
        registry,
        replanAdapter,
        retrievalPlan,
        saveExecutionGraphCheckpoint,
        sessionId,
        stepLifecycle,
        taskMemory,
        userId,
        ...(skillGraphMode ? { mode: skillGraphMode } : {}),
      });

      const outage = findWholeStageOutage(state.customSkillResults);

      if (outage) {
        throw outage;
      }
    },

    [AGENT_EXECUTION_STEP_IDS.documentRag]: async () => {
      state.documentRagSkill = getSelectedSkill(AGENT_SKILL_IDS.documentRag);

      const documentLoopResult = await runDocumentRagLoop({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        docIds,
        documentRagSkill: state.documentRagSkill,
        executeObservedSkill,
        executionLoop,
        plan,
        question,
        ragService,
        recordExecutionGaps,
        recordSkippedSkill,
        recordSkillResult,
        recordWorkingMemoryClaimSupport,
        recordWorkingMemoryGaps,
        resolveWorkingMemoryGaps,
        retrievalPlan,
        sessionId,
        stepLifecycle,
        userId,
      });

      state.ragResult = documentLoopResult.ragResult;
      state.documentEvidenceClarification =
        documentLoopResult.documentEvidenceClarification;

      if (state.documentEvidenceClarification && !plan.wantsWeb) {
        state.response = await returnClarification(
          state.documentEvidenceClarification
        );
      }
    },

    [AGENT_EXECUTION_STEP_IDS.webSearch]: async () => {
      const plannedWebSearchSkill = getSelectedSkill(AGENT_SKILL_IDS.webSearch);
      const webSearchSkill =
        plannedWebSearchSkill ??
        registry?.get?.(AGENT_SKILL_IDS.webSearch) ??
        null;

      state.shouldRunWeb =
        Boolean(webSearchSkill) &&
        (Boolean(plannedWebSearchSkill) ||
          (state.ragResult?.ok && state.ragResult.value.abstained) ||
          state.ragResult?.ok === false);

      const webSearchResult = await runWebSearchSkill({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        capabilityRegistry,
        executeObservedSkill,
        plannedWebSearchSkill,
        question,
        recordSkippedSkill,
        recordSkillResult,
        shouldRunWeb: state.shouldRunWeb,
        stepLifecycle,
        webChatService,
        webSearchSkill,
      });

      state.webResult = webSearchResult.webResult;
      state.skippedWebBecauseBudget = webSearchResult.skippedWebBecauseBudget;
    },
  };

  for (const step of validatedExecutionPlan) {
    const runStep = stepHandlers[step.id];

    if (!runStep) {
      throw new Error(`Unknown AgentRAG execution step: ${step.id}.`);
    }

    try {
      // Each stage boundary is a safe point for a cancelled request
      // (request-deadline.js); inside a stage, step starts are.
      throwIfRequestCancelled();
      await runStep(step);
    } catch (error) {
      if (isAgentRunInterrupt(error)) {
        error.agentExecutionState = state;
      }

      throw error;
    }

    if (state.response) {
      return state;
    }
  }

  return state;
};
