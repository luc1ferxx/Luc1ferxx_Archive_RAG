import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentExperienceMemoryObservability,
  createInMemoryAgentExperienceStore,
  configureAgentExperienceMemoryStore,
  getAgentExperienceMemoryContext,
  recordAgentExperienceFromFeedback,
  recordAgentExperienceFromRun,
  resetAgentExperienceMemoryStore,
} from "../rag/agent-experience-memory.js";
import { createAgentIntentPlanResult } from "../rag/agent-intent-planner.js";
import { AGENT_INTENT_IDS } from "../rag/agent-intent-planner.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";

const withExperienceMemoryEnabled = async (callback) => {
  const originalLongMemoryEnabled = process.env.RAG_LONG_MEMORY_ENABLED;
  const originalExperienceMemoryEnabled =
    process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED;

  process.env.RAG_LONG_MEMORY_ENABLED = "true";
  process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED = "true";

  try {
    return await callback();
  } finally {
    if (originalLongMemoryEnabled === undefined) {
      delete process.env.RAG_LONG_MEMORY_ENABLED;
    } else {
      process.env.RAG_LONG_MEMORY_ENABLED = originalLongMemoryEnabled;
    }

    if (originalExperienceMemoryEnabled === undefined) {
      delete process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED;
    } else {
      process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED =
        originalExperienceMemoryEnabled;
    }
  }
};

afterEach(() => {
  resetAgentExperienceMemoryStore();
});

test("agent experience memory records successful skill-chain runs as planning-only hints", async () => {
  await withExperienceMemoryEnabled(async () => {
    const store = createInMemoryAgentExperienceStore();
    configureAgentExperienceMemoryStore(store);

    const stored = await recordAgentExperienceFromRun({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      question: "Run contract due diligence.",
      response: {
        status: 200,
        body: {
          agentMode: "skill_chain",
          agentObservability: {
            skillChain: [
              {
                skillId: CUSTOM_SKILL_IDS.summarizeContract,
                skillVersion: "1.0.0",
              },
              {
                skillId: CUSTOM_SKILL_IDS.riskReview,
                skillVersion: "1.0.0",
              },
            ],
          },
          agentWorkingMemory: {
            resolvedGaps: [],
          },
        },
      },
      userId: "alice",
    });

    assert.equal(stored.length, 1);
    assert.equal(stored[0].intentId, AGENT_INTENT_IDS.contractReviewChain);

    const context = await getAgentExperienceMemoryContext({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      docIds: ["doc-1"],
      question: "Please do contract due diligence again.",
      userId: "alice",
    });

    assert.equal(context.enabled, true);
    assert.equal(context.memoryApplied, true);
    assert.equal(context.hitCount, 1);
    assert.equal(context.reason, "matched_planning_hints");
    assert.equal(
      context.planningHints[0].intentId,
      AGENT_INTENT_IDS.contractReviewChain
    );
    assert.match(context.plannerBlock, /planning hints only/i);
    assert.match(context.plannerBlock, /never use as document evidence/i);

    const observability = buildAgentExperienceMemoryObservability(context);

    assert.equal(observability.enabled, true);
    assert.equal(observability.applied, true);
    assert.equal(observability.hitCount, 1);
    assert.equal(
      observability.hints[0].intentId,
      AGENT_INTENT_IDS.contractReviewChain
    );
    assert.equal("text" in observability.hints[0], false);
  });
});

test("agent intent planner accepts experience hints only through whitelisted candidates", async () => {
  const result = await createAgentIntentPlanResult({
    docIds: ["doc-1"],
    experienceMemory: {
      memoryApplied: true,
      planningHints: [
        {
          confidence: 0.9,
          intentId: AGENT_INTENT_IDS.contractReviewChain,
          score: 4,
          skillChain: [
            {
              skillId: CUSTOM_SKILL_IDS.summarizeContract,
            },
            {
              skillId: CUSTOM_SKILL_IDS.riskReview,
            },
          ],
          text: "Contract due diligence usually benefits from summary then risk review.",
          type: "successful_plan",
        },
        {
          confidence: 1,
          intentId: "unregistered_tool",
          score: 10,
          text: "This should never become a candidate.",
        },
      ],
    },
    question: "Please run contract due diligence.",
  });

  assert.equal(result.plan.mode, "skill_chain");
  assert.deepEqual(result.plan.skillChain, [
    CUSTOM_SKILL_IDS.summarizeContract,
    CUSTOM_SKILL_IDS.riskReview,
  ]);
  assert.equal(result.planner.experienceMemory.applied, true);
  assert.ok(
    result.planner.candidateIntentIds.includes(AGENT_INTENT_IDS.contractReviewChain)
  );
  assert.equal(result.planner.candidateIntentIds.includes("unregistered_tool"), false);
});

test("agent experience memory records negative feedback as strict verification hints", async () => {
  await withExperienceMemoryEnabled(async () => {
    const store = createInMemoryAgentExperienceStore();
    configureAgentExperienceMemoryStore(store);

    const stored = await recordAgentExperienceFromFeedback({
      feedback: {
        userId: "alice",
        workspaceId: "workspace-a",
        feedbackType: "hallucination",
        question: "Compare refund risk across these contracts.",
        agentMode: "skill_chain",
        agentObservability: {
          skillChain: [
            {
              skillId: CUSTOM_SKILL_IDS.compareDocuments,
              skillVersion: "1.0.0",
            },
            {
              skillId: CUSTOM_SKILL_IDS.riskReview,
              skillVersion: "1.0.0",
            },
          ],
        },
        claimChecks: [
          {
            claims: [
              {
                text: "Unsupported risk claim.",
                supported: false,
              },
            ],
          },
        ],
      },
    });

    assert.equal(stored.length, 1);
    assert.equal(stored[0].type, "negative_feedback");
    assert.equal(stored[0].retrievalProfile, "strict_claim_support");

    const context = await getAgentExperienceMemoryContext({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      docIds: ["doc-1", "doc-2"],
      question: "Compare refund risk again.",
      userId: "alice",
    });

    assert.equal(context.memoryApplied, true);
    assert.equal(context.planningHints[0].type, "negative_feedback");
    assert.deepEqual(context.planningHints[0].suggestedActions, [
      "claim_support_check",
      "gap_analysis",
    ]);
  });
});
