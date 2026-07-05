import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getRequestAccessScope,
  requireApiAuth,
} from "../auth.js";
import {
  buildHealthReport,
  runStartupHealthChecks,
} from "../health.js";
import {
  buildFeedbackRecord,
  configureFeedbackDirectory,
  listFeedback,
  recordFeedback,
} from "../feedback.js";
import {
  completeText,
  completeTextWithMetadata,
  configureOpenAIProvider,
  embedQuery,
  embedTexts,
  getEmbeddings,
  getOpenAIApiKey,
  resetOpenAIProvider,
} from "../rag/openai.js";
import {
  checkLongMemoryPostgresHealth,
  checkPostgresHealth,
  getPostgresPool,
  isPostgresConfigured,
  resetPostgresPool,
} from "../rag/postgres.js";
import {
  resetPostgresMigrations,
  runPostgresMigrations,
} from "../rag/db-migrations.js";
import {
  ADMIN_PERMISSION_IDS,
  ADMIN_ROLE_IDS,
} from "../rag/admin-permissions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.resolve(__dirname, "..");
const defaultFeedbackDirectory = path.join(serverDirectory, "data", "feedback");

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

const runAuthMiddleware = ({
  body = {},
  headers = {},
  path: requestPath = "/documents",
  query = {},
} = {}) => {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  const req = {
    accessScope: undefined,
    body,
    get: (key) => normalizedHeaders.get(key.toLowerCase()) ?? "",
    path: requestPath,
    query,
  };
  let statusCode = 200;
  let jsonPayload = null;
  let nextCalled = false;
  const res = {
    json: (payload) => {
      jsonPayload = payload;
      return res;
    },
    status: (code) => {
      statusCode = code;
      return res;
    },
  };

  requireApiAuth(req, res, () => {
    nextCalled = true;
  });

  return {
    accessScope: getRequestAccessScope(req),
    jsonPayload,
    nextCalled,
    req,
    statusCode,
  };
};

test("health report contracts expose missing dependencies and strict startup failure", async () => {
  await withEnv(
    {
      AGENT_RUN_STORE_PROVIDER: "memory",
      API_AUTH_ENABLED: "false",
      LONG_MEMORY_DATABASE_URL: undefined,
      OPENAI_API_KEY: undefined,
      POSTGRES_DATABASE_URL: undefined,
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: undefined,
      RAG_LONG_MEMORY_ENABLED: undefined,
      STARTUP_HEALTH_STRICT: "false",
      TASK_STORE_PROVIDER: "memory",
      VECTOR_STORE_PROVIDER: "local",
    },
    async () => {
      const report = await buildHealthReport();

      assert.equal(report.status, "error");
      assert.equal(report.checks.apiAuth.status, "disabled");
      assert.equal(report.checks.openai.status, "error");
      assert.match(report.checks.openai.message, /OPENAI_API_KEY/);
      assert.equal(report.checks.vectorStore.status, "disabled");
      assert.equal(report.checks.documentStore.status, "error");
      assert.equal(report.checks.sessionMemory.status, "error");
      assert.equal(report.checks.longMemory.status, "disabled");
      assert.equal(report.checks.agentExperienceMemory.status, "disabled");
      assert.equal(report.checks.taskStore.status, "ok");
      assert.equal(report.checks.taskStore.backend, "memory");
      assert.equal(report.checks.agentRunStore.status, "ok");
      assert.equal(report.checks.agentRunStore.backend, "memory");

      const logs = [];
      const startupReport = await runStartupHealthChecks({
        logger: {
          log: (message) => logs.push(["log", message]),
          warn: (message) => logs.push(["warn", message]),
        },
      });

      assert.equal(startupReport.status, "error");
      assert.equal(logs[0][0], "warn");
      assert.match(logs[0][1], /openai=error/);
    }
  );

  await withEnv(
    {
      OPENAI_API_KEY: undefined,
      POSTGRES_DATABASE_URL: undefined,
      STARTUP_HEALTH_STRICT: "true",
      VECTOR_STORE_PROVIDER: "local",
    },
    async () => {
      await assert.rejects(
        () =>
          runStartupHealthChecks({
            logger: {
              log: () => {},
              warn: () => {},
            },
          }),
        /Startup health checks failed/
      );
    }
  );
});

test("health report contracts cover auth, qdrant, and scoped store failures", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  try {
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: false,
        status: 503,
      };
    };

    await withEnv(
      {
        AGENT_RUN_STORE_PROVIDER: "postgres",
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKEN: "",
        LONG_MEMORY_DATABASE_URL: undefined,
        OPENAI_API_KEY: "test-key",
        POSTGRES_DATABASE_URL: undefined,
        QDRANT_COLLECTION: "contract_chunks",
        QDRANT_URL: "http://qdrant.local/",
        RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "true",
        RAG_LONG_MEMORY_ENABLED: "true",
        STARTUP_HEALTH_STRICT: "false",
        TASK_STORE_PROVIDER: "postgres",
        VECTOR_STORE_PROVIDER: "qdrant",
      },
      async () => {
        const report = await buildHealthReport();

        assert.equal(report.status, "error");
        assert.equal(report.checks.apiAuth.status, "error");
        assert.match(report.checks.apiAuth.message, /API_AUTH_TOKEN/);
        assert.equal(report.checks.openai.status, "ok");
        assert.equal(report.checks.vectorStore.status, "error");
        assert.equal(report.checks.vectorStore.provider, "qdrant");
        assert.equal(report.checks.vectorStore.collection, "contract_chunks");
        assert.match(report.checks.vectorStore.message, /503/);
        assert.deepEqual(requestedUrls, ["http://qdrant.local/healthz"]);
        assert.equal(report.checks.longMemory.status, "error");
        assert.equal(report.checks.longMemory.backend, "postgresql");
        assert.equal(report.checks.agentExperienceMemory.status, "ok");
        assert.equal(report.checks.taskStore.status, "error");
        assert.equal(report.checks.taskStore.backend, "postgresql");
        assert.equal(report.checks.agentRunStore.status, "error");
        assert.equal(report.checks.agentRunStore.backend, "postgresql");
      }
    );

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
    });

    await withEnv(
      {
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKEN: "local-token",
        OPENAI_API_KEY: "test-key",
        QDRANT_COLLECTION: "healthy_chunks",
        QDRANT_URL: "http://qdrant.local",
        VECTOR_STORE_PROVIDER: "qdrant",
      },
      async () => {
        const report = await buildHealthReport();

        assert.equal(report.checks.apiAuth.status, "ok");
        assert.equal(
          report.checks.apiAuth.header,
          "x-api-key or Authorization: Bearer <token>"
        );
        assert.equal(report.checks.vectorStore.status, "ok");
        assert.equal(report.checks.vectorStore.collection, "healthy_chunks");
      }
    );

    globalThis.fetch = async () => {
      throw new Error("qdrant refused connection");
    };

    await withEnv(
      {
        OPENAI_API_KEY: "test-key",
        QDRANT_URL: "http://qdrant.local",
        VECTOR_STORE_PROVIDER: "qdrant",
      },
      async () => {
        const report = await buildHealthReport();

        assert.equal(report.checks.vectorStore.status, "error");
        assert.match(report.checks.vectorStore.message, /qdrant refused connection/);
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API auth middleware contract preserves public paths and scoped principals", async () => {
  await withEnv(
    {
      API_AUTH_ENABLED: "false",
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: undefined,
    },
    async () => {
      const result = runAuthMiddleware({
        body: {
          userId: "body-user",
        },
        query: {
          workspaceId: "query-workspace",
        },
      });

      assert.equal(result.nextCalled, true);
      assert.deepEqual(result.accessScope, {
        authenticated: false,
        userId: "body-user",
        workspaceId: "query-workspace",
      });
    }
  );

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: "{not-json",
    },
    async () => {
      const publicResult = runAuthMiddleware({
        path: "/health/deep",
      });

      assert.equal(publicResult.nextCalled, true);
      assert.deepEqual(publicResult.accessScope, {});

      const protectedResult = runAuthMiddleware();

      assert.equal(protectedResult.statusCode, 500);
      assert.match(protectedResult.jsonPayload.error, /valid JSON/);
    }
  );

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: JSON.stringify(false),
    },
    async () => {
      const result = runAuthMiddleware();

      assert.equal(result.statusCode, 500);
      assert.match(result.jsonPayload.error, /JSON object or array/);
    }
  );

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: undefined,
    },
    async () => {
      const result = runAuthMiddleware();

      assert.equal(result.statusCode, 500);
      assert.match(result.jsonPayload.error, /no API token/);
    }
  );

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: JSON.stringify([
        {
          token: "bearer-token",
          permission_ids: [ADMIN_PERMISSION_IDS.adminActionQualityRefresh],
          roles: [ADMIN_ROLE_IDS.viewer],
          user_id: "alice",
          workspace_id: "workspace-a",
        },
      ]),
    },
    async () => {
      const result = runAuthMiddleware({
        headers: {
          authorization: "Bearer bearer-token",
        },
      });

      assert.equal(result.nextCalled, true);
      assert.deepEqual(result.accessScope, {
        authenticated: true,
        permissionIds: [ADMIN_PERMISSION_IDS.adminActionQualityRefresh],
        roleIds: [ADMIN_ROLE_IDS.viewer],
        userId: "alice",
        workspaceId: "workspace-a",
      });
    }
  );

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: JSON.stringify({
        "legacy-token": "legacy-user",
      }),
    },
    async () => {
      const result = runAuthMiddleware({
        headers: {
          "x-api-key": "legacy-token",
        },
        query: {
          workspaceId: "legacy-workspace",
        },
      });

      assert.equal(result.nextCalled, true);
      assert.deepEqual(result.accessScope, {
        authenticated: true,
        userId: "legacy-user",
        workspaceId: "legacy-workspace",
      });

      const unauthorizedResult = runAuthMiddleware({
        headers: {
          "x-api-key": "wrong",
        },
      });

      assert.equal(unauthorizedResult.statusCode, 401);
      assert.equal(unauthorizedResult.jsonPayload.error, "Unauthorized.");
    }
  );
});

test("feedback contract validates payloads, sanitizes agent metadata, and lists scoped records", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "feedback-contract-"));

  configureFeedbackDirectory(tempRoot);

  try {
    assert.throws(
      () =>
        buildFeedbackRecord({
          payload: {
            feedbackType: "unknown",
            question: "Q?",
            answerText: "A.",
          },
        }),
      /feedbackType must be one of/
    );
    assert.throws(
      () =>
        buildFeedbackRecord({
          payload: {
            feedbackType: "helpful",
            answerText: "A.",
          },
        }),
      /question is required/
    );
    assert.throws(
      () =>
        buildFeedbackRecord({
          payload: {
            feedbackType: "helpful",
            question: "Q?",
          },
        }),
      /answer text is required/
    );

    const record = buildFeedbackRecord({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      payload: {
        feedbackType: "hallucination",
        question: "What changed?",
        docIds: "doc-1, doc-2, doc-1",
        answer: {
          agentAnswer: "The answer contained an unsupported claim.",
          agentMode: "document",
          agentSkills: [
            {
              id: "document_rag",
              version: "1.0.0",
              label: "Document RAG",
              status: "completed",
            },
          ],
          ragSources: [
            {
              docId: "doc-1",
              fileName: "policy.pdf",
              pageNumber: "3",
              chunkIndex: "9",
              excerpt: " ".repeat(2) + "This excerpt is kept.".repeat(50),
            },
          ],
          agentTrace: [
            {
              type: "self_check",
              detail: {
                claimSupport: {
                  checked: true,
                  supportedClaimCount: "1",
                  unsupportedClaimCount: "1",
                  claims: [
                    {
                      text: "Supported claim.",
                      supported: true,
                      tokenOverlap: 0.5,
                      anchors: ["approval"],
                    },
                    {
                      text: "Unsupported satellite stipend.",
                      supported: false,
                      missingAnchors: ["satellite"],
                    },
                  ],
                },
              },
            },
          ],
          agentObservability: {
            agentMode: "document",
            planMode: "document",
            selectedSkills: [
              {
                skillId: "document_rag",
                skillVersion: "1.0.0",
              },
            ],
            skillChain: [
              {
                skillId: "risk_review",
                skillVersion: "1.0.0",
              },
            ],
            skills: [
              {
                skillId: "document_rag",
                skillVersion: "1.0.0",
                attempts: "2",
                budgetDelta: {
                  documentRagCalls: "2",
                  ignored: 0,
                },
              },
            ],
            runs: [
              {
                skillId: "document_rag",
                skillVersion: "1.0.0",
                phase: "primary",
                status: "completed",
                budget: {
                  ok: true,
                  key: "documentRagCalls",
                  limit: "3",
                  used: "1",
                  remaining: "2",
                },
              },
            ],
            budget: {
              limits: {
                documentRagCalls: 3,
              },
              used: {
                documentRagCalls: 1,
              },
              traceTruncated: true,
            },
          },
          agentWorkingMemory: {
            version: "1",
            goal: "What changed?",
            docIds: ["doc-1", "doc-2"],
            checkedQueries: [
              {
                skillId: "document_rag",
                query: "What changed?",
                primary: true,
              },
            ],
            unsupportedClaims: [
              {
                text: "Unsupported satellite stipend.",
                missingAnchors: ["satellite"],
              },
            ],
            unresolvedGaps: [
              {
                type: "unsupported_claim",
                message: "Need cited evidence.",
              },
            ],
          },
        },
      },
    });

    assert.equal(record.userId, "alice");
    assert.equal(record.workspaceId, "workspace-a");
    assert.deepEqual(record.docIds, ["doc-1", "doc-2"]);
    assert.equal(record.answerText, "The answer contained an unsupported claim.");
    assert.equal(record.claimChecks[0].unsupportedClaimCount, 1);
    assert.equal(record.citations[0].pageNumber, 3);
    assert.equal(record.citations[0].excerpt.length, 500);
    assert.equal(record.agentObservability.feedbackType, "hallucination");
    assert.equal(record.agentObservability.skills[0].attempts, 2);
    assert.deepEqual(record.agentObservability.skills[0].budgetDelta, {
      documentRagCalls: 2,
    });
    assert.equal(
      record.agentObservability.workingMemory.unsupportedClaims[0].text,
      "Unsupported satellite stipend."
    );

    await recordFeedback(record);
    await recordFeedback({
      ...record,
      feedbackId: "bob-feedback",
      userId: "bob",
      workspaceId: "workspace-b",
    });
    await appendFile(path.join(tempRoot, "feedback.jsonl"), "not-json\n", "utf8");

    const scopedFeedback = await listFeedback({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      limit: 10,
    });

    assert.equal(scopedFeedback.length, 1);
    assert.equal(scopedFeedback[0].feedbackId, record.feedbackId);

    const allFeedback = await listFeedback({
      limit: "bad-limit",
    });

    assert.equal(allFeedback.length, 2);
  } finally {
    configureFeedbackDirectory(defaultFeedbackDirectory);
    await rm(tempRoot, {
      recursive: true,
      force: true,
    });
  }
});

test("OpenAI adapter contract normalizes custom providers and surfaces configuration failures", async () => {
  await withEnv(
    {
      OPENAI_API_KEY: undefined,
    },
    async () => {
      resetOpenAIProvider();

      assert.throws(() => getOpenAIApiKey(), /OPENAI_API_KEY is not configured/);
      assert.throws(() => getEmbeddings(), /OPENAI_API_KEY is not configured/);
    }
  );

  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map((text) => [`doc:${text}`]),
    embedQuery: async (query) => [`query:${query}`],
    completeText: async (prompt) => prompt,
  });

  assert.deepEqual(await embedTexts(["alpha", "beta"]), [
    ["doc:alpha"],
    ["doc:beta"],
  ]);
  assert.deepEqual(await embedQuery("alpha"), ["query:alpha"]);
  assert.match(
    await completeText({
      messages: [
        {
          role: "system",
          content: "Use evidence.",
        },
        {
          getType: () => "human",
          content: [
            {
              text: "Answer the question.",
            },
          ],
        },
      ],
    }),
    /SYSTEM:\nUse evidence\.\n\nHUMAN:\nAnswer the question\./
  );
  const completionWithMetadata = await completeTextWithMetadata(
    "prompt with sk-test-secret-value"
  );

  assert.equal(completionWithMetadata.modelRoute.status, "custom_provider");
  assert.equal(completionWithMetadata.modelRoute.providerId, "custom_provider");
  assert.doesNotMatch(
    JSON.stringify(completionWithMetadata.modelRoute),
    /sk-test-secret-value/
  );

  configureOpenAIProvider({
    getChatModel: () => ({
      invoke: async () => ({
        content: [
          {
            text: "Chunked ",
          },
          "answer",
          {
            ignored: true,
          },
        ],
      }),
    }),
  });

  assert.equal(await completeText("prompt"), "Chunked answer");

  configureOpenAIProvider({
    getChatModel: () => ({
      invoke: async () => {
        const error = new Error("bad request");
        error.status = 400;
        throw error;
      },
    }),
  });

  await assert.rejects(
    () => completeText("prompt"),
    /Chat completion failed\. bad request/
  );

  resetOpenAIProvider();
});

test("PostgreSQL and migration contracts expose missing configuration without network access", async () => {
  await withEnv(
    {
      LONG_MEMORY_DATABASE_URL: undefined,
      POSTGRES_DATABASE_URL: undefined,
      RAG_LONG_MEMORY_ENABLED: undefined,
    },
    async () => {
      await resetPostgresPool();
      resetPostgresMigrations();

      assert.equal(isPostgresConfigured(), false);
      assert.throws(() => getPostgresPool(), /PostgreSQL-backed storage/);
      assert.deepEqual(await checkPostgresHealth(), {
        status: "error",
        message: "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is missing.",
      });
      assert.deepEqual(await checkLongMemoryPostgresHealth(), {
        status: "disabled",
        message: "Long-term memory is disabled.",
      });
      await assert.rejects(
        () => runPostgresMigrations(),
        /PostgreSQL-backed storage/
      );
    }
  );

  await withEnv(
    {
      POSTGRES_DATABASE_URL: "postgres://user:pass@localhost:1/db",
      POSTGRES_SSL_ENABLED: "true",
    },
    async () => {
      const pool = getPostgresPool();

      assert.ok(pool);
      assert.equal(getPostgresPool(), pool);
      await resetPostgresPool();

      const health = await checkPostgresHealth();

      assert.equal(health.status, "error");
      assert.equal(typeof health.message, "string");
      await resetPostgresPool();

      await assert.rejects(
        () => runPostgresMigrations(),
        /AggregateError|ECONNREFUSED|Connection terminated|connect/i
      );
    }
  );
});
