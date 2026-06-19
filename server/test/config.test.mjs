import test from "node:test";
import assert from "node:assert/strict";
import {
  getAgentExperienceMemoryConfigStatus,
  getLongMemoryConfigStatus,
  isAgentExperienceMemoryEnabled,
  isLongMemoryEnabled,
} from "../rag/config.js";

const withEnv = async (overrides, callback) => {
  const originalValues = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("memory defaults stay disabled when PostgreSQL is not configured", async () => {
  await withEnv(
    {
      LONG_MEMORY_DATABASE_URL: undefined,
      POSTGRES_DATABASE_URL: undefined,
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: undefined,
      RAG_LONG_MEMORY_ENABLED: undefined,
    },
    async () => {
      assert.equal(isLongMemoryEnabled(), false);
      assert.equal(isAgentExperienceMemoryEnabled(), false);
      assert.equal(getLongMemoryConfigStatus().reason, "postgres_not_configured");
      assert.equal(
        getAgentExperienceMemoryConfigStatus().reason,
        "postgres_not_configured"
      );
    }
  );
});

test("PostgreSQL configuration enables long and experience memory by default", async () => {
  await withEnv(
    {
      LONG_MEMORY_DATABASE_URL: undefined,
      POSTGRES_DATABASE_URL: "postgres://user:pass@localhost:5432/rag",
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: undefined,
      RAG_LONG_MEMORY_ENABLED: undefined,
    },
    async () => {
      assert.equal(isLongMemoryEnabled(), true);
      assert.equal(isAgentExperienceMemoryEnabled(), true);
      assert.equal(
        getLongMemoryConfigStatus().reason,
        "postgres_configured_default"
      );
      assert.equal(
        getAgentExperienceMemoryConfigStatus().reason,
        "postgres_configured_default"
      );
    }
  );
});

test("explicit memory disable overrides PostgreSQL default", async () => {
  await withEnv(
    {
      POSTGRES_DATABASE_URL: "postgres://user:pass@localhost:5432/rag",
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: undefined,
      RAG_LONG_MEMORY_ENABLED: "false",
    },
    async () => {
      assert.equal(isLongMemoryEnabled(), false);
      assert.equal(isAgentExperienceMemoryEnabled(), false);
      assert.equal(getLongMemoryConfigStatus().reason, "env_disabled");
      assert.equal(
        getAgentExperienceMemoryConfigStatus().reason,
        "env_disabled"
      );
    }
  );
});
