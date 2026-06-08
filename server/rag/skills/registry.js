import {
  AGENT_SKILL_IDS,
  createBuiltInSkills,
} from "./built-ins.js";
import {
  CUSTOM_SKILL_IDS,
  createCustomSkills,
} from "./custom/index.js";

export { AGENT_SKILL_IDS } from "./built-ins.js";
export { CUSTOM_SKILL_IDS } from "./custom/index.js";

const normalizeText = (value) => String(value ?? "").trim();

const REQUIRED_SKILL_FIELDS = [
  "id",
  "version",
  "label",
  "budgetKey",
  "requiresAccessScope",
  "match",
  "execute",
];

export const validateSkillContract = (skill = {}) => {
  const errors = [];

  for (const field of REQUIRED_SKILL_FIELDS) {
    if (!(field in skill)) {
      errors.push(`missing ${field}`);
    }
  }

  if (!normalizeText(skill.id)) {
    errors.push("id must be non-empty");
  }

  if (!normalizeText(skill.version)) {
    errors.push("version must be non-empty");
  }

  if (!normalizeText(skill.label)) {
    errors.push("label must be non-empty");
  }

  if (skill.budgetKey !== null && typeof skill.budgetKey !== "string") {
    errors.push("budgetKey must be a string or null");
  }

  if (typeof skill.requiresAccessScope !== "boolean") {
    errors.push("requiresAccessScope must be boolean");
  }

  if (typeof skill.match !== "function") {
    errors.push("match must be a function");
  }

  if (typeof skill.execute !== "function") {
    errors.push("execute must be a function");
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid AgentRAG skill contract for ${skill.id ?? "unknown"}: ${errors.join(", ")}.`
    );
  }

  return skill;
};

const validateUniqueSkills = (skills = []) => {
  const seen = new Set();

  for (const skill of skills) {
    validateSkillContract(skill);

    if (seen.has(skill.id)) {
      throw new Error(`Duplicate AgentRAG skill id: ${skill.id}`);
    }

    seen.add(skill.id);
  }
};

const normalizeSkillResult = (skill, result = {}) => ({
  ok: true,
  skillId: skill.id,
  skillVersion: skill.version,
  label: skill.label,
  value: result.value ?? result,
  text: normalizeText(result.text ?? result.value?.text),
  citations: result.citations ?? result.value?.citations ?? [],
  abstained: Boolean(result.abstained ?? result.value?.abstained),
  traceDetail: result.traceDetail ?? null,
});

export const buildFailedSkillResult = (skill, error) => ({
  ok: false,
  skillId: skill.id,
  skillVersion: skill.version,
  label: skill.label,
  value: null,
  text: "",
  citations: [],
  abstained: false,
  error,
  traceDetail: null,
});

export const executeAgentSkill = async (skill, context) => {
  try {
    return normalizeSkillResult(skill, await skill.execute(context));
  } catch (error) {
    return buildFailedSkillResult(skill, error);
  }
};

export const createDefaultSkills = () => [
  ...createBuiltInSkills(),
  ...createCustomSkills(),
];

export const createSkillRegistry = (skills = createDefaultSkills()) => {
  validateUniqueSkills(skills);

  const skillMap = new Map(skills.map((skill) => [skill.id, skill]));

  return {
    get: (skillId) => skillMap.get(skillId) ?? null,
    list: () => [...skillMap.values()],
    select: ({ plan, docIds }) =>
      [...skillMap.values()].filter((skill) =>
        skill.match?.({
          plan,
          docIds,
        })
      ),
  };
};

export const createBuiltInSkillRegistry = () =>
  createSkillRegistry(createBuiltInSkills());

export const createDefaultSkillRegistry = () =>
  createSkillRegistry(createDefaultSkills());

export const createCustomSkillRegistry = () =>
  createSkillRegistry(createCustomSkills());
