import test from "node:test";
import assert from "node:assert/strict";
import { createAgentSession } from "../rag/agent-bootstrap.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";

const createSkill = ({ id, label }) => ({
  id,
  version: "1.0.0",
  label,
  budgetKey: "customSkillCalls",
  kind: "custom",
  requiresAccessScope: true,
  match: ({ plan }) => plan.skillChain?.includes(id),
  execute: async () => ({
    text: `${label} result.`,
  }),
});

test("agent bootstrap creates an ordered session with working memory and selected skills", () => {
  const riskSkill = createSkill({
    id: CUSTOM_SKILL_IDS.riskReview,
    label: "Risk Review",
  });
  const summarySkill = createSkill({
    id: CUSTOM_SKILL_IDS.summarizeContract,
    label: "Contract Summary",
  });
  const session = createAgentSession({
    docIds: ["contract-1"],
    question: "Review this contract for risks and key terms.",
    skillRegistry: {
      select: ({ plan, docIds }) => [
        riskSkill,
        summarySkill,
      ].filter((skill) => skill.match({
        plan,
        docIds,
      })),
    },
  });

  assert.equal(session.plan.mode, SKILL_CHAIN_MODE);
  assert.deepEqual(
    session.selectedSkills.map((skill) => skill.id),
    [CUSTOM_SKILL_IDS.summarizeContract, CUSTOM_SKILL_IDS.riskReview]
  );
  assert.equal(session.getSelectedSkill(CUSTOM_SKILL_IDS.riskReview), riskSkill);
  assert.equal(session.workingMemory.goal, "Review this contract for risks and key terms.");
  assert.equal(session.executionLoop.maxFollowUps, 1);
  assert.equal(session.getSkillObservations().length, 2);
});

test("agent bootstrap exposes run context helpers wired to the session budget", () => {
  const session = createAgentSession({
    agentBudget: {
      maxTraceSteps: 1,
    },
    docIds: ["doc-1"],
    question: "What does the document say?",
    skillRegistry: {
      select: () => [],
    },
  });

  assert.equal(
    session.addTraceStep({
      type: "plan",
      label: "Plan",
      summary: "Plan created.",
    }),
    true
  );
  assert.equal(
    session.addTraceStep({
      type: "query_planner",
      label: "Query Planner",
      summary: "Should be truncated.",
    }),
    false
  );
  assert.equal(session.trace.length, 1);
  assert.equal(session.getBudgetSnapshot().traceTruncated, true);
});
