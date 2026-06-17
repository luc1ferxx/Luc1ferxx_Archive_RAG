import test from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_CHAIN_MODE,
  buildPreExecutionClarification,
  orderSelectedSkills,
} from "../rag/agent-planner.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";

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
  const clarification = buildPreExecutionClarification({
    plan: {
      mode: SKILL_CHAIN_MODE,
      wantsCompareDocuments: true,
      requiresDocuments: true,
    },
    docIds: ["contract-1"],
  });

  assert.equal(clarification.reason, "comparison_requires_multiple_documents");
  assert.equal(clarification.detail.selectedDocumentCount, 1);
  assert.equal(clarification.detail.requiredDocumentCount, 2);
});
