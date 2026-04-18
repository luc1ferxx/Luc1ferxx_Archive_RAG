import { createHash, randomUUID } from "crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let uploadSessionsDirectory =
  process.env.UPLOAD_SESSION_DIRECTORY?.trim() ||
  path.join(__dirname, "upload-sessions");
const chunkPrefix = "chunk-";

const createUploadError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const hashFileId = (fileId) =>
  createHash("sha256").update(String(fileId)).digest("hex");

const getSessionDirectory = (fileId) =>
  path.join(uploadSessionsDirectory, hashFileId(fileId));

const getManifestPath = (fileId) =>
  path.join(getSessionDirectory(fileId), "manifest.json");

const getChunkPath = (fileId, chunkIndex) =>
  path.join(getSessionDirectory(fileId), `${chunkPrefix}${chunkIndex}`);

const parseChunkIndex = (entryName) => {
  if (!entryName.startsWith(chunkPrefix)) {
    return null;
  }

  const chunkIndex = Number.parseInt(entryName.slice(chunkPrefix.length), 10);

  return Number.isInteger(chunkIndex) && chunkIndex >= 0 ? chunkIndex : null;
};

const listUploadedChunks = async (fileId) => {
  try {
    const entries = await readdir(getSessionDirectory(fileId), {
      withFileTypes: true,
    });

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => parseChunkIndex(entry.name))
      .filter((chunkIndex) => chunkIndex !== null)
      .sort((left, right) => left - right);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const writeManifest = async (fileId, manifest) => {
  await writeFile(
    getManifestPath(fileId),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
};

const readManifest = async (fileId) => {
  try {
    const content = await readFile(getManifestPath(fileId), "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const normalizeMetadata = (metadata) => ({
  fileId: String(metadata.fileId ?? ""),
  fileName: String(metadata.fileName ?? ""),
  fileSize: Number.parseInt(metadata.fileSize, 10),
  lastModified: Number.parseInt(metadata.lastModified ?? "0", 10),
  totalChunks: Number.parseInt(metadata.totalChunks, 10),
  chunkSize: Number.parseInt(metadata.chunkSize ?? "0", 10),
  createdAt: metadata.createdAt ?? new Date().toISOString(),
  sessionId: metadata.sessionId ?? randomUUID(),
});

const validateMetadata = (metadata) => {
  if (!metadata.fileId.trim()) {
    throw createUploadError("fileId is required.");
  }

  if (!metadata.fileName.trim()) {
    throw createUploadError("fileName is required.");
  }

  if (!Number.isInteger(metadata.fileSize) || metadata.fileSize < 0) {
    throw createUploadError("fileSize must be a non-negative integer.");
  }

  if (!Number.isInteger(metadata.totalChunks) || metadata.totalChunks <= 0) {
    throw createUploadError("totalChunks must be a positive integer.");
  }

  if (!Number.isInteger(metadata.chunkSize) || metadata.chunkSize <= 0) {
    throw createUploadError("chunkSize must be a positive integer.");
  }

  if (!Number.isInteger(metadata.lastModified) || metadata.lastModified < 0) {
    throw createUploadError("lastModified must be a non-negative integer.");
  }
};

const metadataMatches = (storedMetadata, nextMetadata) =>
  storedMetadata.fileId === nextMetadata.fileId &&
  storedMetadata.fileName === nextMetadata.fileName &&
  storedMetadata.fileSize === nextMetadata.fileSize &&
  storedMetadata.lastModified === nextMetadata.lastModified &&
  storedMetadata.totalChunks === nextMetadata.totalChunks;

export const ensureUploadStorage = async () => {
  await mkdir(uploadSessionsDirectory, { recursive: true });
};

export const configureUploadSessionDirectory = (nextDirectory) => {
  uploadSessionsDirectory = path.resolve(nextDirectory);
};

export const initializeUploadSession = async (rawMetadata) => {
  const metadata = normalizeMetadata(rawMetadata);
  validateMetadata(metadata);

  const sessionDirectory = getSessionDirectory(metadata.fileId);
  await mkdir(sessionDirectory, { recursive: true });

  const existingManifest = await readManifest(metadata.fileId);

  if (existingManifest && !metadataMatches(existingManifest, metadata)) {
    await rm(sessionDirectory, { recursive: true, force: true });
    await mkdir(sessionDirectory, { recursive: true });
  }

  const nextManifest = existingManifest && metadataMatches(existingManifest, metadata)
    ? {
        ...existingManifest,
        chunkSize: metadata.chunkSize,
      }
    : metadata;

  const uploadedChunks = await listUploadedChunks(metadata.fileId);
  await writeManifest(metadata.fileId, nextManifest);

  return {
    ...nextManifest,
    uploadedChunks,
  };
};

export const getUploadSessionStatus = async (fileId) => {
  const manifest = await readManifest(fileId);

  if (!manifest) {
    return null;
  }

  const uploadedChunks = await listUploadedChunks(fileId);

  return {
    ...manifest,
    uploadedChunks,
  };
};

export const storeUploadChunk = async ({
  fileId,
  chunkIndex,
  totalChunks,
  chunkBuffer,
}) => {
  const manifest = await readManifest(fileId);

  if (!manifest) {
    throw createUploadError("Upload session not found. Initialize upload first.", 404);
  }

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw createUploadError("chunkIndex must be a non-negative integer.");
  }

  if (chunkIndex >= manifest.totalChunks) {
    throw createUploadError("chunkIndex exceeds totalChunks.");
  }

  if (Number.parseInt(totalChunks, 10) !== manifest.totalChunks) {
    throw createUploadError("totalChunks does not match the upload session.");
  }

  await writeFile(getChunkPath(fileId, chunkIndex), chunkBuffer);

  const uploadedChunks = await listUploadedChunks(fileId);

  return {
    uploadedChunks,
    totalChunks: manifest.totalChunks,
  };
};

const mergeChunksIntoFile = async ({ fileId, destinationPath, totalChunks }) => {
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunkPath = getChunkPath(fileId, chunkIndex);

    try {
      await stat(chunkPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw createUploadError(
          `Missing chunk ${chunkIndex}. Resume the upload before completing it.`
        );
      }

      throw error;
    }

    const chunkBuffer = await readFile(chunkPath);

    await writeFile(destinationPath, chunkBuffer, {
      flag: chunkIndex === 0 ? "w" : "a",
    });
  }
};

export const finalizeUploadSession = async ({
  fileId,
  destinationPath,
  cleanupChunks = false,
}) => {
  const manifest = await readManifest(fileId);

  if (!manifest) {
    throw createUploadError("Upload session not found. Initialize upload first.", 404);
  }

  const uploadedChunks = await listUploadedChunks(fileId);

  if (uploadedChunks.length !== manifest.totalChunks) {
    throw createUploadError(
      `Upload incomplete. Received ${uploadedChunks.length}/${manifest.totalChunks} chunks.`
    );
  }

  await mergeChunksIntoFile({
    fileId,
    destinationPath,
    totalChunks: manifest.totalChunks,
  });

  if (cleanupChunks) {
    await clearUploadSession(fileId);
  }

  return manifest;
};

export const clearUploadSession = async (fileId) => {
  await rm(getSessionDirectory(fileId), { recursive: true, force: true });
};

export const removeMergedUpload = async (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
};
