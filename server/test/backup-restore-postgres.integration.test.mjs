import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";

// The backup and restore drill (scripts/backup-postgres.sh,
// restore-postgres.sh, verify-backup.sh; server/backup-tools.mjs) on a real
// PostgreSQL with pgvector:
//
// * a source database is migrated by the real migrations and seeded with two
//   tenants' documents (one in the trash, migration 042) and admin audit
//   events (hash chains, migration 041);
// * backup-postgres.sh dumps it and writes a manifest whose counts, migrations,
//   tenants and audit chain heads match the source, and whose checksum
//   matches the dump; the manifest holds no credential;
// * restore-postgres.sh restores into an empty database as a non-superuser
//   owner, refuses a non-empty target without --force (exit 3) and a dump
//   that no longer matches its checksum;
// * verify-backup.sh restores into another empty database and passes every
//   check: migrations, row and tenant counts, the health report's
//   rowLevelSecurity entry and the audit chains;
// * the verify step fails (exit 1) when a restored row is missing or an
//   audit row was changed, checks the dump and files archive next to the
//   manifest, and with --allow-pending-migrations never migrates the
//   restored database;
// * every file a backup writes is 0600 and the --out directory it creates
//   0700; --with-files leaves local KMS key material out by path (flags,
//   variables) and by content, and the manifest names what it found.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one), and the scripts find
// pg_dump and pg_restore at the server's major version or newer (the drill in
// a disposable cluster also needs initdb with pgvector next to them);
// otherwise it is reported as skipped, never as passed. Every database and
// role it creates is dropped afterwards.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();
const SERVER_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MODEL = "backup-it-embed";
const DIMENSIONS = 3;
const ALICE = Object.freeze({ userId: "alice", workspaceId: "ws-a" });
const BOB = Object.freeze({ userId: "bob", workspaceId: "ws-b" });

const embeddingProvider = {
  completeText: async () => "unused [Source 1]",
  embedQuery: async () => [1, 0, 0.1],
  embedTexts: async (texts) => texts.map((text) => [text.length % 7, 1, 0.1]),
};

// The scripts get only what a shell would give them, never this process's
// database settings, so a script cannot read the source through an inherited
// POSTGRES_DATABASE_URL by accident.
const scriptEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("POSTGRES_") && !key.startsWith("PG") && key !== "LONG_MEMORY_DATABASE_URL"
    )
  );

const runScript = (command, args, { env = {} } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: SERVER_DIRECTORY,
      env: { ...scriptEnvironment(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });

// The client binaries the scripts would use (scripts/backup-common.sh finds
// them), and whether they can serve this server.
const describeClientTools = async () => {
  const located = spawnSync(
    "bash",
    ["-c", 'source scripts/backup-common.sh && printf "%s" "$PG_BIN_DIR_RESOLVED"'],
    { cwd: SERVER_DIRECTORY, encoding: "utf8" }
  );
  const binDirectory = located.status === 0 ? located.stdout.trim() : "";

  if (!binDirectory || !existsSync(path.join(binDirectory, "pg_restore"))) {
    return { skip: "pg_dump / pg_restore were not found (set PG_BIN_DIR)" };
  }

  const dumpMajor = Number(
    /(\d+)(?:\.\d+)?/.exec(spawnSync(path.join(binDirectory, "pg_dump"), ["--version"], { encoding: "utf8" }).stdout)?.[1]
  );
  const client = new pg.Client({ connectionString: adminDatabaseUrl });

  await client.connect();

  const serverMajor = Math.floor(Number((await client.query("SHOW server_version_num")).rows[0].server_version_num) / 10000);

  await client.end();

  if (!(dumpMajor >= serverMajor)) {
    return { skip: `pg_dump ${dumpMajor} is older than the server (${serverMajor})` };
  }

  const shareDirectory = [path.join(binDirectory, "..", "share", "postgresql"), path.join(binDirectory, "..", "share")].find(
    (directory) => existsSync(path.join(directory, "extension", "vector.control"))
  );

  return {
    drillSkip:
      existsSync(path.join(binDirectory, "initdb")) && shareDirectory
        ? false
        : "no initdb with pgvector next to pg_dump, so verify-backup.sh cannot bring up its own cluster",
    skip: false,
  };
};

const clientTools = adminDatabaseUrl ? await describeClientTools() : { drillSkip: true, skip: true };

if (!adminDatabaseUrl || clientTools.skip) {
  test("backup and restore PostgreSQL integration suite", {
    skip: adminDatabaseUrl
      ? clientTools.skip
      : "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `backup_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `backup_it_tenant_${suffix}`;
  const systemRole = `backup_it_system_${suffix}`;
  const sourceDatabase = `backup_it_source_${suffix}`;
  const restoredDatabase = `backup_it_restored_${suffix}`;
  const drillDatabase = `backup_it_drill_${suffix}`;
  const withDatabase = (url, name, { password, user } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const ownerUrl = (name) => withDatabase(adminDatabaseUrl, name, { password: ownerPassword, user: ownerRole });
  const adminQuery = async (url, sql, values = []) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(sql, values);
    } finally {
      await client.end();
    }
  };

  const originalEnv = new Map();
  let modules;
  let tempRoot;
  let backup;

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "backup-it-"));

    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);

    for (const name of [sourceDatabase, restoredDatabase, drillDatabase]) {
      await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${name} OWNER ${ownerRole}`);
      // pgvector needs a superuser to install; the restore finds it there.
      await adminQuery(withDatabase(adminDatabaseUrl, name), "CREATE EXTENSION IF NOT EXISTS vector");
    }

    for (const [key, value] of Object.entries({
      LONG_MEMORY_DATABASE_URL: "",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "backup-it-key",
      OPENAI_EMBEDDING_MODEL: MODEL,
      PDF_PARSER: "pdfjs",
      POSTGRES_DATABASE_URL: ownerUrl(sourceDatabase),
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_SYSTEM_ROLE: systemRole,
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_DATA_DIRECTORY: tempRoot,
      RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      VECTOR_STORE_PROVIDER: "pgvector",
    })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }

    const [config, postgres, tenant, migrations, registry, rag, openai, vectorStore, auditStores] = await Promise.all([
      import("../rag/config.js"),
      import("../rag/postgres.js"),
      import("../rag/postgres-tenant.js"),
      import("../rag/db-migrations.js"),
      import("../rag/doc-registry.js"),
      import("../rag/index.js"),
      import("../rag/openai.js"),
      import("../rag/vector-store.js"),
      import("../rag/admin-audit-store.js"),
    ]);

    modules = { config, openai, postgres, registry, vectorStore };
    config.configureEmbeddingDimensions(DIMENSIONS);
    openai.configureOpenAIProvider(embeddingProvider);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    vectorStore.resetVectorStore();
    await migrations.runPostgresMigrations();
    await registry.initializeDocumentRegistry();

    const ingest = async (scope, docId, text) => {
      const filePath = path.join(tempRoot, `${docId}.pdf`);

      await writeFile(filePath, buildTextPdf({ pages: [[text]] }));
      await tenant.runWithDatabaseTenant(scope, () =>
        rag.ingestDocument({
          docId,
          fileName: `${docId}.pdf`,
          filePath,
          ownerUserId: scope.userId,
          workspaceId: scope.workspaceId,
        })
      );
    };

    await ingest(ALICE, "doc-a1", "Alice keeps the alpha policy.");
    await ingest(ALICE, "doc-a2", "Alice keeps the gamma policy.");
    await ingest(BOB, "doc-b1", "Bob keeps the beta policy.");

    // One document in the trash: the manifest counts it apart.
    process.env.DOCUMENT_TRASH_RETENTION_HOURS = "24";

    try {
      await tenant.runWithDatabaseTenant(ALICE, () => rag.deleteDocument("doc-a2", { accessScope: ALICE }));
    } finally {
      delete process.env.DOCUMENT_TRASH_RETENTION_HOURS;
    }

    const audit = auditStores.createDefaultAdminAuditService();

    for (const scope of [ALICE, BOB, ALICE]) {
      await tenant.runWithDatabaseTenant(scope, () =>
        audit.recordAuthorizationDecision({
          accessScope: scope,
          decision: { allowed: true, permissionId: "admin.status.read" },
          request: { method: "GET", path: "/admin/status" },
        })
      );
    }

    await registry.resetDocumentRegistryStore();
    await postgres.resetPostgresPool();
  });

  after(async () => {
    try {
      modules?.openai.resetOpenAIProvider();
      modules?.config.configureEmbeddingDimensions(null);
      modules?.vectorStore.resetVectorStore();
      await modules?.registry.resetDocumentRegistryStore();
      await modules?.postgres.resetPostgresPool();
    } finally {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      for (const name of [sourceDatabase, restoredDatabase, drillDatabase]) {
        await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }

      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${systemRole}`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("backup-postgres.sh writes a dump and a manifest that describe the source exactly", async () => {
    const result = await runScript("bash", [
      "scripts/backup-postgres.sh",
      "--database-url",
      ownerUrl(sourceDatabase),
      "--out",
      path.join(tempRoot, "backups"),
      "--name",
      "drill",
    ]);

    assert.equal(result.code, 0, result.stderr);
    backup = JSON.parse(result.stdout);

    const manifestText = await readFile(backup.manifest, "utf8");
    const manifest = JSON.parse(manifestText);
    const source = new pg.Client({ connectionString: ownerUrl(sourceDatabase) });

    await source.connect();

    try {
      const migrations = (await source.query("SELECT id FROM schema_migrations ORDER BY id")).rows.map((row) => row.id);

      assert.deepEqual(manifest.migrations, migrations);
      assert.ok(manifest.migrations.includes("042_add_document_trash.sql"));
      assert.equal(
        manifest.tables.rag_documents,
        Number((await source.query("SELECT COUNT(*)::int AS n FROM rag_documents")).rows[0].n)
      );
      assert.equal(
        manifest.tables.rag_admin_audit_events,
        Number((await source.query("SELECT COUNT(*)::int AS n FROM rag_admin_audit_events")).rows[0].n)
      );
    } finally {
      await source.end();
    }

    assert.deepEqual(
      manifest.tenants.map(({ documents, ownerUserId, trashedDocuments, workspaceId }) => ({
        documents,
        ownerUserId,
        trashedDocuments,
        workspaceId,
      })),
      [
        { documents: 1, ownerUserId: "alice", trashedDocuments: 1, workspaceId: "ws-a" },
        { documents: 1, ownerUserId: "bob", trashedDocuments: 0, workspaceId: "ws-b" },
      ]
    );
    assert.deepEqual(
      manifest.auditChains.map((chain) => chain.workspaceId).sort(),
      ["ws-a", "ws-b"]
    );
    assert.equal(manifest.roles.tenant, tenantRole);
    assert.equal(manifest.roles.system, systemRole);
    assert.equal(manifest.dump.sha256.length, 64);
    assert.equal(manifest.database.database, sourceDatabase);
    assert.equal(manifestText.includes(ownerPassword), false, "no credential in the manifest");
    assert.equal(manifestText.includes(ownerRole), false, "not even the login's name");

    // Only this login reads what a backup writes, whatever the umask.
    const modeOf = async (target) => (await stat(target)).mode & 0o777;

    assert.equal(await modeOf(path.join(tempRoot, "backups")), 0o700, "the --out directory it created");
    assert.equal(await modeOf(backup.dump), 0o600);
    assert.equal(await modeOf(backup.manifest), 0o600);
  });

  test("--with-files archives the state outside PostgreSQL and leaves the tenant keystore and master key out", async () => {
    const root = path.join(tempRoot, "server-state");
    const keystore = path.join(root, "data", "tenant-keystore");

    await mkdir(path.join(root, "uploads"), { recursive: true });
    await mkdir(path.join(root, "upload-sessions", "session-1"), { recursive: true });
    await mkdir(keystore, { recursive: true });
    await writeFile(path.join(root, "uploads", "upload.pdf"), "%PDF-1.4 upload");
    await writeFile(path.join(root, "upload-sessions", "session-1", "manifest.json"), "{}");
    await writeFile(path.join(root, "data", "documents.json"), "[]");
    await writeFile(path.join(keystore, "ws-a.key"), "not a real key");
    // The master key under a configured name (left out by path) and a copy
    // under the default name (left out by name).
    await writeFile(path.join(root, "data", "wrapping.key"), "not a real master key");
    await writeFile(path.join(root, "data", "tenant-kms-master.key"), "not a real master key");
    // A keystore and a master key the flags name (as server/.env would, which
    // the script does not read), under names no pattern knows.
    await mkdir(path.join(root, "data", "vault-by-flag"), { recursive: true });
    await writeFile(path.join(root, "data", "vault-by-flag", "opaque.bin"), "not a real key");
    await writeFile(path.join(root, "uploads", "wrap-by-flag.bin"), "not a real master key");
    // And key material nothing names: a key file, a destroyed key's
    // tombstone and a master key copied anywhere, found by content.
    const keyFileFormat = "archive-rag-local-tenant-key";
    const masterKeyFormat = "archive-rag-local-kms-master-key";

    await mkdir(path.join(root, "data", "copied"), { recursive: true });
    await writeFile(
      path.join(root, "data", "copied", "tk_aaaa.json"),
      JSON.stringify({ format: keyFileFormat, keyId: "tk_aaaa", versions: [{ version: 1, wrappedKey: "S0VZLU1BVEVSSUFM" }] })
    );
    await writeFile(
      path.join(root, "data", "copied", "tk_bbbb.json"),
      JSON.stringify({ currentVersion: null, destroyedThroughVersion: 2, format: keyFileFormat, keyId: "tk_bbbb", versions: [] })
    );
    await writeFile(
      path.join(root, "upload-sessions", "stray.json"),
      JSON.stringify({ format: masterKeyFormat, key: "TUFTVEVSLUtFWS1NQVRFUklBTA==" })
    );

    const result = await runScript(
      "bash",
      [
        "scripts/backup-postgres.sh",
        "--database-url",
        ownerUrl(sourceDatabase),
        "--out",
        path.join(tempRoot, "backups"),
        "--name",
        "with-files",
        "--with-files",
        "--uploads-dir",
        path.join(root, "uploads"),
        "--upload-sessions-dir",
        path.join(root, "upload-sessions"),
        "--data-dir",
        path.join(root, "data"),
      ],
      { env: { TENANT_KEYSTORE_DIR: keystore, TENANT_KMS_MASTER_KEY_FILE: path.join(root, "data", "wrapping.key") } }
    );

    assert.equal(result.code, 0, result.stderr);

    const manifestText = await readFile(JSON.parse(result.stdout).manifest, "utf8");
    const manifest = JSON.parse(manifestText);
    const archive = path.join(tempRoot, "backups", manifest.files.file);
    const listing = await runScript("tar", ["-tzf", archive]);
    const members = listing.stdout.split("\n").filter(Boolean);

    assert.equal(listing.code, 0, listing.stderr);
    assert.ok(members.some((member) => member.endsWith("uploads/upload.pdf")), members.join(", "));
    assert.ok(members.some((member) => member.endsWith("upload-sessions/session-1/manifest.json")));
    assert.ok(members.some((member) => member.endsWith("data/documents.json")));
    assert.equal(members.some((member) => member.includes("keystore")), false, members.join(", "));
    assert.ok(manifest.files.excluded.includes("data/tenant-keystore"));
    assert.equal(members.some((member) => member.endsWith(".key")), false, members.join(", "));
    assert.ok(manifest.files.excluded.includes("data/wrapping.key"));
    assert.equal(manifest.files.sha256.length, 64);
    assert.deepEqual(
      manifest.files.keyMaterialExcluded,
      [
        { file: "data/copied/tk_aaaa.json", format: keyFileFormat },
        { file: "data/copied/tk_bbbb.json", format: keyFileFormat },
        { file: "upload-sessions/stray.json", format: masterKeyFormat },
      ],
      "found by content, listed by path and format"
    );
    assert.equal(members.some((member) => member.includes("copied/tk_")), false, members.join(", "));
    assert.equal(members.some((member) => member.endsWith("stray.json")), false, members.join(", "));
    assert.ok(members.some((member) => member.endsWith("data/vault-by-flag/opaque.bin")), "no flag yet: archived");
    assert.equal(manifestText.includes("S0VZLU1BVEVSSUFM") || manifestText.includes("TUFTVEVS"), false, "no key material");
    assert.equal((await stat(archive)).mode & 0o777, 0o600);

    // The flags name a keystore and a master key the shell's variables do not.
    const flagged = await runScript("bash", [
      "scripts/backup-postgres.sh",
      "--database-url",
      ownerUrl(sourceDatabase),
      "--out",
      path.join(tempRoot, "backups"),
      "--name",
      "with-files-flags",
      "--with-files",
      "--uploads-dir",
      path.join(root, "uploads"),
      "--upload-sessions-dir",
      path.join(root, "upload-sessions"),
      "--data-dir",
      path.join(root, "data"),
      "--keystore-dir",
      path.join(root, "data", "vault-by-flag"),
      "--kms-master-key-file",
      path.join(root, "uploads", "wrap-by-flag.bin"),
    ]);

    assert.equal(flagged.code, 0, flagged.stderr);

    const flaggedManifest = JSON.parse(await readFile(JSON.parse(flagged.stdout).manifest, "utf8"));
    const flaggedMembers = (await runScript("tar", ["-tzf", path.join(tempRoot, "backups", flaggedManifest.files.file)])).stdout
      .split("\n")
      .filter(Boolean);

    assert.ok(flaggedManifest.files.excluded.includes("data/vault-by-flag"));
    assert.ok(flaggedManifest.files.excluded.includes("uploads/wrap-by-flag.bin"));
    assert.equal(flaggedMembers.some((member) => member.includes("by-flag")), false, flaggedMembers.join(", "));
    assert.ok(flaggedMembers.some((member) => member.endsWith("uploads/upload.pdf")));
  });

  test("restore-postgres.sh restores into an empty database and refuses a non-empty one", async () => {
    const restore = await runScript("bash", [
      "scripts/restore-postgres.sh",
      "--database-url",
      ownerUrl(restoredDatabase),
      "--dump",
      backup.dump,
    ]);

    assert.equal(restore.code, 0, restore.stderr);
    assert.match(restore.stderr, /\[restore\] target: /);
    assert.equal(restore.stderr.includes(ownerPassword), false);

    const again = await runScript("bash", [
      "scripts/restore-postgres.sh",
      "--database-url",
      ownerUrl(restoredDatabase),
      "--dump",
      backup.dump,
    ]);

    assert.equal(again.code, 3, again.stderr);
    assert.match(again.stderr, /refusing to restore into it/);

    const restored = await adminQuery(ownerUrl(restoredDatabase), "SELECT doc_id, deleted_at FROM rag_documents ORDER BY doc_id");

    assert.deepEqual(
      restored.rows.map((row) => [row.doc_id, row.deleted_at !== null]),
      [
        ["doc-a1", false],
        ["doc-a2", true],
        ["doc-b1", false],
      ]
    );
    assert.equal(
      (await adminQuery(ownerUrl(restoredDatabase), "SELECT tableowner FROM pg_tables WHERE tablename = 'rag_documents'"))
        .rows[0].tableowner,
      ownerRole,
      "owned by the restoring login"
    );
  });

  test("a dump that no longer matches its manifest is not restored", async () => {
    const tampered = path.join(tempRoot, "backups", "tampered.dump");
    const bytes = await readFile(backup.dump);

    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(tampered, bytes);

    const refused = await runScript("bash", [
      "scripts/restore-postgres.sh",
      "--database-url",
      ownerUrl(drillDatabase),
      "--dump",
      tampered,
      "--manifest",
      backup.manifest,
    ]);

    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /does not match its manifest/);
  });

  test("verify-backup.sh restores into an empty database and every check passes", async () => {
    const drill = await runScript("bash", [
      "scripts/verify-backup.sh",
      "--dump",
      backup.dump,
      "--database-url",
      ownerUrl(drillDatabase),
    ]);

    assert.equal(drill.code, 0, `${drill.stderr}\n${drill.stdout}`);

    const report = JSON.parse(drill.stdout.slice(drill.stdout.indexOf("{")));

    assert.equal(report.ok, true);
    assert.deepEqual(Object.keys(report.checks).sort(), [
      "auditChains",
      "dumpChecksum",
      "migrations",
      "rowCounts",
      "rowLevelSecurity",
      "tenantDocuments",
    ]);
    assert.equal(report.checks.rowLevelSecurity.status, "ok", report.checks.rowLevelSecurity.message);
    assert.equal(report.checks.auditChains.chains, 2);
    assert.deepEqual(report.checks.migrations.pending, []);
  });

  test("verify checks the dump and the files archive it finds next to the manifest", async () => {
    // The --with-files backup of the same source (nothing changed it since
    // the drill's dump), verified against the drill's restored database.
    const directory = path.join(tempRoot, "backups");
    const manifestPath = path.join(directory, "with-files.manifest.json");
    const verify = (manifest) =>
      runScript(process.execPath, [
        "backup-tools.mjs",
        "verify",
        "--database-url",
        ownerUrl(drillDatabase),
        "--manifest",
        manifest,
      ]);

    let result = await verify(manifestPath);
    let report = JSON.parse(result.stdout);

    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(report.checks.dumpChecksum.ok, true);
    assert.equal(report.checks.dumpChecksum.file, "with-files.dump");
    assert.equal(report.checks.filesChecksum.ok, true);

    // A copy whose files archive changed after the manifest was written.
    const copy = path.join(tempRoot, "backups-tampered");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    await mkdir(copy, { recursive: true });
    await copyFile(manifestPath, path.join(copy, "with-files.manifest.json"));
    await copyFile(path.join(directory, manifest.dump.file), path.join(copy, manifest.dump.file));

    const archive = await readFile(path.join(directory, manifest.files.file));

    archive[archive.length - 1] ^= 0xff;
    await writeFile(path.join(copy, manifest.files.file), archive);
    result = await verify(path.join(copy, "with-files.manifest.json"));
    report = JSON.parse(result.stdout);

    assert.equal(result.code, 1);
    assert.equal(report.checks.filesChecksum.ok, false);
    assert.equal(report.checks.dumpChecksum.ok, true);
  });

  test("verify --allow-pending-migrations never migrates the restored database", async () => {
    // A backup taken before the newest migration, restored under the newer
    // code: the drill database without its newest schema_migrations row, and
    // a manifest that says so.
    const manifest = JSON.parse(await readFile(backup.manifest, "utf8"));
    const newest = manifest.migrations.at(-1);
    const older = {
      ...manifest,
      migrations: manifest.migrations.slice(0, -1),
      tables: { ...manifest.tables, schema_migrations: manifest.tables.schema_migrations - 1 },
    };
    const olderPath = path.join(tempRoot, "older.manifest.json");

    await writeFile(olderPath, JSON.stringify(older));
    await adminQuery(ownerUrl(drillDatabase), "DELETE FROM schema_migrations WHERE id = $1", [newest]);

    const result = await runScript(process.execPath, [
      "backup-tools.mjs",
      "verify",
      "--database-url",
      ownerUrl(drillDatabase),
      "--manifest",
      olderPath,
      "--allow-pending-migrations",
    ]);
    const report = JSON.parse(result.stdout);

    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.deepEqual(report.checks.migrations.pending, [newest]);
    assert.equal(report.checks.rowLevelSecurity.skipped, "pending_migrations");
    assert.equal(report.checks.auditChains.ok, true);
    assert.equal(
      (await adminQuery(ownerUrl(drillDatabase), "SELECT COUNT(*)::int AS n FROM schema_migrations WHERE id = $1", [newest]))
        .rows[0].n,
      0,
      "the pending migration was not applied"
    );
  });

  // The drill as an operator runs it: no database named, so the script brings
  // up its own throwaway cluster (unix socket only, trust inside a 0700
  // directory, no password anywhere) and removes it afterwards.
  test("verify-backup.sh passes in a disposable cluster of its own and removes it", { skip: clientTools.drillSkip }, async () => {
    const drillTemp = await mkdtemp(path.join(os.tmpdir(), "verify-drill-"));

    try {
      const drill = await runScript("bash", ["scripts/verify-backup.sh", "--dump", backup.dump], {
        env: { TMPDIR: drillTemp },
      });

      assert.equal(drill.code, 0, `${drill.stderr}\n${drill.stdout}`);
      assert.equal(JSON.parse(drill.stdout.slice(drill.stdout.indexOf("{"))).ok, true);
      assert.match(drill.stderr, /disposable cluster in /);

      const { readdir } = await import("node:fs/promises");

      assert.deepEqual(await readdir(drillTemp), [], "the cluster's directory is gone");
    } finally {
      await rm(drillTemp, { force: true, recursive: true });
    }
  });

  test("the verify step fails when a restored row is missing or an audit row was changed", async () => {
    const verify = () =>
      runScript(process.execPath, [
        "backup-tools.mjs",
        "verify",
        "--database-url",
        ownerUrl(restoredDatabase),
        "--manifest",
        backup.manifest,
      ]);

    let result = await verify();

    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);

    await adminQuery(ownerUrl(restoredDatabase), "DELETE FROM rag_documents WHERE doc_id = 'doc-b1'");
    result = await verify();

    let report = JSON.parse(result.stdout);

    assert.equal(result.code, 1);
    assert.equal(report.checks.rowCounts.ok, false);
    assert.equal(report.checks.tenantDocuments.ok, false);
    assert.equal(report.checks.auditChains.ok, true);

    await adminQuery(
      ownerUrl(restoredDatabase),
      "UPDATE rag_admin_audit_events SET path = '/admin/forged' WHERE id = (SELECT MIN(id) FROM rag_admin_audit_events)"
    );
    result = await verify();
    report = JSON.parse(result.stdout);

    assert.equal(result.code, 1);
    assert.equal(report.checks.auditChains.ok, false);
    assert.equal(report.checks.auditChains.status, "broken");
  });
}
