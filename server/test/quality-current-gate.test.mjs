import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getPublicEvaluationConfig,
  hashCanonicalJson,
} from "../evaluation/eval-evidence.js";
import {
  CURRENT_QUALITY_REPORT_SPECS,
  buildCurrentQualityGateReport,
  readCurrentQualityInputs,
} from "../evaluation/quality-current-gate.js";
import {
  CURRENT_QUALITY_SUITE_MANIFEST,
} from "../evaluation/quality-current-suite-manifest.js";
import {
  validateCurrentQualitySuiteReport,
} from "../evaluation/quality-current-suite-validator.js";
import {
  buildRecoveryObservabilityCases,
} from "../evaluation/recovery-observability-cases.js";
import {
  evaluateSyntheticCaseResponse,
} from "../evaluation/synthetic-case-evaluator.js";
import {
  buildSyntheticDocumentId,
} from "../evaluation/synthetic-document-identity.js";
import { chunkDocumentWithConfig } from "../rag/chunker.js";
import {
  buildComparisonAnalysisFromContexts,
} from "../rag/comparison-analysis-summary.js";
import { splitAnswerClaims } from "../rag/self-check/claims.js";

const TARGET_COMMIT = "a".repeat(40);
const NOW = "2026-07-30T08:00:00.000Z";
const GENERATED_AT = "2026-07-30T07:30:00.000Z";
const PINNED_BASELINE_RUN_ID =
  "quality-near-duplicate-deterministic-v1";
const passingHistory = {
  regressionGate: {
    baselineRunId: PINNED_BASELINE_RUN_ID,
    baselineSelection: {
      profileMatched: true,
      strategy: "same_corpus_same_profile",
    },
  },
  runs: [
    {
      runId: PINNED_BASELINE_RUN_ID,
      status: "ok",
    },
  ],
  qualityGate: {
    status: "pass",
    summary: "Current quality metrics passed.",
  },
};

const formatAnswerClaims = (claims) =>
  claims
    .map(({ sourceRanks, text }) => {
      const sourceLabels = sourceRanks
        .map((rank) => `[Source ${rank}]`)
        .join(" ");

      return `${text}. ${sourceLabels}`.trim();
    })
    .join("\n");

const reevaluateSyntheticCase = ({ answer, caseResult, manifest }) => {
  const semantics = manifest.requiredCaseSemantics[caseResult.id];
  const evidence = [
    ...(caseResult.rawCitations ?? []),
    ...(caseResult.rawRetrievedContexts ?? []),
  ];
  const docKeyByDocId = new Map(
    evidence.map((item) => [item.docId, item.docKey])
  );
  const pagesByDocKey = new Map(
    Object.entries(manifest.requiredDocuments).map(([docKey, document]) => [
      docKey,
      document.pages,
    ])
  );

  return evaluateSyntheticCaseResponse({
    testCase: {
      id: caseResult.id,
      ...semantics,
    },
    response: {
      abstained: false,
      citations: caseResult.rawCitations,
      comparisonAnalysisSummary: caseResult.comparisonAnalysisSummary,
      retrievedContexts: caseResult.rawRetrievedContexts,
      text: answer,
    },
    responseTimeMs: caseResult.responseTimeMs,
    docKeyByDocId,
    pagesByDocKey,
  });
};

const buildReport = (spec) => {
  const manifest = CURRENT_QUALITY_SUITE_MANIFEST[spec.id];
  const runId = `${spec.id}-run`;
  const hasGateChecks = manifest.kind === "checks";
  const executionConfig = hasGateChecks
    ? {}
    : structuredClone(manifest.requiredConfig);
  const recovery =
    spec.id === "recovery"
      ? {
          recoverableRunCount: 3,
          manualRecoveryCount: 1,
          manualRecoveryActionCount: 3,
          manualRecoveryActionFailureCount: 0,
          autoReplayAttemptCount: 2,
          autoReplaySuccessRate: 1,
          autoReplayFailureCount: 0,
          primaryStepStartedCount: 2,
          primaryStepCompletedCount: 1,
          primaryStepFailedCount: 1,
          primaryStepLifecycleCounts: {
            step_started: 2,
            step_completed: 1,
            step_failed: 1,
          },
          actionCounts: {
            resume_from_step: 1,
            retry_failed_step: 1,
            cancel: 1,
          },
          stepRetryCount: 1,
          stepResumeCount: 3,
          stepReplayFailureCount: 0,
          taskRecoveryScheduledCount: 1,
          taskRecoveryResumeActionCount: 1,
          taskRecoveryResumeFailureCount: 0,
          taskRecoveryCompletedCount: 1,
          plannerFallbackCount: 0,
        }
      : undefined;
  const caseIds =
    manifest.kind === "checks"
      ? Object.keys(manifest.checksByCase)
      : manifest.requiredCaseIds.length > 0
        ? [...manifest.requiredCaseIds]
        : [`${spec.id}-case`];
  const documents = hasGateChecks
    ? undefined
    : Object.entries(manifest.requiredDocuments).map(
        ([docKey, document]) => ({
          chunkCount: document.chunkCount,
          docId: buildSyntheticDocumentId({
            corpusId: spec.corpus.id,
            corpusVersion: spec.corpus.version,
            docKey,
          }),
          docKey,
          fileName: document.fileName,
          mergedFilePath: `server/evaluation/generated/${runId}/merged/${document.fileName}`,
          pageCount: document.pageCount,
          sourcePath: `server/evaluation/generated/${runId}/source/${document.fileName}`,
        })
      );
  const documentsByKey = new Map(
    (documents ?? []).map((document) => [document.docKey, document])
  );
  const docKeyByDocId = new Map(
    (documents ?? []).map((document) => [document.docId, document.docKey])
  );
  const pagesByDocKey = new Map(
    Object.entries(manifest.requiredDocuments ?? {}).map(
      ([docKey, document]) => [docKey, document.pages]
    )
  );
  const chunksByDocKey = new Map(
    (documents ?? []).map((document) => [
      document.docKey,
      chunkDocumentWithConfig({
        docId: document.docId,
        fileName: document.fileName,
        publicFilePath: "",
        pages: manifest.requiredDocuments[document.docKey].pages.map(
          (text, pageIndex) => ({
            pageNumber: pageIndex + 1,
            text,
          })
        ),
        chunkStrategy: executionConfig.chunkStrategy,
        chunkSize: executionConfig.chunkSize,
        chunkOverlap: executionConfig.chunkOverlap,
      }),
    ])
  );
  const cases =
    spec.id === "recovery"
      ? buildRecoveryObservabilityCases({ recovery })
      : caseIds.map((id) => {
    if (hasGateChecks) {
      return {
        id,
        passed: true,
        failedCheckCount: 0,
        checks: manifest.checksByCase[id].map((checkId) => ({
          id: checkId,
          passed: true,
        })),
        response: structuredClone(
          manifest.responseProjectionByCase[id]
        ),
      };
    }

    const semantics = manifest.requiredCaseSemantics[id];
    const citations = semantics.expectedEvidence.map(
      (expectedEvidence, index) => {
        const document = documentsByKey.get(expectedEvidence.docKey);
        const chunk = chunksByDocKey
          .get(expectedEvidence.docKey)
          .find(
            (candidate) =>
              candidate.metadata.pageNumber === expectedEvidence.pages[0]
          );

        return {
          rank: index + 1,
          docId: document.docId,
          docKey: expectedEvidence.docKey,
          fileName: document.fileName,
          pageNumber: chunk.metadata.pageNumber,
          chunkIndex: chunk.metadata.chunkIndex,
          score: 0.8,
          sectionHeading: chunk.metadata.sectionHeading ?? null,
        };
      }
    );
    const sourceRanks = citations.map((citation) => citation.rank);
    const retrievedContexts = citations.map((citation) => {
      const chunk = chunksByDocKey
        .get(citation.docKey)
        .find(
          (candidate) =>
            candidate.metadata.chunkIndex === citation.chunkIndex
        );

      return {
        ...citation,
        text: chunk.pageContent,
      };
    });
    const sourceLabels = sourceRanks
      .map((rank) => `[Source ${rank}]`)
      .join(" ");
    const expectsNoMaterialDifference =
      semantics.expectedAnswerIncludes.some((fragment) =>
        fragment.includes(
          "No evidence-backed material differences were found"
        )
      );
    const requiredAnswerClaims =
      manifest.requiredAnswerClaims?.[id] ?? [];
    const answerText = semantics.shouldAbstain
      ? id === "qa_satellite_stipend_abstain"
        ? "I have not found reliable evidence that directly answers satellite relocation stipend."
        : "I only found strong evidence in 1 of the 2 selected documents, so the comparison would be unreliable."
      : requiredAnswerClaims.length > 0
        ? formatAnswerClaims(requiredAnswerClaims)
      : expectsNoMaterialDifference
        ? `No evidence-backed material differences were found across the selected documents based on the retrieved evidence. ${sourceLabels}`
        : citations
            .map((citation) => {
              const document =
                manifest.requiredDocuments[citation.docKey];
              const evidenceText = document.pages[
                citation.pageNumber - 1
              ]
                .replace(/\s+/g, " ")
                .trim();
              const firstSentence =
                evidenceText.match(/.*?(?:[.!?]|$)/)?.[0]?.trim() ??
                evidenceText;

              return `${firstSentence} [Source ${citation.rank}]`;
            })
            .join("\n");
    const comparisonAnalysisSummary =
      semantics.type === "compare"
        ? buildComparisonAnalysisFromContexts({
            query: semantics.question,
            documents: semantics.docKeys.map((docKey) => {
              const document = documentsByKey.get(docKey);

              return {
                docId: document.docId,
                fileName: document.fileName,
              };
            }),
            retrievedContexts,
          }).summary
        : null;

    return evaluateSyntheticCaseResponse({
      testCase: {
        id,
        ...semantics,
      },
      response: {
        abstained: semantics.shouldAbstain,
        abstainReason: semantics.shouldAbstain ? answerText : null,
        citations,
        comparisonAnalysisSummary,
        retrievedContexts,
        text: answerText,
      },
      responseTimeMs: 1,
      docKeyByDocId,
      pagesByDocKey,
    });
  });
  const checkCount = cases.reduce(
    (sum, caseResult) => sum + (caseResult.checks?.length ?? 0),
    0
  );
  const nonAbstainCases = cases.filter(
    (caseResult) => caseResult.shouldAbstain === false
  );
  const qaCaseCount = nonAbstainCases.filter(
    (caseResult) => caseResult.type === "qa"
  ).length;
  const compareCaseCount = nonAbstainCases.filter(
    (caseResult) => caseResult.type === "compare"
  ).length;
  const abstainCaseCount = cases.filter(
    (caseResult) => caseResult.shouldAbstain === true
  ).length;
  const uploads = hasGateChecks
    ? undefined
    : documents.map((document, index) => {
        const documentContract =
          manifest.requiredDocuments[document.docKey];
        const totalBytes = documentContract.totalBytes;
        const totalChunks = Math.ceil(
          totalBytes / executionConfig.uploadChunkSizeBytes
        );
        const pausedUploadedChunks = Array.from(
          { length: Math.max(1, Math.floor(totalChunks / 2)) },
          (_, chunkIndex) => chunkIndex
        );
        const skippedBytesOnResume = pausedUploadedChunks.reduce(
          (sum, chunkIndex) =>
            sum +
            Math.min(
              executionConfig.uploadChunkSizeBytes,
              totalBytes -
                chunkIndex *
                  executionConfig.uploadChunkSizeBytes
            ),
          0
        );

        return {
          fileName: document.fileName,
          fileId: `upload-${index + 1}`,
          totalBytes,
          totalChunks,
          chunkSizeBytes:
            executionConfig.uploadChunkSizeBytes,
          pausedUploadedChunks,
          skippedChunksOnResume: pausedUploadedChunks.length,
          skippedBytesOnResume,
          resumedBytesUploaded: totalBytes - skippedBytesOnResume,
          mergedMatchesOriginal: true,
          mergedFilePath: document.mergedFilePath,
          sourcePath: document.sourcePath,
        };
      });
  const averageCitationCount =
    cases.length === 0
      ? null
      : Number(
          (
            cases.reduce(
              (sum, caseResult) =>
                sum + (caseResult.citations?.length ?? 0),
              0
            ) / cases.length
          ).toFixed(2)
        );
  const report = {
    summary: {
      config:
        spec.reportType === "synthetic" ? executionConfig : {},
      corpus: spec.corpus
        ? {
            documents: documents.length,
            cases: cases.length,
            qaCases: qaCaseCount,
            compareCases: compareCaseCount,
            abstainCases: abstainCaseCount,
            path: spec.corpus.relativePath,
          }
        : undefined,
      createdAt: GENERATED_AT,
      metrics:
        hasGateChecks
          ? {
              caseCount: cases.length,
              checkCount,
              failedCaseCount: 0,
              failedCheckCount: 0,
              passedCaseCount: cases.length,
              passedCheckCount: checkCount,
              overallPassRate: 1,
              checkPassRate: 1,
            }
          : spec.reportType === "synthetic"
          ? {
              overallPassRate: 1,
              qaPageHitRate: 1,
              compareDocCoverageRate:
                compareCaseCount > 0 ? 1 : null,
              comparePageHitRate:
                compareCaseCount > 0 ? 1 : null,
              abstainAccuracy: abstainCaseCount > 0 ? 1 : null,
              answerContentHitRate: 1,
              claimSupportHitRate: 1,
              uploadResumeSuccessRate: 1,
              averageResponseTimeMs: 1,
              averageCitationCount,
              totalSkippedBytesOnResume: uploads.reduce(
                (sum, upload) =>
                  sum + upload.skippedBytesOnResume,
                0
              ),
            }
          : undefined,
      models:
        spec.reportType === "synthetic"
          ? {
              chat: "deterministic",
              embedding: "deterministic",
            }
          : undefined,
      provider:
        spec.id === "planner-mock"
          ? "mock"
          : spec.id === "planner-real"
            ? "real"
            : undefined,
      runId,
      status: "pass",
    },
    cases,
    documents,
    uploads,
    recovery,
  };

  return {
    ...report,
    evidence: {
      schemaVersion: "1.0.0",
      reportType: spec.reportType,
      reportId: spec.reportId ?? spec.id,
      runId: report.summary.runId,
      generatedAt: GENERATED_AT,
      git: {
        commitSha: TARGET_COMMIT,
        dirty: false,
      },
      command: `npm run ${spec.id}`,
      profile: "quality-current",
      corpus: spec.corpus
        ? {
            ...spec.corpus,
            contentHash: `${spec.id.length % 10}`.repeat(64),
          }
        : {
            contentHash: "unknown",
            id: "unknown",
            relativePath: "unknown",
            version: "unknown",
          },
      configHash: hashCanonicalJson(
        getPublicEvaluationConfig({
          report,
          reportType: spec.reportType,
        })
      ),
      provider: {
        id: spec.providerId,
        mode: spec.providerMode,
      },
      modelRouteId: spec.modelRouteId,
      sourceReports: [],
      suite: null,
      generatorVersion: "1.0.0",
    },
  };
};

const createFixture = ({ includePlannerReal = false } = {}) => {
  const reports = Object.fromEntries(
    CURRENT_QUALITY_REPORT_SPECS.filter(
      (spec) => spec.required || includePlannerReal
    ).map((spec) => [spec.id, buildReport(spec)])
  );
  const expectedCorpusHashes = Object.fromEntries(
    CURRENT_QUALITY_REPORT_SPECS.filter((spec) => spec.corpus).map((spec) => [
      spec.id,
      reports[spec.id]?.evidence.corpus.contentHash ?? null,
    ])
  );
  const expectedCorpusContracts = Object.fromEntries(
    CURRENT_QUALITY_REPORT_SPECS.filter((spec) => spec.corpus).map((spec) => [
      spec.id,
      {
        cases: Object.entries(
          CURRENT_QUALITY_SUITE_MANIFEST[spec.id]
            .requiredCaseSemantics
        ).map(([id, semantics]) => ({
          id,
          ...structuredClone(semantics),
        })),
        documentCount: Object.keys(
          CURRENT_QUALITY_SUITE_MANIFEST[spec.id]
            .requiredDocuments
        ).length,
        documents: Object.entries(
          CURRENT_QUALITY_SUITE_MANIFEST[spec.id]
            .requiredDocuments
        ).map(([key, document]) => ({
          key,
          ...structuredClone(document),
        })),
      },
    ])
  );

  return {
    expectedCorpusContracts,
    expectedCorpusHashes,
    reports,
  };
};

const buildGate = ({
  currentGitState = {
    commitSha: TARGET_COMMIT,
    dirty: false,
  },
  history = passingHistory,
  includePlannerReal = false,
  inputErrors = {},
  mutate,
  mutateFixture,
} = {}) => {
  const fixture = createFixture({ includePlannerReal });

  mutateFixture?.(fixture);
  mutate?.(fixture.reports);

  return buildCurrentQualityGateReport({
    currentGitState,
    expectedCorpusContracts: fixture.expectedCorpusContracts,
    expectedCorpusHashes: fixture.expectedCorpusHashes,
    failOnWarn: true,
    history,
    inputErrors,
    maxAgeHours: 24,
    now: NOW,
    reports: fixture.reports,
    requirePlannerReal: includePlannerReal,
    targetCommit: TARGET_COMMIT,
  });
};

test("current quality gate passes complete fresh clean reports from one commit", () => {
  const report = buildGate();

  assert.equal(
    report.summary.status,
    "pass",
    JSON.stringify(report.failedChecks, null, 2)
  );
  assert.equal(report.summary.reasonCode, "ok");
  assert.equal(report.summary.targetCommit, TARGET_COMMIT);
  assert.equal(report.currentEvidence.label, "current_commit_evidence");
  assert.equal(report.metricGate.label, "current_metrics_pinned_baseline");
  assert.equal(report.failedChecks.length, 0);
});

test("current quality gate rejects a required report without lineage", () => {
  const report = buildGate({
    mutate: (reports) => {
      delete reports["quality-synthetic"].evidence;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")?.reasonCode,
    "missing_lineage"
  );
  assert.equal(
    report.checks.find((check) => check.id === "quality-metrics")?.reasonCode,
    "quality_metrics_unverified"
  );
  assert.equal(
    report.checks.find((check) => check.id === "quality-metrics")?.actual
      ?.status,
    "unverified"
  );
  assert.equal(report.metricGate.status, "unverified");
  assert.equal(report.metricGate.diagnosticStatus, "pass");
});

test("current quality gate records malformed producer output as an invalid report", () => {
  const report = buildGate({
    inputErrors: {
      "quality-synthetic": {
        code: "invalid_json",
        fileName: "latest-quality.json",
      },
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "invalid_report"
  );
});

test("current quality gate rejects reports from another commit", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports.feedback.evidence.git.commitSha = "b".repeat(40);
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "feedback")?.reasonCode,
    "commit_mismatch"
  );
});

test("current quality gate rejects report-time and gate-time dirty worktrees", () => {
  const reportDirty = buildGate({
    mutate: (reports) => {
      reports.trajectory.evidence.git.dirty = true;
    },
  });
  const gateDirty = buildGate({
    currentGitState: {
      commitSha: TARGET_COMMIT,
      dirty: true,
    },
  });

  assert.equal(
    reportDirty.checks.find((check) => check.id === "trajectory")?.reasonCode,
    "dirty_worktree"
  );
  assert.equal(
    gateDirty.checks.find((check) => check.id === "gate-worktree")?.reasonCode,
    "dirty_worktree"
  );
});

test("current quality gate rejects stale and future reports", () => {
  const stale = buildGate({
    mutate: (reports) => {
      const generatedAt = "2026-07-28T07:30:00.000Z";

      reports["planner-mock"].evidence.generatedAt = generatedAt;
      reports["planner-mock"].summary.createdAt = generatedAt;
    },
  });
  const future = buildGate({
    mutate: (reports) => {
      const generatedAt = "2026-07-30T08:30:00.000Z";

      reports.recovery.evidence.generatedAt = generatedAt;
      reports.recovery.summary.createdAt = generatedAt;
    },
  });

  assert.equal(
    stale.checks.find((check) => check.id === "planner-mock")?.reasonCode,
    "stale_report"
  );
  assert.equal(
    future.checks.find((check) => check.id === "recovery")?.reasonCode,
    "future_report"
  );
});

test("current quality gate rejects a missing required report", () => {
  const report = buildGate({
    mutate: (reports) => {
      delete reports.feedback;
    },
  });

  assert.equal(
    report.checks.find((check) => check.id === "feedback")?.reasonCode,
    "missing_report"
  );
});

test("current quality gate validates planner-real when it exists", () => {
  const report = buildGate({
    includePlannerReal: true,
    mutate: (reports) => {
      const generatedAt = "2026-06-19T11:59:32.636Z";

      reports["planner-real"].evidence.generatedAt = generatedAt;
      reports["planner-real"].summary.createdAt = generatedAt;
    },
  });

  assert.equal(
    report.checks.find((check) => check.id === "planner-real")?.reasonCode,
    "stale_report"
  );
});

test("current quality gate rejects forged provider, corpus, and config identity", () => {
  const wrongProvider = buildGate({
    mutate: (reports) => {
      reports.trajectory.evidence.provider.id = "forged-provider";
    },
  });
  const wrongCorpus = buildGate({
    mutate: (reports) => {
      reports.feedback.evidence.corpus.contentHash = "f".repeat(64);
    },
  });
  const wrongConfig = buildGate({
    mutate: (reports) => {
      reports.recovery.summary.version = "changed-after-evidence";
    },
  });

  assert.equal(
    wrongProvider.checks.find((check) => check.id === "trajectory")?.reasonCode,
    "wrong_provider"
  );
  assert.equal(
    wrongCorpus.checks.find((check) => check.id === "feedback")?.reasonCode,
    "wrong_corpus"
  );
  assert.equal(
    wrongConfig.checks.find((check) => check.id === "recovery")?.reasonCode,
    "config_hash_mismatch"
  );
});

test("current quality gate fails when current metrics fail", () => {
  const report = buildGate({
    history: {
      ...passingHistory,
      qualityGate: {
        status: "fail",
        summary: "Current feedback regression failed.",
      },
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-metrics")?.reasonCode,
    "quality_metrics_failed"
  );
});

test("current quality gate rejects a substituted regression baseline", () => {
  const report = buildGate({
    history: {
      ...passingHistory,
      regressionGate: {
        baselineRunId: "attacker-controlled-baseline",
        baselineSelection: {
          profileMatched: true,
          strategy: "same_corpus_same_profile",
        },
      },
      runs: [
        {
          runId: "attacker-controlled-baseline",
          status: "ok",
        },
      ],
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-baseline")
      ?.reasonCode,
    "wrong_baseline"
  );
});

test("current quality gate rejects a stable synthetic failure even when relative metrics pass", () => {
  const report = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];

      synthetic.cases[0].answer = "Missing expected content";
      synthetic.cases[0].answerExpectationHit = false;
      synthetic.cases[0].passed = false;
      synthetic.summary.metrics.answerContentHitRate = 0.875;
      synthetic.summary.metrics.overallPassRate = 0.875;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate rejects a synthetic summary with no raw cases", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports["quality-synthetic"].cases = [];
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate rejects synchronized contraction of corpus and synthetic report", () => {
  const report = buildGate({
    mutateFixture: (fixture) => {
      const synthetic = fixture.reports["quality-synthetic"];

      synthetic.cases = synthetic.cases.slice(0, -1);
      synthetic.summary.corpus.cases = synthetic.cases.length;
      synthetic.summary.corpus.qaCases = synthetic.cases.length;
      fixture.expectedCorpusContracts["quality-synthetic"].cases =
        fixture.expectedCorpusContracts["quality-synthetic"].cases.slice(
          0,
          -1
        );
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate rejects a self-consistent contracted trajectory suite", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports.trajectory.cases = [];
      reports.trajectory.evidence.configHash = hashCanonicalJson(
        getPublicEvaluationConfig({
          report: reports.trajectory,
          reportType: "trajectory",
        })
      );
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "trajectory")?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate rejects a planner case with deleted checks", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports["planner-mock"].cases[0].checks = [];
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "planner-mock")?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate rejects deleted trajectory and planner raw responses", () => {
  const trajectory = buildGate({
    mutate: (reports) => {
      for (const caseResult of reports.trajectory.cases) {
        delete caseResult.response;
      }
    },
  });
  const planner = buildGate({
    mutate: (reports) => {
      for (const caseResult of reports["planner-mock"].cases) {
        delete caseResult.response;
      }
    },
  });
  const contradictory = buildGate({
    mutate: (reports) => {
      reports.trajectory.cases[0].response.agentMode = "document";
      reports["planner-mock"].cases[0].response.planner.fallback = true;
    },
  });

  assert.equal(
    trajectory.checks.find((check) => check.id === "trajectory")
      ?.reasonCode,
    "report_integrity_failed"
  );
  assert.equal(
    planner.checks.find((check) => check.id === "planner-mock")
      ?.reasonCode,
    "report_integrity_failed"
  );
  assert.equal(
    contradictory.checks.find((check) => check.id === "trajectory")
      ?.reasonCode,
    "report_integrity_failed"
  );
  assert.equal(
    contradictory.checks.find((check) => check.id === "planner-mock")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate does not trust trajectory PASS after raw observations are removed", () => {
  const report = buildGate({
    mutate: (reports) => {
      for (const caseResult of reports.trajectory.cases) {
        for (const check of caseResult.checks) {
          delete check.detail;
        }

        delete caseResult.response.observed;
      }
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "trajectory")?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate treats check detail as diagnostics, not as the evidence oracle", () => {
  const report = buildGate({
    mutate: (reports) => {
      for (const caseResult of reports.trajectory.cases) {
        for (const check of caseResult.checks) {
          delete check.detail;
        }
      }
    },
  });

  assert.equal(report.summary.status, "pass");
});

test("current quality gate rejects forged high-risk trajectory observations", () => {
  const mutations = [
    (reports) => {
      reports.trajectory.cases.find(
        (caseResult) => caseResult.id === "custom_skill_access_scope"
      ).response.observed.chatScopes[0].workspaceId = "other-workspace";
    },
    (reports) => {
      reports.trajectory.cases.find(
        (caseResult) => caseResult.id === "capability_approval_resume"
      ).response.observed.resumed.sameRun = false;
    },
    (reports) => {
      reports.trajectory.cases.find(
        (caseResult) => caseResult.id === "privacy_sanitization"
      ).response.observed.selectionTokenPresent = true;
    },
    (reports) => {
      reports.trajectory.cases.find(
        (caseResult) =>
          caseResult.id === "agent_goal_lifecycle_completion"
      ).response.observed.deliverables.storedArtifactCount = 0;
    },
  ];

  for (const mutate of mutations) {
    const report = buildGate({ mutate });

    assert.equal(report.summary.status, "fail");
    assert.equal(
      report.checks.find((check) => check.id === "trajectory")
        ?.reasonCode,
      "report_integrity_failed"
    );
  }
});

test("suite validation itself fails closed on raw response mismatch", () => {
  const fixture = createFixture();
  const report = fixture.reports.trajectory;

  delete report.cases[0].response;
  const validation = validateCurrentQualitySuiteReport({
    report,
    specId: "trajectory",
  });

  assert.equal(validation.resultPassed, false);
  assert.ok(validation.integrityErrors.length > 0);
});

test("current quality gate recomputes recovery cases from raw recovery metrics", () => {
  const deleted = buildGate({
    mutate: (reports) => {
      delete reports.recovery.recovery;
    },
  });
  const forged = buildGate({
    mutate: (reports) => {
      reports.recovery.recovery.autoReplayFailureCount = 9;
    },
  });

  assert.equal(
    deleted.checks.find((check) => check.id === "recovery")
      ?.reasonCode,
    "report_integrity_failed"
  );
  assert.equal(
    forged.checks.find((check) => check.id === "recovery")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate rejects contradictory synthetic case semantics", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports["quality-synthetic"].cases[0].pageCoverageHit = false;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate cannot reclassify a required answer as abstention", () => {
  const report = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases[0];

      syntheticCase.shouldAbstain = true;
      syntheticCase.abstained = true;
      syntheticCase.passed = true;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate derives claim support from raw claim verdicts", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports["quality-synthetic"].cases[0].claimSupport.claims[0].supported =
        false;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate rejects raw-only synthetic evidence tampering", () => {
  const mutations = [
    (caseResult) => {
      caseResult.rawAnswer = "Employees receive an unlimited stipend.";
    },
    (caseResult) => {
      caseResult.rawCitations = [];
    },
    (caseResult) => {
      caseResult.rawRetrievedContexts = [];
    },
    (caseResult) => {
      caseResult.rawClaimSupport = {
        checked: true,
        supportedClaimCount: 1,
        unsupportedClaimCount: 0,
        claims: [
          {
            sourceRanks: [1],
            supported: true,
            text: "Employees receive an unlimited stipend",
          },
        ],
      };
    },
  ];

  for (const mutateRawEvidence of mutations) {
    const report = buildGate({
      mutate: (reports) => {
        const caseResult = reports["quality-synthetic"].cases.find(
          (candidate) => candidate.id === "qa_remote_alpha"
        );
        const finalProjection = structuredClone({
          answer: caseResult.answer,
          citations: caseResult.citations,
          retrievedContexts: caseResult.retrievedContexts,
          claimSupport: caseResult.claimSupport,
        });

        mutateRawEvidence(caseResult);

        assert.deepEqual(
          {
            answer: caseResult.answer,
            citations: caseResult.citations,
            retrievedContexts: caseResult.retrievedContexts,
            claimSupport: caseResult.claimSupport,
          },
          finalProjection
        );
      },
    });

    assert.equal(report.summary.status, "fail");
    assert.equal(
      report.checks.find((check) => check.id === "quality-synthetic")
        ?.reasonCode,
      "report_integrity_failed"
    );
  }
});

test("current quality gate rejects an affirmative answer mislabeled as abstention", () => {
  const report = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases.find(
        (caseResult) =>
          caseResult.id === "qa_satellite_stipend_abstain"
      );

      syntheticCase.abstained = true;
      syntheticCase.answer = "The employee receives 999999 dollars.";
      syntheticCase.abstainReason = syntheticCase.answer;
      syntheticCase.claimSupport = {
        checked: false,
        supportedClaimCount: 0,
        unsupportedClaimCount: 0,
        claims: [],
      };
      syntheticCase.citations = [];
      syntheticCase.citationCount = 0;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate rejects facts appended to an abstention phrase", () => {
  const report = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases.find(
        (caseResult) =>
          caseResult.id === "qa_satellite_stipend_abstain"
      );

      syntheticCase.answer +=
        " The employee receives 999999 dollars.";
      syntheticCase.abstainReason = syntheticCase.answer;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate pins required abstention answers exactly", () => {
  const appendedFact = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases.find(
        (caseResult) =>
          caseResult.id === "qa_satellite_stipend_abstain"
      );

      syntheticCase.answer =
        "I have not found reliable evidence that directly answers satellite relocation stipend and employees receive 999999 dollars.";
      syntheticCase.abstainReason = syntheticCase.answer;
    },
  });
  const forgedCoverageCount = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases.find(
        (caseResult) =>
          caseResult.id === "compare_remote_single_doc_abstain"
      );

      syntheticCase.answer =
        "I only found strong evidence in 999 of the 2 selected documents, so the comparison would be unreliable.";
      syntheticCase.abstainReason = syntheticCase.answer;
    },
  });

  for (const report of [appendedFact, forgedCoverageCount]) {
    assert.equal(report.summary.status, "fail");
    assert.equal(
      report.checks.find(
        (check) => check.id === "quality-synthetic"
      )?.reasonCode,
      "report_integrity_failed"
    );
  }
});

test("current quality gate requires raw claim checks for non-abstain answers", () => {
  const report = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases[0];

      syntheticCase.claimSupport = {
        checked: false,
        supportedClaimCount: 0,
        unsupportedClaimCount: 0,
        claims: [],
      };
      syntheticCase.claimSupportHit = true;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate accepts additional grounded facts without pinning formatter output", () => {
  const report = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases.find(
        (caseResult) => caseResult.id === "qa_remote_alpha"
      );
      const answer = `${syntheticCase.answer}\nSecurity checklists must be completed before each remote day. [Source 1]`;

      Object.assign(
        syntheticCase,
        reevaluateSyntheticCase({
          answer,
          caseResult: syntheticCase,
          manifest:
            CURRENT_QUALITY_SUITE_MANIFEST["quality-synthetic"],
        })
      );
    },
  });

  assert.equal(
    report.summary.status,
    "pass",
    JSON.stringify(report.failedChecks, null, 2)
  );
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.status,
    "pass"
  );
});

test("current quality gate accepts evidence-bound structured comparison rendering", () => {
  const report = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases.find(
        (caseResult) => caseResult.id === "compare_remote_numeric_conflict"
      );
      const alphaFact =
        "- handbook-alpha states Remote Work Policy Employees may work remotely 2 days per week with manager approval. [Source 1]";
      const gammaFact =
        "- handbook-gamma states Remote Work Policy Employees may work remotely 3 days per week with manager approval. [Source 2]";

      const answer = [
        "Summary:",
        "Per document:",
        alphaFact,
        gammaFact,
        "Differences:",
        alphaFact,
        gammaFact,
        "Gaps or uncertainty:",
      ].join("\n");

      Object.assign(
        syntheticCase,
        reevaluateSyntheticCase({
          answer,
          caseResult: syntheticCase,
          manifest:
            CURRENT_QUALITY_SUITE_MANIFEST["quality-synthetic"],
        })
      );
    },
  });

  assert.equal(
    report.summary.status,
    "pass",
    JSON.stringify(report.failedChecks, null, 2)
  );
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.status,
    "pass"
  );
});

test("current quality gate defaults required answer claim enforcement to on", () => {
  const manifest = CURRENT_QUALITY_SUITE_MANIFEST.feedback;

  assert.equal(
    Object.hasOwn(manifest, "enforceRequiredAnswerClaims"),
    false
  );

  const report = buildGate({
    mutate: (reports) => {
      const caseResult = reports.feedback.cases[0];
      const answer = `${caseResult.answer}\n${caseResult.answer}`;

      Object.assign(
        caseResult,
        reevaluateSyntheticCase({
          answer,
          caseResult,
          manifest,
        })
      );
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "feedback")?.reasonCode,
    "report_integrity_failed"
  );
  assert.ok(
    report.checks
      .find((check) => check.id === "feedback")
      ?.actual?.suite?.integrityErrors?.some((error) =>
        error.id.endsWith(".answer_claim_contract")
      )
  );
});

test("current quality gate rejects answer claims omitted from raw claim checks", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports["quality-synthetic"].cases[0].answer +=
        " The employee also receives 999999 dollars. [Source 1]";
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate independently recomputes raw claim support", () => {
  const report = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases[0];

      syntheticCase.answer +=
        " Employees also receive 999999 dollars. [Source 1]";
      const forgedClaims = splitAnswerClaims(
        syntheticCase.answer,
        syntheticCase.citations
      ).map((claim) => ({
        sourceRanks: claim.sourceRanks,
        supported: true,
        text: claim.text,
      }));

      syntheticCase.claimSupport.claims = forgedClaims;
      syntheticCase.claimSupport.supportedClaimCount =
        forgedClaims.length;
      syntheticCase.claimSupport.unsupportedClaimCount = 0;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate pins deterministic claim meaning and source attribution", () => {
  const report = buildGate({
    mutate: (reports) => {
      const syntheticCase = reports["quality-synthetic"].cases.find(
        (caseResult) => caseResult.id === "qa_remote_alpha"
      );

      syntheticCase.answer =
        "Manager approval may work remotely 2 days per week with employees. [Source 1]";
      const forgedClaims = splitAnswerClaims(
        syntheticCase.answer,
        syntheticCase.citations
      ).map((claim) => ({
        sourceRanks: claim.sourceRanks,
        supported: true,
        text: claim.text,
      }));

      syntheticCase.claimSupport.claims = forgedClaims;
      syntheticCase.claimSupport.supportedClaimCount =
        forgedClaims.length;
      syntheticCase.claimSupport.unsupportedClaimCount = 0;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate preserves required evidence for grounded abstentions", () => {
  const report = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];
      const syntheticCase = synthetic.cases.find(
        (caseResult) =>
          caseResult.id === "compare_remote_single_doc_abstain"
      );

      syntheticCase.citations = [];
      syntheticCase.citationCount = 0;
      syntheticCase.retrievedContexts = [];
      syntheticCase.ragasSample.retrieved_context_ids = [];
      syntheticCase.ragasSample.retrieved_contexts = [];
      syntheticCase.docCoverageHit = false;
      syntheticCase.pageCoverageHit = false;
      synthetic.summary.metrics.averageCitationCount = Number(
        (
          synthetic.cases.reduce(
            (sum, caseResult) => sum + caseResult.citations.length,
            0
          ) / synthetic.cases.length
        ).toFixed(2)
      );
    },
  });

  assert.equal(report.summary.status, "fail");
});

test("current quality gate binds citations to raw retrieved contexts", () => {
  const report = buildGate({
    mutate: (reports) => {
      for (const caseResult of reports["quality-synthetic"].cases) {
        caseResult.retrievedContexts = [];
        caseResult.ragasSample.retrieved_context_ids = [];
        caseResult.ragasSample.retrieved_contexts = [];
      }
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate validates citation identity against raw documents", () => {
  const report = buildGate({
    mutate: (reports) => {
      const citation = reports["quality-synthetic"].cases[0].citations[0];

      citation.docId = "bogus-document-id";
      citation.fileName = "bogus-document.pdf";
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate rejects non-contiguous, duplicate, or unused citations", () => {
  const report = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];
      const syntheticCase = synthetic.cases.find(
        (caseResult) => caseResult.id === "qa_remote_alpha"
      );

      syntheticCase.citations.push({
        ...syntheticCase.citations[0],
        rank: 2,
      });
      syntheticCase.citationCount = syntheticCase.citations.length;
      synthetic.summary.metrics.averageCitationCount = Number(
        (
          synthetic.cases.reduce(
            (sum, caseResult) => sum + caseResult.citations.length,
            0
          ) / synthetic.cases.length
        ).toFixed(2)
      );
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate rejects duplicate document and upload identities", () => {
  const report = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];

      synthetic.documents = synthetic.documents.map(() => ({
        ...synthetic.documents[0],
      }));
      synthetic.uploads = synthetic.uploads.map(() => ({
        ...synthetic.uploads[0],
      }));
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate pins chunk counts and document-upload path identity", () => {
  const wrongChunkCount = buildGate({
    mutate: (reports) => {
      reports["quality-synthetic"].documents[0].chunkCount = 1;
    },
  });
  const rotatedUploads = buildGate({
    mutate: (reports) => {
      const uploads = reports["quality-synthetic"].uploads;
      const fileNames = uploads.map((upload) => upload.fileName);

      uploads.forEach((upload, index) => {
        upload.fileName = fileNames[(index + 1) % fileNames.length];
      });
    },
  });

  for (const report of [wrongChunkCount, rotatedUploads]) {
    assert.equal(report.summary.status, "fail");
    assert.equal(
      report.checks.find(
        (check) => check.id === "quality-synthetic"
      )?.reasonCode,
      "report_integrity_failed"
    );
  }
});

test("current quality gate pins required corpus case semantics", () => {
  const report = buildGate({
    mutateFixture: (fixture) => {
      const syntheticCase = fixture.reports["quality-synthetic"].cases[0];
      const contractCase =
        fixture.expectedCorpusContracts["quality-synthetic"].cases[0];

      contractCase.expectedAnswerIncludes = [];
      syntheticCase.answer = "The moon is made of cheese.";
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate pins required corpus document pages", () => {
  const report = buildGate({
    mutateFixture: (fixture) => {
      const corpusDocument =
        fixture.expectedCorpusContracts["quality-synthetic"]
          .documents[0];

      corpusDocument.pages[0] +=
        " Employees receive 999999 dollars.";
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate recomputes resumed-upload invariants", () => {
  const report = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];

      for (const upload of synthetic.uploads) {
        upload.pausedUploadedChunks = [];
        upload.totalChunks = 0;
        upload.skippedBytesOnResume = -1;
      }

      synthetic.summary.metrics.totalSkippedBytesOnResume =
        -synthetic.uploads.length;
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate pins deterministic upload byte geometry", () => {
  const report = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];

      for (const upload of synthetic.uploads) {
        upload.totalBytes = 361;
        upload.totalChunks = 3;
        upload.pausedUploadedChunks = [0];
        upload.skippedChunksOnResume = 1;
        upload.skippedBytesOnResume = 180;
        upload.resumedBytesUploaded = 181;
      }
      synthetic.summary.metrics.totalSkippedBytesOnResume =
        synthetic.uploads.length * 180;
    },
  });

  assert.equal(report.summary.status, "fail");
});

test("current quality gate fails closed on oversized upload metadata", () => {
  const report = buildGate({
    mutate: (reports) => {
      const upload = reports["quality-synthetic"].uploads[0];

      upload.totalBytes = 1e18;
      upload.totalChunks = Math.ceil(
        upload.totalBytes / upload.chunkSizeBytes
      );
    },
  });

  assert.equal(report.summary.status, "fail");
});

test("current quality gate rejects a no-op upload resume", () => {
  const report = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];

      for (const upload of synthetic.uploads) {
        upload.chunkSizeBytes = upload.totalBytes;
        upload.totalChunks = 1;
        upload.pausedUploadedChunks = [0];
        upload.skippedChunksOnResume = 1;
        upload.skippedBytesOnResume = upload.totalBytes;
        upload.resumedBytesUploaded = 0;
      }

      synthetic.summary.metrics.totalSkippedBytesOnResume =
        synthetic.uploads.reduce(
          (sum, upload) => sum + upload.skippedBytesOnResume,
          0
        );
    },
  });

  assert.equal(report.summary.status, "fail");
});

test("current quality gate rejects zero document chunks", () => {
  const report = buildGate({
    mutate: (reports) => {
      for (const document of reports["quality-synthetic"]
        .documents) {
        document.chunkCount = 0;
      }
    },
  });

  assert.equal(report.summary.status, "fail");
});

test("current quality gate rejects citations below the configured relevance threshold", () => {
  const report = buildGate({
    mutate: (reports) => {
      for (const caseResult of reports["quality-synthetic"].cases) {
        for (const citation of caseResult.citations) {
          citation.score = -999;
        }
      }
    },
  });

  assert.equal(report.summary.status, "fail");
});

test("current quality gate pins the deterministic synthetic config", () => {
  const report = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];

      synthetic.summary.config.minRelevanceScore = -1_000;
      for (const caseResult of synthetic.cases) {
        for (const citation of caseResult.citations) {
          citation.score = -999;
        }
      }
      synthetic.evidence.configHash = hashCanonicalJson(
        getPublicEvaluationConfig({
          report: synthetic,
          reportType: "synthetic",
        })
      );
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "quality-synthetic")
      ?.reasonCode,
    "report_integrity_failed"
  );
});

test("current quality gate binds report summary identity to its evidence envelope", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports["quality-synthetic"].summary.createdAt =
        "1999-01-01T00:00:00.000Z";
    },
  });

  assert.equal(report.summary.status, "fail");
});

test("current quality gate pins evidence schema and generator versions", () => {
  const wrongSchema = buildGate({
    mutate: (reports) => {
      reports.feedback.evidence.schemaVersion = "999.0.0";
    },
  });
  const wrongGenerator = buildGate({
    mutate: (reports) => {
      reports.feedback.evidence.generatorVersion = "999.0.0";
    },
  });

  assert.equal(wrongSchema.summary.status, "fail");
  assert.equal(wrongGenerator.summary.status, "fail");
});

test("current quality gate rejects invalid timings and forged summary status", () => {
  const invalidTiming = buildGate({
    mutate: (reports) => {
      const synthetic = reports["quality-synthetic"];

      synthetic.cases[0].responseTimeMs = -1;
      synthetic.summary.metrics.averageResponseTimeMs = 0.75;
    },
  });
  const forgedStatus = buildGate({
    mutate: (reports) => {
      reports.feedback.summary.status = "PASS";
    },
  });

  assert.equal(invalidTiming.summary.status, "fail");
  assert.equal(forgedStatus.summary.status, "fail");
});

test("current quality gate keeps required feedback seeds outside the generated-corpus trust loop", () => {
  const report = buildGate({
    mutateFixture: (fixture) => {
      const feedback = fixture.reports.feedback;
      const retainedCase = feedback.cases[1];

      feedback.cases = [retainedCase];
      feedback.summary.corpus.cases = 1;
      feedback.summary.corpus.qaCases = 1;
      fixture.expectedCorpusContracts.feedback.cases =
        fixture.expectedCorpusContracts.feedback.cases.slice(1);
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "feedback")?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate rejects duplicate or extra check IDs", () => {
  const duplicate = buildGate({
    mutate: (reports) => {
      const plannerCase = reports["planner-mock"].cases[0];

      plannerCase.checks.push({
        ...plannerCase.checks[0],
      });
    },
  });
  const extra = buildGate({
    mutate: (reports) => {
      reports.trajectory.cases[0].checks.push({
        id: "uncontracted_check",
        passed: true,
      });
    },
  });

  assert.equal(
    duplicate.checks.find((check) => check.id === "planner-mock")?.reasonCode,
    "suite_contract_mismatch"
  );
  assert.equal(
    extra.checks.find((check) => check.id === "trajectory")?.reasonCode,
    "suite_contract_mismatch"
  );
});

test("current quality gate requires the current-evidence profile", () => {
  const report = buildGate({
    mutate: (reports) => {
      reports.feedback.evidence.profile = "default";
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "feedback")?.reasonCode,
    "wrong_profile"
  );
});

test("current quality gate validates each planner provider's own status", () => {
  const report = buildGate({
    includePlannerReal: true,
    mutate: (reports) => {
      const planner = reports["planner-real"];
      const failedCase = planner.cases[0];

      failedCase.checks[0].passed = false;
      failedCase.failedCheckCount = 1;
      failedCase.passed = false;
      planner.summary.metrics.failedCaseCount = 1;
      planner.summary.metrics.failedCheckCount = 1;
      planner.summary.metrics.passedCaseCount -= 1;
      planner.summary.metrics.passedCheckCount -= 1;
      planner.summary.metrics.overallPassRate = Number(
        (
          planner.summary.metrics.passedCaseCount /
          planner.summary.metrics.caseCount
        ).toFixed(4)
      );
      planner.summary.metrics.checkPassRate = Number(
        (
          planner.summary.metrics.passedCheckCount /
          planner.summary.metrics.checkCount
        ).toFixed(4)
      );
      planner.summary.status = "fail";
    },
  });

  assert.equal(report.summary.status, "fail");
  assert.equal(
    report.checks.find((check) => check.id === "planner-real")?.reasonCode,
    "report_failed"
  );
});

test("current quality reader uses latest-quality as current and excludes legacy latest", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "current-quality-inputs-")
  );
  const syntheticSpec = CURRENT_QUALITY_REPORT_SPECS.find(
    (spec) => spec.id === "quality-synthetic"
  );
  const current = buildReport(syntheticSpec);
  const legacy = structuredClone(current);

  current.summary.runId = "current-quality-run";
  current.summary.createdAt = "2026-07-30T07:30:00.000Z";
  current.evidence.runId = current.summary.runId;
  current.evidence.generatedAt = current.summary.createdAt;
  legacy.summary.runId = "legacy-baseline-run";
  legacy.summary.createdAt = "2026-04-21T20:43:26.600Z";
  delete legacy.evidence;

  try {
    await writeFile(
      path.join(directory, "latest-quality.json"),
      JSON.stringify(current)
    );
    await writeFile(
      path.join(directory, "latest.json"),
      JSON.stringify(legacy)
    );

    const { history, reports } = await readCurrentQualityInputs({
      baselinePath: null,
      inputDirectory: directory,
    });

    assert.equal(reports["quality-synthetic"].summary.runId, "current-quality-run");
    assert.equal(history.latestRun.runId, "current-quality-run");
    assert.equal(history.regressionGate.baselineRunId, null);
    assert.ok(
      history.runs.every((run) => run.runId !== "legacy-baseline-run")
    );
    assert.equal(legacy.evidence, undefined);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("current quality reader preserves a malformed report as gate diagnostics", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "current-quality-invalid-json-")
  );

  try {
    await writeFile(path.join(directory, "latest-quality.json"), "{not-json");

    const { inputErrors, reports } = await readCurrentQualityInputs({
      inputDirectory: directory,
    });

    assert.equal(reports["quality-synthetic"], null);
    assert.deepEqual(inputErrors["quality-synthetic"], {
      code: "invalid_json",
      fileName: "latest-quality.json",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("current quality reader does not let newer result files replace the pinned baseline", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "current-quality-hostile-baseline-")
  );
  const syntheticSpec = CURRENT_QUALITY_REPORT_SPECS.find(
    (spec) => spec.id === "quality-synthetic"
  );
  const current = buildReport(syntheticSpec);
  const hostileBaseline = structuredClone(current);

  current.summary.runId = "current-quality-run";
  current.summary.createdAt = "2026-07-30T07:30:00.000Z";
  current.evidence.runId = current.summary.runId;
  current.evidence.generatedAt = current.summary.createdAt;
  hostileBaseline.summary.runId = "hostile-newer-baseline";
  hostileBaseline.summary.createdAt = "2026-07-30T07:00:00.000Z";
  hostileBaseline.summary.metrics.overallPassRate = 0;
  hostileBaseline.cases[0].passed = false;
  delete hostileBaseline.evidence;

  try {
    await writeFile(
      path.join(directory, "latest-quality.json"),
      JSON.stringify(current)
    );
    await writeFile(
      path.join(directory, "2026-07-30-hostile.json"),
      JSON.stringify(hostileBaseline)
    );

    const { history } = await readCurrentQualityInputs({
      inputDirectory: directory,
    });

    assert.equal(
      history.regressionGate.baselineRunId,
      "quality-near-duplicate-deterministic-v1"
    );
    assert.ok(
      history.runs.every((run) => run.runId !== "hostile-newer-baseline")
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("current quality reader compares deterministic reports to the pinned deterministic baseline", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "current-quality-baseline-")
  );
  const syntheticSpec = CURRENT_QUALITY_REPORT_SPECS.find(
    (spec) => spec.id === "quality-synthetic"
  );
  const current = buildReport(syntheticSpec);

  current.summary.runId = "current-quality-run";
  current.summary.createdAt = "2026-07-30T07:30:00.000Z";
  current.evidence.runId = current.summary.runId;
  current.evidence.generatedAt = current.summary.createdAt;

  try {
    await writeFile(
      path.join(directory, "latest-quality.json"),
      JSON.stringify(current)
    );

    const { history } = await readCurrentQualityInputs({
      inputDirectory: directory,
    });

    assert.equal(
      history.regressionGate.baselineRunId,
      "quality-near-duplicate-deterministic-v1"
    );
    assert.equal(
      history.regressionGate.baselineSelection.strategy,
      "same_corpus_same_profile"
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
