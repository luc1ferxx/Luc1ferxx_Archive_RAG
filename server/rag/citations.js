const getPageNumber = (metadata = {}) =>
  metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page ?? null;

const cleanExcerpt = (text = "") =>
  text.replace(/\s+/g, " ").trim().slice(0, 220);

export const buildCitation = (document, score, rank) => ({
  rank,
  score: Number(score.toFixed(4)),
  docId: document.metadata?.docId ?? null,
  fileName: document.metadata?.fileName ?? "Unknown document",
  filePath: document.metadata?.publicFilePath ?? "",
  pageNumber: getPageNumber(document.metadata),
  chunkIndex: document.metadata?.chunkIndex ?? null,
  excerpt: cleanExcerpt(document.pageContent),
  sectionHeading: document.metadata?.sectionHeading ?? null,
});

export const buildContextSection = (document, _score, rank) =>
  [
    `Source ${rank}`,
    `File: ${document.metadata?.fileName ?? "Unknown document"}`,
    getPageNumber(document.metadata)
      ? `Page: ${getPageNumber(document.metadata)}`
      : null,
    document.metadata?.sectionHeading
      ? `Section: ${document.metadata.sectionHeading}`
      : null,
    `Evidence:`,
    document.pageContent,
  ]
    .filter(Boolean)
    .join("\n");

export const getResultKey = (resultOrDocument) => {
  const document = resultOrDocument.document ?? resultOrDocument;

  return `${document.metadata?.docId ?? "unknown"}:${document.metadata?.chunkIndex ?? document.id}`;
};

export const dedupeCitations = (citations, limit = citations.length) => {
  const seenCitationKeys = new Set();
  const dedupedCitations = [];

  for (const citation of citations) {
    const citationKey = `${citation.docId}:${citation.chunkIndex}:${citation.pageNumber}`;

    if (seenCitationKeys.has(citationKey)) {
      continue;
    }

    seenCitationKeys.add(citationKey);
    dedupedCitations.push(citation);

    if (dedupedCitations.length >= limit) {
      break;
    }
  }

  return dedupedCitations;
};

const normalizePositiveRank = (value) => {
  const rank = Number(value);

  return Number.isInteger(rank) && rank > 0 ? rank : null;
};

const EXPLICIT_EVIDENCE_IDENTITY_FIELDS = Object.freeze([
  "docId",
  "docKey",
  "chunkIndex",
  "pageNumber",
  "fileName",
  "filePath",
  "url",
]);

const hasExplicitIdentityValue = (value) =>
  value !== null && value !== undefined && String(value).trim() !== "";

const normalizeIdentityValue = (value) => String(value).trim();

const hasExplicitIdentityConflict = (citation = {}, context = {}) =>
  EXPLICIT_EVIDENCE_IDENTITY_FIELDS.some((field) => {
    const citationValue = citation[field];
    const contextValue = context[field];

    return (
      hasExplicitIdentityValue(citationValue) &&
      hasExplicitIdentityValue(contextValue) &&
      normalizeIdentityValue(citationValue) !==
        normalizeIdentityValue(contextValue)
    );
  });

export const hasCompatibleEvidenceIdentity = (citation = {}, context = {}) => {
  const citationRank = normalizePositiveRank(citation.rank);
  const contextRank = normalizePositiveRank(context.rank);

  if (citationRank || contextRank) {
    return Boolean(
      citationRank &&
        contextRank &&
        citationRank === contextRank &&
        !hasExplicitIdentityConflict(citation, context)
    );
  }

  return Boolean(
    citation.docId &&
      context.docId &&
      citation.docId === context.docId &&
      citation.chunkIndex !== null &&
      citation.chunkIndex !== undefined &&
      citation.chunkIndex === context.chunkIndex &&
      !hasExplicitIdentityConflict(citation, context)
  );
};

export const attachRetrievedEvidence = ({
  citations = [],
  retrievedContexts = [],
} = {}) =>
  citations.map((citation) => {
    const context = retrievedContexts.find((candidate) =>
      hasCompatibleEvidenceIdentity(citation, candidate)
    );
    const evidenceText = String(context?.text ?? "").trim();

    return evidenceText
      ? {
          ...citation,
          evidenceText,
        }
      : citation;
  });
