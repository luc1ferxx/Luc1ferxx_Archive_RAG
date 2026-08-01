import test from "node:test";
import assert from "node:assert/strict";

import {
  validateRerankCaseRanking,
  validateRerankReportRankings,
} from "../evaluation/rerank-report-ranking-validation.js";
import {
  replayRerankCaseRankings,
} from "../evaluation/rerank-report-replay.js";
import {
  getRobustEvalSuiteReport,
} from "../evaluation/eval-suite.js";
import {
  buildPassingRobustRerankReport,
  readEvaluationCorpus,
} from "./fixtures/release-evidence-report-fixtures.mjs";

const buildGlobalCase = ({ id = "global-ranking" } = {}) => ({
  id,
  docKeys: ["noise", "alpha", "beta"],
  retrievalMode: "global",
  k: 2,
  candidateCount: 3,
  expectedUnits: [
    { key: "alpha:1", docKey: "alpha", pageNumber: 1 },
    { key: "beta:2", docKey: "beta", pageNumber: 2 },
  ],
  candidateRanking: [
    {
      rank: 1,
      resultKey: "noise:1",
      docKey: "noise",
      fileName: "noise.pdf",
      pageNumber: 1,
      chunkIndex: 0,
      text: "Noise policy.",
    },
    {
      rank: 2,
      resultKey: "alpha:1",
      docKey: "alpha",
      fileName: "alpha.pdf",
      pageNumber: 1,
      chunkIndex: 0,
      text: "Alpha evidence.",
    },
    {
      rank: 3,
      resultKey: "beta:2",
      docKey: "beta",
      fileName: "beta.pdf",
      pageNumber: 2,
      chunkIndex: 1,
      text: "Beta page two evidence.",
    },
  ],
  baselineRanking: [
    {
      rank: 1,
      resultKey: "noise:1",
      docKey: "noise",
      fileName: "noise.pdf",
      pageNumber: 1,
      chunkIndex: 0,
    },
    {
      rank: 2,
      resultKey: "alpha:1",
      docKey: "alpha",
      fileName: "alpha.pdf",
      pageNumber: 1,
      chunkIndex: 0,
    },
  ],
  rerankedRanking: [
    {
      rank: 1,
      resultKey: "alpha:1",
      docKey: "alpha",
      fileName: "alpha.pdf",
      pageNumber: 1,
      chunkIndex: 0,
    },
    {
      rank: 2,
      resultKey: "beta:2",
      docKey: "beta",
      fileName: "beta.pdf",
      pageNumber: 2,
      chunkIndex: 1,
    },
  ],
  baselineMetrics: {
    ndcgAtK: 0.3869,
    precisionAtK: 0.5,
    recallAtK: 0.5,
    mrr: 0.5,
    noiseRateAtK: 0.5,
    relevantCountAtK: 1,
    noiseCountAtK: 1,
    expectedRelevantCount: 2,
    evaluatedCountAtK: 2,
  },
  rerankedMetrics: {
    ndcgAtK: 1,
    precisionAtK: 1,
    recallAtK: 1,
    mrr: 1,
    noiseRateAtK: 0,
    relevantCountAtK: 2,
    noiseCountAtK: 0,
    expectedRelevantCount: 2,
    evaluatedCountAtK: 2,
  },
  lift: {
    ndcgAtK: { absolute: 0.6131, relative: 1.5846 },
    precisionAtK: { absolute: 0.5, relative: 1 },
    recallAtK: { absolute: 0.5, relative: 1 },
    mrr: { absolute: 0.5, relative: 1 },
    noiseRateAtK: { absoluteReduction: 0.5, relativeReduction: 1 },
  },
  noiseFilteringRate: 1,
});

const zeroRankingMetrics = {
  ndcgAtK: 0,
  precisionAtK: 0,
  recallAtK: 0,
  mrr: 0,
  noiseRateAtK: 1,
  relevantCountAtK: 0,
  noiseCountAtK: 1,
  expectedRelevantCount: 1,
  evaluatedCountAtK: 1,
};

const perfectRankingMetrics = {
  ndcgAtK: 1,
  precisionAtK: 1,
  recallAtK: 1,
  mrr: 1,
  noiseRateAtK: 0,
  relevantCountAtK: 1,
  noiseCountAtK: 0,
  expectedRelevantCount: 1,
  evaluatedCountAtK: 1,
};

const buildPerDocumentCase = () => ({
  id: "per-document-ranking",
  docKeys: ["alpha", "beta"],
  retrievalMode: "per-document",
  k: 1,
  candidateCount: 3,
  expectedUnits: [
    { key: "alpha:1", docKey: "alpha", pageNumber: 1 },
    { key: "beta:2", docKey: "beta", pageNumber: 2 },
  ],
  perDocument: [
    {
      docKey: "alpha",
      k: 1,
      candidateCount: 2,
      expectedUnits: [
        { key: "alpha:1", docKey: "alpha", pageNumber: 1 },
      ],
      candidateRanking: [
        {
          rank: 1,
          resultKey: "alpha:noise",
          docKey: "alpha",
          pageNumber: 2,
          chunkIndex: 1,
        },
        {
          rank: 2,
          resultKey: "alpha:1",
          docKey: "alpha",
          pageNumber: 1,
          chunkIndex: 0,
        },
      ],
      baselineRanking: [
        {
          rank: 1,
          resultKey: "alpha:noise",
          docKey: "alpha",
          pageNumber: 2,
          chunkIndex: 1,
        },
      ],
      rerankedRanking: [
        {
          rank: 1,
          resultKey: "alpha:1",
          docKey: "alpha",
          pageNumber: 1,
          chunkIndex: 0,
        },
      ],
      baselineMetrics: zeroRankingMetrics,
      rerankedMetrics: perfectRankingMetrics,
      lift: {
        ndcgAtK: { absolute: 1, relative: null },
        precisionAtK: { absolute: 1, relative: null },
        recallAtK: { absolute: 1, relative: null },
        mrr: { absolute: 1, relative: null },
        noiseRateAtK: { absoluteReduction: 1, relativeReduction: 1 },
      },
      noiseFilteringRate: 1,
    },
    {
      docKey: "beta",
      k: 1,
      candidateCount: 1,
      expectedUnits: [
        { key: "beta:2", docKey: "beta", pageNumber: 2 },
      ],
      candidateRanking: [
        {
          rank: 1,
          resultKey: "beta:2",
          docKey: "beta",
          pageNumber: 2,
          chunkIndex: 0,
        },
      ],
      baselineRanking: [
        {
          rank: 1,
          resultKey: "beta:2",
          docKey: "beta",
          pageNumber: 2,
          chunkIndex: 0,
        },
      ],
      rerankedRanking: [
        {
          rank: 1,
          resultKey: "beta:2",
          docKey: "beta",
          pageNumber: 2,
          chunkIndex: 0,
        },
      ],
      baselineMetrics: perfectRankingMetrics,
      rerankedMetrics: perfectRankingMetrics,
      lift: {
        ndcgAtK: { absolute: 0, relative: 0 },
        precisionAtK: { absolute: 0, relative: 0 },
        recallAtK: { absolute: 0, relative: 0 },
        mrr: { absolute: 0, relative: 0 },
        noiseRateAtK: { absoluteReduction: 0, relativeReduction: null },
      },
      noiseFilteringRate: null,
    },
  ],
  baselineMetrics: {
    ndcgAtK: 0.5,
    precisionAtK: 0.5,
    recallAtK: 0.5,
    mrr: 0.5,
    noiseRateAtK: 0.5,
    relevantCountAtK: 0.5,
    noiseCountAtK: 0.5,
    expectedRelevantCount: 1,
    evaluatedCountAtK: 1,
  },
  rerankedMetrics: perfectRankingMetrics,
  lift: {
    ndcgAtK: { absolute: 0.5, relative: 1 },
    precisionAtK: { absolute: 0.5, relative: 1 },
    recallAtK: { absolute: 0.5, relative: 1 },
    mrr: { absolute: 0.5, relative: 1 },
    noiseRateAtK: { absoluteReduction: 0.5, relativeReduction: 1 },
  },
  noiseFilteringRate: 1,
});

test("ranking validator independently recomputes global metrics and rejects a forged report", () => {
  const validResult = validateRerankCaseRanking(buildGlobalCase());

  assert.equal(validResult.status, "pass");
  assert.equal(validResult.recomputed.baselineMetrics.ndcgAtK, 0.3869);
  assert.equal(validResult.recomputed.rerankedMetrics.recallAtK, 1);
  assert.equal(validResult.recomputed.noiseFilteringRate, 1);

  const forgedCase = buildGlobalCase();
  forgedCase.baselineMetrics.ndcgAtK = 1;
  const forgedResult = validateRerankCaseRanking(forgedCase);

  assert.equal(forgedResult.status, "fail");
  assert.ok(
    forgedResult.issues.some(
      (issue) =>
        issue.reasonCode === "reported_ranking_metric_mismatch" &&
        issue.path === "baselineMetrics.ndcgAtK"
    )
  );
  assert.equal(forgedResult.recomputed.baselineMetrics.ndcgAtK, 0.3869);
});

test("ranking validator recomputes and validates per-document averages", () => {
  const result = validateRerankCaseRanking(buildPerDocumentCase());

  assert.equal(result.status, "pass");
  assert.equal(result.recomputed.baselineMetrics.ndcgAtK, 0.5);
  assert.equal(result.recomputed.rerankedMetrics.ndcgAtK, 1);
  assert.equal(result.recomputed.lift.ndcgAtK.absolute, 0.5);
  assert.equal(result.recomputed.noiseFilteringRate, 1);
});

test("ranking validator fails closed on missing evidence, missing rankings, duplicates, and invalid ranks", () => {
  const cases = [
    {
      reasonCode: "expected_units_missing",
      mutate: (caseResult) => {
        delete caseResult.expectedUnits;
      },
    },
    {
      reasonCode: "ranking_missing",
      mutate: (caseResult) => {
        delete caseResult.baselineRanking;
      },
    },
    {
      reasonCode: "ranking_result_duplicate",
      mutate: (caseResult) => {
        caseResult.baselineRanking[1].resultKey =
          caseResult.baselineRanking[0].resultKey;
      },
    },
    {
      reasonCode: "ranking_rank_invalid",
      mutate: (caseResult) => {
        caseResult.rerankedRanking[1].rank = 1;
      },
    },
  ];

  for (const scenario of cases) {
    const caseResult = buildGlobalCase();
    scenario.mutate(caseResult);
    const result = validateRerankCaseRanking(caseResult);

    assert.equal(result.status, "fail");
    assert.ok(
      result.issues.some(
        (issue) => issue.reasonCode === scenario.reasonCode
      ),
      scenario.reasonCode
    );
    assert.equal(result.recomputed, null);
  }
});

test("ranking validator rejects a reranked result that was not in the candidate pool", () => {
  const caseResult = buildGlobalCase();
  caseResult.candidateRanking = caseResult.candidateRanking.slice(0, 2);
  caseResult.candidateCount = 2;

  const result = validateRerankCaseRanking(caseResult);

  assert.equal(result.status, "fail");
  assert.ok(
    result.issues.some(
      (issue) => issue.reasonCode === "reranked_candidate_missing"
    )
  );
});

test("ranking validator binds candidate text to the configured corpus page", () => {
  const caseResult = buildGlobalCase();
  caseResult.candidateRanking[1].text = "Forged policy text.";
  const result = validateRerankCaseRanking(caseResult, {
    caseContract: {
      id: caseResult.id,
      type: "qa",
      docKeys: caseResult.docKeys,
      expectedEvidence: [
        { docKey: "alpha", pages: [1] },
        { docKey: "beta", pages: [2] },
      ],
    },
    documentContracts: [
      { key: "noise", fileName: "noise.pdf", pages: ["Noise policy."] },
      { key: "alpha", fileName: "alpha.pdf", pages: ["Alpha evidence."] },
      {
        key: "beta",
        fileName: "beta.pdf",
        pages: ["Beta page one.", "Beta page two evidence."],
      },
    ],
  });

  assert.equal(result.status, "fail");
  assert.ok(
    result.issues.some(
      (issue) => issue.reasonCode === "candidate_corpus_source_mismatch"
    )
  );
});

test("ranking validator rejects a corpus substring presented as a complete candidate", () => {
  const payload = buildGlobalCase();

  payload.candidateRanking[0].text = ".";

  const result = validateRerankCaseRanking(payload, {
    caseContract: {
      id: payload.id,
      type: "qa",
      docKeys: payload.docKeys,
      expectedEvidence: [
        { docKey: "alpha", pages: [1] },
        { docKey: "beta", pages: [2] },
      ],
    },
    documentContracts: [
      { key: "noise", fileName: "noise.pdf", pages: ["Noise policy."] },
      { key: "alpha", fileName: "alpha.pdf", pages: ["Alpha evidence."] },
      {
        key: "beta",
        fileName: "beta.pdf",
        pages: ["Beta page one.", "Beta page two evidence."],
      },
    ],
  });

  assert.equal(result.status, "fail");
  assert.ok(
    result.issues.some(
      (issue) => issue.reasonCode === "candidate_corpus_source_mismatch"
    )
  );
});

test("report ranking validation fails closed without checked corpus contracts", () => {
  const payload = {
    cases: [buildGlobalCase()],
  };
  const result = validateRerankReportRankings(payload);

  assert.equal(result.status, "fail");
  assert.ok(
    result.issues.some(
      (issue) => issue.reasonCode === "ranking_case_contracts_missing"
    )
  );
});

const replayConfig = Object.freeze({
  chunkStrategy: "structured",
  chunkSize: 900,
  chunkOverlap: 180,
  vectorStoreProvider: "local",
  hybridEnabled: false,
  retrievalScoringMode: "combined",
  vectorWeight: 0.82,
  keywordWeight: 0.18,
  topK: 2,
  topKPerDoc: 1,
  candidateMultiplier: 2,
  embeddingProvider: "deterministic",
  rerankProvider: "heuristic",
  rerankWeight: 0.6,
});

const replayDocumentContracts = [
  { key: "noise", fileName: "noise.pdf", pages: ["Noise policy."] },
  { key: "alpha", fileName: "alpha.pdf", pages: ["Alpha evidence."] },
  {
    key: "beta",
    fileName: "beta.pdf",
    pages: ["Beta page one.", "Beta page two evidence."],
  },
];

const buildReplayBackedGlobalCase = ({ id }) => {
  const caseContract = {
    id,
    type: "qa",
    question: "Which alpha and beta evidence is relevant?",
    docKeys: ["noise", "alpha", "beta"],
    expectedEvidence: [
      { docKey: "alpha", pages: [1] },
      { docKey: "beta", pages: [2] },
    ],
  };
  const caseResult = {
    id,
    type: caseContract.type,
    question: caseContract.question,
    docKeys: caseContract.docKeys,
    ...replayRerankCaseRankings({
      caseContract,
      config: replayConfig,
      documentContracts: replayDocumentContracts,
    }),
  };
  const recomputed = validateRerankCaseRanking(caseResult).recomputed;

  return {
    caseContract,
    caseResult: {
      ...caseResult,
      baselineMetrics: recomputed.baselineMetrics,
      rerankedMetrics: recomputed.rerankedMetrics,
      lift: recomputed.lift,
      noiseFilteringRate: recomputed.noiseFilteringRate,
    },
  };
};

test("payload aggregation exposes only independently replayed and recomputed case values", () => {
  const expectedConfig = replayConfig;
  const first = buildReplayBackedGlobalCase({ id: "global-one" });
  const second = buildReplayBackedGlobalCase({ id: "global-two" });
  const payload = {
    summary: {
      config: expectedConfig,
      metrics: {
        baseline: { ndcgAtK: -1 },
        reranked: { ndcgAtK: -1 },
      },
    },
    cases: [first.caseResult, second.caseResult],
  };
  const caseContracts = [first.caseContract, second.caseContract];
  const documentContracts = replayDocumentContracts;
  const result = validateRerankReportRankings(payload, {
    caseContracts,
    documentContracts,
    expectedConfig,
  });

  assert.equal(result.status, "pass");
  assert.equal(
    result.metrics.baseline.ndcgAtK,
    first.caseResult.baselineMetrics.ndcgAtK
  );
  assert.equal(
    result.metrics.reranked.ndcgAtK,
    first.caseResult.rerankedMetrics.ndcgAtK
  );
  assert.notEqual(
    result.metrics.baseline.ndcgAtK,
    payload.summary.metrics.baseline.ndcgAtK
  );

  payload.cases[1].id = payload.cases[0].id;
  const duplicateResult = validateRerankReportRankings(payload, {
    caseContracts,
    documentContracts,
    expectedConfig,
  });

  assert.equal(duplicateResult.status, "fail");
  assert.ok(
    duplicateResult.issues.some(
      (issue) => issue.reasonCode === "report_case_id_duplicate"
    )
  );
});

test("report replay rejects hand-reordered legal chunks and a forged positive lift", () => {
  const fixture = buildReplayBackedGlobalCase({ id: "forged-order" });
  const forgedCase = structuredClone(fixture.caseResult);

  forgedCase.candidateRanking.reverse();
  forgedCase.candidateRanking.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  forgedCase.baselineRanking = forgedCase.candidateRanking
    .slice(0, forgedCase.k)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  forgedCase.rerankedRanking = forgedCase.baselineRanking
    .map((entry) => ({ ...entry }))
    .reverse();
  forgedCase.rerankedRanking.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const locallyRecomputed = validateRerankCaseRanking(forgedCase).recomputed;

  forgedCase.baselineMetrics = locallyRecomputed.baselineMetrics;
  forgedCase.rerankedMetrics = locallyRecomputed.rerankedMetrics;
  forgedCase.lift = locallyRecomputed.lift;
  forgedCase.noiseFilteringRate = locallyRecomputed.noiseFilteringRate;

  const result = validateRerankReportRankings(
    {
      summary: { config: replayConfig },
      cases: [forgedCase],
    },
    {
      caseContracts: [fixture.caseContract],
      documentContracts: replayDocumentContracts,
      expectedConfig: replayConfig,
    }
  );

  assert.equal(result.status, "fail");
  assert.ok(
    result.issues.some(
      (issue) => issue.reasonCode === "candidate_replay_mismatch"
    )
  );
});

test("hard-CS replay mirrors producer partition skips and still rejects reordered chunks", () => {
  const reportSpec = getRobustEvalSuiteReport("rerank-hard-cs");
  const corpus = readEvaluationCorpus(reportSpec.corpusPath);
  const expectedConfig = {
    ...reportSpec.rankingConfig,
    rerankProvider: reportSpec.rerankProvider,
    rerankWeight: reportSpec.rerankWeight,
  };
  const report = buildPassingRobustRerankReport({
    corpusPath: reportSpec.corpusPath,
    createdAt: "2026-08-01T00:00:00.000Z",
    reportId: reportSpec.id,
    runId: "hard-cs-producer-parity",
  });
  const singleEvidencePartitionCase = {
    ...corpus.cases.find(
      (caseContract) => caseContract.id === "compare_retrieval_noise_controls"
    ),
    shouldAbstain: false,
  };
  const singleEvidencePartitionReplay = replayRerankCaseRankings({
    caseContract: singleEvidencePartitionCase,
    config: expectedConfig,
    documentContracts: corpus.documents,
  });

  assert.deepEqual(
    singleEvidencePartitionReplay.perDocument.map((entry) => entry.docKey),
    ["retrieval_router_paper"]
  );

  const valid = validateRerankReportRankings(report, {
    caseContracts: corpus.cases,
    documentContracts: corpus.documents,
    expectedConfig,
  });

  assert.equal(valid.status, "pass", JSON.stringify(valid.issues, null, 2));

  const forged = structuredClone(report);
  const forgedPartition = forged.cases.find(
    (caseResult) => caseResult.id === "compare_hnsw_tombstone_compaction_policy"
  ).perDocument[0];

  forgedPartition.candidateRanking.reverse();
  forgedPartition.candidateRanking.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  forgedPartition.baselineRanking = forgedPartition.candidateRanking
    .slice(0, forgedPartition.k)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  const reordered = validateRerankReportRankings(forged, {
    caseContracts: corpus.cases,
    documentContracts: corpus.documents,
    expectedConfig,
  });

  assert.equal(reordered.status, "fail");
  assert.ok(
    reordered.issues.some(
      (issue) =>
        issue.caseId === "compare_hnsw_tombstone_compaction_policy" &&
        issue.reasonCode === "candidate_replay_mismatch"
    )
  );
});

test("report replay fails closed when the authoritative config is unsupported", () => {
  const fixture = buildReplayBackedGlobalCase({ id: "unsupported-config" });
  const unsupportedConfig = {
    ...replayConfig,
    hybridEnabled: true,
  };
  const result = validateRerankReportRankings(
    {
      summary: { config: unsupportedConfig },
      cases: [fixture.caseResult],
    },
    {
      caseContracts: [fixture.caseContract],
      documentContracts: replayDocumentContracts,
      expectedConfig: unsupportedConfig,
    }
  );

  assert.equal(result.status, "fail");
  assert.ok(
    result.issues.some(
      (issue) => issue.reasonCode === "ranking_replay_config_unsupported"
    )
  );
});
