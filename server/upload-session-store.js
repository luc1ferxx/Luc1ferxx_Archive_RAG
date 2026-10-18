import { createHash, randomUUID } from "crypto";
import {
  link,
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

import {
  getUploadSessionMaxBytesPerTenant,
  getUploadSessionMaxPerTenant,
} from "./rag/config.js";
import {
  MAX_CHUNK_UPLOAD_SIZE,
  MAX_RESUMABLE_UPLOAD_SIZE,
  MAX_UPLOAD_FILE_ID_BYTES,
  MAX_UPLOAD_FILE_NAME_BYTES,
  MAX_UPLOAD_CHUNKS,
  isSafeUploadFileName,
} from "./upload-policy.js";
import { resolveDataDirectory } from "./runtime-paths.js";
import { tenantSelectorMatches } from "./rag/tenant-records.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let uploadSessionsDirectory = resolveDataDirectory({
  explicitPath: process.env.UPLOAD_SESSION_DIRECTORY,
  derivedPath: path.join(__dirname, "upload-sessions"),
  fallbackSegments: ["upload-sessions"],
  sourceDirectory: __dirname,
});

const MANIFEST_VERSION = 2;
const UPLOAD_STORE_INSTANCE_ID = randomUUID();
const chunkPrefix = "chunk-";
const chunkNamePattern = /^chunk-(\d+)$/;
const finalizationClaimFileName = "finalizing.json";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionClaimPurposes = new Set(["cleanup", "finalize"]);

const createUploadError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// The stable code of a POST /upload/init refused (429) because the tenant has
// too many upload sessions open (limit "sessions") or their declared sizes
// would pass the byte cap (limit "bytes").
export const UPLOAD_SESSION_LIMIT_EXCEEDED = "UPLOAD_SESSION_LIMIT_EXCEEDED";

const createUploadSessionLimitError = (limit, maximum) =>
  Object.assign(
    createUploadError(
      limit === "sessions"
        ? `Too many open upload sessions; at most ${maximum} may be open at once. Complete an open upload or wait for one to expire before starting another.`
        : `Open upload sessions would exceed ${maximum} declared bytes. Complete an open upload or wait for one to expire before starting another.`,
      429
    ),
    { code: UPLOAD_SESSION_LIMIT_EXCEEDED, limit }
  );

const parseStrictInteger = (value) => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : Number.NaN;
  }

  const normalized = String(value ?? "").trim();

  if (!/^-?\d+$/.test(normalized)) {
    return Number.NaN;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
};

const normalizeAccessScope = (request = {}) => {
  if (
    !Object.prototype.hasOwnProperty.call(request, "accessScope") ||
    !request.accessScope ||
    typeof request.accessScope !== "object" ||
    Array.isArray(request.accessScope)
  ) {
    throw createUploadError(
      "Upload session operations require an explicit accessScope.",
      500
    );
  }

  return {
    userId: String(request.accessScope.userId ?? "").trim(),
    workspaceId: String(request.accessScope.workspaceId ?? "").trim(),
  };
};

const normalizeFileId = (value) => {
  const fileId = String(value ?? "").trim();

  if (!fileId) {
    throw createUploadError("fileId is required.");
  }

  if (Buffer.byteLength(fileId, "utf8") > MAX_UPLOAD_FILE_ID_BYTES) {
    throw createUploadError(
      `fileId must not exceed ${MAX_UPLOAD_FILE_ID_BYTES} UTF-8 bytes.`
    );
  }

  return fileId;
};

const normalizeIdentity = (request = {}) => ({
  accessScope: normalizeAccessScope(request),
  fileId: normalizeFileId(request.fileId),
});

const hashSessionIdentity = ({ accessScope, fileId }) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        MANIFEST_VERSION,
        accessScope.userId,
        accessScope.workspaceId,
        fileId,
      ])
    )
    .digest("hex");

const getSessionDirectory = (identity) =>
  path.join(uploadSessionsDirectory, hashSessionIdentity(identity));

const getManifestPath = (identity) =>
  path.join(getSessionDirectory(identity), "manifest.json");

const getChunkPath = (identity, chunkIndex) =>
  path.join(getSessionDirectory(identity), `${chunkPrefix}${chunkIndex}`);

const getFinalizationClaimPath = (identity) =>
  path.join(getSessionDirectory(identity), finalizationClaimFileName);

const parseChunkIndex = (entryName) => {
  const match = entryName.match(chunkNamePattern);

  if (!match) {
    return null;
  }

  const chunkIndex = Number(match[1]);
  return Number.isSafeInteger(chunkIndex) ? chunkIndex : null;
};

const listUploadedChunks = async (identity) => {
  try {
    const entries = await readdir(getSessionDirectory(identity), {
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

const readManifest = async (identity) => {
  try {
    const content = await readFile(getManifestPath(identity), "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const manifestMatchesAccessScope = (manifest, accessScope) =>
  manifest?.manifestVersion === MANIFEST_VERSION &&
  String(manifest.ownerUserId ?? "") === accessScope.userId &&
  String(manifest.workspaceId ?? "") === accessScope.workspaceId;

const readOwnedManifest = async (identity) => {
  const manifest = await readManifest(identity);

  return manifestMatchesAccessScope(manifest, identity.accessScope)
    ? manifest
    : null;
};

const installBufferAtomically = async (filePath, buffer) => {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;

  await writeFile(temporaryPath, buffer, {
    flag: "wx",
  });

  try {
    await link(temporaryPath, filePath);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }

    throw error;
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
};

const normalizeOptionalSha256 = (value) =>
  String(value ?? "").trim().toLowerCase();

const normalizeMetadata = (request = {}) => {
  const identity = normalizeIdentity(request);

  return {
    manifestVersion: MANIFEST_VERSION,
    ownerUserId: identity.accessScope.userId,
    workspaceId: identity.accessScope.workspaceId,
    fileId: identity.fileId,
    fileName: String(request.fileName ?? ""),
    fileSize: parseStrictInteger(request.fileSize),
    lastModified: parseStrictInteger(request.lastModified ?? 0),
    totalChunks: parseStrictInteger(request.totalChunks),
    chunkSize: parseStrictInteger(request.chunkSize),
    fileSha256: normalizeOptionalSha256(request.fileSha256),
    createdAt: new Date().toISOString(),
    sessionId: randomUUID(),
  };
};

const validateMetadata = (metadata) => {
  if (!metadata.fileName) {
    throw createUploadError("fileName is required.");
  }

  if (!isSafeUploadFileName(metadata.fileName)) {
    throw createUploadError(
      `fileName must be a safe name of at most ${MAX_UPLOAD_FILE_NAME_BYTES} UTF-8 bytes.`
    );
  }

  if (!Number.isSafeInteger(metadata.fileSize) || metadata.fileSize <= 0) {
    throw createUploadError("fileSize must be a positive safe integer.");
  }

  if (metadata.fileSize > MAX_RESUMABLE_UPLOAD_SIZE) {
    throw createUploadError(
      `fileSize exceeds the maximum resumable upload size of ${MAX_RESUMABLE_UPLOAD_SIZE} bytes.`,
      413
    );
  }

  if (!Number.isSafeInteger(metadata.totalChunks) || metadata.totalChunks <= 0) {
    throw createUploadError("totalChunks must be a positive safe integer.");
  }

  if (metadata.totalChunks > MAX_UPLOAD_CHUNKS) {
    throw createUploadError(
      `Upload requires too many chunks; the maximum is ${MAX_UPLOAD_CHUNKS}.`,
      413
    );
  }

  if (!Number.isSafeInteger(metadata.chunkSize) || metadata.chunkSize <= 0) {
    throw createUploadError("chunkSize must be a positive safe integer.");
  }

  if (metadata.chunkSize > MAX_CHUNK_UPLOAD_SIZE) {
    throw createUploadError(
      `chunkSize exceeds the maximum chunk size of ${MAX_CHUNK_UPLOAD_SIZE} bytes.`,
      413
    );
  }

  if (
    !Number.isSafeInteger(metadata.lastModified) ||
    metadata.lastModified < 0
  ) {
    throw createUploadError(
      "lastModified must be a non-negative safe integer."
    );
  }

  const expectedTotalChunks = Math.ceil(metadata.fileSize / metadata.chunkSize);

  if (metadata.totalChunks !== expectedTotalChunks) {
    throw createUploadError(
      `totalChunks does not match fileSize and chunkSize; expected ${expectedTotalChunks}.`
    );
  }

  if (
    metadata.fileSha256 &&
    !/^[a-f0-9]{64}$/.test(metadata.fileSha256)
  ) {
    throw createUploadError(
      "fileSha256 must be a 64-character hexadecimal SHA-256 digest."
    );
  }
};

const metadataMatches = (storedMetadata, nextMetadata) =>
  storedMetadata.manifestVersion === nextMetadata.manifestVersion &&
  storedMetadata.ownerUserId === nextMetadata.ownerUserId &&
  storedMetadata.workspaceId === nextMetadata.workspaceId &&
  storedMetadata.fileId === nextMetadata.fileId &&
  storedMetadata.fileName === nextMetadata.fileName &&
  storedMetadata.fileSize === nextMetadata.fileSize &&
  storedMetadata.lastModified === nextMetadata.lastModified &&
  storedMetadata.totalChunks === nextMetadata.totalChunks &&
  storedMetadata.chunkSize === nextMetadata.chunkSize &&
  String(storedMetadata.fileSha256 ?? "") === nextMetadata.fileSha256;

const toPublicSession = (manifest, uploadedChunks) => {
  const {
    manifestVersion,
    ownerUserId,
    workspaceId,
    ...publicManifest
  } = manifest;

  return {
    ...publicManifest,
    uploadedChunks,
  };
};

const getExpectedChunkSize = (manifest, chunkIndex) =>
  chunkIndex === manifest.totalChunks - 1
    ? manifest.fileSize - manifest.chunkSize * (manifest.totalChunks - 1)
    : manifest.chunkSize;

const hashBuffer = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");

export const ensureUploadStorage = async () => {
  await mkdir(uploadSessionsDirectory, { recursive: true });
};

export const configureUploadSessionDirectory = (nextDirectory) => {
  uploadSessionsDirectory = path.resolve(nextDirectory);
};

// New sessions of one tenant are created one at a time in this process, so
// two concurrent /upload/init calls cannot both pass the cap check and both
// install a manifest. Processes that share one sessions directory do not see
// each other's lock: together they can pass a cap by at most one session (or
// one file's bytes) per extra process.
const tenantSessionCreations = new Map();

const withTenantSessionCreationLock = async (accessScope, operation) => {
  const tenantKey = JSON.stringify([accessScope.userId, accessScope.workspaceId]);
  const previous = tenantSessionCreations.get(tenantKey) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);

  tenantSessionCreations.set(tenantKey, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (tenantSessionCreations.get(tenantKey) === tail) {
      tenantSessionCreations.delete(tenantKey);
    }
  }
};

// Bounds the open manifest reads of one scan.
const MANIFEST_SCAN_CONCURRENCY = 32;

// The tenant's open sessions: every session directory whose manifest names
// this (user, workspace). Directory names are hashes, so this reads each
// manifest; it runs only when a new session is about to be created. A session
// past its TTL still counts until the sweep removes it (it can still be
// resumed until then). A manifest that cannot be read or parsed names no
// session anyone can resume, so it counts for nobody.
const listTenantUploadSessions = async (accessScope) => {
  let entries;

  try {
    entries = await readdir(uploadSessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const directories = entries.filter((entry) => entry.isDirectory());
  const sessions = [];

  for (let start = 0; start < directories.length; start += MANIFEST_SCAN_CONCURRENCY) {
    const batch = await Promise.all(
      directories.slice(start, start + MANIFEST_SCAN_CONCURRENCY).map(async (entry) => {
        try {
          const manifest = JSON.parse(
            await readFile(
              path.join(uploadSessionsDirectory, entry.name, "manifest.json"),
              "utf8"
            )
          );

          return manifestMatchesAccessScope(manifest, accessScope)
            ? {
                fileSize:
                  Number.isSafeInteger(manifest.fileSize) && manifest.fileSize > 0
                    ? manifest.fileSize
                    : 0,
              }
            : null;
        } catch {
          return null;
        }
      })
    );

    sessions.push(...batch.filter(Boolean));
  }

  return sessions;
};

/**
 * The tenant erase and export (rag/tenant-lifecycle.js): every session
 * directory whose manifest names a tenant of `selector` (rag/tenant-records.js;
 * a workspace-wide selector covers every user of the workspace), with its
 * manifest and how many chunk files it holds. Directory names are hashes, so
 * this reads every manifest; one that cannot be read names nobody.
 */
export const listUploadSessionsForTenant = async (selector) => {
  let entries;

  try {
    entries = await readdir(uploadSessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const sessions = [];

  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    let manifest = null;

    try {
      manifest = JSON.parse(
        await readFile(path.join(uploadSessionsDirectory, entry.name, "manifest.json"), "utf8")
      );
    } catch {
      continue;
    }

    if (
      manifest?.manifestVersion !== MANIFEST_VERSION ||
      !tenantSelectorMatches(selector, {
        userId: String(manifest.ownerUserId ?? ""),
        workspaceId: String(manifest.workspaceId ?? ""),
      })
    ) {
      continue;
    }

    let chunkFiles = 0;

    try {
      chunkFiles = (await readdir(path.join(uploadSessionsDirectory, entry.name))).filter(
        (name) => parseChunkIndex(name) !== null
      ).length;
    } catch {
      chunkFiles = 0;
    }

    sessions.push({ chunkFiles, directory: entry.name, manifest });
  }

  return sessions;
};

/** Removes the directories listUploadSessionsForTenant finds; returns how many. */
export const eraseUploadSessionsForTenant = async (selector) => {
  const sessions = await listUploadSessionsForTenant(selector);

  for (const session of sessions) {
    await rm(path.join(uploadSessionsDirectory, session.directory), {
      force: true,
      recursive: true,
    });
  }

  return sessions.length;
};

const assertTenantSessionCapacity = async ({ accessScope, fileSize }) => {
  const maxSessions = getUploadSessionMaxPerTenant();
  const maxBytes = getUploadSessionMaxBytesPerTenant();

  if (maxSessions <= 0 && maxBytes <= 0) {
    return;
  }

  const sessions = await listTenantUploadSessions(accessScope);

  if (maxSessions > 0 && sessions.length + 1 > maxSessions) {
    throw createUploadSessionLimitError("sessions", maxSessions);
  }

  const openBytes = sessions.reduce((total, session) => total + session.fileSize, 0);

  if (maxBytes > 0 && openBytes + fileSize > maxBytes) {
    throw createUploadSessionLimitError("bytes", maxBytes);
  }
};

const toInitializedSession = async (identity, manifest, metadata) => {
  if (!manifestMatchesAccessScope(manifest, identity.accessScope)) {
    throw createUploadError("Upload session not found.", 404);
  }

  if (!metadataMatches(manifest, metadata)) {
    throw createUploadError(
      "Upload session metadata does not match the existing session.",
      409
    );
  }

  const uploadedChunks = await listUploadedChunks(identity);
  return toPublicSession(manifest, uploadedChunks);
};

export const initializeUploadSession = async (request = {}) => {
  const metadata = normalizeMetadata(request);
  validateMetadata(metadata);

  const identity = {
    accessScope: {
      userId: metadata.ownerUserId,
      workspaceId: metadata.workspaceId,
    },
    fileId: metadata.fileId,
  };

  // Resuming a session the tenant already has is never refused by the caps
  // and does not wait for the tenant's lock.
  const resumedManifest = await readManifest(identity);

  if (resumedManifest) {
    return toInitializedSession(identity, resumedManifest, metadata);
  }

  return withTenantSessionCreationLock(identity.accessScope, async () => {
    let existingManifest = await readManifest(identity);

    if (!existingManifest) {
      // Checked before the directory is created, so a refused init leaves
      // nothing on disk.
      await assertTenantSessionCapacity({
        accessScope: identity.accessScope,
        fileSize: metadata.fileSize,
      });
      await mkdir(getSessionDirectory(identity), { recursive: true });

      const installed = await installBufferAtomically(
        getManifestPath(identity),
        Buffer.from(JSON.stringify(metadata, null, 2), "utf8")
      );

      existingManifest = installed ? metadata : await readManifest(identity);
    }

    return toInitializedSession(identity, existingManifest, metadata);
  });
};

export const getUploadSessionStatus = async (request = {}) => {
  const identity = normalizeIdentity(request);
  const manifest = await readOwnedManifest(identity);

  if (!manifest) {
    return null;
  }

  const uploadedChunks = await listUploadedChunks(identity);
  return toPublicSession(manifest, uploadedChunks);
};

const readFinalizationClaim = async (identity) => {
  try {
    const claim = JSON.parse(
      await readFile(getFinalizationClaimPath(identity), "utf8")
    );

    if (!isValidFinalizationClaim(claim)) {
      throw createUploadError(
        "Upload finalization claim is invalid.",
        500
      );
    }

    return claim;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const isValidFinalizationClaim = (claim) =>
  claim &&
  typeof claim === "object" &&
  !Array.isArray(claim) &&
  uuidPattern.test(String(claim.claimToken ?? "")) &&
  uuidPattern.test(String(claim.ownerInstanceId ?? "")) &&
  Number.isSafeInteger(claim.ownerPid) &&
  claim.ownerPid > 0 &&
  sessionClaimPurposes.has(claim.purpose) &&
  typeof claim.claimedAt === "string" &&
  Number.isFinite(Date.parse(claim.claimedAt));

const createSessionClaim = (purpose) => ({
  claimToken: randomUUID(),
  claimedAt: new Date().toISOString(),
  ownerInstanceId: UPLOAD_STORE_INSTANCE_ID,
  ownerPid: process.pid,
  purpose,
});

const assertFinalizationClaim = async (identity, claimToken) => {
  const normalizedClaimToken = String(claimToken ?? "").trim();
  const claim = await readFinalizationClaim(identity);

  if (
    !claim ||
    claim.purpose !== "finalize" ||
    claim.claimToken !== normalizedClaimToken
  ) {
    throw createUploadError(
      "Upload session is not claimed for finalization.",
      409
    );
  }
};

export const claimUploadSessionFinalization = async (request = {}) => {
  const identity = normalizeIdentity(request);
  const manifest = await readOwnedManifest(identity);

  if (!manifest) {
    throw createUploadError(
      "Upload session not found. Initialize upload first.",
      404
    );
  }

  const uploadedChunks = await listUploadedChunks(identity);
  assertCompleteChunkSet(manifest, uploadedChunks);

  const claim = createSessionClaim("finalize");

  try {
    const installed = await installBufferAtomically(
      getFinalizationClaimPath(identity),
      Buffer.from(JSON.stringify(claim), "utf8")
    );

    if (!installed) {
      throw createUploadError(
        "Upload session is already being finalized.",
        409
      );
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw createUploadError("Upload session not found.", 404);
    }

    throw error;
  }

  return {
    claimToken: claim.claimToken,
    session: toPublicSession(manifest, uploadedChunks),
  };
};

export const releaseUploadSessionFinalization = async (request = {}) => {
  const identity = normalizeIdentity(request);
  const claimToken = String(request.claimToken ?? "").trim();
  const claim = await readFinalizationClaim(identity);

  if (!claim || !claimToken || claim.claimToken !== claimToken) {
    return false;
  }

  try {
    await unlink(getFinalizationClaimPath(identity));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

export const storeUploadChunk = async (request = {}) => {
  const identity = normalizeIdentity(request);
  const manifest = await readOwnedManifest(identity);

  if (!manifest) {
    throw createUploadError(
      "Upload session not found. Initialize upload first.",
      404
    );
  }

  if (await readFinalizationClaim(identity)) {
    throw createUploadError(
      "Upload session is already being finalized.",
      409
    );
  }

  const chunkIndex = parseStrictInteger(request.chunkIndex);
  const totalChunks = parseStrictInteger(request.totalChunks);

  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw createUploadError(
      "chunkIndex must be a non-negative integer."
    );
  }

  if (chunkIndex >= manifest.totalChunks) {
    throw createUploadError("chunkIndex exceeds totalChunks.");
  }

  if (totalChunks !== manifest.totalChunks) {
    throw createUploadError(
      "totalChunks does not match the upload session."
    );
  }

  if (!Buffer.isBuffer(request.chunkBuffer)) {
    throw createUploadError("chunk must be binary data.");
  }

  const expectedChunkSize = getExpectedChunkSize(manifest, chunkIndex);

  if (request.chunkBuffer.byteLength !== expectedChunkSize) {
    throw createUploadError(
      `Chunk ${chunkIndex} must contain exactly ${expectedChunkSize} bytes.`
    );
  }

  const actualChunkSha256 = hashBuffer(request.chunkBuffer);
  const claimedChunkSha256 = normalizeOptionalSha256(request.chunkSha256);

  if (
    claimedChunkSha256 &&
    !/^[a-f0-9]{64}$/.test(claimedChunkSha256)
  ) {
    throw createUploadError(
      "chunkSha256 must be a 64-character hexadecimal SHA-256 digest."
    );
  }

  if (claimedChunkSha256 && claimedChunkSha256 !== actualChunkSha256) {
    throw createUploadError("chunkSha256 does not match the uploaded chunk.");
  }

  const chunkPath = getChunkPath(identity, chunkIndex);
  const installed = await installBufferAtomically(
    chunkPath,
    request.chunkBuffer
  );

  if (!installed) {
    const existingChunk = await readFile(chunkPath);

    if (hashBuffer(existingChunk) !== actualChunkSha256) {
      throw createUploadError(
        `Chunk ${chunkIndex} already contains different content.`,
        409
      );
    }
  }

  const uploadedChunks = await listUploadedChunks(identity);

  return {
    uploadedChunks,
    totalChunks: manifest.totalChunks,
  };
};

const assertCompleteChunkSet = (manifest, uploadedChunks) => {
  if (
    uploadedChunks.length !== manifest.totalChunks ||
    uploadedChunks.some((chunkIndex, index) => chunkIndex !== index)
  ) {
    throw createUploadError(
      `Upload incomplete. Received ${uploadedChunks.length}/${manifest.totalChunks} chunks.`,
      409
    );
  }
};

const mergeChunksIntoFile = async ({
  identity,
  destinationPath,
  manifest,
}) => {
  const temporaryPath = `${destinationPath}.upload-${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let bytesWritten = 0;

  try {
    for (
      let chunkIndex = 0;
      chunkIndex < manifest.totalChunks;
      chunkIndex += 1
    ) {
      const chunkPath = getChunkPath(identity, chunkIndex);
      let chunkBuffer;

      try {
        chunkBuffer = await readFile(chunkPath);
      } catch (error) {
        if (error.code === "ENOENT") {
          throw createUploadError(
            `Missing chunk ${chunkIndex}. Resume the upload before completing it.`,
            409
          );
        }

        throw error;
      }

      const expectedChunkSize = getExpectedChunkSize(manifest, chunkIndex);

      if (chunkBuffer.byteLength !== expectedChunkSize) {
        throw createUploadError(
          `Chunk ${chunkIndex} has an invalid size; expected ${expectedChunkSize} bytes.`,
          409
        );
      }

      hash.update(chunkBuffer);
      bytesWritten += chunkBuffer.byteLength;
      await writeFile(temporaryPath, chunkBuffer, {
        flag: chunkIndex === 0 ? "wx" : "a",
      });
    }

    if (bytesWritten !== manifest.fileSize) {
      throw createUploadError(
        `Merged upload size ${bytesWritten} does not match declared fileSize ${manifest.fileSize}.`,
        409
      );
    }

    const sha256 = hash.digest("hex");

    if (manifest.fileSha256 && manifest.fileSha256 !== sha256) {
      throw createUploadError(
        "Merged upload SHA-256 does not match fileSha256.",
        409
      );
    }

    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw createUploadError(
          "Upload destination already exists.",
          409
        );
      }

      throw error;
    }

    return {
      bytesWritten,
      sha256,
    };
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
};

export const finalizeUploadSession = async (request = {}) => {
  const identity = normalizeIdentity(request);
  const manifest = await readOwnedManifest(identity);

  if (!manifest) {
    throw createUploadError(
      "Upload session not found. Initialize upload first.",
      404
    );
  }

  const destinationPath = String(request.destinationPath ?? "").trim();

  if (!destinationPath) {
    throw createUploadError(
      "Upload destinationPath is required.",
      500
    );
  }

  await assertFinalizationClaim(identity, request.claimToken);

  const uploadedChunks = await listUploadedChunks(identity);
  assertCompleteChunkSet(manifest, uploadedChunks);

  const result = await mergeChunksIntoFile({
    identity,
    destinationPath,
    manifest,
  });

  if (request.cleanupChunks === true) {
    await rm(getSessionDirectory(identity), {
      recursive: true,
      force: true,
    });
  }

  return {
    ...toPublicSession(manifest, uploadedChunks),
    fileSize: result.bytesWritten,
    sha256: result.sha256,
  };
};

export const clearUploadSession = async (request = {}) => {
  const identity = normalizeIdentity(request);

  await rm(getSessionDirectory(identity), {
    recursive: true,
    force: true,
  });
};

export const removeMergedUpload = async (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    await rm(filePath, {
      force: true,
    });
  } catch (error) {
    console.error(`Failed to remove merged upload at ${filePath}.`, error);
  }
};

const isProcessAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const isFinalizationClaimOwnerAlive = (claim) => {
  if (!isValidFinalizationClaim(claim)) {
    return false;
  }

  const belongsToCurrentProcess =
    claim.ownerPid === process.pid &&
    claim.ownerInstanceId === UPLOAD_STORE_INSTANCE_ID;

  return (
    belongsToCurrentProcess ||
    (claim.ownerPid !== process.pid && isProcessAlive(claim.ownerPid))
  );
};

export const recoverInterruptedUploadFinalizations = async () => {
  let entries;

  try {
    entries = await readdir(uploadSessionsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        recoveredClaims: 0,
      };
    }

    throw error;
  }

  let recoveredClaims = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const claimPath = path.join(
      uploadSessionsDirectory,
      entry.name,
      finalizationClaimFileName
    );
    let claim;

    try {
      claim = JSON.parse(await readFile(claimPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }

      if (!(error instanceof SyntaxError)) {
        console.error(
          `recoverInterruptedUploadFinalizations: failed to read claim in "${entry.name}":`,
          error
        );
        continue;
      }
    }

    if (!isValidFinalizationClaim(claim)) {
      try {
        await unlink(claimPath);
        recoveredClaims += 1;
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.error(
            `recoverInterruptedUploadFinalizations: failed to remove malformed claim in "${entry.name}":`,
            error
          );
        }
      }
      continue;
    }

    if (isFinalizationClaimOwnerAlive(claim)) {
      continue;
    }

    try {
      await unlink(claimPath);
      recoveredClaims += 1;
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(
          `recoverInterruptedUploadFinalizations: failed to remove claim in "${entry.name}":`,
          error
        );
      }
    }
  }

  return {
    recoveredClaims,
  };
};

const DEFAULT_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const getSessionLastActivity = async (
  sessionDir,
  {
    excludeClaim = false,
    emptyFallback,
  } = {}
) => {
  const entries = await readdir(sessionDir, {
    withFileTypes: true,
  });
  const relevantEntries = excludeClaim
    ? entries.filter((entry) => entry.name !== finalizationClaimFileName)
    : entries;

  if (relevantEntries.length === 0) {
    if (Number.isFinite(emptyFallback)) {
      return emptyFallback;
    }

    return (await stat(sessionDir)).mtimeMs;
  }

  let newest = 0;

  for (const entry of relevantEntries) {
    const entryStat = await stat(path.join(sessionDir, entry.name));
    newest = Math.max(newest, entryStat.mtimeMs);
  }

  return newest;
};

const releaseSessionClaimFile = async (claimPath, claimToken) => {
  try {
    const claim = JSON.parse(await readFile(claimPath, "utf8"));

    if (claim.claimToken !== claimToken) {
      return false;
    }

    await unlink(claimPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

export const cleanupExpiredUploadSessions = async ({
  ttlMs = DEFAULT_UPLOAD_SESSION_TTL_MS,
  now = Date.now(),
} = {}) => {
  const parsedEnvTtl = Number.parseInt(process.env.UPLOAD_SESSION_TTL_MS, 10);
  const effectiveTtl =
    Number.isInteger(parsedEnvTtl) && parsedEnvTtl > 0 ? parsedEnvTtl : ttlMs;

  let entries;
  try {
    entries = await readdir(uploadSessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { removedSessions: 0 };
    }
    throw error;
  }

  let removedSessions = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sessionDir = path.join(uploadSessionsDirectory, entry.name);

    try {
      const claimPath = path.join(sessionDir, finalizationClaimFileName);
      try {
        await stat(claimPath);
        continue;
      } catch (claimError) {
        if (claimError.code !== "ENOENT") {
          console.error(
            `cleanupExpiredUploadSessions: failed to inspect finalization claim in "${entry.name}":`,
            claimError
          );
          continue;
        }
      }

      const lastActivity = await getSessionLastActivity(sessionDir);

      if (now - lastActivity >= effectiveTtl) {
        const cleanupClaim = createSessionClaim("cleanup");
        const installed = await installBufferAtomically(
          claimPath,
          Buffer.from(JSON.stringify(cleanupClaim), "utf8")
        );

        if (!installed) {
          continue;
        }

        let cleanupClaimOwned = true;

        try {
          const refreshedLastActivity = await getSessionLastActivity(
            sessionDir,
            {
              excludeClaim: true,
              emptyFallback: lastActivity,
            }
          );

          if (now - refreshedLastActivity < effectiveTtl) {
            continue;
          }

          await rm(sessionDir, {
            recursive: true,
            force: true,
          });
          cleanupClaimOwned = false;
          removedSessions += 1;
        } finally {
          if (cleanupClaimOwned) {
            await releaseSessionClaimFile(
              claimPath,
              cleanupClaim.claimToken
            );
          }
        }
      }
    } catch (sessionError) {
      console.error(
        `cleanupExpiredUploadSessions: failed to process session "${entry.name}":`,
        sessionError
      );
    }
  }

  return { removedSessions };
};

/**
 * Sweeps expired upload sessions every `intervalMs` while the process runs,
 * so an abandoned session stops holding its chunks (and its place under the
 * tenant caps) about one interval after it expires, not at the next restart.
 * The timer is unref'd, so it never keeps a process alive, and a sweep still
 * running when the next tick comes skips that tick. `stop()` clears the
 * timer; a sweep in flight is left to finish or be cut by the exit, as the
 * start-up sweep always could be: a cleanup claim left by a dead process is
 * removed by start-up recovery (recoverInterruptedUploadFinalizations), and
 * whatever a cut removal left behind is past its TTL for the next sweep. An
 * interval of 0 (or less) starts nothing.
 */
export const startUploadSessionSweeper = ({
  cleanup = cleanupExpiredUploadSessions,
  intervalMs,
  logger = console,
} = {}) => {
  const delay = Math.floor(Number(intervalMs));

  if (!Number.isFinite(delay) || delay <= 0) {
    return { running: false, stop: () => {} };
  }

  let inFlight = null;
  const timer = setInterval(() => {
    if (inFlight) {
      return;
    }

    inFlight = Promise.resolve()
      .then(() => cleanup())
      .catch((error) => {
        logger.error?.(
          "[upload-sessions] periodic cleanup of expired upload sessions failed:",
          error
        );
      })
      .finally(() => {
        inFlight = null;
      });
  }, delay);

  timer.unref?.();

  return {
    running: true,
    stop: () => clearInterval(timer),
  };
};
