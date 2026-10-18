// The hardened tenant-isolation demo kit without a server: the profile
// (deploy/demo/hardened.env) names only variables the server reads and
// documents, the server's own parsers read every isolation switch in it as
// on, its tokens are the demo personas of demo/tenant-demo.js, and the CLI
// and the result table behave. test/tenant-isolation-hardened.e2e.test.mjs
// runs the profile against a real `node server.js` on PostgreSQL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { assertApiAuthTokenConfiguration } from "../auth.js";
import { parseDemoArgs, runDemoCommand } from "../demo-tenants.mjs";
import { DEMO_FAKE_MODEL_DIMENSIONS, startDemoFakeModel } from "../demo/fake-model.js";
import {
  buildDemoApiAuthTokens,
  createDemoClient,
  DEMO_CHECKS,
  DEMO_DOCUMENTS,
  DEMO_MEMBERSHIPS,
  DEMO_PERSONAS,
  DEMO_WORKSPACES,
  demoDocumentsVisibleTo,
  formatDemoResultTable,
  runDemoWalkthrough,
} from "../demo/tenant-demo.js";
import {
  getAgentRunRetentionDays,
  getDocumentTrashRetentionHours,
  getFeedbackRetentionDays,
  getLongMemoryScope,
  getQueryEmbeddingCacheScope,
  getTenantEncryptionMode,
  getTenantKmsProviderId,
  getTenantRegistryCacheScope,
  isDocumentTrashEnabled,
  isTenantEncryptionEnabled,
  getModelGatewayQuotaLimits,
  getPostgresRowLevelSecurityMode,
  getPostgresTenantContextMode,
  getRagIngestMaxPendingBytesPerWorkspace,
  getRagIngestMaxPendingJobsPerWorkspace,
  getTaskRetentionDays,
  getTenantMaxConcurrentRuns,
  getTenantMaxDocumentBytes,
  getTenantMaxDocuments,
  getTenantMaxQueuedTasks,
  getTenantMaxRunningTasks,
  getTenantMembershipMode,
  getTenantRateLimits,
  getWorkspaceArtifactRetentionDays,
  isAdminAuditDataEventsEnabled,
  isApiAuthEnabled,
  isApiAuthOidcPlatformRolesAllowed,
  isApiAuthWorkspaceRequired,
  isDocumentDeleteRedactionEnabled,
  isModelQuotaEnabled,
  isPostgresRoleSplitEnabled,
  isRagIngestAsync,
  isTenantRateLimitEnabled,
} from "../rag/config.js";
import { resolveLocalKmsPaths } from "../rag/kms/local-provider.js";
import { assertRbacConfiguration, getRbacMode } from "../rag/rbac.js";
import { getRagDataDirectory } from "../rag/storage.js";

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.join(serverDirectory, "..");
const profileText = readFileSync(path.join(repositoryRoot, "deploy", "demo", "hardened.env"), "utf8");
const profile = dotenv.parse(profileText);

const withProfile = async (run) => {
  const previous = new Map(Object.keys(profile).map((key) => [key, process.env[key]]));

  Object.assign(process.env, profile);

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// The server's own sources (not tests, evaluations or this kit), where a
// variable it reads is named.
const listSources = (directory) =>
  readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);

    if (["node_modules", "test", "evaluation", "demo", "data", "uploads"].includes(entry)) {
      return [];
    }

    if (statSync(fullPath).isDirectory()) {
      return listSources(fullPath);
    }

    return /\.(m?js)$/u.test(entry) ? [fullPath] : [];
  });

// docs/configuration.md abbreviates a family as `TENANT_RATE_LIMIT_CHAT_MAX` /
// `_INGEST_MAX`: each `_X` after a full name stands for that name with its
// last segments replaced by X.
const documentedNames = (text) => {
  const names = new Set();

  for (const line of text.split("\n")) {
    let last = null;

    for (const [, token] of line.matchAll(/`([A-Z_][A-Z0-9_]*)`/gu)) {
      if (!token.startsWith("_")) {
        names.add(token);
        last = token;
      } else if (last) {
        const segments = token.slice(1).split("_");
        const base = last.split("_").slice(0, -segments.length).join("_");

        names.add(`${base}${token}`);
      }
    }
  }

  return names;
};

test("every variable of the profile is one the server reads and documents", () => {
  const sources = listSources(serverDirectory).map((file) => readFileSync(file, "utf8")).join("\n");
  const documented = new Set([
    ...documentedNames(readFileSync(path.join(repositoryRoot, "docs", "configuration.md"), "utf8")),
    ...[...readFileSync(path.join(serverDirectory, ".env.example"), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gmu)].map(
      (match) => match[1]
    ),
  ]);

  assert.ok(Object.keys(profile).length > 40, "the profile parses");

  for (const key of Object.keys(profile)) {
    assert.match(sources, new RegExp(`\\b${key}\\b`, "u"), `${key} is read by the server`);
    assert.ok(documented.has(key), `${key} is documented in docs/configuration.md or server/.env.example`);
  }
});

test("the server's own parsers read every isolation switch of the profile as on", async () => {
  await withProfile(() => {
    assert.equal(isApiAuthEnabled(), true);
    assert.equal(isApiAuthWorkspaceRequired(), true);
    assert.equal(isApiAuthOidcPlatformRolesAllowed(), false);
    assert.equal(getRbacMode(), "enforce");
    assert.doesNotThrow(() => assertRbacConfiguration());
    assert.doesNotThrow(() => assertApiAuthTokenConfiguration());
    assert.equal(getTenantMembershipMode(), "enforce");
    assert.equal(getPostgresRowLevelSecurityMode(), "enforce");
    assert.equal(getPostgresTenantContextMode(), "strict");
    assert.equal(isPostgresRoleSplitEnabled(), true);
    assert.equal(isAdminAuditDataEventsEnabled(), true);
    assert.equal(isDocumentDeleteRedactionEnabled(), true);
    assert.equal(isTenantRateLimitEnabled(), true);
    assert.ok(Object.values(getTenantRateLimits()).every((limit) => limit > 0), JSON.stringify(getTenantRateLimits()));
    assert.ok(getTenantMaxConcurrentRuns() > 0);
    assert.equal(isModelQuotaEnabled(), true);
    assert.ok(Object.values(getModelGatewayQuotaLimits()).every((limit) => limit > 0));
    assert.ok(getTenantMaxDocuments() > 0 && getTenantMaxDocumentBytes() > 0);
    assert.equal(isRagIngestAsync(), true);
    assert.ok(getRagIngestMaxPendingJobsPerWorkspace() > 0 && getRagIngestMaxPendingBytesPerWorkspace() > 0);
    assert.ok(getTenantMaxRunningTasks() > 0 && getTenantMaxQueuedTasks() > 0);

    for (const days of [
      getAgentRunRetentionDays(),
      getTaskRetentionDays(),
      getWorkspaceArtifactRetentionDays(),
      getFeedbackRetentionDays(),
    ]) {
      assert.ok(days > 0);
    }

    assert.equal(isDocumentTrashEnabled(), true);
    assert.ok(getDocumentTrashRetentionHours() > 0);
    assert.equal(getTenantEncryptionMode(), "on");
    assert.equal(isTenantEncryptionEnabled(), true);
    assert.equal(getTenantKmsProviderId(), "local");
    assert.equal(getLongMemoryScope(), "workspace");
    assert.equal(getQueryEmbeddingCacheScope(), "tenant");
    assert.equal(getTenantRegistryCacheScope(), "tenant");
  });
});

// The profile leaves TENANT_KEYSTORE_DIR and TENANT_KMS_MASTER_KEY_FILE unset:
// a local run keeps both under server/data/ (git-ignored, resolved from the
// server's directory whatever the working directory), and compose.demo.yml
// names the app volume's paths (deployment-contract.test.mjs).
test("a local run of the profile keeps the keystore and master key next to the data directory, git-ignored", async () => {
  assert.equal(profile.TENANT_KEYSTORE_DIR, undefined);
  assert.equal(profile.TENANT_KMS_MASTER_KEY_FILE, undefined);
  assert.equal(profile.RAG_DATA_DIRECTORY, undefined);

  await withProfile(() => {
    const dataRoot = path.dirname(getRagDataDirectory());
    const paths = resolveLocalKmsPaths();

    assert.equal(paths.keystoreDirectory, path.join(dataRoot, "tenant-keystore"));
    assert.equal(paths.masterKeyFile, path.join(dataRoot, "tenant-kms-master.key"));

    // In a checkout (no RAG_DATA_DIRECTORY in this process) the data
    // directory is server/data/rag, and server/data/ is git-ignored.
    if (!process.env.RAG_DATA_DIRECTORY && dataRoot === path.join(serverDirectory, "data")) {
      assert.match(readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8"), /^\/server\/data\/$/mu);
    }
  });
});

test("the split's two logins differ, and the runtime login is not the postgres superuser", () => {
  const runtime = new URL(profile.POSTGRES_DATABASE_URL);
  const owner = new URL(profile.POSTGRES_MIGRATION_DATABASE_URL);

  assert.notEqual(runtime.username, owner.username);
  assert.notEqual(runtime.username, "postgres");
  assert.equal(runtime.pathname, owner.pathname);
  // The names create-split-roles.sql uses by default, with demo passwords.
  assert.equal(runtime.username, "archive_rag_app");
  assert.equal(owner.username, "archive_rag_owner");
  assert.equal(runtime.pathname, "/archive_rag");
  assert.match(runtime.password, /^demo_/u);
  assert.match(owner.password, /^demo_/u);
});

test("the profile's tokens are the demo personas, all of them obvious demo values", () => {
  assert.deepEqual(JSON.parse(profile.API_AUTH_TOKENS), buildDemoApiAuthTokens());

  for (const persona of Object.values(DEMO_PERSONAS)) {
    assert.match(persona.token, /^demo-[a-z-]+-token$/u);
  }

  // Two workspaces with two users each, a user in both, a platform admin and
  // a tenant manager without a workspace.
  const membersOf = (workspaceId) =>
    DEMO_MEMBERSHIPS.filter((membership) => membership.workspaceId === workspaceId).map((membership) => membership.userId);

  assert.ok(membersOf("alpha").length >= 2 && membersOf("beta").length >= 2);
  assert.ok(membersOf("alpha").includes("carol") && membersOf("beta").includes("carol"));
  assert.deepEqual(DEMO_PERSONAS.platformAdmin.principal.roles, ["admin.owner"]);
  assert.deepEqual(DEMO_PERSONAS.tenantManager.principal.roles, ["admin.tenant_manager"]);
  assert.equal(DEMO_PERSONAS.platformAdmin.principal.workspaceId, undefined);
  assert.equal(DEMO_PERSONAS.tenantManager.principal.workspaceId, undefined);
  assert.ok(DEMO_WORKSPACES.every((workspace) => membersOf(workspace.id).length > 0));
});

test("demo documents are private to their uploader in its workspace, except the shared ones", () => {
  const names = (personaName, workspaceId) =>
    demoDocumentsVisibleTo(personaName, workspaceId).map((document) => document.fileName).sort();

  assert.deepEqual(names("alice", "alpha"), ["alpha-leave-policy.pdf", "alpha-shared-glossary.pdf"]);
  assert.deepEqual(names("anna", "alpha"), ["alpha-shared-glossary.pdf"]);
  assert.deepEqual(names("carol", "alpha"), ["alpha-security-standard.pdf", "alpha-shared-glossary.pdf"]);
  assert.deepEqual(names("carol", "beta"), ["beta-onboarding-checklist.pdf"]);
  assert.deepEqual(names("bob", "beta"), ["beta-travel-policy.pdf"]);
  assert.deepEqual(names("alice", "beta"), []);
  assert.equal(new Set(DEMO_DOCUMENTS.map((document) => document.fileName)).size, DEMO_DOCUMENTS.length);
});

test("the walkthrough refuses to run, rather than pass, when it cannot list the seeded documents", async () => {
  const client = createDemoClient({
    baseUrl: "http://demo.invalid",
    fetchImpl: async () => new Response(JSON.stringify({ error: "down" }), { headers: { "content-type": "application/json" }, status: 503 }),
  });

  await assert.rejects(runDemoWalkthrough({ client }), /Listing alpha's documents as alice answered 503/u);
});

test("the fake model answers embeddings, chat and streamed chat in the OpenAI shapes", async () => {
  const model = await startDemoFakeModel({ port: 0 });
  const post = (pathname, body) =>
    fetch(`${model.url}${pathname}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  const prompt = {
    messages: [
      {
        content:
          "User Question:\nHow many paid annual leave days do Alpha employees receive?\n\nSource 1\nFile: a.pdf\nEvidence:\nAlpha Corp employee handbook. Alpha employees receive twelve paid annual leave days each year.\n\nGrounded Answer:",
        role: "user",
      },
    ],
    model: "demo-fake-chat",
  };

  try {
    const embeddings = await (await post("/embeddings", { input: ["alpha leave", "beta travel"], model: "m" })).json();

    assert.equal(embeddings.data.length, 2);
    assert.equal(embeddings.data[0].embedding.length, DEMO_FAKE_MODEL_DIMENSIONS);

    const chat = await (await post("/chat/completions", prompt)).json();
    const answer = chat.choices[0].message.content;

    assert.match(answer, /twelve paid annual leave days.*\[Source 1\]/u);

    // The stream carries the same answer in pieces, then usage and [DONE].
    const streamed = await (await post("/chat/completions", { ...prompt, stream: true })).text();
    const chunks = streamed
      .split("\n\n")
      .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
      .map((block) => JSON.parse(block.slice(6)));

    assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join(""), answer);
    assert.ok(chunks.some((chunk) => chunk.usage?.total_tokens > 0));
    assert.match(streamed, /data: \[DONE\]\n\n$/u);
    assert.deepEqual(model.requests, { chat: 2, embeddings: 1 });

    // A chat delay holds the completion.
    model.setChatDelayMs(150);
    const started = Date.now();

    await (await post("/chat/completions", prompt)).json();
    assert.ok(Date.now() - started >= 140);
  } finally {
    await new Promise((resolve) => model.server.close(resolve));
  }
});

// compose.demo.yml runs the command in the demo-model container (with
// init: true too): without its own handler, node as PID 1 ignores docker's
// SIGTERM, and `docker compose stop` waits out its timeout and kills it.
test("the fake-model command stops cleanly on SIGTERM and SIGINT", async () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const child = spawn(process.execPath, [path.join(serverDirectory, "demo-tenants.mjs"), "fake-model", "--port", "0"], {
      cwd: serverDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exited = new Promise((resolve) => child.once("exit", (code, exitSignal) => resolve({ code, exitSignal })));

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      const deadline = Date.now() + 10_000;

      while (!/fake model serving http:\/\/127\.0\.0\.1:\d+\/v1/u.test(output) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      assert.match(output, /fake model serving/u);
      child.kill(signal);

      const result = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 5_000)),
      ]);

      assert.deepEqual(result, { code: 0, exitSignal: null }, output);
      assert.match(output, new RegExp(`fake model stopping \\(${signal}\\)`, "u"));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }
});

test("the result table counts each status, and the CLI parses its commands", async () => {
  const table = formatDemoResultTable([
    { detail: "ok", id: "first", status: "PASS" },
    { detail: "no", id: "second", status: "FAIL" },
    { detail: "later", id: "third", status: "SKIP" },
  ]);

  assert.match(table, /^RESULT\s+CHECK\s+DETAIL/u);
  assert.match(table, /PASS\s+first\s+ok/u);
  assert.match(table, /1 PASS, 1 FAIL, 1 SKIP$/u);

  assert.equal(parseDemoArgs(["seed", "--url", "http://127.0.0.1:5002"]).url, "http://127.0.0.1:5002");
  assert.deepEqual(parseDemoArgs(["walkthrough", "--only", "list_isolation,chat_isolation"]).only, [
    "list_isolation",
    "chat_isolation",
  ]);
  assert.equal(parseDemoArgs(["fake-model", "--port", "0"]).port, 0);
  assert.throws(() => parseDemoArgs(["walkthrough", "--only", "no_such_check"]), /Unknown check/u);
  assert.throws(() => parseDemoArgs(["deploy"]), /Unknown command/u);
  assert.ok(DEMO_CHECKS.length >= 15);
  assert.equal(new Set(DEMO_CHECKS.map((check) => check.id)).size, DEMO_CHECKS.length);

  const output = [];
  const code = await runDemoCommand(["nope"], {
    stderr: { write: (text) => output.push(text) },
    stdout: { write: (text) => output.push(text) },
  });

  assert.equal(code, 2);
  assert.match(output.join(""), /Unknown command: nope/u);
});
