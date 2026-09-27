// A file-backed document registry store: the zero-infrastructure alternative to
// the PostgreSQL store in doc-registry.js.
//
// The archive's vector index and sparse index are already file-persisted
// (vector-store-local.js, sparse-store.js), so PostgreSQL was the last thing
// standing between "clone the repo" and "ask a question about a PDF". This store
// puts the registry and the PDF bytes on disk too, which is also what lets a
// *second* process -- the MCP server an agent runtime spawns -- see documents
// ingested by the first one.
//
// It mirrors the PostgreSQL store's contract on purpose, including access-scope
// filtering on list/getFile/delete/clear and the docId+fileName requirement on
// upsert. The in-memory evaluation store (evaluation/eval-store-overrides.js)
// skips both, which is fine for fixtures and not fine for a user's archive.
//
// Single writer assumed. Ingestion happens in one process; the MCP bridge is
// read-only. Two concurrent ingesting processes would race on documents.json the
// same way they already race on vector-index.json.

import { mkdir, readFile as readBinaryFile, rename, rm, unlink, writeFile } from "fs/promises";
import path from "path";
import { createHash, randomBytes } from "crypto";

import {
  DOCUMENT_REGISTRY_BACKENDS,
  documentMatchesAccessScope,
  hasAccessScope,
  normalizeContentSha256,
  resolveFileBuffer,
} from "./doc-registry.js";
import { buildPublicFilePath } from "./document-utils.js";
import { getRagDataPath, readJsonFileSync, writeJsonFileAsync } from "./storage.js";

const REGISTRY_FILE_NAME = "documents.json";
const DOCUMENTS_DIRECTORY_NAME = "documents";
const DOCUMENT_FILE_NAME = "file";

const toPositiveInteger = (value, fallbackValue = 0) => {
  const parsedValue = Number.parseInt(value ?? fallbackValue, 10);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallbackValue;
};

const normalizeDocId = (docId) => String(docId ?? "").trim();

// The docId becomes a directory name, so it is encoded the same way
// buildPublicFilePath encodes it for URLs -- and then checked. encodeURIComponent
// leaves "." untouched, so a docId of ".." would otherwise write outside the
// documents directory.
const encodeDocIdSegment = (docId) => {
  const segment = encodeURIComponent(normalizeDocId(docId));

  if (!segment || segment === "." || segment === "..") {
    throw new Error(`Document id "${docId}" cannot be used as a storage path.`);
  }

  return segment;
};

// doc-registry.js accepts the profile either nested under `profile` or spread
// across `summary`/`tags`/`entities`/`source`. Collapse both spellings into one
// persisted shape; the registry's own normalizer still trims and dedupes it on
// the way back in, so this only has to avoid losing anything.
const toStoredProfile = (document = {}) => {
  const rawProfile =
    document.profile && typeof document.profile === "object" ? document.profile : {};
  const source = rawProfile.source ?? document.source;
  const profile = {
    summary: rawProfile.summary ?? document.summary ?? "",
    tags: rawProfile.tags ?? document.tags ?? [],
    entities: rawProfile.entities ?? document.entities ?? [],
    generatedAt: rawProfile.generatedAt ?? document.profileGeneratedAt ?? "",
  };

  if (source && typeof source === "object") {
    profile.source = source;
  }

  return profile;
};

const toStoredRecord = (document = {}) => {
  const docId = normalizeDocId(document.docId);
  const publicFilePath = buildPublicFilePath(docId);

  return {
    docId,
    fileName: String(document.fileName ?? "").trim(),
    filePath: publicFilePath,
    publicFilePath,
    mimeType: String(document.mimeType ?? "application/pdf").trim() || "application/pdf",
    fileSize: toPositiveInteger(document.fileSize),
    chunkCount: toPositiveInteger(document.chunkCount),
    pageCount: toPositiveInteger(document.pageCount),
    ownerUserId: String(
      document.ownerUserId ?? document.userId ?? document.owner_user_id ?? ""
    ).trim(),
    workspaceId: String(document.workspaceId ?? document.workspace_id ?? "").trim(),
    profile: toStoredProfile(document),
    uploadedAt: document.uploadedAt ?? new Date().toISOString(),
    storageBackend: "filesystem",
    // Content identity and version, as in the PostgreSQL store (migration 018).
    contentSha256: normalizeContentSha256(document.contentSha256),
    version: toContentVersion(document.version ?? document.contentVersion),
    updatedAt: document.updatedAt ?? document.contentUpdatedAt ?? null,
  };
};

const toContentVersion = (value) => {
  const parsedValue = Number.parseInt(value ?? 1, 10);

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : 1;
};

// temp + rename, mirroring writeJsonFileAsync in storage.js: a reader sees either
// the previous bytes or the new bytes, never a half-written PDF. rename also
// *replaces*, which matters because docIds are UUIDs rather than content hashes,
// so re-ingesting one has to overwrite its bytes.
const writeFileAtomically = async (filePath, buffer) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, buffer);

  try {
    await rename(temporaryPath, filePath);
  } catch (renameError) {
    try {
      await unlink(filePath);
      await rename(temporaryPath, filePath);
    } catch (fallbackError) {
      await unlink(temporaryPath).catch(() => {
        /* best-effort cleanup */
      });
      throw fallbackError;
    }
  }
};

export const createFileDocumentRegistryStore = ({
  getDocumentsDirectory = () => getRagDataPath(DOCUMENTS_DIRECTORY_NAME),
  getRegistryFilePath = () => getRagDataPath(REGISTRY_FILE_NAME),
  readFile = readBinaryFile,
} = {}) => {
  let writeQueue = Promise.resolve();

  // Every mutation is a read-modify-write over one JSON file, so they are
  // serialized the same way vector-store-local.js serializes its index writes.
  const withWriteLock = (task) => {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  };

  const documentDirectory = (docId) =>
    path.join(getDocumentsDirectory(), encodeDocIdSegment(docId));

  const documentFilePath = (docId) =>
    path.join(documentDirectory(docId), DOCUMENT_FILE_NAME);

  const removeDocumentDirectory = (docId) =>
    rm(documentDirectory(docId), {
      force: true,
      recursive: true,
    });

  // Tolerant of a truncated or hand-edited registry, matching how
  // vector-store-local.js filters its entries on load: a record without a docId
  // and fileName is unusable, and dropping it beats crashing every read.
  const loadRecords = () => {
    const storedRecords = readJsonFileSync(getRegistryFilePath(), []);

    if (!Array.isArray(storedRecords)) {
      return [];
    }

    return storedRecords
      .map((record) => toStoredRecord(record))
      .filter((record) => record.docId && record.fileName);
  };

  const persistRecords = (records) => writeJsonFileAsync(getRegistryFilePath(), records);

  const findRecord = (records, docId) =>
    records.find((record) => record.docId === docId) ?? null;

  return {
    // One writer (see the header), so the registry map never needs re-reading
    // from this store (isDocumentRegistryShared).
    backend: DOCUMENT_REGISTRY_BACKENDS.filesystem,

    async initialize() {
      await mkdir(getDocumentsDirectory(), {
        recursive: true,
      });

      return true;
    },

    async list(accessScope = {}) {
      return loadRecords()
        .filter((record) => documentMatchesAccessScope(record, accessScope))
        .sort(
          (left, right) =>
            left.uploadedAt.localeCompare(right.uploadedAt) ||
            left.docId.localeCompare(right.docId)
        );
    },

    async upsert(document) {
      const storedRecord = toStoredRecord(document);

      if (!storedRecord.docId || !storedRecord.fileName) {
        throw new Error("Document registration requires both docId and fileName.");
      }

      const fileBuffer = await resolveFileBuffer({
        fileBuffer: document.fileBuffer,
        readFile,
        sourceFilePath: document.sourceFilePath,
      });
      const record = {
        ...storedRecord,
        contentSha256:
          storedRecord.contentSha256 ?? createHash("sha256").update(fileBuffer).digest("hex"),
        fileSize: storedRecord.fileSize || fileBuffer.byteLength,
        updatedAt: storedRecord.updatedAt ?? storedRecord.uploadedAt,
      };

      return withWriteLock(async () => {
        // Bytes before registry entry. Interrupted here you get orphan bytes that
        // nothing references; the other order would leave a registered document
        // whose file does not exist, which reads as corruption to every caller.
        await writeFileAtomically(documentFilePath(record.docId), fileBuffer);
        await persistRecords([
          ...loadRecords().filter((existing) => existing.docId !== record.docId),
          record,
        ]);

        return record;
      });
    },

    async getFile(docId, accessScope = {}) {
      const normalizedDocId = normalizeDocId(docId);

      if (!normalizedDocId) {
        return null;
      }

      const record = findRecord(loadRecords(), normalizedDocId);

      if (!record || !documentMatchesAccessScope(record, accessScope)) {
        return null;
      }

      let fileBuffer = null;

      try {
        // Deliberately the real fs and not the injected readFile: that injection
        // point exists for a caller-supplied sourceFilePath, not for our storage.
        fileBuffer = await readBinaryFile(documentFilePath(normalizedDocId));
      } catch (error) {
        // A registered document whose bytes are gone is corruption, not a miss.
        // Report it as absent, but say so rather than returning an empty PDF.
        console.error(
          `Document ${normalizedDocId} is registered but its file could not be read.`,
          error
        );
        return null;
      }

      return {
        document: record,
        fileBuffer,
        mimeType: record.mimeType,
        fileName: record.fileName,
        fileSize: record.fileSize,
      };
    },

    async delete(docId, accessScope = {}) {
      const normalizedDocId = normalizeDocId(docId);

      if (!normalizedDocId) {
        return null;
      }

      return withWriteLock(async () => {
        const records = loadRecords();
        const record = findRecord(records, normalizedDocId);

        if (!record || !documentMatchesAccessScope(record, accessScope)) {
          return null;
        }

        // Registry entry before bytes, the reverse of upsert, so an interruption
        // again leaves orphan bytes rather than a dangling registration.
        await persistRecords(
          records.filter((existing) => existing.docId !== normalizedDocId)
        );
        await removeDocumentDirectory(normalizedDocId);

        return record;
      });
    },

    async clear(accessScope = {}) {
      return withWriteLock(async () => {
        if (!hasAccessScope(accessScope)) {
          await persistRecords([]);
          await rm(getDocumentsDirectory(), {
            force: true,
            recursive: true,
          });

          return true;
        }

        const records = loadRecords();
        const scopedDocIds = new Set(
          records
            .filter((record) => documentMatchesAccessScope(record, accessScope))
            .map((record) => record.docId)
        );

        if (scopedDocIds.size === 0) {
          return true;
        }

        await persistRecords(records.filter((record) => !scopedDocIds.has(record.docId)));

        for (const docId of scopedDocIds) {
          await removeDocumentDirectory(docId);
        }

        return true;
      });
    },

    // Deliberately not a wipe. resetDocumentRegistryStore() calls reset() to drop
    // in-process state, and this store holds none -- the disk is the state. An
    // in-memory store can equate "reset" with "forget everything"; doing that here
    // would delete the user's archive. clear() is the destructive one.
    async reset() {
      return true;
    },
  };
};
