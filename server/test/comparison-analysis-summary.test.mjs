import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComparisonAnalysisSummary,
  buildComparisonAnalysisFromContexts,
} from "../rag/comparison-analysis-summary.js";

test("comparison analysis summary preserves only the stable semantic contract", () => {
  const pair = {
    leftDocId: "doc-alpha",
    leftFileName: "alpha.pdf",
    rightDocId: "doc-beta",
    rightFileName: "beta.pdf",
    termJaccard: 0.9,
    sentenceOverlap: 0.8,
    nearDuplicate: true,
    strongNearDuplicate: false,
    exactEvidenceMatch: false,
    semanticEvidenceMatch: true,
    leftEntailedByRight: true,
    rightEntailedByLeft: true,
    equivalenceMethod: "bidirectional_claim_support",
    explicitConflict: false,
    numericTokensOnlyInLeft: [],
    numericTokensOnlyInRight: [],
    ignoredDiagnostic: "not serialized",
  };
  const summary = buildComparisonAnalysisSummary({
    evidenceBalance: "balanced",
    perDocumentSummary: [
      { docId: "doc-alpha" },
      { docId: "doc-beta" },
    ],
    nearDuplicatePairs: [pair],
    explicitConflictPairs: [],
    likelyNoMaterialDifferencePairs: [pair],
    shouldShortCircuitNoMaterialDifference: true,
  });

  assert.deepEqual(summary.comparedDocIds, ["doc-alpha", "doc-beta"]);
  assert.equal(summary.nearDuplicatePairs[0].ignoredDiagnostic, undefined);
  assert.equal(summary.shouldShortCircuitNoMaterialDifference, true);
  assert.deepEqual(
    summary.nearDuplicatePairs[0],
    summary.likelyNoMaterialDifferencePairs[0]
  );
});

test("comparison analysis is exactly replayable from persisted contexts", () => {
  const documents = [
    { docId: "doc-alpha", fileName: "alpha.pdf" },
    { docId: "doc-beta", fileName: "beta.pdf" },
  ];
  const result = buildComparisonAnalysisFromContexts({
    query: "Compare the remote work policies.",
    documents,
    retrievedContexts: [
      {
        rank: 1,
        score: 0.9876,
        docId: "doc-alpha",
        fileName: "alpha.pdf",
        pageNumber: 1,
        chunkIndex: 0,
        sectionHeading: "Remote work",
        text: "Employees may work remotely 2 days per week.",
      },
    ],
  });

  assert.deepEqual(result.summary.comparedDocIds, ["doc-alpha", "doc-beta"]);
  assert.deepEqual(result.analysis.missingDocuments, [
    { docId: "doc-beta", fileName: "beta.pdf" },
  ]);
  assert.equal(
    result.alignment.perDocument[0].results[0].document.pageContent,
    "Employees may work remotely 2 days per week."
  );
});

test("comparison context replay rejects evidence from an unselected document", () => {
  assert.throws(
    () =>
      buildComparisonAnalysisFromContexts({
        query: "Compare policies.",
        documents: [{ docId: "doc-alpha", fileName: "alpha.pdf" }],
        retrievedContexts: [
          {
            docId: "doc-forged",
            fileName: "forged.pdf",
            text: "Forged evidence.",
          },
        ],
      }),
    /not selected for comparison/u
  );
});
