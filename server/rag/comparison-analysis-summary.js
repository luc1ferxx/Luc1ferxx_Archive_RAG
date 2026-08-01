import { analyzeComparison } from "./comparison-engine.js";
import { alignComparisonEvidence } from "./evidence-aligner.js";

const buildComparisonPairSummary = (pair = {}) => ({
  leftDocId: pair.leftDocId ?? null,
  leftFileName: pair.leftFileName ?? null,
  rightDocId: pair.rightDocId ?? null,
  rightFileName: pair.rightFileName ?? null,
  termJaccard: pair.termJaccard ?? null,
  sentenceOverlap: pair.sentenceOverlap ?? null,
  nearDuplicate: Boolean(pair.nearDuplicate),
  strongNearDuplicate: Boolean(pair.strongNearDuplicate),
  exactEvidenceMatch: Boolean(pair.exactEvidenceMatch),
  semanticEvidenceMatch: Boolean(pair.semanticEvidenceMatch),
  leftEntailedByRight: Boolean(pair.leftEntailedByRight),
  rightEntailedByLeft: Boolean(pair.rightEntailedByLeft),
  equivalenceMethod: pair.equivalenceMethod ?? "none",
  explicitConflict: Boolean(pair.explicitConflict),
  numericTokensOnlyInLeft: pair.numericTokensOnlyInLeft ?? [],
  numericTokensOnlyInRight: pair.numericTokensOnlyInRight ?? [],
});

export const buildComparisonAnalysisSummary = (analysis = {}) => ({
  comparedDocIds: (analysis.perDocumentSummary ?? [])
    .map((entry) => entry.docId)
    .filter(Boolean),
  evidenceBalance: analysis.evidenceBalance ?? null,
  nearDuplicatePairs: (analysis.nearDuplicatePairs ?? []).map(
    buildComparisonPairSummary
  ),
  explicitConflictPairs: (analysis.explicitConflictPairs ?? []).map(
    buildComparisonPairSummary
  ),
  likelyNoMaterialDifferencePairs: (
    analysis.likelyNoMaterialDifferencePairs ?? []
  ).map(buildComparisonPairSummary),
  shouldShortCircuitNoMaterialDifference: Boolean(
    analysis.shouldShortCircuitNoMaterialDifference
  ),
});

export const buildComparisonAnalysisFromEvidence = ({
  documents = [],
  perDocumentResults = new Map(),
  query = "",
} = {}) => {
  const alignment = alignComparisonEvidence({
    query,
    documents,
    perDocumentResults,
  });
  const analysis = analyzeComparison({ alignment });

  return {
    alignment,
    analysis,
    summary: buildComparisonAnalysisSummary(analysis),
  };
};

export const buildComparisonAnalysisFromContexts = ({
  documents = [],
  query = "",
  retrievedContexts = [],
} = {}) => {
  const perDocumentResults = new Map();

  for (const document of documents) {
    const docId = String(document?.docId ?? "").trim();

    if (!docId) {
      throw new Error("comparison document id is required");
    }
    if (perDocumentResults.has(docId)) {
      throw new Error(`comparison document id is duplicated: ${docId}`);
    }

    perDocumentResults.set(docId, []);
  }

  for (const context of retrievedContexts) {
    const docId = String(context?.docId ?? "").trim();
    const results = perDocumentResults.get(docId);

    if (!results) {
      throw new Error(
        `comparison context document is not selected for comparison: ${docId || "unknown"}`
      );
    }

    const numericScore = Number(context?.score);
    results.push({
      score: Number.isFinite(numericScore) ? numericScore : 0,
      document: {
        pageContent: String(context?.text ?? ""),
        metadata: {
          docId,
          fileName: context?.fileName ?? "Unknown document",
          pageNumber: context?.pageNumber ?? null,
          chunkIndex: context?.chunkIndex ?? null,
          sectionHeading: context?.sectionHeading ?? null,
        },
      },
    });
  }

  return buildComparisonAnalysisFromEvidence({
    query,
    documents,
    perDocumentResults,
  });
};
