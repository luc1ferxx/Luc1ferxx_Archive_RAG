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

export const getTotalPages = (documents = []) =>
  documents.reduce(
    (sum, document) => sum + (Number.parseInt(document.pageCount ?? "0", 10) || 0),
    0
  );

export const buildPreviewSourceFromDocument = (document, citation = null) => ({
  docId: document.docId,
  fileName: document.fileName,
  filePath: citation?.filePath || document.publicFilePath || "",
  pageNumber: citation?.pageNumber ?? 1,
  excerpt: citation?.excerpt ?? "",
  chunkIndex: citation?.chunkIndex ?? null,
});

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
