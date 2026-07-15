import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityGateDecision,
  buildQualityHistoryResponse,
  formatFeedbackSkillFailureLine,
} from "../evaluation/quality-report.js";
import {
  buildRecoveryObservabilityEvaluationReport,
  buildRecoveryObservabilityFixtureEvents,
} from "../evaluation/recovery-observability-eval.js";

const buildPassingSyntheticPayload = ({
  config = null,
  corpusPath = "evaluation/synthetic-corpus-near-duplicate.json",
  createdAt,
  metrics = {},
  models = null,
  runId,
} = {}) => ({
  summary: {
    runId,
    createdAt,
    corpus: {
      path: corpusPath,
      cases: 1,
    },
    ...(config ? { config } : {}),
    ...(models ? { models } : {}),
    metrics: {
      overallPassRate: 1,
      qaPageHitRate: 1,
      comparePageHitRate: 1,
      averageCitationCount: 2,
      ...metrics,
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

const buildPassingRerankPayload = ({
  corpusPath,
  runId,
} = {}) => ({
  summary: {
    runId,
    createdAt: "2026-06-08T10:30:00.000Z",
    corpus: {
      path: corpusPath,
      cases: 2,
    },
    caseCount: 2,
    metrics: {
      baseline: {
        ndcgAtK: 0.75,
        recallAtK: 0.8,
        mrr: 0.7,
      },
      reranked: {
        ndcgAtK: 0.9,
        recallAtK: 0.8,
        mrr: 0.85,
      },
      lift: {
        ndcgAtK: {
          absolute: 0.15,
          relative: 0.2,
        },
      },
      noiseFilteringRate: 0.4,
    },
  },
  cases: [
    {
      id: "rerank-1",
    },
    {
      id: "rerank-2",
    },
  ],
});

const buildPassingPlannerPayload = ({
  provider = "mock",
  runId = "planner-latest",
} = {}) => ({
  summary: {
    runId,
    createdAt: "2026-06-08T10:15:00.000Z",
    provider,
    status: "pass",
    version: "1.0.0",
    metrics: {
      caseCount: 2,
      passedCaseCount: 2,
      failedCaseCount: 0,
      checkCount: 4,
      passedCheckCount: 4,
      failedCheckCount: 0,
      overallPassRate: 1,
      checkPassRate: 1,
    },
  },
  cases: [
    {
      id: "planner_inventory",
      label: "Inventory planner selection",
      passed: true,
      failedCheckCount: 0,
      checks: [
        {
          id: "llm_planner_selected",
          label: "LLM planner selected the inventory step",
          category: "planner",
          passed: true,
        },
        {
          id: "inventory_mode",
          label: "Agent answered in inventory mode",
          category: "execution",
          passed: true,
        },
      ],
      response: {
        planner: {
          requestedPlannerId: "llm",
          selectedPlannerId: "llm",
          status: "selected",
        },
      },
    },
    {
      id: "planner_fallback_invalid_step",
      label: "Unsafe planner falls back",
      passed: true,
      failedCheckCount: 0,
      checks: [
        {
          id: "llm_planner_fallback",
          label: "Invalid LLM planner output fell back",
          category: "fallback",
          passed: true,
        },
        {
          id: "fallback_observability",
          label: "Observability records fallback reason",
          category: "observability",
          passed: true,
        },
      ],
      response: {
        planner: {
          fallback: true,
          requestedPlannerId: "llm",
          selectedPlannerId: "deterministic",
          status: "fallback",
        },
      },
    },
  ],
});

const buildFailingPlannerPayload = () => ({
  ...buildPassingPlannerPayload({
    runId: "planner-failing",
  }),
  summary: {
    ...buildPassingPlannerPayload().summary,
    runId: "planner-failing",
    status: "fail",
    metrics: {
      ...buildPassingPlannerPayload().summary.metrics,
      passedCaseCount: 1,
      failedCaseCount: 1,
      passedCheckCount: 3,
      failedCheckCount: 1,
      overallPassRate: 0.5,
      checkPassRate: 0.75,
    },
  },
  cases: [
    buildPassingPlannerPayload().cases[0],
    {
      id: "planner_custom_chain",
      label: "Custom chain planner selection",
      passed: false,
      failedCheckCount: 1,
      checks: [
        {
          id: "llm_planner_selected",
          label: "LLM planner selected custom_skills",
          category: "planner",
          passed: false,
          detail: {
            requestedPlannerId: "llm",
            selectedPlannerId: "deterministic",
            status: "fallback",
          },
        },
        {
          id: "custom_chain_observability",
          label: "Skill chain observability recorded",
          category: "observability",
          passed: true,
        },
      ],
      response: {
        planner: {
          requestedPlannerId: "llm",
          selectedPlannerId: "deterministic",
          status: "fallback",
        },
      },
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

test("quality history selects a same-corpus same-profile baseline first", () => {
  const stableConfig = {
    chunkStrategy: "structured",
    chunkSize: 900,
    chunkOverlap: 180,
    retrievalTopK: 6,
  };
  const latestPayload = buildPassingSyntheticPayload({
    runId: "near-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
    config: stableConfig,
    metrics: {
      averageCitationCount: 2,
    },
  });
  const sameCorpusSameProfilePayload = buildPassingSyntheticPayload({
    runId: "near-same-profile",
    createdAt: "2026-06-08T09:00:00.000Z",
    config: stableConfig,
    metrics: {
      averageCitationCount: 2.1,
    },
  });
  const sameCorpusDifferentProfilePayload = buildPassingSyntheticPayload({
    runId: "near-different-profile",
    createdAt: "2026-06-08T09:30:00.000Z",
    config: {
      ...stableConfig,
      retrievalTopK: 10,
    },
    metrics: {
      averageCitationCount: 3,
    },
  });
  const differentCorpusSameProfilePayload = buildPassingSyntheticPayload({
    runId: "compare-same-profile",
    createdAt: "2026-06-08T09:45:00.000Z",
    config: stableConfig,
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
    metrics: {
      averageCitationCount: 3,
    },
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    runPayloads: [
      {
        fileName: "near-same-profile.json",
        payload: sameCorpusSameProfilePayload,
      },
      {
        fileName: "near-different-profile.json",
        payload: sameCorpusDifferentProfilePayload,
      },
      {
        fileName: "compare-same-profile.json",
        payload: differentCorpusSameProfilePayload,
      },
    ],
  });

  assert.equal(history.regressionGate.baselineRunId, "near-same-profile");
  assert.equal(
    history.regressionGate.baselineSelection.strategy,
    "same_corpus_same_profile"
  );
  assert.equal(history.regressionGate.status, "pass");
});

test("quality history ignores future synthetic runs when choosing a baseline", () => {
  const stableConfig = {
    chunkStrategy: "structured",
    chunkSize: 900,
    chunkOverlap: 180,
    retrievalTopK: 6,
    compareTopKPerDoc: 3,
  };
  const latestPayload = buildPassingSyntheticPayload({
    runId: "latest-near-duplicate",
    createdAt: "2026-04-21T20:43:26.600Z",
    config: stableConfig,
    corpusPath: "evaluation/synthetic-corpus-near-duplicate.json",
    metrics: {
      averageCitationCount: 1.63,
    },
  });
  const futureHardCorpusPayload = buildPassingSyntheticPayload({
    runId: "future-hard-cs",
    createdAt: "2026-06-09T17:27:50.812Z",
    config: stableConfig,
    corpusPath: "evaluation/synthetic-corpus-rerank-hard-cs.json",
    metrics: {
      averageCitationCount: 2.25,
    },
  });
  const previousCompareHardPayload = buildPassingSyntheticPayload({
    runId: "previous-compare-hard",
    createdAt: "2026-04-21T20:13:44.597Z",
    config: stableConfig,
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
    metrics: {
      averageCitationCount: 1.88,
    },
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    runPayloads: [
      {
        fileName: "future-hard-cs.json",
        payload: futureHardCorpusPayload,
      },
      {
        fileName: "previous-compare-hard.json",
        payload: previousCompareHardPayload,
      },
    ],
  });

  assert.equal(history.regressionGate.baselineRunId, "previous-compare-hard");
  assert.equal(history.regressionGate.baselineSelection.strategy, "same_profile");
  assert.equal(history.regressionGate.baselineSelection.previousCandidateCount, 1);
  assert.equal(history.regressionGate.status, "pass");
});

test("quality history folds planner eval failures into gate decision", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestPlannerPayload: buildFailingPlannerPayload(),
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.regressionGate.status, "pass");
  assert.equal(history.plannerGate.status, "fail");
  assert.equal(history.plannerGate.provider, "mock");
  assert.equal(history.plannerGate.failedCaseCount, 1);
  assert.equal(history.plannerGate.failedCheckCount, 1);
  assert.equal(history.qualityGate.status, "fail");
  assert.equal(buildQualityGateDecision({ history }).exitCode, 1);
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "plannerFailedCheckCount" &&
        check.status === "fail" &&
        check.currentValue === 1
    )
  );
  assert.equal(
    history.plannerGate.failedCases[0].failedChecks[0].label,
    "LLM planner selected custom_skills"
  );
});

test("quality history folds multiple planner provider reports into gate decision", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });
  const failingRealPlannerPayload = {
    ...buildFailingPlannerPayload(),
    summary: {
      ...buildFailingPlannerPayload().summary,
      provider: "real",
      runId: "planner-real-failing",
    },
  };

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestPlannerPayloads: [
      buildPassingPlannerPayload({
        provider: "mock",
        runId: "planner-mock-passing",
      }),
      failingRealPlannerPayload,
    ],
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.plannerGate.status, "fail");
  assert.deepEqual(history.plannerGate.providers, ["mock", "real"]);
  assert.equal(history.plannerGate.provider, "mock, real");
  assert.equal(history.plannerGate.failedCaseCount, 1);
  assert.equal(history.plannerGate.failedCheckCount, 1);
  assert.equal(history.plannerGate.caseCount, 4);
  assert.equal(history.plannerGate.checkCount, 8);
  assert.equal(history.plannerGate.failedCases[0].provider, "real");
  assert.equal(history.qualityGate.status, "fail");
  assert.match(
    history.qualityGate.summary,
    /Planner evaluations \(mock, real\) failed 1 of 4 cases and 1 of 8 checks\./
  );
});

test("quality history includes passing planner eval in the combined gate summary", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestPlannerPayload: buildPassingPlannerPayload(),
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.plannerGate.status, "pass");
  assert.equal(history.plannerGate.skipped, false);
  assert.equal(history.plannerGate.failedCaseCount, 0);
  assert.equal(history.qualityGate.status, "pass");
  assert.match(
    history.qualityGate.summary,
    /Planner evaluation \(mock\) passed all 2 cases and 4 checks\./
  );
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "plannerFailedCaseCount" &&
        check.status === "pass" &&
        check.currentValue === 0
    )
  );
});

test("quality history requires robust hard and real eval suite when requested", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "compare-hard-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "compare-hard-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestRobustPayloads: [
      {
        reportId: "compare-hard-synthetic",
        payload: latestPayload,
      },
      {
        reportId: "rerank-hard-cs",
        payload: buildPassingRerankPayload({
          corpusPath: "evaluation/synthetic-corpus-rerank-hard-cs.json",
          runId: "hard-cs-rerank",
        }),
      },
      {
        reportId: "arxiv-real-paper-rerank",
        payload: buildPassingRerankPayload({
          corpusPath: "evaluation/generated/arxiv-corpus.json",
          runId: "arxiv-rerank",
        }),
      },
    ],
    requireRobustSuite: true,
    runPayloads: [
      {
        fileName: "compare-hard-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.regressionGate.status, "pass");
  assert.equal(history.robustSuiteGate.status, "pass");
  assert.equal(history.robustSuiteGate.skipped, false);
  assert.equal(history.robustSuiteGate.reports.length, 3);
  assert.equal(history.qualityGate.status, "pass");
  assert.match(
    history.qualityGate.summary,
    /Robust eval suite passed 3 reports/
  );
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "robustSuiteRerankNdcgLift" &&
        check.reportId === "arxiv-real-paper-rerank" &&
        check.status === "pass"
    )
  );
});

test("quality history preserves legacy pass and skip semantics without release evidence", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "compare-hard-latest-legacy",
    createdAt: "2026-06-08T10:00:00.000Z",
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "compare-hard-previous-legacy",
    createdAt: "2026-06-08T09:00:00.000Z",
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
  });
  const latestFeedbackPayload = {
    summary: {
      runId: "feedback-legacy",
      createdAt: "2026-06-08T10:05:00.000Z",
      corpus: {
        path: "evaluation/generated/feedback-corpus.json",
        cases: 1,
      },
      metrics: {
        overallPassRate: 1,
      },
    },
    cases: [
      {
        id: "feedback-pass-legacy",
        passed: true,
      },
    ],
  };
  const latestTrajectoryPayload = {
    summary: {
      runId: "trajectory-legacy",
      createdAt: "2026-06-08T10:10:00.000Z",
      status: "pass",
      metrics: {
        caseCount: 1,
        passedCaseCount: 1,
        failedCaseCount: 0,
        checkCount: 1,
        passedCheckCount: 1,
        failedCheckCount: 0,
      },
    },
    cases: [
      {
        id: "trajectory-pass-legacy",
        label: "Legacy trajectory",
        passed: true,
        failedCheckCount: 0,
        checks: [],
      },
    ],
  };
  const latestPlannerPayload = buildPassingPlannerPayload({
    runId: "planner-legacy",
  });
  const latestRecoveryPayload = buildRecoveryObservabilityEvaluationReport({
    createdAt: "2026-06-08T10:20:00.000Z",
    runId: "recovery-legacy",
  });
  const latestRobustPayloads = [
    {
      reportId: "compare-hard-synthetic",
      payload: latestPayload,
    },
    {
      reportId: "rerank-hard-cs",
      payload: buildPassingRerankPayload({
        corpusPath: "evaluation/synthetic-corpus-rerank-hard-cs.json",
        runId: "hard-cs-rerank-legacy",
      }),
    },
    {
      reportId: "arxiv-real-paper-rerank",
      payload: buildPassingRerankPayload({
        corpusPath: "evaluation/generated/arxiv-corpus.json",
        runId: "arxiv-rerank-legacy",
      }),
    },
  ];
  const legacyPayloads = [
    latestPayload,
    previousPayload,
    latestFeedbackPayload,
    latestTrajectoryPayload,
    latestPlannerPayload,
    latestRecoveryPayload,
    ...latestRobustPayloads.map(({ payload }) => payload),
  ];
  const buildLegacyHistory = (requireRobustSuite = false) =>
    buildQualityHistoryResponse({
      latestPayload,
      latestFeedbackPayload,
      latestPlannerPayload,
      latestRecoveryPayload,
      latestRobustPayloads,
      latestTrajectoryPayload,
      requireRobustSuite,
      runPayloads: [
        {
          fileName: "compare-hard-previous-legacy.json",
          payload: previousPayload,
        },
      ],
    });

  assert.ok(legacyPayloads.every((payload) => payload.evidence === undefined));

  const defaultHistory = buildLegacyHistory();

  assert.equal(defaultHistory.regressionGate.status, "pass");
  assert.equal(defaultHistory.feedbackGate.status, "pass");
  assert.equal(defaultHistory.feedbackGate.skipped, false);
  assert.equal(defaultHistory.trajectoryGate.status, "pass");
  assert.equal(defaultHistory.trajectoryGate.skipped, false);
  assert.equal(defaultHistory.plannerGate.status, "pass");
  assert.equal(defaultHistory.plannerGate.skipped, false);
  assert.equal(defaultHistory.recoveryGate.status, "pass");
  assert.equal(defaultHistory.recoveryGate.skipped, false);
  assert.equal(defaultHistory.robustSuiteGate.status, "pass");
  assert.equal(defaultHistory.robustSuiteGate.skipped, true);
  assert.equal(defaultHistory.qualityGate.status, "pass");
  assert.equal(buildQualityGateDecision({ history: defaultHistory }).exitCode, 0);

  const requiredRobustHistory = buildLegacyHistory(true);

  assert.equal(requiredRobustHistory.robustSuiteGate.status, "pass");
  assert.equal(requiredRobustHistory.robustSuiteGate.skipped, false);
  assert.equal(requiredRobustHistory.robustSuiteGate.reports.length, 3);
  assert.equal(requiredRobustHistory.qualityGate.status, "pass");
  assert.equal(
    buildQualityGateDecision({ history: requiredRobustHistory }).exitCode,
    0
  );
});

test("quality history fails when required robust suite reports are missing", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "compare-hard-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "compare-hard-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestRobustPayloads: [
      {
        reportId: "compare-hard-synthetic",
        payload: latestPayload,
      },
    ],
    requireRobustSuite: true,
    runPayloads: [
      {
        fileName: "compare-hard-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.robustSuiteGate.status, "fail");
  assert.equal(history.robustSuiteGate.failedReports.length, 2);
  assert.deepEqual(
    history.robustSuiteGate.failedReports.map((report) => report.reportId),
    ["rerank-hard-cs", "arxiv-real-paper-rerank"]
  );
  assert.equal(history.qualityGate.status, "fail");
  assert.equal(buildQualityGateDecision({ history }).exitCode, 1);
});

test("quality history folds passing recovery observability report into gate decision", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });
  const latestRecoveryPayload = buildRecoveryObservabilityEvaluationReport({
    createdAt: "2026-06-08T10:20:00.000Z",
    runId: "recovery-latest",
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestRecoveryPayload,
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.recoveryGate.status, "pass");
  assert.equal(history.recoveryGate.skipped, false);
  assert.equal(history.recoveryGate.currentRunId, "recovery-latest");
  assert.equal(history.recoveryGate.recovery.primaryStepStartedCount, 2);
  assert.equal(history.recoveryGate.recovery.primaryStepCompletedCount, 1);
  assert.equal(history.recoveryGate.recovery.primaryStepFailedCount, 1);
  assert.equal(history.recoveryGate.recovery.stepReplayFailureCount, 0);
  assert.equal(history.recoveryGate.recovery.autoReplaySuccessRate, 1);
  assert.equal(history.recoveryGate.recovery.taskRecoveryScheduledCount, 1);
  assert.equal(history.recoveryGate.recovery.taskRecoveryResumeActionCount, 1);
  assert.equal(history.recoveryGate.recovery.taskRecoveryResumeFailureCount, 0);
  assert.equal(history.recoveryGate.recovery.taskRecoveryCompletedCount, 1);
  assert.equal(history.qualityGate.status, "pass");
  assert.match(
    history.qualityGate.summary,
    /Recovery observability passed 6 cases; replay failures 0, manual action failures 0, task resume failures 0/
  );
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "recoveryStepReplayFailureCount" &&
        check.status === "pass" &&
        check.currentValue === 0
    )
  );
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "recoveryPrimaryStepStartedCount" &&
        check.status === "pass" &&
        check.currentValue === 2
    )
  );
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "recoveryTaskRecoveryResumeFailureCount" &&
        check.status === "pass" &&
        check.currentValue === 0
    )
  );
});

test("quality history does not require primary step failures in healthy recovery reports", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });
  const latestRecoveryPayload = {
    summary: {
      runId: "recovery-no-primary-failures",
      status: "pass",
      metrics: {
        caseCount: 1,
        checkCount: 1,
        failedCaseCount: 0,
        failedCheckCount: 0,
      },
    },
    recovery: {
      recoverableRunCount: 1,
      manualRecoveryCount: 1,
      manualRecoveryActionCount: 1,
      manualRecoveryActionFailureCount: 0,
      autoReplayAttemptCount: 1,
      autoReplaySuccessRate: 1,
      autoReplayFailureCount: 0,
      primaryStepStartedCount: 1,
      primaryStepCompletedCount: 1,
      primaryStepFailedCount: 0,
      stepRetryCount: 1,
      stepResumeCount: 1,
      stepReplayFailureCount: 0,
      taskRecoveryScheduledCount: 1,
      taskRecoveryResumeActionCount: 1,
      taskRecoveryResumeFailureCount: 0,
      taskRecoveryCompletedCount: 1,
      plannerFallbackCount: 0,
    },
    cases: [
      {
        id: "healthy_recovery",
        label: "Healthy recovery",
        passed: true,
        checks: [
          {
            id: "healthy",
            label: "Healthy recovery",
            passed: true,
          },
        ],
      },
    ],
  };

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestRecoveryPayload,
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.recoveryGate.status, "pass");
  assert.ok(
    history.recoveryGate.checks.some(
      (check) =>
        check.metric === "recoveryPrimaryStepFailedCount" &&
        check.status === "pass" &&
        check.currentValue === 0
    )
  );
  assert.equal(history.qualityGate.status, "pass");
});

test("quality history folds recovery observability failures into gate decision", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });
  const latestRecoveryPayload = buildRecoveryObservabilityEvaluationReport({
    createdAt: "2026-06-08T10:20:00.000Z",
    events: [
      ...buildRecoveryObservabilityFixtureEvents(),
      {
        traceType: "agent_run_step_replay",
        action: "resume_step",
        status: "failed",
        error: {
          message: "Replay failed.",
        },
      },
      {
        traceType: "agent_run_recovery",
        eventType: "manual_recovery_action",
        action: "retry_failed_step",
        status: "failed",
        error: {
          message: "Manual action failed.",
        },
      },
      {
        traceType: "agent_task_recovery",
        eventType: "task_resume_action",
        action: "confirm",
        errorStatus: 409,
        resultStatus: "waiting_for_user",
        runnerId: "agent_task",
        status: "failed",
        taskId: "task-failed",
      },
    ],
    runId: "recovery-failing",
  });

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestRecoveryPayload,
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.regressionGate.status, "pass");
  assert.equal(history.recoveryGate.status, "fail");
  assert.equal(history.recoveryGate.failedCaseCount, 3);
  assert.equal(history.recoveryGate.recovery.stepReplayFailureCount, 1);
  assert.equal(history.recoveryGate.recovery.manualRecoveryActionFailureCount, 1);
  assert.equal(history.recoveryGate.recovery.taskRecoveryResumeFailureCount, 1);
  assert.equal(history.qualityGate.status, "fail");
  assert.equal(buildQualityGateDecision({ history }).exitCode, 1);
  assert.ok(
    history.recoveryGate.failedChecks.some(
      (check) =>
        check.metric === "recoveryStepReplayFailureCount" &&
        check.status === "fail"
    )
  );
  assert.ok(
    history.recoveryGate.failedCases.some(
      (caseResult) => caseResult.id === "step_replay_actions"
    )
  );
  assert.ok(
    history.recoveryGate.failedChecks.some(
      (check) =>
        check.metric === "recoveryTaskRecoveryResumeFailureCount" &&
        check.status === "fail"
    )
  );
  assert.ok(
    history.recoveryGate.failedCases.some(
      (caseResult) => caseResult.id === "agent_task_recovery"
    )
  );
});

test("quality history keeps planner gate summary when regression gate warns", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const previousPayload = buildPassingSyntheticPayload({
    runId: "synthetic-previous",
    createdAt: "2026-06-08T09:00:00.000Z",
  });

  previousPayload.summary.metrics.averageCitationCount = 2.6;

  const history = buildQualityHistoryResponse({
    latestPayload,
    latestPlannerPayload: buildPassingPlannerPayload(),
    runPayloads: [
      {
        fileName: "synthetic-previous.json",
        payload: previousPayload,
      },
    ],
  });

  assert.equal(history.regressionGate.status, "warn");
  assert.equal(history.qualityGate.status, "warn");
  assert.match(
    history.qualityGate.summary,
    /Planner evaluation \(mock\) passed all 2 cases and 4 checks\./
  );
  assert.ok(
    history.qualityGate.checks.some(
      (check) =>
        check.metric === "plannerFailedCheckCount" &&
        check.status === "pass" &&
        check.currentValue === 0
    )
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
  assert.equal(history.plannerGate.status, "pass");
  assert.equal(history.plannerGate.skipped, true);
  assert.equal(history.recoveryGate.status, "pass");
  assert.equal(history.recoveryGate.skipped, true);
  assert.equal(history.robustSuiteGate.status, "pass");
  assert.equal(history.robustSuiteGate.skipped, true);
  assert.equal(history.qualityGate.status, "unknown");
  assert.equal(history.qualityGate.summary, "No previous synthetic run is available for regression comparison.");
});

test("quality history fails feedback gate when latest feedback report is empty", () => {
  const latestPayload = buildPassingSyntheticPayload({
    runId: "synthetic-latest",
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const latestFeedbackPayload = {
    summary: {
      runId: "feedback-empty",
      createdAt: "2026-06-08T10:05:00.000Z",
      corpus: {
        path: "evaluation/generated/feedback-corpus.json",
        cases: 0,
      },
      metrics: {
        overallPassRate: null,
      },
    },
    cases: [],
  };

  const history = buildQualityHistoryResponse({
    latestFeedbackPayload,
    latestPayload,
    runPayloads: [],
  });

  assert.equal(history.feedbackGate.status, "fail");
  assert.equal(history.feedbackGate.skipped, false);
  assert.equal(history.feedbackGate.caseCount, 0);
  assert.equal(history.feedbackGate.summary, "Feedback evaluation has no cases yet.");
  assert.equal(history.qualityGate.status, "fail");
});

test("quality history excludes non-synthetic eval runs from regression baselines", () => {
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
  const timestampedPlannerPayload = buildPassingPlannerPayload({
    runId: "planner-timestamped",
  });
  const timestampedRerankPayload = {
    summary: {
      runId: "rerank-timestamped",
      createdAt: "2026-06-08T10:10:00.000Z",
      corpus: {
        path: "evaluation/generated/arxiv-corpus.json",
        cases: 48,
      },
      metrics: {
        baseline: {
          ndcgAtK: 0.6,
        },
        reranked: {
          ndcgAtK: 0.7,
        },
        noiseFilteringRate: 0.45,
      },
    },
    cases: [
      {
        id: "rerank_case",
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
        fileName: "2026-planner.json",
        payload: timestampedPlannerPayload,
      },
      {
        fileName: "2026-rerank.json",
        payload: timestampedRerankPayload,
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
  assert.equal(
    history.runs.some((run) => run.runId === "planner-timestamped"),
    false
  );
  assert.equal(
    history.runs.some((run) => run.runId === "rerank-timestamped"),
    false
  );
});
