import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget } from "../rag/agent-budget.js";
import {
  runAgentExecutionPlan,
} from "../rag/agent-execution-plan-runner.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { AGENT_SKILL_IDS } from "../rag/skills/registry.js";

const createSkill = ({
  budgetKey = null,
  createPlan,
  execute,
  id,
  kind = "built_in",
  label,
}) => ({
  id,
  version: "1.0.0",
  label,
  budgetKey,
  kind,
  requiresAccessScope: true,
  match: () => true,
  ...(createPlan ? { createPlan } : {}),
  execute,
});

const createRunnerHarness = ({
  agentBudget,
  callOrder = [],
  docIds = ["doc-1"],
  executionLoop = {
    followUpsRun: 0,
    maxFollowUps: 1,
    stoppedReason: null,
  },
  plan = {
    mode: "document",
    wantsWeb: true,
  },
  selectedSkills,
} = {}) => {
  const budgetState = createAgentBudget(agentBudget);
  const trace = [];
  const recordedClarifications = [];
  const tracker = createAgentSkillTracker({
    budgetState,
    selectedSkills,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const ragService = {
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy.pdf",
      },
    ],
  };
  const registry = {
    get: (skillId) =>
      selectedSkills.find((skill) => skill.id === skillId) ?? null,
  };

  return {
    args: {
      accessScope,
      addBudgetLimitTrace: (step) => trace.push({
        type: "budget_limit",
        ...step,
      }),
      addTraceStep: (step) => trace.push(step),
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      docIds,
      executeObservedSkill: tracker.executeObservedSkill,
      executionLoop,
      getSelectedSkill: (skillId) =>
        selectedSkills.find((skill) => skill.id === skillId) ?? null,
      plan,
      question: "What does remote work require?",
      ragService,
      recordExecutionGaps: () => [],
      recordSkippedSkill: tracker.recordSkippedSkill,
      recordSkillResult: tracker.recordSkillResult,
      recordWorkingMemoryClaimSupport: () => {},
      recordWorkingMemoryGaps: () => {},
      registry,
      resolveWorkingMemoryGaps: () => {},
      retrievalPlan: {
        retrievalQueries: [
          {
            id: "primary",
            query: "remote work approval",
          },
        ],
      },
      returnClarification: async (clarification) => {
        recordedClarifications.push(clarification);

        return {
          status: 200,
          body: {
            clarification,
          },
        };
      },
      selectedSkills,
      sessionId: "session-1",
      userId: "alice",
      webChatService: async () => {
        callOrder.push(AGENT_SKILL_IDS.webSearch);

        return {
          text: "Web answer.",
          citations: [],
        };
      },
    },
    recordedClarifications,
    trace,
    tracker,
  };
};

const createDefaultSelectedSkills = (callOrder) => [
  createSkill({
    budgetKey: "researchQuestions",
    createPlan: () => ({
      questions: [
        {
          id: "research-1",
          question: "What evidence supports remote work requirements?",
        },
      ],
    }),
    execute: async () => {
      callOrder.push(AGENT_SKILL_IDS.researchBrief);

      return {
        text: "Research brief.",
        findings: [],
        questions: [],
      };
    },
    id: AGENT_SKILL_IDS.researchBrief,
    label: "Research Brief",
  }),
  createSkill({
    execute: async () => {
      callOrder.push(AGENT_SKILL_IDS.inventory);

      return {
        text: "Inventory answer.",
        value: {
          text: "Inventory answer.",
          documents: [
            {
              docId: "doc-1",
              fileName: "policy.pdf",
            },
          ],
        },
      };
    },
    id: AGENT_SKILL_IDS.inventory,
    label: "Workspace Inventory",
  }),
  createSkill({
    execute: async () => {
      callOrder.push(AGENT_SKILL_IDS.documentDiscovery);

      return {
        text: "Discovery answer.",
        value: {
          text: "Discovery answer.",
          matches: [
            {
              document: {
                docId: "doc-1",
              },
            },
          ],
        },
      };
    },
    id: AGENT_SKILL_IDS.documentDiscovery,
    label: "Document Discovery",
  }),
  createSkill({
    budgetKey: "customSkillCalls",
    execute: async () => {
      callOrder.push("custom_review");

      return {
        text: "Custom review. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            excerpt: "Custom review.",
          },
        ],
      };
    },
    id: "custom_review",
    kind: "custom",
    label: "Custom Review",
  }),
  createSkill({
    budgetKey: "documentRagCalls",
    execute: async () => {
      callOrder.push(AGENT_SKILL_IDS.documentRag);

      return {
        text: "Remote work requires manager approval. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval.",
          },
        ],
        abstained: false,
      };
    },
    id: AGENT_SKILL_IDS.documentRag,
    label: "Document RAG",
  }),
  createSkill({
    budgetKey: "webSearchCalls",
    execute: async ({ webChatService }) => webChatService(),
    id: AGENT_SKILL_IDS.webSearch,
    label: "Web Search",
  }),
];

test("execution plan runner preserves the default skill execution order", async () => {
  const callOrder = [];
  const selectedSkills = createDefaultSelectedSkills(callOrder);
  const harness = createRunnerHarness({
    callOrder,
    selectedSkills,
  });

  const result = await runAgentExecutionPlan(harness.args);

  assert.equal(result.response, null);
  assert.deepEqual(callOrder, [
    AGENT_SKILL_IDS.researchBrief,
    AGENT_SKILL_IDS.inventory,
    AGENT_SKILL_IDS.documentDiscovery,
    "custom_review",
    AGENT_SKILL_IDS.documentRag,
    AGENT_SKILL_IDS.webSearch,
  ]);
  assert.equal(result.inventoryAnswer, "Inventory answer.");
  assert.equal(result.discoveryAnswer, "Discovery answer.");
  assert.equal(result.customSkillResults[0].skillId, "custom_review");
  assert.equal(result.documentRagSkill.id, AGENT_SKILL_IDS.documentRag);
  assert.equal(result.ragResult.skillId, AGENT_SKILL_IDS.documentRag);
  assert.equal(result.webResult.skillId, AGENT_SKILL_IDS.webSearch);
  assert.equal(result.shouldRunWeb, true);
  assert.deepEqual(
    harness.trace.map((step) => step.type),
    [
      "research_plan",
      "inventory",
      "document_discovery",
      "custom_skill",
      "document_rag",
      "self_check",
      "web_search",
    ]
  );
});

test("execution plan runner returns clarification before web fallback when document evidence is unresolved", async () => {
  const callOrder = [];
  const selectedSkills = [
    createSkill({
      budgetKey: "documentRagCalls",
      execute: async () => {
        callOrder.push(AGENT_SKILL_IDS.documentRag);

        return {
          text: "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
          citations: [
            {
              docId: "doc-1",
              fileName: "policy.pdf",
              pageNumber: 2,
              excerpt: "Remote work requires manager approval.",
            },
          ],
          abstained: false,
        };
      },
      id: AGENT_SKILL_IDS.documentRag,
      label: "Document RAG",
    }),
    createSkill({
      budgetKey: "webSearchCalls",
      execute: async ({ webChatService }) => webChatService(),
      id: AGENT_SKILL_IDS.webSearch,
      label: "Web Search",
    }),
  ];
  const harness = createRunnerHarness({
    callOrder,
    executionLoop: {
      followUpsRun: 0,
      maxFollowUps: 0,
      stoppedReason: null,
    },
    plan: {
      mode: "document",
      wantsWeb: false,
    },
    selectedSkills,
  });

  const result = await runAgentExecutionPlan(harness.args);

  assert.equal(result.response.status, 200);
  assert.equal(
    result.response.body.clarification.reason,
    "document_follow_up_limit_reached"
  );
  assert.deepEqual(callOrder, [AGENT_SKILL_IDS.documentRag]);
  assert.equal(result.webResult, null);
  assert.equal(harness.recordedClarifications.length, 1);
  assert.deepEqual(
    harness.trace.map((step) => step.type),
    ["document_rag", "self_check"]
  );
});
