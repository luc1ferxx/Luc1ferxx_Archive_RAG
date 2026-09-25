import { normalizeTrimmedText as normalizeText } from "../../../lib/normalize-text.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
  SKILL_VALUE_TYPES,
} from "../skill-contract.js";

// Shared typed contract for the read-only RAG custom skills. Declaring these
// explicitly (rather than leaning on inferSkillContractDefaults) is what makes
// these skills eligible for DAG parallelism: inference can only ever say "not
// parallel-safe", because opting in is a claim the skill author has to make.

const PRIOR_FINDINGS_MAX_LENGTH = 4000;

export const CUSTOM_RAG_SKILL_INPUT_SCHEMA = Object.freeze({
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

export const CUSTOM_RAG_SKILL_OUTPUT_SCHEMA = Object.freeze({
  abstained: Object.freeze({ required: true, type: SKILL_VALUE_TYPES.boolean }),
  citations: Object.freeze({ required: true, type: SKILL_VALUE_TYPES.citationArray }),
  text: Object.freeze({ required: true, type: SKILL_VALUE_TYPES.string }),
});

export const CUSTOM_RAG_SKILL_CONTRACT = Object.freeze({
  effects: SKILL_EFFECTS.readOnly,
  idempotency: SKILL_IDEMPOTENCY.readOnlyRag,
  inputSchema: CUSTOM_RAG_SKILL_INPUT_SCHEMA,
  outputSchema: CUSTOM_RAG_SKILL_OUTPUT_SCHEMA,
  parallelSafe: true,
  replaySafe: true,
  retryable: true,
});

/**
 * Renders an upstream node's findings as one clearly delimited, clearly
 * subordinate prompt section.
 *
 * This replaces the V1 chain's blind concatenation of the last three skill
 * results: a node now receives exactly the upstream output its inputBindings
 * named, and the section keeps the same standing guardrail -- prior findings
 * are context for avoiding repeated work, never evidence for a final claim.
 */
export const buildPriorFindingsSection = (priorFindings) => {
  const text = normalizeText(priorFindings);

  if (!text) {
    return "";
  }

  return [
    "Upstream findings from an earlier step in this same task (context only, not evidence):",
    text.slice(0, PRIOR_FINDINGS_MAX_LENGTH),
    "Use these findings to avoid repeating work. Verify every claim you keep against the selected document citations, and drop anything the documents do not support.",
  ].join("\n\n");
};
