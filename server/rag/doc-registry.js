const documentRegistry = new Map();

export const normalizeDocIds = (docIds) => {
  if (Array.isArray(docIds)) {
    return [...new Set(docIds.map((docId) => docId?.trim()).filter(Boolean))];
  }

  if (typeof docIds === "string") {
    return [
      ...new Set(
        docIds
          .split(",")
          .map((docId) => docId.trim())
          .filter(Boolean)
      ),
    ];
  }

  return [];
};

export const registerDocument = (document) => {
  documentRegistry.set(document.docId, document);
  return getDocument(document.docId);
};

export const hasDocument = (docId) => documentRegistry.has(docId);

export const getDocument = (docId) => {
  const document = documentRegistry.get(docId);

  return document
    ? {
        docId: document.docId,
        fileName: document.fileName,
        filePath: document.filePath,
        publicFilePath: document.publicFilePath,
        chunkCount: document.chunkCount,
        pageCount: document.pageCount,
        uploadedAt: document.uploadedAt,
      }
    : null;
};

export const getDocuments = (docIds) =>
  normalizeDocIds(docIds)
    .map((docId) => getDocument(docId))
    .filter(Boolean);
