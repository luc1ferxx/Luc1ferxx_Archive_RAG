import { AGENT_SKILL_IDS } from "./skills/registry.js";

export const AGENT_EXECUTION_STEP_IDS = {
  arxivImport: "arxiv_import",
  researchBrief: "research_brief",
  inventory: "inventory",
  documentDiscovery: "document_discovery",
  customSkills: "custom_skills",
  documentRag: "document_rag",
  webSearch: "web_search",
};

export const AGENT_EXECUTION_CONDITIONS = {
  always: "always",
  selectedSkill: "selected_skill",
  selectedCustomSkills: "selected_custom_skills",
  selectedOrDocumentFallback: "selected_or_document_fallback",
};

export const AGENT_EXECUTION_STEP_SCHEMA = {
  [AGENT_EXECUTION_STEP_IDS.arxivImport]: {
    budgetKey: "arxivPaperFetches",
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    requiresAccessScope: true,
    skillId: AGENT_SKILL_IDS.arxivImport,
  },
  [AGENT_EXECUTION_STEP_IDS.researchBrief]: {
    budgetKey: "researchQuestions",
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    requiresAccessScope: true,
    skillId: AGENT_SKILL_IDS.researchBrief,
  },
  [AGENT_EXECUTION_STEP_IDS.inventory]: {
    budgetKey: null,
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    requiresAccessScope: true,
    skillId: AGENT_SKILL_IDS.inventory,
  },
  [AGENT_EXECUTION_STEP_IDS.documentDiscovery]: {
    budgetKey: null,
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    requiresAccessScope: true,
    skillId: AGENT_SKILL_IDS.documentDiscovery,
  },
  [AGENT_EXECUTION_STEP_IDS.customSkills]: {
    budgetKey: "customSkillCalls",
    condition: AGENT_EXECUTION_CONDITIONS.selectedCustomSkills,
    requiresAccessScope: true,
    skillGroup: "custom",
  },
  [AGENT_EXECUTION_STEP_IDS.documentRag]: {
    budgetKey: "documentRagCalls",
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    requiresAccessScope: true,
    skillId: AGENT_SKILL_IDS.documentRag,
  },
  [AGENT_EXECUTION_STEP_IDS.webSearch]: {
    budgetKey: "webSearchCalls",
    condition: AGENT_EXECUTION_CONDITIONS.selectedOrDocumentFallback,
    requiresAccessScope: false,
    skillId: AGENT_SKILL_IDS.webSearch,
  },
};

const normalizeText = (value) => String(value ?? "").trim();

const normalizePlannerId = (plannerAdapter) =>
  normalizeText(plannerAdapter?.id) || "unknown";

const getStepId = (step) =>
  typeof step === "string" ? normalizeText(step) : normalizeText(step?.id);

const serializePlannerError = (error) =>
  normalizeText(error instanceof Error ? error.message : error).slice(0, 500);

const buildPlannerSelection = ({
  executionPlan,
  fallback = false,
  fallbackReason = null,
  requestedPlannerId,
  selectedPlannerId,
}) => ({
  fallback,
  fallbackReason: fallbackReason ? serializePlannerError(fallbackReason) : null,
  requestedPlannerId,
  selectedPlannerId,
  status: fallback ? "fallback" : "selected",
  stepIds: executionPlan.map((step) => step.id),
});

const getSelectedSkill = (selectedSkills = [], skillId) =>
  selectedSkills.find((skill) => skill.id === skillId) ?? null;

const getRegistrySkill = (registry, skillId) =>
  registry?.get?.(skillId) ?? null;

const normalizeCondition = ({ condition, schema }) => {
  const normalizedCondition = normalizeText(condition);

  return normalizedCondition || schema.condition || AGENT_EXECUTION_CONDITIONS.always;
};

const assertValidAccessScope = ({ accessScope, errors, stepId }) => {
  if (!accessScope || typeof accessScope !== "object") {
    errors.push(`${stepId} requires an accessScope object`);
  }
};

const validateFixedSkillStep = ({
  accessScope,
  errors,
  registry,
  schema,
  selectedSkills,
  skillId,
  stepId,
}) => {
  if (skillId !== schema.skillId) {
    errors.push(
      `${stepId} must reference ${schema.skillId}, received ${skillId || "none"}`
    );
    return null;
  }

  const selectedSkill = getSelectedSkill(selectedSkills, skillId);
  const registeredSkill = getRegistrySkill(registry, skillId);

  if (selectedSkill && registry?.get && !registeredSkill) {
    errors.push(`${stepId} selected skill ${skillId} is not registered`);
  }

  const skill = selectedSkill ?? registeredSkill;

  if (!skill) {
    return null;
  }

  if (skill.budgetKey !== schema.budgetKey) {
    errors.push(
      `${stepId} expects budgetKey ${schema.budgetKey ?? "none"}, received ${
        skill.budgetKey ?? "none"
      }`
    );
  }

  if (schema.requiresAccessScope) {
    assertValidAccessScope({
      accessScope,
      errors,
      stepId,
    });
  }

  return skill;
};

const validateCustomSkillStep = ({
  accessScope,
  errors,
  registry,
  selectedSkills,
  step,
  stepId,
}) => {
  if (step?.skillId) {
    errors.push(`${stepId} cannot reference an arbitrary skillId`);
  }

  assertValidAccessScope({
    accessScope,
    errors,
    stepId,
  });

  const customSkills = selectedSkills.filter((skill) => skill.kind === "custom");

  for (const customSkill of customSkills) {
    const registeredSkill = getRegistrySkill(registry, customSkill.id);

    if (registry?.get && !registeredSkill) {
      errors.push(`${stepId} references unregistered custom skill ${customSkill.id}`);
    }

    if (
      customSkill.budgetKey !== null &&
      typeof customSkill.budgetKey !== "string"
    ) {
      errors.push(`${stepId} custom skill ${customSkill.id} has invalid budgetKey`);
    }
  }
};

const validateWebFallbackOrdering = ({
  errors,
  normalizedPlan,
  selectedSkills,
}) => {
  const webIndex = normalizedPlan.findIndex(
    (step) => step.id === AGENT_EXECUTION_STEP_IDS.webSearch
  );

  if (webIndex === -1) {
    return;
  }

  const documentIndex = normalizedPlan.findIndex(
    (step) => step.id === AGENT_EXECUTION_STEP_IDS.documentRag
  );
  const webIsSelected = Boolean(
    getSelectedSkill(selectedSkills, AGENT_SKILL_IDS.webSearch)
  );

  if (documentIndex !== -1 && webIndex < documentIndex) {
    errors.push("web_search must run after document_rag when both are planned");
  }

  if (!webIsSelected && documentIndex === -1) {
    errors.push(
      "web_search fallback requires a preceding document_rag step unless web_search is selected"
    );
  }
};

const normalizeExecutionStep = ({
  accessScope,
  errors,
  index,
  registry,
  selectedSkills,
  seenStepIds,
  step,
}) => {
  if (typeof step !== "string" && (!step || typeof step !== "object")) {
    errors.push(`execution step ${index + 1} must be a string or object`);
    return null;
  }

  const stepId = getStepId(step);
  const schema = AGENT_EXECUTION_STEP_SCHEMA[stepId];

  if (!schema) {
    errors.push(`unknown execution step ${stepId || `at index ${index + 1}`}`);
    return null;
  }

  if (seenStepIds.has(stepId)) {
    errors.push(`duplicate execution step ${stepId}`);
  }
  seenStepIds.add(stepId);

  const skillId = normalizeText(
    typeof step === "string" ? schema.skillId : step.skillId ?? schema.skillId
  );
  const condition = normalizeCondition({
    condition: typeof step === "string" ? null : step.condition,
    schema,
  });

  if (condition !== schema.condition) {
    errors.push(
      `${stepId} condition must be ${schema.condition}, received ${condition}`
    );
  }

  const normalizedStep = {
    id: stepId,
    condition,
    reason: typeof step === "string" ? null : normalizeText(step.reason) || null,
    skillGroup: schema.skillGroup ?? null,
    skillId: skillId || null,
  };

  if (schema.skillGroup === "custom") {
    validateCustomSkillStep({
      accessScope,
      errors,
      registry,
      selectedSkills,
      step,
      stepId,
    });

    return {
      ...normalizedStep,
      skillId: null,
    };
  }

  validateFixedSkillStep({
    accessScope,
    errors,
    registry,
    schema,
    selectedSkills,
    skillId,
    stepId,
  });

  return normalizedStep;
};

export const validateAgentExecutionPlan = ({
  accessScope = {},
  executionPlan,
  registry,
  selectedSkills = [],
} = {}) => {
  const errors = [];

  if (!Array.isArray(executionPlan) || executionPlan.length === 0) {
    throw new Error("AgentRAG execution plan must contain at least one step.");
  }

  const seenStepIds = new Set();
  const normalizedPlan = executionPlan
    .map((step, index) =>
      normalizeExecutionStep({
        accessScope,
        errors,
        index,
        registry,
        selectedSkills,
        seenStepIds,
        step,
      })
    )
    .filter(Boolean);

  validateWebFallbackOrdering({
    errors,
    normalizedPlan,
    selectedSkills,
  });

  if (errors.length > 0) {
    throw new Error(`Invalid AgentRAG execution plan: ${errors.join("; ")}.`);
  }

  return normalizedPlan;
};

export const createDeterministicAgentExecutionPlan = () => [
  {
    id: AGENT_EXECUTION_STEP_IDS.arxivImport,
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    skillId: AGENT_SKILL_IDS.arxivImport,
  },
  {
    id: AGENT_EXECUTION_STEP_IDS.researchBrief,
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    skillId: AGENT_SKILL_IDS.researchBrief,
  },
  {
    id: AGENT_EXECUTION_STEP_IDS.inventory,
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    skillId: AGENT_SKILL_IDS.inventory,
  },
  {
    id: AGENT_EXECUTION_STEP_IDS.documentDiscovery,
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    skillId: AGENT_SKILL_IDS.documentDiscovery,
  },
  {
    id: AGENT_EXECUTION_STEP_IDS.customSkills,
    condition: AGENT_EXECUTION_CONDITIONS.selectedCustomSkills,
  },
  {
    id: AGENT_EXECUTION_STEP_IDS.documentRag,
    condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
    skillId: AGENT_SKILL_IDS.documentRag,
  },
  {
    id: AGENT_EXECUTION_STEP_IDS.webSearch,
    condition: AGENT_EXECUTION_CONDITIONS.selectedOrDocumentFallback,
    skillId: AGENT_SKILL_IDS.webSearch,
  },
];

export const deterministicPlannerAdapter = {
  id: "deterministic",
  createExecutionPlan: createDeterministicAgentExecutionPlan,
};

export const createAgentExecutionPlanResult = async ({
  accessScope = {},
  fallbackPlannerAdapter = deterministicPlannerAdapter,
  plannerAdapter = fallbackPlannerAdapter,
  plannerContext = {},
  registry,
  selectedSkills = [],
} = {}) => {
  const fallbackPlannerId = normalizePlannerId(fallbackPlannerAdapter);
  const requestedPlannerId = normalizePlannerId(plannerAdapter);
  const createFallbackPlan = async () =>
    validateAgentExecutionPlan({
      accessScope,
      executionPlan: await fallbackPlannerAdapter.createExecutionPlan(
        plannerContext
      ),
      registry,
      selectedSkills,
    });

  if (!plannerAdapter || plannerAdapter === fallbackPlannerAdapter) {
    const executionPlan = await createFallbackPlan();

    return {
      executionPlan,
      planner: buildPlannerSelection({
        executionPlan,
        requestedPlannerId: fallbackPlannerId,
        selectedPlannerId: fallbackPlannerId,
      }),
    };
  }

  try {
    const executionPlan = validateAgentExecutionPlan({
      accessScope,
      executionPlan: await plannerAdapter.createExecutionPlan(plannerContext),
      registry,
      selectedSkills,
    });

    return {
      executionPlan,
      planner: buildPlannerSelection({
        executionPlan,
        requestedPlannerId,
        selectedPlannerId: requestedPlannerId,
      }),
    };
  } catch (error) {
    const executionPlan = await createFallbackPlan();

    return {
      executionPlan,
      planner: buildPlannerSelection({
        executionPlan,
        fallback: true,
        fallbackReason: error,
        requestedPlannerId,
        selectedPlannerId: fallbackPlannerId,
      }),
    };
  }
};

export const createValidatedAgentExecutionPlan = async (options = {}) => {
  const result = await createAgentExecutionPlanResult(options);

  return result.executionPlan;
};
