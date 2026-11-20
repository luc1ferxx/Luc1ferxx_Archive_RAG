import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_EXECUTION_CONDITIONS,
  AGENT_EXECUTION_STEP_IDS,
  createAgentExecutionPlanResult,
} from "../rag/agent-execution-plan.js";
import { createAgentIntentPlanResult } from "../rag/agent-intent-planner.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { withPlannerRollout } from "../rag/agent-planner-rollout.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
} from "../rag/skills/registry.js";

const ACCESS_SCOPE = {
  userId: "rollout-user",
  workspaceId: "rollout-workspace",
};

test("LLM intent planner under the llm rollout selects through the validator and records the rollout", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["contract-1"],
    plannerAdapter: withPlannerRollout({
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: CUSTOM_SKILL_IDS.summarizeContract,
        reason: "The user asked for key terms.",
      }),
    }, "llm"),
    question: "Summarize the key terms in this contract.",
  });

  assert.equal(result.plan.mode, CUSTOM_SKILL_IDS.summarizeContract);
  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "llm");
  assert.equal(result.planner.selectedIntentId, CUSTOM_SKILL_IDS.summarizeContract);
  assert.equal(result.planner.rolloutMode, "llm");
  assert.equal(result.planner.fallback, false);
});

test("LLM intent planner under the llm rollout falls back when the selected intent is invalid", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["contract-1"],
    plannerAdapter: withPlannerRollout({
      id: "llm",
      selectIntentPlan: async () => ({
        selectedIntentId: "unregistered_tool",
      }),
    }, "llm"),
    question: "Review this contract for risks and key terms.",
  });

  assert.equal(result.plan.mode, SKILL_CHAIN_MODE);
  assert.equal(result.planner.rolloutMode, "llm");
  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "deterministic");
  assert.equal(result.planner.status, "fallback");
  assert.equal(result.planner.fallback, true);
  assert.match(result.planner.fallbackReason, /unregistered_tool/);
});

test("LLM execution planner under the llm rollout selects validated steps and records the rollout", async () => {
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
    }, "llm"),
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
  assert.equal(result.planner.rolloutMode, "llm");
  assert.equal(result.planner.requestedPlannerId, "llm");
  assert.equal(result.planner.selectedPlannerId, "llm");
  assert.equal(result.planner.status, "selected");
  assert.equal(result.planner.fallback, false);
});

test("LLM execution planner under the llm rollout falls back when validation rejects a step", async () => {
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
    }, "llm"),
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

  assert.equal(result.planner.rolloutMode, "llm");
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
