import test from "node:test";
import assert from "node:assert/strict";
import { runAgentRag } from "../rag/agent.js";
import { buildFeedbackRecord } from "../feedback.js";
import { buildFeedbackCorpusFromRecords } from "../evaluation/feedback-corpus.js";
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

test("agent rag retries when claim support check finds unsupported answer claims", async () => {
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
      throw new Error("Web search should not run when document retry succeeds.");
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

  const documentObservation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === "document_rag"
  );
  assert.equal(documentObservation.attempts, 2);
  assert.equal(documentObservation.retryCount, 1);
  assert.equal(documentObservation.citationCount, 2);
  assert.equal(documentObservation.budgetUsed, 2);
  assert.deepEqual(
    response.body.agentObservability.runs.map((run) => run.phase),
    ["primary", "retry"]
  );
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
