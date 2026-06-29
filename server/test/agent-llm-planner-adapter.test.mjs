import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_EXECUTION_CONDITIONS,
  AGENT_EXECUTION_STEP_IDS,
} from "../rag/agent-execution-plan.js";
import { llmPlannerAdapter } from "../rag/agent-llm-planner-adapter.js";
import {
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
} from "../rag/skills/registry.js";

test("llm planner adapter parses fenced JSON execution plan output", async () => {
  let renderedPrompt = "";

  configureOpenAIProvider({
    completeText: async (prompt) => {
      renderedPrompt = prompt;

      return [
        "```json",
        JSON.stringify({
          steps: [
            {
              condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
              id: AGENT_EXECUTION_STEP_IDS.documentRag,
              reason: "Use document evidence first.",
              skillId: AGENT_SKILL_IDS.documentRag,
            },
          ],
        }),
        "```",
      ].join("\n");
    },
  });

  try {
    const executionPlan = await llmPlannerAdapter.createExecutionPlan({
      docIds: ["doc-1"],
      plan: {
        mode: "document",
        wantsWeb: false,
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
      taskMemory: {
        completedSteps: [
          {
            agentMode: "document",
            answer: "Policy summary found.",
            question: "Summarize the policy.",
          },
        ],
        evidencePolicy: "planning_context_only",
        goal: "Review policy obligations.",
        nextCandidates: ["Check exceptions."],
        userPreferences: ["Keep answers short."],
      },
    });

    assert.equal(llmPlannerAdapter.id, "llm");
    assert.match(renderedPrompt, /allowedSteps/);
    assert.match(renderedPrompt, /Task memory, when present, is planning context only/i);
    assert.match(renderedPrompt, /taskMemoryPlanningContext/);
    assert.doesNotMatch(renderedPrompt, /ragSources/);
    assert.equal(executionPlan.modelRoute.status, "custom_provider");
    assert.equal(executionPlan.modelRoute.providerId, "custom_provider");
    assert.deepEqual(executionPlan, [
      {
        condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
        id: AGENT_EXECUTION_STEP_IDS.documentRag,
        reason: "Use document evidence first.",
        skillId: AGENT_SKILL_IDS.documentRag,
      },
    ]);
  } finally {
    resetOpenAIProvider();
  }
});

test("llm planner adapter rejects responses without execution steps", async () => {
  configureOpenAIProvider({
    completeText: async () => JSON.stringify({ steps: [] }),
  });

  try {
    await assert.rejects(
      () => llmPlannerAdapter.createExecutionPlan({ question: "Hello?" }),
      /non-empty steps array/
    );
  } finally {
    resetOpenAIProvider();
  }
});

test("llm planner adapter collapses per-custom-skill steps into one custom step", async () => {
  configureOpenAIProvider({
    completeText: async () =>
      JSON.stringify({
        steps: [
          {
            condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
            id: AGENT_EXECUTION_STEP_IDS.documentDiscovery,
            reason: "Find relevant documents first.",
            skillId: AGENT_SKILL_IDS.documentDiscovery,
          },
          {
            condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
            id: AGENT_EXECUTION_STEP_IDS.documentRag,
            reason: "Run document RAG first.",
            skillId: AGENT_SKILL_IDS.documentRag,
          },
          {
            condition: AGENT_EXECUTION_CONDITIONS.selectedCustomSkills,
            id: AGENT_EXECUTION_STEP_IDS.customSkills,
            reason: "Run contract summary.",
            skillId: CUSTOM_SKILL_IDS.summarizeContract,
          },
          {
            condition: AGENT_EXECUTION_CONDITIONS.selectedCustomSkills,
            id: AGENT_EXECUTION_STEP_IDS.customSkills,
            reason: "Run risk review.",
            skillId: CUSTOM_SKILL_IDS.riskReview,
          },
        ],
      }),
  });

  try {
    const executionPlan = await llmPlannerAdapter.createExecutionPlan({
      docIds: ["contract-1"],
      plan: {
        mode: "skill_chain",
        wantsWeb: false,
      },
      question: "Review this contract for risks and key terms.",
      selectedSkills: [
        {
          budgetKey: "customSkillCalls",
          id: CUSTOM_SKILL_IDS.summarizeContract,
          kind: "custom",
          label: "Summarize Contract",
          requiresAccessScope: true,
        },
        {
          budgetKey: "customSkillCalls",
          id: CUSTOM_SKILL_IDS.riskReview,
          kind: "custom",
          label: "Risk Review",
          requiresAccessScope: true,
        },
      ],
    });

    assert.deepEqual(executionPlan, [
      {
        condition: AGENT_EXECUTION_CONDITIONS.selectedCustomSkills,
        id: AGENT_EXECUTION_STEP_IDS.customSkills,
        reason: "Run contract summary.",
      },
    ]);
  } finally {
    resetOpenAIProvider();
  }
});
