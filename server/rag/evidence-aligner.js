import { buildTermSet, extractTerms, normalizeWhitespace } from "./text-utils.js";

const SENTENCE_BOUNDARY = /(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/;
const NUMBER_TOKEN_PATTERN = /\$?\d[\d,./-]*%?/g;

const buildCanonicalSentenceSet = (text = "") =>
  new Set(
    normalizeWhitespace(text)
      .split(SENTENCE_BOUNDARY)
      .map((sentence) =>
        sentence
          .toLowerCase()
          .replace(NUMBER_TOKEN_PATTERN, "<num>")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(Boolean)
  );

const buildNumericTokenSet = (text = "") =>
  new Set(
    (normalizeWhitespace(text).match(NUMBER_TOKEN_PATTERN) ?? []).map((token) =>
      token.toLowerCase()
    )
  );

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
      evidenceText,
      termSet,
      canonicalSentenceSet: buildCanonicalSentenceSet(evidenceText),
      numericTokenSet: buildNumericTokenSet(evidenceText),
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
