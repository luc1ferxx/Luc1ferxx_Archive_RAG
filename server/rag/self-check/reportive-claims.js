import { normalizeSemanticText } from "./text.js";

const DOCUMENT_NOUN_PATTERN =
  "(?:documents?|polic(?:y|ies)|handbooks?|sources?|agreements?|contracts?)";
const CARDINAL_WORDS = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
]);
const REPORTIVE_VERB_PATTERN =
  "(?:states?|stated|says?|said|specif(?:y|ies|ied)|references?|referenced|includes?|included)";
const GENERIC_REPORTER_PATTERN = new RegExp(
  `^\\s*(?:[-*]\\s*)?(?:(?:both|each|all(?:\\s+(?:[a-z]+|\\d+))?)\\s+${DOCUMENT_NOUN_PATTERN}|both)\\s+(${REPORTIVE_VERB_PATTERN})\\s+(.+)$`,
  "i"
);

const escapeRegExp = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripOuterQuotes = (value = "") =>
  String(value ?? "")
    .trim()
    .replace(/^["“](.*)["”]$/u, "$1")
    .trim();

const normalizeReportivePayload = ({ payload = "", verb = "" } = {}) => {
  const normalizedPayload = String(payload ?? "").trim();
  const nominalRequirement =
    /^the\s+requirement\s+(?:for|of)\s+(.+)$/i.exec(normalizedPayload);
  let factualClaim = nominalRequirement
    ? `${nominalRequirement[1].replace(/[.!?。！？]+$/u, "").trim()} is required.`
    : normalizedPayload
        .replace(/^that\s+/i, "")
        .replace(/^the\s+(?:condition|rule|term)\s+/i, "")
        .trim();

  if (/^includ|^referenc/i.test(verb)) {
    factualClaim = factualClaim.replace(
      /^["“]?with\s+([^"”]+?)["”]?\s+for\s+(.+)$/iu,
      "$2 with $1"
    );
    factualClaim = factualClaim.replace(
      /^(.+?)\s+for\s+(remote\s+work)([.!?]?)$/iu,
      "$2 $1$3"
    );
  }

  factualClaim = factualClaim.replace(
    /^["“]([^"”]+)["”]\s+for\s+(.+?)([.!?]?)$/u,
    "$2 is $1$3"
  );

  return stripOuterQuotes(factualClaim);
};

const matchExplicitReporter = ({ claimText = "", aliases = [] } = {}) => {
  const aliasPattern = [...new Set(aliases.filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((alias) =>
      String(alias)
        .split(/\s+/g)
        .filter(Boolean)
        .map(escapeRegExp)
        .join("[^a-z0-9一-鿿]+")
    )
    .join("|");

  if (!aliasPattern) {
    return null;
  }

  return new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:${aliasPattern})\\s+(${REPORTIVE_VERB_PATTERN})\\s+(.+)$`,
    "i"
  ).exec(claimText);
};

export const normalizeDocumentReportiveClaim = ({
  claimText = "",
  documentAliases = [],
} = {}) => {
  const normalizedClaim = normalizeSemanticText(claimText).trim();
  const match =
    GENERIC_REPORTER_PATTERN.exec(normalizedClaim) ??
    matchExplicitReporter({
      claimText: normalizedClaim,
      aliases: documentAliases,
    });

  if (!match) {
    return normalizedClaim;
  }

  if (
    /^includ/i.test(match[1]) &&
    !/^the\s+(?:condition|requirement|rule|term)\b/i.test(match[2])
  ) {
    return normalizedClaim;
  }

  return normalizeReportivePayload({
    verb: match[1],
    payload: match[2],
  });
};

export const getDocumentRelationCardinality = (claimText = "") => {
  const normalizedClaim = normalizeSemanticText(claimText).trim();
  const bothMatch = new RegExp(
    `^\\s*(?:[-*]\\s*)?both(?:\\s+${DOCUMENT_NOUN_PATTERN})?\\b`,
    "i"
  ).exec(normalizedClaim);

  if (bothMatch) {
    return 2;
  }

  const allMatch = new RegExp(
    `^\\s*(?:[-*]\\s*)?all\\s+([a-z]+|\\d+)\\s+${DOCUMENT_NOUN_PATTERN}\\b`,
    "i"
  ).exec(normalizedClaim);

  if (!allMatch) {
    return null;
  }

  const numericCardinality = Number(allMatch[1]);

  return Number.isInteger(numericCardinality) && numericCardinality > 0
    ? numericCardinality
    : CARDINAL_WORDS.get(allMatch[1].toLowerCase()) ?? Number.NaN;
};
