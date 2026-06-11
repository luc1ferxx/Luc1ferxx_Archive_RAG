import {
  AGENT_EXECUTION_CONDITIONS,
  AGENT_EXECUTION_STEP_IDS,
  AGENT_EXECUTION_STEP_SCHEMA,
} from "./agent-execution-plan.js";
import { completeText } from "./openai.js";

const MAX_REASON_LENGTH = 220;

const sanitizeText = (value, maxLength = 500) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const compactSelectedSkill = (skill) => ({
  budgetKey: skill.budgetKey ?? null,
  id: skill.id,
  kind: skill.kind ?? "built_in",
  label: skill.label ?? skill.id,
  requiresAccessScope: Boolean(skill.requiresAccessScope),
});

const compactExecutionSchema = () =>
  Object.entries(AGENT_EXECUTION_STEP_SCHEMA).map(([id, schema]) => ({
    condition: schema.condition,
    id,
    skillGroup: schema.skillGroup ?? null,
    skillId: schema.skillId ?? null,
  }));

const extractJsonCandidate = (rawText) => {
  const text = String(rawText ?? "").trim();

  if (!text) {
    throw new Error("LLM planner returned an empty response.");
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return text;
};

const parsePlannerJson = (rawText) => {
  const candidate = extractJsonCandidate(rawText);

  try {
    return JSON.parse(candidate);
  } catch {
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    const arrayStart = candidate.indexOf("[");
    const arrayEnd = candidate.lastIndexOf("]");

    if (
      arrayStart !== -1 &&
      arrayEnd > arrayStart &&
      (objectStart === -1 || arrayStart < objectStart)
    ) {
      return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
    }

    if (objectStart !== -1 && objectEnd > objectStart) {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    }

    throw new Error("LLM planner response was not valid JSON.");
  }
};

const normalizePlannerStep = (step) => {
  if (typeof step === "string") {
    return step;
  }

  if (!step || typeof step !== "object") {
    return step;
  }

  const normalizedStep = {
    id: sanitizeText(step.id, 80),
  };

  if (typeof step.skillId === "string") {
    normalizedStep.skillId = sanitizeText(step.skillId, 80);
  }

  if (typeof step.condition === "string") {
    normalizedStep.condition = sanitizeText(step.condition, 80);
  }

  if (typeof step.reason === "string") {
    normalizedStep.reason = sanitizeText(step.reason, MAX_REASON_LENGTH);
  }

  return normalizedStep;
};

const normalizePlannerPayload = (payload) => {
  const rawSteps = Array.isArray(payload) ? payload : payload?.steps;

  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error("LLM planner response must contain a non-empty steps array.");
  }

  return rawSteps.map(normalizePlannerStep);
};

const buildPlannerPrompt = ({
  docIds = [],
  plan = {},
  question,
  selectedSkills = [],
} = {}) => {
  const payload = {
    allowedConditions: AGENT_EXECUTION_CONDITIONS,
    allowedSteps: compactExecutionSchema(),
    documentCount: docIds.length,
    intentPlan: {
      mode: plan.mode ?? null,
      needsClarification: Boolean(plan.needsClarification),
      wantsWeb: Boolean(plan.wantsWeb),
    },
    question: sanitizeText(question, 1000),
    selectedSkills: selectedSkills.map(compactSelectedSkill),
  };

  return [
    "You are planning a guarded AgentRAG execution plan.",
    "Return only JSON. Do not include markdown, prose, or extra keys.",
    'The JSON shape must be: {"steps":[{"id":"...","skillId":"...","condition":"...","reason":"..."}]}.',
    "Use only the allowed step ids and conditions from the input.",
    "Do not invent tools, function names, skill ids, budget keys, or data access scopes.",
    `Use ${AGENT_EXECUTION_STEP_IDS.customSkills} only for selected skills where kind is custom.`,
    `Use ${AGENT_EXECUTION_STEP_IDS.webSearch} only when web_search is selected or after document_rag as fallback.`,
    "Keep document_rag before web_search when both are needed.",
    "Input:",
    JSON.stringify(payload),
  ].join("\n");
};

export const llmPlannerAdapter = {
  id: "llm",
  createExecutionPlan: async (plannerContext = {}) => {
    const response = await completeText(buildPlannerPrompt(plannerContext));

    return normalizePlannerPayload(parsePlannerJson(response));
  },
};
