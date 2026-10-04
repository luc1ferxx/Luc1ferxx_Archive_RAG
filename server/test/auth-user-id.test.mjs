// Which user a request acts for under API auth (auth.js resolveUserId and
// resolveRequestUserId, routes/helpers.js resolveScopedUserId).
//
// Before: an API_AUTH_TOKENS entry without a userId let the client name any
// user through the x-user-id header, a userId query parameter or a JSON body
// field, so a holder of a workspace token read and deleted another user's
// documents and long-term memory. Now only auth off, the single API_AUTH_TOKEN
// and an entry with "allowClientUserId": true take the client's user. A
// principal with its own userId acts as itself and ignores a client userId (as
// before); any other principal acts as no user, and a request that names one
// is refused with 403 (an empty value is ignored).
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { createApp } from "../app.js";
import { createHs256Jwt } from "../auth-jwt.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { documentMatchesAccessScope } from "../rag/doc-registry.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { resolveScopedUserId } from "../routes/helpers.js";

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const AUTH_ENV_KEYS = [
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_AUDIENCE",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_JWT_HS256_SECRET",
  "API_AUTH_JWT_ISSUER",
  "API_AUTH_JWT_SECRET",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_REQUIRE_WORKSPACE",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "RBAC_MODE",
];

const TOKEN_MAP = {
  // A workspace token without a user: the shape the review found.
  "workspace-token": { workspaceId: "ws-a" },
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
  "delegating-token": { allowClientUserId: true, workspaceId: "ws-a" },
  // Only the JSON literal true opts in.
  "string-flag-token": { allowClientUserId: "true", workspaceId: "ws-a" },
};

const withEnv = async (values, run) => {
  const original = new Map(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of AUTH_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return await run();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const createFixture = () => {
  const documents = new Map(
    [
      { docId: "doc-alice", fileName: "alice.pdf", ownerUserId: "alice", workspaceId: "ws-a" },
      { docId: "doc-bob", fileName: "bob.pdf", ownerUserId: "bob", workspaceId: "ws-a" },
      { docId: "doc-shared", fileName: "shared.pdf", ownerUserId: "", workspaceId: "ws-a" },
    ].map((document) => [document.docId, document])
  );
  const memoryCalls = [];
  const deleteScopes = [];
  const visible = (accessScope) =>
    [...documents.values()].filter((document) =>
      documentMatchesAccessScope(document, accessScope)
    );
  const ragService = {
    initializeDocumentRegistry: async () => [],
    initializeSessionMemory: async () => true,
    listDocuments: (accessScope) => visible(accessScope),
    getDocumentFile: async (docId, accessScope) => {
      const document = documents.get(docId);

      return document && documentMatchesAccessScope(document, accessScope)
        ? {
            document,
            fileBuffer: Buffer.from(`%PDF-1.4 ${docId}`),
            fileName: document.fileName,
            mimeType: "application/pdf",
          }
        : null;
    },
    deleteDocument: async (docId, { accessScope }) => {
      deleteScopes.push(accessScope);
      const document = documents.get(docId);

      if (!document || !documentMatchesAccessScope(document, accessScope)) {
        return null;
      }

      documents.delete(docId);
      return document;
    },
    listLongMemories: async ({ userId }) => {
      memoryCalls.push(["list", userId]);
      return [{ memoryId: `m-${userId}`, userId }];
    },
    rememberLongMemory: async ({ userId, text }) => {
      memoryCalls.push(["remember", userId]);
      return { memoryId: "m-new", text, userId };
    },
    deleteLongMemory: async ({ userId, memoryId }) => {
      memoryCalls.push(["delete", userId]);
      return { memoryId, userId };
    },
    clearLongMemories: async ({ userId }) => {
      memoryCalls.push(["clear", userId]);
      return 1;
    },
  };

  return { deleteScopes, documents, memoryCalls, ragService };
};

const startFixtureServer = async () => {
  const fixture = createFixture();
  const app = await createApp({
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService: {
      buildHealthReport: async () => ({ checks: {}, status: "ok" }),
      runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
    },
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService: fixture.ragService,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  // node:http rather than fetch, so a GET can carry a JSON body too: the body
  // is one of the three places a client userId was read from.
  const call = (method, path, { body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = httpRequest(
        {
          headers: {
            ...headers,
            ...(payload
              ? { "content-length": payload.length, "content-type": "application/json" }
              : {}),
          },
          host: "127.0.0.1",
          method,
          path,
          port,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            resolve({ json, status: res.statusCode, text });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });

  return {
    ...fixture,
    call,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const listedIds = (response) => response.json.map((document) => document.docId).sort();

// The three ways a client named a user, for one target user.
const injections = (userId) => [
  { label: "header", headers: { "x-user-id": userId } },
  { label: "query", query: `userId=${encodeURIComponent(userId)}` },
  { label: "body", body: { userId } },
  { label: "x-user-id query", query: `x-user-id=${encodeURIComponent(userId)}` },
  { label: "x-user-id body", body: { "x-user-id": userId } },
];

const withQuery = (path, query) =>
  query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;

test("a token entry without a userId cannot act as another user on /documents (list, file, delete)", async () => {
  await withEnv(
    { API_AUTH_ENABLED: "true", API_AUTH_TOKENS: JSON.stringify(TOKEN_MAP) },
    async () => {
      const server = await startFixtureServer();
      const auth = { "x-api-key": "workspace-token" };

      try {
        // Without a userId the token sees only the workspace's unowned documents.
        let response = await server.call("GET", "/documents", { headers: auth });
        assert.equal(response.status, 200);
        assert.deepEqual(listedIds(response), ["doc-shared"]);

        for (const injection of injections("alice")) {
          const options = { body: injection.body, headers: { ...auth, ...injection.headers } };

          response = await server.call("GET", withQuery("/documents", injection.query), options);
          assert.equal(response.status, 403, `list via ${injection.label}`);
          assert.doesNotMatch(response.text, /alice\.pdf/);

          response = await server.call(
            "GET",
            withQuery("/documents/doc-alice/file", injection.query),
            options
          );
          assert.equal(response.status, 403, `file via ${injection.label}`);
          assert.doesNotMatch(response.text, /PDF-1\.4/);

          response = await server.call(
            "DELETE",
            withQuery("/documents/doc-alice", injection.query),
            options
          );
          assert.equal(response.status, 403, `delete via ${injection.label}`);
        }

        assert.equal(server.documents.has("doc-alice"), true);
        assert.deepEqual(server.deleteScopes, [], "the delete never reached the store");

        // Empty client values are ignored, not refused.
        response = await server.call("GET", "/documents?userId=", {
          headers: { ...auth, "x-user-id": "  " },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(listedIds(response), ["doc-shared"]);

        // The owned document stays invisible to the token's own scope.
        response = await server.call("GET", "/documents/doc-alice/file", { headers: auth });
        assert.equal(response.status, 404);
        response = await server.call("DELETE", "/documents/doc-alice", { headers: auth });
        assert.equal(response.status, 404);
        assert.equal(server.documents.has("doc-alice"), true);
      } finally {
        await server.close();
      }
    }
  );
});

test("a token entry without a userId cannot read or change another user's long-term memory", async () => {
  await withEnv(
    { API_AUTH_ENABLED: "true", API_AUTH_TOKENS: JSON.stringify(TOKEN_MAP) },
    async () => {
      const server = await startFixtureServer();
      const auth = { "x-api-key": "workspace-token" };
      const routes = [
        ["GET", "/memory"],
        ["POST", "/memory"],
        ["DELETE", "/memory/m-alice"],
        ["DELETE", "/memory"],
      ];

      try {
        for (const [method, path] of routes) {
          for (const injection of injections("alice")) {
            const body =
              method === "POST" ? { text: "note", ...(injection.body ?? {}) } : injection.body;
            const response = await server.call(method, withQuery(path, injection.query), {
              body,
              headers: { ...auth, ...injection.headers },
            });
            assert.equal(response.status, 403, `${method} ${path} via ${injection.label}`);
          }
        }

        // No user of its own and none it may choose: the route asks for one.
        const response = await server.call("GET", "/memory", { headers: auth });
        assert.equal(response.status, 400);
        assert.deepEqual(server.memoryCalls, []);

        // The same refusal covers the other routes that take a client userId.
        for (const [path, body] of [
          ["/chat", { question: "What changed?", userId: "alice" }],
          ["/agent-tasks", { question: "What changed?", userId: "alice" }],
        ]) {
          const refused = await server.call("POST", path, { body, headers: auth });
          assert.equal(refused.status, 403, path);
        }
      } finally {
        await server.close();
      }
    }
  );
});

test("a token with its own userId always acts as that user, whatever the client names", async () => {
  await withEnv(
    { API_AUTH_ENABLED: "true", API_AUTH_TOKENS: JSON.stringify(TOKEN_MAP) },
    async () => {
      const server = await startFixtureServer();
      const auth = { "x-api-key": "alice-token" };

      try {
        // A differing client userId is ignored (the contract app.test.mjs and
        // service-roles.test.mjs pin), never used.
        for (const injection of injections("bob")) {
          let response = await server.call("GET", withQuery("/documents", injection.query), {
            body: injection.body,
            headers: { ...auth, ...injection.headers },
          });
          assert.equal(response.status, 200, `list via ${injection.label}`);
          assert.deepEqual(listedIds(response), ["doc-alice", "doc-shared"]);

          response = await server.call(
            "GET",
            withQuery("/documents/doc-bob/file", injection.query),
            { body: injection.body, headers: { ...auth, ...injection.headers } }
          );
          assert.equal(response.status, 404, `file via ${injection.label}`);

          response = await server.call(
            "DELETE",
            withQuery("/documents/doc-bob", injection.query),
            { body: injection.body, headers: { ...auth, ...injection.headers } }
          );
          assert.equal(response.status, 404, `delete via ${injection.label}`);
        }

        assert.equal(server.documents.has("doc-bob"), true);

        let response = await server.call("GET", "/memory?userId=bob", {
          headers: { ...auth, "x-user-id": "bob" },
        });
        assert.equal(response.status, 200);
        response = await server.call("POST", "/memory", {
          body: { text: "note", userId: "bob" },
          headers: auth,
        });
        assert.equal(response.status, 201);
        assert.deepEqual(server.memoryCalls, [
          ["list", "alice"],
          ["remember", "alice"],
        ]);
      } finally {
        await server.close();
      }
    }
  );
});

test("allowClientUserId: true keeps the client-chosen user; any other value does not opt in", async () => {
  await withEnv(
    { API_AUTH_ENABLED: "true", API_AUTH_TOKENS: JSON.stringify(TOKEN_MAP) },
    async () => {
      const server = await startFixtureServer();
      const auth = { "x-api-key": "delegating-token" };

      try {
        let response = await server.call("GET", "/documents", {
          headers: { ...auth, "x-user-id": "alice" },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(listedIds(response), ["doc-alice", "doc-shared"]);

        response = await server.call("GET", "/documents/doc-bob/file?userId=bob", { headers: auth });
        assert.equal(response.status, 200);
        assert.match(response.text, /doc-bob/);

        response = await server.call("POST", "/memory", {
          body: { text: "note", userId: "bob" },
          headers: auth,
        });
        assert.equal(response.status, 201);
        response = await server.call("GET", "/memory?userId=alice", { headers: auth });
        assert.equal(response.status, 200);
        assert.deepEqual(server.memoryCalls, [
          ["remember", "bob"],
          ["list", "alice"],
        ]);

        response = await server.call("DELETE", "/documents/doc-alice", {
          body: { userId: "alice" },
          headers: auth,
        });
        assert.equal(response.status, 200);
        assert.equal(server.documents.has("doc-alice"), false);

        response = await server.call("GET", "/documents", {
          headers: { "x-api-key": "string-flag-token", "x-user-id": "bob" },
        });
        assert.equal(response.status, 403);
      } finally {
        await server.close();
      }
    }
  );
});

test("the single API_AUTH_TOKEN and auth off keep the client-chosen user", async () => {
  for (const env of [
    { API_AUTH_ENABLED: "true", API_AUTH_TOKEN: "local-token", API_AUTH_TOKENS: "" },
    { API_AUTH_ENABLED: "false" },
  ]) {
    await withEnv(env, async () => {
      const server = await startFixtureServer();
      const auth = env.API_AUTH_TOKEN ? { "x-api-key": env.API_AUTH_TOKEN } : {};

      try {
        let response = await server.call("GET", "/documents", {
          headers: { ...auth, "x-user-id": "alice", "x-workspace-id": "ws-a" },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(listedIds(response), ["doc-alice", "doc-shared"]);

        response = await server.call("GET", "/documents/doc-bob/file?userId=bob&workspaceId=ws-a", {
          headers: auth,
        });
        assert.equal(response.status, 200);

        response = await server.call("GET", "/memory?userId=alice", { headers: auth });
        assert.equal(response.status, 200);
        response = await server.call("POST", "/memory", {
          body: { text: "note", userId: "bob" },
          headers: auth,
        });
        assert.equal(response.status, 201);
        response = await server.call("DELETE", "/memory?userId=carol", { headers: auth });
        assert.equal(response.status, 200);
        assert.deepEqual(server.memoryCalls, [
          ["list", "alice"],
          ["remember", "bob"],
          ["clear", "carol"],
        ]);

        response = await server.call("DELETE", "/documents/doc-bob", {
          headers: { ...auth, "x-user-id": "bob", "x-workspace-id": "ws-a" },
        });
        assert.equal(response.status, 200);
      } finally {
        await server.close();
      }
    });
  }
});

test("an HS256 JWT principal always acts as its own user", async () => {
  const secret = "auth-user-id-test-secret";

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_JWT_AUDIENCE: "archive-rag",
      API_AUTH_JWT_ENABLED: "true",
      API_AUTH_JWT_HS256_SECRET: secret,
      API_AUTH_JWT_ISSUER: "https://issuer.example",
    },
    async () => {
      const server = await startFixtureServer();
      const token = createHs256Jwt({
        payload: {
          // A claim of that name grants nothing: the flag is set by auth.js only.
          allowClientUserId: true,
          aud: "archive-rag",
          exp: Math.floor(Date.now() / 1000) + 60,
          iss: "https://issuer.example",
          sub: "alice",
          workspace_id: "ws-a",
        },
        secret,
      });
      const auth = { authorization: `Bearer ${token}`, "x-workspace-id": "ws-a" };

      try {
        let response = await server.call("GET", "/documents", { headers: auth });
        assert.equal(response.status, 200);
        assert.deepEqual(listedIds(response), ["doc-alice", "doc-shared"]);

        response = await server.call("GET", "/documents", {
          headers: { ...auth, "x-user-id": "bob" },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(listedIds(response), ["doc-alice", "doc-shared"]);
        response = await server.call("GET", "/memory?userId=bob", { headers: auth });
        assert.equal(response.status, 200);
        assert.deepEqual(server.memoryCalls, [["list", "alice"]]);
      } finally {
        await server.close();
      }
    }
  );
});

test("routes never take a raw userId once the scope is authenticated", () => {
  // The agent tier gets the scope from the edge's token, not from requireApiAuth.
  const scoped = (accessScope) => ({ accessScope });

  assert.equal(resolveScopedUserId(scoped({ authenticated: true, userId: "" }), "alice"), "");
  assert.equal(resolveScopedUserId(scoped({ authenticated: true, userId: "bob" }), "alice"), "bob");
  assert.equal(resolveScopedUserId(scoped({ authenticated: false, userId: "" }), " alice "), "alice");
  assert.equal(resolveScopedUserId(scoped({ authenticated: false, userId: "bob" }), "alice"), "bob");
  assert.equal(resolveScopedUserId({}, "alice"), "alice");
  assert.equal(resolveScopedUserId({}, 42), "");
});
