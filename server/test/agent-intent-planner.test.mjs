import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntentPlanCandidates,
  buildIntentPlannerPrompt,
  buildPlan,
  createAgentIntentPlanResult,
  deterministicIntentPlannerAdapter,
  llmIntentPlannerAdapter,
} from "../rag/agent-intent-planner.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { runAgentRag } from "../rag/agent.js";
import {
  getIntentPlanner,
  getSelectedSkillIds,
} from "../evaluation/chat-response-contract.js";
import {
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";
import {
  CUSTOM_SKILL_IDS,
} from "../rag/skills/registry.js";

test("agent intent planner routes arxiv topic imports without requiring documents", () => {
  const plan = buildPlan({
    question: "帮我从 arXiv 抓取 2 篇关于 retrieval augmented generation 的论文",
    docIds: [],
  });

  assert.equal(plan.mode, "arxiv_import");
  assert.equal(plan.wantsArxivImport, true);
  assert.equal(plan.wantsDocumentRag, false);
  assert.equal(plan.wantsWeb, false);
  assert.equal(plan.requiresDocuments, false);
});

test("agent intent planner selects the contract review skill chain", () => {
  const plan = buildPlan({
    question: "Review this contract for risks and key terms.",
    docIds: ["contract-1"],
  });

  assert.equal(plan.mode, SKILL_CHAIN_MODE);
  assert.deepEqual(plan.skillChain, [
    CUSTOM_SKILL_IDS.summarizeContract,
    CUSTOM_SKILL_IDS.riskReview,
  ]);
  assert.equal(plan.requiresDocuments, true);
});

test("agent intent planner exposes deterministic candidates in priority order", () => {
  const candidates = buildIntentPlanCandidates({
    question: "Review this contract for risks and key terms.",
    docIds: ["contract-1"],
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    [
      "skill_chain_contract_review",
      CUSTOM_SKILL_IDS.summarizeContract,
      "research_brief",
      "document",
    ]
  );
  assert.equal(candidates[0].plan.mode, SKILL_CHAIN_MODE);
  assert.deepEqual(candidates[0].plan.skillChain, [
    CUSTOM_SKILL_IDS.summarizeContract,
    CUSTOM_SKILL_IDS.riskReview,
  ]);
});

test("deterministic intent planner selects the highest-priority rule candidate", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: [],
    question: "帮我从 arXiv 抓取 2 篇关于 retrieval augmented generation 的论文",
  });

  assert.equal(result.plan.mode, "arxiv_import");
  assert.equal(result.planner.requestedPlannerId, "deterministic");
  assert.equal(result.planner.selectedPlannerId, "deterministic");
  assert.equal(result.planner.selectedIntentId, "arxiv_import");
  assert.equal(result.planner.status, "selected");
});

test("custom intent planner can select a whitelisted candidate without changing rule code", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["contract-1"],
    plannerAdapter: {
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: CUSTOM_SKILL_IDS.summarizeContract,
        reason: "The user asked for key terms.",
      }),
    },
    question: "Review this contract for risks and key terms.",
  });

  assert.equal(result.plan.mode, CUSTOM_SKILL_IDS.summarizeContract);
  assert.equal(result.plan.wantsContractSummary, true);
  assert.equal(result.plan.wantsRiskReview, false);
  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "llm");
  assert.equal(result.planner.selectionReason, "The user asked for key terms.");
});

test("invalid intent planner output falls back to deterministic candidates", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["contract-1"],
    plannerAdapter: {
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: "shell_tool",
      }),
    },
    question: "Review this contract for risks and key terms.",
  });

  assert.equal(result.plan.mode, "skill_chain");
  assert.deepEqual(result.plan.skillChain, [
    CUSTOM_SKILL_IDS.summarizeContract,
    CUSTOM_SKILL_IDS.riskReview,
  ]);
  assert.equal(result.planner.status, "fallback");
  assert.equal(result.planner.fallback, true);
  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "deterministic");
  assert.match(result.planner.fallbackReason, /shell_tool/);
});

test("LLM intent planner parses a provider-selected candidate id", async () => {
  configureOpenAIProvider({
    completeText: async (prompt) => {
      assert.match(prompt, /selectedIntentId/);
      assert.match(prompt, /risk_review/);

      return [
        "```json",
        JSON.stringify({
          selectedIntentId: CUSTOM_SKILL_IDS.riskReview,
          reason: "Risk wording should use the risk-review skill.",
        }),
        "```",
      ].join("\n");
    },
  });

  try {
    const result = await createAgentIntentPlanResult({
      docIds: ["policy-1"],
      plannerAdapter: llmIntentPlannerAdapter,
      question: "Review this policy for risks and gaps.",
    });

    assert.equal(result.plan.mode, CUSTOM_SKILL_IDS.riskReview);
    assert.equal(result.planner.requestedPlannerId, "llm");
    assert.equal(result.planner.selectedPlannerId, "llm");
    assert.equal(result.planner.selectedIntentId, CUSTOM_SKILL_IDS.riskReview);
    assert.equal(result.planner.status, "selected");
  } finally {
    resetOpenAIProvider();
  }
});

test("LLM intent planner prompt treats task memory as planning-only context", () => {
  const prompt = buildIntentPlannerPrompt({
    candidates: buildIntentPlanCandidates({
      docIds: ["doc-1"],
      question: "Continue the renewal review.",
    }),
    docIds: ["doc-1"],
    question: "Continue the renewal review.",
    taskMemory: {
      completedSteps: [
        {
          agentMode: "document",
          answer: "Renewal terms found.",
          question: "Summarize renewal terms.",
        },
      ],
      evidencePolicy: "planning_context_only",
      goal: "Review renewal terms.",
      nextCandidates: ["Check renewal risk."],
      userPreferences: ["Use concise bullets."],
    },
  });
  const payload = JSON.parse(prompt.split("Input:\n")[1]);

  assert.match(prompt, /Task memory, when present, is planning context only/i);
  assert.equal(payload.taskMemoryPlanningContext.goal, "Review renewal terms.");
  assert.equal(
    payload.taskMemoryPlanningContext.evidencePolicy,
    "planning_context_only"
  );
  assert.deepEqual(payload.taskMemoryPlanningContext.nextCandidates, [
    "Check renewal risk.",
  ]);
  assert.equal("ragSources" in payload.taskMemoryPlanningContext, false);
});

test("deterministic intent planner adapter is exported for app wiring", () => {
  assert.equal(deterministicIntentPlannerAdapter.id, "deterministic");
  assert.equal(typeof deterministicIntentPlannerAdapter.selectIntentPlan, "function");
});

test("runAgentRag uses the injected intent planner before selecting skills", async () => {
  const response = await runAgentRag({
    accessScope: {
      userId: "intent-user",
      workspaceId: "intent-workspace",
    },
    docIds: ["contract-1"],
    intentPlannerAdapter: {
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: CUSTOM_SKILL_IDS.summarizeContract,
        reason: "Only summarize key terms for this run.",
      }),
    },
    question: "Review this contract for risks and key terms.",
    ragService: {
      chat: async () => ({
        abstained: false,
        citations: [
          {
            chunkIndex: 0,
            docId: "contract-1",
            excerpt:
              "The services agreement renews every 12 months unless either party gives 30 days notice.",
            fileName: "services-agreement.pdf",
            pageNumber: 3,
            rank: 1,
          },
        ],
        memoryApplied: false,
        resolvedQuery: "contract summary",
        text:
          "The services agreement renews every 12 months unless either party gives 30 days notice. [Source 1]",
      }),
      listDocuments: () => [
        {
          docId: "contract-1",
          fileName: "services-agreement.pdf",
        },
      ],
    },
    sessionId: "intent-session",
    userId: "intent-user",
    webChatService: async () => {
      throw new Error("Web search should not run for this custom intent.");
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, CUSTOM_SKILL_IDS.summarizeContract);
  assert.deepEqual(getSelectedSkillIds(response), [
    CUSTOM_SKILL_IDS.summarizeContract,
  ]);
  assert.equal(getIntentPlanner(response).selectedPlannerId, "llm");
  assert.equal(
    getIntentPlanner(response).selectedIntentId,
    CUSTOM_SKILL_IDS.summarizeContract
  );
});
