import { createAgentSession } from "./agent-bootstrap.js";
import { runDocumentRagLoop } from "./agent-document-loop.js";
import { finalizeAgentRun } from "./agent-finalization-flow.js";
import { prepareAgentRun } from "./agent-preparation-flow.js";
import {
  runCustomSkills,
  runDocumentDiscoverySkill,
  runInventorySkill,
  runResearchBriefSkill,
  runWebSearchSkill,
} from "./agent-skill-runners.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";

export const runAgentRag = async ({
  agentBudget,
  ragService,
  webChatService,
  question,
  docIds,
  sessionId,
  userId,
  accessScope,
  skillRegistry,
}) => {
  const {
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildAgentObservability,
    buildSkillTraceDetail,
    chainSkills,
    executeObservedSkill,
    executionLoop,
    getAgentSkills,
    getBudgetSnapshot,
    getSelectedSkill,
    plan,
    recordAgentTrace,
    recordExecutionGaps,
    recordSkillResult,
    recordSkippedSkill,
    recordWorkingMemoryClaimSupport,
    recordWorkingMemoryGaps,
    registry,
    resolveWorkingMemoryGaps,
    returnClarification,
    selectedSkills,
    setAgentRetrievalPlan,
    trace,
    workingMemory,
  } = createAgentSession({
    agentBudget,
    docIds,
    question,
    skillRegistry,
  });

  const preparationResult = await prepareAgentRun({
    addTraceStep,
    chainSkills,
    docIds,
    getBudgetSnapshot,
    plan,
    question,
    returnClarification,
    selectedSkills,
    setAgentRetrievalPlan,
  });

  if (preparationResult.response) {
    return preparationResult.response;
  }

  let inventoryAnswer = null;
  let discoveryAnswer = null;
  let researchBrief = null;
  let ragResult = null;
  let webResult = null;
  let customSkillResults = [];
  const agentRetrievalPlan = preparationResult.agentRetrievalPlan;

  const researchSkill = getSelectedSkill(AGENT_SKILL_IDS.researchBrief);
  researchBrief = await runResearchBriefSkill({
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

  const inventorySkill = getSelectedSkill(AGENT_SKILL_IDS.inventory);
  inventoryAnswer = await runInventorySkill({
    accessScope,
    addTraceStep,
    buildSkillTraceDetail,
    executeObservedSkill,
    inventorySkill,
    ragService,
    recordSkillResult,
  });

  const discoverySkill = getSelectedSkill(AGENT_SKILL_IDS.documentDiscovery);
  discoveryAnswer = await runDocumentDiscoverySkill({
    accessScope,
    addTraceStep,
    buildSkillTraceDetail,
    discoverySkill,
    docIds,
    executeObservedSkill,
    question,
    ragService,
    recordSkillResult,
  });

  const customSkills = selectedSkills.filter((skill) => skill.kind === "custom");
  customSkillResults = await runCustomSkills({
    accessScope,
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildSkillTraceDetail,
    customSkills,
    docIds,
    executeObservedSkill,
    plan,
    question,
    ragService,
    recordSkippedSkill,
    recordSkillResult,
    retrievalPlan: agentRetrievalPlan,
    sessionId,
    userId,
  });

  const documentRagSkill = getSelectedSkill(AGENT_SKILL_IDS.documentRag);
  const documentLoopResult = await runDocumentRagLoop({
    accessScope,
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildSkillTraceDetail,
    docIds,
    documentRagSkill,
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
    retrievalPlan: agentRetrievalPlan,
    sessionId,
    userId,
  });
  ragResult = documentLoopResult.ragResult;
  const documentEvidenceClarification =
    documentLoopResult.documentEvidenceClarification;

  if (documentEvidenceClarification && !plan.wantsWeb) {
    return returnClarification(documentEvidenceClarification);
  }

  const plannedWebSearchSkill = getSelectedSkill(AGENT_SKILL_IDS.webSearch);
  const webSearchSkill = plannedWebSearchSkill ?? registry.get(AGENT_SKILL_IDS.webSearch);
  const shouldRunWeb =
    Boolean(webSearchSkill) &&
    (Boolean(plannedWebSearchSkill) ||
      (ragResult?.ok && ragResult.value.abstained) ||
      ragResult?.ok === false);
  const webSearchResult = await runWebSearchSkill({
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildSkillTraceDetail,
    executeObservedSkill,
    plannedWebSearchSkill,
    question,
    recordSkippedSkill,
    recordSkillResult,
    shouldRunWeb,
    webChatService,
    webSearchSkill,
  });
  webResult = webSearchResult.webResult;
  const skippedWebBecauseBudget = webSearchResult.skippedWebBecauseBudget;

  return finalizeAgentRun({
    addTraceStep,
    buildAgentObservability,
    customSkillResults,
    customSkills,
    discoveryAnswer,
    documentRagSkill,
    getAgentSkills,
    getBudgetSnapshot,
    inventoryAnswer,
    plan,
    question,
    ragResult,
    recordAgentTrace,
    recordWorkingMemoryClaimSupport,
    researchBrief,
    shouldRunWeb,
    skippedWebBecauseBudget,
    trace,
    webResult,
    workingMemory,
  });
};
