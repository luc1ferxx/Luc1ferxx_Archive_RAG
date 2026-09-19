import { readFile } from "fs/promises";
import { buildPublicFilePath } from "../rag/document-utils.js";
import { configureDocumentRegistryStore } from "../rag/doc-registry.js";
import { configureLongMemoryStore } from "../rag/long-memory.js";
import { configureSessionMemoryStore } from "../rag/memory.js";

const createEvaluationDocumentRegistryStore = () => {
  const documentsById = new Map();
  const filesById = new Map();

  const toStoredDocument = (document = {}, fileBuffer = Buffer.alloc(0)) => {
    const docId = String(document.docId ?? "").trim();
    const publicFilePath = buildPublicFilePath(docId);

    return {
      docId,
      fileName: String(document.fileName ?? "").trim(),
      filePath: publicFilePath,
      publicFilePath,
      mimeType: String(document.mimeType ?? "application/pdf"),
      fileSize:
        Number.parseInt(document.fileSize ?? `${fileBuffer.byteLength}`, 10) ||
        fileBuffer.byteLength,
      chunkCount: Number.parseInt(document.chunkCount ?? "0", 10) || 0,
      pageCount: Number.parseInt(document.pageCount ?? "0", 10) || 0,
      uploadedAt: document.uploadedAt ?? new Date().toISOString(),
      storageBackend: "postgresql",
    };
  };

  return {
    async initialize() {
      return true;
    },
    async list() {
      return [...documentsById.values()].map((document) => structuredClone(document));
    },
    async upsert(document) {
      const fileBuffer = document.fileBuffer
        ? Buffer.from(document.fileBuffer)
        : document.sourceFilePath
          ? await readFile(document.sourceFilePath)
          : Buffer.alloc(0);
      const storedDocument = toStoredDocument(document, fileBuffer);

      documentsById.set(storedDocument.docId, storedDocument);
      filesById.set(storedDocument.docId, {
        fileBuffer,
        fileName: storedDocument.fileName,
        mimeType: storedDocument.mimeType,
        fileSize: storedDocument.fileSize,
      });

      return structuredClone(storedDocument);
    },
    async getFile(docId) {
      const storedDocument = documentsById.get(docId);
      const storedFile = filesById.get(docId);

      if (!storedDocument || !storedFile) {
        return null;
      }

      return {
        document: structuredClone(storedDocument),
        fileBuffer: Buffer.from(storedFile.fileBuffer),
        fileName: storedFile.fileName,
        mimeType: storedFile.mimeType,
        fileSize: storedFile.fileSize,
      };
    },
    async delete(docId) {
      const storedDocument = documentsById.get(docId) ?? null;
      documentsById.delete(docId);
      filesById.delete(docId);
      return storedDocument ? structuredClone(storedDocument) : null;
    },
    async clear() {
      documentsById.clear();
      filesById.clear();
      return true;
    },
    async reset() {
      documentsById.clear();
      filesById.clear();
      return true;
    },
  };
};

const createEvaluationSessionMemoryStore = () => {
  const sessionsById = new Map();

  const cloneSession = (session) =>
    session
      ? {
          updatedAt: Number(session.updatedAt ?? Date.now()),
          messages: structuredClone(session.messages ?? []),
        }
      : null;

  return {
    async initialize() {
      return true;
    },
    async get(sessionId) {
      return cloneSession(sessionsById.get(sessionId) ?? null);
    },
    async upsert({ sessionId, messages, updatedAt = Date.now() }) {
      const session = {
        updatedAt,
        messages: structuredClone(messages ?? []),
      };

      sessionsById.set(sessionId, session);
      return cloneSession(session);
    },
    async delete(sessionId) {
      return sessionsById.delete(sessionId);
    },
    async reset() {
      sessionsById.clear();
      return true;
    },
  };
};

const createDisabledLongMemoryStore = () => ({
  async initialize() {
    return false;
  },
  async list() {
    return [];
  },
  async remember() {
    return null;
  },
  async delete() {
    return null;
  },
  async clear() {
    return 0;
  },
  async touch() {
    return 0;
  },
});

/**
 * Session and long memory are always replaced with in-process stores. The
 * document registry is replaced too unless the caller keeps the real one: the
 * pgvector provider's chunk table has a foreign key onto the PostgreSQL
 * document row, so an evaluation on pgvector must register documents for real.
 */
export const configureEvaluationStores = ({
  keepDocumentRegistryStore = false,
} = {}) => {
  configureDocumentRegistryStore(
    keepDocumentRegistryStore ? null : createEvaluationDocumentRegistryStore()
  );
  configureSessionMemoryStore(createEvaluationSessionMemoryStore());
  configureLongMemoryStore(createDisabledLongMemoryStore());
};
