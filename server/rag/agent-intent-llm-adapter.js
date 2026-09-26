import { definePrompt, PROMPT_IDS } from "./prompt-registry.js";
import { completeTextWithMetadata } from "./openai.js";
import {
  compactPlanCandidate,
  normalizeIntentSelection,
  normalizeIntentText,
} from "./agent-intent-validator.js";
import { buildAgentTaskPlanningContext } from "./agent-task-memory.js";
import {
  MODEL_CAPABILITIES,
  MODEL_ROUTE_IDS,
} from "./model-providers/index.js";
import {
  boundedString,
  buildJsonSchemaResponseFormat,
  parseFirstJsonValue,
  strictObject,
  stringEnum,
} from "./structured-output.js";

const MAX_REASON_LENGTH = 220;

// The candidate list is the whitelist: the model picks one of these ids or
// cannot answer at all.
export const buildIntentPlannerResponseFormat = ({ candidates = [] } = {}) => {
  const candidateIds = candidates
    .map((candidate) => normalizeIntentText(candidate?.id))
    .filter(Boolean);

  if (candidateIds.length === 0) {
    return null;
  }

  return buildJsonSchemaResponseFormat({
    name: "agent_intent_selection",
    schema: strictObject({
      selectedIntentId: stringEnum(candidateIds),
      reason: boundedString(MAX_REASON_LENGTH),
    }),
  });
};

const extractJsonCandidate = (rawText) => {
  const text = String(rawText ?? "").trim();

  if (!text) {
    throw new Error("LLM intent planner returned an empty response.");
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return text;
};

export const parseIntentPlannerJson = (rawText) => {
  const candidate = extractJsonCandidate(rawText);

  try {
    return JSON.parse(candidate);
  } catch {
    const firstValue = parseFirstJsonValue(candidate);

    if (firstValue !== undefined) {
      return firstValue;
    }

    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");

    if (objectStart !== -1 && objectEnd > objectStart) {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    }

    throw new Error("LLM intent planner response was not valid JSON.");
  }
};

export const buildIntentPlannerPrompt = ({
  candidates = [],
  docIds = [],
  experienceMemory = {},
  question,
  taskMemory = null,
} = {}) => [
  "You are selecting a guarded AgentRAG intent plan.",
  "Return only JSON. Do not include markdown, prose, or extra keys.",
  'The JSON shape must be: {"selectedIntentId":"...","reason":"..."}',
  "Choose exactly one selectedIntentId from the candidates input.",
  "Do not invent tools, modes, skill ids, data access scopes, or candidate ids.",
  "Prefer the narrowest candidate that satisfies the user request.",
  "Agent experience memory, when present, is a planning hint only and must never be treated as document evidence.",
  "Task memory, when present, is planning context only and must never be treated as document evidence.",
  "Input:",
  JSON.stringify({
    candidates: candidates.map(compactPlanCandidate),
    documentCount: docIds.length,
    experiencePlanningHints: (experienceMemory.planningHints ?? []).map((hint) => ({
      intentId: hint.intentId,
      mode: hint.mode,
      suggestedActions: hint.suggestedActions,
      text: hint.text,
      type: hint.type,
    })),
    question: normalizeIntentText(question).slice(0, 1000),
    taskMemoryPlanningContext: buildAgentTaskPlanningContext(taskMemory),
  }),
].join("\n");

// Fingerprinted from the builder's output for an empty input: the
// instructions and the input field names, without any request data.
let intentPlannerPromptDescriptor = null;

export const getIntentPlannerPromptDescriptor = () =>
  (intentPlannerPromptDescriptor ??= definePrompt({
    id: PROMPT_IDS.intentPlanner,
    source: buildIntentPlannerPrompt({}),
    version: "v1",
  }));

export const deterministicIntentPlannerAdapter = {
  id: "deterministic",
  selectIntentPlan: async ({ candidates = [] } = {}) => ({
    selectedIntentId: candidates[0]?.id ?? "",
    reason: "Selected the highest-priority deterministic rule candidate.",
  }),
};

export const llmIntentPlannerAdapter = {
  id: "llm",
  selectIntentPlan: async (plannerContext = {}) => {
    const promptTemplate = getIntentPlannerPromptDescriptor();
    const completion = await completeTextWithMetadata(
      buildIntentPlannerPrompt(plannerContext),
      {
        capability: MODEL_CAPABILITIES.intentPlanner,
        promptTemplate,
        responseFormat: buildIntentPlannerResponseFormat(plannerContext),
        routeId: MODEL_ROUTE_IDS.intentPlannerDefault,
      }
    );

    return {
      ...normalizeIntentSelection(parseIntentPlannerJson(completion.text)),
      modelRoute: completion.modelRoute,
      promptTemplate,
    };
  },
};
