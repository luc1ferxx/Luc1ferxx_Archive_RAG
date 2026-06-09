import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget } from "../rag/agent-budget.js";
import { runDocumentRagLoop } from "../rag/agent-document-loop.js";
import { buildAgentRetrievalPlan } from "../rag/agent-query-planner.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { createAgentWorkingMemory } from "../rag/agent-working-memory.js";

const documentRagSkill = {
  id: "document_rag",
  version: "1.0.0",
  label: "Document RAG",
  budgetKey: "documentRagCalls",
  requiresAccessScope: true,
  match: () => true,
  execute: async () => {
    throw new Error("Override executeObservedSkill in tests.");
  },
};

const createLoopHarness = ({
  agentBudget,
  docIds = ["doc-1"],
  question = "What does remote work require?",
  ragResponses = [],
} = {}) => {
  const budgetState = createAgentBudget(agentBudget);
  const trace = [];
  const recordedBudgetLimits = [];
  const askedQuestions = [];
  const {
    executionLoop,
    recordExecutionGaps,
    recordWorkingMemoryClaimSupport,
    recordWorkingMemoryGaps,
    recordWorkingMemoryQueries,
    resolveWorkingMemoryGaps,
    workingMemory,
  } = createAgentWorkingMemory({
    docIds,
    maxFollowUps: 1,
    question,
  });
  let responseIndex = 0;
  const ragService = {};
  const retrievalPlan = buildAgentRetrievalPlan({
    question,
    plan: {
      mode: "document",
    },
    docIds,
  });
  const skill = {
    ...documentRagSkill,
    execute: async (args) => {
      askedQuestions.push(args.question);
      const value = ragResponses[responseIndex++];

      return {
        ...value,
        traceDetail: {
          retrievalPlan: args.retrievalPlan,
        },
      };
    },
  };
  const tracker = createAgentSkillTracker({
    budgetState,
    recordWorkingMemoryQueries,
    selectedSkills: [skill],
  });

  return {
    args: {
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      addBudgetLimitTrace: (event) => recordedBudgetLimits.push(event),
      addTraceStep: (step) => trace.push(step),
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      docIds,
      documentRagSkill: skill,
      executeObservedSkill: tracker.executeObservedSkill,
      executionLoop,
      plan: {
        mode: "document",
      },
      question,
      ragService,
      recordExecutionGaps,
      recordSkippedSkill: tracker.recordSkippedSkill,
      recordSkillResult: tracker.recordSkillResult,
      recordWorkingMemoryClaimSupport,
      recordWorkingMemoryGaps,
      resolveWorkingMemoryGaps,
      retrievalPlan,
      sessionId: "session-1",
      userId: "alice",
    },
    askedQuestions,
    executionLoop,
    recordedBudgetLimits,
    trace,
    tracker,
    workingMemory,
  };
};

test("document loop runs focused follow-up when primary evidence lacks claim support", async () => {
  const harness = createLoopHarness({
    ragResponses: [
      {
        text: "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
        abstained: false,
      },
      {
        text: "Remote work requires manager approval before the first remote day. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
        abstained: false,
      },
    ],
  });

  const result = await runDocumentRagLoop(harness.args);

  assert.equal(result.documentEvidenceClarification, null);
  assert.match(result.ragResult.value.text, /before the first remote day/i);
  assert.equal(harness.askedQuestions.length, 2);
  assert.match(harness.askedQuestions[1], /claim lacks citation support/i);
  assert.deepEqual(
    harness.trace.map((step) => step.type),
    ["document_rag", "self_check", "gap_analysis", "follow_up_retrieval", "self_check"]
  );
  assert.equal(harness.executionLoop.followUpsRun, 1);
  assert.equal(harness.executionLoop.stoppedReason, "follow_up_resolved");
  assert.equal(harness.workingMemory.unresolvedGaps.length, 0);
  assert.equal(harness.workingMemory.resolvedGaps[0].type, "unsupported_claim");
  assert.deepEqual(
    harness.tracker.getSkillRuns().map((run) => run.phase),
    ["primary", "follow_up"]
  );
});

test("document loop returns clarification when follow-up budget is exhausted", async () => {
  const harness = createLoopHarness({
    agentBudget: {
      maxDocumentRagCalls: 1,
    },
    ragResponses: [
      {
        text: "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
        abstained: false,
      },
    ],
  });

  const result = await runDocumentRagLoop(harness.args);

  assert.equal(
    result.documentEvidenceClarification.reason,
    "document_follow_up_budget_exhausted"
  );
  assert.match(result.ragResult.value.text, /satellite stipend/i);
  assert.equal(harness.askedQuestions.length, 1);
  assert.equal(harness.executionLoop.stoppedReason, "budget_exhausted");
  assert.equal(harness.recordedBudgetLimits[0].tool, "Document follow-up");
  assert.deepEqual(
    harness.tracker.getSkillRuns().map((run) => run.phase),
    ["primary", "follow_up"]
  );
  assert.equal(harness.tracker.getSkillRuns()[1].status, "skipped");
  assert.equal(harness.workingMemory.unresolvedGaps[0].type, "unsupported_claim");
});
