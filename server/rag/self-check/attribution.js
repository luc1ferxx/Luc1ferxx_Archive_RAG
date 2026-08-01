import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import {
  CHECKABLE_CITATION_FIELDS,
  CHINESE_ATTRIBUTION_PREFIX_PATTERN,
  CHINESE_ATTRIBUTION_VERB_PATTERN,
  CHINESE_DOCUMENT_IDENTITY_PATTERN,
  DOCUMENT_ATTRIBUTION_PREPOSITIONS,
  DOCUMENT_ATTRIBUTION_VERBS,
  DOCUMENT_IDENTITY_TERMS,
  FILE_EXTENSION_TERMS,
  STRUCTURAL_SECTION_HEADING_PATTERN,
} from "./patterns.js";
import { splitModalityClauses } from "./modality.js";
import {
  includesNormalizedPhrase,
  normalizeEvidenceText,
  normalizeStructuralClaimLabel,
  stripSourceLabels,
  uniqueValues,
} from "./text.js";

export const getCitationDocIds = (citations = []) =>
  new Set(
    citations
      .map((citation) => citation?.docId)
      .filter((docId) => typeof docId === "string" && docId.trim())
  );

export const hasCheckableCitationText = (citations = []) =>
  citations.some((citation) =>
    CHECKABLE_CITATION_FIELDS.some((field) =>
      normalizeEvidenceText(citation?.[field])
    )
  );

export const getCitationDocumentLabels = (citations = []) =>
  new Set(
    citations.flatMap((citation) => {
      const fileName = normalizeEvidenceText(citation?.fileName);
      const fileNameWithoutExtension = fileName.replace(/\.[^.]+$/, "");

      return [fileName, fileNameWithoutExtension, citation?.docId]
        .map(normalizeSearchText)
        .filter(Boolean);
    })
  );

export const getCitationDocumentAliasEntries = (citation = {}) => {
  const fileName = normalizeEvidenceText(citation?.fileName);
  const fileNameWithoutExtension = fileName.replace(/\.[^.]+$/, "");
  const docId = normalizeEvidenceText(citation?.docId);
  const rawLabels = [
    { value: fileName, isDocId: false },
    { value: fileNameWithoutExtension, isDocId: false },
    { value: docId, isDocId: true },
  ].filter((entry) => entry.value);
  const entries = rawLabels.map(({ value, isDocId }) => {
    const normalized = normalizeSearchText(value);
    const terms = extractMeaningfulTokens(normalized);
    const identityLike =
      isDocId ||
      /\d/.test(value) ||
      CHINESE_DOCUMENT_IDENTITY_PATTERN.test(value) ||
      terms.some((term) => DOCUMENT_IDENTITY_TERMS.has(term));

    return {
      normalized,
      removable:
        identityLike && (terms.length >= 2 || /[-_]/.test(value)),
    };
  });

  for (const entry of [...entries]) {
    const terms = extractMeaningfulTokens(entry.normalized);
    const shortAlias = [...terms]
      .reverse()
      .find(
        (term) =>
          !FILE_EXTENSION_TERMS.has(term) &&
          !DOCUMENT_IDENTITY_TERMS.has(term)
      );

    if (entry.removable && shortAlias?.length >= 3) {
      entries.push({
        normalized: shortAlias,
        removable: true,
      });
    }
  }

  return [...new Map(entries.map((entry) => [entry.normalized, entry])).values()]
    .filter((entry) => entry.normalized)
    .sort((left, right) => right.normalized.length - left.normalized.length);
};

export const getCitationDocumentAliases = (citation = {}) =>
  getCitationDocumentAliasEntries(citation).map((entry) => entry.normalized);

export const isExplicitDocumentAttribution = ({
  claimText = "",
  alias = "",
} = {}) => {
  if (/[一-鿿]/.test(alias) && includesNormalizedPhrase(claimText, alias)) {
    const compactClaim = normalizeSearchText(claimText).replace(/\s+/g, "");
    const compactAlias = normalizeSearchText(alias).replace(/\s+/g, "");
    const aliasIndex = compactClaim.indexOf(compactAlias);
    const beforeAlias = compactClaim.slice(0, aliasIndex);
    const afterAlias = compactClaim.slice(aliasIndex + compactAlias.length);

    if (
      aliasIndex >= 0 &&
      (CHINESE_ATTRIBUTION_PREFIX_PATTERN.test(beforeAlias) ||
        CHINESE_ATTRIBUTION_VERB_PATTERN.test(afterAlias))
    ) {
      return true;
    }
  }

  const claimTerms = normalizeSearchText(claimText).split(/\s+/g).filter(Boolean);
  const aliasTerms = normalizeSearchText(alias).split(/\s+/g).filter(Boolean);

  if (aliasTerms.length === 0 || claimTerms.length < aliasTerms.length) {
    return false;
  }

  const aliasPattern = aliasTerms
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^a-z0-9一-鿿]+");

  if (
    new RegExp(`(?:^|\\s|[-*])${aliasPattern}\\s*[:：]`, "i").test(
      claimText
    ) ||
    new RegExp(`[（(]\\s*${aliasPattern}\\s*[)）]`, "i").test(claimText)
  ) {
    return true;
  }

  for (let index = 0; index <= claimTerms.length - aliasTerms.length; index += 1) {
    const matches = aliasTerms.every(
      (term, offset) => claimTerms[index + offset] === term
    );

    if (!matches) {
      continue;
    }

    const previousTerm = claimTerms[index - 1] ?? "";
    const nextTerm = claimTerms[index + aliasTerms.length] ?? "";

    if (
      DOCUMENT_ATTRIBUTION_PREPOSITIONS.has(previousTerm) ||
      DOCUMENT_ATTRIBUTION_PREPOSITIONS.has(nextTerm) ||
      DOCUMENT_ATTRIBUTION_VERBS.has(nextTerm)
    ) {
      return true;
    }
  }

  return false;
};

export const getDocumentAttributionTerms = ({
  claimText = "",
  citations = [],
  forceComparisonClaim = false,
} = {}) =>
  new Set(
    citations.flatMap((citation) =>
      getCitationDocumentAliasEntries(citation)
        .filter(
          (entry) =>
            entry.removable &&
            includesNormalizedPhrase(claimText, entry.normalized) &&
            (forceComparisonClaim ||
              isExplicitDocumentAttribution({
                claimText,
                alias: entry.normalized,
              }))
        )
        .flatMap((entry) => extractMeaningfulTokens(entry.normalized))
    )
  );

export const getGenericDocumentAttributionTerms = (claimText = "") => {
  const terms = normalizeSearchText(claimText).split(/\s+/g).filter(Boolean);
  const attributionVerbIndex = terms.findIndex((term) =>
    DOCUMENT_ATTRIBUTION_VERBS.has(term)
  );

  if (
    attributionVerbIndex <= 0 ||
    !terms
      .slice(0, attributionVerbIndex)
      .some((term) => DOCUMENT_IDENTITY_TERMS.has(term))
  ) {
    return new Set();
  }

  return new Set(terms.slice(0, attributionVerbIndex + 1));
};

export const getCitationIdentity = (citation = {}, index = 0) =>
  normalizeEvidenceText(citation?.docId) ||
  normalizeSearchText(citation?.fileName) ||
  `citation-${index + 1}`;

export const getExplicitlyAttributedCitationIdentities = ({
  claimText = "",
  citations = [],
} = {}) =>
  uniqueValues(
    citations.flatMap((citation, index) => {
      const explicitlyAttributed = getCitationDocumentAliasEntries(citation).some(
        (entry) =>
          entry.removable &&
          includesNormalizedPhrase(claimText, entry.normalized) &&
          isExplicitDocumentAttribution({
            claimText,
            alias: entry.normalized,
          })
      );

      return explicitlyAttributed ? [getCitationIdentity(citation, index)] : [];
    })
  );

export const getMetadataFactAnchors = ({ claimText = "", citations = [] } = {}) =>
  uniqueValues(
    citations.flatMap((citation) =>
      getCitationDocumentAliasEntries(citation)
        .filter(
          (entry) =>
            !entry.removable && includesNormalizedPhrase(claimText, entry.normalized)
        )
        .map((entry) => entry.normalized)
    )
  );

export const isStructuralSectionHeading = (value = "") =>
  STRUCTURAL_SECTION_HEADING_PATTERN.test(normalizeStructuralClaimLabel(value));

export const isStructuralClaimLabel = ({ value = "", citations = [] } = {}) => {
  const label = normalizeStructuralClaimLabel(value);
  const normalizedLabel = normalizeSearchText(label);

  return (
    isStructuralSectionHeading(label) ||
    getCitationDocumentLabels(citations).has(normalizedLabel)
  );
};

export const groupCitationsByDocument = (citations = []) => {
  const groupsByIdentity = new Map();

  citations.forEach((citation, index) => {
    const identity = getCitationIdentity(citation, index);
    const existing = groupsByIdentity.get(identity);

    if (existing) {
      existing.citations.push(citation);
      return;
    }

    groupsByIdentity.set(identity, {
      identity,
      docId: normalizeEvidenceText(citation?.docId) || null,
      citations: [citation],
    });
  });

  return [...groupsByIdentity.values()];
};

export const getGroupDocumentAliases = (group = {}) =>
  uniqueValues(
    (group.citations ?? []).flatMap((citation) =>
      getCitationDocumentAliases(citation)
    )
  );

export const buildCitationSupportSentences = (citations = []) =>
  uniqueValues(
    citations.flatMap((citation) =>
      CHECKABLE_CITATION_FIELDS.flatMap((field) =>
        String(citation?.[field] ?? "")
          .split(/(?<=[.!?。！？])\s+|\n+/g)
          .map((sentence) => sentence.trim())
          .filter(Boolean)
      )
    )
  );

export const buildCitationSupportSegments = (
  citations = [],
  { includeParentSentences = true } = {}
) =>
  uniqueValues(
    buildCitationSupportSentences(citations).flatMap((sentence) => {
      const clauses = splitModalityClauses(sentence);

      if (clauses.length <= 1) {
        return [sentence];
      }

      return includeParentSentences ? [sentence, ...clauses] : clauses;
    })
  );

export const getCitationSourceRank = ({
  citation,
  scopedCitations = [],
  sourceRanks = [],
} = {}) => {
  const explicitRank = Number(citation?.rank);

  if (Number.isInteger(explicitRank) && explicitRank > 0) {
    return explicitRank;
  }

  const citationIndex = scopedCitations.indexOf(citation);
  const fallbackRank = Number(sourceRanks[citationIndex]);

  return Number.isInteger(fallbackRank) && fallbackRank > 0
    ? fallbackRank
    : null;
};
