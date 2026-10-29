import { normalizeSemanticText } from "./text.js";

const setsIntersect = (left = [], right = []) => {
  const rightSet = new Set(right);
  return left.some((term) => rightSet.has(term));
};

export const hasReversedTermOrder = (
  claimTerms = [],
  supportTerms = [],
  { pivotTerms = null } = {}
) => {
  // The claim's terms as a run of the evidence's terms, in its order, is
  // never a reversal; the pivot heuristic below would see one wherever a word
  // repeats on both sides of the pivot ("many medical terminologies, so only
  // annotators with medical backgrounds" against the sentence it is taken
  // from, which goes on past it).
  if (
    claimTerms.length > 0 &&
    supportTerms.some((_term, start) =>
      claimTerms.every((term, index) => supportTerms[start + index] === term)
    )
  ) {
    return false;
  }

  return claimTerms.some((pivot, claimIndex) => {
    if (
      claimIndex === 0 ||
      claimIndex === claimTerms.length - 1 ||
      (pivotTerms && !pivotTerms.has(pivot))
    ) {
      return false;
    }

    const supportIndexes = supportTerms.flatMap((term, index) =>
      term === pivot ? [index] : []
    );

    return supportIndexes.some(
      (supportIndex) =>
        supportIndex > 0 &&
        supportIndex < supportTerms.length - 1 &&
        setsIntersect(
          claimTerms.slice(0, claimIndex),
          supportTerms.slice(supportIndex + 1)
        ) &&
        setsIntersect(
          claimTerms.slice(claimIndex + 1),
          supportTerms.slice(0, supportIndex)
        )
    );
  });
};

const COPULAR_POSSESSIVE_RELATION_PATTERN =
  /([\p{L}\p{N}_-]+)\s+(?:is|are|was|were)\s+([\p{L}\p{N}_-]+)'s\s+([\p{L}\p{N}_-]+)/giu;
const COPULAR_OF_RELATION_PATTERN =
  /([\p{L}\p{N}_-]+)\s+(?:is|are|was|were)\s+(?:the\s+|an?\s+)?([\p{L}\p{N}_-]+)\s+of\s+([\p{L}\p{N}_-]+)/giu;

const normalizeFrameTerm = (value = "") =>
  normalizeSemanticText(value).toLowerCase();

const extractCopularRelationFrames = (value = "") => {
  const text = normalizeSemanticText(value);
  const frames = [];

  COPULAR_POSSESSIVE_RELATION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(COPULAR_POSSESSIVE_RELATION_PATTERN)) {
    frames.push({
      actor: normalizeFrameTerm(match[1]),
      object: normalizeFrameTerm(match[2]),
      relation: normalizeFrameTerm(match[3]),
    });
  }
  COPULAR_POSSESSIVE_RELATION_PATTERN.lastIndex = 0;

  COPULAR_OF_RELATION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(COPULAR_OF_RELATION_PATTERN)) {
    frames.push({
      actor: normalizeFrameTerm(match[1]),
      object: normalizeFrameTerm(match[3]),
      relation: normalizeFrameTerm(match[2]),
    });
  }
  COPULAR_OF_RELATION_PATTERN.lastIndex = 0;

  return frames;
};

const haveSameFrame = (left, right) =>
  left.actor === right.actor &&
  left.object === right.object &&
  left.relation === right.relation;

export const areCopularRelationsSupported = (
  claimText = "",
  supportText = ""
) => {
  const claimFrames = extractCopularRelationFrames(claimText);

  if (claimFrames.length === 0) {
    return true;
  }

  const supportFrames = extractCopularRelationFrames(supportText);

  return claimFrames.every((claimFrame) =>
    supportFrames.some((supportFrame) =>
      haveSameFrame(claimFrame, supportFrame)
    )
  );
};
