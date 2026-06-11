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
import { AGENT_SKILL_IDS } from "../rag/skills/registry.js";

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
    });

    assert.equal(llmPlannerAdapter.id, "llm");
    assert.match(renderedPrompt, /allowedSteps/);
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
