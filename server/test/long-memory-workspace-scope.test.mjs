import test, { afterEach, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
  configureAgentExperienceMemoryStore,
  getAgentExperienceMemoryContext,
  recordAgentExperienceFromRun,
} from "../rag/agent-experience-memory.js";
import { getLongMemoryScope } from "../rag/config.js";
import {
  clearLongMemories,
  configureLongMemoryStore,
  deleteLongMemory,
  getLongMemoryContext,
  listLongMemories,
  longMemoryAppliesToTenantSelector,
  recordLongMemoryFromUserMessage,
  rememberLongMemory,
  resetLongMemoryStore,
  resolveLongMemoryWorkspace,
} from "../rag/long-memory.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { normalizeTenantSelector } from "../rag/tenant-records.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";
import { createMemoryRouter } from "../routes/memory.js";

// LONG_MEMORY_SCOPE=workspace: one user in two workspaces (two tenants) must
// not have a note or an agent experience from one recalled in the other, while
// the fixed-enum preferences follow the user. The default `user` scope keeps
// the store calls, and so the PostgreSQL statements, of before migration 045.
// postgres-row-level-security.integration.test.mjs runs the same rules
// against the real store and the migration 045 policy.

const IN_ACME = Object.freeze({ authenticated: true, userId: "ann", workspaceId: "client-acme" });
const IN_GLOBEX = Object.freeze({ authenticated: true, userId: "ann", workspaceId: "client-globex" });
const ACME_NOTE = "remember that the Acme acquisition of Beta closes in May";
const ACME_QUESTION = "When does the Acme acquisition of Beta close?";

// The store contract of the default PostgreSQL store (rag/long-memory.js), in
// memory: `workspaceId` (a string) limits a call to that workspace's rows and
// the user-level ones (''), as its SQL and migration 045's policy do; without
// it a call sees every row of the user. Every call is recorded as made.
const createRecordingStore = () => {
  const rows = [];
  const calls = [];
  let clock = 0;
  let nextId = 0;
  const sees = (row, userId, workspaceId) =>
    row.userId === userId &&
    (typeof workspaceId !== "string" || row.workspaceId === "" || row.workspaceId === workspaceId);
  const copy = (row) => structuredClone(row);

  return {
    calls,
    rows,
    seed(row) {
      nextId += 1;
      clock += 1;
      rows.push({ memoryId: `m-${nextId}`, updatedAt: clock, workspaceId: "", ...row });
    },
    async list(args) {
      calls.push(["list", args]);
      const { categories, limit, userId, workspaceId } = args;

      return rows
        .filter((row) => sees(row, userId, workspaceId) && categories.includes(row.category))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit)
        .map(copy);
    },
    async remember(args) {
      calls.push(["remember", args]);
      const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : "";
      const category = args.category ?? "note";
      const existing = rows.find(
        (row) =>
          row.userId === args.userId &&
          row.category === category &&
          (typeof args.workspaceId !== "string" || row.workspaceId === workspaceId) &&
          (args.memoryKey ? row.memoryKey === args.memoryKey : row.text === args.text)
      );
      clock += 1;

      if (existing) {
        Object.assign(existing, { memoryValue: args.memoryValue ?? null, text: args.text, updatedAt: clock });
        return copy(existing);
      }

      nextId += 1;
      const row = {
        category,
        memoryId: `m-${nextId}`,
        memoryKey: args.memoryKey ?? null,
        memoryValue: args.memoryValue ?? null,
        text: args.text,
        updatedAt: clock,
        userId: args.userId,
        workspaceId,
      };

      rows.push(row);
      return copy(row);
    },
    async delete(args) {
      calls.push(["delete", args]);
      const index = rows.findIndex(
        (row) => row.memoryId === args.memoryId && sees(row, args.userId, args.workspaceId)
      );

      return index === -1 ? null : copy(rows.splice(index, 1)[0]);
    },
    async clear(args) {
      calls.push(["clear", args]);
      const removed = rows.filter((row) => sees(row, args.userId, args.workspaceId));

      for (const row of removed) rows.splice(rows.indexOf(row), 1);
      return removed.length;
    },
    async touch() {
      return 0;
    },
  };
};

const ENV_NAMES = [
  "API_AUTH_ENABLED",
  "LONG_MEMORY_SCOPE",
  "RAG_AGENT_EXPERIENCE_MEMORY_ENABLED",
  "RAG_LONG_MEMORY_ENABLED",
];

let savedEnv;
let store;

const setScope = (value) => {
  if (value === undefined) {
    delete process.env.LONG_MEMORY_SCOPE;
  } else {
    process.env.LONG_MEMORY_SCOPE = value;
  }
};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env.API_AUTH_ENABLED = "true";
  process.env.RAG_LONG_MEMORY_ENABLED = "true";
  process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED = "true";
  delete process.env.LONG_MEMORY_SCOPE;
  store = createRecordingStore();
  configureLongMemoryStore(store);
  // The default experience store: the one backed by long-term memory.
  configureAgentExperienceMemoryStore(null);
});

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  configureAgentExperienceMemoryStore(null);
  await resetLongMemoryStore();
});

const contextFor = (accessScope, query = ACME_QUESTION) =>
  getLongMemoryContext({ accessScope, query, userId: "ann" });

const recordFrom = (accessScope, query) =>
  recordLongMemoryFromUserMessage({ accessScope, query, userId: "ann" });

describe("LONG_MEMORY_SCOPE", () => {
  test("user by default and for blank values; workspace in any case; anything else refuses", () => {
    for (const value of [undefined, "", "  ", "\t", "user", " USER "]) {
      setScope(value);
      assert.equal(getLongMemoryScope(), "user");
    }

    for (const value of ["workspace", " Workspace "]) {
      setScope(value);
      assert.equal(getLongMemoryScope(), "workspace");
    }

    for (const value of ["tenant", "workspaces", "on"]) {
      setScope(value);
      assert.throws(getLongMemoryScope, (error) => {
        assert.equal(error.code, "LONG_MEMORY_SCOPE_INVALID");
        assert.match(error.message, /LONG_MEMORY_SCOPE must be one of user, workspace/);
        return true;
      });
    }
  });

  test("an unknown value refuses the start of the app", async () => {
    const { createApp } = await import("../app.js");

    delete process.env.API_AUTH_ENABLED;
    setScope("per-workspace");

    await assert.rejects(createApp({}), (error) => error.code === "LONG_MEMORY_SCOPE_INVALID");
  });
});

describe("LONG_MEMORY_SCOPE=user (default)", () => {
  test("the store sees exactly the calls it saw before, and a note follows the user into every workspace", async () => {
    await recordFrom(IN_ACME, ACME_NOTE);
    const inGlobex = await contextFor(IN_GLOBEX);
    const memoryId = store.rows[0].memoryId;

    await listLongMemories({ accessScope: IN_GLOBEX, userId: "ann", limit: 5 });
    await deleteLongMemory({ accessScope: IN_GLOBEX, memoryId: "absent", userId: "ann" });
    await clearLongMemories({ accessScope: IN_GLOBEX, userId: "ann" });

    assert.deepEqual(inGlobex.memories.map((memory) => memory.memoryId), [memoryId]);
    assert.match(inGlobex.answerBlock, /Acme acquisition of Beta closes in May/);
    assert.deepEqual(store.calls, [
      [
        "remember",
        {
          category: "note",
          confidence: 1,
          memoryKey: null,
          memoryValue: null,
          source: "user_explicit",
          text: "the Acme acquisition of Beta closes in May",
          userId: "ann",
        },
      ],
      ["list", { categories: ["preference", "note"], limit: 50, userId: "ann" }],
      ["list", { categories: ["preference", "note"], limit: 5, userId: "ann" }],
      ["delete", { memoryId: "absent", userId: "ann" }],
      ["clear", { userId: "ann" }],
    ]);
    assert.equal(resolveLongMemoryWorkspace(IN_ACME), null);
  });

  test("a tenant erase reaches long memory only through a selector that names a user", () => {
    assert.equal(longMemoryAppliesToTenantSelector(normalizeTenantSelector({ workspaceId: "client-acme" })), false);
    assert.equal(
      longMemoryAppliesToTenantSelector(normalizeTenantSelector({ userId: "ann", workspaceId: "client-acme" })),
      true
    );
  });
});

describe("LONG_MEMORY_SCOPE=workspace", () => {
  beforeEach(() => setScope("workspace"));

  test("a note taken in one workspace is never recalled in the other; the fixed preferences are", async () => {
    await recordFrom(IN_ACME, ACME_NOTE);
    await recordFrom(IN_ACME, "以后用中文回答");

    const inGlobex = await contextFor(IN_GLOBEX);
    const inAcme = await contextFor(IN_ACME);

    assert.deepEqual(
      store.rows.map(({ category, text, workspaceId }) => [category, workspaceId, text]),
      [
        ["note", "client-acme", "the Acme acquisition of Beta closes in May"],
        ["preference", "", "Reply in Chinese by default."],
      ]
    );
    assert.deepEqual(inGlobex.memories.map((memory) => memory.category), ["preference"]);
    assert.match(inGlobex.answerBlock, /Reply language: Chinese\./);
    assert.doesNotMatch(inGlobex.answerBlock, /Acme/);
    assert.doesNotMatch(inGlobex.rewriteBlock, /Acme/);
    assert.deepEqual(inAcme.memories.map((memory) => memory.category).sort(), ["note", "preference"]);
    assert.match(inAcme.answerBlock, /Acme acquisition of Beta closes in May/);
    assert.deepEqual(
      store.calls.filter(([kind]) => kind === "list").map(([, args]) => args.workspaceId),
      ["client-globex", "client-acme"]
    );
  });

  test("rows from before the scope (workspace '') stay visible in every workspace until cleared", async () => {
    store.seed({ category: "note", text: "Globex budget is 2M", userId: "ann" });

    assert.equal((await contextFor(IN_ACME, "What is the Globex budget?")).memories.length, 1);
    assert.equal((await contextFor(IN_GLOBEX, "What is the Globex budget?")).memories.length, 1);

    assert.equal(await clearLongMemories({ accessScope: IN_ACME, userId: "ann" }), 1);
    assert.equal((await contextFor(IN_GLOBEX, "What is the Globex budget?")).memories.length, 0);
  });

  test("the workspace is the caller's scope, else the active database tenant; auth off and a user-only tenant stay user-level", async () => {
    assert.equal(resolveLongMemoryWorkspace(IN_ACME), "client-acme");
    assert.equal(
      runWithDatabaseTenant(IN_GLOBEX, () => resolveLongMemoryWorkspace(null)),
      "client-globex"
    );
    // An explicit scope wins over the bound tenant, as for the session key.
    assert.equal(runWithDatabaseTenant(IN_GLOBEX, () => resolveLongMemoryWorkspace(IN_ACME)), "client-acme");
    assert.equal(resolveLongMemoryWorkspace({ authenticated: true, userId: "ann" }), "");
    assert.equal(resolveLongMemoryWorkspace(null), "");

    delete process.env.API_AUTH_ENABLED;
    assert.equal(resolveLongMemoryWorkspace({ userId: "ann", workspaceId: "client-acme" }), "");
    assert.equal(runWithDatabaseTenant(IN_GLOBEX, () => resolveLongMemoryWorkspace(null)), "");
    // An authenticated scope applies whatever API_AUTH_ENABLED says, as for
    // session memory (a split agent tier gets the edge's signed scope).
    assert.equal(resolveLongMemoryWorkspace(IN_ACME), "client-acme");

    await runWithDatabaseTenant(IN_GLOBEX, () => recordFrom(null, "remember that the Globex launch is in June"));
    assert.equal(store.rows.at(-1).workspaceId, "", "auth off: the bound tenant is no boundary");
  });

  test("a user-level row holds a fixed preference value and its fixed text only", async () => {
    const remember = (input) => rememberLongMemory({ accessScope: IN_ACME, userId: "ann", ...input });

    await remember({
      category: "preference",
      memoryKey: " reply_language ",
      memoryValue: "zh",
      text: "Acme's counsel is Jane Roe",
    });
    await remember({ category: "preference", memoryKey: "reply_language", memoryValue: "fr", text: "fr text" });
    await remember({ category: "preference", memoryKey: "tone", memoryValue: "formal", text: "Acme tone" });
    await remember({ category: "preference", memoryKey: "constructor", memoryValue: "zh", text: "odd key" });
    await remember({ category: "note", memoryKey: "answer_style", memoryValue: "concise", text: "a note" });
    await remember({ category: "custom", text: "free text" });

    assert.deepEqual(
      store.calls.map(([, args]) => [args.memoryKey ?? null, args.workspaceId, args.text]),
      [
        ["reply_language", "", "Reply in Chinese by default."],
        ["reply_language", "client-acme", "fr text"],
        ["tone", "client-acme", "Acme tone"],
        ["constructor", "client-acme", "odd key"],
        ["answer_style", "client-acme", "a note"],
        [null, "client-acme", "free text"],
      ]
    );
  });

  test("delete and clear act on what the workspace sees: the user-level rows included, another workspace's never", async () => {
    await recordFrom(IN_ACME, ACME_NOTE);
    await recordFrom(IN_GLOBEX, "remember that the Globex launch is in June");
    await recordFrom(IN_GLOBEX, "please keep answers concise");

    const acmeNote = store.rows.find((row) => row.workspaceId === "client-acme");

    assert.equal(await deleteLongMemory({ accessScope: IN_GLOBEX, memoryId: acmeNote.memoryId, userId: "ann" }), null);
    assert.equal(await clearLongMemories({ accessScope: IN_GLOBEX, userId: "ann" }), 2);
    assert.deepEqual(store.rows.map((row) => row.memoryId), [acmeNote.memoryId]);
    assert.equal(
      (await deleteLongMemory({ accessScope: IN_ACME, memoryId: acmeNote.memoryId, userId: "ann" })).memoryId,
      acmeNote.memoryId
    );
  });

  test("agent experience is stored and recalled in its workspace only", async () => {
    const response = {
      body: {
        agentMode: "skill_chain",
        agentObservability: {
          skillChain: [
            { skillId: CUSTOM_SKILL_IDS.summarizeContract, skillVersion: "1.0.0" },
            { skillId: CUSTOM_SKILL_IDS.riskReview, skillVersion: "1.0.0" },
          ],
        },
        agentWorkingMemory: { resolvedGaps: [] },
        ragSources: [{ docId: "doc-1", excerpt: "The contract renews annually." }],
      },
      status: 200,
    };
    const question = "Run Acme contract due diligence.";
    const written = await recordAgentExperienceFromRun({ accessScope: IN_ACME, question, response, userId: "ann" });

    assert.equal(written.status, "stored");
    assert.deepEqual(
      store.rows.map(({ category, workspaceId }) => [category, workspaceId]),
      [["agent_experience", "client-acme"]]
    );

    const inGlobex = await getAgentExperienceMemoryContext({ accessScope: IN_GLOBEX, question, userId: "ann" });
    const inAcme = await getAgentExperienceMemoryContext({ accessScope: IN_ACME, question, userId: "ann" });

    assert.deepEqual(inGlobex.planningHints, []);
    assert.equal(inAcme.planningHints.length, 1);
    assert.deepEqual(
      store.calls.filter(([kind]) => kind === "list").map(([, args]) => args.workspaceId),
      ["client-acme", "client-globex", "client-acme"],
      "the write's retention scan, then each read, in the caller's workspace"
    );
  });

  test("a tenant erase reaches long memory through every selector", () => {
    for (const selector of [
      { workspaceId: "client-acme" },
      { userId: "ann", workspaceId: "client-acme" },
      { userId: "ann", workspaceId: "" },
    ]) {
      assert.equal(longMemoryAppliesToTenantSelector(normalizeTenantSelector(selector)), true);
    }
  });

  test("the /memory routes read, write, delete and clear in the caller's workspace", async () => {
    const app = express();

    app.use(express.json());
    app.use((req, _res, next) => {
      req.accessScope = req.get("x-test-workspace") === "client-globex" ? IN_GLOBEX : IN_ACME;
      next();
    });
    app.use(
      createMemoryRouter({
        ragService: { clearLongMemories, deleteLongMemory, listLongMemories, rememberLongMemory },
      })
    );

    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });

    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const send = (method, path, workspaceId, body) =>
        fetch(`${base}${path}`, {
          body: body ? JSON.stringify(body) : undefined,
          headers: { "content-type": "application/json", "x-test-workspace": workspaceId },
          method,
        });

      const created = await send("POST", "/memory", "client-acme", { text: "Acme's counsel is Jane Roe" });
      const { memory } = await created.json();

      assert.equal(created.status, 201);
      assert.equal(memory.workspaceId, "client-acme");
      assert.deepEqual((await (await send("GET", "/memory", "client-globex")).json()).memories, []);
      assert.equal((await (await send("GET", "/memory", "client-acme")).json()).memories.length, 1);
      assert.equal((await send("DELETE", `/memory/${memory.memoryId}`, "client-globex")).status, 404);
      assert.deepEqual(await (await send("DELETE", "/memory", "client-globex")).json(), { deletedCount: 0 });
      assert.deepEqual(await (await send("DELETE", "/memory", "client-acme")).json(), { deletedCount: 1 });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
