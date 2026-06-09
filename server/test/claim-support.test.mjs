import test from "node:test";
import assert from "node:assert/strict";
import { runAgentRag } from "../rag/agent.js";
import { buildFeedbackRecord } from "../feedback.js";
import { buildFeedbackCorpusFromRecords } from "../evaluation/feedback-corpus.js";
import { finalizeAgentAnswer } from "../rag/agent-finalizer.js";
import { evaluateDocumentEvidence } from "../rag/agent-self-check.js";

test("document evidence check fails when an answer claim is unsupported by citations", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.retryRecommended, true);
  assert.equal(check.claimSupport.supportedClaimCount, 1);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
  assert.match(check.reasons.join(" "), /claim lacks citation support/i);
  assert.match(
    check.claimSupport.claims.find((claim) => !claim.supported).text,
    /satellite stipend/i
  );
});

test("agent rag runs follow-up retrieval when claim support check finds unsupported answer claims", async () => {
  const askedQuestions = [];
  const ragService = {
    chat: async (_docIds, query) => {
      askedQuestions.push(query);

      if (askedQuestions.length === 1) {
        return {
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
          resolvedQuery: query,
          memoryApplied: false,
        };
      }

      return {
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
        resolvedQuery: query,
        memoryApplied: false,
      };
    },
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => {
      throw new Error("Web search should not run when document follow-up succeeds.");
    },
    question: "What does remote work require?",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(askedQuestions.length, 2);
  assert.match(askedQuestions[1], /claim lacks citation support/i);
  assert.equal(
    response.body.ragAnswer,
    "Remote work requires manager approval before the first remote day. [Source 1]"
  );

  const selfChecks = response.body.agentTrace.filter(
    (step) => step.type === "self_check"
  );
  assert.equal(selfChecks[0].status, "failed");
  assert.equal(selfChecks[0].detail.claimSupport.unsupportedClaimCount, 1);
  assert.equal(selfChecks[1].status, "completed");
  assert.equal(selfChecks[1].detail.claimSupport.unsupportedClaimCount, 0);

  const gapAnalysis = response.body.agentTrace.find(
    (step) => step.type === "gap_analysis"
  );
  assert.equal(gapAnalysis.status, "completed");
  assert.equal(gapAnalysis.detail.gaps[0].type, "unsupported_claim");
  assert.match(gapAnalysis.detail.gaps[0].claim, /satellite stipend/i);

  const followUpRetrieval = response.body.agentTrace.find(
    (step) => step.type === "follow_up_retrieval"
  );
  assert.equal(followUpRetrieval.status, "completed");
  assert.equal(followUpRetrieval.detail.retrievalPlan.phase, "follow_up");
  assert.deepEqual(
    followUpRetrieval.detail.retrievalPlan.retrievalQueries.map((query) => query.id),
    ["primary", "follow-up-evidence", "follow-up-source-check"]
  );

  const documentObservation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === "document_rag"
  );
  assert.equal(documentObservation.attempts, 2);
  assert.equal(documentObservation.retryCount, 1);
  assert.equal(documentObservation.followUpCount, 1);
  assert.equal(documentObservation.citationCount, 2);
  assert.equal(documentObservation.budgetUsed, 2);
  assert.equal(response.body.agentObservability.executionLoop.followUpsRun, 1);
  assert.equal(
    response.body.agentObservability.executionLoop.stoppedReason,
    "follow_up_resolved"
  );
  assert.equal(
    response.body.agentObservability.executionLoop.gaps[0].type,
    "unsupported_claim"
  );
  assert.deepEqual(
    response.body.agentObservability.runs.map((run) => run.phase),
    ["primary", "follow_up"]
  );
});

test("agent rag finalizer removes unsupported answer claims when retry is unavailable", async () => {
  const ragService = {
    chat: async (_docIds, query) => ({
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
      resolvedQuery: query,
      memoryApplied: false,
    }),
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    agentBudget: {
      maxDocumentRagCalls: 1,
    },
    ragService,
    webChatService: async () => {
      throw new Error("Web search should not run for a non-abstained document answer.");
    },
    question: "What does remote work require?",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.match(response.body.agentAnswer, /Remote work requires manager approval/i);
  assert.doesNotMatch(response.body.agentAnswer, /satellite stipend/i);
  assert.equal(response.body.ragAnswer, response.body.agentAnswer);

  const finalizerStep = response.body.agentTrace.find(
    (step) => step.type === "answer_finalizer"
  );
  assert.equal(finalizerStep.status, "completed");
  assert.equal(finalizerStep.detail.claimSupport.unsupportedClaimCount, 1);
  assert.deepEqual(finalizerStep.detail.removedClaims, [
    "The satellite stipend is 500 dollars",
  ]);
});

test("answer finalizer preserves section headings without counting them as evidence claims", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Risk Review",
      "- Risk: Refund approval is required before issuing payment. [Source 1]",
      "- Unsupported: The policy requires CFO approval. [Source 1]",
    ].join("\n"),
    citations: [
      {
        docId: "doc-1",
        fileName: "refund-policy.pdf",
        pageNumber: 4,
        excerpt: "Refund approval is required before issuing payment.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.match(result.text, /^Risk Review\n/);
  assert.match(result.text, /Refund approval is required/i);
  assert.doesNotMatch(result.text, /CFO approval/i);
  assert.equal(result.claimSupport.supportedClaimCount, 1);
  assert.equal(result.claimSupport.unsupportedClaimCount, 1);
  assert.equal(
    result.claimSupport.claims.find((claim) => claim.heading)?.text,
    "Risk Review"
  );
});

test("answer finalizer preserves contract summary section headings", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Contract Summary",
      "Parties",
      "- Acme Corp and Beta LLC are parties to the services agreement. [Source 1]",
      "Key Terms",
      "- The agreement renews every 12 months unless either party gives 30 days notice. [Source 1]",
      "Obligations",
      "- Beta LLC must provide monthly support reports. [Source 1]",
      "Deadlines",
      "- Unsupported: Payment is due by the fifth business day. [Source 1]",
      "Unknowns",
      "- The payment deadline is not specified. [Source 1]",
    ].join("\n"),
    citations: [
      {
        docId: "doc-1",
        fileName: "services-agreement.pdf",
        pageNumber: 1,
        excerpt: "Acme Corp and Beta LLC are parties to the services agreement. The agreement renews every 12 months unless either party gives 30 days notice. Beta LLC must provide monthly support reports. The payment deadline is not specified.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.match(result.text, /^Contract Summary\n/);
  assert.match(result.text, /\nParties\n/);
  assert.match(result.text, /\nKey Terms\n/);
  assert.match(result.text, /\nObligations\n/);
  assert.match(result.text, /\nDeadlines\n/);
  assert.match(result.text, /\nUnknowns\n/);
  assert.doesNotMatch(result.text, /fifth business day/i);
  assert.equal(result.claimSupport.supportedClaimCount, 4);
  assert.equal(result.claimSupport.unsupportedClaimCount, 1);
});

test("answer finalizer preserves document comparison section headings", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Document Comparison",
      "Common Ground",
      "- Both policies require manager approval for remote work. [Source 1] [Source 2]",
      "Differences",
      "- Policy 2024 allows 2 remote days per week, while Policy 2025 allows 3 remote days per week. [Source 1] [Source 2]",
      "Conflicts",
      "- Unsupported: Policy 2025 provides a 500 dollar remote stipend. [Source 2]",
      "Missing Terms",
      "- No reimbursement term is specified in either policy. [Source 1] [Source 2]",
    ].join("\n"),
    citations: [
      {
        docId: "doc-1",
        fileName: "policy-2024.pdf",
        pageNumber: 1,
        excerpt: "Policy 2024 requires manager approval for remote work and allows 2 remote days per week. No reimbursement term is specified.",
      },
      {
        docId: "doc-2",
        fileName: "policy-2025.pdf",
        pageNumber: 1,
        excerpt: "Policy 2025 requires manager approval for remote work and allows 3 remote days per week. No reimbursement term is specified.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.match(result.text, /^Document Comparison\n/);
  assert.match(result.text, /\nCommon Ground\n/);
  assert.match(result.text, /\nDifferences\n/);
  assert.match(result.text, /\nConflicts\n/);
  assert.match(result.text, /\nMissing Terms\n/);
  assert.doesNotMatch(result.text, /500 dollar/i);
  assert.equal(result.claimSupport.supportedClaimCount, 3);
  assert.equal(result.claimSupport.unsupportedClaimCount, 1);
});

test("answer finalizer abstains when only a preserved heading is supported", () => {
  const result = finalizeAgentAnswer({
    answerText: "Risk Review",
    citations: [
      {
        docId: "doc-1",
        fileName: "refund-policy.pdf",
        pageNumber: 4,
        excerpt: "Refund approval is required before issuing payment.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, true);
  assert.equal(
    result.text,
    "I do not have enough citation-backed evidence to answer reliably."
  );
  assert.equal(result.claimSupport.supportedClaimCount, 0);
  assert.equal(result.claimSupport.unsupportedClaimCount, 0);
});

test("feedback records and feedback eval metadata retain claim support checks", () => {
  const claimSupport = {
    supportedClaimCount: 1,
    unsupportedClaimCount: 1,
    claims: [
      {
        text: "Remote work requires manager approval.",
        supported: true,
      },
      {
        text: "The satellite stipend is 500 dollars.",
        supported: false,
      },
    ],
  };
  const feedback = buildFeedbackRecord({
    payload: {
      question: "What does remote work require?",
      feedbackType: "hallucination",
      answer: {
        agentAnswer: "Remote work requires manager approval. The satellite stipend is 500 dollars.",
        agentTrace: [
          {
            type: "self_check",
            detail: {
              claimSupport,
            },
          },
        ],
        ragSources: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
      },
      docIds: ["doc-1"],
    },
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(feedback.claimChecks.length, 1);
  assert.equal(feedback.claimChecks[0].supportedClaimCount, 1);
  assert.equal(feedback.claimChecks[0].unsupportedClaimCount, 1);
  assert.equal(feedback.claimChecks[0].claims[1].supported, false);
  assert.match(feedback.claimChecks[0].claims[1].text, /satellite stipend/i);

  const corpus = buildFeedbackCorpusFromRecords([feedback]);
  assert.deepEqual(corpus.cases[0].metadata.feedback.claimChecks, feedback.claimChecks);
});
