// The archive MCP server acts for ARCHIVE_MCP_USER_ID / ARCHIVE_MCP_WORKSPACE_ID
// only (it never passes through API auth). Unscoped, the registry filter reads
// its empty scope as every tenant and its statements run on the database owner
// path, so against a multi-tenant configuration it must refuse to start. With
// API auth off or the single shared API_AUTH_TOKEN (one tenant) it keeps
// starting unscoped.
//
// The first half tests the rule (archive-mcp-tools.js); the second starts the
// real entry point (archive-mcp-server.js) as a child process, which is the
// only way to see it refuse before the stdio transport connects.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe } from "node:test";

import {
  ARCHIVE_MCP_SCOPE_REQUIRED,
  assertArchiveMcpScope,
  listMultiTenantAuthSettings,
  resolveArchiveMcpAccessScope,
} from "../archive-mcp-tools.js";

const SERVER_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AUTH_KEYS = [
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_REQUIRE_WORKSPACE",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
];

const withAuthEnv = (t, values) => {
  const original = new Map(AUTH_KEYS.map((key) => [key, process.env[key]]));

  for (const key of AUTH_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of original.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const UNSCOPED = { userId: null, workspaceId: null };
const TOKENS = JSON.stringify({ "alice-token": { userId: "alice", workspaceId: "acme" } });

describe("the rule", () => {
  test("the scope is read from the two variables, blanks as unset", () => {
    assert.deepEqual(resolveArchiveMcpAccessScope({}), UNSCOPED);
    assert.deepEqual(
      resolveArchiveMcpAccessScope({ ARCHIVE_MCP_USER_ID: "  ", ARCHIVE_MCP_WORKSPACE_ID: "" }),
      UNSCOPED
    );
    assert.deepEqual(
      resolveArchiveMcpAccessScope({ ARCHIVE_MCP_USER_ID: " alice ", ARCHIVE_MCP_WORKSPACE_ID: "acme" }),
      { userId: "alice", workspaceId: "acme" }
    );
  });

  test("API auth off is one tenant, whatever else is set", (t) => {
    withAuthEnv(t, { API_AUTH_JWT_ENABLED: "true", API_AUTH_TOKENS: TOKENS });

    assert.deepEqual(listMultiTenantAuthSettings(), []);
    assert.doesNotThrow(() => assertArchiveMcpScope(UNSCOPED));
  });

  test("the single shared API_AUTH_TOKEN is one tenant", (t) => {
    withAuthEnv(t, { API_AUTH_ENABLED: "true", API_AUTH_TOKEN: "shared" });

    assert.deepEqual(listMultiTenantAuthSettings(), []);
    assert.doesNotThrow(() => assertArchiveMcpScope(UNSCOPED));
  });

  for (const [label, values, setting] of [
    ["per-principal static tokens", { API_AUTH_TOKENS: TOKENS }, "API_AUTH_TOKENS"],
    ["HS256 JWTs", { API_AUTH_JWT_ENABLED: "true" }, "API_AUTH_JWT_ENABLED"],
    ["OIDC", { API_AUTH_OIDC_ENABLED: "true" }, "API_AUTH_OIDC_ENABLED"],
    [
      "a required workspace on the shared token",
      { API_AUTH_REQUIRE_WORKSPACE: "true", API_AUTH_TOKEN: "shared" },
      "API_AUTH_REQUIRE_WORKSPACE",
    ],
  ]) {
    test(`multi-tenant through ${label}: unscoped is refused, a scope is not`, (t) => {
      withAuthEnv(t, { API_AUTH_ENABLED: "true", ...values });

      assert.deepEqual(listMultiTenantAuthSettings(), [setting]);
      assert.throws(
        () => assertArchiveMcpScope(UNSCOPED),
        (error) =>
          error.code === ARCHIVE_MCP_SCOPE_REQUIRED &&
          error.settings.includes(setting) &&
          /ARCHIVE_MCP_USER_ID/.test(error.message) &&
          error.message.includes(setting)
      );
      assert.doesNotThrow(() => assertArchiveMcpScope({ userId: "alice", workspaceId: null }));
      assert.doesNotThrow(() => assertArchiveMcpScope({ userId: null, workspaceId: "acme" }));
    });
  }

  test("every multi-tenant setting is named", (t) => {
    withAuthEnv(t, {
      API_AUTH_ENABLED: "true",
      API_AUTH_JWT_ENABLED: "true",
      API_AUTH_OIDC_ENABLED: "true",
      API_AUTH_REQUIRE_WORKSPACE: "true",
      API_AUTH_TOKENS: TOKENS,
    });

    assert.deepEqual(listMultiTenantAuthSettings(), [
      "API_AUTH_TOKENS",
      "API_AUTH_JWT_ENABLED",
      "API_AUTH_OIDC_ENABLED",
      "API_AUTH_REQUIRE_WORKSPACE",
    ]);
  });

  test("the default reads the server's own variables", (t) => {
    withAuthEnv(t, { API_AUTH_ENABLED: "true", API_AUTH_TOKENS: TOKENS });
    const original = {
      userId: process.env.ARCHIVE_MCP_USER_ID,
      workspaceId: process.env.ARCHIVE_MCP_WORKSPACE_ID,
    };
    t.after(() => {
      if (original.userId === undefined) delete process.env.ARCHIVE_MCP_USER_ID;
      else process.env.ARCHIVE_MCP_USER_ID = original.userId;
      if (original.workspaceId === undefined) delete process.env.ARCHIVE_MCP_WORKSPACE_ID;
      else process.env.ARCHIVE_MCP_WORKSPACE_ID = original.workspaceId;
    });

    delete process.env.ARCHIVE_MCP_USER_ID;
    delete process.env.ARCHIVE_MCP_WORKSPACE_ID;
    assert.throws(() => assertArchiveMcpScope(), { code: ARCHIVE_MCP_SCOPE_REQUIRED });

    process.env.ARCHIVE_MCP_WORKSPACE_ID = "acme";
    assert.doesNotThrow(() => assertArchiveMcpScope());
  });
});

describe("the entry point", () => {
  let dataDirectory;

  before(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "archive-mcp-scope-"));
  });

  after(async () => {
    await rm(dataDirectory, { force: true, recursive: true });
  });

  // A clean environment: no inherited auth, scope, database, profile or
  // tracing variable, and an empty data directory, so the child touches
  // nothing of this checkout's.
  const buildEnv = (values) => {
    const env = { ...process.env };

    for (const key of Object.keys(env)) {
      if (
        AUTH_KEYS.includes(key) ||
        key.startsWith("ARCHIVE_MCP_") ||
        key.startsWith("LANGSMITH_") ||
        key.startsWith("LANGCHAIN_") ||
        key.startsWith("POSTGRES_") ||
        key === "DOCCOMPARE_STANDALONE"
      ) {
        delete env[key];
      }
    }

    return { ...env, RAG_DATA_DIRECTORY: dataDirectory, ...values };
  };

  // Resolves with the exit code once the child exits, or with "running" once it
  // says it serves on stdio (then it is killed).
  const startServer = (values) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["archive-mcp-server.js"], {
        cwd: SERVER_DIRECTORY,
        env: buildEnv(values),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`archive MCP server neither started nor exited: ${stderr}`));
      }, 30000);
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...outcome, stderr });
      };

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;

        if (stderr.includes("running on stdio")) {
          child.kill("SIGTERM");
          settle({ outcome: "running" });
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => settle({ code, outcome: "exited" }));
    });

  test("a multi-tenant configuration without a scope refuses to start", async () => {
    const result = await startServer({ API_AUTH_ENABLED: "true", API_AUTH_TOKENS: TOKENS });

    assert.equal(result.outcome, "exited", result.stderr);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refused to start \(ARCHIVE_MCP_SCOPE_REQUIRED\)/);
    assert.match(result.stderr, /API_AUTH_TOKENS/);
    assert.doesNotMatch(result.stderr, /running on stdio/);
  });

  test("the same configuration with a scope starts", async () => {
    const result = await startServer({
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKENS: TOKENS,
      ARCHIVE_MCP_USER_ID: "alice",
      ARCHIVE_MCP_WORKSPACE_ID: "acme",
    });

    assert.equal(result.outcome, "running", result.stderr);
  });

  test("API auth off without a scope starts, as before", async () => {
    const result = await startServer({});

    assert.equal(result.outcome, "running", result.stderr);
  });
});
