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
} from "./agent-built-in-skill-runners.js";
import { runCustomSkills } from "./agent-custom-skill-runner.js";
import { runWebSearchSkill } from "./agent-web-runner.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";

const getCustomSkills = (selectedSkills = []) =>
  selectedSkills.filter((skill) => skill.kind === "custom");

export const runAgentExecutionPlan = async ({
  accessScope,
  addBudgetLimitTrace,
  addTraceStep,
  arxivImportService,
  budgetState,
  buildSkillTraceDetail,
  capabilityRegistry,
  docIds,
  executeObservedSkill,
  executionLoop,
  executionPlan = createDeterministicAgentExecutionPlan(),
  getSelectedSkill,
  plan,
  question,
  ragService,
  recordExecutionGaps,
  recordSkippedSkill,
  recordSkillResult,
  recordWorkingMemoryClaimSupport,
  recordWorkingMemoryGaps,
  registry,
  resolveWorkingMemoryGaps,
  retrievalPlan,
  returnClarification,
  selectedSkills = [],
  sessionId,
  stepLifecycle,
  userId,
  webChatService,
} = {}) => {
  const validatedExecutionPlan = validateAgentExecutionPlan({
    accessScope,
    executionPlan,
    registry,
    selectedSkills,
  });
  const state = {
    arxivImportAnswer: null,
    customSkillResults: [],
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
      });
    },

    [AGENT_EXECUTION_STEP_IDS.customSkills]: async () => {
      state.customSkillResults = await runCustomSkills({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        customSkills: state.customSkills,
        docIds,
        executeObservedSkill,
        plan,
        question,
        ragService,
        recordSkippedSkill,
        recordSkillResult,
        retrievalPlan,
        sessionId,
        userId,
      });
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
