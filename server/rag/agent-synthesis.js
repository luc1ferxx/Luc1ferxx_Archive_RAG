import { SKILL_CHAIN_MODE } from "./agent-planner.js";
import { CUSTOM_SKILL_IDS } from "./skills/registry.js";

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeText = (value) => (hasText(value) ? value.trim() : "");

export const buildDirectAnswerModes = ({ customSkills = [] } = {}) =>
  new Set([
    "arxiv_import",
    "inventory",
    "document_discovery",
    "research_brief",
    SKILL_CHAIN_MODE,
    ...customSkills.map((skill) => skill.id),
  ]);

export const shouldFinalizeAgentAnswer = ({
  agentMode,
  primaryCustomResult,
  ragSources = [],
} = {}) =>
  Boolean(
    ragSources.length > 0 &&
      (agentMode === "document" ||
        agentMode === SKILL_CHAIN_MODE ||
        (primaryCustomResult && agentMode === primaryCustomResult.skillId))
  );

export const buildSynthesisAnswer = ({
  plan,
  arxivImportAnswer,
  ragResult,
  webResult,
  customSkillResults = [],
  inventoryAnswer,
  discoveryAnswer,
  researchBrief,
}) => {
  if (plan.mode === "arxiv_import") {
    return arxivImportAnswer ?? "The arXiv import could not be completed.";
  }

  if (plan.mode === SKILL_CHAIN_MODE) {
    const completedResults = customSkillResults
      .filter((result) => result.ok && normalizeText(result.text))
      .map((result) => normalizeText(result.text));

    return completedResults.length > 0
      ? completedResults.join("\n\n")
      : "The skill chain could not complete the request.";
  }

  if (Object.values(CUSTOM_SKILL_IDS).includes(plan.mode)) {
    const customResult = customSkillResults.find(
      (result) => result.ok && result.skillId === plan.mode
    );

    return customResult?.text ?? "The custom skill could not complete the request.";
  }

  if (plan.mode === "research_brief") {
    return researchBrief?.text ?? "The research brief could not be generated.";
  }

  if (plan.mode === "inventory") {
    return inventoryAnswer;
  }

  if (plan.mode === "document_discovery") {
    return discoveryAnswer;
  }

  if (ragResult?.ok && webResult?.ok) {
    return [
      "Document evidence:",
      normalizeText(ragResult.value.text),
      "",
      "Web context:",
      normalizeText(webResult.value.text),
    ].join("\n");
  }

  if (ragResult?.ok) {
    return normalizeText(ragResult.value.text);
  }

  if (webResult?.ok) {
    return normalizeText(webResult.value.text);
  }

  return "The agent could not complete the request because all selected tools failed.";
};
