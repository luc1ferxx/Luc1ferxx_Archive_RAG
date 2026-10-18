// Where tenant file bytes rest, with TENANT_ENCRYPTION=on (no database): the
// file-backed registry, the upload session chunks and the merged upload, the
// ingest job stores' attempt files, stage outputs and job bytes (the
// PostgreSQL store over a stand-in query), the PostgreSQL registry's upsert,
// download and delete; then the tenant erase's key step, the health check
// and the tenant:keys command. Every store must keep plaintext out of what it
// writes, hand its readers plaintext, and stay exactly as before with the
// setting off.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import { createDocumentRegistryStore } from "../rag/doc-registry.js";
import { createInMemoryIngestJobStore, createPostgresIngestJobStore } from "../rag/ingest-job-store.js";
import { configureTenantKmsProvider, resetTenantKmsProvider, TENANT_ENCRYPTION_ERROR_CODES as CODES } from "../rag/kms/index.js";
import { resolveTenantKeyScope } from "../rag/kms/key-scope.js";
import { createLocalTenantKmsProvider } from "../rag/kms/local-provider.js";
import {
  decryptTenantBytes,
  encryptTenantBytes,
  ingestJobFileContext,
  ingestJobOutputContext,
  isTenantEnvelope,
} from "../rag/tenant-encryption.js";
import { createTenantLifecycleService } from "../rag/tenant-lifecycle.js";
import { isWorkingFileEnvelope, readWorkingFile } from "../rag/working-files.js";
import { parseTenantKeysArgs, runTenantKeysCommand } from "../tenant-keys.mjs";
import {
  claimUploadSessionFinalization,
  configureUploadSessionDirectory,
  finalizeUploadSession,
  initializeUploadSession,
  storeUploadChunk,
} from "../upload-session-store.js";

const MARKER = "quokka-marker-91c2";
const PDF = Buffer.from(`%PDF-1.4 ${MARKER} ${"body text ".repeat(50)}`);
const ANN = Object.freeze({ userId: "ann", workspaceId: "acme" });

let tempRoot;
let kms;
let previousEncryption;

const containsMarker = (bytes) => Buffer.from(bytes).includes(Buffer.from(MARKER));

const listFiles = async (directory) => {
  const found = [];

  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      found.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }

  return found;
};

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-encryption-stores-"));
  kms = createLocalTenantKmsProvider({
    keystoreDirectory: path.join(tempRoot, "keystore"),
    masterKeyFile: path.join(tempRoot, "master.key"),
  });
  configureTenantKmsProvider(kms);
  previousEncryption = process.env.TENANT_ENCRYPTION;
  process.env.TENANT_ENCRYPTION = "on";
});

after(async () => {
  if (previousEncryption === undefined) {
    delete process.env.TENANT_ENCRYPTION;
  } else {
    process.env.TENANT_ENCRYPTION = previousEncryption;
  }

  resetTenantKmsProvider();
  await rm(tempRoot, { force: true, recursive: true });
});

test("file-backed registry: the stored file is an envelope; getFile and the export see plaintext", async () => {
  const directory = await mkdtemp(path.join(tempRoot, "file-registry-"));
  const store = createFileDocumentRegistryStore({
    getDocumentsDirectory: () => path.join(directory, "documents"),
    getRegistryFilePath: () => path.join(directory, "documents.json"),
  });

  await store.upsert({ docId: "doc-a", fileBuffer: PDF, fileName: "a.pdf", ownerUserId: "ann", workspaceId: "acme" });
  await store.upsert({ docId: "doc-b", fileBuffer: PDF, fileName: "b.pdf", ownerUserId: "bob", workspaceId: "globex" });

  const storedPath = path.join(directory, "documents", "doc-a", "file");
  const stored = await readFile(storedPath);

  assert.ok(isTenantEnvelope(stored));
  assert.ok(!containsMarker(stored));

  const file = await store.getFile("doc-a", ANN);

  assert.deepEqual(file.fileBuffer, PDF);
  assert.equal(file.document.contentSha256, createHash("sha256").update(PDF).digest("hex"), "the plaintext's hash");
  assert.equal(file.fileSize, PDF.length, "the plaintext's size");

  const exported = await store.listTenantRecords({ userId: null, workspaceId: "acme" });

  assert.deepEqual(exported.map((entry) => entry.record.fileBytes), [PDF]);

  // Another tenant's file copied over this one fails closed.
  await copyFile(path.join(directory, "documents", "doc-b", "file"), storedPath);
  await assert.rejects(store.getFile("doc-a", ANN), { code: CODES.envelopeKeyMismatch });
});

test("upload sessions: chunk files are envelopes, the merged upload is a working file", async () => {
  const sessions = await mkdtemp(path.join(tempRoot, "sessions-"));

  configureUploadSessionDirectory(sessions);

  const chunkSize = 64;
  const totalChunks = Math.ceil(PDF.length / chunkSize);
  const fileId = "upload-1";

  await initializeUploadSession({
    accessScope: ANN,
    chunkSize,
    fileId,
    fileName: "notes.pdf",
    fileSha256: createHash("sha256").update(PDF).digest("hex"),
    fileSize: PDF.length,
    lastModified: 1,
    totalChunks,
  });

  for (let index = 0; index < totalChunks; index += 1) {
    await storeUploadChunk({
      accessScope: ANN,
      chunkBuffer: PDF.subarray(index * chunkSize, (index + 1) * chunkSize),
      chunkIndex: String(index),
      fileId,
      totalChunks: String(totalChunks),
    });
  }

  // Re-sending a chunk compares plaintext, so the same bytes are accepted
  // and other bytes refused.
  await storeUploadChunk({
    accessScope: ANN,
    chunkBuffer: PDF.subarray(0, chunkSize),
    chunkIndex: "0",
    fileId,
    totalChunks: String(totalChunks),
  });
  await assert.rejects(
    storeUploadChunk({
      accessScope: ANN,
      chunkBuffer: Buffer.alloc(chunkSize, 1),
      chunkIndex: "0",
      fileId,
      totalChunks: String(totalChunks),
    }),
    { status: 409 }
  );

  const chunkFiles = (await listFiles(sessions)).filter((file) => /chunk-\d+$/.test(file));

  assert.equal(chunkFiles.length, totalChunks);

  for (const chunkFile of chunkFiles) {
    const bytes = await readFile(chunkFile);

    assert.ok(isTenantEnvelope(bytes), `${path.basename(chunkFile)} is an envelope`);
    assert.ok(!containsMarker(bytes));
  }

  const claim = await claimUploadSessionFinalization({ accessScope: ANN, fileId });
  const destinationPath = path.join(tempRoot, "merged.pdf");
  const finalized = await finalizeUploadSession({
    accessScope: ANN,
    claimToken: claim.claimToken,
    destinationPath,
    fileId,
  });

  assert.equal(finalized.fileSize, PDF.length);
  assert.equal(finalized.sha256, createHash("sha256").update(PDF).digest("hex"));

  const merged = await readFile(destinationPath);

  assert.ok(isWorkingFileEnvelope(merged));
  assert.ok(!containsMarker(merged));
  assert.deepEqual(await readWorkingFile(destinationPath), PDF);
});

test("in-memory ingest store: the attempt file is a working file", async () => {
  const store = createInMemoryIngestJobStore();
  const job = await store.enqueue({ docId: "doc-m", fileBytes: PDF, fileName: "m.pdf", ...{ ownerUserId: "ann", workspaceId: "acme" } });
  const claimed = await store.claim({ leaseMs: 60000, workerId: "w1" });
  const filePath = path.join(tempRoot, "attempt.pdf");

  assert.equal(claimed.jobId, job.jobId);
  assert.equal(
    await store.copyJobFile({ attemptCount: claimed.attemptCount, filePath, jobId: claimed.jobId, workerId: "w1" }),
    true
  );
  assert.ok(isWorkingFileEnvelope(await readFile(filePath)));
  assert.deepEqual(await readWorkingFile(filePath), PDF);
});

// A stand-in for one job row and its outputs, answering the statements the
// PostgreSQL store sends for an attempt.
const createJobDatabase = ({ fileBytes, outputs = {} }) => {
  const calls = [];
  const state = { fileBytes, outputs: new Map(Object.entries(outputs)), owner: { owner_user_id: "ann", workspace_id: "acme" } };
  const fenced = (values) => values[0] === "job-1" && values[1] === "w1" && values[2] === 1;
  const query = async (sql, values = []) => {
    calls.push(sql);

    if (/SELECT owner_user_id, workspace_id FROM jobs_t WHERE/.test(sql)) {
      return { rows: fenced(values) ? [state.owner] : [] };
    }

    if (/octet_length\(file_bytes\) AS size/.test(sql)) {
      return { rows: fenced(values) ? [{ size: state.fileBytes.length }] : [] };
    }

    if (/substring\(file_bytes FROM \$4/.test(sql)) {
      return { rows: [{ part: state.fileBytes.subarray(values[3] - 1, values[3] - 1 + values[4]) }] };
    }

    if (/SELECT job_id FROM jobs_t WHERE/.test(sql)) {
      return { rows: fenced(values) ? [{ job_id: "job-1" }] : [] };
    }

    if (/octet_length\(o\.payload\) AS size/.test(sql)) {
      const payload = state.outputs.get(values[3]);

      return { rows: payload ? [{ size: payload.length }] : [] };
    }

    if (/substring\(o\.payload FROM \$5/.test(sql)) {
      const payload = state.outputs.get(values[3]);

      return { rows: [{ part: payload.subarray(values[4] - 1, values[4] - 1 + values[5]) }] };
    }

    if (/WITH job AS/.test(sql)) {
      if (!fenced(values)) {
        return { rows: [] };
      }

      state.outputs.set(values[6], values[7]);
      return { rows: [{ stage: values[4] }] };
    }

    throw new Error(`Unexpected statement: ${sql}`);
  };

  return { calls, query, state };
};

test("PostgreSQL ingest store: attempt files, stage outputs and their readers", async () => {
  const fence = { attemptCount: 1, jobId: "job-1", workerId: "w1" };
  const sealedFile = await encryptTenantBytes(PDF, ingestJobFileContext({ jobId: "job-1", ...ANN }));
  const database = createJobDatabase({ fileBytes: sealedFile });
  const store = createPostgresIngestJobStore({
    fileReadChunkBytes: 16,
    getTable: () => "jobs_t",
    queryPostgres: database.query,
    runMigrations: async () => {},
  });
  const attemptFile = path.join(tempRoot, "pg-attempt.pdf");

  // The row's envelope, read in 16-byte slices, decrypted with the fenced
  // owner, written as a working file.
  assert.equal(await store.copyJobFile({ ...fence, filePath: attemptFile }), true);
  assert.ok(isWorkingFileEnvelope(await readFile(attemptFile)));
  assert.deepEqual(await readWorkingFile(attemptFile), PDF);
  assert.equal(database.calls.filter((sql) => /SELECT owner_user_id/.test(sql)).length, 1);

  // A row copied from another tenant's job fails, and leaves no file.
  database.state.fileBytes = await encryptTenantBytes(PDF, ingestJobFileContext({ jobId: "job-1", userId: "eve", workspaceId: "evil" }));
  await assert.rejects(store.copyJobFile({ ...fence, filePath: attemptFile }), { code: CODES.envelopeKeyMismatch });
  await assert.rejects(readFile(attemptFile), { code: "ENOENT" });

  // advanceStage seals the output for the job's owner; readOutputs opens it.
  const pages = Buffer.from(JSON.stringify([{ pageNumber: 1, text: MARKER }]));

  assert.equal(
    await store.advanceStage({
      ...fence,
      fromStage: "parse",
      leaseMs: 1000,
      maxAttempts: 3,
      moveDocumentFile: true,
      output: { name: "pages", payload: pages },
      toStage: "chunk",
    }),
    true
  );

  const storedPages = database.state.outputs.get("pages");

  assert.ok(isTenantEnvelope(storedPages));
  assert.ok(!containsMarker(storedPages));
  assert.deepEqual(
    await decryptTenantBytes(storedPages, ingestJobOutputContext({ jobId: "job-1", output: "pages", ...ANN })),
    pages
  );
  assert.deepEqual((await store.readOutputs({ ...fence, outputs: ["pages"] })).pages, pages);

  // An attempt that lost the job writes nothing.
  assert.equal(
    await store.advanceStage({
      ...fence,
      workerId: "stale",
      fromStage: "chunk",
      leaseMs: 1000,
      maxAttempts: 3,
      output: { name: "chunks", payload: Buffer.from("[]") },
      toStage: "embed",
    }),
    false
  );
  assert.equal(database.state.outputs.has("chunks"), false);
});

test("PostgreSQL ingest store with the setting off: no extra statement, plaintext as stored", async () => {
  process.env.TENANT_ENCRYPTION = "off";

  try {
    const database = createJobDatabase({ fileBytes: PDF });
    const store = createPostgresIngestJobStore({
      fileReadChunkBytes: 16,
      getTable: () => "jobs_t",
      queryPostgres: database.query,
      runMigrations: async () => {},
    });
    const fence = { attemptCount: 1, jobId: "job-1", workerId: "w1" };
    const attemptFile = path.join(tempRoot, "pg-plain.pdf");

    assert.equal(await store.copyJobFile({ ...fence, filePath: attemptFile }), true);
    assert.deepEqual(await readFile(attemptFile), PDF);
    assert.equal(database.calls.length, 1 + Math.ceil(PDF.length / 16));

    await store.advanceStage({
      ...fence,
      fromStage: "parse",
      leaseMs: 1000,
      maxAttempts: 3,
      output: { name: "pages", payload: Buffer.from("[]") },
      toStage: "chunk",
    });
    assert.deepEqual(database.state.outputs.get("pages"), Buffer.from("[]"));
    assert.equal(database.calls.filter((sql) => /SELECT owner_user_id/.test(sql)).length, 0);
  } finally {
    process.env.TENANT_ENCRYPTION = "on";
  }
});

test("PostgreSQL registry: upsert stores an envelope, getFile decrypts, delete needs no key", async () => {
  const rows = new Map();
  const query = async (sql, values = []) => {
    if (/INSERT INTO docs_t/.test(sql)) {
      const row = {
        chunk_count: values[5],
        content_sha256: values[11],
        content_version: values[12],
        doc_id: values[0],
        file_bytes: values[4],
        file_name: values[1],
        file_size: values[3],
        mime_type: values[2],
        owner_user_id: values[7],
        page_count: values[6],
        profile: values[9],
        uploaded_at: values[10],
        workspace_id: values[8],
      };

      rows.set(row.doc_id, row);
      return { rows: [row] };
    }

    if (/DELETE FROM docs_t/.test(sql)) {
      const row = rows.get(values[0]);

      rows.delete(values[0]);
      return { rows: row ? [row] : [] };
    }

    if (/FROM docs_t/.test(sql) && /WHERE doc_id = \$1/.test(sql)) {
      return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [] };
    }

    throw new Error(`Unexpected statement: ${sql}`);
  };
  const store = createDocumentRegistryStore({
    getDocumentsTable: () => "docs_t",
    queryPostgres: query,
    runMigrations: async () => {},
  });

  await store.upsert({ docId: "doc-p", fileBuffer: PDF, fileName: "p.pdf", ownerUserId: "ann", workspaceId: "acme" });

  const row = rows.get("doc-p");

  assert.ok(isTenantEnvelope(row.file_bytes));
  assert.ok(!containsMarker(row.file_bytes));
  assert.equal(row.content_sha256, createHash("sha256").update(PDF).digest("hex"));
  assert.equal(row.file_size, PDF.length);
  assert.deepEqual((await store.getFile("doc-p", ANN)).fileBuffer, PDF);

  await kms.destroyKey(resolveTenantKeyScope(ANN).keyId);
  await assert.rejects(store.getFile("doc-p", ANN), { code: CODES.keyDestroyed });
  assert.equal((await store.delete("doc-p", ANN)).docId, "doc-p", "a destroyed key does not block a delete");
});

const createEraseHarness = ({ failingStore = false } = {}) => {
  const events = [];
  const service = createTenantLifecycleService({
    adminAuditService: {
      async recordTenantLifecycleEvent(event) {
        events.push(event);
      },
    },
    claimJudge: null,
    documents: null,
    logger: { error() {} },
    longMemory: () => ({ status: "not_configured", store: null }),
    semanticCache: null,
    sessionMemory: () => ({ status: "not_configured", store: null }),
    taskStore: failingStore
      ? {
          countTenantRecords: async () => ({ tasks: { active: 0, records: 1 } }),
          deleteTenantRecords: async () => {
            throw Object.assign(new Error("down"), { code: "STORE_DOWN" });
          },
        }
      : null,
    tenantRegistry: null,
    tenantUsageStore: null,
  });

  return { events, service };
};

test("tenant erase: a workspace erase destroys the workspace key after the rows", async () => {
  const context = ingestJobFileContext({ jobId: "job-w", userId: "carol", workspaceId: "erase-me" });
  const sealed = await encryptTenantBytes(PDF, context);
  const keyId = resolveTenantKeyScope({ workspaceId: "erase-me" }).keyId;
  const { events, service } = createEraseHarness();

  const preview = await service.eraseTenant({ workspaceId: "erase-me" });

  assert.equal(preview.tenantKeys.status, "dry_run");
  assert.deepEqual(preview.tenantKeys.destroy, [{ keyId, scope: "workspace", state: "active", versions: [1] }]);
  assert.equal((await kms.describeKey(keyId)).state, "active", "a dry run destroys nothing");

  const erased = await service.eraseTenant({ dryRun: false, workspaceId: "erase-me" });

  assert.equal(erased.tenantKeys.status, "destroyed");
  assert.deepEqual(erased.tenantKeys.destroyed, [
    { destroyedVersions: [1], existed: true, keyId, scope: "workspace" },
  ]);
  await assert.rejects(decryptTenantBytes(sealed, context), { code: CODES.keyDestroyed });
  assert.deepEqual(events.at(-1).details.tenantKeys, {
    destroyed: [{ keyId, versions: [1] }],
    kept: [],
    status: "destroyed",
  });
  assert.ok(!JSON.stringify(events).includes("wrappedKey"));

  // Run again: nothing left to destroy, still complete for the key step.
  const again = await service.eraseTenant({ dryRun: false, workspaceId: "erase-me" });

  assert.deepEqual(again.tenantKeys.destroyed, [{ destroyedVersions: [], existed: true, keyId, scope: "workspace" }]);
});

test("tenant erase: one member of a workspace keeps the shared key; a personal tenant loses its own", async () => {
  const shared = ingestJobFileContext({ jobId: "job-s", userId: "dave", workspaceId: "shared-ws" });
  const sharedSealed = await encryptTenantBytes(PDF, shared);
  const personal = ingestJobFileContext({ jobId: "job-u", userId: "dave" });
  const personalSealed = await encryptTenantBytes(PDF, personal);
  const { service } = createEraseHarness();

  const member = await service.eraseTenant({ dryRun: false, userId: "dave", workspaceId: "shared-ws" });

  assert.equal(member.tenantKeys.status, "destroyed");
  assert.deepEqual(member.tenantKeys.destroyed, []);
  assert.deepEqual(
    member.tenantKeys.kept.map((key) => [key.keyId, key.scope]),
    [[resolveTenantKeyScope({ workspaceId: "shared-ws" }).keyId, "workspace"]]
  );
  assert.deepEqual(await decryptTenantBytes(sharedSealed, shared), PDF, "the workspace's other members still read");

  const user = await service.eraseTenant({ dryRun: false, userId: "dave" });

  assert.deepEqual(user.tenantKeys.destroyed.map((key) => key.scope), ["user"]);
  await assert.rejects(decryptTenantBytes(personalSealed, personal), { code: CODES.keyDestroyed });
  assert.deepEqual(await decryptTenantBytes(sharedSealed, shared), PDF);
});

test("tenant erase: a failed store keeps the key; without encryption or keys there is no key step", async () => {
  const context = ingestJobFileContext({ jobId: "job-f", userId: "erin", workspaceId: "failing-ws" });
  const sealed = await encryptTenantBytes(PDF, context);
  const failing = createEraseHarness({ failingStore: true });
  const failed = await failing.service.eraseTenant({ dryRun: false, force: true, workspaceId: "failing-ws" });

  assert.equal(failed.status, "failed");
  assert.equal(failed.tenantKeys.status, "not_attempted");
  assert.deepEqual(await decryptTenantBytes(sealed, context), PDF, "the rerun destroys it");

  process.env.TENANT_ENCRYPTION = "off";

  try {
    const { service } = createEraseHarness();
    const untouched = await service.eraseTenant({ dryRun: false, workspaceId: "never-encrypted" });

    assert.equal("tenantKeys" in untouched, false, "the result keeps its shape");

    // Keys on file still go, even with the setting off now.
    const later = await service.eraseTenant({ dryRun: false, workspaceId: "failing-ws" });

    assert.equal(later.tenantKeys.status, "destroyed");
    await assert.rejects(decryptTenantBytes(sealed, context), { code: CODES.keyDestroyed });
  } finally {
    process.env.TENANT_ENCRYPTION = "on";
  }
});

test("health: checks.tenantEncryption appears only with the setting on, after every other check", async () => {
  const { buildHealthReport } = await import("../health.js");
  const withRole = async (role, callback) => {
    const previousRole = process.env.ARCHIVE_RAG_ROLE;

    if (role === undefined) {
      delete process.env.ARCHIVE_RAG_ROLE;
    } else {
      process.env.ARCHIVE_RAG_ROLE = role;
    }

    try {
      return await callback();
    } finally {
      if (previousRole === undefined) {
        delete process.env.ARCHIVE_RAG_ROLE;
      } else {
        process.env.ARCHIVE_RAG_ROLE = previousRole;
      }
    }
  };

  const on = await withRole(undefined, () => buildHealthReport());

  process.env.TENANT_ENCRYPTION = "off";

  let off;

  try {
    off = await withRole(undefined, () => buildHealthReport());
  } finally {
    process.env.TENANT_ENCRYPTION = "on";
  }

  assert.equal("tenantEncryption" in off.checks, false);
  assert.deepEqual(Object.keys(on.checks), [...Object.keys(off.checks), "tenantEncryption"]);
  assert.equal(on.checks.tenantEncryption.status, "ok");
  assert.equal(on.checks.tenantEncryption.mode, "on");
  assert.equal(on.checks.tenantEncryption.keystore.state, "ok");
  assert.equal(on.checks.tenantEncryption.masterKey.state, "ok");

  // A tier that holds no tenant files never reports it.
  const gateway = await withRole("model-gateway", () => buildHealthReport());

  assert.equal("tenantEncryption" in gateway.checks, false);

  // A master key other users can read is an error.
  const { chmod } = await import("node:fs/promises");

  if (process.platform !== "win32") {
    await chmod(kms.masterKeyFile, 0o644);

    try {
      const exposed = await withRole(undefined, () => buildHealthReport());

      assert.equal(exposed.checks.tenantEncryption.status, "error");
      assert.equal(exposed.status, "error");
    } finally {
      await chmod(kms.masterKeyFile, 0o600);
    }
  }
});

test("tenant:keys parses its scopes strictly and refuses destroy without --apply", async () => {
  assert.throws(() => parseTenantKeysArgs(["rotate"]), /needs a key/);
  assert.throws(() => parseTenantKeysArgs(["destroy", "--workspace", "a", "--user", "b"]), /Name one key/);
  assert.throws(() => parseTenantKeysArgs(["rewrap", "--workspace", "a"]), /takes no scope/);
  assert.throws(() => parseTenantKeysArgs(["status", "--user", ""]), /non-empty/);
  assert.throws(() => parseTenantKeysArgs(["status", "--apply"]), /only reads/);
  assert.throws(() => parseTenantKeysArgs(["encrypt-existing", "--batch-size", "0"]), /batch-size/);

  const output = [];
  const deps = {
    countFiles: async () => ({ documents: { encrypted: 1, plaintext: 0 } }),
    databaseConfigured: true,
    encryptExisting: async ({ apply }) => ({ apply, mode: "encrypt", tables: { documents: { changed: 0, failed: 0 } } }),
    encryptionMode: "off",
    kms,
    resolveScope: resolveTenantKeyScope,
    rewrap: async ({ apply }) => ({ apply, mode: "rewrap", tables: {} }),
  };
  const run = (argv) =>
    runTenantKeysCommand(argv, { loadDependencies: async () => deps, write: (text) => output.push(text) });
  const keyId = resolveTenantKeyScope({ workspaceId: "cli-ws" }).keyId;

  await kms.getOrCreateKey(resolveTenantKeyScope({ workspaceId: "cli-ws" }));

  const refused = await run(["destroy", "--workspace", "cli-ws"]);

  assert.equal(refused.exitCode, 2);
  assert.equal(refused.result.refused, true);
  assert.equal((await kms.describeKey(keyId)).state, "active");

  const rotatePreview = await run(["rotate", "--workspace", "cli-ws"]);

  assert.equal(rotatePreview.result.dryRun, true);
  assert.equal((await kms.describeKey(keyId)).currentVersion, 1);
  assert.equal((await run(["rotate", "--workspace", "cli-ws", "--apply"])).result.version, 2);
  assert.equal((await run(["encrypt-existing", "--apply"])).exitCode, 2, "refused while TENANT_ENCRYPTION is off");
  assert.equal((await run(["encrypt-existing"])).exitCode, 0, "a dry run is allowed");

  const status = await run(["status", "--json"]);

  assert.equal(status.exitCode, 0);
  assert.ok(status.result.keys.some((key) => key.keyId === keyId && key.currentVersion === 2));
  assert.equal((await run(["destroy", "--workspace", "cli-ws", "--apply"])).result.destroyedVersions.length, 2);
  assert.ok(!output.join("").includes("wrappedKey"));
});
