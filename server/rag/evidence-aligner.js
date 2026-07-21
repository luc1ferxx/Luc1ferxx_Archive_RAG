import { buildTermSet, extractTerms, normalizeWhitespace } from "./text-utils.js";

const SENTENCE_BOUNDARY = /(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/;
const NUMBER_TOKEN_PATTERN = /\$?\d[\d,./-]*%?/g;

const normalizeNumericToken = (value = "") => {
  const candidate = value.toLowerCase().replace(/[.,]+$/u, "");
  const decimalMatch = candidate.match(/^(\$?)(\d[\d,]*)(?:\.(\d+))?(%?)$/u);

  if (!decimalMatch) {
    return candidate;
  }

  const integerPart = decimalMatch[2]
    .replace(/,/g, "")
    .replace(/^0+(?=\d)/u, "");
  const fractionalPart = (decimalMatch[3] ?? "").replace(/0+$/u, "");

  return `${decimalMatch[1]}${integerPart}${
    fractionalPart ? `.${fractionalPart}` : ""
  }${decimalMatch[4]}`;
};

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
      normalizeNumericToken(token)
    )
  );

const buildNumericBindingsBySentence = (text = "") => {
  const bindingsBySentence = new Map();

  for (const sentence of normalizeWhitespace(text).split(SENTENCE_BOUNDARY)) {
    const numericTokens = [];
    const canonicalSentence = sentence
      .toLowerCase()
      .replace(NUMBER_TOKEN_PATTERN, (token) => {
        numericTokens.push(normalizeNumericToken(token));
        return "<num>";
      })
      .replace(/\s+/g, " ")
      .trim();

    if (!canonicalSentence || numericTokens.length === 0) {
      continue;
    }

    if (!bindingsBySentence.has(canonicalSentence)) {
      bindingsBySentence.set(canonicalSentence, new Set());
    }

    bindingsBySentence.get(canonicalSentence).add(JSON.stringify(numericTokens));
  }

  return bindingsBySentence;
};

export const alignComparisonEvidence = ({
  query,
  documents,
  perDocumentResults,
}) => {
  const queryTerms = extractTerms(query, { limit: 8 }).map((term) => term.value);

  const perDocument = documents.map((document) => {
    const results = perDocumentResults.get(document.docId) ?? [];
    const evidenceText = results.map((result) => result.document.pageContent).join("\n\n");
    const hasComparableEvidence = Boolean(normalizeWhitespace(evidenceText));
    const termSet = buildTermSet(evidenceText);

    return {
      docId: document.docId,
      fileName: document.fileName,
      document,
      results,
      evidenceText,
      hasComparableEvidence,
      termSet,
      canonicalSentenceSet: buildCanonicalSentenceSet(evidenceText),
      numericBindingsBySentence: buildNumericBindingsBySentence(evidenceText),
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
      .filter((entry) => !entry.hasComparableEvidence)
      .map((entry) => ({
        docId: entry.docId,
        fileName: entry.fileName,
      })),
  };
};
