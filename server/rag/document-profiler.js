import {
  extractMeaningfulTokens,
  normalizeWhitespace,
} from "./text-utils.js";

const MAX_SUMMARY_LENGTH = 260;
const MAX_TAGS = 12;
const MAX_ENTITIES = 8;
const SENTENCE_PATTERN = /(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/;
const ENTITY_PATTERN =
  /\b(?:[A-Z][A-Za-z0-9&/-]{2,}(?:\s+[A-Z][A-Za-z0-9&/-]{2,}){0,4}|[A-Z]{2,})\b/g;
const TAG_STOP_TERMS = new Set([
  "policy",
  "policies",
  "document",
  "documents",
  "employee",
  "employees",
  "requirement",
  "requirements",
  "section",
  "sections",
  "page",
  "pages",
  "must",
  "may",
  "with",
  "from",
  "per",
  "this",
  "that",
  "they",
  "their",
  "there",
  "where",
  "which",
  "about",
  "approved",
  "approval",
  "manager",
  "客户",
  "文档",
  "政策",
  "要求",
  "资料",
  "文件",
]);

const uniq = (values) => [...new Set(values.filter(Boolean))];

const truncate = (value, maxLength) => {
  const normalizedValue = normalizeWhitespace(value);

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 1).trim()}...`;
};

const getPageText = (page) =>
  normalizeWhitespace(typeof page === "string" ? page : page?.text ?? "");

const splitSentences = (text) =>
  normalizeWhitespace(text)
    .split(SENTENCE_PATTERN)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);

const buildSummary = ({ fileName, text }) => {
  const sentences = splitSentences(text);
  const selectedSentences = sentences
    .filter((sentence) => sentence.length >= 24)
    .slice(0, 2);

  if (selectedSentences.length > 0) {
    return truncate(selectedSentences.join(" "), MAX_SUMMARY_LENGTH);
  }

  const fallback = text || fileName;
  return truncate(fallback, MAX_SUMMARY_LENGTH);
};

const buildTags = ({ fileName, text }) => {
  const tokenCounts = new Map();
  const firstPositions = new Map();
  const sourceText = text || fileName;
  let position = 0;

  for (const token of extractMeaningfulTokens(sourceText)) {
    const normalizedToken = token.toLowerCase();
    position += 1;

    if (normalizedToken.length < 3 || TAG_STOP_TERMS.has(normalizedToken)) {
      continue;
    }

    tokenCounts.set(normalizedToken, (tokenCounts.get(normalizedToken) ?? 0) + 1);

    if (!firstPositions.has(normalizedToken)) {
      firstPositions.set(normalizedToken, position);
    }
  }

  return [...tokenCounts.entries()]
    .sort(
      (left, right) =>
        right[1] - left[1] ||
        firstPositions.get(left[0]) - firstPositions.get(right[0]) ||
        left[0].localeCompare(right[0])
    )
    .slice(0, MAX_TAGS)
    .map(([token]) => token);
};

const buildEntities = ({ fileName, text }) => {
  const entityCounts = new Map();
  const sourceText = `${fileName}\n${text}`;

  for (const match of sourceText.matchAll(ENTITY_PATTERN)) {
    const entity = normalizeWhitespace(match[0]);

    if (!entity || entity.length < 3) {
      continue;
    }

    entityCounts.set(entity, (entityCounts.get(entity) ?? 0) + 1);
  }

  return uniq(
    [...entityCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_ENTITIES)
      .map(([entity]) => entity)
  );
};

export const buildDocumentProfile = ({ fileName, pages }) => {
  const text = pages.map(getPageText).filter(Boolean).join("\n");
  const summary = buildSummary({
    fileName,
    text,
  });
  const tags = buildTags({
    fileName,
    text,
  });
  const entities = buildEntities({
    fileName,
    text,
  });

  return {
    summary,
    tags,
    entities,
    generatedAt: new Date().toISOString(),
  };
};
