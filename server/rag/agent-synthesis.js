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

// Synthesis reads no Web result: Web search answers only from its approved
// capability_call step, never inside the outer plan (agent-web-runner.js). A
// document_web plan whose Web search was skipped for budget answers from its
// documents.
export const shouldFinalizeAgentAnswer = ({
  agentMode,
  primaryCustomResult,
  ragSources = [],
  researchBrief,
} = {}) =>
  Boolean(
    ragSources.length > 0 &&
      (agentMode === "document" ||
        agentMode === "document_web" ||
        agentMode === "research_brief" ||
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

  if (ragResult?.ok) {
    return normalizeText(ragResult.value.text);
  }

  return "The agent could not complete the request because all selected tools failed.";
};
