const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "these",
  "those",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "vs",
  "versus",
  "can",
  "could",
  "should",
  "would",
  "will",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "them",
  "our",
  "your",
  "his",
  "her",
  "its",
  "theirs",
  "ours",
  "yours",
  "about",
  "against",
  "between",
  "policy",
  "policies",
  "document",
  "documents",
  "file",
  "files",
  "than",
  "then",
  "there",
  "here",
  "also",
  "just",
  "compare",
  "comparison",
  "different",
  "difference",
  "same",
  "similar",
  "conflict",
  "contrast",
  "contradict",
  "not",
  "no",
  "yes",
  "\u6bd4\u8f83",
  "\u533a\u522b",
  "\u5dee\u5f02",
  "\u54ea\u4e9b",
  "\u4ec0\u4e48",
  "\u8fd9\u4e2a",
  "\u90a3\u4e2a",
  "\u4e00\u4e0b",
  "\u91cc\u9762",
  "\u53ef\u4ee5",
  "\u662f\u5426",
  "\u4ee5\u53ca",
  "\u8fd8\u662f",
  "\u8fdb\u884c",
  "\u4e00\u4e2a",
  "\u4e00\u79cd",
  "\u6211\u4eec",
  "\u4f60\u4eec",
  "\u4ed6\u4eec",
]);

const isCjkToken = (value) => /[\u4e00-\u9fff]/.test(value);

export const normalizeWhitespace = (value = "") =>
  value
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

export const normalizeToken = (value = "") =>
  value
    .toLowerCase()
    .replace(/^[^a-z0-9\u4e00-\u9fff]+/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+$/i, "");

export const tokenize = (value = "") =>
  (value.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]/g) ?? [])
    .map((token) => normalizeToken(token))
    .filter(Boolean);

const isMeaningfulToken = (token) =>
  Boolean(token) && (token.length > 1 || isCjkToken(token)) && !STOP_WORDS.has(token);

export const extractMeaningfulTokens = (value = "") =>
  tokenize(value).filter((token) => isMeaningfulToken(token));

export const buildTermSet = (value = "") =>
  new Set(extractMeaningfulTokens(value));

export const buildTermFrequencyMap = (value = "") => {
  const frequencies = new Map();

  for (const token of extractMeaningfulTokens(value)) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  return frequencies;
};

export const extractTerms = (value = "", { limit = 10 } = {}) => {
  const frequencies = new Map();

  for (const token of tokenize(value)) {
    if (!isMeaningfulToken(token)) {
      continue;
    }

    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  return [...frequencies.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([term, count]) => ({
      value: term,
      count,
    }));
};

export const splitParagraphs = (value = "") =>
  normalizeWhitespace(value)
    .split(/\n+/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean);
