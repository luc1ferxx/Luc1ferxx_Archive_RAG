import { normalizeTrimmedText as normalizeText } from "../../lib/normalize-text.js";
import { SKILL_EFFECTS, getSkillContract } from "./skill-contract.js";

const VALID_EFFECTS = new Set(Object.values(SKILL_EFFECTS));

/**
 * The DAG planner's atomic Skill pool is authorized by the runtime, not by
 * the intent classifier. In particular, `match()` and composite intent ids
 * must not determine which registered Skills the model is allowed to combine.
 *
 * This catalog is intentionally narrower than the V1 registry: every Skill
 * needs an explicit typed contract and document scope. A legacy Skill can
 * continue to run through V1 without silently becoming a new model-callable
 * capability. The document lookup is the same scoped lookup used by /chat.
 */
export const listAuthorizedAtomicCustomSkills = ({
  accessScope,
  docIds = [],
  ragService,
  registry,
} = {}) => {
  if (
    !accessScope ||
    typeof accessScope !== "object" ||
    Array.isArray(accessScope) ||
    !Array.isArray(docIds) ||
    docIds.length === 0 ||
    typeof ragService?.getDocument !== "function" ||
    typeof registry?.get !== "function" ||
    typeof registry?.list !== "function"
  ) {
    return [];
  }

  const normalizedDocIds = docIds.map(normalizeText);

  if (normalizedDocIds.some((docId) => !docId)) {
    return [];
  }

  try {
    for (const docId of normalizedDocIds) {
      const document = ragService.getDocument(docId, accessScope);

      if (
        !document ||
        typeof document?.then === "function" ||
        normalizeText(document.docId) !== docId
      ) {
        return [];
      }
    }
  } catch {
    return [];
  }

  return registry.list().filter((skill) => {
    if (skill?.kind !== "custom" || registry.get(skill.id) !== skill) {
      return false;
    }

    // Inferring `read_only` from missing or misspelled metadata is fine for
    // the legacy chain, but not for adding a Skill to a model-facing catalog.
    if (
      !VALID_EFFECTS.has(skill.effects) ||
      !skill.inputSchema ||
      !skill.outputSchema ||
      !skill.requiresAccessScope
    ) {
      return false;
    }

    const contract = getSkillContract(skill);

    return Boolean(
      contract.inputSchema.docIds?.required &&
      contract.inputSchema.docIds?.scoped
    );
  });
};
