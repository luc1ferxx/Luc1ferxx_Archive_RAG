// The local KMS provider (TENANT_KMS_PROVIDER=local): tenant keys as files on
// this machine. DEMO-GRADE. It exists so envelope encryption and crypto-shred
// can be exercised without any cloud credentials; a production deployment
// replaces it with a cloud KMS or an HSM behind the same interface
// (rag/kms/index.js).
//
// Layout, both outside PostgreSQL so a database backup never holds a usable
// key, and destroying a key here also shreds the copies of its ciphertext in
// every older database backup:
//
//   TENANT_KMS_MASTER_KEY_FILE      default <data root>/tenant-kms-master.key
//     One 32-byte random key (base64 in a small JSON file), created on first
//     use with mode 0600 and never rewritten. Refused when other users of the
//     machine can read it.
//   TENANT_KEYSTORE_DIR             default <data root>/tenant-keystore
//     <keyId>.json per tenant key: its versions, each 32 random bytes wrapped
//     (AES-256-GCM) under the master key with the key id, the version and the
//     master key id as AAD. File names are key ids (a hash of the scope,
//     rag/kms/key-scope.js), never raw tenant ids. Directory mode 0700, files
//     0600.
//
// <data root> is the parent of RAG_DATA_DIRECTORY (server/data locally,
// /data on the image's volume).
//
// Concurrency: the master key and a key's first version are created with an
// exclusive link() of a fully written temp file, so processes that race on
// first use agree on one key (the losers re-read it). Every later change of a
// key file (rotate, destroy, a new version after a destroy) takes an O_EXCL
// lock file, re-reads, and replaces the file with rename(), so a reader sees
// the old file or the new one, never half of either. A lock older than
// `staleLockMs` (a holder that crashed) is broken.
//
// Caching: a key file's unwrapped versions are kept in memory and reused while
// the file's identity (inode, size, mtime) is unchanged, checked with one
// stat per operation, so a key another process rotated or destroyed is seen at
// the next operation, not after a TTL.
//
// What "destroy" means here: the key file is overwritten in place with zeros,
// synced, and replaced by a tombstone that keeps only the version numbers (so
// a later read of a destroyed version fails as destroyed rather than as
// missing, and a new key for the same scope continues the numbering). On a
// copy-on-write filesystem (APFS, btrfs, ZFS) or an SSD the old blocks may
// survive the overwrite, and they are wrapped by a master key that does
// survive: the local provider's shred is best effort. A cloud KMS or an HSM
// destroys key material where it cannot be copied in the first place, which
// is why it is the production replacement.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { getTenantKeystoreDirectorySetting, getTenantKmsMasterKeyFileSetting } from "../config.js";
import { getRagDataDirectory } from "../storage.js";
import { TENANT_ENCRYPTION_ERROR_CODES as CODES, createTenantEncryptionError } from "./errors.js";
import { isTenantKeyId } from "./key-scope.js";

export const LOCAL_KMS_PROVIDER_ID = "local";

const KEY_FILE_FORMAT = "archive-rag-local-tenant-key";
const MASTER_KEY_FORMAT = "archive-rag-local-kms-master-key";
const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_FILE_PATTERN = /^(tk_[0-9a-f]{40})\.json$/;
const MASTER_KEY_WARNING =
  "Demo-grade local master key for TENANT_KMS_PROVIDER=local. Anyone who can read this file and the keystore can decrypt every tenant's files. Use a cloud KMS or an HSM in production.";

/** The paths the local provider uses: the settings, else the defaults. */
export const resolveLocalKmsPaths = () => {
  const dataRoot = path.dirname(getRagDataDirectory());

  return {
    keystoreDirectory: path.resolve(getTenantKeystoreDirectorySetting() ?? path.join(dataRoot, "tenant-keystore")),
    masterKeyFile: path.resolve(getTenantKmsMasterKeyFileSetting() ?? path.join(dataRoot, "tenant-kms-master.key")),
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isGroupOrOtherAccessible = (mode) => process.platform !== "win32" && (mode & 0o077) !== 0;

const toOctalMode = (mode) => `0${(mode & 0o777).toString(8)}`;

const sealAesGcm = (key, plaintext, aad) => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);

  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
};

// Throws (any error) when the bytes do not authenticate under `key` and `aad`.
const openAesGcm = (key, sealed, aad) => {
  if (!Buffer.isBuffer(sealed) || sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("Sealed bytes are too short.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_BYTES));

  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));

  return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]);
};

const toMasterKeyId = (key) =>
  `mk_${createHash("sha256").update("archive-rag/local-kms-master-key|").update(key).digest("hex").slice(0, 16)}`;

const keyMaterialAad = ({ keyId, masterKeyId, version }) =>
  Buffer.from(JSON.stringify(["archive-rag/local-kms/tenant-key", FORMAT_VERSION, keyId, version, masterKeyId]));

const assertKeyId = (keyId) => {
  if (!isTenantKeyId(keyId)) {
    throw createTenantEncryptionError(CODES.envelopeMalformed, `"${String(keyId).slice(0, 64)}" is not a tenant key id.`);
  }

  return keyId;
};

const toVersion = (value) => {
  const version = Number(value);

  return Number.isSafeInteger(version) && version > 0 ? version : null;
};

// Writes `content` to `filePath` only if nothing is there yet: a complete temp
// file is linked into place, so a reader never sees a partial one. False when
// another writer got there first.
const createFileExclusively = async (filePath, content) => {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });

  try {
    await link(temporaryPath, filePath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }

    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
};

const replaceFileAtomically = async (filePath, content) => {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
};

// Best effort (see the header): the old key file's bytes are zeroed in place
// before the tombstone replaces it.
const overwriteInPlace = async (filePath) => {
  let handle;

  try {
    handle = await open(filePath, "r+");

    const { size } = await handle.stat();

    if (size > 0) {
      await handle.write(Buffer.alloc(size), 0, size, 0);
      await handle.sync();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
};

/**
 * The local provider. `keystoreDirectory` and `masterKeyFile` default to
 * resolveLocalKmsPaths() at construction (rag/kms/index.js rebuilds the
 * default provider when the settings change).
 */
export const createLocalTenantKmsProvider = ({
  keystoreDirectory = resolveLocalKmsPaths().keystoreDirectory,
  lockRetryMs = 10,
  lockTimeoutMs = 10000,
  masterKeyFile = resolveLocalKmsPaths().masterKeyFile,
  now = () => new Date().toISOString(),
  staleLockMs = 30000,
} = {}) => {
  const directory = path.resolve(keystoreDirectory);
  const masterPath = path.resolve(masterKeyFile);
  // keyId -> { signature, file, materials: Map<version, Buffer> }
  const keyCache = new Map();
  // keyId -> Promise, so one process's concurrent first uses of a key share
  // one creation, and its own key file changes run one at a time.
  const pendingCreations = new Map();
  const mutationQueues = new Map();
  let master = null;

  const keyFilePath = (keyId) => path.join(directory, `${assertKeyId(keyId)}.json`);
  const lockFilePath = (keyId) => path.join(directory, `${assertKeyId(keyId)}.lock`);

  const ensureKeystoreDirectory = () => mkdir(directory, { mode: 0o700, recursive: true });

  const parseMasterKeyFile = (text) => {
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const key = typeof parsed?.key === "string" ? Buffer.from(parsed.key, "base64") : null;

    if (
      parsed?.format !== MASTER_KEY_FORMAT ||
      parsed?.formatVersion !== FORMAT_VERSION ||
      key?.length !== KEY_BYTES ||
      parsed.masterKeyId !== toMasterKeyId(key)
    ) {
      throw createTenantEncryptionError(CODES.masterKeyInvalid, "The tenant KMS master key file is damaged.");
    }

    return { createdAt: parsed.createdAt ?? null, key, masterKeyId: parsed.masterKeyId };
  };

  // The master key from disk, refused when other users can read it. Null when
  // it does not exist and `create` is false.
  const readMasterKey = async ({ create }) => {
    let fileStat;

    try {
      fileStat = await stat(masterPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }

      if (!create) {
        return null;
      }

      const key = randomBytes(KEY_BYTES);

      await mkdir(path.dirname(masterPath), { mode: 0o700, recursive: true });
      await createFileExclusively(
        masterPath,
        `${JSON.stringify(
          {
            createdAt: now(),
            format: MASTER_KEY_FORMAT,
            formatVersion: FORMAT_VERSION,
            key: key.toString("base64"),
            masterKeyId: toMasterKeyId(key),
            warning: MASTER_KEY_WARNING,
          },
          null,
          2
        )}\n`
      );
      key.fill(0);

      return readMasterKey({ create: false });
    }

    if (!fileStat.isFile()) {
      throw createTenantEncryptionError(CODES.masterKeyInvalid, "The tenant KMS master key path is not a file.");
    }

    if (isGroupOrOtherAccessible(fileStat.mode)) {
      throw createTenantEncryptionError(
        CODES.masterKeyPermissions,
        `The tenant KMS master key file is accessible to other users (mode ${toOctalMode(fileStat.mode)}); restrict it to 0600.`
      );
    }

    return parseMasterKeyFile(await readFile(masterPath, "utf8"));
  };

  const getMasterKey = async ({ create = false } = {}) => {
    if (master) {
      return master;
    }

    const loaded = await readMasterKey({ create });

    if (!loaded && !create) {
      throw createTenantEncryptionError(
        CODES.masterKeyMissing,
        "The tenant KMS master key file does not exist, so no tenant key can be read."
      );
    }

    master = loaded;
    return master;
  };

  const validateKeyFile = (keyId, parsed) => {
    if (
      parsed?.format !== KEY_FILE_FORMAT ||
      parsed?.formatVersion !== FORMAT_VERSION ||
      parsed?.keyId !== keyId ||
      !Array.isArray(parsed?.versions)
    ) {
      throw createTenantEncryptionError(CODES.keystoreInvalid, `The key file of ${keyId} is damaged.`);
    }

    return parsed;
  };

  // The key file and its identity, read from one open handle so the two
  // belong together. Null when there is none.
  const readKeyFileWithSignature = async (keyId) => {
    let handle;

    try {
      handle = await open(keyFilePath(keyId), "r");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    try {
      const fileStat = await handle.stat();
      let parsed;

      try {
        parsed = JSON.parse(await handle.readFile("utf8"));
      } catch {
        parsed = null;
      }

      return {
        file: validateKeyFile(keyId, parsed),
        signature: `${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`,
      };
    } finally {
      await handle.close();
    }
  };

  const currentSignature = async (keyId) => {
    try {
      const fileStat = await stat(keyFilePath(keyId));

      return `${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  };

  // The key file with every live version unwrapped; null when there is no
  // key file. Reused while the file is unchanged on disk.
  const loadKey = async (keyId) => {
    const signature = await currentSignature(keyId);

    if (signature === null) {
      keyCache.delete(keyId);
      return null;
    }

    const cached = keyCache.get(keyId);

    if (cached?.signature === signature) {
      return cached;
    }

    const read = await readKeyFileWithSignature(keyId);

    if (!read) {
      keyCache.delete(keyId);
      return null;
    }

    const materials = new Map();

    if (read.file.versions.length > 0) {
      const { key: masterKey, masterKeyId } = await getMasterKey();

      if (read.file.masterKeyId !== masterKeyId) {
        throw createTenantEncryptionError(
          CODES.keystoreInvalid,
          `The key file of ${keyId} was written under another master key (${String(read.file.masterKeyId)}).`
        );
      }

      for (const entry of read.file.versions) {
        const version = toVersion(entry?.version);

        try {
          materials.set(
            version,
            openAesGcm(
              masterKey,
              Buffer.from(String(entry?.wrappedKey ?? ""), "base64"),
              keyMaterialAad({ keyId, masterKeyId, version })
            )
          );
        } catch {
          throw createTenantEncryptionError(CODES.keystoreInvalid, `Version ${version} of ${keyId} cannot be unwrapped.`);
        }
      }
    }

    const entry = { file: read.file, materials, signature: read.signature };

    keyCache.set(keyId, entry);
    return entry;
  };

  const wrapNewVersion = async ({ keyId, version }) => {
    const { key: masterKey, masterKeyId } = await getMasterKey({ create: true });
    const material = randomBytes(KEY_BYTES);
    const wrappedKey = sealAesGcm(masterKey, material, keyMaterialAad({ keyId, masterKeyId, version }));

    material.fill(0);
    return { masterKeyId, versionEntry: { createdAt: now(), version, wrappedKey: wrappedKey.toString("base64") } };
  };

  const newKeyFile = async ({ keyId, scopeKind }) => {
    const { masterKeyId, versionEntry } = await wrapNewVersion({ keyId, version: 1 });
    const createdAt = now();

    return {
      createdAt,
      currentVersion: 1,
      destroyedAt: null,
      destroyedThroughVersion: 0,
      format: KEY_FILE_FORMAT,
      formatVersion: FORMAT_VERSION,
      keyId,
      masterKeyId,
      scopeKind,
      updatedAt: createdAt,
      versions: [versionEntry],
    };
  };

  // The next version of `current` (or of nothing), numbered after every
  // version it ever had, destroyed ones included.
  const withNewVersion = async ({ current, keyId, scopeKind }) => {
    if (!current) {
      return newKeyFile({ keyId, scopeKind });
    }

    const highest = Math.max(
      Number(current.destroyedThroughVersion) || 0,
      ...current.versions.map((entry) => toVersion(entry?.version) ?? 0)
    );
    const version = highest + 1;
    const { masterKeyId, versionEntry } = await wrapNewVersion({ keyId, version });

    if (current.versions.length > 0 && current.masterKeyId !== masterKeyId) {
      throw createTenantEncryptionError(
        CODES.keystoreInvalid,
        `The key file of ${keyId} was written under another master key (${String(current.masterKeyId)}).`
      );
    }

    return {
      ...current,
      currentVersion: version,
      masterKeyId,
      updatedAt: now(),
      versions: [...current.versions, versionEntry],
    };
  };

  const withFileLock = async (keyId, callback) => {
    const lockPath = lockFilePath(keyId);
    const deadline = Date.now() + lockTimeoutMs;

    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);

        try {
          await handle.writeFile(JSON.stringify({ at: now(), pid: process.pid }));
        } finally {
          await handle.close();
        }

        break;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }

        try {
          const lockStat = await stat(lockPath);

          if (Date.now() - lockStat.mtimeMs > staleLockMs) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") {
            continue;
          }

          throw statError;
        }

        if (Date.now() > deadline) {
          throw createTenantEncryptionError(
            CODES.keystoreLockTimeout,
            `Timed out waiting for the keystore lock of ${keyId}.`
          );
        }

        await sleep(lockRetryMs + Math.floor(Math.random() * lockRetryMs));
      }
    }

    try {
      return await callback();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  };

  // One change of a key file: under this process's queue for the key and the
  // cross-process file lock, the file is re-read, `mutate(current)` returns
  // the next content (or null for no change), and the file is replaced.
  const mutateKeyFile = (keyId, mutate) => {
    const previous = mutationQueues.get(keyId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        await ensureKeystoreDirectory();

        return withFileLock(keyId, async () => {
          const read = await readKeyFileWithSignature(keyId);
          const current = read?.file ?? null;
          const next = await mutate(current);

          if (next) {
            if (next.versions.length === 0 && current) {
              await overwriteInPlace(keyFilePath(keyId));
            }

            await replaceFileAtomically(keyFilePath(keyId), `${JSON.stringify(next, null, 2)}\n`);
          }

          keyCache.delete(keyId);
          return { current, next };
        });
      });

    mutationQueues.set(keyId, run);
    run.finally(() => {
      if (mutationQueues.get(keyId) === run) {
        mutationQueues.delete(keyId);
      }
    }).catch(() => {});

    return run;
  };

  const materialFor = (entry, keyId, version) => {
    const requested = toVersion(version);

    if (!entry) {
      throw createTenantEncryptionError(CODES.keyNotFound, `The keystore holds no key ${keyId}.`);
    }

    if (requested !== null && requested <= (Number(entry.file.destroyedThroughVersion) || 0)) {
      throw createTenantEncryptionError(CODES.keyDestroyed, `Version ${requested} of ${keyId} was destroyed.`);
    }

    const material = requested === null ? null : entry.materials.get(requested);

    if (!material) {
      throw createTenantEncryptionError(CODES.keyNotFound, `The keystore holds no version ${version} of ${keyId}.`);
    }

    return material;
  };

  const describeFile = (keyId, file) =>
    file
      ? {
          createdAt: file.createdAt ?? null,
          currentVersion: toVersion(file.currentVersion),
          destroyedAt: file.destroyedAt ?? null,
          destroyedThroughVersion: Number(file.destroyedThroughVersion) || 0,
          keyId,
          scopeKind: file.scopeKind ?? null,
          state: toVersion(file.currentVersion) ? "active" : "destroyed",
          updatedAt: file.updatedAt ?? null,
          versions: file.versions.map((entry) => toVersion(entry?.version)).filter(Boolean),
        }
      : null;

  const createFirstVersion = async ({ keyId, scopeKind }) => {
    await ensureKeystoreDirectory();

    const file = await newKeyFile({ keyId, scopeKind });

    await createFileExclusively(keyFilePath(keyId), `${JSON.stringify(file, null, 2)}\n`);
    keyCache.delete(keyId);
  };

  const getOrCreateKeyOnce = async ({ keyId, kind }) => {
    let entry = await loadKey(keyId);

    if (!entry) {
      await createFirstVersion({ keyId, scopeKind: kind });
      entry = await loadKey(keyId);
    }

    if (!toVersion(entry?.file.currentVersion)) {
      // Destroyed before (a tenant erase): new writes get a new version,
      // numbered after the destroyed ones, which stay unreadable.
      await mutateKeyFile(keyId, (current) =>
        toVersion(current?.currentVersion) ? null : withNewVersion({ current, keyId, scopeKind: kind })
      );
      entry = await loadKey(keyId);
    }

    return { keyId, version: toVersion(entry.file.currentVersion) };
  };

  const describeKey = async (scopeOrKeyId) => {
    const keyId = assertKeyId(typeof scopeOrKeyId === "string" ? scopeOrKeyId : scopeOrKeyId?.keyId);
    const read = await readKeyFileWithSignature(keyId);

    return describeFile(keyId, read?.file ?? null);
  };

  const listKeys = async () => {
    let entries;

    try {
      entries = await readdir(directory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }

      throw error;
    }

    const keys = [];

    for (const name of entries.sort()) {
      const match = name.match(KEY_FILE_PATTERN);
      const described = match ? await describeKey(match[1]) : null;

      if (described) {
        keys.push(described);
      }
    }

    return keys;
  };

  return {
    id: LOCAL_KMS_PROVIDER_ID,
    keystoreDirectory: directory,
    masterKeyFile: masterPath,

    /** The key's current version for new writes; creates the key on first use. */
    async getOrCreateKey(scope) {
      const keyId = assertKeyId(scope?.keyId);
      const pending = pendingCreations.get(keyId);

      if (pending) {
        return pending;
      }

      const run = getOrCreateKeyOnce({ keyId, kind: scope.kind }).finally(() => {
        pendingCreations.delete(keyId);
      });

      pendingCreations.set(keyId, run);
      return run;
    },

    async wrapDataKey({ aad, dataKey, keyId, version }) {
      const material = materialFor(await loadKey(assertKeyId(keyId)), keyId, version);

      return sealAesGcm(material, dataKey, aad);
    },

    async unwrapDataKey({ aad, keyId, version, wrapped }) {
      const material = materialFor(await loadKey(assertKeyId(keyId)), keyId, version);

      try {
        return openAesGcm(material, wrapped, aad);
      } catch {
        throw createTenantEncryptionError(
          CODES.keyUnwrapFailed,
          `The data key cannot be unwrapped with version ${version} of ${keyId}.`
        );
      }
    },

    /** Metadata of the key (no material, no master key needed), or null. */
    describeKey,

    /** Metadata of every key in the keystore, in key id order. */
    listKeys,

    /**
     * A new version for new writes; older versions stay readable. A scope
     * without a key gets its first one. `dryRun` only reports.
     */
    async rotateKey(scope, { dryRun = false } = {}) {
      const keyId = assertKeyId(scope?.keyId);

      if (dryRun) {
        const described = await describeKey(keyId);
        const highest = Math.max(described?.destroyedThroughVersion ?? 0, ...(described?.versions ?? [0]));

        return { dryRun: true, keyId, previousVersion: described?.currentVersion ?? null, version: highest + 1 };
      }

      const { current, next } = await mutateKeyFile(keyId, (current) =>
        withNewVersion({ current, keyId, scopeKind: scope.kind })
      );

      return {
        dryRun: false,
        keyId,
        previousVersion: toVersion(current?.currentVersion),
        version: toVersion(next.currentVersion),
      };
    },

    /**
     * Destroys every version of the key: what was encrypted under it can no
     * longer be read, by this process or any other, from the database or
     * from any backup of it. `dryRun` reports what would go.
     */
    async destroyKey(scopeOrKeyId, { dryRun = false } = {}) {
      const keyId = assertKeyId(typeof scopeOrKeyId === "string" ? scopeOrKeyId : scopeOrKeyId?.keyId);

      if (dryRun) {
        const described = await describeKey(keyId);

        return {
          destroyedVersions: described?.versions ?? [],
          dryRun: true,
          existed: Boolean(described),
          keyId,
        };
      }

      const { current } = await mutateKeyFile(keyId, (current) => {
        if (!current || current.versions.length === 0) {
          return null;
        }

        const highest = Math.max(
          Number(current.destroyedThroughVersion) || 0,
          ...current.versions.map((entry) => toVersion(entry?.version) ?? 0)
        );
        const destroyedAt = now();

        return {
          ...current,
          currentVersion: null,
          destroyedAt,
          destroyedThroughVersion: highest,
          updatedAt: destroyedAt,
          versions: [],
        };
      });

      return {
        destroyedVersions: (current?.versions ?? []).map((entry) => toVersion(entry?.version)).filter(Boolean),
        dryRun: false,
        existed: Boolean(current),
        keyId,
      };
    },

    /**
     * Readability of the keystore and the master key, for health and the CLI.
     * Reads only: a missing master key or keystore is `absent` (created on
     * the first encrypted write), an error only when keys exist without a
     * usable master key, a file is damaged, or the master key is exposed.
     * Every key file is checked against the master key id; up to
     * `sampleSize` active keys are also unwrapped.
     */
    async status({ sampleSize = 5 } = {}) {
      const errors = [];
      const warnings = [];
      const keystore = { keys: 0, state: "absent" };
      const masterKey = { state: "absent" };
      let loadedMaster = null;

      try {
        const directoryStat = await stat(directory);

        if (!directoryStat.isDirectory()) {
          keystore.state = "error";
          errors.push({ code: CODES.keystoreInvalid, message: "The tenant keystore path is not a directory." });
        } else {
          keystore.state = "ok";
          keystore.mode = toOctalMode(directoryStat.mode);

          if (isGroupOrOtherAccessible(directoryStat.mode)) {
            warnings.push({ message: `The tenant keystore directory is accessible to other users (mode ${keystore.mode}).` });
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          keystore.state = "error";
          errors.push({ code: error?.code ?? "ERROR", message: "The tenant keystore cannot be read." });
        }
      }

      try {
        loadedMaster = await readMasterKey({ create: false });

        if (loadedMaster) {
          const masterStat = await stat(masterPath);

          Object.assign(masterKey, {
            masterKeyId: loadedMaster.masterKeyId,
            mode: toOctalMode(masterStat.mode),
            state: "ok",
          });
        }
      } catch (error) {
        masterKey.state = "error";
        errors.push({
          code: error?.code ?? CODES.masterKeyInvalid,
          message: error?.code?.startsWith?.("TENANT_") ? error.message : "The tenant KMS master key cannot be read.",
        });
      }

      if (keystore.state === "ok") {
        let keys = [];

        try {
          keys = await listKeys();
        } catch (error) {
          keystore.state = "error";
          errors.push({ code: error?.code ?? "ERROR", message: "The tenant key files cannot be read." });
        }

        const active = keys.filter((key) => key.state === "active");

        Object.assign(keystore, { activeKeys: active.length, destroyedKeys: keys.length - active.length, keys: keys.length });

        if (active.length > 0 && masterKey.state === "absent") {
          masterKey.state = "error";
          errors.push({
            code: CODES.masterKeyMissing,
            message: "The keystore holds tenant keys but the master key file does not exist; they cannot be read.",
          });
        } else if (loadedMaster) {
          for (const key of active) {
            try {
              const read = await readKeyFileWithSignature(key.keyId);

              if (read.file.masterKeyId !== loadedMaster.masterKeyId) {
                throw createTenantEncryptionError(CODES.keystoreInvalid, `${key.keyId} was written under another master key.`);
              }
            } catch (error) {
              keystore.state = "error";
              errors.push({ code: error?.code ?? CODES.keystoreInvalid, keyId: key.keyId, message: error.message });
            }
          }

          for (const key of active.slice(0, Math.max(0, sampleSize))) {
            try {
              materialFor(await loadKey(key.keyId), key.keyId, key.currentVersion);
            } catch (error) {
              keystore.state = "error";
              errors.push({ code: error?.code ?? CODES.keystoreInvalid, keyId: key.keyId, message: error.message });
            }
          }
        }
      }

      return {
        errors,
        keystore,
        masterKey,
        provider: LOCAL_KMS_PROVIDER_ID,
        status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok",
        warnings,
      };
    },

    /** Drops this process's cached keys (all, or one key id). */
    invalidate(keyId = null) {
      if (keyId) {
        keyCache.delete(keyId);
      } else {
        keyCache.clear();
        master = null;
      }
    },
  };
};
