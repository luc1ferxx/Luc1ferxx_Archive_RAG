import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityGateDecision,
  buildQualityHistoryResponse,
  formatFeedbackSkillFailureLine,
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
            claimChecks: [
              {
                checked: true,
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
                    missingAnchors: ["500"],
                  },
                ],
              },
            ],
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
  assert.equal(history.feedbackGate.unsupportedClaimCount, 1);
  assert.equal(history.feedbackGate.unsupportedClaimCaseCount, 1);
  assert.equal(history.qualityGate.status, "fail");
  assert.equal(buildQualityGateDecision({ history }).exitCode, 1);
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "feedbackUnsupportedClaimCount" &&
        check.status === "fail" &&
        check.currentValue === 1
    )
  );

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
      unsupportedClaimCount: 1,
      unsupportedClaimCaseCount: 1,
      unsupportedClaims: [
        {
          caseId: "feedback_citation_1",
          text: "The satellite stipend is 500 dollars.",
          missingAnchors: ["500"],
        },
      ],
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
      unsupportedClaimCount: 0,
      unsupportedClaimCaseCount: 0,
      unsupportedClaims: [],
      failedCaseIds: ["feedback_incomplete_1"],
    },
  ]);
  assert.equal(
    formatFeedbackSkillFailureLine(history.feedbackGate.skillFailures[0]),
    "document_rag@1.0.0: 1 citation error, 1 incomplete answer, 1 unsupported claim"
  );
});

test("quality history fails feedback gate when current eval claim support fails", () => {
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
        cases: 1,
      },
      metrics: {
        overallPassRate: 1,
        qaPageHitRate: 1,
        comparePageHitRate: null,
        claimSupportHitRate: 0,
        averageCitationCount: 1,
      },
    },
    cases: [
      {
        id: "feedback_claim_support_1",
        passed: true,
        shouldAbstain: false,
        abstained: false,
        docCoverageHit: true,
        pageCoverageHit: true,
        answerExpectationHit: true,
        claimSupportHit: false,
        claimSupport: {
          checked: true,
          supportedClaimCount: 0,
          unsupportedClaimCount: 1,
          claims: [
            {
              text: "The satellite stipend is 500 dollars.",
              supported: false,
              missingAnchors: ["500"],
            },
          ],
        },
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

  assert.equal(history.feedbackGate.status, "fail");
  assert.equal(history.feedbackGate.failedCaseCount, 1);
  assert.equal(history.feedbackGate.unsupportedClaimCount, 1);
  assert.deepEqual(history.feedbackGate.failedCases[0].reasons, [
    "1 unsupported answer claim",
  ]);
  assert.equal(history.qualityGate.status, "fail");
  assert.equal(
    formatFeedbackSkillFailureLine(history.feedbackGate.skillFailures[0]),
    "document_rag@1.0.0: 1 citation error, 1 unsupported claim"
  );
});

test("quality history folds trajectory eval failures into gate decision", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });
  const latestTrajectoryPayload = {
    summary: {
      runId: "trajectory-latest",
      createdAt: "2026-06-08T10:10:00.000Z",
      status: "fail",
      metrics: {
        caseCount: 2,
        passedCaseCount: 1,
        failedCaseCount: 1,
        checkCount: 4,
        passedCheckCount: 3,
        failedCheckCount: 1,
      },
    },
    cases: [
      {
        id: "skill_chain_contract_review",
        label: "Contract review skill chain",
        passed: true,
        failedCheckCount: 0,
        checks: [],
      },
      {
        id: "comparison_requires_clarification",
        label: "Comparison clarification gate",
        passed: false,
        failedCheckCount: 1,
        checks: [
          {
            id: "clarification_trace",
            label: "Trace records the clarification gate",
            category: "clarification",
            passed: false,
          },
        ],
      },
    ],
  };

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestTrajectoryPayload,
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.regressionGate.status, "pass");
  assert.equal(history.feedbackGate.status, "pass");
  assert.equal(history.feedbackGate.skipped, true);
  assert.equal(history.trajectoryGate.status, "fail");
  assert.equal(history.trajectoryGate.failedCaseCount, 1);
  assert.equal(history.qualityGate.status, "fail");
  assert.equal(buildQualityGateDecision({ history }).exitCode, 1);
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "trajectoryFailedCaseCount" &&
        check.status === "fail" &&
        check.currentValue === 1
    )
  );
  assert.equal(
    history.trajectoryGate.failedCases[0].failedChecks[0].label,
    "Trace records the clarification gate"
  );
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
