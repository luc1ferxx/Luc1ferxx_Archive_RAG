export const analyzeComparison = ({ alignment }) => {
  const evidenceCounts = alignment.perDocument.map((entry) => entry.results.length);
  const maxEvidenceCount = evidenceCounts.length > 0 ? Math.max(...evidenceCounts) : 0;
  const minEvidenceCount = evidenceCounts.length > 0 ? Math.min(...evidenceCounts) : 0;

  return {
    sharedTerms: alignment.sharedTerms,
    missingDocuments: alignment.missingDocuments,
    evidenceBalance:
      maxEvidenceCount - minEvidenceCount > 1 ? "skewed" : "balanced",
    perDocumentSummary: alignment.perDocument.map((entry) => ({
      docId: entry.docId,
      fileName: entry.fileName,
      evidenceCount: entry.results.length,
      topScore: Number(entry.topScore.toFixed(4)),
      focusTerms: entry.focusTerms,
    })),
  };
};
