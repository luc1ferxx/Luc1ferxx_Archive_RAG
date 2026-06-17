import { readFile } from "fs/promises";
import {
  fileExistsSync,
  getRagDataPath,
  readJsonFileSync,
} from "./storage.js";

const normalizeDocId = (docId) => String(docId ?? "").trim();

const toPositiveInteger = (value, fallbackValue = 0) => {
  const parsedValue = Number.parseInt(value ?? fallbackValue, 10);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallbackValue;
};

export const getLegacyDocumentRegistryPath = () => getRagDataPath("documents.json");

export const loadLegacyDocuments = ({
  registryFilePath = getLegacyDocumentRegistryPath(),
} = {}) => {
  const entries = readJsonFileSync(registryFilePath, []);

  return entries
    .map((entry) => ({
      docId: normalizeDocId(entry.docId),
      fileName: String(entry.fileName ?? "").trim(),
      sourceFilePath: String(entry.filePath ?? "").trim(),
      mimeType: String(entry.mimeType ?? "application/pdf").trim() || "application/pdf",
      fileSize: toPositiveInteger(entry.fileSize),
      chunkCount: toPositiveInteger(entry.chunkCount),
      pageCount: toPositiveInteger(entry.pageCount),
      uploadedAt: entry.uploadedAt ?? new Date().toISOString(),
    }))
    .filter(
      (entry) =>
        entry.docId &&
        entry.fileName &&
        entry.sourceFilePath &&
        fileExistsSync(entry.sourceFilePath)
    );
};

const resolveLegacyDocumentFileBuffer = async ({ sourceFilePath }) =>
  readFile(sourceFilePath);

export const createDocumentLegacyImporter = ({
  loadDocuments = loadLegacyDocuments,
} = {}) => ({
  async importMissingDocuments({
    getExistingDocIds,
    upsertDocument,
  } = {}) {
    const legacyDocuments = loadDocuments();

    if (legacyDocuments.length === 0) {
      return {
        importedCount: 0,
        skippedCount: 0,
      };
    }

    const existingDocIds = await getExistingDocIds(
      legacyDocuments.map((document) => document.docId)
    );
    let importedCount = 0;
    let skippedCount = 0;

    for (const document of legacyDocuments) {
      if (existingDocIds.has(document.docId)) {
        skippedCount += 1;
        continue;
      }

      const fileBuffer = await resolveLegacyDocumentFileBuffer({
        sourceFilePath: document.sourceFilePath,
      });

      await upsertDocument({
        ...document,
        fileBuffer,
        fileSize: document.fileSize || fileBuffer.byteLength,
      });
      importedCount += 1;
    }

    return {
      importedCount,
      skippedCount,
    };
  },
});
