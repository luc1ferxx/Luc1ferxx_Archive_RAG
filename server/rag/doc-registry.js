import { fileExistsSync, getRagDataPath, readJsonFileSync, writeJsonFileSync } from "./storage.js";

const registryPath = () => getRagDataPath("documents.json");

const toStoredDocument = (document = {}) => ({
  docId: String(document.docId ?? ""),
  fileName: String(document.fileName ?? ""),
  filePath: String(document.filePath ?? ""),
  publicFilePath: String(document.publicFilePath ?? ""),
  chunkCount: Number.parseInt(document.chunkCount ?? "0", 10),
  pageCount: Number.parseInt(document.pageCount ?? "0", 10),
  uploadedAt: document.uploadedAt ?? new Date().toISOString(),
});

const loadDocumentRegistry = () => {
  const entries = readJsonFileSync(registryPath(), []);
  const nextRegistry = new Map();

  for (const entry of entries) {
    const document = toStoredDocument(entry);

    if (!document.docId || !document.fileName || !document.filePath) {
      continue;
    }

    if (!fileExistsSync(document.filePath)) {
      continue;
    }

    nextRegistry.set(document.docId, document);
  }

  return nextRegistry;
};

let documentRegistry = loadDocumentRegistry();

const persistDocumentRegistry = () => {
  writeJsonFileSync(registryPath(), [...documentRegistry.values()]);
};

const toPublicDocument = (document) =>
  document
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
  const nextDocument = toStoredDocument(document);
  documentRegistry.set(nextDocument.docId, nextDocument);
  persistDocumentRegistry();
  return getDocument(document.docId);
};

export const hasDocument = (docId) => documentRegistry.has(docId);

export const getStoredDocument = (docId) => documentRegistry.get(docId) ?? null;

export const getDocument = (docId) => toPublicDocument(getStoredDocument(docId));

export const getDocuments = (docIds) =>
  normalizeDocIds(docIds)
    .map((docId) => getDocument(docId))
    .filter(Boolean);

export const listDocuments = () =>
  [...documentRegistry.values()]
    .sort((left, right) => left.uploadedAt.localeCompare(right.uploadedAt))
    .map((document) => toPublicDocument(document));

export const deleteDocument = (docId) => {
  const document = getStoredDocument(docId);

  if (!document) {
    return null;
  }

  documentRegistry.delete(docId);
  persistDocumentRegistry();
  return toPublicDocument(document);
};

export const clearDocuments = () => {
  const documents = listDocuments();
  documentRegistry = new Map();
  persistDocumentRegistry();
  return documents;
};

export const resetDocumentRegistry = () => {
  documentRegistry = loadDocumentRegistry();
};
