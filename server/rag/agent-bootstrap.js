import { createAgentRunContext } from "./agent-run-context.js";
import {
  createAgentSkillTracker,
} from "./agent-skill-observability.js";
import { createAgentWorkingMemory } from "./agent-working-memory.js";
import { buildPlan } from "./agent-intent-planner.js";
import {
  orderSelectedSkills,
} from "./agent-planner.js";
import { createDefaultSkillRegistry } from "./skills/registry.js";

export const DEFAULT_AGENT_MAX_FOLLOW_UPS = 1;

export const createAgentSession = ({
  agentBudget,
  docIds = [],
  experienceMemory = null,
  intentPlanner,
  maxFollowUps = DEFAULT_AGENT_MAX_FOLLOW_UPS,
  plan: providedPlan,
  question,
  skillRegistry,
} = {}) => {
  const registry = skillRegistry ?? createDefaultSkillRegistry();
  const workingMemoryState = createAgentWorkingMemory({
    docIds,
    maxFollowUps,
    question,
  });
  const plan = providedPlan ?? buildPlan({
    question,
    docIds,
  });
  const selectedSkills = orderSelectedSkills({
    selectedSkills: registry.select({
      plan,
      docIds,
    }),
    plan,
  });
  const chainSkills = Array.isArray(plan.skillChain)
    ? plan.skillChain
        .map((skillId) => selectedSkills.find((skill) => skill.id === skillId))
        .filter(Boolean)
    : [];
  const runContext = createAgentRunContext({
    agentBudget,
    chainSkills,
    docIds,
    experienceMemory,
    executionLoop: workingMemoryState.executionLoop,
    intentPlanner,
    plan,
    question,
    selectedSkills,
    workingMemory: workingMemoryState.workingMemory,
  });
  const skillTracker = createAgentSkillTracker({
    budgetState: runContext.budgetState,
    recordWorkingMemoryQueries: workingMemoryState.recordWorkingMemoryQueries,
    selectedSkills,
  });

  runContext.setSkillTracker({
    getAgentSkills: skillTracker.getAgentSkills,
    getSkillObservations: skillTracker.getSkillObservations,
    getSkillRuns: skillTracker.getSkillRuns,
  });

  for (const skill of selectedSkills) {
    skillTracker.getOrCreateSkillObservation(skill);
  }

  const getSelectedSkill = (skillId) =>
    selectedSkills.find((skill) => skill.id === skillId) ?? null;

  return {
    ...workingMemoryState,
    ...runContext,
    ...skillTracker,
    chainSkills,
    getSelectedSkill,
    plan,
    registry,
    runContext,
    selectedSkills,
    skillTracker,
  };
};
