import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget } from "../rag/agent-budget.js";
import {
  AGENT_EXECUTION_STEP_IDS,
  createAgentExecutionPlanResult,
  createDeterministicAgentExecutionPlan,
  createValidatedAgentExecutionPlan,
  deterministicPlannerAdapter,
  validateAgentExecutionPlan,
} from "../rag/agent-execution-plan.js";
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

const createRegistry = (skills = []) => ({
  get: (skillId) => skills.find((skill) => skill.id === skillId) ?? null,
});

test("deterministic planner adapter emits the guarded default execution order", () => {
  const executionPlan = deterministicPlannerAdapter.createExecutionPlan();

  assert.deepEqual(executionPlan, createDeterministicAgentExecutionPlan());
  assert.deepEqual(
    executionPlan.map((step) => step.id),
    [
      AGENT_EXECUTION_STEP_IDS.arxivImport,
      AGENT_EXECUTION_STEP_IDS.workspaceAction,
      AGENT_EXECUTION_STEP_IDS.researchBrief,
      AGENT_EXECUTION_STEP_IDS.inventory,
      AGENT_EXECUTION_STEP_IDS.documentDiscovery,
      AGENT_EXECUTION_STEP_IDS.customSkills,
      AGENT_EXECUTION_STEP_IDS.documentRag,
      AGENT_EXECUTION_STEP_IDS.webSearch,
    ]
  );
});

test("validated execution planner accepts a safe adapter proposal", async () => {
  const documentSkill = createSkill({
    budgetKey: "documentRagCalls",
    execute: async () => ({}),
    id: AGENT_SKILL_IDS.documentRag,
    label: "Document RAG",
  });
  const proposedAdapter = {
    id: "test-safe",
    createExecutionPlan: async () => [
      {
        condition: "selected_skill",
        id: AGENT_EXECUTION_STEP_IDS.documentRag,
        reason: "Answer from selected documents.",
        skillId: AGENT_SKILL_IDS.documentRag,
      },
    ],
  };

  const executionPlan = await createValidatedAgentExecutionPlan({
    accessScope: {},
    plannerAdapter: proposedAdapter,
    registry: createRegistry([documentSkill]),
    selectedSkills: [documentSkill],
  });

  assert.deepEqual(
    executionPlan.map((step) => step.id),
    [AGENT_EXECUTION_STEP_IDS.documentRag]
  );
  assert.equal(executionPlan[0].reason, "Answer from selected documents.");
});

test("execution planner result reports selected planner metadata", async () => {
  const documentSkill = createSkill({
    budgetKey: "documentRagCalls",
    execute: async () => ({}),
    id: AGENT_SKILL_IDS.documentRag,
    label: "Document RAG",
  });
  const proposedAdapter = {
    id: "llm",
    createExecutionPlan: async () => {
      const plan = [
        {
          condition: "selected_skill",
          id: AGENT_EXECUTION_STEP_IDS.documentRag,
          reason: "Use document evidence first.",
          skillId: AGENT_SKILL_IDS.documentRag,
        },
      ];

      Object.defineProperty(plan, "modelRoute", {
        enumerable: false,
        value: {
          capability: "execution_planner",
          modelId: "openai.chat",
          providerId: "openai",
          routeId: "planner.execution.default",
          status: "selected",
        },
      });

      return plan;
    },
  };

  const result = await createAgentExecutionPlanResult({
    accessScope: {},
    plannerAdapter: proposedAdapter,
    registry: createRegistry([documentSkill]),
    selectedSkills: [documentSkill],
  });

  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "llm");
  assert.equal(result.planner.status, "selected");
  assert.equal(result.planner.fallback, false);
  assert.deepEqual(result.planner.modelRoute, {
    capability: "execution_planner",
    modelId: "openai.chat",
    providerId: "openai",
    routeId: "planner.execution.default",
    status: "selected",
  });
  assert.deepEqual(result.planner.stepIds, [AGENT_EXECUTION_STEP_IDS.documentRag]);
});

test("validated execution planner falls back from unsafe adapter output", async () => {
  const unsafeAdapter = {
    id: "llm",
    createExecutionPlan: async () => [
      {
        id: "shell_tool",
        reason: "Run arbitrary code.",
      },
    ],
  };

  const executionPlan = await createValidatedAgentExecutionPlan({
    accessScope: {},
    plannerAdapter: unsafeAdapter,
    registry: createRegistry([]),
    selectedSkills: [],
  });

  assert.deepEqual(
    executionPlan.map((step) => step.id),
    createDeterministicAgentExecutionPlan().map((step) => step.id)
  );
});

test("execution planner result reports fallback metadata", async () => {
  const unsafeAdapter = {
    id: "llm",
    createExecutionPlan: async () => [
      {
        id: "shell_tool",
        reason: "Run arbitrary code.",
      },
    ],
  };

  const result = await createAgentExecutionPlanResult({
    accessScope: {},
    plannerAdapter: unsafeAdapter,
    registry: createRegistry([]),
    selectedSkills: [],
  });

  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "deterministic");
  assert.equal(result.planner.status, "fallback");
  assert.equal(result.planner.fallback, true);
  assert.match(result.planner.fallbackReason, /unknown execution step shell_tool/);
  assert.deepEqual(
    result.planner.stepIds,
    createDeterministicAgentExecutionPlan().map((step) => step.id)
  );
});

test("execution plan validator rejects unknown or mismatched steps", () => {
  const documentSkill = createSkill({
    budgetKey: "documentRagCalls",
    execute: async () => ({}),
    id: AGENT_SKILL_IDS.documentRag,
    label: "Document RAG",
  });

  assert.throws(
    () =>
      validateAgentExecutionPlan({
        accessScope: {},
        executionPlan: [
          {
            id: "shell_tool",
          },
        ],
        registry: createRegistry([documentSkill]),
        selectedSkills: [documentSkill],
      }),
    /unknown execution step shell_tool/
  );

  assert.throws(
    () =>
      validateAgentExecutionPlan({
        accessScope: {},
        executionPlan: [
          {
            id: AGENT_EXECUTION_STEP_IDS.documentRag,
            skillId: AGENT_SKILL_IDS.webSearch,
          },
        ],
        registry: createRegistry([documentSkill]),
        selectedSkills: [documentSkill],
      }),
    /document_rag must reference document_rag/
  );

  assert.throws(
    () =>
      validateAgentExecutionPlan({
        accessScope: {},
        executionPlan: [
          {
            id: AGENT_EXECUTION_STEP_IDS.customSkills,
            skillId: "unregistered_tool",
          },
        ],
        registry: createRegistry([documentSkill]),
        selectedSkills: [documentSkill],
      }),
    /custom_skills cannot reference an arbitrary skillId/
  );

  assert.throws(
    () =>
      validateAgentExecutionPlan({
        accessScope: {},
        executionPlan: [
          {
            condition: "ignore_budget",
            id: AGENT_EXECUTION_STEP_IDS.documentRag,
            skillId: AGENT_SKILL_IDS.documentRag,
          },
        ],
        registry: createRegistry([documentSkill]),
        selectedSkills: [documentSkill],
      }),
    /document_rag condition must be selected_skill/
  );
});

test("execution plan validator enforces budgets and web fallback ordering", () => {
  const documentSkillWithWrongBudget = createSkill({
    budgetKey: null,
    execute: async () => ({}),
    id: AGENT_SKILL_IDS.documentRag,
    label: "Document RAG",
  });
  const webSkill = createSkill({
    budgetKey: "webSearchCalls",
    execute: async () => ({}),
    id: AGENT_SKILL_IDS.webSearch,
    label: "Web Search",
  });

  assert.throws(
    () =>
      validateAgentExecutionPlan({
        accessScope: {},
        executionPlan: [
          {
            id: AGENT_EXECUTION_STEP_IDS.documentRag,
            skillId: AGENT_SKILL_IDS.documentRag,
          },
        ],
        registry: createRegistry([documentSkillWithWrongBudget]),
        selectedSkills: [documentSkillWithWrongBudget],
      }),
    /document_rag expects budgetKey documentRagCalls/
  );

  assert.throws(
    () =>
      validateAgentExecutionPlan({
        accessScope: {},
        executionPlan: [
          {
            id: AGENT_EXECUTION_STEP_IDS.webSearch,
            skillId: AGENT_SKILL_IDS.webSearch,
          },
        ],
        registry: createRegistry([webSkill]),
        selectedSkills: [],
      }),
    /web_search fallback requires a preceding document_rag/
  );

  assert.doesNotThrow(() =>
    validateAgentExecutionPlan({
      accessScope: {},
      executionPlan: [
        {
          id: AGENT_EXECUTION_STEP_IDS.webSearch,
          skillId: AGENT_SKILL_IDS.webSearch,
        },
      ],
      registry: createRegistry([webSkill]),
      selectedSkills: [webSkill],
    })
  );
});

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
          text: "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
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
