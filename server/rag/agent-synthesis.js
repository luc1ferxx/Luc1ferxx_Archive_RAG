import { SKILL_CHAIN_MODE } from "./agent-planner.js";
import { CUSTOM_SKILL_IDS } from "./skills/registry.js";

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeText = (value) => (hasText(value) ? value.trim() : "");

export const buildDirectAnswerModes = ({ customSkills = [] } = {}) =>
  new Set([
    "arxiv_import",
    "workspace_action",
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
  researchBrief,
  webResult,
} = {}) =>
  Boolean(
    ragSources.length > 0 &&
      (agentMode === "document" ||
        agentMode === "document_web" ||
        agentMode === "research_brief" ||
        (agentMode === "web" && webResult?.ok) ||
        agentMode === SKILL_CHAIN_MODE ||
        researchBrief ||
        (primaryCustomResult && agentMode === primaryCustomResult.skillId))
  );

export const buildSynthesisAnswer = ({
  plan,
  customSkillGraphExecuted = false,
  actionAnswer,
  arxivImportAnswer,
  ragResult,
  webResult,
  customSkillResults = [],
  inventoryAnswer,
  discoveryAnswer,
  researchBrief,
}) => {
  // The DAG may select additional authorized atomic Skills beyond the single
  // V1 intent. Compose what actually ran, not just the intent's one Skill id.
  if (customSkillGraphExecuted) {
    const completedResults = customSkillResults
      .filter((result) => result.ok && normalizeText(result.text))
      .map((result) => normalizeText(result.text));

    if (completedResults.length > 0) {
      const researchFindings = (researchBrief?.findings ?? [])
        .filter((finding) => finding.status === "completed" && normalizeText(finding.text))
        .map((finding) => normalizeText(finding.text));

      return [
        ...completedResults,
        ...researchFindings,
        ...(ragResult?.ok ? [normalizeText(ragResult.value.text)] : []),
        ...(webResult?.ok ? [normalizeText(webResult.value.text)] : []),
      ].filter(Boolean).join("\n\n");
    }
  }

  if (plan.mode === "arxiv_import") {
    return arxivImportAnswer ?? "The arXiv import could not be completed.";
  }

  if (plan.mode === "workspace_action") {
    return actionAnswer ?? "The workspace action could not be completed.";
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
