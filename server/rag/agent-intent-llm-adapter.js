import { completeText } from "./openai.js";
import {
  compactPlanCandidate,
  normalizeIntentSelection,
  normalizeIntentText,
} from "./agent-intent-validator.js";
import { buildAgentTaskPlanningContext } from "./agent-task-memory.js";

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

export const deterministicIntentPlannerAdapter = {
  id: "deterministic",
  selectIntentPlan: async ({ candidates = [] } = {}) => ({
    selectedIntentId: candidates[0]?.id ?? "",
    reason: "Selected the highest-priority deterministic rule candidate.",
  }),
};

export const llmIntentPlannerAdapter = {
  id: "llm",
  selectIntentPlan: async (plannerContext = {}) =>
    normalizeIntentSelection(
      parseIntentPlannerJson(
        await completeText(buildIntentPlannerPrompt(plannerContext))
      )
    ),
};
