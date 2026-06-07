import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityGateDecision,
  buildQualityHistoryResponse,
} from "../evaluation/quality-report.js";

const buildPassingSyntheticPayload = ({ runId, createdAt }) => ({
  summary: {
    runId,
    createdAt,
    corpus: {
      path: "evaluation/synthetic-corpus-near-duplicate.json",
      cases: 1,
    },
    metrics: {
      overallPassRate: 1,
      qaPageHitRate: 1,
      comparePageHitRate: 1,
      averageCitationCount: 2,
    },
  },
  cases: [
    {
      id: "qa-1",
      passed: true,
      shouldAbstain: false,
      abstained: false,
      docCoverageHit: true,
      pageCoverageHit: true,
      answerExpectationHit: true,
    },
  ],
});

test("quality history folds feedback eval failures into gate decision by skill", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });
  const latestFeedbackPayload = {
    summary: {
      runId: "feedback-latest",
      createdAt: "2026-06-08T10:05:00.000Z",
      corpus: {
        path: "evaluation/generated/feedback-corpus.json",
        cases: 3,
      },
      metrics: {
        overallPassRate: 0.3333,
        qaPageHitRate: 0.5,
        comparePageHitRate: null,
        averageCitationCount: 1,
      },
    },
    cases: [
      {
        id: "feedback_citation_1",
        passed: false,
        shouldAbstain: false,
        abstained: false,
        docCoverageHit: true,
        pageCoverageHit: false,
        answerExpectationHit: true,
        metadata: {
          feedback: {
            feedbackType: "citation_error",
            skills: [
              {
                skillId: "document_rag",
                skillVersion: "1.0.0",
                label: "Document RAG",
              },
            ],
          },
        },
      },
      {
        id: "feedback_incomplete_1",
        passed: false,
        shouldAbstain: false,
        abstained: false,
        docCoverageHit: true,
        pageCoverageHit: true,
        answerExpectationHit: false,
        metadata: {
          feedback: {
            feedbackType: "incomplete",
            skills: [
              {
                skillId: "document_rag",
                skillVersion: "1.0.0",
                label: "Document RAG",
              },
              {
                skillId: "research_brief",
                skillVersion: "1.0.0",
                label: "Research Brief",
              },
            ],
          },
        },
      },
      {
        id: "feedback_passed_1",
        passed: true,
        shouldAbstain: false,
        abstained: false,
        docCoverageHit: true,
        pageCoverageHit: true,
        answerExpectationHit: true,
        metadata: {
          feedback: {
            feedbackType: "citation_error",
            skills: [
              {
                skillId: "web_search",
                skillVersion: "1.0.0",
                label: "Web Search",
              },
            ],
          },
        },
      },
    ],
  };

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestFeedbackPayload,
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.regressionGate.status, "pass");
  assert.equal(history.feedbackGate.status, "fail");
  assert.equal(history.feedbackGate.failedCaseCount, 2);
  assert.equal(history.qualityGate.status, "fail");
  assert.equal(buildQualityGateDecision({ history }).exitCode, 1);

  assert.deepEqual(history.feedbackGate.skillFailures, [
    {
      skillKey: "document_rag@1.0.0",
      skillId: "document_rag",
      skillVersion: "1.0.0",
      label: "Document RAG",
      failedCaseCount: 2,
      feedbackTypes: {
        citation_error: 1,
        incomplete: 1,
      },
      failedCaseIds: ["feedback_citation_1", "feedback_incomplete_1"],
    },
    {
      skillKey: "research_brief@1.0.0",
      skillId: "research_brief",
      skillVersion: "1.0.0",
      label: "Research Brief",
      failedCaseCount: 1,
      feedbackTypes: {
        incomplete: 1,
      },
      failedCaseIds: ["feedback_incomplete_1"],
    },
  ]);
});

test("quality history skips feedback gate when no feedback eval report exists", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    runPayloads: [],
  });

  assert.equal(history.feedbackGate.status, "pass");
  assert.equal(history.feedbackGate.skipped, true);
  assert.equal(history.qualityGate.status, "unknown");
  assert.equal(history.qualityGate.summary, "No previous synthetic run is available for regression comparison.");
});

test("quality history excludes feedback eval runs from synthetic regression baselines", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });
  const timestampedFeedbackPayload = {
    summary: {
      runId: "feedback-timestamped",
      createdAt: "2026-06-08T10:05:00.000Z",
      corpus: {
        path: "evaluation/generated/feedback-corpus.json",
        cases: 1,
      },
      metrics: {
        overallPassRate: 0,
        qaPageHitRate: 0,
        comparePageHitRate: null,
        averageCitationCount: 0,
      },
    },
    cases: [
      {
        id: "feedback_failed",
        passed: false,
        shouldAbstain: false,
        abstained: false,
        docCoverageHit: true,
        pageCoverageHit: false,
        answerExpectationHit: false,
      },
    ],
  };

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestFeedbackPayload: timestampedFeedbackPayload,
    runPayloads: [
      {
        fileName: "2026-feedback.json",
        payload: timestampedFeedbackPayload,
      },
      {
        fileName: "2026-synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.regressionGate.baselineRunId, "synthetic-previous");
  assert.equal(
    history.runs.some((run) => run.runId === "feedback-timestamped"),
    false
  );
});
