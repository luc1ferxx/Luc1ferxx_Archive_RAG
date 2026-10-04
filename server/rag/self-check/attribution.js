import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import { buildInflectionIndex } from "../inflection.js";
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
  copyArray,
  copyObjectArray,
  memoizeInEvidenceContext,
} from "./evidence-context.js";
import {
  hasNegativePolarity,
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

// File names that tell sibling documents apart by a short suffix -- vendor-a /
// vendor-b, contract_ii, option-beta -- are document labels even without an
// identity noun such as "policy". Topical names (remote-work.pdf) still are not,
// so a claim's subject is never stripped just because a file shares its words.
const VARIANT_LABEL_PATTERN =
  /[-_\s]([a-z]|ii|iii|iv|vi|vii|viii|ix|xi|xii|alpha|beta|gamma|delta)$/i;

const isAliasKeyPart = (value) =>
  value === undefined || value === null || typeof value === "string";

// The entries depend on the citation's file name and docId alone.
export const getCitationDocumentAliasEntries = (citation = {}) =>
  memoizeInEvidenceContext(
    "citationDocumentAliasEntries",
    isAliasKeyPart(citation?.fileName) && isAliasKeyPart(citation?.docId)
      ? JSON.stringify([citation?.fileName ?? "", citation?.docId ?? ""])
      : null,
    () => computeCitationDocumentAliasEntries(citation),
    copyObjectArray
  );

const computeCitationDocumentAliasEntries = (citation = {}) => {
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
    const variantSuffix =
      (isDocId ? value : value.replace(/\.[^.]+$/, ""))
        .match(VARIANT_LABEL_PATTERN)?.[1]
        ?.toLowerCase() ?? null;
    const identityLike =
      isDocId ||
      Boolean(variantSuffix) ||
      /\d/.test(value) ||
      CHINESE_DOCUMENT_IDENTITY_PATTERN.test(value) ||
      terms.some((term) => DOCUMENT_IDENTITY_TERMS.has(term));

    return {
      normalized,
      removable:
        identityLike && (terms.length >= 2 || /[-_]/.test(value)),
      variantSuffix,
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

    // When a variant suffix is too short to be a meaningful token (vendor-a), the
    // short alias falls back to the stem every sibling shares ("vendor") and would
    // attribute a claim to all of them. A suffix that survives (alpha) is kept.
    const sharedStemAlias = entry.variantSuffix && shortAlias !== entry.variantSuffix;

    if (entry.removable && !sharedStemAlias && shortAlias?.length >= 3) {
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

const splitSupportSentences = (text = "") =>
  memoizeInEvidenceContext(
    "splitSupportSentences",
    text,
    () =>
      text
        .split(/(?<=[.!?。！？])\s+|\n+/g)
        .map((sentence) => sentence.trim())
        .filter(Boolean),
    copyArray
  );

/**
 * PDF text keeps the page layout, so a sentence wrapped across lines arrives
 * as "... on thirty (30) days\n\nwritten notice to the other party." Split at
 * every line break, neither half supports a claim that restates the sentence.
 *
 * A line break is a wrap only when the previous line has no sentence-final
 * punctuation and the next one continues in lowercase. That leaves a heading
 * ("Remote Work Policy" / "Employees may ...") apart, which comparison
 * equivalence depends on to drop it as structure, and never merges list items
 * or labelled values ("Fee: 100" / "Term: 12 months") into one sentence.
 * Scripts without case, such as Chinese, are not rejoined.
 */
export const joinWrappedLines = (text = "") =>
  memoizeInEvidenceContext("joinWrappedLines", text, () =>
    computeJoinWrappedLines(text)
  );

const computeJoinWrappedLines = (text = "") => {
  const lines = String(text ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.reduce((joined, line, index) => {
    if (index === 0) {
      return line;
    }

    const previous = lines[index - 1];
    const wrapped = !/[.!?。！？:：;；]$/.test(previous) && /^[a-z]/.test(line);

    return `${joined}${wrapped ? " " : "\n"}${line}`;
  }, "");
};

// Line-level sentences stay; the rejoined ones are added beside them, never in
// their place, so a claim is checked against both readings of the layout.
const splitCitationFieldSentences = (text = "") =>
  memoizeInEvidenceContext(
    "citationFieldSentences",
    text,
    () => [
      ...splitSupportSentences(text),
      ...(text.includes("\n") ? splitSupportSentences(joinWrappedLines(text)) : []),
    ],
    copyArray
  );

export const buildCitationSupportSentences = (citations = []) =>
  uniqueValues(
    citations.flatMap((citation) =>
      CHECKABLE_CITATION_FIELDS.flatMap((field) =>
        splitCitationFieldSentences(String(citation?.[field] ?? ""))
      )
    )
  );

// RAG_CLAIM_HEADING_CONTEXT: a sentence under a section heading in the cited
// chunk ("Section 7. Limitation of Liability." / "The total liability ...")
// is also read with the heading's title in front of it ("Limitation of
// Liability: The total liability ..."), so an answer that names the section it
// answers from ("The limitation of liability is that ...") is checked against
// what the section says.
//
// A title comes only from an explicit "Section/Article/... N" line in Title
// Case of at most eight words, or from the chunk's own section heading; its
// numbers are dropped (so "Section 7" never supports a 7), and a negative
// title ("No Refunds") is not used. A bare numbered or unnumbered Title Case
// line ("2. Interns", "Parental Leave") is never a title, because a list item
// reads the same, but it does end the previous title's scope, as does a
// Section line whose title is rejected. A title applies until the next such
// boundary.
//
// With a claim (support.js always passes one), a title is used only when the
// claim names it as a phrase and every other word of the claim is in the
// sentence itself: the heading may supply the section's name, never a party,
// subject or fact ("Termination by Customer" does not let "the Customer may
// terminate" stand on a sentence about the Supplier).
const SECTION_MARKER_LINE_PATTERN =
  /^(?:section|article|clause|part|chapter|schedule|appendix|annex|\u00a7)\s*[\dIVXLC]+(?:\.\d+)*[.:)]?\s+(\S.*)$/i;
const NUMBERED_LINE_PATTERN = /^\d+(?:\.\d+)*[.)]?\s+(\S.*)$/;
const MAX_HEADING_TITLE_WORDS = 8;
const MINOR_TITLE_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

// The title a heading line reads as, before the negation check; null when the
// line does not read as a short Title Case heading.
const readTitleShape = (value = "") => {
  const title = String(value ?? "")
    .replace(/\d+/g, " ")
    .replace(/[.:\uff1a]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = title.split(" ").filter((word) => /[\p{L}]/u.test(word));

  if (
    words.length === 0 ||
    words.length > MAX_HEADING_TITLE_WORDS ||
    /[.!?;\u3002\uff01\uff1f\uff1b]/.test(title) ||
    !words.every((word) => MINOR_TITLE_WORDS.has(word.toLowerCase()) || /^[\p{Lu}]/u.test(word))
  ) {
    return null;
  }

  return title;
};

export const readHeadingTitle = (value = "") => {
  const title = readTitleShape(value);

  return title && !hasNegativePolarity(title) ? title : null;
};

// { boundary, title } for one line of a cited chunk.
const readHeadingLine = (line = "", metadataTitle = null) => {
  const text = String(line ?? "").trim();
  const marker = SECTION_MARKER_LINE_PATTERN.exec(text);

  if (marker) {
    return { boundary: true, title: readHeadingTitle(marker[1]) };
  }

  const numbered = NUMBERED_LINE_PATTERN.exec(text);

  // An unnumbered line ending like a sentence ("Delaware.") is a wrapped body
  // line, not a heading.
  if (numbered ? readTitleShape(numbered[1]) : !/[.!?\u3002\uff01\uff1f]$/.test(text) && readTitleShape(text)) {
    const isChunkHeading =
      Boolean(metadataTitle) &&
      normalizeSearchText(readTitleShape(numbered ? numbered[1] : text) ?? "") === normalizeSearchText(metadataTitle);

    return { boundary: true, title: isChunkHeading ? metadataTitle : null };
  }

  return { boundary: false, title: null };
};

const buildHeadingScopedPairs = (citations = []) =>
  citations.flatMap((citation) => {
    const metadataTitle = readHeadingTitle(citation?.sectionHeading ?? "");

    return CHECKABLE_CITATION_FIELDS.flatMap((field) => {
      const pairs = [];
      let title = metadataTitle;
      let block = [];
      const flush = () => {
        if (title && block.length > 0) {
          const blockText = block.join("\n");

          for (const sentence of uniqueValues([
            ...splitSupportSentences(blockText),
            ...(block.length > 1 ? splitSupportSentences(joinWrappedLines(blockText)) : []),
          ])) {
            pairs.push({ sentence, title });
          }
        }

        block = [];
      };

      for (const line of String(citation?.[field] ?? "").split(/\n+/).map((entry) => entry.trim()).filter(Boolean)) {
        const heading = readHeadingLine(line, metadataTitle);

        if (heading.boundary) {
          flush();
          title = heading.title;
          continue;
        }

        block.push(line);
      }

      flush();
      return pairs;
    });
  });

// The claim names the title as a phrase, and its other words are all in the
// sentence (inflected forms count only with RAG_CLAIM_INFLECTION).
const isHeadingNamedByClaim = ({ claimText, inflection = false, sentence, title }) => {
  const claim = ` ${normalizeSearchText(stripSourceLabels(claimText))} `;
  const phrase = normalizeSearchText(title);
  const at = phrase ? claim.indexOf(` ${phrase} `) : -1;

  if (at < 0) {
    return false;
  }

  const remainder = `${claim.slice(0, at)} ${claim.slice(at + phrase.length + 2)}`;
  const sentenceTokens = extractMeaningfulTokens(sentence);
  const present = inflection ? buildInflectionIndex(sentenceTokens) : new Set(sentenceTokens);

  return extractMeaningfulTokens(remainder).every((token) => present.has(token));
};

export const buildHeadingScopedSupportSentences = (
  citations = [],
  { claimText = null, inflection = false } = {}
) =>
  uniqueValues(
    buildHeadingScopedPairs(citations)
      .filter(
        ({ sentence, title }) =>
          claimText === null || isHeadingNamedByClaim({ claimText, inflection, sentence, title })
      )
      .map(({ sentence, title }) => `${title}: ${sentence}`)
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
