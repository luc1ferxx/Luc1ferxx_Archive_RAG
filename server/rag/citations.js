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
