import {
  appendTraceStep,
  buildBudgetLimitStep,
  createAgentBudget,
  getBudgetSnapshot as getAgentBudgetSnapshot,
} from "./agent-budget.js";
import { buildClarificationResponse } from "./agent-response-builder.js";
import { getSkillDescriptor } from "./agent-skill-observability.js";
import { buildAgentTraceSummary, buildStep } from "./agent-trace.js";
import { recordRagTrace } from "./observability.js";

const defaultSkillTracker = {
  getAgentSkills: () => [],
  getSkillObservations: () => [],
  getSkillRuns: () => [],
};

export const createAgentRunContext = ({
  agentBudget,
  chainSkills = [],
  docIds = [],
  executionLoop,
  plan,
  question,
  recordTrace = recordRagTrace,
  selectedSkills = [],
  timestamp = () => new Date().toISOString(),
  workingMemory,
} = {}) => {
  const trace = [];
  const budgetState = createAgentBudget(agentBudget);
  let agentRetrievalPlan = null;
  let skillTracker = defaultSkillTracker;

  const getBudgetSnapshot = () => getAgentBudgetSnapshot(budgetState);

  const addTraceStep = (step) =>
    appendTraceStep({
      budgetState,
      trace,
      step: buildStep({
        index: trace.length + 1,
        ...step,
      }),
    });

  const addBudgetLimitTrace = ({ reason, tool }) =>
    appendTraceStep({
      budgetState,
      trace,
      step: buildBudgetLimitStep({
        index: trace.length + 1,
        reason,
        tool,
      }),
    });

  const setSkillTracker = (tracker = {}) => {
    skillTracker = {
      ...defaultSkillTracker,
      ...tracker,
    };
  };

  const setAgentRetrievalPlan = (retrievalPlan) => {
    agentRetrievalPlan = retrievalPlan;
    return agentRetrievalPlan;
  };

  const getAgentRetrievalPlan = () => agentRetrievalPlan;

  const buildAgentObservability = ({ agentMode }) => ({
    agentMode,
    planMode: plan.mode,
    skillChain: chainSkills.map((skill) => getSkillDescriptor(skill)),
    executionLoop,
    workingMemory,
    selectedSkills: selectedSkills.map((skill) => getSkillDescriptor(skill)),
    skills: skillTracker.getSkillObservations(),
    runs: skillTracker.getSkillRuns(),
    budget: getBudgetSnapshot(),
  });

  const recordAgentTrace = async ({
    agentMode,
    agentObservability,
    agentSkills,
    status,
  }) =>
    recordTrace({
      traceType: "agent",
      timestamp: timestamp(),
      agentMode,
      planMode: plan.mode,
      docIds,
      agentSkills,
      agentObservability,
      agentRetrievalPlan,
      agentTraceSummary: buildAgentTraceSummary(trace),
      status,
    });

  const returnClarification = async (clarification) => {
    const agentMode = "clarification";

    addTraceStep({
      type: "clarification_gate",
      label: "Clarification Gate",
      status: "needs_input",
      summary: clarification.summary,
      detail: {
        reason: clarification.reason,
        clarificationQuestion: clarification.question,
        ...(clarification.detail ?? {}),
      },
    });

    const agentObservability = buildAgentObservability({
      agentMode,
    });
    const status = 200;
    const agentSkills = skillTracker.getAgentSkills();

    await recordAgentTrace({
      agentMode,
      agentObservability,
      agentSkills,
      status,
    });

    return buildClarificationResponse({
      clarification,
      agentMode,
      trace,
      agentSkills,
      agentObservability,
      workingMemory,
      question,
    });
  };

  return {
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildAgentObservability,
    getAgentRetrievalPlan,
    getBudgetSnapshot,
    recordAgentTrace,
    returnClarification,
    setAgentRetrievalPlan,
    setSkillTracker,
    trace,
  };
};
