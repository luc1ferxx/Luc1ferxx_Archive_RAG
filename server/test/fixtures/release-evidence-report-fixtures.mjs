import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CURRENT_QUALITY_SUITE_MANIFEST,
} from "../../evaluation/quality-current-suite-manifest.js";
import {
  buildRecoveryObservabilityCases,
} from "../../evaluation/recovery-observability-cases.js";
import {
  buildRolloutReadinessReport,
} from "../../evaluation/rollout-readiness-report.js";
import {
  buildDeterministicEvidenceAnswer,
} from "../../evaluation/deterministic-evidence-answer.js";
import {
  getRobustEvalSuiteReport,
} from "../../evaluation/eval-suite.js";
import {
  evaluateSyntheticCaseResponse,
} from "../../evaluation/synthetic-case-evaluator.js";
import {
  recomputeSyntheticCaseOutcome,
} from "../../evaluation/synthetic-report-case-evaluator.js";
import {
  buildSyntheticDocumentId,
} from "../../evaluation/synthetic-document-identity.js";
import {
  buildRerankReplayContext,
  replayRerankCaseRankings,
} from "../../evaluation/rerank-report-replay.js";
import {
  prepareComparisonSourceBundle,
  prepareQASourceBundle,
  writeComparisonAnswer,
  writeQaAnswer,
} from "../../rag/answer-writer.js";
import {
  buildComparisonAnalysisFromContexts,
  buildComparisonAnalysisFromEvidence,
} from "../../rag/comparison-analysis-summary.js";
import { assessComparisonConfidence } from "../../rag/confidence.js";
import { chunkDocumentWithConfig } from "../../rag/chunker.js";
import {
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../../rag/openai.js";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(fixtureDirectory, "..", "..");

export const readEvaluationCorpus = (corpusPath) =>
  JSON.parse(
    readFileSync(
      path.resolve(serverDirectory, corpusPath.replace(/^server\//, "")),
      "utf8"
    )
  );

const round = (value, precision = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(precision)) : null;

const average = (values) => {
  const finiteValues = values.filter(Number.isFinite);

  return finiteValues.length > 0
    ? round(
        finiteValues.reduce((sum, value) => sum + value, 0) /
          finiteValues.length
      )
    : null;
};

const buildSyntheticDocumentIdByKey = (corpus) =>
  new Map(
    corpus.documents.map((document) => [
      document.key,
      buildSyntheticDocumentId({
        corpusId: corpus.id,
        corpusVersion: corpus.version,
        docKey: document.key,
      }),
    ])
  );

const buildSyntheticCaseContract = (corpusCase, corpus) => ({
  ...corpusCase,
  corpusId: corpus.id,
  corpusVersion: corpus.version,
});

const materializeRecomputedSyntheticCase = ({
  caseResult,
  corpus,
  corpusCase,
}) => {
  const outcome = recomputeSyntheticCaseOutcome({
    caseContract: buildSyntheticCaseContract(corpusCase, corpus),
    caseResult,
    documentContracts: corpus.documents,
  });

  if (!outcome.comparisonSummaryMatches || !outcome.projectionMatches) {
    const reasons = [
      outcome.comparisonSummaryMatches
        ? null
        : outcome.comparisonSummaryError ?? "comparison summary mismatch",
      ...outcome.projectionMismatches.map(
        ([field]) => `${field} projection mismatch`
      ),
    ].filter(Boolean);

    throw new Error(
      `Synthetic fixture raw facts could not be recomputed for ${corpusCase.id}: ${reasons.join(
        ", "
      )}`
    );
  }

  return {
    ...caseResult,
    shouldAbstain: outcome.shouldAbstain,
    abstained: outcome.abstained,
    docCoverageHit: outcome.docCoverageHit,
    pageCoverageHit: outcome.pageCoverageHit,
    answerExpectationHit: outcome.answerExpectationHit,
    rawClaimSupport: outcome.rawClaimSupport,
    rawClaimSupportHit: outcome.rawClaimSupportHit,
    claimSupport: outcome.claimSupport,
    claimSupportHit: outcome.claimSupportHit,
    comparisonAnalysisSummary: outcome.comparisonAnalysisSummary,
    comparisonExpectationHit: outcome.comparisonExpectationHit,
    comparisonVerdict: outcome.comparisonVerdict,
    passed: outcome.passed,
  };
};

const buildSyntheticEvidenceResults = ({
  docId,
  docKey,
  document,
  executionConfig,
  pageNumber,
}) => {
  const chunks = chunkDocumentWithConfig({
    docId,
    fileName: document.fileName,
    publicFilePath: `/evaluation-contract/${document.fileName}`,
    pages: document.pages.map((text, pageIndex) => ({
      pageNumber: pageIndex + 1,
      text,
    })),
    chunkStrategy: executionConfig.chunkStrategy,
    chunkSize: executionConfig.chunkSize,
    chunkOverlap: executionConfig.chunkOverlap,
  }).filter((chunk) => chunk.metadata.pageNumber === pageNumber);

  if (chunks.length === 0) {
    throw new Error(
      `Synthetic fixture could not reconstruct ${docKey} page ${pageNumber}`
    );
  }

  return chunks.map((chunk) => ({
    score: 0.99,
    document: {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        docKey,
      },
    },
  }));
};

const buildPassingSyntheticCase = async (
  corpusCase,
  corpus,
  executionConfig
) => {
  const documentsByKey = new Map(
    corpus.documents.map((document) => [document.key, document])
  );
  const docIdByKey = buildSyntheticDocumentIdByKey(corpus);
  const selectedDocuments = corpusCase.docKeys.map((docKey) => ({
    docId: docIdByKey.get(docKey),
    fileName: documentsByKey.get(docKey).fileName,
  }));
  const evidenceResults = (corpusCase.expectedEvidence ?? []).flatMap(
    (expected) =>
      (expected.pages?.length > 0 ? expected.pages : [1]).flatMap(
        (pageNumber) =>
          buildSyntheticEvidenceResults({
            docId: docIdByKey.get(expected.docKey),
            docKey: expected.docKey,
            document: documentsByKey.get(expected.docKey),
            executionConfig,
            pageNumber,
          })
      )
  );
  const resultsByDocId = new Map(
    selectedDocuments.map(({ docId }) => [
      docId,
      evidenceResults.filter(
        (result) => result.document.metadata.docId === docId
      ),
    ])
  );
  let response;

  if (corpusCase.type === "qa") {
    const bundle = prepareQASourceBundle({ results: evidenceResults });
    const writtenAnswer = await writeQaAnswer({
      query: corpusCase.question,
      resolvedQuery: corpusCase.question,
      bundle,
    });

    response = {
      ...writtenAnswer,
      abstained: false,
      retrievedContexts: bundle.retrievedContexts,
      comparisonAnalysisSummary: null,
    };
  } else {
    const confidence = assessComparisonConfidence({
      docIds: selectedDocuments.map(({ docId }) => docId),
      perDocumentResults: resultsByDocId,
      queryText: corpusCase.question,
    });
    const comparison = buildComparisonAnalysisFromEvidence({
      query: corpusCase.question,
      documents: selectedDocuments,
      perDocumentResults: confidence.usableResultsByDoc,
    });
    const bundle = prepareComparisonSourceBundle({
      alignment: comparison.alignment,
    });
    const comparisonAnalysisSummary = buildComparisonAnalysisFromContexts({
      query: corpusCase.question,
      documents: selectedDocuments,
      retrievedContexts: bundle.retrievedContexts,
    }).summary;

    response = confidence.confident
      ? {
          ...(await writeComparisonAnswer({
            query: corpusCase.question,
            resolvedQuery: corpusCase.question,
            bundle,
            analysis: comparison.analysis,
          })),
          retrievedContexts: bundle.retrievedContexts,
          comparisonAnalysisSummary,
        }
      : {
          text: confidence.reason,
          abstained: true,
          abstainReason: confidence.reason,
          citations: bundle.citations,
          retrievedContexts: bundle.retrievedContexts,
          comparisonAnalysisSummary,
        };
  }

  const caseResult = evaluateSyntheticCaseResponse({
    testCase: corpusCase,
    response,
    docKeyByDocId: new Map(
      [...docIdByKey].map(([docKey, docId]) => [docId, docKey])
    ),
    pagesByDocKey: new Map(
      corpus.documents.map((document) => [document.key, document.pages])
    ),
  });

  return materializeRecomputedSyntheticCase({
    caseResult,
    corpus,
    corpusCase,
  });
};

const buildSyntheticSummaryMetrics = (cases) => {
  const qaCases = cases.filter(
    (caseResult) =>
      caseResult.type === "qa" && caseResult.shouldAbstain !== true
  );
  const compareCases = cases.filter(
    (caseResult) =>
      caseResult.type === "compare" && caseResult.shouldAbstain !== true
  );
  const comparisonExpectationCases = cases.filter(
    (caseResult) => caseResult.comparisonVerdict.checked === true
  );
  const rate = (matchingCases, allCases) =>
    allCases.length > 0 ? round(matchingCases.length / allCases.length) : null;

  return {
    overallPassRate: rate(
      cases.filter((caseResult) => caseResult.passed),
      cases
    ),
    qaPageHitRate: rate(
      qaCases.filter((caseResult) => caseResult.pageCoverageHit),
      qaCases
    ),
    comparePageHitRate: rate(
      compareCases.filter((caseResult) => caseResult.pageCoverageHit),
      compareCases
    ),
    averageCitationCount:
      cases.length > 0
        ? round(
            cases.reduce(
              (sum, caseResult) => sum + caseResult.citationCount,
              0
            ) / cases.length,
            2
          )
        : null,
    comparisonExpectationHitRate: rate(
      comparisonExpectationCases.filter(
        (caseResult) => caseResult.comparisonExpectationHit
      ),
      comparisonExpectationCases
    ),
  };
};

export const buildPassingRobustSyntheticReport = async ({
  corpusPath = "evaluation/synthetic-corpus-compare-hard.json",
  createdAt,
  runId,
} = {}) => {
  const corpus = readEvaluationCorpus(corpusPath);
  const reportSpec = getRobustEvalSuiteReport("compare-hard-synthetic");

  if (!reportSpec?.executionConfig) {
    throw new Error("Missing compare-hard synthetic report contract");
  }

  configureOpenAIProvider({
    completeText: async (prompt) => buildDeterministicEvidenceAnswer(prompt),
  });

  try {
    const cases = [];

    for (const corpusCase of corpus.cases) {
      cases.push(
        await buildPassingSyntheticCase(
          corpusCase,
          corpus,
          reportSpec.executionConfig
        )
      );
    }

    const failedCaseIds = cases
      .filter((caseResult) => caseResult.passed !== true)
      .map((caseResult) => caseResult.id);

    if (failedCaseIds.length > 0) {
      throw new Error(
        `Passing robust synthetic fixture produced failing cases: ${failedCaseIds.join(
          ", "
        )}`
      );
    }

    return {
      summary: {
        runId,
        createdAt,
        config: structuredClone(reportSpec.executionConfig),
        corpus: {
          path: corpusPath,
          cases: cases.length,
        },
        metrics: buildSyntheticSummaryMetrics(cases),
        status: cases.every((caseResult) => caseResult.passed)
          ? "pass"
          : "fail",
      },
      cases,
    };
  } finally {
    resetOpenAIProvider();
  }
};

const metricNames = [
  "ndcgAtK",
  "precisionAtK",
  "recallAtK",
  "mrr",
  "noiseRateAtK",
  "relevantCountAtK",
  "noiseCountAtK",
  "expectedRelevantCount",
  "evaluatedCountAtK",
];
const liftMetricNames = ["ndcgAtK", "precisionAtK", "recallAtK", "mrr"];

const labelRanking = ({ expectedUnits, ranking }) => {
  const matchedUnitKeys = new Set();

  return ranking.map((entry) => {
    const expectedUnit = expectedUnits.find(
      (unit) =>
        unit.docKey === entry.docKey &&
        (unit.pageNumber === null || unit.pageNumber === entry.pageNumber)
    );
    const exactRelevant =
      Boolean(expectedUnit) && !matchedUnitKeys.has(expectedUnit.key);

    if (exactRelevant) {
      matchedUnitKeys.add(expectedUnit.key);
    }

    return {
      ...entry,
      exactRelevant,
      matchedUnitKey: expectedUnit?.key ?? null,
      relevanceGrade: exactRelevant ? 2 : 0,
    };
  });
};

const dcg = (grades, k) =>
  grades
    .slice(0, k)
    .reduce(
      (sum, grade, index) =>
        sum + (2 ** grade - 1) / Math.log2(index + 2),
      0
    );

const calculateRankingMetrics = ({ expectedUnits, k, ranking }) => {
  const topRanking = ranking.slice(0, k);
  const labeledRanking = labelRanking({ expectedUnits, ranking: topRanking });
  const relevantEntries = labeledRanking.filter((entry) => entry.exactRelevant);
  const matchedUnits = new Set(
    labeledRanking.map((entry) => entry.matchedUnitKey).filter(Boolean)
  );
  const firstRelevantIndex = labeledRanking.findIndex(
    (entry) => entry.exactRelevant
  );
  const idealDcg = dcg(expectedUnits.map(() => 2), k);
  const actualDcg = dcg(
    labeledRanking.map((entry) => entry.relevanceGrade),
    k
  );
  const relevantCount = relevantEntries.length;
  const noiseCount = topRanking.length - relevantCount;

  return {
    ndcgAtK: idealDcg > 0 ? round(actualDcg / idealDcg) : null,
    precisionAtK:
      topRanking.length > 0 ? round(relevantCount / topRanking.length) : null,
    recallAtK:
      expectedUnits.length > 0
        ? round(matchedUnits.size / expectedUnits.length)
        : null,
    mrr: firstRelevantIndex >= 0 ? round(1 / (firstRelevantIndex + 1)) : 0,
    noiseRateAtK:
      topRanking.length > 0 ? round(noiseCount / topRanking.length) : null,
    relevantCountAtK: relevantCount,
    noiseCountAtK: noiseCount,
    expectedRelevantCount: expectedUnits.length,
    evaluatedCountAtK: topRanking.length,
  };
};

const calculateLift = (baselineMetrics, rerankedMetrics) => {
  const lift = Object.fromEntries(
    liftMetricNames.map((metric) => {
      const absolute = round(
        rerankedMetrics[metric] - baselineMetrics[metric]
      );

      return [
        metric,
        {
          absolute,
          relative:
            absolute !== null && baselineMetrics[metric] > 0
              ? round(absolute / baselineMetrics[metric])
              : null,
        },
      ];
    })
  );

  lift.noiseRateAtK = {
    absoluteReduction: round(
      baselineMetrics.noiseRateAtK - rerankedMetrics.noiseRateAtK
    ),
    relativeReduction:
      baselineMetrics.noiseRateAtK > 0
        ? round(
            (baselineMetrics.noiseRateAtK - rerankedMetrics.noiseRateAtK) /
              baselineMetrics.noiseRateAtK
          )
        : null,
  };

  return lift;
};

const calculateNoiseFilteringRate = ({
  baselineRanking,
  expectedUnits,
  rerankedRanking,
}) => {
  const baselineLabels = labelRanking({
    expectedUnits,
    ranking: baselineRanking,
  });
  const noiseResultKeys = baselineRanking
    .filter((_entry, index) => !baselineLabels[index].exactRelevant)
    .map((entry) => entry.resultKey);

  if (noiseResultKeys.length === 0) {
    return null;
  }

  const rerankedResultKeys = new Set(
    rerankedRanking.map((entry) => entry.resultKey)
  );
  return round(
    noiseResultKeys.filter((resultKey) => !rerankedResultKeys.has(resultKey))
      .length / noiseResultKeys.length
  );
};

const averageMetrics = (entries) =>
  Object.fromEntries(
    metricNames.map((metric) => [
      metric,
      average(entries.map((entry) => entry[metric])),
    ])
  );

const buildAggregate = (entries) => {
  const baselineMetrics = averageMetrics(
    entries.map((entry) => entry.baselineMetrics)
  );
  const rerankedMetrics = averageMetrics(
    entries.map((entry) => entry.rerankedMetrics)
  );

  return {
    baselineMetrics,
    rerankedMetrics,
    lift: calculateLift(baselineMetrics, rerankedMetrics),
    noiseFilteringRate: average(
      entries.map((entry) => entry.noiseFilteringRate)
    ),
    averageCandidateCount: average(
      entries.map((entry) => entry.candidateCount)
    ),
  };
};

export const buildPassingRobustRerankReport = ({
  corpusPath,
  createdAt,
  reportId,
  runId,
} = {}) => {
  const corpus = readEvaluationCorpus(corpusPath);
  const reportSpec =
    getRobustEvalSuiteReport(reportId) ??
    ["rerank-hard-cs", "arxiv-real-paper-rerank"]
      .map((candidateId) => getRobustEvalSuiteReport(candidateId))
      .find((candidate) => candidate?.corpusPath === corpusPath);

  if (!reportSpec?.rankingConfig || !reportSpec.rerankProvider) {
    throw new Error(`Unknown robust rerank report contract: ${reportId ?? corpusPath}`);
  }

  const rankingConfig = {
    ...structuredClone(reportSpec.rankingConfig),
    rerankProvider: reportSpec.rerankProvider,
    rerankWeight: reportSpec.rerankWeight,
  };
  const replayContext = buildRerankReplayContext({
    config: rankingConfig,
    documentContracts: corpus.documents,
  });
  const buildRankingEntry = (entry) => {
    const {
      baselineRanking,
      candidateRanking,
      expectedUnits,
      k,
      rerankedRanking,
    } = entry;
    const baselineMetrics = calculateRankingMetrics({
      expectedUnits,
      k,
      ranking: baselineRanking,
    });
    const rerankedMetrics = calculateRankingMetrics({
      expectedUnits,
      k,
      ranking: rerankedRanking,
    });

    return {
      ...entry,
      baselineMetrics,
      rerankedMetrics,
      lift: calculateLift(baselineMetrics, rerankedMetrics),
      noiseFilteringRate: calculateNoiseFilteringRate({
        baselineRanking,
        expectedUnits,
        rerankedRanking,
      }),
    };
  };
  const cases = corpus.cases
    .filter((corpusCase) => corpusCase.shouldAbstain !== true)
    .map((corpusCase) => {
      const replay = replayRerankCaseRankings({
        caseContract: corpusCase,
        replayContext,
      });
      const common = {
        id: corpusCase.id,
        type: corpusCase.type,
        question: corpusCase.question,
        docKeys: corpusCase.docKeys,
        ...(Object.hasOwn(corpusCase, "compareExpectation")
          ? { compareExpectation: corpusCase.compareExpectation }
          : {}),
      };

      if (corpusCase.type === "compare" && corpusCase.docKeys.length > 1) {
        const perDocument = replay.perDocument.map((entry) =>
          buildRankingEntry(entry)
        );
        const aggregate = buildAggregate(perDocument);

        return {
          ...common,
          ...replay,
          baselineMetrics: aggregate.baselineMetrics,
          rerankedMetrics: aggregate.rerankedMetrics,
          lift: aggregate.lift,
          noiseFilteringRate: aggregate.noiseFilteringRate,
          perDocument,
        };
      }

      return {
        ...common,
        ...buildRankingEntry(replay),
      };
    });
  const skippedCases = corpus.cases
    .filter((corpusCase) => corpusCase.shouldAbstain === true)
    .map((corpusCase) => ({
      id: corpusCase.id,
      reason: "abstain_case",
    }));
  const aggregate = buildAggregate(cases);

  return {
    summary: {
      runId,
      createdAt,
      corpus: {
        path: corpusPath,
        cases: corpus.cases.length,
      },
      config: {
        ...rankingConfig,
      },
      caseCount: cases.length,
      metrics: {
        baseline: aggregate.baselineMetrics,
        reranked: aggregate.rerankedMetrics,
        lift: aggregate.lift,
        noiseFilteringRate: aggregate.noiseFilteringRate,
        averageCandidateCount: aggregate.averageCandidateCount,
      },
      status: "pass",
    },
    skippedCases,
    cases,
  };
};

const PASSING_RECOVERY = Object.freeze({
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
});

const buildRawMetrics = (cases) => {
  const checks = cases.flatMap((caseResult) => caseResult.checks ?? []);
  const passedCaseCount = cases.filter((caseResult) => caseResult.passed).length;
  const passedCheckCount = checks.filter((check) => check.passed).length;

  return {
    caseCount: cases.length,
    checkCount: checks.length,
    failedCaseCount: cases.length - passedCaseCount,
    failedCheckCount: checks.length - passedCheckCount,
    passedCaseCount,
    passedCheckCount,
    overallPassRate: cases.length > 0 ? passedCaseCount / cases.length : null,
    checkPassRate: checks.length > 0 ? passedCheckCount / checks.length : null,
  };
};

export const buildPassingCheckSuiteReport = ({
  createdAt,
  provider,
  runId,
  specId,
} = {}) => {
  const manifest = CURRENT_QUALITY_SUITE_MANIFEST[specId];

  if (!manifest || manifest.kind !== "checks") {
    throw new Error(`Unknown check-suite manifest: ${specId}`);
  }

  const recovery = specId === "recovery"
    ? structuredClone(PASSING_RECOVERY)
    : undefined;
  const cases = specId === "recovery"
    ? buildRecoveryObservabilityCases({ recovery })
    : Object.entries(manifest.checksByCase).map(([id, checkIds]) => ({
        id,
        passed: true,
        failedCheckCount: 0,
        checks: checkIds.map((checkId) => ({
          id: checkId,
          passed: true,
        })),
        response: structuredClone(manifest.responseProjectionByCase[id]),
      }));

  return {
    summary: {
      createdAt,
      provider,
      runId,
      status: "pass",
      version: "1.0.0",
      metrics: buildRawMetrics(cases),
    },
    cases,
    ...(recovery ? { recovery } : {}),
  };
};

export const buildPassingRuntimeSmokeReport = ({ createdAt, runId } = {}) => ({
  completedAt: createdAt,
  runId,
  status: "pass",
  version: "1.0.0",
  checks: {
    longMemory: {
      healthReason: "postgres_configured_default",
      healthStatus: "ok",
    },
    agentExperienceMemory: {
      healthReason: "postgres_configured_default",
      healthStatus: "ok",
      writeStatus: "stored",
      secondRunHintCount: 1,
    },
    planners: {
      executionPlanner: "llm",
      executionPlannerStatus: "selected",
      intentPlanner: "llm",
      intentPlannerStatus: "selected",
    },
    sources: {
      sourceDocIds: ["runtime-smoke-contract"],
      firstRunSourceCount: 1,
      secondRunSourceCount: 1,
    },
  },
  runtime: {
    ragCallCount: 2,
    userId: "runtime-smoke-user",
  },
});

export const buildPassingRolloutReadinessReport = ({
  createdAt,
  reports,
  runId,
} = {}) =>
  buildRolloutReadinessReport({
    createdAt,
    runId,
    mockPlannerPayload: reports["planner-mock"],
    realPlannerPayload: reports["planner-real"],
    trajectoryPayload: reports.trajectory,
    recoveryPayload: reports["recovery-observability"],
    runtimeSmokePayload: reports["runtime-smoke"],
    plannerRuntime: {
      executionPlanner: "llm",
      intentPlanner: "llm",
      plannerRollout: "llm",
      effectiveExecutionPlanner: "llm",
      effectiveIntentPlanner: "llm",
    },
  });
