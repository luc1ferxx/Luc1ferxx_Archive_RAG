// The local KMS provider (rag/kms/local-provider.js): file modes, the
// master key's permission check, atomic first use and rotation across
// processes that race, lock handling, destroy tombstones, and that a key
// another process destroyed is seen at once.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TENANT_ENCRYPTION_ERROR_CODES as CODES } from "../rag/kms/errors.js";
import { resolveTenantKeyScope } from "../rag/kms/key-scope.js";
import { createLocalTenantKmsProvider } from "../rag/kms/local-provider.js";

const providerUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "rag", "kms", "local-provider.js")
).href;
const posix = process.platform !== "win32";

let tempRoot;

const freshPaths = async (name) => {
  const directory = await mkdtemp(path.join(tempRoot, `${name}-`));

  return {
    keystoreDirectory: path.join(directory, "keystore"),
    masterKeyFile: path.join(directory, "secrets", "master.key"),
  };
};

const modeOf = async (target) => (await stat(target)).mode & 0o777;

const rejectsWithCode = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });

// Runs `script` (an async function body with `provider`, `scope` and `args` in
// scope) in a separate Node process at `startAt`, so several processes race.
const runInChild = (paths, script, args, startAt) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          const { createLocalTenantKmsProvider } = await import(${JSON.stringify(providerUrl)});
          const args = JSON.parse(process.argv[1]);
          const provider = createLocalTenantKmsProvider(args.paths);
          const scope = args.scope;
          while (Date.now() < args.startAt) {}
          const result = await (async () => { ${script} })();
          process.stdout.write(JSON.stringify(result));
        `,
        JSON.stringify({ ...args, paths, startAt }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(JSON.parse(stdout));
      } else {
        reject(new Error(`child exited ${code}: ${stderr}`));
      }
    });
  });

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-kms-local-"));
});

after(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

test("first use creates a 0600 master key and a 0700 keystore with 0600 key files", async () => {
  const paths = await freshPaths("modes");
  const provider = createLocalTenantKmsProvider(paths);
  const scope = resolveTenantKeyScope({ workspaceId: "acme" });

  assert.equal((await provider.status()).status, "ok", "absent is not an error");
  assert.equal(await provider.describeKey(scope), null);

  const key = await provider.getOrCreateKey(scope);

  assert.deepEqual(key, { keyId: scope.keyId, version: 1 });

  if (posix) {
    assert.equal(await modeOf(paths.masterKeyFile), 0o600);
    assert.equal(await modeOf(paths.keystoreDirectory), 0o700);
    assert.equal(await modeOf(path.join(paths.keystoreDirectory, `${scope.keyId}.json`)), 0o600);
  }

  const masterText = await readFile(paths.masterKeyFile, "utf8");

  assert.match(masterText, /Demo-grade/);

  const keyFile = JSON.parse(await readFile(path.join(paths.keystoreDirectory, `${scope.keyId}.json`), "utf8"));

  assert.equal(keyFile.keyId, scope.keyId);
  assert.ok(!JSON.stringify(keyFile).includes("acme"), "no raw tenant id in the keystore");
  assert.deepEqual(await readdir(paths.keystoreDirectory), [`${scope.keyId}.json`], "no temp or lock file left");

  const status = await provider.status();

  assert.equal(status.status, "ok");
  assert.equal(status.keystore.keys, 1);
  assert.equal(status.masterKey.state, "ok");
  assert.match(status.masterKey.masterKeyId, /^mk_[0-9a-f]{16}$/);
});

test("a master key other users can read is refused", { skip: !posix && "POSIX modes only" }, async () => {
  const paths = await freshPaths("permissions");
  const scope = resolveTenantKeyScope({ userId: "ann" });

  await createLocalTenantKmsProvider(paths).getOrCreateKey(scope);
  await chmod(paths.masterKeyFile, 0o644);

  const reader = createLocalTenantKmsProvider(paths);

  await rejectsWithCode(
    reader.wrapDataKey({ aad: Buffer.from("a"), dataKey: randomBytes(32), keyId: scope.keyId, version: 1 }),
    CODES.masterKeyPermissions
  );

  const status = await reader.status();

  assert.equal(status.status, "error");
  assert.ok(status.errors.some((error) => error.code === CODES.masterKeyPermissions));
});

test("wrap and unwrap bind the AAD; another provider over the same files agrees", async () => {
  const paths = await freshPaths("wrap");
  const scope = resolveTenantKeyScope({ workspaceId: "acme" });
  const writer = createLocalTenantKmsProvider(paths);
  const { version } = await writer.getOrCreateKey(scope);
  const dataKey = randomBytes(32);
  const wrapped = await writer.wrapDataKey({ aad: Buffer.from("ctx"), dataKey, keyId: scope.keyId, version });
  const reader = createLocalTenantKmsProvider(paths);

  assert.deepEqual(await reader.unwrapDataKey({ aad: Buffer.from("ctx"), keyId: scope.keyId, version, wrapped }), dataKey);
  await rejectsWithCode(
    reader.unwrapDataKey({ aad: Buffer.from("other"), keyId: scope.keyId, version, wrapped }),
    CODES.keyUnwrapFailed
  );
  await rejectsWithCode(
    reader.unwrapDataKey({ aad: Buffer.from("ctx"), keyId: resolveTenantKeyScope({ workspaceId: "x" }).keyId, version, wrapped }),
    CODES.keyNotFound
  );
});

test("processes racing on first use agree on one master key and one key", async () => {
  const paths = await freshPaths("race-create");
  const scope = resolveTenantKeyScope({ workspaceId: "racing" });
  const dataKey = randomBytes(32);
  const startAt = Date.now() + 700;
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      runInChild(
        paths,
        `
          const key = await provider.getOrCreateKey(scope);
          const wrapped = await provider.wrapDataKey({
            aad: Buffer.from("race"),
            dataKey: Buffer.from(args.dataKey, "hex"),
            keyId: key.keyId,
            version: key.version,
          });
          return { version: key.version, wrapped: wrapped.toString("base64") };
        `,
        { dataKey: dataKey.toString("hex"), index, scope },
        startAt
      )
    )
  );
  const parent = createLocalTenantKmsProvider(paths);

  for (const result of results) {
    assert.equal(result.version, 1);
    assert.deepEqual(
      await parent.unwrapDataKey({
        aad: Buffer.from("race"),
        keyId: scope.keyId,
        version: 1,
        wrapped: Buffer.from(result.wrapped, "base64"),
      }),
      dataKey,
      "every process wrapped with the same key material"
    );
  }

  assert.deepEqual(await readdir(paths.keystoreDirectory), [`${scope.keyId}.json`]);
  assert.deepEqual(await readdir(path.dirname(paths.masterKeyFile)), ["master.key"]);
});

test("processes rotating at once each get their own version, and none is lost", async () => {
  const paths = await freshPaths("race-rotate");
  const scope = resolveTenantKeyScope({ workspaceId: "rotating" });

  await createLocalTenantKmsProvider(paths).getOrCreateKey(scope);

  const startAt = Date.now() + 700;
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      runInChild(paths, "return provider.rotateKey(scope);", { scope }, startAt)
    )
  );
  const versions = results.map((result) => result.version).sort((left, right) => left - right);

  assert.deepEqual(versions, [2, 3, 4, 5]);

  const described = await createLocalTenantKmsProvider(paths).describeKey(scope);

  assert.deepEqual(described.versions, [1, 2, 3, 4, 5]);
  assert.equal(described.currentVersion, 5);
  assert.deepEqual(await readdir(paths.keystoreDirectory), [`${scope.keyId}.json`], "no lock or temp file left");
});

test("a rotation that found no key file never replaces a first version created meanwhile", async () => {
  const paths = await freshPaths("rotate-vs-create");
  const scope = resolveTenantKeyScope({ workspaceId: "first-use-race" });
  const dataKey = randomBytes(32);
  const creator = createLocalTenantKmsProvider(paths);
  let sealed = null;
  // The rotator read "no key file" under its lock; before it writes, another
  // process's lock-free first use links version 1 in and seals with it.
  const rotator = createLocalTenantKmsProvider({
    ...paths,
    beforeKeyFileWrite: async ({ current }) => {
      if (!current && !sealed) {
        const key = await creator.getOrCreateKey(scope);

        sealed = {
          version: key.version,
          wrapped: await creator.wrapDataKey({ aad: Buffer.from("race"), dataKey, keyId: key.keyId, version: key.version }),
        };
      }
    },
  });
  const rotation = await rotator.rotateKey(scope);

  assert.equal(sealed.version, 1);
  assert.deepEqual(rotation, { dryRun: false, keyId: scope.keyId, previousVersion: 1, version: 2 }, "rotated on top of it");

  const reader = createLocalTenantKmsProvider(paths);

  assert.deepEqual(
    await reader.unwrapDataKey({ aad: Buffer.from("race"), keyId: scope.keyId, version: 1, wrapped: sealed.wrapped }),
    dataKey,
    "what the first use sealed still decrypts"
  );
  assert.deepEqual((await reader.describeKey(scope)).versions, [1, 2]);
  assert.deepEqual(await readdir(paths.keystoreDirectory), [`${scope.keyId}.json`], "no lock or temp file left");
});

test("processes creating and rotating a new key at once lose no version anyone sealed with", async () => {
  const paths = await freshPaths("race-create-rotate");
  const scope = resolveTenantKeyScope({ workspaceId: "racing-rotate" });
  const dataKey = randomBytes(32);
  const startAt = Date.now() + 700;
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      runInChild(
        paths,
        index % 2 === 0
          ? `
          const key = await provider.getOrCreateKey(scope);
          const wrapped = await provider.wrapDataKey({
            aad: Buffer.from("race"),
            dataKey: Buffer.from(args.dataKey, "hex"),
            keyId: key.keyId,
            version: key.version,
          });
          return { version: key.version, wrapped: wrapped.toString("base64") };
        `
          : "const rotated = await provider.rotateKey(scope); return { rotated: rotated.version };",
        { dataKey: dataKey.toString("hex"), scope },
        startAt
      )
    )
  );
  const reader = createLocalTenantKmsProvider(paths);
  const described = await reader.describeKey(scope);

  for (const result of results.filter((entry) => entry.wrapped)) {
    assert.deepEqual(
      await reader.unwrapDataKey({
        aad: Buffer.from("race"),
        keyId: scope.keyId,
        version: result.version,
        wrapped: Buffer.from(result.wrapped, "base64"),
      }),
      dataKey,
      `version ${result.version} still holds the material it was sealed with`
    );
  }

  const rotated = results.filter((entry) => entry.rotated).map((entry) => entry.rotated);

  assert.equal(new Set(rotated).size, rotated.length, "every rotation got its own version");
  assert.deepEqual(described.versions, Array.from({ length: described.versions.length }, (_, index) => index + 1));
});

test("one process's concurrent first uses share one creation", async () => {
  const paths = await freshPaths("same-process");
  const provider = createLocalTenantKmsProvider(paths);
  const scope = resolveTenantKeyScope({ userId: "solo" });
  const keys = await Promise.all(Array.from({ length: 20 }, () => provider.getOrCreateKey(scope)));

  assert.ok(keys.every((key) => key.version === 1));

  const rotations = await Promise.all(Array.from({ length: 5 }, () => provider.rotateKey(scope)));

  assert.deepEqual(rotations.map((rotation) => rotation.version).sort(), [2, 3, 4, 5, 6]);
});

test("a stale lock is broken; a live one times out with a coded error", async () => {
  const paths = await freshPaths("locks");
  const scope = resolveTenantKeyScope({ workspaceId: "locked" });
  const provider = createLocalTenantKmsProvider({ ...paths, lockTimeoutMs: 150, staleLockMs: 60000 });

  await provider.getOrCreateKey(scope);

  const lockPath = path.join(paths.keystoreDirectory, `${scope.keyId}.lock`);

  await writeFile(lockPath, "{}");
  await rejectsWithCode(provider.rotateKey(scope), CODES.keystoreLockTimeout);

  const old = new Date(Date.now() - 120000);

  await utimes(lockPath, old, old);
  assert.equal((await provider.rotateKey(scope)).version, 2, "a lock older than staleLockMs is broken");
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("destroy leaves a tombstone without material, seen at once by other providers", async () => {
  const paths = await freshPaths("destroy");
  const scope = resolveTenantKeyScope({ workspaceId: "doomed" });
  const holder = createLocalTenantKmsProvider(paths);
  const { version } = await holder.getOrCreateKey(scope);
  const dataKey = randomBytes(32);
  const wrapped = await holder.wrapDataKey({ aad: Buffer.from("x"), dataKey, keyId: scope.keyId, version });

  // The holder has the key cached.
  assert.deepEqual(await holder.unwrapDataKey({ aad: Buffer.from("x"), keyId: scope.keyId, version, wrapped }), dataKey);

  const preview = await createLocalTenantKmsProvider(paths).destroyKey(scope, { dryRun: true });

  assert.deepEqual(preview, { destroyedVersions: [1], dryRun: true, existed: true, keyId: scope.keyId });

  const destroyed = await createLocalTenantKmsProvider(paths).destroyKey(scope);

  assert.deepEqual(destroyed.destroyedVersions, [1]);

  const tombstone = JSON.parse(await readFile(path.join(paths.keystoreDirectory, `${scope.keyId}.json`), "utf8"));

  assert.deepEqual(tombstone.versions, []);
  assert.equal(tombstone.currentVersion, null);
  assert.equal(tombstone.destroyedThroughVersion, 1);
  assert.ok(!JSON.stringify(tombstone).includes("wrappedKey"));

  await rejectsWithCode(
    holder.unwrapDataKey({ aad: Buffer.from("x"), keyId: scope.keyId, version, wrapped }),
    CODES.keyDestroyed
  );
  assert.equal((await holder.describeKey(scope)).state, "destroyed");
  assert.deepEqual(await holder.destroyKey(scope), {
    destroyedVersions: [],
    dryRun: false,
    existed: true,
    keyId: scope.keyId,
  });
  assert.equal((await holder.getOrCreateKey(scope)).version, 2);

  const status = await holder.status();

  assert.equal(status.status, "ok");
  assert.equal(status.keystore.activeKeys, 1);
});

test("status reports keys without a master key, a foreign master key and a damaged key file", async () => {
  const paths = await freshPaths("status");
  const scope = resolveTenantKeyScope({ workspaceId: "acme" });

  await createLocalTenantKmsProvider(paths).getOrCreateKey(scope);

  const masterText = await readFile(paths.masterKeyFile, "utf8");

  await rm(paths.masterKeyFile);

  const missing = await createLocalTenantKmsProvider(paths).status();

  assert.equal(missing.status, "error");
  assert.ok(missing.errors.some((error) => error.code === CODES.masterKeyMissing));
  await rejectsWithCode(
    createLocalTenantKmsProvider(paths).wrapDataKey({ aad: Buffer.alloc(1), dataKey: randomBytes(32), keyId: scope.keyId, version: 1 }),
    CODES.masterKeyMissing
  );

  // Another master key (a lost one regenerated): the key file names the old id.
  const other = randomBytes(32);
  const { createHash } = await import("node:crypto");

  await writeFile(
    paths.masterKeyFile,
    JSON.stringify({
      format: "archive-rag-local-kms-master-key",
      formatVersion: 1,
      key: other.toString("base64"),
      masterKeyId: `mk_${createHash("sha256").update("archive-rag/local-kms-master-key|").update(other).digest("hex").slice(0, 16)}`,
    }),
    { mode: 0o600 }
  );

  const foreign = await createLocalTenantKmsProvider(paths).status();

  assert.equal(foreign.status, "error");
  assert.ok(foreign.errors.some((error) => error.code === CODES.keystoreInvalid));

  await writeFile(paths.masterKeyFile, masterText, { mode: 0o600 });
  assert.equal((await createLocalTenantKmsProvider(paths).status()).status, "ok");

  await writeFile(path.join(paths.keystoreDirectory, `${scope.keyId}.json`), "{ not json", { mode: 0o600 });

  const damaged = await createLocalTenantKmsProvider(paths).status();

  assert.equal(damaged.status, "error");
  assert.ok(damaged.errors.some((error) => error.code === CODES.keystoreInvalid));
});
