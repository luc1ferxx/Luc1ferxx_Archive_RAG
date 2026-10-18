import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

import { startDevOidcProvider } from "../dev-oidc-provider.mjs";
import { startDemoFakeModel } from "../demo/fake-model.js";
import { createLocalTenantKmsProvider } from "../rag/kms/local-provider.js";
import {
  decryptTenantBytes,
  describeTenantEnvelope,
  documentFileContext,
  isTenantEnvelope,
} from "../rag/tenant-encryption.js";
import {
  createDemoClient,
  DEMO_DOCUMENTS,
  DEMO_PERSONAS,
  DEMO_REDACTION_PROBE,
  DELETED_SOURCE_MARKER,
  demoDocumentsVisibleTo,
  discoverDemoDocuments,
  formatDemoResultTable,
  runDemoWalkthrough,
  seedDemoTenants,
} from "../demo/tenant-demo.js";

// Every tenant-isolation switch at once: `node server.js` started with the
// values of deploy/demo/hardened.env (only the database URLs, the role names,
// the model URL, the ports and the data directories are replaced), on a real
// PostgreSQL with pgvector and the database role split, against the demo's
// fake model. The demo seed and every walkthrough check of demo/tenant-demo.js
// run over HTTP and must pass; then /ready, the health report's row-level
// security and role-split entries, a retention sweep, the audit hash chain
// (audit-verify.mjs as an operator runs it), a real erase of one tenant while
// the other keeps working, the log (no lost tenant context, no permission
// error) and a clean shutdown.
//
// The split logins come from deploy/postgres/create-split-roles.sql, the file
// compose.demo.yml mounts into the postgres service, run with psql when one is
// found (PG_BIN_DIR, PATH or Postgres.app); without psql the same statements
// run through pg. It needs PGVECTOR_TEST_DATABASE_URL (a superuser, as `bash
// scripts/run-pgvector-integration.sh` provisions) and is reported as skipped
// without it, never as passed. Its roles and database are unique to the run
// and dropped afterwards.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!adminDatabaseUrl) {
  test("hardened tenant-isolation profile end to end (node server.js on pgvector)", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryRoot = path.join(serverDirectory, "..");
  const profile = dotenv.parse(readFileSync(path.join(repositoryRoot, "deploy", "demo", "hardened.env"), "utf8"));
  const splitRolesSql = path.join(repositoryRoot, "deploy", "postgres", "create-split-roles.sql");
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `hardened_owner_${suffix}`;
  const runtimeRole = `hardened_app_${suffix}`;
  const tenantRole = `hardened_tenant_${suffix}`;
  const systemRole = `hardened_system_${suffix}`;
  const databaseName = `hardened_e2e_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const runtimePassword = `pw_${randomBytes(12).toString("hex")}`;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "hardened-tenant-e2e-"));
  const emptyEnvironmentFile = path.join(tempRoot, "empty.env");
  const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;

  writeFileSync(emptyEnvironmentFile, "", "utf8");

  const withDatabase = (url, name, { user, password } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const ownerUrl = withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole });
  const runtimeUrl = withDatabase(adminDatabaseUrl, databaseName, { password: runtimePassword, user: runtimeRole });
  const adminQuery = async (url, sql, values) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(sql, values);
    } finally {
      await client.end();
    }
  };
  const inheritedEnvironment = () =>
    Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name)));
  // The database settings of every process that talks to the throwaway
  // database: the profile's split, under this run's role names.
  const databaseEnvironment = {
    POSTGRES_DATABASE_URL: runtimeUrl,
    POSTGRES_MIGRATION_DATABASE_URL: ownerUrl,
    POSTGRES_ROW_LEVEL_SECURITY: profile.POSTGRES_ROW_LEVEL_SECURITY,
    POSTGRES_SYSTEM_ROLE: systemRole,
    POSTGRES_TENANT_CONTEXT: profile.POSTGRES_TENANT_CONTEXT,
    POSTGRES_TENANT_ROLE: tenantRole,
  };
  // TENANT_ENCRYPTION=on (the profile): one keystore and master key for the
  // server and every operator command of the run, as compose.demo.yml gives
  // them one volume. The test reads envelopes with the same local KMS.
  const kmsEnvironment = {
    TENANT_KEYSTORE_DIR: path.join(tempRoot, "tenant-keystore"),
    TENANT_KMS_MASTER_KEY_FILE: path.join(tempRoot, "tenant-kms-master.key"),
  };
  const createTestKms = () =>
    createLocalTenantKmsProvider({
      keystoreDirectory: kmsEnvironment.TENANT_KEYSTORE_DIR,
      masterKeyFile: kmsEnvironment.TENANT_KMS_MASTER_KEY_FILE,
    });
  // Every stored document file, as the owner reads the table.
  const readStoredDocumentFiles = async () =>
    (
      await adminQuery(
        ownerUrl,
        "SELECT doc_id, owner_user_id, workspace_id, file_name, file_bytes FROM rag_documents ORDER BY doc_id"
      )
    ).rows;
  const decryptStoredFile = (row, kms = createTestKms()) =>
    decryptTenantBytes(
      row.file_bytes,
      documentFileContext({ docId: row.doc_id, ownerUserId: row.owner_user_id, workspaceId: row.workspace_id }),
      { kms }
    );

  const findPsql = () => {
    const candidates = [
      process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, "psql") : "",
      "psql",
      ...(existsSync("/Applications/Postgres.app/Contents/Versions")
        ? readdirSync("/Applications/Postgres.app/Contents/Versions")
            .sort()
            .reverse()
            .map((version) => `/Applications/Postgres.app/Contents/Versions/${version}/bin/psql`)
        : []),
    ].filter(Boolean);

    // psql 15 or later: the file reads its passwords with \getenv.
    return (
      candidates.find((candidate) => {
        const version = spawnSync(candidate, ["--version"], { encoding: "utf8" });
        const major = Number(/\bpsql \(PostgreSQL\) (\d+)/u.exec(version.stdout ?? "")?.[1]);

        return version.status === 0 && major >= 15;
      }) ?? null
    );
  };

  // deploy/postgres/create-split-roles.sql, or its statements through pg.
  const createSplitLogins = async () => {
    const psql = findPsql();

    if (psql) {
      const admin = new URL(adminDatabaseUrl);
      const result = spawnSync(
        psql,
        [
          adminDatabaseUrl,
          "-X",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-v",
          `database=${databaseName}`,
          "-v",
          `owner=${ownerRole}`,
          "-v",
          `runtime=${runtimeRole}`,
          "-f",
          splitRolesSql,
        ],
        {
          encoding: "utf8",
          // The passwords come from the environment (\getenv), as the
          // postgres image's init runs the file for compose.demo.yml.
          env: {
            ...inheritedEnvironment(),
            ARCHIVE_RAG_OWNER_PASSWORD: ownerPassword,
            ARCHIVE_RAG_RUNTIME_PASSWORD: runtimePassword,
            PGPASSWORD: decodeURIComponent(admin.password),
          },
        }
      );

      assert.equal(result.status, 0, `create-split-roles.sql failed:\n${result.stdout}\n${result.stderr}`);
      return "psql";
    }

    await adminQuery(
      adminDatabaseUrl,
      `CREATE ROLE ${ownerRole} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB PASSWORD '${ownerPassword}'`
    );
    await adminQuery(
      adminDatabaseUrl,
      `CREATE ROLE ${runtimeRole} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${runtimePassword}'`
    );
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(adminDatabaseUrl, `REVOKE ALL ON DATABASE ${databaseName} FROM PUBLIC`);
    await adminQuery(adminDatabaseUrl, `GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`);

    const databaseUrl = withDatabase(adminDatabaseUrl, databaseName);

    await adminQuery(databaseUrl, "CREATE EXTENSION IF NOT EXISTS vector");
    await adminQuery(databaseUrl, `ALTER SCHEMA public OWNER TO ${ownerRole}`);
    await adminQuery(databaseUrl, "REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await adminQuery(databaseUrl, `GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    return "pg";
  };

  let modelServer = null;
  let monolith = null;
  let client = null;
  let walkthrough = [];
  let idp = null;
  let splitLoginsVia = "";

  // An OIDC identity next to the static tokens (the profile configures no
  // IdP, so API_AUTH_OIDC_ALLOW_PLATFORM_ROLES=false only matters with one):
  // the dev IdP (development and tests only) issues olivia a token whose
  // claims ask for admin.owner and name no workspace.
  const OIDC_REDIRECT_URI = "http://127.0.0.1:3000/";
  const OIDC_USERS = [
    {
      claims: { permissions: ["admin.tenants.erase", "admin.tenants.export"], roles: ["admin.owner"] },
      email: "olivia@example.test",
      name: "Olivia from the IdP",
      sub: "olivia",
    },
  ];

  // Authorization Code + PKCE (S256) as a public client, as the SPA does
  // (test/oidc-rbac.e2e.test.mjs has the same flow with every step asserted).
  const loginWithIdp = async (loginHint) => {
    const discovery = await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json();
    const verifier = randomBytes(32).toString("base64url");
    const authorize = new URL(discovery.authorization_endpoint);

    authorize.search = new URLSearchParams({
      client_id: idp.clientId,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      login_hint: loginHint,
      nonce: randomBytes(16).toString("base64url"),
      redirect_uri: OIDC_REDIRECT_URI,
      response_type: "code",
      scope: "openid profile",
      state: randomBytes(16).toString("base64url"),
    }).toString();

    const redirect = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(redirect.headers.get("location"));
    const exchange = await fetch(discovery.token_endpoint, {
      body: new URLSearchParams({
        client_id: idp.clientId,
        code: callback.searchParams.get("code"),
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: OIDC_REDIRECT_URI,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    assert.equal(exchange.status, 200);
    return (await exchange.json()).access_token;
  };

  const startMonolith = async ({ modelUrl }) => {
    const child = spawn(process.execPath, [path.join(serverDirectory, "server.js")], {
      cwd: tempRoot,
      env: {
        ...inheritedEnvironment(),
        ...profile,
        ...databaseEnvironment,
        ...kmsEnvironment,
        API_AUTH_OIDC_AUDIENCE: idp.audience,
        API_AUTH_OIDC_CLIENT_ID: idp.clientId,
        API_AUTH_OIDC_ENABLED: "true",
        API_AUTH_OIDC_ISSUER: idp.issuer,
        API_AUTH_OIDC_REQUIRE_TYP: "true",
        DOTENV_CONFIG_PATH: emptyEnvironmentFile,
        DOTENV_CONFIG_QUIET: "true",
        FEEDBACK_DIRECTORY: path.join(tempRoot, "feedback"),
        OPENAI_BASE_URL: modelUrl,
        PORT: "0",
        RAG_CLAIM_JUDGE: "off",
        RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
        RAG_INGEST_WORKER_POLL_MS: "100",
        RAG_OBSERVABILITY_ENABLED: "false",
        RAG_SEMANTIC_CACHE: "off",
        RAG_SHARED_STATE: "memory",
        // So the first retention sweep (system work under the split and
        // strict context) runs during the test, not a minute after start-up.
        RETENTION_SWEEP_INTERVAL_MS: "2000",
        TENANT_USAGE_FLUSH_MS: "1000",
        UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
        UPLOAD_SESSION_DIRECTORY: path.join(tempRoot, "upload-sessions"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    const appUrl = await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;

        const appPort = /server is running on port (\d+)/u.exec(output)?.[1];

        if (appPort) {
          resolve(`http://127.0.0.1:${appPort}`);
        }
      });
      exited.then(({ code, signal }) => reject(new Error(`server.js exited (${code ?? signal}):\n${output}`)));
    });

    return { appUrl, child, exited, output: () => output };
  };

  before(async () => {
    splitLoginsVia = await createSplitLogins();
    idp = await startDevOidcProvider({ port: 0, redirectUris: [OIDC_REDIRECT_URI], users: OIDC_USERS });
    modelServer = await startDemoFakeModel({ port: 0 });
    monolith = await startMonolith({ modelUrl: modelServer.url });
    client = createDemoClient({ baseUrl: monolith.appUrl });
  });

  after(async () => {
    if (monolith && monolith.child.exitCode === null && monolith.child.signalCode === null) {
      monolith.child.kill("SIGKILL");
      await monolith.exited;
    }

    await new Promise((resolve) => (modelServer ? modelServer.server.close(resolve) : resolve()));
    await idp?.stop();
    await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);

    for (const role of [tenantRole, systemRole, runtimeRole, ownerRole]) {
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${role}`);
    }

    rmSync(tempRoot, { force: true, recursive: true });
  });

  const assertCleanLog = (where) => {
    const output = monolith.output();

    for (const pattern of [
      /ARCHIVE_RAG_TENANT_CONTEXT_MISSING/u,
      /permission denied/iu,
      /\[retention\][^\n]*(failed|could not be read)/u,
      /Tenant membership check failed/u,
      /Failed to flush tenant usage/u,
    ]) {
      assert.doesNotMatch(output, pattern, `${where}:\n${output}`);
    }
  };

  test("the seed and every walkthrough check pass with every isolation switch on", async (t) => {
    const seeded = await seedDemoTenants({ client });

    assert.deepEqual(
      seeded.workspaces.map((workspace) => workspace.outcome),
      ["created", "created", "created"]
    );
    assert.equal(seeded.documents.filter((document) => document.outcome === "created").length, DEMO_DOCUMENTS.length);

    // Idempotent: a second seed changes nothing.
    const again = await seedDemoTenants({ client });

    assert.deepEqual(
      again.workspaces.map((workspace) => workspace.outcome),
      ["existing", "existing", "existing"]
    );
    assert.deepEqual(
      again.documents.map((document) => [document.fileName, document.outcome, document.docId]),
      seeded.documents.map((document) => [document.fileName, "duplicate", document.docId])
    );

    walkthrough = await runDemoWalkthrough({ client });

    const table = formatDemoResultTable(walkthrough);
    const failed = walkthrough.filter((result) => result.status === "FAIL");

    t.diagnostic(`\n${table}`);
    assert.deepEqual(failed, [], `${table}\n\n${monolith.output()}`);
    // Everything but the database-side chain check, which this suite runs
    // below with audit-verify.mjs.
    assert.deepEqual(
      walkthrough.filter((result) => result.status === "SKIP").map((result) => result.id),
      ["audit_chain"],
      table
    );

    // The walkthrough leaves the server as the seed made it, so it can run
    // again (inside the same rate-limit window, too).
    const rerun = await runDemoWalkthrough({ client });

    assert.deepEqual(
      rerun.filter((result) => result.status === "FAIL"),
      [],
      `${formatDemoResultTable(rerun)}\n\n${monolith.output()}`
    );
    assertCleanLog("seed and walkthrough");
  });

  test("every stored document file is an envelope under its workspace's key, readable only with its own row's context", async () => {
    const rows = await readStoredDocumentFiles();
    const facts = DEMO_DOCUMENTS.map((document) => document.lines.at(-1));
    const keyByWorkspace = new Map();

    assert.ok(rows.length >= DEMO_DOCUMENTS.length, `${rows.length} stored documents`);

    for (const row of rows) {
      const bytes = row.file_bytes;
      const text = bytes.toString("latin1");

      assert.equal(isTenantEnvelope(bytes), true, `${row.file_name} is an envelope`);
      assert.equal(text.includes("%PDF"), false, `${row.file_name}: no plaintext PDF marker`);
      assert.deepEqual(facts.filter((fact) => text.includes(fact)), [], `${row.file_name}: no plaintext fact`);

      const { keyId, provider } = describeTenantEnvelope(bytes);

      assert.equal(provider, "local");
      assert.match(keyId, /^tk_[0-9a-f]{40}$/u, "key ids are hashes, never raw tenant ids");
      assert.equal(keyId.includes(row.workspace_id), false);

      // One key per workspace, a different one for every workspace.
      if (keyByWorkspace.has(row.workspace_id)) {
        assert.equal(keyId, keyByWorkspace.get(row.workspace_id), `${row.workspace_id} has one key`);
      } else {
        keyByWorkspace.set(row.workspace_id, keyId);
      }

      const plaintext = await decryptStoredFile(row);

      assert.equal(plaintext.subarray(0, 5).toString("latin1"), "%PDF-", `${row.file_name} decrypts to the PDF`);
    }

    assert.equal(new Set(keyByWorkspace.values()).size, keyByWorkspace.size, "no two workspaces share a key");

    // Whatever the ingest queue still holds (the bytes of a finished job are
    // cleared) is an envelope too.
    const queued = [
      ...(await adminQuery(ownerUrl, "SELECT file_bytes AS bytes FROM rag_ingest_jobs WHERE file_bytes IS NOT NULL")).rows,
      ...(await adminQuery(ownerUrl, "SELECT payload AS bytes FROM rag_ingest_jobs_outputs WHERE payload IS NOT NULL")).rows,
    ];

    assert.deepEqual(
      queued.filter((row) => !isTenantEnvelope(row.bytes)).length,
      0,
      `${queued.length} queued byte rows, all envelopes`
    );

    // The ciphertext is bound to its row: alpha's bytes read as beta's
    // document fail instead of decrypting.
    const alphaRow = rows.find((row) => row.workspace_id === "alpha");
    const betaRow = rows.find((row) => row.workspace_id === "beta");

    await assert.rejects(
      decryptStoredFile({ ...betaRow, file_bytes: alphaRow.file_bytes }),
      (error) => /^TENANT_(ENVELOPE|KEY)_/u.test(error?.code ?? "")
    );

    // The status command reads the same keystore as the server.
    const status = runCli("tenant-keys.mjs", ["status", "--json"]);

    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);

    const report = JSON.parse(status.stdout);
    const reportText = JSON.stringify(report);

    for (const keyId of keyByWorkspace.values()) {
      assert.ok(reportText.includes(keyId), `tenant:keys status lists ${keyId}: ${status.stdout}`);
    }

    assertCleanLog("encryption at rest");
  });

  test("an OIDC identity: the registry decides its workspaces, and the IdP cannot grant platform roles", async (t) => {
    t.diagnostic(`split logins created with ${splitLoginsVia === "psql" ? "deploy/postgres/create-split-roles.sql (psql)" : "the same statements through pg (no psql found)"}`);

    const token = await loginWithIdp("olivia");
    const asOlivia = (pathname, { method = "GET", json, workspace } = {}) =>
      client.call(null, pathname, {
        headers: { authorization: `Bearer ${token}`, ...(workspace ? { "x-workspace-id": workspace } : {}) },
        json,
        method,
      });

    // Not a member yet: the registry refuses her, whatever workspace she names.
    let response = await asOlivia("/documents", { workspace: "beta" });

    assert.equal(response.status, 403, response.text);
    assert.equal(response.json.code, "WORKSPACE_MEMBERSHIP_REQUIRED");

    const added = await client.call("tenantManager", "/admin/workspaces/beta/members/olivia", {
      json: { roles: ["workspace.viewer"] },
      method: "PUT",
    });

    assert.equal(added.status, 201, added.text);

    try {
      response = await asOlivia("/documents", { workspace: "beta" });
      assert.equal(response.status, 200, response.text);
      // What bob uploaded is his own; beta has no shared document, so a new
      // member of beta sees none of the seeded documents.
      assert.deepEqual(response.json, []);

      const me = await asOlivia("/auth/me", { workspace: "beta" });

      assert.equal(me.status, 200, me.text);
      assert.equal(me.json.authProvider, "oidc");
      assert.ok(me.json.permissions.includes("documents.read"), me.text);
      // The token's admin.owner and admin permissions were dropped.
      assert.deepEqual(me.json.permissions.filter((permission) => permission.startsWith("admin.")), [], me.text);
      assert.equal(me.json.permissions.includes("documents.write"), false, me.text);

      response = await asOlivia("/admin/tenants/erase", { json: { workspaceId: "beta" }, method: "POST" });
      assert.equal(response.status, 403, response.text);
      response = await asOlivia("/admin/workspaces");
      assert.equal(response.status, 403, response.text);
      // Outside the platform routes she has to name a workspace.
      response = await asOlivia("/documents");
      assert.equal(response.status, 403, response.text);
      response = await asOlivia("/documents", { workspace: "alpha" });
      assert.equal(response.status, 403, response.text);
      assert.equal(response.json.code, "WORKSPACE_MEMBERSHIP_REQUIRED");
    } finally {
      const removed = await client.call("tenantManager", "/admin/workspaces/beta/members/olivia", { method: "DELETE" });

      assert.equal(removed.status, 200, removed.text);
    }

    response = await asOlivia("/documents", { workspace: "beta" });
    assert.equal(response.status, 403, "removed from beta, refused again");
    assertCleanLog("OIDC identity");
  });

  // TENANT_MAX_CONCURRENT_RUNS (2 in the profile): the fake model holds each
  // chat completion, so beta's runs overlap; the third is refused while
  // alpha's run beside them is not counted against beta.
  test("the per-tenant concurrency cap refuses beta's third concurrent run, not alpha's", async () => {
    const documents = await discoverDemoDocuments({ client });
    const betaDocument = DEMO_DOCUMENTS.find((document) => document.fileName === "beta-travel-policy.pdf");
    const alphaDocument = DEMO_DOCUMENTS.find((document) => document.fileName === "alpha-leave-policy.pdf");
    const ask = (personaName, document) =>
      client.call(personaName, "/chat", {
        json: { docIds: [documents[document.fileName].docId], question: document.question },
        method: "POST",
      });

    modelServer.setChatDelayMs(1_500);

    try {
      const chatsBefore = modelServer.requests.chat;
      const beta = [ask("bob", betaDocument), ask("bob", betaDocument)];

      // Both of beta's runs hold their slot before the third arrives: each
      // has reached the model, which holds its completion for 1.5 s (the
      // fake counts a chat request as it arrives, before the delay). A
      // counter, not a timer, so a slow runner cannot reorder them.
      const reachedBy = Date.now() + 30_000;

      while (modelServer.requests.chat < chatsBefore + 2 && Date.now() < reachedBy) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.ok(modelServer.requests.chat >= chatsBefore + 2, "both of beta's runs reached the model");

      const [first, second, third, alpha] = await Promise.all([...beta, ask("bob", betaDocument), ask("alice", alphaDocument)]);

      assert.deepEqual(
        [first.status, second.status, third.status, alpha.status],
        [200, 200, 429, 200],
        [first, second, third, alpha].map((response) => response.text.slice(0, 200)).join("\n")
      );
      assert.equal(third.json.code, "TENANT_CONCURRENCY_LIMITED");
      assert.match(alpha.json.agentAnswer, alphaDocument.answer);
    } finally {
      modelServer.setChatDelayMs(0);
    }

    assertCleanLog("concurrency cap");
  });

  test("/ready is 200, and the admin's health report has no row-level security or role-split error", async () => {
    const ready = await client.call(null, "/ready");

    assert.equal(ready.status, 200, ready.text);
    assert.deepEqual(ready.json, { status: "ok" });

    const health = await client.call("platformAdmin", "/ready");
    const rowLevelSecurity = health.json?.checks?.rowLevelSecurity;

    assert.equal(health.status, 200, health.text);
    assert.equal(rowLevelSecurity?.status, "ok", JSON.stringify(rowLevelSecurity));
    assert.equal(rowLevelSecurity?.roleSplit?.status, "ok", JSON.stringify(rowLevelSecurity?.roleSplit));
    // TENANT_ENCRYPTION=on: the keystore and master key are readable and
    // private.
    assert.equal(health.json.checks.tenantEncryption?.status, "ok", JSON.stringify(health.json.checks.tenantEncryption));
    assert.equal(
      Object.values(health.json.checks).some((check) => check?.status === "error"),
      false,
      JSON.stringify(health.json.checks)
    );
  });

  // DOCUMENT_TRASH_RETENTION_HOURS (72 in the profile): the walkthrough left
  // bob's redaction probe in his trash, its feedback excerpts intact. Aged
  // past the retention, the sweep purges it (row and bytes, as the system)
  // and only then runs the redaction, in bob's own database context.
  test("the trash purge removes an aged trashed document and only then redacts its excerpts", async () => {
    assert.match(monolith.output(), /\[retention\] sweeping every 2000 ms: [^\n]*document_trash=72h/u);

    const excerpts = async () =>
      ((await client.call("bob", "/feedback?limit=100")).json?.feedback ?? [])
        .flatMap((record) => record.citations ?? [])
        .filter((citation) => citation.fileName === DEMO_REDACTION_PROBE.fileName)
        .map((citation) => citation.excerpt);
    const trashed = (
      await adminQuery(
        ownerUrl,
        "SELECT doc_id FROM rag_documents WHERE workspace_id = 'beta' AND file_name = $1 AND deleted_at IS NOT NULL",
        [DEMO_REDACTION_PROBE.fileName]
      )
    ).rows;

    assert.equal(trashed.length, 1, "one probe in bob's trash");
    assert.ok((await excerpts()).length > 0);
    assert.ok((await excerpts()).every((excerpt) => excerpt === DEMO_REDACTION_PROBE.fact), "kept while restorable");

    await adminQuery(
      ownerUrl,
      `UPDATE rag_documents SET deleted_at = now() - interval '${Number(profile.DOCUMENT_TRASH_RETENTION_HOURS) + 8} hours' WHERE doc_id = $1`,
      [trashed[0].doc_id]
    );

    const deadline = Date.now() + 20_000;
    let left = 1;

    while (Date.now() < deadline && left > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      left = (await adminQuery(ownerUrl, "SELECT count(*)::int AS n FROM rag_documents WHERE doc_id = $1", [trashed[0].doc_id]))
        .rows[0].n;
    }

    assert.equal(left, 0, monolith.output());

    // The cascade runs right after the purge commits.
    const redactedBy = Date.now() + 5_000;
    let after = await excerpts();

    while (Date.now() < redactedBy && !after.every((excerpt) => excerpt === DELETED_SOURCE_MARKER)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      after = await excerpts();
    }

    assert.ok(after.length > 0 && after.every((excerpt) => excerpt === DELETED_SOURCE_MARKER), JSON.stringify(after));

    const trashListing = await client.call("bob", "/documents/trash");

    assert.equal(
      (trashListing.json ?? []).some((document) => document.docId === trashed[0].doc_id),
      false,
      "purged from the trash"
    );
    assertCleanLog("trash purge");
  });

  test("the retention sweep deletes aged runs, tasks and feedback as system work under the split", async () => {
    assert.match(monolith.output(), /\[retention\] sweeping every 2000 ms/u);

    // Age one finished run, one finished task and the feedback rows past the
    // profile's retention days, as the owner (the sweep itself runs as the
    // system role the runtime login switches into).
    const run = (
      await adminQuery(
        ownerUrl,
        "SELECT run_id FROM rag_agent_runs WHERE workspace_id = 'beta' AND status = 'completed' ORDER BY created_at LIMIT 1"
      )
    ).rows[0];
    const task = (
      await adminQuery(ownerUrl, "SELECT task_id FROM rag_tasks WHERE status = 'completed' ORDER BY created_at LIMIT 1")
    ).rows[0];
    const feedbackRows = (await adminQuery(ownerUrl, "SELECT count(*)::int AS n FROM rag_feedback")).rows[0].n;

    assert.ok(run && task && feedbackRows > 0, "the walkthrough left a finished run, a finished task and feedback");

    const runAge = Number(profile.AGENT_RUN_RETENTION_DAYS) + 10;
    const taskAge = Number(profile.TASK_RETENTION_DAYS) + 10;
    const feedbackAge = Number(profile.FEEDBACK_RETENTION_DAYS) + 10;

    await adminQuery(ownerUrl, `UPDATE rag_agent_runs SET updated_at = now() - interval '${runAge} days' WHERE run_id = $1`, [
      run.run_id,
    ]);
    await adminQuery(ownerUrl, `UPDATE rag_tasks SET updated_at = now() - interval '${taskAge} days' WHERE task_id = $1`, [
      task.task_id,
    ]);
    await adminQuery(ownerUrl, `UPDATE rag_feedback SET created_at = now() - interval '${feedbackAge} days'`);

    const remaining = async () => ({
      feedback: (await adminQuery(ownerUrl, "SELECT count(*)::int AS n FROM rag_feedback")).rows[0].n,
      run: (await adminQuery(ownerUrl, "SELECT count(*)::int AS n FROM rag_agent_runs WHERE run_id = $1", [run.run_id]))
        .rows[0].n,
      task: (await adminQuery(ownerUrl, "SELECT count(*)::int AS n FROM rag_tasks WHERE task_id = $1", [task.task_id]))
        .rows[0].n,
    });
    const deadline = Date.now() + 20_000;
    let left = await remaining();

    while (Date.now() < deadline && (left.run || left.task || left.feedback)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      left = await remaining();
    }

    assert.deepEqual(left, { feedback: 0, run: 0, task: 0 }, monolith.output());
    assert.match(monolith.output(), /\[retention\] agent_runs: deleted 1 /u);
    assert.match(monolith.output(), /\[retention\] tasks: deleted 1 /u);
    assert.match(monolith.output(), /\[retention\] feedback: deleted \d+ /u);
    assertCleanLog("retention sweep");
  });

  const runAuditVerify = () =>
    spawnSync(process.execPath, [path.join(serverDirectory, "audit-verify.mjs"), "--json"], {
      cwd: tempRoot,
      encoding: "utf8",
      env: { ...inheritedEnvironment(), ...databaseEnvironment, DOTENV_CONFIG_PATH: emptyEnvironmentFile, DOTENV_CONFIG_QUIET: "true" },
    });

  test("the audit hash chain verifies (audit-verify.mjs with the profile's two database URLs)", () => {
    const result = runAuditVerify();

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const report = JSON.parse(result.stdout);

    assert.equal(report.status, "ok", result.stdout);
    assert.ok(report.chainedRows > 0, result.stdout);
    assert.ok(report.chainCount >= 3, `alpha, beta, gamma and the platform users' chains: ${result.stdout}`);
  });

  // The operator commands with the profile's environment (strict tenant
  // context, the split's two logins) while the server runs.
  const runCli = (script, args) =>
    spawnSync(process.execPath, [path.join(serverDirectory, script), ...args], {
      cwd: tempRoot,
      encoding: "utf8",
      env: {
        ...inheritedEnvironment(),
        ...profile,
        ...databaseEnvironment,
        ...kmsEnvironment,
        DOTENV_CONFIG_PATH: emptyEnvironmentFile,
        DOTENV_CONFIG_QUIET: "true",
        RAG_DATA_DIRECTORY: path.join(tempRoot, "cli-rag-data"),
        UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
      },
      timeout: 60_000,
    });

  test("the operator commands work with the profile: registry, erase preview, export, ingest jobs, index versions", async () => {
    const documents = await discoverDemoDocuments({ client });
    const registry = runCli("tenant-registry.mjs", ["list", "--json"]);

    assert.equal(registry.status, 0, `${registry.stdout}\n${registry.stderr}`);
    assert.deepEqual(
      JSON.parse(registry.stdout).workspaces.map((workspace) => workspace.workspaceId).sort(),
      ["alpha", "beta", "gamma"]
    );

    const preview = runCli("tenant-lifecycle.mjs", ["erase", "--workspace", "beta", "--json"]);

    assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
    assert.equal(JSON.parse(preview.stdout).status, "dry_run", preview.stdout);

    const exportFile = path.join(tempRoot, "beta-export.ndjson");
    const exported = runCli("tenant-lifecycle.mjs", ["export", "--workspace", "beta", "--output", exportFile, "--json"]);

    assert.equal(exported.status, 0, `${exported.stdout}\n${exported.stderr}`);

    const lines = readFileSync(exportFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const records = lines.filter((line) => line.type === "record");
    const alphaDocuments = DEMO_DOCUMENTS.filter((document) => document.workspaceId === "alpha");

    assert.ok(records.length > 0);
    assert.ok(
      demoDocumentsVisibleTo("bob", "beta").every((document) =>
        records.some((line) => JSON.stringify(line.record).includes(documents[document.fileName].docId))
      ),
      "beta's documents are in its export"
    );
    assert.deepEqual(
      records.filter((line) =>
        alphaDocuments.some(
          (document) => document.answer.test(JSON.stringify(line.record)) || JSON.stringify(line.record).includes(document.fileName)
        )
      ),
      [],
      "nothing of alpha's documents is in beta's export"
    );

    const counts = runCli("ingest-jobs.mjs", ["counts", "--json"]);

    assert.equal(counts.status, 0, `${counts.stdout}\n${counts.stderr}`);

    const deadLetters = runCli("ingest-jobs.mjs", ["dead-letter", "list", "--all", "--json"]);

    assert.equal(deadLetters.status, 0, `${deadLetters.stdout}\n${deadLetters.stderr}`);

    const versions = runCli("vector-index.mjs", ["status", "--json"]);

    assert.equal(versions.status, 0, `${versions.stdout}\n${versions.stderr}`);
    assertCleanLog("operator commands");
  });

  test("a real erase removes alpha everywhere while beta's documents and chat keep working", async () => {
    const documents = await discoverDemoDocuments({ client });
    const betaDocument = DEMO_DOCUMENTS.find((document) => document.workspaceId === "beta");
    // A copy of alpha's stored ciphertext, as an old database backup would
    // keep it after the erase, and the key it names.
    const storedBefore = await readStoredDocumentFiles();
    const alphaCopy = storedBefore.find((row) => row.workspace_id === "alpha");
    const alphaKey = describeTenantEnvelope(alphaCopy.file_bytes);

    assert.equal((await decryptStoredFile(alphaCopy)).subarray(0, 5).toString("latin1"), "%PDF-");

    // An erase sees the trash too: gamma's preview counts the quota probes the
    // walkthrough left there, and names the one key it would destroy.
    const gammaTrashed = (
      await adminQuery(ownerUrl, "SELECT count(*)::int AS n FROM rag_documents WHERE workspace_id = 'gamma' AND deleted_at IS NOT NULL")
    ).rows[0].n;
    const gammaPreview = await client.call("platformAdmin", "/admin/tenants/erase", {
      json: { workspaceId: "gamma" },
      method: "POST",
    });
    const gammaDocuments = gammaPreview.json?.stores?.find((store) => store.store === "documents");

    assert.ok(gammaTrashed > 0, "the walkthrough left gamma's probes in the trash");
    assert.equal(gammaDocuments?.tables?.documents?.records, gammaTrashed, gammaPreview.text);
    assert.equal(gammaPreview.json.tenantKeys?.status, "dry_run", gammaPreview.text);
    assert.equal(gammaPreview.json.tenantKeys.destroy.length, 1, gammaPreview.text);

    const erased = await client.call("platformAdmin", "/admin/tenants/erase", {
      json: { dryRun: false, workspaceId: "alpha" },
      method: "POST",
    });

    assert.equal(erased.status, 200, erased.text);
    assert.equal(erased.json.complete, true, erased.text);
    assert.equal(erased.json.status, "completed", erased.text);

    // Crypto-shred: the erase destroyed alpha's workspace key, last, and
    // reports it by id and versions only.
    assert.equal(erased.json.tenantKeys?.status, "destroyed", erased.text);
    assert.deepEqual(
      erased.json.tenantKeys.destroyed.map((key) => [key.keyId, key.scope]),
      [[alphaKey.keyId, "workspace"]],
      erased.text
    );
    assert.ok(erased.json.tenantKeys.destroyed[0].destroyedVersions.includes(alphaKey.version), erased.text);
    assert.equal(/alpha/u.test(JSON.stringify(erased.json.tenantKeys)), false, "no raw tenant id in the key report");

    // The kept copy no longer decrypts, with a fresh KMS (nothing cached).
    await assert.rejects(decryptStoredFile(alphaCopy), (error) => error?.code === "TENANT_KEY_DESTROYED");

    // beta's key is untouched: its stored file decrypts, and bob downloads.
    const betaRow = (await readStoredDocumentFiles()).find(
      (row) => row.workspace_id === "beta" && row.doc_id === documents[betaDocument.fileName].docId
    );

    assert.equal((await decryptStoredFile(betaRow)).subarray(0, 5).toString("latin1"), "%PDF-");

    const download = await client.call("bob", `/documents/${documents[betaDocument.fileName].docId}/file`);

    assert.equal(download.status, 200, download.text.slice(0, 200));
    assert.match(download.headers.get("content-type") ?? "", /pdf/u);
    assert.ok(download.text.startsWith("%PDF-"), "bob gets the plaintext PDF");
    // Per table: every seeded alpha document (and its chunks) went.
    assert.equal(
      erased.json.totals.deleted.documents,
      DEMO_DOCUMENTS.filter((document) => document.workspaceId === "alpha").length,
      erased.text
    );

    // alpha is gone: its members are refused, and the export holds nothing
    // but its audit trail, which an erase keeps by design.
    const alice = await client.call("alice", "/documents");

    assert.equal(alice.status, 403, alice.text);

    const exported = await client.call("platformAdmin", "/admin/tenants/export?workspaceId=alpha");
    const records = exported.text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === "record");

    assert.equal(exported.status, 200, exported.text);
    assert.ok(records.some((line) => line.store === "admin_audit_events"), "the audit trail is kept");
    assert.deepEqual(
      records.filter((line) => line.store !== "admin_audit_events").map((line) => line.store),
      []
    );

    // In the database, as the owner: no row of alpha in any table that has a
    // workspace column, except the audit trail (kept, with the tombstone).
    const tables = (
      await adminQuery(
        ownerUrl,
        `SELECT DISTINCT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'workspace_id' ORDER BY table_name`
      )
    ).rows.map((row) => row.table_name);
    const leftovers = {};

    for (const table of tables) {
      const { rows } = await adminQuery(ownerUrl, `SELECT count(*)::int AS n FROM "${table}" WHERE workspace_id = 'alpha'`);

      if (rows[0].n > 0) {
        leftovers[table] = rows[0].n;
      }
    }

    assert.ok(tables.includes("rag_documents") && tables.includes("rag_workspace_members"), tables.join(","));
    assert.deepEqual(Object.keys(leftovers).filter((table) => !/audit/u.test(table)), [], JSON.stringify(leftovers));

    const tombstones = await adminQuery(
      ownerUrl,
      "SELECT count(*)::int AS n FROM rag_admin_audit_events WHERE event_type = 'admin.tenant.erased'"
    );

    assert.equal(tombstones.rows[0].n, 1);

    const betaRows = await adminQuery(ownerUrl, "SELECT count(*)::int AS n FROM rag_documents WHERE workspace_id = 'beta'");

    assert.equal(betaRows.rows[0].n, DEMO_DOCUMENTS.filter((document) => document.workspaceId === "beta").length);

    // beta works as before.
    const listing = await client.call("bob", "/documents");

    assert.equal(listing.status, 200, listing.text);
    assert.deepEqual(
      listing.json.map((document) => document.docId).sort(),
      demoDocumentsVisibleTo("bob", "beta")
        .map((document) => documents[document.fileName].docId)
        .sort()
    );

    const chat = await client.call("bob", "/chat", {
      json: { docIds: [documents[betaDocument.fileName].docId], question: betaDocument.question },
      method: "POST",
    });

    assert.equal(chat.status, 200, chat.text);
    assert.match(chat.json.agentAnswer, betaDocument.answer);

    // Nothing flushes alpha back afterwards (the usage ledger's unflushed
    // totals went with the erase): two flush intervals later it is still gone.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    for (const table of tables) {
      if (/audit/u.test(table)) {
        continue;
      }

      const { rows } = await adminQuery(ownerUrl, `SELECT count(*)::int AS n FROM "${table}" WHERE workspace_id = 'alpha'`);

      assert.equal(rows[0].n, 0, `${table} holds alpha rows after the erase`);
    }

    // alice's refused request after the erase is still counted, for her
    // alone: the erased workspace's id does not come back into the ledger.
    const aliceRefusals = await adminQuery(
      ownerUrl,
      "SELECT metric FROM tenant_usage WHERE owner_user_id = 'alice' AND workspace_id = '' AND metric LIKE 'refused_%'"
    );

    assert.deepEqual(
      aliceRefusals.rows.map((row) => row.metric),
      ["refused_workspace_membership_required"]
    );

    // The erase and the requests after it still chain.
    const verified = runAuditVerify();

    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    assert.equal(JSON.parse(verified.stdout).status, "ok", verified.stdout);

    // alpha can be registered again and starts empty: its old documents are
    // not resolved as duplicates of the same bytes (the content hashes went
    // with them), so every upload is a new document.
    const reseeded = await seedDemoTenants({ client });
    const alphaUploads = reseeded.documents.filter((document) => document.workspaceId === "alpha");

    assert.deepEqual(
      reseeded.workspaces.map((workspace) => [workspace.id, workspace.outcome]),
      [
        ["alpha", "created"],
        ["beta", "existing"],
        ["gamma", "existing"],
      ]
    );
    assert.deepEqual(
      alphaUploads.map((document) => document.outcome),
      alphaUploads.map(() => "created")
    );
    assert.equal(
      alphaUploads.some((document) => document.docId === documents[document.fileName].docId),
      false,
      "new document ids"
    );

    const aliceAgain = await client.call("alice", "/documents");

    assert.equal(aliceAgain.status, 200, aliceAgain.text);
    assert.deepEqual(
      aliceAgain.json.map((document) => document.fileName).sort(),
      demoDocumentsVisibleTo("alice", "alpha").map((document) => document.fileName).sort()
    );

    // The re-registered alpha writes under the same key id at a newer
    // version; the destroyed version stays unreadable.
    const newAlpha = (await readStoredDocumentFiles()).filter((row) => row.workspace_id === "alpha");

    assert.ok(newAlpha.length > 0);

    for (const row of newAlpha) {
      const header = describeTenantEnvelope(row.file_bytes);

      assert.equal(header.keyId, alphaKey.keyId);
      assert.ok(header.version > alphaKey.version, `${row.file_name} is under version ${header.version}`);
      assert.equal((await decryptStoredFile(row)).subarray(0, 5).toString("latin1"), "%PDF-");
    }

    await assert.rejects(decryptStoredFile(alphaCopy), (error) => error?.code === "TENANT_KEY_DESTROYED");
    assertCleanLog("erase");
  });

  test("the process shuts down cleanly on SIGTERM", async () => {
    assert.equal(monolith.child.exitCode, null, "the process is still up");
    // The demo personas were all used against this server.
    assert.ok(Object.keys(DEMO_PERSONAS).length >= 8);

    monolith.child.kill("SIGTERM");

    const { code } = await monolith.exited;

    assert.equal(code, 0, monolith.output());
    assertCleanLog("shutdown");
  });
}
