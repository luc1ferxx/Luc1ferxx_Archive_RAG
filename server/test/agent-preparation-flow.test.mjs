import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareAgentRun,
  shouldPlanAgentRetrieval,
} from "../rag/agent-preparation-flow.js";

test("preparation flow returns clarification before query planning when scope is invalid", async () => {
  const trace = [];
  const result = await prepareAgentRun({
    addTraceStep: (step) => trace.push(step),
    chainSkills: [],
    docIds: [],
    getBudgetSnapshot: () => ({
      used: {},
    }),
    plan: {
      mode: "document",
      requiresDocuments: true,
      wantsCompareDocuments: false,
      summary: "Use selected documents.",
    },
    question: "What does the policy say?",
    returnClarification: async (clarification) => ({
      status: 200,
      body: {
        clarification,
      },
    }),
    selectedSkills: [],
    setAgentRetrievalPlan: () => {
      throw new Error("Retrieval planning should not run before clarification.");
    },
  });

  assert.equal(result.agentRetrievalPlan, null);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.body.clarification.reason, "missing_required_documents");
  assert.deepEqual(
    trace.map((step) => step.type),
    ["plan"]
  );
});

test("preparation flow adds query planner and skill chain trace for valid agent runs", async () => {
  const trace = [];
  let savedRetrievalPlan = null;
  const customSkill = {
    id: "risk_review",
    version: "1.0.0",
    label: "Risk Review",
    kind: "custom",
    budgetKey: "customSkillCalls",
  };
  const result = await prepareAgentRun({
    addTraceStep: (step) => trace.push(step),
    chainSkills: [customSkill],
    docIds: ["doc-1"],
    getBudgetSnapshot: () => ({
      used: {
        traceSteps: trace.length,
      },
    }),
    plan: {
      mode: "skill_chain",
      requiresDocuments: true,
      wantsCompareDocuments: false,
      summary: "Run chained skills.",
    },
    question: "Review this contract for risks.",
    returnClarification: async () => {
      throw new Error("Clarification should not run for valid selected docs.");
    },
    selectedSkills: [customSkill],
    setAgentRetrievalPlan: (retrievalPlan) => {
      savedRetrievalPlan = retrievalPlan;
      return retrievalPlan;
    },
  });

  assert.equal(result.response, null);
  assert.equal(result.agentRetrievalPlan, savedRetrievalPlan);
  assert.deepEqual(
    trace.map((step) => step.type),
    ["plan", "query_planner", "skill_chain"]
  );
  assert.equal(trace[1].detail.retrievalQueries.length > 0, true);
  assert.equal(trace[2].detail.skills[0].skillId, "risk_review");
});

test("preparation flow plans retrieval for document and custom skills only", () => {
  assert.equal(
    shouldPlanAgentRetrieval([
      {
        id: "document_rag",
      },
    ]),
    true
  );
  assert.equal(
    shouldPlanAgentRetrieval([
      {
        id: "risk_review",
        kind: "custom",
      },
    ]),
    true
  );
  assert.equal(
    shouldPlanAgentRetrieval([
      {
        id: "web_search",
        kind: "built_in",
      },
    ]),
    false
  );
});
