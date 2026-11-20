import { createHash } from "node:crypto";

// Every prompt sent to a chat model is identified by a descriptor:
//
//   id           what the prompt is for (stable across edits)
//   version      the template variant in use; RAG_PROMPT_VERSION selects it for
//                the answer, rewrite and web prompts, the others have one
//   fingerprint  first 12 hex chars of the SHA-256 of the unrendered template
//                (or, for prompts built by a function, of that function's
//                output for an empty input: the instructions plus the input
//                field names, without any request data)
//
// The descriptor travels with the model call into the LLMOps metric event, the
// model span, the run's prompt ledger and the planner decisions, and every
// evaluation report records the descriptors in effect. Two calls with the same
// fingerprint used byte-identical instructions; test/prompt-registry.test.mjs
// pins each id@version to its fingerprint so an edited template must be
// recorded as a new version rather than change silently under an old one.

export const PROMPT_IDS = Object.freeze({
  claimJudge: "claim_judge",
  comparisonAnswer: "comparison_answer",
  dagPlanner: "dag_planner",
  executionPlanner: "execution_planner",
  guardedComparisonAnswer: "guarded_comparison_answer",
  intentPlanner: "intent_planner",
  memoryQueryRewrite: "memory_query_rewrite",
  qaAnswer: "qa_answer",
  replanner: "replanner",
  webAnswer: "web_answer",
});

const FINGERPRINT_LENGTH = 12;
const PROMPT_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PROMPT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{12}$/;

export const fingerprintPromptSource = (source) =>
  createHash("sha256").update(String(source ?? "")).digest("hex").slice(0, FINGERPRINT_LENGTH);

export const definePrompt = ({ id, source, version }) => {
  if (!PROMPT_ID_PATTERN.test(id ?? "") || !PROMPT_VERSION_PATTERN.test(version ?? "")) {
    throw new Error(`Invalid prompt descriptor ${id}@${version}.`);
  }

  if (!String(source ?? "").trim()) {
    throw new Error(`Prompt ${id}@${version} has no source text to fingerprint.`);
  }

  return Object.freeze({ fingerprint: fingerprintPromptSource(source), id, version });
};

/**
 * Keeps a descriptor only when every field is well formed, so a metric or a
 * report never carries a half-identified prompt.
 */
export const normalizePromptDescriptor = (prompt) => {
  if (!prompt || typeof prompt !== "object") {
    return null;
  }

  const id = String(prompt.id ?? "");
  const version = String(prompt.version ?? "");
  const fingerprint = String(prompt.fingerprint ?? "");

  return PROMPT_ID_PATTERN.test(id) &&
    PROMPT_VERSION_PATTERN.test(version) &&
    FINGERPRINT_PATTERN.test(fingerprint)
    ? { fingerprint, id, version }
    : null;
};

/**
 * One hash for a whole set of descriptors, independent of order, so two
 * reports can be compared with a single value.
 */
export const hashPromptSet = (prompts = []) =>
  fingerprintPromptSource(
    JSON.stringify(
      prompts
        .map(normalizePromptDescriptor)
        .filter(Boolean)
        .map(({ fingerprint, id, version }) => `${id}@${version}#${fingerprint}`)
        .sort()
    )
  );
