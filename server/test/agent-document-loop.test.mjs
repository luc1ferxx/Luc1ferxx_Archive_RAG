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
        text: "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
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
  assert.equal(harness.askedQuestions[1], "What does remote work require?");
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
        text: "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
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

test("the follow-up asks the resolved question and puts the gaps only in retrieval", async () => {
  const citations = [
    {
      docId: "doc-1",
      fileName: "policy.pdf",
      pageNumber: 2,
      excerpt: "Remote work requires manager approval before the first remote day.",
    },
  ];
  const harness = createLoopHarness({
    ragResponses: [
      {
        text: "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
        citations,
        abstained: false,
        resolvedQuery: "What does remote work require for employees?",
      },
      {
        text: "Remote work requires manager approval before the first remote day. [Source 1]",
        citations,
        abstained: false,
      },
    ],
  });

  const result = await runDocumentRagLoop(harness.args);
  const followUpStep = harness.trace.find((step) => step.type === "follow_up_retrieval");
  const queries = followUpStep.detail.retrievalPlan.retrievalQueries;

  assert.equal(result.documentEvidenceClarification, null);
  assert.equal(harness.askedQuestions.length, 2);
  // The answer model is asked the primary call's resolved question.
  assert.equal(harness.askedQuestions[1], "What does remote work require for employees?");
  assert.equal(followUpStep.detail.retrievalPlan.phase, "follow_up");
  assert.equal(queries[0].query, "What does remote work require for employees?");
  assert.ok(
    queries.some((query) => /Unsupported claim: The satellite stipend is 500 dollars/.test(query.query)),
    "the unsupported claim still steers a follow-up retrieval query"
  );
  // The follow-up answer is checked by the same verifier.
  assert.equal(harness.executionLoop.stoppedReason, "follow_up_resolved");
});

test("an unsupported follow-up answer still ends in a clarification", async () => {
  const citations = [
    {
      docId: "doc-1",
      fileName: "policy.pdf",
      pageNumber: 2,
      excerpt: "Remote work requires manager approval before the first remote day.",
    },
  ];
  const wrongAnswer = {
    text: "The satellite stipend is 500 dollars. [Source 1]",
    citations,
    abstained: false,
  };
  const harness = createLoopHarness({ ragResponses: [wrongAnswer, wrongAnswer] });
  const result = await runDocumentRagLoop(harness.args);

  assert.equal(harness.askedQuestions[1], "What does remote work require?");
  assert.equal(
    result.documentEvidenceClarification.reason,
    "document_evidence_unresolved_after_follow_up"
  );
  assert.equal(harness.executionLoop.stoppedReason, "follow_up_unresolved");
});

const policyCitations = [
  {
    docId: "doc-1",
    fileName: "policy.pdf",
    pageNumber: 2,
    excerpt: "Remote work requires manager approval before the first remote day.",
  },
];
const oneDocumentAnswer = {
  text: "Remote work requires manager approval before the first remote day. [Source 1]",
  citations: policyCitations,
  abstained: false,
};

test("a fact question over two documents passes on one cited document, in the primary and the follow-up check", async () => {
  const docIds = ["doc-1", "doc-2"];
  const harness = createLoopHarness({ docIds, ragResponses: [oneDocumentAnswer] });
  const result = await runDocumentRagLoop(harness.args);
  const [selfCheck] = harness.trace.filter((step) => step.type === "self_check");

  assert.equal(harness.args.retrievalPlan.intent, "fact");
  assert.equal(result.documentEvidenceClarification, null);
  assert.equal(harness.askedQuestions.length, 1);
  assert.equal(selfCheck.detail.passed, true);
  assert.equal(selfCheck.detail.requiredDocCoverage, 1);

  const followUpHarness = createLoopHarness({
    docIds,
    ragResponses: [
      {
        text: "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
        citations: policyCitations,
        abstained: false,
      },
      oneDocumentAnswer,
    ],
  });
  const followUpResult = await runDocumentRagLoop(followUpHarness.args);

  assert.equal(followUpResult.documentEvidenceClarification, null);
  assert.equal(followUpHarness.askedQuestions.length, 2);
  assert.equal(followUpHarness.executionLoop.stoppedReason, "follow_up_resolved");
});

test("a comparison answer that cites one document still gets the follow-up", async () => {
  const harness = createLoopHarness({
    docIds: ["doc-1", "doc-2"],
    question: "What is the difference between the two remote work policies?",
    ragResponses: [oneDocumentAnswer, oneDocumentAnswer],
  });
  const result = await runDocumentRagLoop(harness.args);
  const [primaryCheck, followUpCheck] = harness.trace.filter(
    (step) => step.type === "self_check"
  );

  assert.equal(harness.args.retrievalPlan.intent, "comparison");
  assert.deepEqual(primaryCheck.detail.reasons, [
    "Citations cover 1 of 2 required documents.",
  ]);
  assert.equal(harness.askedQuestions.length, 2);
  assert.deepEqual(followUpCheck.detail.reasons, [
    "Citations cover 1 of 2 required documents.",
  ]);
  assert.equal(
    result.documentEvidenceClarification.reason,
    "document_evidence_unresolved_after_follow_up"
  );
});
