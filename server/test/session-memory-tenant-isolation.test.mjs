import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";

import {
  clearSessionMemory,
  configureSessionMemoryStore,
  recordSessionTurn,
  resetSessionMemoryStore,
  resolveQueryWithSessionMemory,
  resolveSessionMemoryKey,
} from "../rag/memory.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { createMemoryRouter } from "../routes/memory.js";

// Session memory is keyed by a client-chosen id. These tests pin that, with
// API auth on, two tenants who use the same id get two sessions in any store
// (the key carries the tenant), and that auth off keeps the raw id.

const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-a" };
const BOB = { authenticated: true, userId: "bob", workspaceId: "ws-b" };
const SESSION_ID = "client-session-1";

const createRecordingStore = () => {
  const sessions = new Map();
  const reads = [];

  return {
    reads,
    sessions,
    async get(sessionKey) {
      reads.push(sessionKey);
      const session = sessions.get(sessionKey);
      return session ? structuredClone(session) : null;
    },
    async upsert({ sessionId, messages, updatedAt }) {
      sessions.set(sessionId, { messages: structuredClone(messages), updatedAt });
      return structuredClone(sessions.get(sessionId));
    },
    async delete(sessionKey) {
      return sessions.delete(sessionKey);
    },
  };
};

const recordTurn = (accessScope, text, sessionId = SESSION_ID) =>
  recordSessionTurn({
    accessScope,
    answer: `${text} answer`,
    documents: [{ fileName: "policy.pdf" }],
    query: text,
    resolvedQuery: text,
    routeMode: "qa",
    sessionId,
  });

const messagesOf = (store, key) => (store.sessions.get(key)?.messages ?? []).map((m) => m.text);

let store;
let savedAuth;

beforeEach(() => {
  savedAuth = process.env.API_AUTH_ENABLED;
  process.env.API_AUTH_ENABLED = "true";
  store = createRecordingStore();
  configureSessionMemoryStore(store);
});

afterEach(async () => {
  if (savedAuth === undefined) {
    delete process.env.API_AUTH_ENABLED;
  } else {
    process.env.API_AUTH_ENABLED = savedAuth;
  }

  await resetSessionMemoryStore();
});

test("the tenant key is sha256(userId \\0 workspaceId \\0 sessionId) and never the raw id", () => {
  const expected = createHash("sha256")
    .update(`alice\u0000ws-a\u0000${SESSION_ID}`)
    .digest("hex");

  assert.equal(resolveSessionMemoryKey(` ${SESSION_ID} `, ALICE), `tenant:${expected}`);
  assert.notEqual(resolveSessionMemoryKey(SESSION_ID, ALICE), resolveSessionMemoryKey(SESSION_ID, BOB));
  assert.equal(resolveSessionMemoryKey("   ", ALICE), "");
  // The separator keeps ("ab", "c") and ("a", "bc") apart.
  assert.notEqual(
    resolveSessionMemoryKey("s", { authenticated: true, userId: "ab", workspaceId: "c" }),
    resolveSessionMemoryKey("s", { authenticated: true, userId: "a", workspaceId: "bc" })
  );
});

test("two tenants with the same session id neither see, extend nor clear each other's turns", async () => {
  await recordTurn(ALICE, "alice first");
  await recordTurn(BOB, "bob first");
  await recordTurn(ALICE, "alice second");

  const aliceKey = resolveSessionMemoryKey(SESSION_ID, ALICE);
  const bobKey = resolveSessionMemoryKey(SESSION_ID, BOB);

  assert.equal(store.sessions.size, 2);
  assert.equal(store.sessions.has(SESSION_ID), false, "the raw client id is never a key");
  assert.deepEqual(messagesOf(store, aliceKey), [
    "alice first",
    "alice first answer",
    "alice second",
    "alice second answer",
  ]);
  assert.deepEqual(messagesOf(store, bobKey), ["bob first", "bob first answer"]);

  // Bob's follow-up reads only bob's session.
  store.reads.length = 0;
  await resolveQueryWithSessionMemory({
    accessScope: BOB,
    documents: [],
    query: "what about it?",
    sessionId: SESSION_ID,
  }).catch(() => null);
  assert.deepEqual(store.reads, [bobKey]);

  // Bob clears only his own session; alice's is untouched.
  assert.equal(await clearSessionMemory(SESSION_ID, BOB), true);
  assert.equal(await clearSessionMemory(SESSION_ID, BOB), false);
  assert.equal(store.sessions.has(aliceKey), true);
  assert.equal(messagesOf(store, aliceKey).length, 4);
});

test("a tenant without a session reads nothing even when another tenant used the id", async () => {
  await recordTurn(ALICE, "alice secret question");

  const resolution = await resolveQueryWithSessionMemory({
    accessScope: BOB,
    documents: [],
    // A follow-up shape: it would be rewritten if bob had any session turns.
    query: "and that?",
    sessionId: SESSION_ID,
  });

  assert.deepEqual(resolution, { memoryApplied: false, resolvedQuery: "and that?" });
});

test("the same user in two workspaces gets two sessions", async () => {
  const workspaceA = { authenticated: true, userId: "alice", workspaceId: "ws-a" };
  const workspaceB = { authenticated: true, userId: "alice", workspaceId: "ws-b" };

  await recordTurn(workspaceA, "in workspace a");
  await recordTurn(workspaceB, "in workspace b");

  const keyA = resolveSessionMemoryKey(SESSION_ID, workspaceA);
  const keyB = resolveSessionMemoryKey(SESSION_ID, workspaceB);

  assert.notEqual(keyA, keyB);
  assert.deepEqual(messagesOf(store, keyA), ["in workspace a", "in workspace a answer"]);
  assert.deepEqual(messagesOf(store, keyB), ["in workspace b", "in workspace b answer"]);
  assert.equal(await clearSessionMemory(SESSION_ID, workspaceB), true);
  assert.equal(store.sessions.has(keyA), true);
});

test("a background task's stored scope (no authenticated flag) and the database tenant name the same session", async () => {
  await recordTurn(ALICE, "alice question");

  const aliceKey = resolveSessionMemoryKey(SESSION_ID, ALICE);
  const taskScope = { userId: "alice", workspaceId: "ws-a" };

  assert.equal(resolveSessionMemoryKey(SESSION_ID, taskScope), aliceKey);
  // A caller that passes no scope falls back to the active database tenant.
  assert.equal(
    runWithDatabaseTenant(taskScope, () => resolveSessionMemoryKey(SESSION_ID)),
    aliceKey
  );
  // So does a caller whose scope names no user or workspace.
  assert.equal(
    runWithDatabaseTenant(taskScope, () => resolveSessionMemoryKey(SESSION_ID, {})),
    aliceKey
  );
  assert.equal(
    await runWithDatabaseTenant(BOB, () => clearSessionMemory(SESSION_ID)),
    false,
    "bob's tenant context cannot clear alice's session"
  );
  assert.equal(await runWithDatabaseTenant(taskScope, () => clearSessionMemory(SESSION_ID)), true);
});

test("with auth off the raw session id stays the key, whatever user id the client sends", async () => {
  delete process.env.API_AUTH_ENABLED;

  const localScope = { authenticated: false, userId: "local-user", workspaceId: "" };

  await recordTurn(localScope, "local question");

  assert.deepEqual([...store.sessions.keys()], [SESSION_ID]);
  assert.equal(resolveSessionMemoryKey(SESSION_ID, localScope), SESSION_ID);
  assert.equal(
    runWithDatabaseTenant(localScope, () => resolveSessionMemoryKey(SESSION_ID)),
    SESSION_ID
  );
  // The local frontend sends a userId with every chat but not with the
  // session DELETE; both still name the same session.
  assert.equal(await clearSessionMemory(SESSION_ID, { authenticated: false }), true);
  assert.equal(store.sessions.size, 0);
});

test("DELETE /sessions/:sessionId clears the session of the caller's scope only", async () => {
  await recordTurn(ALICE, "alice question");
  await recordTurn(BOB, "bob question");

  const calls = [];
  const app = express();

  app.use((req, _res, next) => {
    req.accessScope = req.get("x-test-user") === "bob" ? BOB : ALICE;
    next();
  });
  app.use(
    createMemoryRouter({
      ragService: {
        clearSessionMemory: async (sessionId, accessScope) => {
          calls.push({ accessScope, sessionId });
          return clearSessionMemory(sessionId, accessScope);
        },
      },
    })
  );

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION_ID}`, {
      headers: { "x-test-user": "bob" },
      method: "DELETE",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cleared: true });
    assert.deepEqual(calls, [{ accessScope: BOB, sessionId: SESSION_ID }]);
    assert.equal(store.sessions.has(resolveSessionMemoryKey(SESSION_ID, ALICE)), true);
    assert.equal(store.sessions.has(resolveSessionMemoryKey(SESSION_ID, BOB)), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a tenant-less caller cannot name a tenant's derived key as its raw session id", async () => {
  // Auth on, but a credential with neither a user nor a workspace (or auth
  // off): the raw id is the key, so a client id spelled like a derived key
  // would otherwise reach that tenant's session on the owner path.
  await recordTurn(ALICE, "alice private question");

  const aliceKey = resolveSessionMemoryKey(SESSION_ID, ALICE);
  const tenantless = { authenticated: true, userId: "", workspaceId: "" };

  for (const forged of [aliceKey, ` ${aliceKey} `]) {
    assert.equal(resolveSessionMemoryKey(forged, tenantless), "");

    const resolution = await resolveQueryWithSessionMemory({
      accessScope: tenantless,
      sessionId: forged,
      query: "what did I just ask about it?",
      documents: [{ fileName: "policy.pdf" }],
    });
    assert.equal(resolution.memoryApplied, false);
    assert.equal(await recordTurn(tenantless, "injected", forged), null);
    assert.equal(await clearSessionMemory(forged, tenantless), false);
  }

  delete process.env.API_AUTH_ENABLED;
  assert.equal(resolveSessionMemoryKey(aliceKey, { authenticated: false, userId: "x" }), "");
  assert.equal(await clearSessionMemory(aliceKey), false);

  assert.deepEqual(messagesOf(store, aliceKey), ["alice private question", "alice private question answer"]);
  assert.equal(store.reads.includes(aliceKey) && store.reads.every((key) => key === aliceKey), true);
});
