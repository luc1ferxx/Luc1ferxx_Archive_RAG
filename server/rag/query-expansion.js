import { createPromptTemplate } from "../lib/prompt-template.js";
import {
  getEmbeddingQueryAdapterPath,
  getQaDenseRescue,
  getQaQueryExpansion,
  isRerankEnabled,
} from "./config.js";
import { completeTextWithMetadata } from "./openai.js";
import { definePrompt, PROMPT_IDS } from "./prompt-registry.js";
import { isRequestCancelledError } from "./request-deadline.js";
import { isRemoteRetrievalEnabled } from "./service-topology.js";
import { buildTermSet } from "./text-utils.js";

// Query expansion on the single-document QA route's own retrieval
// (RAG_QA_QUERY_EXPANSION, default off; settings in config.js). Before the
// route retrieves, the chat model is asked once:
//
//   multi_query  rewrite the question as RAG_QA_QUERY_EXPANSION_COUNT other
//                search queries (the MultiQueryRetriever / RAG-Fusion idea);
//                document-rag-execution.js runs the question and each rewrite
//                through the hybrid route and fuses the lists by reciprocal
//                rank, the question's own first (fuseExpandedQueryResults).
//   hyde         write a short passage that would answer the question
//                (HyDE, Gao et al. 2022); the dense route then searches with
//                the normalized mean of the question's query embedding and
//                the passage's document embedding (embedding-cache.js
//                embedHydeQueryVector), the sparse route with the question.
//
// What does not change: the gate judges the question (a candidate only a
// rewrite found has its query-term coverage measured against the question
// again), the answer model reads the question, and a question the query
// decomposer split into parts or a retrieval the agent planned is never
// expanded. A reply that holds nothing usable, or a failed call, leaves the
// retrieval as it was without expansion; the trace says which
// (`queryExpansion`). Codes and counts only: the generated text never leaves
// this request.
//
// Combinations that would mix in scores measured against something other
// than the question refuse instead of running (describeConflict below).

// Both prompts ask for well under this; it only bounds a model that runs on
// (qwen2.5:7b at temperature 0 once wrote until the client timeout).
export const QUERY_EXPANSION_MAX_TOKENS = 256;
// A rewrite longer than this is not a search query.
const MAX_REWRITE_CHARS = 400;
const MAX_PASSAGE_CHARS = 2000;

const multiQueryPromptV1 = createPromptTemplate(`You help search a document archive. Rewrite the user's question as {count} different search queries that could find the passage answering it.

Rules:
- Each query must ask for the same information as the question. Do not add facts, names, numbers or conditions that the question does not contain.
- Vary the wording: use synonyms and the terms a document would likely use.
- Write every query in the language of the question.
- Return exactly {count} lines, one query per line, with no numbering, quotation marks or other text.

Question: {question}`);

const hydePromptV1 = createPromptTemplate(`Write a short passage, as it might appear in a document, that answers the user's question.

Rules:
- Write 2 to 4 sentences, at most 100 words, in the language of the question.
- State the answer directly, in the style and vocabulary of such a document. If you do not know the answer, write a plausible one; it is used only to search the archive.
- Return only the passage, with no title, preface or notes.

Question: {question}`);

const QUERY_EXPANSION_PROMPTS = Object.freeze({
  hyde: {
    descriptor: definePrompt({ id: PROMPT_IDS.qaQueryHyde, source: hydePromptV1.source, version: "v1" }),
    render: (values) => hydePromptV1.format(values),
  },
  multi_query: {
    descriptor: definePrompt({
      id: PROMPT_IDS.qaQueryMultiQuery,
      source: multiQueryPromptV1.source,
      version: "v1",
    }),
    render: (values) => multiQueryPromptV1.format(values),
  },
});

/** Every expansion template (the pinned fingerprint test, prompt-catalog.js). */
export const listQueryExpansionPromptDescriptors = () =>
  Object.values(QUERY_EXPANSION_PROMPTS).map(({ descriptor }) => descriptor);

/** The template the current setting sends, none when it is off. */
export const getActiveQueryExpansionPromptDescriptors = () => {
  const setting = getQaQueryExpansion();

  return setting ? [QUERY_EXPANSION_PROMPTS[setting.mode].descriptor] : [];
};

/** `id@version#fingerprint` of a mode's template, as evaluation reports record it. */
export const describeQueryExpansionPrompt = (mode) => {
  const descriptor = QUERY_EXPANSION_PROMPTS[mode]?.descriptor;

  return descriptor ? `${descriptor.id}@${descriptor.version}#${descriptor.fingerprint}` : null;
};

const describeConflict = ({ mode }) => {
  if (getQaDenseRescue()) {
    return "cannot run with RAG_QA_DENSE_RESCUE: the rescue's threshold is a cosine to the question's own vector, and expanded candidates carry cosines to another vector.";
  }

  if (mode === "hyde" && isRemoteRetrievalEnabled()) {
    return "cannot run with a retrieval tier (RETRIEVAL_SERVICE_URL): HyDE searches with a vector, and a remote retrieval carries query texts only.";
  }

  if (mode === "hyde" && getEmbeddingQueryAdapterPath()) {
    return "cannot run with RAG_EMBEDDING_QUERY_ADAPTER: the adapter maps question vectors, and HyDE's vector mixes in a passage's document embedding.";
  }

  if (mode === "multi_query" && isRerankEnabled()) {
    return "cannot run with RAG_RERANK_ENABLED (any RAG_RERANK_PROVIDER): each rewrite's candidates would be reranked against the rewrite, and with the cross-encoder the rerank gate would read those scores as relevance to the question.";
  }

  return null;
};

/**
 * The setting in effect, null when off. Throws on an invalid value (config.js)
 * and on a combination it cannot run with (code RAG_QA_QUERY_EXPANSION_CONFLICT).
 */
export const resolveQaQueryExpansion = () => {
  const setting = getQaQueryExpansion();

  if (!setting) {
    return null;
  }

  const conflict = describeConflict(setting);

  if (conflict) {
    throw Object.assign(new Error(`RAG_QA_QUERY_EXPANSION=${setting.mode} ${conflict}`), {
      code: "RAG_QA_QUERY_EXPANSION_CONFLICT",
    });
  }

  return setting;
};

/** Where an app is built (createAppServices): a wrong value refuses the start. */
export const assertQaQueryExpansionSettings = () => {
  resolveQaQueryExpansion();
};

const normalizeForComparison = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.?!。？！]+$/u, "")
    .trim();

// A leading list marker followed by a space: "- ", "* ", "• ", "1. ", "2) ",
// "(3) ", or a label "Q1:", "Q1) ", "Query 2 - ", "Query:". A number or a
// word that starts the query itself ("2.5 million ...", "Q-learning ...",
// "Q3-2024 revenue", "Q4.2024") is not one: after a label's ".", ")" or "-"
// a space must follow.
const LIST_MARKER_PATTERN =
  /^(?:[-*•]+\s+|\(?\d{1,2}[.)]\s+|(?:q|query)\s*\d{1,2}\s*(?:[:：]\s*|[.)-]\s+)|(?:q|query)\s*[:：]\s*)/iu;
const SURROUNDING_QUOTES_PATTERN = /^["'“”‘’「『]+|["'“”‘’」』]+$/gu;

/**
 * The rewrites a multi_query reply holds: one per line, list markers and
 * surrounding quotes removed, a preface line ending in ":" dropped, never the
 * question itself or a repeat, at most `count`. A line with no term a store
 * would score ("1.", "```", "---", "N/A", "What is it?": buildTermSet, the
 * stores' and the gate's own term set) is no query and takes no slot: its
 * search would return candidates with no coverage to read.
 */
export const parseRewrittenQueries = (text, { count, question }) => {
  const seen = new Set([normalizeForComparison(question)]);
  const rewrites = [];

  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const rewrite = line
      .trim()
      .replace(LIST_MARKER_PATTERN, "")
      .replace(SURROUNDING_QUOTES_PATTERN, "")
      .replace(/\s+/gu, " ")
      .trim();
    const key = normalizeForComparison(rewrite);

    if (
      !rewrite ||
      /[:：]$/u.test(rewrite) ||
      rewrite.length > MAX_REWRITE_CHARS ||
      seen.has(key) ||
      buildTermSet(rewrite).size === 0
    ) {
      continue;
    }

    seen.add(key);
    rewrites.push(rewrite);

    if (rewrites.length >= count) {
      break;
    }
  }

  return rewrites;
};

/** The passage a hyde reply holds, a leading "Passage:" label removed; null when empty. */
export const parseHypotheticalPassage = (text) => {
  const passage = String(text ?? "")
    .trim()
    .replace(/^(?:passage|answer)\s*[:：]\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_PASSAGE_CHARS);

  return passage || null;
};

/**
 * The normalized mean of two vectors each scaled to unit length: HyDE's
 * estimator with one generated document (the paper averages the query's and
 * the documents' embeddings), so neither side wins by its norm.
 */
export const meanOfUnitVectors = (left, right) => {
  const length = left?.length ?? 0;

  if (length === 0 || length !== (right?.length ?? 0)) {
    throw new Error(`HyDE needs two vectors of one width; got ${length} and ${right?.length ?? 0}.`);
  }

  const normOf = (vector) => Math.sqrt(Array.from(vector).reduce((sum, value) => sum + value * value, 0));
  const leftNorm = normOf(left);
  const rightNorm = normOf(right);

  if (!(leftNorm > 0) || !(rightNorm > 0)) {
    throw new Error("HyDE cannot average a zero vector.");
  }

  const sum = Array.from(left, (value, index) => value / leftNorm + right[index] / rightNorm);
  const sumNorm = normOf(sum);

  if (!(sumNorm > 0)) {
    throw new Error("HyDE's question and passage vectors cancel out.");
  }

  return sum.map((value) => value / sumNorm);
};

const toErrorCode = (error) => String(error?.code ?? error?.name ?? "error").slice(0, 64);

/**
 * One expansion call for `question` under `setting` (resolveQaQueryExpansion).
 * Returns `{ rewrites }` (multi_query) or `{ passage }` (hyde) with
 * `diagnostics`, or `diagnostics` alone when the reply held nothing usable or
 * the call failed; a cancelled request still throws.
 */
export const expandQaQuestion = async ({ question, setting }) => {
  const prompt = QUERY_EXPANSION_PROMPTS[setting.mode];
  const startedAt = performance.now();
  let finishReason = null;
  const describe = (fields) => ({
    durationMs: Math.round(performance.now() - startedAt),
    mode: setting.mode,
    ...fields,
  });

  try {
    const { text } = await completeTextWithMetadata(prompt.render({ count: String(setting.count), question }), {
      maxTokens: QUERY_EXPANSION_MAX_TOKENS,
      onFinishReason: (reason) => {
        finishReason = reason;
      },
      promptTemplate: prompt.descriptor,
      ...(setting.temperature === null ? {} : { temperature: setting.temperature }),
    });
    const truncated = finishReason === "length";

    if (setting.mode === "hyde") {
      const passage = parseHypotheticalPassage(text);

      return passage
        ? { diagnostics: describe({ applied: true, generated: 1, truncated }), passage }
        : { diagnostics: describe({ applied: false, fallback: "empty_reply", generated: 0, truncated }) };
    }

    const rewrites = parseRewrittenQueries(text, { count: setting.count, question });

    return rewrites.length > 0
      ? { diagnostics: describe({ applied: true, generated: rewrites.length, truncated }), rewrites }
      : { diagnostics: describe({ applied: false, fallback: "empty_reply", generated: 0, truncated }) };
  } catch (error) {
    if (isRequestCancelledError(error)) {
      throw error;
    }

    const errorCode = toErrorCode(error);

    console.warn(
      `RAG_QA_QUERY_EXPANSION=${setting.mode}: the expansion call failed (${errorCode}); retrieving with the question alone.`
    );

    return { diagnostics: describe({ applied: false, errorCode, fallback: "model_error", generated: 0 }) };
  }
};

export { toErrorCode as describeQueryExpansionErrorCode };
