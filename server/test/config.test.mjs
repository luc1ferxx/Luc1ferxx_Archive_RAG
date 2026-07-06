import test from "node:test";
import assert from "node:assert/strict";
import {
  getAdminAuditRetentionDays,
  getAdminAuditStoreConfigStatus,
  getApiAuthConfigStatus,
  getAgentExecutionPlanner,
  getAgentRunRecoveryMode,
  getAgentRunRecoveryModeConfigStatus,
  getAgentRunStoreConfigStatus,
  getAgentIntentPlanner,
  getAgentPlannerRollout,
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

test("agent planner defaults target pure LLM runtime", async () => {
  await withEnv(
    {
      AGENT_EXECUTION_PLANNER: undefined,
      AGENT_INTENT_PLANNER: undefined,
      AGENT_PLANNER_ROLLOUT: undefined,
    },
    async () => {
      assert.equal(getAgentPlannerRollout(), "llm");
      assert.equal(getAgentIntentPlanner(), "llm");
      assert.equal(getAgentExecutionPlanner(), "llm");
    }
  );
});

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

test("agent run recovery defaults to manual without persistent run storage", async () => {
  await withEnv(
    {
      AGENT_RUN_RECOVERY_MODE: undefined,
      AGENT_RUN_STORE_PROVIDER: undefined,
      LONG_MEMORY_DATABASE_URL: undefined,
      POSTGRES_DATABASE_URL: undefined,
    },
    async () => {
      assert.equal(getAgentRunRecoveryMode(), "manual");
      assert.equal(getAgentRunStoreConfigStatus().backend, "memory");
      assert.equal(
        getAgentRunRecoveryModeConfigStatus().reason,
        "non_persistent_agent_run_store_default"
      );
    }
  );
});

test("PostgreSQL-backed agent run storage enables auto recovery by default", async () => {
  await withEnv(
    {
      AGENT_RUN_RECOVERY_MODE: undefined,
      AGENT_RUN_STORE_PROVIDER: undefined,
      LONG_MEMORY_DATABASE_URL: undefined,
      POSTGRES_DATABASE_URL: "postgres://user:pass@localhost:5432/rag",
    },
    async () => {
      assert.equal(getAgentRunRecoveryMode(), "auto");
      assert.equal(getAgentRunStoreConfigStatus().backend, "postgres");
      assert.equal(
        getAgentRunRecoveryModeConfigStatus().reason,
        "postgres_agent_run_store_default"
      );
    }
  );
});

test("explicit agent run recovery mode overrides the storage-derived default", async () => {
  await withEnv(
    {
      AGENT_RUN_RECOVERY_MODE: "manual",
      AGENT_RUN_STORE_PROVIDER: undefined,
      LONG_MEMORY_DATABASE_URL: undefined,
      POSTGRES_DATABASE_URL: "postgres://user:pass@localhost:5432/rag",
    },
    async () => {
      assert.equal(getAgentRunRecoveryMode(), "manual");
      assert.equal(getAgentRunRecoveryModeConfigStatus().explicit, true);
      assert.equal(getAgentRunRecoveryModeConfigStatus().reason, "env_configured");
    }
  );
});

test("admin audit store defaults to Postgres when configured", async () => {
  await withEnv(
    {
      ADMIN_AUDIT_RETENTION_DAYS: undefined,
      ADMIN_AUDIT_STORE_PROVIDER: undefined,
      LONG_MEMORY_DATABASE_URL: undefined,
      POSTGRES_DATABASE_URL: "postgres://user:pass@localhost:5432/rag",
    },
    async () => {
      assert.equal(getAdminAuditStoreConfigStatus().backend, "postgres");
      assert.equal(getAdminAuditStoreConfigStatus().persistent, true);
      assert.equal(
        getAdminAuditStoreConfigStatus().reason,
        "postgres_configured_default"
      );
      assert.equal(getAdminAuditRetentionDays(), 90);
    }
  );
});

test("explicit admin audit store provider and retention override defaults", async () => {
  await withEnv(
    {
      ADMIN_AUDIT_RETENTION_DAYS: "0",
      ADMIN_AUDIT_STORE_PROVIDER: "memory",
      POSTGRES_DATABASE_URL: "postgres://user:pass@localhost:5432/rag",
    },
    async () => {
      assert.equal(getAdminAuditStoreConfigStatus().backend, "memory");
      assert.equal(getAdminAuditStoreConfigStatus().persistent, false);
      assert.equal(getAdminAuditStoreConfigStatus().reason, "env_memory");
      assert.equal(getAdminAuditRetentionDays(), 0);
    }
  );
});

test("API auth config status covers static tokens, JWT, and workspace requirements", async () => {
  await withEnv(
    {
      API_AUTH_ENABLED: "false",
      API_AUTH_JWT_ENABLED: undefined,
      API_AUTH_JWT_HS256_SECRET: undefined,
      API_AUTH_JWT_SECRET: undefined,
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: undefined,
      API_AUTH_REQUIRE_WORKSPACE: undefined,
    },
    async () => {
      assert.deepEqual(getApiAuthConfigStatus(), {
        enabled: false,
        jwtEnabled: false,
        jwtSecretConfigured: false,
        modes: [],
        staticTokenConfigured: false,
        status: "disabled",
        workspaceRequired: false,
      });
    }
  );

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_JWT_ENABLED: "true",
      API_AUTH_JWT_HS256_SECRET: "jwt-secret",
      API_AUTH_JWT_SECRET: undefined,
      API_AUTH_TOKEN: "",
      API_AUTH_TOKENS: "",
      API_AUTH_REQUIRE_WORKSPACE: "true",
    },
    async () => {
      assert.deepEqual(getApiAuthConfigStatus(), {
        enabled: true,
        jwtEnabled: true,
        jwtSecretConfigured: true,
        modes: ["jwt"],
        staticTokenConfigured: false,
        status: "ok",
        workspaceRequired: true,
      });
    }
  );

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_JWT_ENABLED: "true",
      API_AUTH_JWT_HS256_SECRET: "",
      API_AUTH_JWT_SECRET: "",
      API_AUTH_TOKEN: "local-token",
      API_AUTH_TOKENS: "",
      API_AUTH_REQUIRE_WORKSPACE: undefined,
    },
    async () => {
      assert.deepEqual(getApiAuthConfigStatus(), {
        enabled: true,
        jwtEnabled: true,
        jwtSecretConfigured: false,
        modes: ["static_token", "jwt"],
        staticTokenConfigured: true,
        status: "error",
        workspaceRequired: false,
      });
    }
  );

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_JWT_ENABLED: "false",
      API_AUTH_JWT_HS256_SECRET: undefined,
      API_AUTH_JWT_SECRET: undefined,
      API_AUTH_TOKEN: "",
      API_AUTH_TOKENS: JSON.stringify({
        token: {
          userId: "alice",
        },
      }),
      API_AUTH_REQUIRE_WORKSPACE: undefined,
    },
    async () => {
      assert.deepEqual(getApiAuthConfigStatus(), {
        enabled: true,
        jwtEnabled: false,
        jwtSecretConfigured: false,
        modes: ["static_token"],
        staticTokenConfigured: true,
        status: "ok",
        workspaceRequired: false,
      });
    }
  );
});
