// Working files: a tenant's PDF on disk for the length of one request or one
// ingest attempt -- the direct upload multer receives and the merged chunked
// upload (the uploads directory), an ingest attempt's copy
// (<temp>/ingest-tmp), an arXiv import's download, and the temporary copies
// vector:reindex and index-version builds parse. The PDF parser and the
// registry read them by path.
//
// With TENANT_ENCRYPTION=on they are written encrypted (AES-256-GCM) under a
// key that exists only in this process's memory: random per process start,
// never written anywhere, no KMS call. The process that writes a working file
// is always the one that reads it, and once it exits -- or crashes, leaving
// the file for a sweep -- nobody can read the file at all. It is not a
// tenant's key and binds no tenant: it only keeps plaintext off the disk; the
// stored copies are tenant envelopes (rag/tenant-encryption.js).
//
// Every reader goes through readWorkingFile / decodeWorkingFileBytes, which
// pass plaintext through unchanged, so with the setting off the files and
// their readers behave exactly as before.
//
// Layout: "\0ARTWRK" + version 1, a 12-byte nonce, the ciphertext, and the
// 16-byte tag at the end, so a file can be written as it streams in.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";

import { isTenantEncryptionEnabled } from "./config.js";
import { TENANT_ENCRYPTION_ERROR_CODES as CODES, createTenantEncryptionError } from "./kms/errors.js";

export const WORKING_FILE_MAGIC = Buffer.from([0x00, 0x41, 0x52, 0x54, 0x57, 0x52, 0x4b]);

const PREFIX = Buffer.concat([WORKING_FILE_MAGIC, Buffer.from([1])]);
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

let processKey = null;

const getProcessKey = () => {
  processKey ??= randomBytes(32);
  return processKey;
};

const createEncryptor = () => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getProcessKey(), nonce);

  cipher.setAAD(PREFIX);
  return { cipher, header: Buffer.concat([PREFIX, nonce]) };
};

export const isWorkingFileEnvelope = (bytes) =>
  (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) &&
  bytes.length >= PREFIX.length &&
  Buffer.from(bytes.buffer, bytes.byteOffset, WORKING_FILE_MAGIC.length).equals(WORKING_FILE_MAGIC);

/** `plaintext` as a working file stores it: encrypted when the setting is on. */
export const encodeWorkingFileBytes = (plaintext) => {
  if (!isTenantEncryptionEnabled()) {
    return plaintext;
  }

  const { cipher, header } = createEncryptor();
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
};

/** The plaintext of a working file's bytes; plaintext passes through. */
export const decodeWorkingFileBytes = (bytes) => {
  if (!isWorkingFileEnvelope(bytes)) {
    return bytes;
  }

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  if (buffer.length < PREFIX.length + NONCE_BYTES + TAG_BYTES || buffer[WORKING_FILE_MAGIC.length] !== 1) {
    throw createTenantEncryptionError(CODES.workingFileUnreadable, "The working file is damaged.");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getProcessKey(),
      buffer.subarray(PREFIX.length, PREFIX.length + NONCE_BYTES)
    );

    decipher.setAAD(PREFIX);
    decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(buffer.subarray(PREFIX.length + NONCE_BYTES, buffer.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw createTenantEncryptionError(
      CODES.workingFileUnreadable,
      "The working file cannot be decrypted: another process wrote it, or it was changed."
    );
  }
};

/** fs.writeFile for a working file (same arguments). */
export const writeWorkingFile = (filePath, bytes, options) =>
  writeFile(filePath, encodeWorkingFileBytes(bytes), options);

/** fs.readFile (no encoding) for a working file: its plaintext bytes. */
export const readWorkingFile = async (filePath, options) =>
  decodeWorkingFileBytes(await readFile(filePath, options));

/**
 * A working file written in parts: write(part) appends, close() finishes it
 * (the tag goes last), abort() closes and removes it. Opened with `flags`
 * (default "w", as fs.open).
 */
export const createWorkingFileWriter = async (filePath, { flags = "w", mode } = {}) => {
  const handle = await open(filePath, flags, mode);
  let encryptor = null;
  let closed = false;

  try {
    if (isTenantEncryptionEnabled()) {
      encryptor = createEncryptor();
      await handle.write(encryptor.header);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }

  return {
    async write(part) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);

      if (bytes.length > 0) {
        await handle.write(encryptor ? encryptor.cipher.update(bytes) : bytes);
      }
    },

    async close() {
      if (closed) {
        return;
      }

      closed = true;

      try {
        if (encryptor) {
          await handle.write(Buffer.concat([encryptor.cipher.final(), encryptor.cipher.getAuthTag()]));
        }
      } finally {
        await handle.close();
      }
    },

    async abort() {
      if (!closed) {
        closed = true;
        await handle.close().catch(() => {});
      }

      await rm(filePath, { force: true });
    },
  };
};

/**
 * A stream that turns plaintext into a working file's stored bytes (always
 * encrypted: for the TENANT_ENCRYPTION=on path of routes/working-file-
 * storage.js). `plaintextBytes` counts what went in.
 */
export const createWorkingFileEncryptStream = () => {
  const { cipher, header } = createEncryptor();
  let started = false;
  let plaintextBytes = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      plaintextBytes += chunk.length;

      const ciphertext = cipher.update(chunk);

      if (!started) {
        started = true;
        callback(null, Buffer.concat([header, ciphertext]));
        return;
      }

      callback(null, ciphertext);
    },

    flush(callback) {
      try {
        const tail = Buffer.concat([cipher.final(), cipher.getAuthTag()]);

        callback(null, started ? tail : Buffer.concat([header, tail]));
      } catch (error) {
        callback(error);
      }
    },
  });

  Object.defineProperty(stream, "plaintextBytes", { get: () => plaintextBytes });
  return stream;
};
