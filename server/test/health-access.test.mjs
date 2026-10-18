// Who may read what the health probes say (tenant isolation phase 1, items 1.4
// and 1.6).
//
// 1.4: with API auth on, POSTGRES_ROW_LEVEL_SECURITY=off leaves only the
// stores' own WHERE clauses between tenants, so checks.rowLevelSecurity
// reports it as an error (which fails /ready and a strict startup) unless the
// operator acknowledges it with POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED=true.
// Auth off keeps the old "disabled" entry.
//
// 1.6: GET /health, /ready and /livez stay public (orchestrators probe them
// without a key and read only the status code), but with API auth on only a
// caller holding admin.status.read gets more than {status}: the report names
// the topology, stores, tables, models and dependency errors. Auth off keeps
// the full body.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { createApp as createProductionApp } from "../app.js";
import { createHs256Jwt } from "../auth-jwt.js";
import { checkRowLevelSecurityHealth } from "../health.js";
import {
  createAdminAuditService,
  createInMemoryAdminAuditStore,
} from "../rag/admin-audit.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { isPostgresRowLevelSecurityOffConfirmed } from "../rag/config.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { resetDefaultOidcVerifier } from "../rag/oidc.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import { createInMemoryWorkspaceArtifactStore } from "../rag/workspace-artifacts/index.js";

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

// Everything that changes who a request is, which routes answer, or what the
// RLS check reads. The split-deployment ones are cleared so this process is
// always the monolith, whatever the shell exports.
const ENV_KEYS = [
  "AGENT_SERVICE_URL",
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_AUDIENCE",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_JWT_HS256_SECRET",
  "API_AUTH_JWT_ISSUER",
  "API_AUTH_JWT_SECRET",
  "API_AUTH_OIDC_AUDIENCE",
  "API_AUTH_OIDC_CLIENT_ID",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_OIDC_ISSUER",
  "API_AUTH_OIDC_REQUIRE_TYP",
  "API_AUTH_REQUIRE_WORKSPACE",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "ARCHIVE_RAG_ROLE",
  "LONG_MEMORY_DATABASE_URL",
  "POSTGRES_DATABASE_URL",
  "POSTGRES_ROW_LEVEL_SECURITY",
  "POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED",
  "RAG_INGEST_MODE",
  "RATE_LIMIT_ENABLED",
  "RBAC_DEFAULT_ROLE",
  "RBAC_MODE",
  "RBAC_POLICY_FILE",
  "RBAC_POLICY_JSON",
];

const withEnv = async (values, run) => {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return await run();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// ---------------------------------------------------------------------------
// 1.4: the RLS-off branch of checks.rowLevelSecurity. It returns before any
// statement, so a URL that is never connected to is enough.
// ---------------------------------------------------------------------------

const NEVER_CONNECTED_URL = "postgres://health-access:none@127.0.0.1:9/never-connected";
const TODAY_OFF_MESSAGE =
  "POSTGRES_ROW_LEVEL_SECURITY=off: scoped queries run as the owner role and bypass the tenant policies.";

describe("checks.rowLevelSecurity with POSTGRES_ROW_LEVEL_SECURITY=off", () => {
  test("auth off keeps today's disabled entry, acknowledged or not", async () => {
    for (const confirmed of [undefined, "true"]) {
      await withEnv(
        {
          POSTGRES_DATABASE_URL: NEVER_CONNECTED_URL,
          POSTGRES_ROW_LEVEL_SECURITY: "off",
          ...(confirmed === undefined ? {} : { POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED: confirmed }),
        },
        async () => {
          assert.deepEqual(await checkRowLevelSecurityHealth(), {
            message: TODAY_OFF_MESSAGE,
            mode: "off",
            status: "disabled",
          });
        }
      );
    }
  });

  test("auth on without the acknowledgement is an error that names both ways out", async () => {
    for (const confirmed of [undefined, "", "   ", "1", "yes", "on", "false", "truee"]) {
      await withEnv(
        {
          API_AUTH_ENABLED: "true",
          API_AUTH_TOKEN: "local-test-token",
          POSTGRES_DATABASE_URL: NEVER_CONNECTED_URL,
          POSTGRES_ROW_LEVEL_SECURITY: "off",
          ...(confirmed === undefined ? {} : { POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED: confirmed }),
        },
        async () => {
          const entry = await checkRowLevelSecurityHealth();

          assert.equal(entry.status, "error", `confirmed=${JSON.stringify(confirmed)}`);
          assert.equal(entry.mode, "off");
          assert.equal("acknowledged" in entry, false);
          assert.match(entry.message, /API_AUTH_ENABLED=true/);
          assert.match(entry.message, /POSTGRES_ROW_LEVEL_SECURITY=enforce/);
          assert.match(entry.message, /POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED=true/);
        }
      );
    }
  });

  test("auth on with the acknowledgement stays disabled, as the operator's decision", async () => {
    for (const confirmed of ["true", "TRUE", " True "]) {
      await withEnv(
        {
          API_AUTH_ENABLED: "true",
          API_AUTH_TOKEN: "local-test-token",
          POSTGRES_DATABASE_URL: NEVER_CONNECTED_URL,
          POSTGRES_ROW_LEVEL_SECURITY: "off",
          POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED: confirmed,
        },
        async () => {
          const entry = await checkRowLevelSecurityHealth();

          assert.equal(entry.status, "disabled");
          assert.equal(entry.mode, "off");
          assert.equal(entry.acknowledged, true);
          assert.match(entry.message, /by operator decision/);
          assert.match(entry.message, /POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED=true/);
        }
      );
    }
  });

  test("without PostgreSQL nothing changes, auth on or off", async () => {
    for (const auth of [{}, { API_AUTH_ENABLED: "true", API_AUTH_TOKEN: "local-test-token" }]) {
      await withEnv({ ...auth, POSTGRES_ROW_LEVEL_SECURITY: "off" }, async () => {
        assert.deepEqual(await checkRowLevelSecurityHealth(), {
          message: "PostgreSQL is not configured; no row-level security applies.",
          mode: "off",
          status: "disabled",
        });
      });
    }
  });

  test("the acknowledgement getter accepts only the literal true", async () => {
    const cases = [
      [undefined, false],
      ["", false],
      ["  ", false],
      ["1", false],
      ["yes", false],
      ["on", false],
      ["false", false],
      ["true", true],
      ["TRUE", true],
      ["\ttrue ", true],
    ];

    for (const [value, expected] of cases) {
      await withEnv(
        value === undefined ? {} : { POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED: value },
        () => {
          assert.equal(isPostgresRowLevelSecurityOffConfirmed(), expected, JSON.stringify(value));
        }
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 1.6: what the probes answer to whom.
// ---------------------------------------------------------------------------

// A report whose details a caller without admin.status.read must not see.
const DETAILED_REPORT = Object.freeze({
  checkedAt: "2026-10-17T00:00:00.000Z",
  checks: {
    documentStore: { message: "rag_documents on db.internal:5432", status: "ok" },
  },
  service: { role: "all" },
  status: "ok",
});
const FAILING_REPORT = Object.freeze({
  checkedAt: "2026-10-17T00:00:00.000Z",
  checks: {
    vectorStore: { message: "connect ECONNREFUSED 10.0.0.5:5432", status: "error" },
  },
  service: { role: "all" },
  status: "error",
});
const THROWN_MESSAGE = "health failed at 10.0.0.5:5432";

const JWT_SECRET = "health-access-test-secret";
const JWT_ENV = {
  API_AUTH_JWT_AUDIENCE: "archive-rag",
  API_AUTH_JWT_ENABLED: "true",
  API_AUTH_JWT_HS256_SECRET: JWT_SECRET,
  API_AUTH_JWT_ISSUER: "https://issuer.example",
};

const TOKENS = {
  // An ordinary tenant token: no admin permission.
  "member-token": { userId: "alice", workspaceId: "ws-a" },
  // admin.viewer carries admin.status.read (rag/admin-permissions.js).
  "viewer-token": { roles: ["admin.viewer"], userId: "ops", workspaceId: "ws-a" },
  "permission-token": { permissions: ["admin.status.read"], userId: "ops-2", workspaceId: "ws-a" },
  // A platform admin with no user, workspace or workspace list.
  "platform-token": { roles: ["admin.viewer"] },
  // Tenantless with a workspace list: requireApiAuth would refuse it on a
  // tenant route without x-workspace-id, but the health report is no tenant's
  // data and admin.viewer is a global role, so it reads the details.
  "multi-workspace-admin-token": { roles: ["admin.viewer"], workspaces: ["ws-a", "ws-b"] },
  // RBAC roles: a global workspace.admin grants admin.status.read only under
  // RBAC_MODE=enforce, and a workspace role never grants an admin permission.
  "global-workspace-admin-token": { roles: ["workspace.admin"], userId: "wsadmin", workspaceId: "ws-a" },
  "scoped-workspace-admin-token": {
    userId: "wsadmin-2",
    workspaceId: "ws-a",
    workspaceRoles: { "ws-a": ["workspace.admin"] },
  },
};

const authEnv = (extra = {}) => ({
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify(TOKENS),
  ...JWT_ENV,
  ...extra,
});

const createHealthService = () => {
  const state = { mode: "ok" };

  return {
    service: {
      buildHealthReport: async () => {
        if (state.mode === "throw") {
          throw new Error(THROWN_MESSAGE);
        }

        return structuredClone(state.mode === "error" ? FAILING_REPORT : DETAILED_REPORT);
      },
      runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
    },
    state,
  };
};

// Every store the defaults would put on PostgreSQL is passed in-memory.
const createApp = (tempRoot, healthService) =>
  createProductionApp({
    adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore() }),
    agentRunStore: createInMemoryAgentRunStore(),
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService,
    ingestJobStore: createInMemoryIngestJobStore(),
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeLongMemory: async () => true,
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
    },
    taskStore: createInMemoryTaskStore(),
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
  });

const startServer = async (app) => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
};

const get = async (server, requestPath, headers = {}) => {
  const response = await fetch(`${server.baseUrl}${requestPath}`, { headers });

  return {
    body: await response.json(),
    cacheControl: response.headers.get("cache-control"),
    status: response.status,
  };
};

const apiKey = (token) => ({ "x-api-key": token });
const bearer = (token) => ({ authorization: `Bearer ${token}` });

const jwt = (claims = {}) =>
  createHs256Jwt({
    payload: {
      aud: "archive-rag",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://issuer.example",
      sub: "jwt-user",
      workspace_id: "ws-a",
      ...claims,
    },
    secret: JWT_SECRET,
  });

// Runs `work` against a fresh app built under `env` (createApp reads the RBAC
// and token configuration at start).
const withServer = async (env, work) =>
  withEnv(env, async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "health-access-"));
    const health = createHealthService();
    const server = await startServer(await createApp(tempRoot, health.service));

    try {
      return await work(server, health.state);
    } finally {
      await server.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

const assertStatusOnly = async (server, headers, label) => {
  const health = await get(server, "/health", headers);
  const ready = await get(server, "/ready", headers);
  const livez = await get(server, "/livez", headers);

  assert.equal(health.status, 200, `${label} /health`);
  assert.deepEqual(health.body, { status: "ok" }, `${label} /health`);
  assert.equal(ready.status, 200, `${label} /ready`);
  assert.deepEqual(ready.body, { status: "ok" }, `${label} /ready`);
  assert.equal(livez.status, 200, `${label} /livez`);
  assert.deepEqual(livez.body, { status: "ok" }, `${label} /livez`);

  for (const response of [health, ready, livez]) {
    assert.equal(response.cacheControl, "no-store", `${label} cache-control`);
  }
};

const assertDetailed = async (server, headers, label) => {
  const health = await get(server, "/health", headers);
  const ready = await get(server, "/ready", headers);
  const livez = await get(server, "/livez", headers);

  assert.equal(health.status, 200, `${label} /health`);
  assert.deepEqual(health.body, DETAILED_REPORT, `${label} /health`);
  assert.equal(ready.status, 200, `${label} /ready`);
  assert.deepEqual(ready.body, DETAILED_REPORT, `${label} /ready`);
  assert.deepEqual(livez.body, { role: "all", status: "ok" }, `${label} /livez`);
};

describe("GET /health, /ready and /livez", () => {
  test("auth off: the full report for everyone, as before", async () => {
    await withServer({}, async (server, state) => {
      const health = await get(server, "/health");
      const ready = await get(server, "/ready");
      const livez = await get(server, "/livez");

      assert.deepEqual(health.body, DETAILED_REPORT);
      assert.deepEqual(ready.body, DETAILED_REPORT);
      assert.deepEqual(livez.body, { role: "all", status: "ok" });
      // No new caching header when the body does not depend on a credential.
      assert.notEqual(health.cacheControl, "no-store");

      state.mode = "error";
      const failingReady = await get(server, "/ready");
      assert.equal(failingReady.status, 503);
      assert.deepEqual(failingReady.body, FAILING_REPORT);

      state.mode = "throw";
      const thrownHealth = await get(server, "/health");
      assert.equal(thrownHealth.status, 500);
      assert.deepEqual(thrownHealth.body, { error: THROWN_MESSAGE, status: "error" });
    });
  });

  test("auth on: no credential, an unknown one, or one without admin.status.read gets the status alone", async () => {
    await withServer(authEnv(), async (server) => {
      await assertStatusOnly(server, {}, "no credential");
      await assertStatusOnly(server, apiKey("not-a-token"), "unknown key");
      await assertStatusOnly(server, bearer("not.a.jwt"), "malformed bearer");
      await assertStatusOnly(server, apiKey("member-token"), "member");
      await assertStatusOnly(server, bearer(jwt()), "JWT without roles");
      // RBAC off: the RBAC role names grant no admin permission.
      await assertStatusOnly(server, apiKey("global-workspace-admin-token"), "workspace.admin, RBAC off");
      // A scope requireApiAuth would refuse (a workspace outside the token's)
      // withholds the details instead of answering 403, so a probe keeps 200.
      await assertStatusOnly(
        server,
        { ...apiKey("viewer-token"), "x-workspace-id": "ws-b" },
        "workspace outside scope"
      );
    });
  });

  test("auth on: admin.status.read reads the full report, however it is granted", async () => {
    await withServer(authEnv(), async (server) => {
      await assertDetailed(server, apiKey("viewer-token"), "admin.viewer by x-api-key");
      await assertDetailed(server, bearer("viewer-token"), "admin.viewer by bearer");
      await assertDetailed(server, apiKey("permission-token"), "explicit permission");
      await assertDetailed(server, apiKey("platform-token"), "tenantless platform admin");
      await assertDetailed(server, apiKey("multi-workspace-admin-token"), "admin with a workspace list");
      await assertDetailed(server, bearer(jwt({ roles: ["admin.viewer"] })), "JWT with admin.viewer");
    });
  });

  test("auth on: a failing or throwing report keeps its status code and withholds its details", async () => {
    await withServer(authEnv(), async (server, state) => {
      state.mode = "error";

      let ready = await get(server, "/ready");
      assert.equal(ready.status, 503);
      assert.deepEqual(ready.body, { status: "error" });

      let health = await get(server, "/health");
      assert.equal(health.status, 200);
      assert.deepEqual(health.body, { status: "error" });

      ready = await get(server, "/ready", apiKey("viewer-token"));
      assert.equal(ready.status, 503);
      assert.deepEqual(ready.body, FAILING_REPORT);

      state.mode = "throw";

      health = await get(server, "/health");
      assert.equal(health.status, 500);
      assert.deepEqual(health.body, { status: "error" });
      ready = await get(server, "/ready", apiKey("member-token"));
      assert.equal(ready.status, 503);
      assert.deepEqual(ready.body, { status: "error" });

      health = await get(server, "/health", apiKey("viewer-token"));
      assert.equal(health.status, 500);
      assert.deepEqual(health.body, { error: THROWN_MESSAGE, status: "error" });
    });
  });

  test("RBAC enforce: a global workspace.admin reads the details, a workspace-scoped one does not", async () => {
    await withServer(authEnv({ RBAC_MODE: "enforce" }), async (server) => {
      await assertDetailed(server, apiKey("global-workspace-admin-token"), "global workspace.admin");
      await assertDetailed(server, apiKey("viewer-token"), "admin.viewer");
      // admin.* never comes from a workspace role (rag/rbac.js).
      await assertStatusOnly(server, apiKey("scoped-workspace-admin-token"), "workspace role");
      // RBAC_DEFAULT_ROLE (workspace.member) grants no admin permission.
      await assertStatusOnly(server, apiKey("member-token"), "default role");
    });
  });

  test("OIDC (the asynchronous verifier): the token's roles decide, an unverifiable token gets the status alone", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const kid = "health-ed-1";
    const jwk = { ...publicKey.export({ format: "jwk" }), alg: "EdDSA", kid, use: "sig" };
    let issuer = "";
    const idp = createServer((req, res) => {
      res.setHeader("content-type", "application/json");

      if (req.url === "/.well-known/openid-configuration") {
        res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      } else if (req.url === "/jwks") {
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });

    await new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${idp.address().port}`;

    const sign = (extraClaims = {}, signingKey = privateKey) => {
      const now = Math.floor(Date.now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const input = `${encode({ alg: "EdDSA", kid, typ: "at+jwt" })}.${encode({
        aud: "archive-rag-api",
        exp: now + 300,
        iat: now,
        iss: issuer,
        sub: "oidc-user",
        workspace_id: "ws-a",
        ...extraClaims,
      })}`;

      return `${input}.${crypto.sign(null, Buffer.from(input), signingKey).toString("base64url")}`;
    };

    resetDefaultOidcVerifier();

    try {
      await withServer(
        {
          API_AUTH_ENABLED: "true",
          API_AUTH_OIDC_AUDIENCE: "archive-rag-api",
          API_AUTH_OIDC_ENABLED: "true",
          API_AUTH_OIDC_ISSUER: issuer,
        },
        async (server) => {
          await assertDetailed(server, bearer(sign({ roles: ["admin.viewer"] })), "OIDC admin.viewer");
          await assertStatusOnly(server, bearer(sign()), "OIDC without roles");
          await assertStatusOnly(
            server,
            bearer(sign({ roles: ["admin.viewer"] }, crypto.generateKeyPairSync("ed25519").privateKey)),
            "OIDC with a foreign signature"
          );
        }
      );
    } finally {
      resetDefaultOidcVerifier();
      idp.closeAllConnections?.();
      await new Promise((resolve) => idp.close(resolve));
    }
  });

  test("the single shared API_AUTH_TOKEN (single-tenant setup) reads the health details, though it holds no admin permission", async () => {
    await withServer(
      { API_AUTH_ENABLED: "true", API_AUTH_TOKEN: "local-test-token" },
      async (server) => {
        // It already acts for the whole archive, and the runbooks tell its
        // operator to read the checks; a wrong token still gets the status.
        await assertDetailed(server, apiKey("local-test-token"), "single token");
        await assertStatusOnly(server, apiKey("wrong-token"), "wrong single token");
        // GET /admin/status still needs the admin permission.
        const adminStatus = await fetch(`${server.baseUrl}/admin/status`, {
          headers: apiKey("local-test-token"),
        });

        assert.equal(adminStatus.status, 403);
      }
    );
  });
});
