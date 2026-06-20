import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../app.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { resetAgentExperienceMemoryStore } from "../rag/agent-experience-memory.js";
import { clearLongMemories, resetLongMemoryStore } from "../rag/long-memory.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");
const latestJsonPath = path.join(resultsDirectory, "latest-runtime-smoke.json");
const latestMarkdownPath = path.join(resultsDirectory, "latest-runtime-smoke.md");

const SMOKE_DOC_ID = "runtime-smoke-contract";
const SMOKE_DOC = {
  docId: SMOKE_DOC_ID,
  fileName: "runtime-smoke-contract.pdf",
  pageCount: 2,
};
const SMOKE_QUESTION = "Review this contract for risks and key terms.";

const normalizeText = (value = "") =>
  String(value ?? "").replace(/\s+/g, " ").trim();

const hasEnvValue = (name) => normalizeText(process.env[name]).length > 0;

const assertRequiredRuntimeEnv = () => {
  assert.equal(
    hasEnvValue("OPENAI_API_KEY"),
    true,
    "OPENAI_API_KEY is required for the pure LLM runtime smoke."
  );
  assert.equal(
    hasEnvValue("POSTGRES_DATABASE_URL") || hasEnvValue("LONG_MEMORY_DATABASE_URL"),
    true,
    "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is required for the runtime smoke."
  );
};

const createRuntimeSmokeRagService = ({ calls } = {}) => ({
  async initializeDocumentRegistry() {
    return true;
  },

  async initializeSessionMemory() {
    return true;
  },

  getDocument(docId) {
    return docId === SMOKE_DOC_ID ? SMOKE_DOC : null;
  },

  getDocumentFile() {
    return null;
  },

  listDocuments() {
    return [SMOKE_DOC];
  },

  async chat(docIds, question, options = {}) {
    calls?.push({
      docIds,
      question,
      retrievalPlan: options.retrievalPlan ?? null,
    });

    if (/risk review/i.test(question)) {
      return {
        text: [
          "Risk Review",
          "- Early termination requires 60 days notice. [Source 1]",
          "- Liability is capped at fees paid in the prior 12 months. [Source 2]",
        ].join("\n"),
        citations: [
          {
            docId: SMOKE_DOC_ID,
            excerpt: "Early termination requires 60 days notice.",
            fileName: SMOKE_DOC.fileName,
            pageNumber: 2,
            rank: 1,
          },
          {
            docId: SMOKE_DOC_ID,
            excerpt: "Liability is capped at fees paid in the prior 12 months.",
            fileName: SMOKE_DOC.fileName,
            pageNumber: 2,
            rank: 2,
          },
        ],
        abstained: false,
        memoryApplied: false,
        resolvedQuery: question,
      };
    }

    return {
      text: [
        "Contract Summary",
        "- Acme contract renews annually unless either party gives notice. [Source 1]",
        "- The agreement includes support obligations and renewal terms. [Source 2]",
      ].join("\n"),
      citations: [
        {
          docId: SMOKE_DOC_ID,
          excerpt: "Acme contract renews annually unless either party gives notice.",
          fileName: SMOKE_DOC.fileName,
          pageNumber: 1,
          rank: 1,
        },
        {
          docId: SMOKE_DOC_ID,
          excerpt: "The agreement includes support obligations and renewal terms.",
          fileName: SMOKE_DOC.fileName,
          pageNumber: 1,
          rank: 2,
        },
      ],
      abstained: false,
      memoryApplied: false,
      resolvedQuery: question,
    };
  },
});

const startServer = async (app) => {
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Runtime smoke server did not expose a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
};

const requestJson = async (baseUrl, routePath, { body, method = "GET" } = {}) => {
  const response = await fetch(`${baseUrl}${routePath}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: body
      ? {
          "content-type": "application/json",
        }
      : undefined,
    method,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  return {
    json,
    ok: response.ok,
    status: response.status,
  };
};

const assertHealth = (health) => {
  assert.equal(health.status, "ok", "Expected /health status to be ok.");

  const checks = health.checks ?? {};
  assert.equal(checks.longMemory?.status, "ok");
  assert.equal(checks.longMemory?.enabled, true);
  assert.equal(checks.longMemory?.reason, "postgres_configured_default");
  assert.equal(checks.agentExperienceMemory?.status, "ok");
  assert.equal(checks.agentExperienceMemory?.enabled, true);
  assert.equal(
    checks.agentExperienceMemory?.reason,
    "postgres_configured_default"
  );
};

const assertPureLlmPlanner = (chat, label) => {
  const observability = chat.agentObservability ?? {};

  assert.equal(
    observability.intentPlanner?.selectedPlannerId,
    "llm",
    `${label} intent planner should select llm.`
  );
  assert.equal(
    observability.intentPlanner?.status,
    "selected",
    `${label} intent planner should not fallback.`
  );
  assert.equal(
    observability.executionPlanner?.selectedPlannerId,
    "llm",
    `${label} execution planner should select llm.`
  );
  assert.equal(
    observability.executionPlanner?.status,
    "selected",
    `${label} execution planner should not fallback.`
  );
};

const assertDocumentOnlySources = (chat, label) => {
  const sources = Array.isArray(chat.ragSources) ? chat.ragSources : [];

  assert.equal(sources.length > 0, true, `${label} should include document sources.`);
  assert.equal(
    sources.every((source) => source?.docId === SMOKE_DOC_ID),
    true,
    `${label} sources should only reference the smoke document.`
  );

  const evidenceText = JSON.stringify({
    ragEvidenceSummary: chat.ragEvidenceSummary ?? null,
    ragSources: sources,
  });

  assert.doesNotMatch(evidenceText, /agent_experience/i);
  assert.doesNotMatch(evidenceText, /successful_plan/i);
};

const assertExperienceWrite = (chat) => {
  const experienceMemory = chat.agentObservability?.experienceMemory ?? {};

  assert.equal(experienceMemory.enabled, true);
  assert.equal(experienceMemory.writeAttempted, true);
  assert.equal(experienceMemory.writeSkippedReason, null);
  assert.equal(experienceMemory.write?.status, "stored");
  assert.equal(experienceMemory.write?.recordTypes?.includes("successful_plan"), true);
  assert.equal(experienceMemory.storedCount >= 1, true);
};

const assertExperiencePlanningHint = (chat) => {
  const experienceMemory = chat.agentObservability?.experienceMemory ?? {};

  assert.equal(experienceMemory.enabled, true);
  assert.equal(experienceMemory.applied, true);
  assert.equal(experienceMemory.hintCount >= 1, true);
  assert.equal(
    experienceMemory.planningHints?.some(
      (hint) => hint.type === "successful_plan" && hint.intentId
    ),
    true
  );
};

const runChatSmoke = async ({ baseUrl, sessionId, userId }) => {
  const payload = {
    docIds: [SMOKE_DOC_ID],
    question: SMOKE_QUESTION,
    sessionId,
    userId,
  };
  const first = await requestJson(baseUrl, "/chat", {
    body: payload,
    method: "POST",
  });

  assert.equal(first.status, 200, `/chat first run returned ${first.status}.`);
  assertPureLlmPlanner(first.json, "first chat");
  assertDocumentOnlySources(first.json, "first chat");
  assertExperienceWrite(first.json);

  const second = await requestJson(baseUrl, "/chat", {
    body: {
      ...payload,
      sessionId: `${sessionId}-hint`,
    },
    method: "POST",
  });

  assert.equal(second.status, 200, `/chat second run returned ${second.status}.`);
  assertPureLlmPlanner(second.json, "second chat");
  assertDocumentOnlySources(second.json, "second chat");
  assertExperiencePlanningHint(second.json);

  return {
    first: first.json,
    second: second.json,
  };
};

const buildReport = ({ calls, health, first, second, startedAt, userId }) => {
  const completedAt = new Date().toISOString();

  return {
    completedAt,
    startedAt,
    status: "pass",
    checks: {
      agentExperienceMemory: {
        healthReason: health.checks?.agentExperienceMemory?.reason ?? null,
        healthStatus: health.checks?.agentExperienceMemory?.status ?? null,
        secondRunHintCount:
          second.agentObservability?.experienceMemory?.hintCount ?? 0,
        writeStatus:
          first.agentObservability?.experienceMemory?.write?.status ?? null,
      },
      longMemory: {
        healthReason: health.checks?.longMemory?.reason ?? null,
        healthStatus: health.checks?.longMemory?.status ?? null,
      },
      planners: {
        executionPlanner:
          second.agentObservability?.executionPlanner?.selectedPlannerId ?? null,
        executionPlannerStatus:
          second.agentObservability?.executionPlanner?.status ?? null,
        intentPlanner:
          second.agentObservability?.intentPlanner?.selectedPlannerId ?? null,
        intentPlannerStatus:
          second.agentObservability?.intentPlanner?.status ?? null,
      },
      sources: {
        firstRunSourceCount: first.ragSources?.length ?? 0,
        secondRunSourceCount: second.ragSources?.length ?? 0,
        sourceDocIds: [
          ...new Set(
            [...(first.ragSources ?? []), ...(second.ragSources ?? [])]
              .map((source) => source.docId)
              .filter(Boolean)
          ),
        ],
      },
    },
    runtime: {
      chatModel: health.checks?.openai?.chatModel ?? null,
      ragCallCount: calls.length,
      userId,
    },
  };
};

const writeReport = async (report) => {
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    latestMarkdownPath,
    [
      "# Runtime Smoke Report",
      "",
      `- Status: ${report.status}`,
      `- Completed at: ${report.completedAt}`,
      `- Intent planner: ${report.checks.planners.intentPlanner} (${report.checks.planners.intentPlannerStatus})`,
      `- Execution planner: ${report.checks.planners.executionPlanner} (${report.checks.planners.executionPlannerStatus})`,
      `- Long memory: ${report.checks.longMemory.healthStatus} (${report.checks.longMemory.healthReason})`,
      `- Experience memory write: ${report.checks.agentExperienceMemory.writeStatus}`,
      `- Experience planning hints on second run: ${report.checks.agentExperienceMemory.secondRunHintCount}`,
      `- Source doc ids: ${report.checks.sources.sourceDocIds.join(", ")}`,
      "",
    ].join("\n")
  );
};

const main = async () => {
  assertRequiredRuntimeEnv();
  resetAgentExperienceMemoryStore();

  const startedAt = new Date().toISOString();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "archive-rag-smoke-"));
  const calls = [];
  const userId = `runtime-smoke-${randomUUID()}`;
  let server = null;

  try {
    const app = await createApp({
      agentRunStore: createInMemoryAgentRunStore(),
      ragService: createRuntimeSmokeRagService({ calls }),
      taskStore: createInMemoryTaskStore(),
      uploadsDirectory: path.join(tempRoot, "uploads"),
      uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    });

    server = await startServer(app);

    const healthResponse = await requestJson(server.baseUrl, "/health");

    assert.equal(healthResponse.status, 200, "/health should return 200.");
    assertHealth(healthResponse.json);

    const { first, second } = await runChatSmoke({
      baseUrl: server.baseUrl,
      sessionId: `runtime-smoke-${randomUUID()}`,
      userId,
    });
    const report = buildReport({
      calls,
      first,
      health: healthResponse.json,
      second,
      startedAt,
      userId,
    });

    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (server) {
      await server.close();
    }

    try {
      await clearLongMemories({ userId });
    } catch (error) {
      console.warn(
        "Failed to clean up runtime smoke long memories.",
        error instanceof Error ? error.message : error
      );
    }

    resetAgentExperienceMemoryStore();
    await resetLongMemoryStore();
    await rm(tempRoot, { force: true, recursive: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
