import { normalizeTrimmedText as normalizeText } from "../../lib/normalize-text.js";

// Typed skill contract extensions. The required V1 contract fields
// (id/version/label/budgetKey/requiresAccessScope/match/execute) stay owned by
// skills/registry.js; this module only adds the planning-and-scheduling
// metadata the ExecutionGraph needs, plus the redacted descriptor the V2
// planner is allowed to see. Skills that predate the typed contract keep
// working through inferSkillContractDefaults, which supplies the conservative
// values (read-only, not parallel-safe, free-text question in / text out).

export const SKILL_EFFECTS = Object.freeze({
  externalRead: "external_read",
  externalWrite: "external_write",
  readOnly: "read_only",
  workspaceWrite: "workspace_write",
});

export const SKILL_IDEMPOTENCY = Object.freeze({
  adapterDefined: "adapter_defined",
  deterministic: "deterministic",
  nondeterministic: "nondeterministic",
  readOnlyRag: "read_only_rag",
});

export const SKILL_VALUE_TYPES = Object.freeze({
  boolean: "boolean",
  citationArray: "citation[]",
  number: "number",
  object: "object",
  string: "string",
  stringArray: "string[]",
});

const VALID_EFFECTS = new Set(Object.values(SKILL_EFFECTS));
const VALID_IDEMPOTENCY = new Set(Object.values(SKILL_IDEMPOTENCY));
const VALID_VALUE_TYPES = new Set(Object.values(SKILL_VALUE_TYPES));

// Request fields a node may bind to. Nothing here can widen access: docIds is
// already narrowed to the caller's authorized scope before the graph runs, and
// accessScope is deliberately absent so a planned node can never name it.
export const EXECUTION_REQUEST_FIELD_TYPES = Object.freeze({
  docIds: SKILL_VALUE_TYPES.stringArray,
  question: SKILL_VALUE_TYPES.string,
  retrievalPlan: SKILL_VALUE_TYPES.object,
  sessionId: SKILL_VALUE_TYPES.string,
  userId: SKILL_VALUE_TYPES.string,
});

const DEFAULT_INPUT_SCHEMA = Object.freeze({
  docIds: Object.freeze({
    required: true,
    scoped: true,
    type: SKILL_VALUE_TYPES.stringArray,
  }),
  priorFindings: Object.freeze({
    required: false,
    type: SKILL_VALUE_TYPES.string,
  }),
  question: Object.freeze({
    required: true,
    type: SKILL_VALUE_TYPES.string,
  }),
  retrievalPlan: Object.freeze({
    required: false,
    type: SKILL_VALUE_TYPES.object,
  }),
});

const DEFAULT_OUTPUT_SCHEMA = Object.freeze({
  abstained: Object.freeze({ type: SKILL_VALUE_TYPES.boolean }),
  citations: Object.freeze({ type: SKILL_VALUE_TYPES.citationArray }),
  text: Object.freeze({ type: SKILL_VALUE_TYPES.string }),
});

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeFieldSchema = (field = {}) => ({
  required: Boolean(field.required),
  scoped: Boolean(field.scoped),
  type: VALID_VALUE_TYPES.has(field.type) ? field.type : SKILL_VALUE_TYPES.object,
});

const normalizeSchema = (schema, fallback) => {
  if (!isRecord(schema)) {
    return fallback;
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(schema)
        .filter(([fieldName]) => normalizeText(fieldName))
        .map(([fieldName, field]) => [
          fieldName,
          Object.freeze(normalizeFieldSchema(isRecord(field) ? field : {})),
        ])
    )
  );
};

/**
 * Fills the typed-contract fields for a skill that may or may not declare them.
 * Legacy skills get the safe defaults: read-only effects, no parallelism, and
 * the free-text question/text schema the V1 chain already used.
 */
export const inferSkillContractDefaults = (skill = {}) => {
  const effects = VALID_EFFECTS.has(skill.effects ?? skill.sideEffect)
    ? (skill.effects ?? skill.sideEffect)
    : SKILL_EFFECTS.readOnly;
  const isReadOnly = effects === SKILL_EFFECTS.readOnly;

  return {
    effects,
    idempotency: VALID_IDEMPOTENCY.has(skill.idempotency)
      ? skill.idempotency
      : isReadOnly
        ? SKILL_IDEMPOTENCY.readOnlyRag
        : SKILL_IDEMPOTENCY.adapterDefined,
    inputSchema: normalizeSchema(skill.inputSchema, DEFAULT_INPUT_SCHEMA),
    outputSchema: normalizeSchema(skill.outputSchema, DEFAULT_OUTPUT_SCHEMA),
    // Declared-only opt-in: a skill is never parallel-safe by inference, and a
    // side-effecting skill can never be parallel-safe even if it says so.
    parallelSafe: isReadOnly && skill.parallelSafe === true,
    replaySafe: skill.replaySafe === undefined ? isReadOnly : Boolean(skill.replaySafe),
    retryable: skill.retryable === undefined ? isReadOnly : Boolean(skill.retryable),
  };
};

export const getSkillContract = (skill = {}) => ({
  budgetKey: skill.budgetKey ?? null,
  id: normalizeText(skill.id),
  kind: normalizeText(skill.kind) || "built_in",
  label: normalizeText(skill.label) || normalizeText(skill.id),
  requiresAccessScope: Boolean(skill.requiresAccessScope),
  version: normalizeText(skill.version),
  ...inferSkillContractDefaults(skill),
});

/**
 * The only skill view the V2 planner ever receives. Mirrors
 * capabilities/registry.js describeCapability: plain data, no executable
 * references, no match predicate, no internal prompt builders.
 */
export const describeSkillForPlanner = (skill = {}) => {
  const contract = getSkillContract(skill);

  return {
    budgetKey: contract.budgetKey,
    effects: contract.effects,
    id: contract.id,
    idempotency: contract.idempotency,
    inputSchema: contract.inputSchema,
    kind: contract.kind,
    label: contract.label,
    outputSchema: contract.outputSchema,
    parallelSafe: contract.parallelSafe,
    requiresAccessScope: contract.requiresAccessScope,
    summary: normalizeText(skill.plannerSummary).slice(0, 240),
    version: contract.version,
  };
};

export const describeSkillsForPlanner = (skills = []) =>
  skills.map((skill) => describeSkillForPlanner(skill));

export const isSideEffectingSkill = (skill = {}) =>
  getSkillContract(skill).effects !== SKILL_EFFECTS.readOnly;

/**
 * The replay-relevant slice of the contract, small enough to persist on every
 * step a skill produces. The recovery layer is handed a stored step, never a
 * live skill, so this is the only route by which a skill's own declaration
 * reaches the decision about whether that step may be re-run unattended.
 */
export const describeSkillReplayContract = (skill = {}) => {
  const contract = getSkillContract(skill);

  return {
    effects: contract.effects,
    idempotency: contract.idempotency,
    replaySafe: contract.replaySafe,
  };
};

/**
 * Structural type compatibility between an upstream output field and the
 * downstream input field it is bound to. Deliberately strict: a citation array
 * never silently stringifies into a text input, which is exactly the
 * free-text-concatenation failure mode the typed contract replaces.
 */
export const isAssignableValueType = (sourceType, targetType) => {
  if (!sourceType || !targetType) {
    return false;
  }

  if (sourceType === targetType) {
    return true;
  }

  return targetType === SKILL_VALUE_TYPES.object;
};
