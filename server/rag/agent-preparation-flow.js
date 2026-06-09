import {
  buildPlannerActions,
  buildPreExecutionClarification,
  buildSkillChainSummary,
} from "./agent-planner.js";
import { buildAgentRetrievalPlan } from "./agent-query-planner.js";
import { getSkillDescriptor } from "./agent-skill-observability.js";
import { buildQueryPlannerSummary } from "./agent-trace.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";

export const shouldPlanAgentRetrieval = (selectedSkills = []) =>
  selectedSkills.some(
    (skill) => skill.id === AGENT_SKILL_IDS.documentRag || skill.kind === "custom"
  );

export const prepareAgentRun = async ({
  addTraceStep,
  chainSkills = [],
  docIds = [],
  getBudgetSnapshot,
  plan,
  question,
  returnClarification,
  selectedSkills = [],
  setAgentRetrievalPlan,
} = {}) => {
  addTraceStep({
    type: "plan",
    label: "Plan",
    summary: plan.summary,
    detail: {
      mode: plan.mode,
      docIds,
      budget: getBudgetSnapshot(),
      actions: buildPlannerActions({
        plan,
        docIds,
        skills: selectedSkills,
      }),
    },
  });

  const preExecutionClarification = buildPreExecutionClarification({
    plan,
    docIds,
  });

  if (preExecutionClarification) {
    return {
      agentRetrievalPlan: null,
      response: await returnClarification(preExecutionClarification),
    };
  }

  const agentRetrievalPlan = setAgentRetrievalPlan(
    shouldPlanAgentRetrieval(selectedSkills)
      ? buildAgentRetrievalPlan({
          question,
          plan,
          docIds,
        })
      : null
  );

  if (agentRetrievalPlan) {
    addTraceStep({
      type: "query_planner",
      label: "Query Planner",
      summary: buildQueryPlannerSummary(agentRetrievalPlan),
      detail: agentRetrievalPlan,
    });
  }

  if (chainSkills.length > 0) {
    addTraceStep({
      type: "skill_chain",
      label: "Skill Chain",
      summary: buildSkillChainSummary({
        chainSkills,
      }),
      detail: {
        mode: plan.mode,
        skills: chainSkills.map((skill) => getSkillDescriptor(skill)),
      },
    });
  }

  return {
    agentRetrievalPlan,
    response: null,
  };
};
