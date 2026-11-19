import test from "node:test";
import assert from "node:assert/strict";

import {
  applyStandaloneProfile,
  isStandaloneProfileEnabled,
} from "../standalone-profile.js";
import {
  getAdminAuditStoreProvider,
  getAgentRunStoreProvider,
  getTaskStoreProvider,
  getVectorStoreProvider,
  getWorkspaceArtifactStoreProvider,
  isAgentExperienceMemoryEnabled,
  isLongMemoryEnabled,
  isPostgresDatabaseConfigured,
} from "../rag/config.js";
import { resetDocumentRegistryStore } from "../rag/doc-registry.js";
import {
  clearSessionMemory,
  recordSessionTurn,
  resetSessionMemory,
  resetSessionMemoryStore,
} from "../rag/memory.js";

const MANAGED_ENVIRONMENT_KEYS = [
  "ADMIN_AUDIT_STORE_PROVIDER",
  "AGENT_RUN_STORE_PROVIDER",
  "DOCCOMPARE_STANDALONE",
  "LONG_MEMORY_DATABASE_URL",
  "POSTGRES_DATABASE_URL",
  "RAG_AGENT_EXPERIENCE_MEMORY_ENABLED",
  "RAG_LONG_MEMORY_ENABLED",
  "TASK_STORE_PROVIDER",
  "VECTOR_STORE_PROVIDER",
  "WORKSPACE_ARTIFACT_STORE_PROVIDER",
];

// applyStandaloneProfile writes to the real process.env and the real store
// singletons, and the suite runs every test file in one process, so both are
// snapshotted and restored.
const withRestoredEnvironment = async (run) => {
  const originalValues = new Map(
    MANAGED_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])
  );

  try {
    await run();
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await resetDocumentRegistryStore();
    await resetSessionMemoryStore();
    resetSessionMemory();
  }
};

test("standalone profile activates only on an explicit opt-in", () => {
  assert.equal(
    isStandaloneProfileEnabled({
      environment: {},
    }),
    false
  );
  assert.equal(
    isStandaloneProfileEnabled({
      environment: {
        DOCCOMPARE_STANDALONE: " 1 ",
      },
    }),
    true
  );
  // Anything other than 1 leaves the PostgreSQL path in place. A truthy-string
  // check would turn DOCCOMPARE_STANDALONE=0 into standalone mode.
  assert.equal(
    isStandaloneProfileEnabled({
      environment: {
        DOCCOMPARE_STANDALONE: "0",
      },
    }),
    false
  );
  assert.equal(
    isStandaloneProfileEnabled({
      environment: {
        DOCCOMPARE_STANDALONE: "true",
      },
    }),
    false
  );
});

test("standalone profile takes every subsystem off PostgreSQL", async () => {
  await withRestoredEnvironment(async () => {
    const registryStores = [];

    process.env.POSTGRES_DATABASE_URL =
      "postgresql://postgres:postgres@127.0.0.1:5432/agentai";
    process.env.LONG_MEMORY_DATABASE_URL =
      "postgresql://postgres:postgres@127.0.0.1:5432/agentai";
    process.env.VECTOR_STORE_PROVIDER = "qdrant";
    delete process.env.RAG_LONG_MEMORY_ENABLED;
    delete process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED;
    delete process.env.TASK_STORE_PROVIDER;
    delete process.env.AGENT_RUN_STORE_PROVIDER;
    delete process.env.WORKSPACE_ARTIFACT_STORE_PROVIDER;
    delete process.env.ADMIN_AUDIT_STORE_PROVIDER;

    assert.equal(isPostgresDatabaseConfigured(), true);
    assert.equal(isLongMemoryEnabled(), true);

    const profile = applyStandaloneProfile({
      createRegistryStore: () => {
        const store = {
          async initialize() {
            return true;
          },
          async list() {
            return [];
          },
        };

        registryStores.push(store);
        return store;
      },
    });

    assert.equal(profile.applied, true);
    assert.equal(profile.documentRegistryBackend, "filesystem");
    assert.equal(profile.sessionMemoryBackend, "memory");
    assert.equal(registryStores.length, 1);

    // Clearing the database URLs is what actually disarms the subsystems that
    // default to PostgreSQL whenever one is configured.
    assert.equal(isPostgresDatabaseConfigured(), false);
    assert.equal(isLongMemoryEnabled(), false);
    assert.equal(isAgentExperienceMemoryEnabled(), false);
    assert.equal(getTaskStoreProvider(), "memory");
    assert.equal(getAgentRunStoreProvider(), "memory");
    assert.equal(getWorkspaceArtifactStoreProvider(), "memory");
    assert.equal(getAdminAuditStoreProvider(), "memory");
    assert.equal(getVectorStoreProvider(), "local");
    assert.equal(profile.settings.POSTGRES_DATABASE_URL, "");
  });
});

test("standalone profile serves session memory in process instead of failing on PostgreSQL", async () => {
  await withRestoredEnvironment(async () => {
    applyStandaloneProfile({
      createRegistryStore: () => ({
        async list() {
          return [];
        },
      }),
    });

    // The MCP bridge passes no sessionId, so this path is dormant there. It exists
    // so a caller that does pass one gets per-process continuity rather than a
    // connection error from a database that is not running.
    resetSessionMemory();

    assert.equal(await clearSessionMemory(""), false);
    assert.equal(await clearSessionMemory("session-a"), false);

    const recordedTurn = await recordSessionTurn({
      sessionId: "session-a",
      query: "What is the liability cap?",
      resolvedQuery: "What is the liability cap?",
      answer: "The cap is 12 months of fees.",
      documents: [],
      routeMode: "document",
    });

    assert.equal(recordedTurn.messages.length, 2);
    assert.equal(recordedTurn.messages[0].text, "What is the liability cap?");
    assert.equal(await clearSessionMemory("session-a"), true);
    assert.equal(await clearSessionMemory("session-a"), false);
  });
});

test("standalone session memory keeps both turns of one session recorded at once, and only the last three turns", async () => {
  await withRestoredEnvironment(async () => {
    applyStandaloneProfile({
      createRegistryStore: () => ({
        async list() {
          return [];
        },
      }),
    });
    resetSessionMemory();

    const record = (text) =>
      recordSessionTurn({
        sessionId: "session-b",
        query: text,
        answer: `${text} answer`,
        documents: [],
        routeMode: "document",
      });
    const texts = (session) => session.messages.map((message) => message.text);

    // Two requests of one session that finish together (two tabs, or a chat
    // and a task iteration): neither write may drop the other's turn.
    await Promise.all([record("first"), record("second")]);

    assert.deepEqual(texts(await record("third")), [
      "first",
      "first answer",
      "second",
      "second answer",
      "third",
      "third answer",
    ]);
    assert.deepEqual(texts(await record("fourth")), [
      "second",
      "second answer",
      "third",
      "third answer",
      "fourth",
      "fourth answer",
    ]);
  });
});
