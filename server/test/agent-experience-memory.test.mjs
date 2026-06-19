import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentExperienceMemoryObservability,
  createInMemoryAgentExperienceStore,
  configureAgentExperienceMemoryStore,
  getAgentExperienceMemoryContext,
  recordAgentExperienceFromFeedback,
  recordAgentExperienceFromRun,
} from "../rag/agent-experience-memory.js";
import { createAgentIntentPlanResult } from "../rag/agent-intent-planner.js";
import { AGENT_INTENT_IDS } from "../rag/agent-intent-planner.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";
import { withAgentExperienceMemoryEnabled } from "./agent-experience-memory-test-helpers.mjs";

test("agent experience memory records successful skill-chain runs as planning-only hints", async () => {
  await withAgentExperienceMemoryEnabled(async () => {
    const store = createInMemoryAgentExperienceStore();
    configureAgentExperienceMemoryStore(store);

    const writeResult = await recordAgentExperienceFromRun({
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
          ragSources: [
            {
              docId: "doc-1",
              excerpt: "The contract renews annually.",
            },
          ],
        },
      },
      userId: "alice",
    });

    assert.equal(writeResult.status, "stored");
    assert.equal(writeResult.writeAttempted, true);
    assert.equal(writeResult.storedCount, 1);
    assert.equal(
      writeResult.storedRecords[0].intentId,
      AGENT_INTENT_IDS.contractReviewChain
    );
    assert.equal(writeResult.observability.storedCount, 1);
    assert.equal("text" in writeResult.observability.storedRecords[0], false);

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

    const isolatedContext = await getAgentExperienceMemoryContext({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-b",
      },
      docIds: ["doc-1"],
      question: "Please do contract due diligence again.",
      userId: "alice",
    });

    assert.equal(isolatedContext.memoryApplied, false);
    assert.equal(isolatedContext.reason, "no_matching_hints");

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

test("agent experience memory skips unsafe or unsupported run writes", async () => {
  await withAgentExperienceMemoryEnabled(async () => {
    const store = createInMemoryAgentExperienceStore();
    configureAgentExperienceMemoryStore(store);
    const baseResponse = {
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
      },
    };

    let writeResult = await recordAgentExperienceFromRun({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      question: "Run contract due diligence.",
      response: baseResponse,
      userId: "alice",
    });

    assert.equal(writeResult.status, "skipped");
    assert.equal(writeResult.skippedReason, "no_evidence");
    assert.equal(writeResult.writeAttempted, false);
    assert.equal(writeResult.recordCount, 1);
    assert.equal(store.snapshot().length, 0);

    writeResult = await recordAgentExperienceFromRun({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      question: "Search the web first.",
      response: {
        status: 200,
        body: {
          agentMode: "clarification",
          approvalGates: [
            {
              id: "approval:web.search:1.0.0",
              status: "pending",
            },
          ],
          clarification: {
            needed: true,
            reason: "capability_approval_required",
          },
        },
      },
      userId: "alice",
    });

    assert.equal(writeResult.status, "skipped");
    assert.equal(writeResult.skippedReason, "approval_pending");
    assert.equal(store.snapshot().length, 0);
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
  await withAgentExperienceMemoryEnabled(async () => {
    const store = createInMemoryAgentExperienceStore();
    configureAgentExperienceMemoryStore(store);

    const writeResult = await recordAgentExperienceFromFeedback({
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

    assert.equal(writeResult.status, "stored");
    assert.equal(writeResult.writeAttempted, true);
    assert.equal(writeResult.storedCount, 1);
    assert.equal(writeResult.storedRecords[0].type, "negative_feedback");
    assert.equal(
      writeResult.storedRecords[0].retrievalProfile,
      "strict_claim_support"
    );
    assert.equal("text" in writeResult.observability.storedRecords[0], false);

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

test("agent experience memory skips non-negative feedback and prunes old hints", async () => {
  await withAgentExperienceMemoryEnabled(async () => {
    let tick = 0;
    const store = createInMemoryAgentExperienceStore({
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    });
    configureAgentExperienceMemoryStore(store);

    let writeResult = await recordAgentExperienceFromFeedback({
      feedback: {
        userId: "alice",
        workspaceId: "workspace-a",
        feedbackType: "helpful",
        question: "Compare renewal risk.",
        answerText: "Looks good.",
      },
    });

    assert.equal(writeResult.status, "skipped");
    assert.equal(writeResult.skippedReason, "feedback_not_negative");
    assert.equal(store.snapshot().length, 0);

    for (let index = 0; index < 92; index += 1) {
      writeResult = await recordAgentExperienceFromFeedback({
        feedback: {
          userId: "alice",
          workspaceId: "workspace-a",
          feedbackType: "hallucination",
          question: `Compare renewal risk topic${index}.`,
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
                  supported: false,
                  text: `Unsupported risk claim topic${index}.`,
                },
              ],
            },
          ],
        },
      });
    }

    assert.equal(writeResult.status, "stored");
    assert.equal(writeResult.prunedCount, 1);
    assert.equal(store.snapshot().length, 40);
    assert.equal(
      store.snapshot().some((record) =>
        record.signatureTerms.includes("topic0")
      ),
      false
    );
  });
});
