import { buildTermSet, extractTerms } from "./text-utils.js";

export const alignComparisonEvidence = ({
  query,
  documents,
  perDocumentResults,
}) => {
  const queryTerms = extractTerms(query, { limit: 8 }).map((term) => term.value);

  const perDocument = documents.map((document) => {
    const results = perDocumentResults.get(document.docId) ?? [];
    const evidenceText = results.map((result) => result.document.pageContent).join("\n\n");
    const termSet = buildTermSet(evidenceText);

    return {
      docId: document.docId,
      fileName: document.fileName,
      document,
      results,
      termSet,
      focusTerms: extractTerms(evidenceText, { limit: 5 }).map((term) => term.value),
      topScore: results[0]?.score ?? 0,
    };
  });

  const sharedTerms = queryTerms.filter((term) => {
    const matches = perDocument.filter((entry) => entry.termSet.has(term));
    return matches.length > 1;
  });

  return {
    perDocument,
    sharedTerms,
    missingDocuments: perDocument
      .filter((entry) => entry.results.length === 0)
      .map((entry) => ({
        docId: entry.docId,
        fileName: entry.fileName,
      })),
  };
};
