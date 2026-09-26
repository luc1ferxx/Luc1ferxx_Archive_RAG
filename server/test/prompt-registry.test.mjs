import assert from "node:assert/strict";
import test from "node:test";
import { llmIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { getIntentPlannerPromptDescriptor } from "../rag/agent-intent-llm-adapter.js";
import { runAgentRag } from "../rag/agent.js";
import { normalizeLlmOpsMetricEvent } from "../rag/llmops-metrics.js";
import {
  completeTextWithMetadata,
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";
import {
  describeActivePromptTemplates,
  getActivePromptTemplates,
  listPromptTemplates,
} from "../rag/prompt-catalog.js";
import {
  definePrompt,
  hashPromptSet,
  normalizePromptDescriptor,
  PROMPT_IDS,
} from "../rag/prompt-registry.js";
import { createRunUsage, getRunPromptUsage, runWithRunUsage } from "../rag/run-usage.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";

// Every released template, pinned to its fingerprint. A failure here means a
// prompt changed. That is fine when intended, but it must not change silently
// under a version label that earlier runs and reports already recorded: give
// the template a new version label where its descriptor is defined (the
// `version` passed to definePrompt, or `versions` in answer-writer.js) and pin
// the new id@version below.
const PINNED_PROMPT_TEMPLATES = Object.freeze({
  // v2: sources are data, not instructions (prompt-injection hardening).
  "claim_judge@v2": "1f7dda59a211",
  "comparison_answer@v1.1": "5cfc615314eb",
  "comparison_answer@v2.1": "2046647cec58",
  "dag_planner@v1": "9b264db384f8",
  "execution_planner@v1": "46e1a0502f34",
  "guarded_comparison_answer@v1.1": "5a59976484cd",
  "guarded_comparison_answer@v2.1": "e5f60f0f5aba",
  "intent_planner@v1": "088ec96ebb85",
  "memory_query_rewrite@v1": "482c557f3448",
  "memory_query_rewrite@v2": "c695383ae9e3",
  "memory_query_rewrite@v3": "2dc8733dd00c",
  // v1.2 / v2.2: lead with the shortest direct answer.
  "qa_answer@v1.2": "b96d76d43661",
  "qa_answer@v2.2": "69647d5ad62c",
  // v1.3 / v2.3: the not-in-evidence verdict (RAG_QA_ANSWER_VERDICT on).
  "qa_answer@v1.3": "c57f90a838c7",
  "qa_answer@v2.3": "f13805dcc49f",
  "replanner@v1": "16e4034680c7",
  "web_answer@v1.1": "26e8ffa6c6c4",
  "web_answer@v2.1": "9fb8253dfa4f",
});

test("every prompt template matches its pinned fingerprint", () => {
  const actual = Object.fromEntries(
    listPromptTemplates().map(({ fingerprint, id, version }) => [`${id}@${version}`, fingerprint])
  );

  for (const [key, fingerprint] of Object.entries(actual)) {
    assert.equal(
      PINNED_PROMPT_TEMPLATES[key],
      fingerprint,
      `${key} is now ${fingerprint}. Record the edited template under a new version label and pin it here.`
    );
  }

  assert.deepEqual(Object.keys(actual).sort(), Object.keys(PINNED_PROMPT_TEMPLATES).sort());
});

test("every prompt id has templates and the active set picks exactly one per id", () => {
  const listedIds = new Set(listPromptTemplates().map((template) => template.id));
  const active = getActivePromptTemplates();
  const activeIds = active.map((template) => template.id);

  assert.deepEqual([...listedIds].sort(), Object.values(PROMPT_IDS).sort());
  assert.equal(new Set(activeIds).size, activeIds.length, "one active template per id");
  // Exactly one of the two comparison prompts is active, by configuration.
  assert.equal(activeIds.length, Object.values(PROMPT_IDS).length - 1);
});

test("the active set follows RAG_PROMPT_VERSION and hashes independently of order", () => {
  const previous = process.env.RAG_PROMPT_VERSION;

  try {
    process.env.RAG_PROMPT_VERSION = "v1";
    const v1 = describeActivePromptTemplates();

    process.env.RAG_PROMPT_VERSION = "v3";
    const v3 = describeActivePromptTemplates();

    assert.equal(v1.templates.find((template) => template.id === "qa_answer").version, "v1.2");
    assert.equal(v3.templates.find((template) => template.id === "qa_answer").version, "v2.2");
    assert.equal(
      v3.templates.find((template) => template.id === "memory_query_rewrite").version,
      "v3"
    );
    assert.notEqual(v1.setHash, v3.setHash);
    assert.equal(hashPromptSet([...v3.templates].reverse()), v3.setHash);
  } finally {
    if (previous === undefined) {
      delete process.env.RAG_PROMPT_VERSION;
    } else {
      process.env.RAG_PROMPT_VERSION = previous;
    }
  }
});

test("a descriptor is identity only: prompt text and malformed values are dropped", () => {
  const descriptor = definePrompt({ id: "qa_answer", source: "Answer {question}", version: "v9" });

  assert.equal(descriptor.fingerprint.length, 12);
  assert.notEqual(
    definePrompt({ id: "qa_answer", source: "Answer {question}.", version: "v9" }).fingerprint,
    descriptor.fingerprint
  );
  assert.equal(normalizePromptDescriptor("Answer the question about the secret."), null);
  assert.equal(normalizePromptDescriptor({ ...descriptor, fingerprint: "zz" }), null);
  assert.throws(() => definePrompt({ id: "qa_answer", source: " ", version: "v1" }), /no source/);

  const event = normalizeLlmOpsMetricEvent({
    operation: "llm_completion",
    prompt: "raw prompt text must never be serialized",
    promptTemplate: descriptor,
    status: "ok",
  });

  assert.deepEqual(event.promptTemplate, { ...descriptor });
  assert.equal(event.prompt, undefined);
  assert.equal(normalizeLlmOpsMetricEvent({ status: "ok" }).promptTemplate, null);
});

test("a model call's template reaches the run ledger through its LLMOps event", async (t) => {
  t.after(() => resetOpenAIProvider());
  configureOpenAIProvider({ completeText: async () => "answer" });

  const [qa] = listPromptTemplates().filter((template) => template.id === "qa_answer");
  const runUsage = createRunUsage();

  await runWithRunUsage(runUsage, async () => {
    await completeTextWithMetadata("first", { promptTemplate: qa });
    await completeTextWithMetadata("second", { promptTemplate: qa });
    await completeTextWithMetadata("unnamed");
  });

  assert.deepEqual(
    getRunPromptUsage(runUsage).map(({ calls, fingerprint, id, version }) => ({
      calls,
      fingerprint,
      id,
      version,
    })),
    [{ ...qa, calls: 2 }]
  );
  assert.equal(runUsage.used.modelCalls, 3, "unnamed calls are still charged");
});

test("an agent run records the template behind its LLM planner decision", async (t) => {
  t.after(() => resetOpenAIProvider());
  configureOpenAIProvider({
    completeText: async () =>
      JSON.stringify({
        reason: "Summarize the key terms.",
        selectedIntentId: CUSTOM_SKILL_IDS.summarizeContract,
      }),
  });

  const response = await runAgentRag({
    accessScope: { userId: "prompt-user", workspaceId: "prompt-workspace" },
    docIds: ["contract-1"],
    intentPlannerAdapter: llmIntentPlannerAdapter,
    question: "Summarize the key terms of this contract.",
    ragService: {
      chat: async () => ({
        abstained: false,
        citations: [
          {
            chunkIndex: 0,
            docId: "contract-1",
            excerpt: "The agreement renews every 12 months.",
            fileName: "services-agreement.pdf",
            pageNumber: 1,
            rank: 1,
          },
        ],
        memoryApplied: false,
        resolvedQuery: "contract summary",
        text: "The agreement renews every 12 months. [Source 1]",
      }),
      listDocuments: () => [{ docId: "contract-1", fileName: "services-agreement.pdf" }],
    },
    sessionId: "prompt-session",
    userId: "prompt-user",
    webChatService: async () => ({ text: "unused" }),
  });
  const observability = response.body.agentObservability;
  const intentTemplate = getIntentPlannerPromptDescriptor();

  assert.equal(response.status, 200);
  assert.deepEqual(observability.intentPlanner.promptTemplate, { ...intentTemplate });
  assert.deepEqual(
    observability.promptTemplates.map(({ calls, id, version }) => ({ calls, id, version })),
    [{ calls: 1, id: intentTemplate.id, version: intentTemplate.version }]
  );
});
