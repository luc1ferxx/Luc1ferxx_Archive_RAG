import { getLocationUnit, hasInlineDocumentPreview } from "./documentLocation";

export const formatPageCount = (pageCount) => {
  const parsed = Number.parseInt(pageCount ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : "?";
};

export const formatDocumentCount = (count) =>
  count === 1 ? "1 document" : `${count} documents`;

export const getDocumentTags = (document) =>
  document?.tags ?? document?.profile?.tags ?? [];

export const getDocumentSummary = (document) =>
  document?.summary ?? document?.profile?.summary ?? "";

export const getDocumentSource = (document) =>
  document?.source ?? document?.profile?.source ?? null;

export const getDocumentSourceType = (document) =>
  getDocumentSource(document)?.sourceType ?? "uploaded";

export const isArxivDocument = (document) =>
  getDocumentSourceType(document) === "arxiv";

export const getTotalPages = (documents = []) =>
  documents.reduce(
    (sum, document) => sum + (Number.parseInt(document.pageCount ?? "0", 10) || 0),
    0
  );

// The stored MIME type of a document the browser cannot show inline (Word,
// PowerPoint, Excel, any other non-PDF type); "" for a PDF or a document whose
// type is not known, which keep today's PDF preview.
const getNonPdfMimeType = (document) => {
  const mimeType = String(document?.mimeType ?? "").trim();

  return mimeType && !hasInlineDocumentPreview({ mimeType }) ? mimeType : "";
};

/**
 * Citations carry no MIME type, but the preview needs one to tell a PDF from
 * an Office file, so a source gets its document's type from the document
 * list. Only a non-PDF type is added: a PDF source stays the very object it
 * was, so its preview is exactly what it was.
 */
export const withDocumentMimeType = (source, documents = []) => {
  if (!source || source.mimeType) {
    return source;
  }

  const document = documents.find((candidate) => candidate.docId === source.docId);
  const mimeType = getNonPdfMimeType(document);

  return mimeType ? { ...source, mimeType } : source;
};

export const buildPreviewSourceFromDocument = (document, citation = null) => {
  const locationUnit = getLocationUnit(citation);
  const mimeType = getNonPdfMimeType(document);
  const previewSource = {
    docId: document.docId,
    fileName: document.fileName,
    filePath: citation?.filePath || document.publicFilePath || "",
    // Only a PDF page defaults to the first one, as before: a slide, sheet or
    // section keeps the citation's number, or none.
    pageNumber:
      locationUnit || mimeType ? citation?.pageNumber ?? null : citation?.pageNumber ?? 1,
    excerpt: citation?.excerpt ?? "",
    chunkIndex: citation?.chunkIndex ?? null,
  };

  if (locationUnit) {
    previewSource.locationUnit = citation.locationUnit;

    if (citation.locationLabel) {
      previewSource.locationLabel = citation.locationLabel;
    }
  }

  if (mimeType) {
    previewSource.mimeType = mimeType;
  }

  return previewSource;
};

export const buildRelevantDocuments = ({
  activeDocuments = [],
  currentSources = [],
} = {}) =>
  [
    ...new Map(
      currentSources.map((source) => {
        const matchingDocument = activeDocuments.find(
          (document) => document.docId === source.docId
        );
        const entry = {
          docId: source.docId,
          fileName: source.fileName,
          pageCount: matchingDocument?.pageCount ?? null,
          summary: getDocumentSummary(matchingDocument),
          tags: getDocumentTags(matchingDocument),
          profile: matchingDocument?.profile ?? null,
          pages: [],
          previewSource: buildPreviewSourceFromDocument(
            matchingDocument ?? {
              docId: source.docId,
              fileName: source.fileName,
              publicFilePath: source.filePath,
            },
            source
          ),
        };

        return [source.docId, entry];
      })
    ).values(),
  ].map((entry) => ({
    ...entry,
    pages: [
      ...new Set(
        currentSources
          .filter((source) => source.docId === entry.docId)
          .map((source) => source.pageNumber)
          .filter(Boolean)
      ),
    ].sort((left, right) => left - right),
  }));
