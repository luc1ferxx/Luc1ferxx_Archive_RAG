// The coded errors of tenant key management and the envelopes built on it. A
// read that cannot decrypt fails with one of these, never with garbage bytes;
// every one is a server-side condition (status 500) whose message names ids
// and versions only, never key material or record content.
export const TENANT_ENCRYPTION_ERROR_CODES = Object.freeze({
  // The envelope's payload failed authentication: a tampered byte, or a
  // ciphertext read with another record's context (tenant, kind or id).
  envelopeAuthFailed: "TENANT_ENVELOPE_AUTH_FAILED",
  // The envelope names another tenant's key than the record's owner columns.
  envelopeKeyMismatch: "TENANT_ENVELOPE_KEY_MISMATCH",
  // The envelope's framing or header cannot be parsed (truncated, damaged).
  envelopeMalformed: "TENANT_ENVELOPE_MALFORMED",
  // Every version up to the one the envelope names was destroyed.
  keyDestroyed: "TENANT_KEY_DESTROYED",
  // No key file, or no such version (a keystore that was lost or replaced).
  keyNotFound: "TENANT_KEY_NOT_FOUND",
  // The per-object data key could not be unwrapped with the named version.
  keyUnwrapFailed: "TENANT_KEY_UNWRAP_FAILED",
  // A key file that is damaged or was written under another master key.
  keystoreInvalid: "TENANT_KMS_KEYSTORE_INVALID",
  // A keystore operation that could not take its file lock in time.
  keystoreLockTimeout: "TENANT_KMS_KEYSTORE_LOCK_TIMEOUT",
  // The master key file is missing where keys need it, damaged, or readable
  // by other users of the machine.
  masterKeyInvalid: "TENANT_KMS_MASTER_KEY_INVALID",
  masterKeyMissing: "TENANT_KMS_MASTER_KEY_MISSING",
  masterKeyPermissions: "TENANT_KMS_MASTER_KEY_PERMISSIONS",
  // The envelope was written by another provider than the configured one.
  providerMismatch: "TENANT_KMS_PROVIDER_MISMATCH",
  // A working file (rag/working-files.js) this process cannot decrypt: written
  // by another process, whose key went with it, or damaged.
  workingFileUnreadable: "WORKING_FILE_UNREADABLE",
});

// Bytes these codes describe can never be read again (a destroyed key, a
// changed byte, another record's ciphertext): `retryable: false`, which
// rag/ingest-worker.js reads before the status, so such an ingest attempt
// fails at once instead of spending its retries. A missing or unreadable
// keystore or master key may be an operator's mount to fix: those stay
// retryable (5xx), and a job that runs out of attempts keeps its bytes in
// dead_letter for a requeue.
const PERMANENT_CODES = new Set([
  TENANT_ENCRYPTION_ERROR_CODES.envelopeAuthFailed,
  TENANT_ENCRYPTION_ERROR_CODES.envelopeKeyMismatch,
  TENANT_ENCRYPTION_ERROR_CODES.envelopeMalformed,
  TENANT_ENCRYPTION_ERROR_CODES.keyDestroyed,
  TENANT_ENCRYPTION_ERROR_CODES.keyUnwrapFailed,
  TENANT_ENCRYPTION_ERROR_CODES.workingFileUnreadable,
]);

export const createTenantEncryptionError = (code, message, details = {}) =>
  Object.assign(new Error(message), {
    code,
    expose: false,
    ...(PERMANENT_CODES.has(code) ? { retryable: false } : {}),
    status: 500,
    ...details,
  });

export const isTenantEncryptionError = (error) =>
  Object.values(TENANT_ENCRYPTION_ERROR_CODES).includes(error?.code);
