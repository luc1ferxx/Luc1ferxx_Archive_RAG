import { createAgentSession } from "./agent-bootstrap.js";
import { deterministicPlannerAdapter } from "./agent-execution-plan.js";
import { runAgentExecutionPlan } from "./agent-execution-plan-runner.js";
import { finalizeAgentRun } from "./agent-finalization-flow.js";
import { prepareAgentRun } from "./agent-preparation-flow.js";

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

  const agentRetrievalPlan = preparationResult.agentRetrievalPlan;
  const executionPlan = deterministicPlannerAdapter.createExecutionPlan({
    plan,
    selectedSkills,
  });
  const executionResult = await runAgentExecutionPlan({
    accessScope,
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildSkillTraceDetail,
    docIds,
    executeObservedSkill,
    executionLoop,
    executionPlan,
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
    retrievalPlan: agentRetrievalPlan,
    returnClarification,
    selectedSkills,
    sessionId,
    userId,
    webChatService,
  });

  if (executionResult.response) {
    return executionResult.response;
  }

  return finalizeAgentRun({
    addTraceStep,
    buildAgentObservability,
    customSkillResults: executionResult.customSkillResults,
    customSkills: executionResult.customSkills,
    discoveryAnswer: executionResult.discoveryAnswer,
    documentRagSkill: executionResult.documentRagSkill,
    getAgentSkills,
    getBudgetSnapshot,
    inventoryAnswer: executionResult.inventoryAnswer,
    plan,
    question,
    ragResult: executionResult.ragResult,
    recordAgentTrace,
    recordWorkingMemoryClaimSupport,
    researchBrief: executionResult.researchBrief,
    shouldRunWeb: executionResult.shouldRunWeb,
    skippedWebBecauseBudget: executionResult.skippedWebBecauseBudget,
    trace,
    webResult: executionResult.webResult,
    workingMemory,
  });
};
