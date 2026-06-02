import {
  getMaxQueryRequirements,
  isQueryDecompositionEnabled,
} from "./config.js";
import {
  extractMeaningfulTokens,
  normalizeSearchText,
  normalizeWhitespace,
} from "./text-utils.js";

const SPLIT_PATTERN =
  /\s+(?:and|also|plus|as well as)\s+|[;；]|以及|并且|同时|、/i;
const TOPIC_PATTERN =
  /\b(?:the\s+)?([a-z0-9][a-z0-9\s-]{1,70}?\b(?:policy|procedure|manual|handbook|guide|rule|rules|requirement|requirements|window|amount|ceiling|limit|limits))\b/i;
const PRONOUN_REFERENCE_PATTERN = /\b(it|this|that|they|them)\b/i;
const LEADING_TOPIC_FILLER_PATTERN =
  /^(?:(?:when|what|which|where|how|why|who|does|do|is|are|was|were|the|a|an)\s+)+/i;

const toSentence = (value = "") =>
  normalizeWhitespace(value).replace(/[?？.。!！]+$/g, "").trim();

const buildPrimaryRequirement = (query) => ({
  id: "primary",
  label: "Overall question",
  query: normalizeWhitespace(query),
  primary: true,
});

const extractSharedTopic = (query) => {
  const match = normalizeWhitespace(query).match(TOPIC_PATTERN);
  const label = (match?.[1] ?? "")
    .replace(LEADING_TOPIC_FILLER_PATTERN, "")
    .trim();

  if (!label) {
    return null;
  }

  return {
    label,
    terms: new Set(extractMeaningfulTokens(label)),
  };
};

const fragmentHasTopic = (fragment, topic) => {
  if (!topic?.terms?.size) {
    return true;
  }

  const fragmentTerms = new Set(extractMeaningfulTokens(fragment));

  for (const term of topic.terms) {
    if (fragmentTerms.has(term)) {
      return true;
    }
  }

  return false;
};

const addTopicToFragment = (fragment, topic) => {
  if (!topic || fragmentHasTopic(fragment, topic)) {
    return fragment;
  }

  if (PRONOUN_REFERENCE_PATTERN.test(fragment)) {
    return fragment.replace(PRONOUN_REFERENCE_PATTERN, `the ${topic.label}`);
  }

  return `${fragment} for the ${topic.label}`;
};

const splitQueryIntoFragments = (query) =>
  normalizeWhitespace(query)
    .split(SPLIT_PATTERN)
    .map(toSentence)
    .filter((fragment) => extractMeaningfulTokens(fragment).length > 0);

const dedupeRequirements = (requirements) => {
  const seenQueries = new Set();
  const deduped = [];

  for (const requirement of requirements) {
    const key = normalizeSearchText(requirement.query);

    if (!key || seenQueries.has(key)) {
      continue;
    }

    seenQueries.add(key);
    deduped.push(requirement);
  }

  return deduped;
};

export const buildEvidenceRequirements = ({ query, mode = "qa" } = {}) => {
  const primary = buildPrimaryRequirement(query);

  if (!isQueryDecompositionEnabled()) {
    return [primary];
  }

  const fragments = splitQueryIntoFragments(query);

  if (fragments.length < 2) {
    return [primary];
  }

  const topic = extractSharedTopic(query);
  const maxRequirements = getMaxQueryRequirements();
  const requirements = fragments
    .map((fragment, index) => ({
      id: `requirement-${index + 1}`,
      label: addTopicToFragment(fragment, topic),
      query: addTopicToFragment(fragment, topic),
      primary: false,
      mode,
    }))
    .slice(0, maxRequirements);

  return dedupeRequirements(requirements).length > 1
    ? dedupeRequirements(requirements)
    : [primary];
};

export const buildRetrievalQueries = ({ query, requirements }) => {
  const primary = buildPrimaryRequirement(query);
  const allRequirements = [primary, ...(requirements ?? [])];

  return dedupeRequirements(allRequirements).map((requirement) => ({
    id: requirement.id,
    label: requirement.label,
    query: requirement.query,
    primary: Boolean(requirement.primary),
  }));
};
