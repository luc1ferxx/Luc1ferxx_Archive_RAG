import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_EXECUTION_CONDITIONS,
  AGENT_EXECUTION_STEP_IDS,
  createAgentExecutionPlanResult,
  deterministicPlannerAdapter,
} from "../rag/agent-execution-plan.js";
import {
  createAgentIntentPlanResult,
  deterministicIntentPlannerAdapter,
} from "../rag/agent-intent-planner.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import {
  withPlannerRollout,
  withShadowPlanner,
} from "../rag/agent-planner-shadow.js";
import { getAgentPlannerRollout } from "../rag/config.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
} from "../rag/skills/registry.js";

const ACCESS_SCOPE = {
  userId: "shadow-user",
  workspaceId: "shadow-workspace",
};

test("intent planner shadow records an LLM proposal without changing the selected plan", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["contract-1"],
    plannerAdapter: withShadowPlanner(deterministicIntentPlannerAdapter, {
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: CUSTOM_SKILL_IDS.summarizeContract,
        reason: "Shadow planner would summarize before risk review.",
      }),
    }),
    question: "Review this contract for risks and key terms.",
  });

  assert.equal(result.plan.mode, SKILL_CHAIN_MODE);
  assert.deepEqual(result.plan.skillChain, [
    CUSTOM_SKILL_IDS.summarizeContract,
    CUSTOM_SKILL_IDS.riskReview,
  ]);
  assert.equal(result.planner.requestedPlannerId, "deterministic");
  assert.equal(result.planner.selectedPlannerId, "deterministic");
  assert.equal(result.planner.selectedIntentId, "skill_chain_contract_review");
  assert.equal(result.planner.shadow.requestedPlannerId, "llm");
  assert.equal(result.planner.shadow.status, "selected");
  assert.equal(
    result.planner.shadow.selectedIntentId,
    CUSTOM_SKILL_IDS.summarizeContract
  );
  assert.equal(result.planner.shadow.selectedMode, CUSTOM_SKILL_IDS.summarizeContract);
  assert.equal(result.planner.shadow.diverged, true);
  assert.equal(result.planner.shadow.error, null);
  assert.equal(typeof result.planner.shadow.latencyMs, "number");
});

test("intent planner shadow errors do not force deterministic fallback metadata", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["contract-1"],
    plannerAdapter: withShadowPlanner(deterministicIntentPlannerAdapter, {
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: "shell_tool",
      }),
    }),
    question: "Review this contract for risks and key terms.",
  });

  assert.equal(result.plan.mode, SKILL_CHAIN_MODE);
  assert.equal(result.planner.status, "selected");
  assert.equal(result.planner.fallback, false);
  assert.equal(result.planner.shadow.status, "error");
  assert.match(result.planner.shadow.error, /shell_tool/);
  assert.equal(result.planner.shadow.diverged, null);
});

test("execution planner shadow records alternate steps without changing execution order", async () => {
  const result = await createAgentExecutionPlanResult({
    accessScope: ACCESS_SCOPE,
    plannerAdapter: withShadowPlanner(deterministicPlannerAdapter, {
      id: "llm",
      createExecutionPlan: async () => [
        {
          condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
          id: AGENT_EXECUTION_STEP_IDS.documentRag,
          reason: "Shadow planner would run only document evidence.",
          skillId: AGENT_SKILL_IDS.documentRag,
        },
      ],
    }),
    plannerContext: {
      docIds: ["policy-1"],
      plan: {
        mode: "document",
      },
      question: "What does the policy require?",
      selectedSkills: [
        {
          budgetKey: "documentRagCalls",
          id: AGENT_SKILL_IDS.documentRag,
          kind: "built_in",
          label: "Document RAG",
          requiresAccessScope: true,
        },
      ],
    },
    selectedSkills: [
      {
        budgetKey: "documentRagCalls",
        id: AGENT_SKILL_IDS.documentRag,
        kind: "built_in",
        label: "Document RAG",
        requiresAccessScope: true,
      },
    ],
  });

  assert.deepEqual(
    result.executionPlan.map((step) => step.id),
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
  assert.equal(result.planner.selectedPlannerId, "deterministic");
  assert.deepEqual(result.planner.shadow.stepIds, [
    AGENT_EXECUTION_STEP_IDS.documentRag,
  ]);
  assert.equal(result.planner.shadow.requestedPlannerId, "llm");
  assert.equal(result.planner.shadow.status, "selected");
  assert.equal(result.planner.shadow.diverged, true);
  assert.equal(result.planner.shadow.error, null);
});

test("guarded LLM intent planner selects through the validator", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["contract-1"],
    plannerAdapter: withPlannerRollout({
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: CUSTOM_SKILL_IDS.summarizeContract,
        reason: "The user asked for key terms.",
      }),
    }, "guarded_llm"),
    question: "Summarize the key terms in this contract.",
  });

  assert.equal(result.plan.mode, CUSTOM_SKILL_IDS.summarizeContract);
  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "llm");
  assert.equal(result.planner.selectedIntentId, CUSTOM_SKILL_IDS.summarizeContract);
  assert.equal(result.planner.rolloutMode, "guarded_llm");
  assert.equal(result.planner.fallback, false);
});

test("guarded LLM intent planner falls back when the selected intent is invalid", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["contract-1"],
    plannerAdapter: withPlannerRollout({
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: "unregistered_tool",
      }),
    }, "guarded_llm"),
    question: "Review this contract for risks and key terms.",
  });

  assert.equal(result.plan.mode, SKILL_CHAIN_MODE);
  assert.equal(result.planner.rolloutMode, "guarded_llm");
  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "deterministic");
  assert.equal(result.planner.status, "fallback");
  assert.equal(result.planner.fallback, true);
  assert.match(result.planner.fallbackReason, /unregistered_tool/);
});

test("guarded LLM execution planner selects validated steps", async () => {
  const result = await createAgentExecutionPlanResult({
    accessScope: ACCESS_SCOPE,
    plannerAdapter: withPlannerRollout({
      id: "llm",
      createExecutionPlan: async () => [
        {
          condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
          id: AGENT_EXECUTION_STEP_IDS.documentRag,
          reason: "Use selected document evidence.",
          skillId: AGENT_SKILL_IDS.documentRag,
        },
      ],
    }, "guarded_llm"),
    plannerContext: {
      docIds: ["policy-1"],
      plan: {
        mode: "document",
      },
      question: "What does the policy require?",
      selectedSkills: [
        {
          budgetKey: "documentRagCalls",
          id: AGENT_SKILL_IDS.documentRag,
          kind: "built_in",
          label: "Document RAG",
          requiresAccessScope: true,
        },
      ],
    },
    selectedSkills: [
      {
        budgetKey: "documentRagCalls",
        id: AGENT_SKILL_IDS.documentRag,
        kind: "built_in",
        label: "Document RAG",
        requiresAccessScope: true,
      },
    ],
  });

  assert.deepEqual(result.executionPlan.map((step) => step.id), [
    AGENT_EXECUTION_STEP_IDS.documentRag,
  ]);
  assert.equal(result.planner.rolloutMode, "guarded_llm");
  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "llm");
  assert.equal(result.planner.status, "selected");
  assert.equal(result.planner.fallback, false);
});

test("guarded LLM execution planner falls back when validation rejects a step", async () => {
  const result = await createAgentExecutionPlanResult({
    accessScope: ACCESS_SCOPE,
    plannerAdapter: withPlannerRollout({
      id: "llm",
      createExecutionPlan: async () => [
        {
          id: "shell_tool",
          reason: "Invalid external tool.",
        },
      ],
    }, "guarded_llm"),
    selectedSkills: [
      {
        budgetKey: "documentRagCalls",
        id: AGENT_SKILL_IDS.documentRag,
        kind: "built_in",
        label: "Document RAG",
        requiresAccessScope: true,
      },
    ],
  });

  assert.equal(result.planner.rolloutMode, "guarded_llm");
  assert.equal(result.planner.selectedPlannerId, "deterministic");
  assert.equal(result.planner.status, "fallback");
  assert.equal(result.planner.fallback, true);
  assert.match(result.planner.fallbackReason, /shell_tool/);
  assert.deepEqual(
    result.executionPlan.map((step) => step.id),
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

test("planner rollout config accepts guarded_llm", () => {
  const originalValue = process.env.AGENT_PLANNER_ROLLOUT;
  process.env.AGENT_PLANNER_ROLLOUT = "guarded_llm";

  try {
    assert.equal(getAgentPlannerRollout(), "guarded_llm");
  } finally {
    if (originalValue === undefined) {
      delete process.env.AGENT_PLANNER_ROLLOUT;
    } else {
      process.env.AGENT_PLANNER_ROLLOUT = originalValue;
    }
  }
});
