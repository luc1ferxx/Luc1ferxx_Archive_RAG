// Envelope encryption of tenant file bytes at rest (tenant isolation phase 5,
// TENANT_ENCRYPTION=on).
//
// What it covers: the bytes a tenant uploaded and everything stored that
// holds them -- rag_documents.file_bytes (and the file-backed registry's
// document files), rag_ingest_jobs.file_bytes and the staged outputs' payload
// in rag_ingest_jobs_outputs (the PDF, its pages and chunks text, the
// embeddings), and the upload session chunk files on disk. The working files
// of one request or ingest attempt are covered by rag/working-files.js. Chunk
// text, embeddings and tsvectors in the chunk tables, run snapshots, feedback
// and memory stay plaintext: search and the agent read them (see AGENTS.md).
//
// Every object gets its own random 256-bit data key; the payload is
// AES-256-GCM under it, and the data key is wrapped by the tenant's key
// (rag/kms/, one key per workspace, or per user outside any workspace). The
// stored form:
//
//   offset  size  field
//   0       7     magic "\0ARTENC"
//   7       1     format version (1)
//   8       4     header length H (uint32, big endian, 1..4096)
//   12      H     header, UTF-8 JSON: { a: "A256GCM", k: key id, v: key
//                 version, p: provider id, w: wrapped data key (base64) }
//   12+H    12    payload nonce
//   24+H    16    payload tag
//   40+H    ...   ciphertext
//
// Both GCM operations carry the record's context as AAD -- its owner's
// workspace and user, the object kind and the object id (a docId, a jobId and
// output name, an upload session chunk) -- which the reader supplies from the
// record itself, never from the envelope. So a ciphertext copied into another
// tenant's row, or another document's row of the same tenant, fails to
// decrypt. The payload AAD leaves the header out, so `rewrap` can move a data
// key to the newest key version without touching the payload; the wrapped
// key's own AAD binds the key id and version.
//
// Reads recognise the magic and decrypt; anything else is legacy plaintext and
// passes through unchanged, so a store holds both while `encrypt-existing`
// (npm run tenant:keys) works through it. A wrong context, a destroyed or
// missing key, or a changed byte fails with a coded error
// (rag/kms/errors.js), never with garbage.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { isTenantEncryptionEnabled } from "./config.js";
import {
  TENANT_ENCRYPTION_ERROR_CODES as CODES,
  createTenantEncryptionError,
  getTenantKmsProvider,
  isTenantKeyId,
  resolveTenantKeyScope,
  resolveTenantKeyScopesForErase,
} from "./kms/index.js";

export const TENANT_ENVELOPE_MAGIC = Buffer.from([0x00, 0x41, 0x52, 0x54, 0x45, 0x4e, 0x43]);
export const TENANT_ENVELOPE_FORMAT_VERSION = 1;

const PREFIX = Buffer.concat([TENANT_ENVELOPE_MAGIC, Buffer.from([TENANT_ENVELOPE_FORMAT_VERSION])]);
const PREFIX_BYTES = PREFIX.length;
const LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 4096;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const ALGORITHM = "A256GCM";
const EMPTY = Buffer.alloc(0);

// The object kinds an envelope's AAD names. A job's PDF keeps one context
// whether it sits in the job row or, once parse finished, in the
// `document_file` stage output (the move happens inside the database).
export const TENANT_OBJECT_KINDS = Object.freeze({
  documentFile: "document_file",
  ingestJobFile: "ingest_job_file",
  ingestJobOutput: "ingest_job_output",
  uploadChunk: "upload_chunk",
});

const normalizeId = (value) => String(value ?? "").trim();

/** The context of one stored object: who owns it, what it is, which one. */
export const buildTenantObjectContext = ({ kind, objectId, userId = "", workspaceId = "" }) => {
  if (!Object.values(TENANT_OBJECT_KINDS).includes(kind)) {
    throw new Error(`Unknown tenant object kind "${kind}".`);
  }

  const id = normalizeId(objectId);

  if (!id) {
    throw new Error("A tenant object context needs an object id.");
  }

  return Object.freeze({ kind, objectId: id, userId: normalizeId(userId), workspaceId: normalizeId(workspaceId) });
};

export const documentFileContext = ({ docId, ownerUserId = "", userId = ownerUserId, workspaceId = "" }) =>
  buildTenantObjectContext({ kind: TENANT_OBJECT_KINDS.documentFile, objectId: docId, userId, workspaceId });

export const ingestJobFileContext = ({ jobId, ownerUserId = "", userId = ownerUserId, workspaceId = "" }) =>
  buildTenantObjectContext({ kind: TENANT_OBJECT_KINDS.ingestJobFile, objectId: jobId, userId, workspaceId });

export const ingestJobOutputContext = ({ jobId, output, ownerUserId = "", userId = ownerUserId, workspaceId = "" }) =>
  output === "document_file"
    ? ingestJobFileContext({ jobId, userId, workspaceId })
    : buildTenantObjectContext({
        kind: TENANT_OBJECT_KINDS.ingestJobOutput,
        objectId: `${normalizeId(jobId)}/${normalizeId(output)}`,
        userId,
        workspaceId,
      });

export const uploadChunkContext = ({ chunkIndex, sessionId, userId = "", workspaceId = "" }) =>
  buildTenantObjectContext({
    kind: TENANT_OBJECT_KINDS.uploadChunk,
    objectId: `${normalizeId(sessionId)}/${Number(chunkIndex)}`,
    userId,
    workspaceId,
  });

const contextParts = (context) => [context.kind, context.objectId, context.workspaceId, context.userId];

const payloadAad = (context) =>
  Buffer.concat([
    PREFIX,
    Buffer.from(JSON.stringify(["archive-rag/tenant-envelope", TENANT_ENVELOPE_FORMAT_VERSION, ...contextParts(context)])),
  ]);

const dataKeyAad = (context, keyId, version) =>
  Buffer.from(
    JSON.stringify(["archive-rag/tenant-data-key", TENANT_ENVELOPE_FORMAT_VERSION, keyId, version, ...contextParts(context)])
  );

const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []));

/** Whether `bytes` are an envelope (they start with the magic and a version). */
export const isTenantEnvelope = (bytes) =>
  (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) &&
  bytes.length >= PREFIX_BYTES &&
  toBuffer(bytes).subarray(0, TENANT_ENVELOPE_MAGIC.length).equals(TENANT_ENVELOPE_MAGIC);

const malformed = (message) => createTenantEncryptionError(CODES.envelopeMalformed, message);

// The framing of an envelope at the start of `bytes`: { complete: false }
// while more bytes are needed, else its header, nonce, tag and where the
// ciphertext starts. Throws for framing that can never be valid.
const readEnvelopeFraming = (bytes) => {
  if (bytes.length < PREFIX_BYTES + LENGTH_BYTES) {
    return { complete: false };
  }

  if (bytes[TENANT_ENVELOPE_MAGIC.length] !== TENANT_ENVELOPE_FORMAT_VERSION) {
    throw malformed(`Unknown tenant envelope format version ${bytes[TENANT_ENVELOPE_MAGIC.length]}.`);
  }

  const headerLength = bytes.readUInt32BE(PREFIX_BYTES);

  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw malformed("The tenant envelope header length is out of range.");
  }

  const headerStart = PREFIX_BYTES + LENGTH_BYTES;
  const bodyOffset = headerStart + headerLength + NONCE_BYTES + TAG_BYTES;

  if (bytes.length < bodyOffset) {
    return { complete: false };
  }

  let parsed;

  try {
    parsed = JSON.parse(bytes.subarray(headerStart, headerStart + headerLength).toString("utf8"));
  } catch {
    parsed = null;
  }

  const version = Number(parsed?.v);
  const wrapped = typeof parsed?.w === "string" ? Buffer.from(parsed.w, "base64") : EMPTY;

  if (
    parsed?.a !== ALGORITHM ||
    !isTenantKeyId(parsed?.k) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof parsed?.p !== "string" ||
    wrapped.length === 0
  ) {
    throw malformed("The tenant envelope header is damaged.");
  }

  const nonceStart = headerStart + headerLength;

  return {
    bodyOffset,
    complete: true,
    header: { keyId: parsed.k, provider: parsed.p, version, wrapped },
    headerEnd: nonceStart,
    nonce: bytes.subarray(nonceStart, nonceStart + NONCE_BYTES),
    tag: bytes.subarray(nonceStart + NONCE_BYTES, bodyOffset),
  };
};

const encodeHeader = ({ keyId, provider, version, wrapped }) => {
  const header = Buffer.from(JSON.stringify({ a: ALGORITHM, k: keyId, p: provider, v: version, w: wrapped.toString("base64") }));
  const length = Buffer.alloc(LENGTH_BYTES);

  length.writeUInt32BE(header.length);
  return Buffer.concat([PREFIX, length, header]);
};

// The data key of an envelope read as `context`: refused before any KMS call
// when the envelope names another tenant's key or another provider.
const unwrapEnvelopeDataKey = async (header, context, kms) => {
  const expected = resolveTenantKeyScope(context);

  if (header.keyId !== expected.keyId) {
    throw createTenantEncryptionError(
      CODES.envelopeKeyMismatch,
      `The envelope names key ${header.keyId}, not the key of the record's owner (${expected.keyId}).`
    );
  }

  if (header.provider !== kms.id) {
    throw createTenantEncryptionError(
      CODES.providerMismatch,
      `The envelope was written by KMS provider "${header.provider}", not "${kms.id}".`
    );
  }

  const dataKey = await kms.unwrapDataKey({
    aad: dataKeyAad(context, header.keyId, header.version),
    keyId: header.keyId,
    version: header.version,
    wrapped: header.wrapped,
  });

  if (!Buffer.isBuffer(dataKey) || dataKey.length !== DATA_KEY_BYTES) {
    throw createTenantEncryptionError(CODES.keyUnwrapFailed, "The unwrapped data key has the wrong length.");
  }

  return dataKey;
};

/**
 * `bytes` sealed for `context` under its tenant's current key version (the
 * key is created on first use). Always encrypts; maybeEncryptTenantBytes is
 * the write-path seam that honours TENANT_ENCRYPTION.
 */
export const encryptTenantBytes = async (bytes, context, { kms = getTenantKmsProvider() } = {}) => {
  const plaintext = toBuffer(bytes);
  const { keyId, version } = await kms.getOrCreateKey(resolveTenantKeyScope(context));
  const dataKey = randomBytes(DATA_KEY_BYTES);

  try {
    const wrapped = await kms.wrapDataKey({ aad: dataKeyAad(context, keyId, version), dataKey, keyId, version });
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);

    cipher.setAAD(payloadAad(context));

    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return Buffer.concat([encodeHeader({ keyId, provider: kms.id, version, wrapped }), nonce, cipher.getAuthTag(), ciphertext]);
  } finally {
    dataKey.fill(0);
  }
};

/** The write path: an envelope with TENANT_ENCRYPTION=on, `bytes` as given otherwise. */
export const maybeEncryptTenantBytes = async (bytes, context, options = {}) =>
  isTenantEncryptionEnabled() ? encryptTenantBytes(bytes, context, options) : bytes;

/**
 * The plaintext of `bytes` read as `context`. Bytes that are not an envelope
 * (legacy plaintext) come back unchanged, the same Buffer; the KMS is touched
 * only for an envelope.
 */
export const decryptTenantBytes = async (bytes, context, { kms = null } = {}) => {
  if (!isTenantEnvelope(bytes)) {
    return bytes === null || bytes === undefined ? bytes : toBuffer(bytes);
  }

  const buffer = toBuffer(bytes);
  const framing = readEnvelopeFraming(buffer);

  if (!framing.complete) {
    throw malformed("The tenant envelope is truncated.");
  }

  const dataKey = await unwrapEnvelopeDataKey(framing.header, context, kms ?? getTenantKmsProvider());

  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, framing.nonce);

    decipher.setAAD(payloadAad(context));
    decipher.setAuthTag(framing.tag);
    return Buffer.concat([decipher.update(buffer.subarray(framing.bodyOffset)), decipher.final()]);
  } catch {
    throw createTenantEncryptionError(
      CODES.envelopeAuthFailed,
      `The ${context.kind} ${context.objectId} failed authentication: it was changed, or it belongs to another record.`
    );
  } finally {
    dataKey.fill(0);
  }
};

/**
 * Decrypts bytes that arrive in parts (a bytea read in slices) without
 * holding them all: push(part) resolves to the plaintext ready so far,
 * finish() to the rest, and throws when the payload does not authenticate.
 * Plaintext handed out before finish() is unverified until finish() returns,
 * so a caller writing it out must discard what it wrote when finish() throws.
 * `resolveContext()` is called once, only when the bytes are an envelope, so
 * a legacy read costs nothing extra.
 */
export const createTenantBytesDecoder = ({ kms = null, resolveContext }) => {
  let mode = "probe";
  let pending = [];
  let pendingLength = 0;
  let decipher = null;
  let dataKey = null;
  let context = null;

  const takePending = () => {
    const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength);

    pending = [];
    pendingLength = 0;
    return all;
  };

  const startBody = async (buffer) => {
    const framing = readEnvelopeFraming(buffer);

    if (!framing.complete) {
      pending = [buffer];
      pendingLength = buffer.length;
      return EMPTY;
    }

    context = await resolveContext();
    dataKey = await unwrapEnvelopeDataKey(framing.header, context, kms ?? getTenantKmsProvider());
    decipher = createDecipheriv("aes-256-gcm", dataKey, framing.nonce);
    decipher.setAAD(payloadAad(context));
    decipher.setAuthTag(framing.tag);
    mode = "body";
    return decipher.update(buffer.subarray(framing.bodyOffset));
  };

  return {
    get encrypted() {
      return mode === "framing" || mode === "body";
    },

    async push(chunk) {
      const part = toBuffer(chunk);

      if (mode === "plain") {
        return part;
      }

      if (mode === "body") {
        return decipher.update(part);
      }

      pending.push(part);
      pendingLength += part.length;

      if (mode === "probe") {
        if (pendingLength < PREFIX_BYTES) {
          return EMPTY;
        }

        const buffered = takePending();

        if (!isTenantEnvelope(buffered)) {
          mode = "plain";
          return buffered;
        }

        mode = "framing";
        return startBody(buffered);
      }

      return startBody(takePending());
    },

    async finish() {
      if (mode === "probe") {
        mode = "done";
        return takePending();
      }

      if (mode === "framing") {
        mode = "done";
        throw malformed("The tenant envelope is truncated.");
      }

      if (mode === "body") {
        mode = "done";

        try {
          return decipher.final();
        } catch {
          throw createTenantEncryptionError(
            CODES.envelopeAuthFailed,
            `The ${context.kind} ${context.objectId} failed authentication: it was changed, or it belongs to another record.`
          );
        } finally {
          dataKey.fill(0);
        }
      }

      mode = "done";
      return EMPTY;
    },
  };
};

/** The key an envelope names ({ keyId, version, provider }), or null for plaintext. */
export const describeTenantEnvelope = (bytes) => {
  if (!isTenantEnvelope(bytes)) {
    return null;
  }

  const framing = readEnvelopeFraming(toBuffer(bytes));

  if (!framing.complete) {
    throw malformed("The tenant envelope is truncated.");
  }

  const { keyId, provider, version } = framing.header;

  return { keyId, provider, version };
};

/**
 * Moves an envelope's data key to its tenant key's current version without
 * re-encrypting the payload (only the header changes): { bytes, changed }.
 * Plaintext and envelopes already on the current version come back
 * unchanged. A key that was destroyed, or has no current version, fails
 * (the old version cannot be unwrapped either).
 */
export const rewrapTenantEnvelope = async (bytes, context, { kms = getTenantKmsProvider() } = {}) => {
  if (!isTenantEnvelope(bytes)) {
    return { bytes, changed: false };
  }

  const buffer = toBuffer(bytes);
  const framing = readEnvelopeFraming(buffer);

  if (!framing.complete) {
    throw malformed("The tenant envelope is truncated.");
  }

  const described = await kms.describeKey(framing.header.keyId);
  const currentVersion = described?.currentVersion ?? null;

  if (currentVersion === framing.header.version) {
    return { bytes, changed: false };
  }

  const dataKey = await unwrapEnvelopeDataKey(framing.header, context, kms);

  try {
    if (!currentVersion) {
      throw createTenantEncryptionError(CODES.keyDestroyed, `${framing.header.keyId} has no current version.`);
    }

    const wrapped = await kms.wrapDataKey({
      aad: dataKeyAad(context, framing.header.keyId, currentVersion),
      dataKey,
      keyId: framing.header.keyId,
      version: currentVersion,
    });

    return {
      bytes: Buffer.concat([
        encodeHeader({ keyId: framing.header.keyId, provider: kms.id, version: currentVersion, wrapped }),
        buffer.subarray(framing.headerEnd),
      ]),
      changed: true,
      fromVersion: framing.header.version,
      toVersion: currentVersion,
    };
  } finally {
    dataKey.fill(0);
  }
};

// --- Crypto-shred on tenant erase (rag/tenant-lifecycle.js) ------------------

const describeKeyScope = async (kms, scope) => {
  const described = await kms.describeKey(scope.keyId);

  return {
    keyId: scope.keyId,
    scope: scope.kind,
    state: described?.state ?? "absent",
    versions: described?.versions ?? [],
  };
};

/**
 * The keys an erase of `selector` (a normalized tenant selector) concerns,
 * ids and versions only: `destroy` (a workspace's key, or the key of a user
 * outside any workspace) and `kept` (the workspace key a one-user erase inside
 * a workspace shares with the other members). `applies` is false when the
 * erase has no key to do anything with: encryption off and no key on file.
 */
export const describeTenantKeysForErase = async (selector, { kms = getTenantKmsProvider() } = {}) => {
  const { destroy, kept } = resolveTenantKeyScopesForErase(selector);
  const described = {
    destroy: await Promise.all(destroy.map((scope) => describeKeyScope(kms, scope))),
    kept: await Promise.all(kept.map((scope) => describeKeyScope(kms, scope))),
  };

  return {
    ...described,
    applies:
      isTenantEncryptionEnabled() ||
      [...described.destroy, ...described.kept].some((key) => key.state !== "absent"),
  };
};

/** Destroys the `destroy` keys of an erase of `selector`; ids and versions only. */
export const destroyTenantKeysForErase = async (selector, { kms = getTenantKmsProvider() } = {}) => {
  const destroyed = [];

  for (const scope of resolveTenantKeyScopesForErase(selector).destroy) {
    const result = await kms.destroyKey(scope.keyId);

    destroyed.push({
      destroyedVersions: result.destroyedVersions,
      existed: result.existed,
      keyId: scope.keyId,
      scope: scope.kind,
    });
  }

  return destroyed;
};
