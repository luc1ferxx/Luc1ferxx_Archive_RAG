import test from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_CHAIN_MODE,
  buildPlan,
  buildPreExecutionClarification,
  orderSelectedSkills,
} from "../rag/agent-planner.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";

test("agent planner selects the contract review skill chain", () => {
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

test("agent planner keeps selected skills in whitelist chain order", () => {
  const selectedSkills = [
    {
      id: CUSTOM_SKILL_IDS.riskReview,
      label: "Risk Review",
    },
    {
      id: CUSTOM_SKILL_IDS.summarizeContract,
      label: "Contract Summary",
    },
  ];

  const orderedSkills = orderSelectedSkills({
    selectedSkills,
    plan: {
      skillChain: [
        CUSTOM_SKILL_IDS.summarizeContract,
        CUSTOM_SKILL_IDS.riskReview,
      ],
    },
  });

  assert.deepEqual(
    orderedSkills.map((skill) => skill.id),
    [CUSTOM_SKILL_IDS.summarizeContract, CUSTOM_SKILL_IDS.riskReview]
  );
});

test("agent planner returns pre-execution clarification for invalid comparison scope", () => {
  const plan = buildPlan({
    question: "Compare this agreement with another contract.",
    docIds: ["contract-1"],
  });
  const clarification = buildPreExecutionClarification({
    plan,
    docIds: ["contract-1"],
  });

  assert.equal(clarification.reason, "comparison_requires_multiple_documents");
  assert.equal(clarification.detail.selectedDocumentCount, 1);
  assert.equal(clarification.detail.requiredDocumentCount, 2);
});
