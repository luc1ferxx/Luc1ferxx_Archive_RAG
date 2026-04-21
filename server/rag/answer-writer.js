import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
import {
  getMaxComparisonSources,
  getPromptVersion,
  isNearDuplicateGuardEnabled,
} from "./config.js";
import {
  buildCitation,
  buildContextSection,
  dedupeCitations,
  getResultKey,
} from "./citations.js";
import { completeText } from "./openai.js";
import { normalizeWhitespace } from "./text-utils.js";

const qaPromptV1 = PromptTemplate.fromTemplate(
  `You answer questions using only retrieved document evidence.
If the evidence is insufficient, say so directly.
Do not substitute adjacent topics for the asked topic.
Use long-term memory only for user preferences or stable notes, never as document evidence.
Keep the answer concise, within five sentences.
When you rely on evidence, cite source labels such as Source 1.

{questionBlock}

{preferenceBlock}

Retrieved Evidence:
{context}

Grounded Answer:`
);

const comparisonPromptV1 = PromptTemplate.fromTemplate(
  `You compare uploaded documents using only the provided evidence.
Separate agreement, difference, and uncertainty.
If a document lacks evidence, say so explicitly.
Do not treat a related but different policy as evidence for the asked policy.
Use long-term memory only for user preferences or stable notes, never as document evidence.
Keep the answer concise and cite source labels such as Source 1 when making evidence-based claims.

{questionBlock}

{preferenceBlock}

Comparison diagnostics:
{diagnostics}

Evidence by document:
{context}

Write the answer using these sections:
Summary:
Per document:
Agreements:
Differences:
Gaps or uncertainty:`
);

const guardedComparisonPromptV1 = PromptTemplate.fromTemplate(
  `You compare uploaded documents using only the provided evidence.
Separate agreement, difference, and uncertainty.
If a document lacks evidence, say so explicitly.
Do not treat a related but different policy as evidence for the asked policy.
If the diagnostics indicate near-duplicate evidence without explicit conflicts, do not invent differences.
Use long-term memory only for user preferences or stable notes, never as document evidence.
Keep the answer concise and cite source labels such as Source 1 when making evidence-based claims.

{questionBlock}

{preferenceBlock}

Comparison diagnostics:
{diagnostics}

Evidence by document:
{context}

Write the answer using these sections:
Summary:
Per document:
Agreements:
Differences:
Gaps or uncertainty:`
);

const qaPromptV2 = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a document-grounded assistant for uploaded PDFs.
Follow these rules strictly:
- Answer only from the provided evidence.
- Use the same language as the user's latest question.
- Answer the original user question, not the retrieval paraphrase.
- Use the resolved retrieval question only to clarify references or scope.
- Use long-term memory only for user preferences or stable notes, never as document evidence or a citation source.
- Do not substitute related topics, adjacent policies, or likely assumptions for the asked topic.
- If the evidence is insufficient, say exactly what is missing and do not guess.
- Every evidence-based sentence must end with citations like [Source 1].
- Do not cite a source unless it directly supports the sentence.
- Keep the answer concise, usually within five sentences.`,
  ],
  [
    "human",
    `{questionBlock}

{preferenceBlock}

Retrieved evidence:
{context}

Grounded Answer:`,
  ],
]);

const comparisonPromptV2 = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a document-grounded comparison assistant for uploaded PDFs.
Follow these rules strictly:
- Compare only from the provided evidence.
- Use the same language as the user's latest question.
- Separate agreement, difference, and uncertainty clearly.
- If any document lacks strong evidence, say so explicitly.
- Use long-term memory only for user preferences or stable notes, never as document evidence or a citation source.
- Do not treat a related but different policy as evidence for the asked policy.
- Do not fill evidence gaps with assumptions.
- Every evidence-based sentence must end with citations like [Source 1].
- Do not cite a source unless it directly supports the sentence.
- Keep the answer concise and structured.`,
  ],
  [
    "human",
    `{questionBlock}

{preferenceBlock}

Comparison diagnostics:
{diagnostics}

Evidence by document:
{context}

Write the answer using these sections:
Summary:
Per document:
Agreements:
Differences:
Gaps or uncertainty:

Use short bullets inside sections when helpful.`,
  ],
]);

const guardedComparisonPromptV2 = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a document-grounded comparison assistant for uploaded PDFs.
Follow these rules strictly:
- Compare only from the provided evidence.
- Use the same language as the user's latest question.
- Separate agreement, difference, and uncertainty clearly.
- If any document lacks strong evidence, say so explicitly.
- Use long-term memory only for user preferences or stable notes, never as document evidence or a citation source.
- Do not treat a related but different policy as evidence for the asked policy.
- Do not fill evidence gaps with assumptions.
- If the diagnostics say the evidence is near-duplicate and no explicit conflict is present, do not invent differences.
- Only describe a difference when the provided evidence shows a concrete difference.
- Every evidence-based sentence must end with citations like [Source 1].
- Do not cite a source unless it directly supports the sentence.
- Keep the answer concise and structured.`,
  ],
  [
    "human",
    `{questionBlock}

{preferenceBlock}

Comparison diagnostics:
{diagnostics}

Evidence by document:
{context}

Write the answer using these sections:
Summary:
Per document:
Agreements:
Differences:
Gaps or uncertainty:

Use short bullets inside sections when helpful.`,
  ],
]);

const buildQuestionBlock = ({ query, resolvedQuery }) =>
  resolvedQuery && resolvedQuery !== query
    ? [
        `User Question:\n${query}`,
        `Resolved Retrieval Question:\n${resolvedQuery}`,
        "Answer the user question. Use the resolved retrieval question only for reference disambiguation.",
      ].join("\n\n")
    : `User Question:\n${query}`;

const buildPreferenceBlock = (preferenceBlock = "") =>
  preferenceBlock?.trim() ? preferenceBlock.trim() : "Long-term memory: none.";

const formatSelectedPrompt = async ({ v1Template, v2Template, values }) =>
  getPromptVersion() === "v1" ? v1Template.format(values) : v2Template.invoke(values);

const formatPairLabels = (pairs) =>
  pairs.map((pair) => `${pair.leftFileName} vs ${pair.rightFileName}`).join(", ");

const formatSourceLabels = (ranks) =>
  ranks.length > 0 ? ranks.map((rank) => `[Source ${rank}]`).join(" ") : "";

const getPageNumber = (metadata = {}) =>
  metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page ?? null;

const SENTENCE_BOUNDARY = /(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/;
const NUMBER_TOKEN_PATTERN = /\$?\d[\d,./-]*%?/g;
const MAX_COMPARE_SELECTED_RESULTS_PER_DOC = 2;

const buildRetrievedContextEntry = (result, rank) => ({
  rank,
  score: Number((result.score ?? 0).toFixed(4)),
  docId: result.document.metadata?.docId ?? null,
  fileName: result.document.metadata?.fileName ?? "Unknown document",
  pageNumber: getPageNumber(result.document.metadata),
  chunkIndex: result.document.metadata?.chunkIndex ?? null,
  sectionHeading: result.document.metadata?.sectionHeading ?? null,
  text: result.document.pageContent,
});

const normalizeComparableSentence = (sentence = "") =>
  normalizeWhitespace(sentence)
    .toLowerCase()
    .replace(NUMBER_TOKEN_PATTERN, "<num>")
    .replace(/\s+/g, " ")
    .trim();

const splitEvidenceSentences = (value = "") =>
  normalizeWhitespace(value)
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence && /[.!?\u3002\uff01\uff1f]$/.test(sentence));

const buildResultSignalSet = (result) => ({
  canonicalSentenceSet: new Set(
    splitEvidenceSentences(result.document.pageContent)
      .map((sentence) => normalizeComparableSentence(sentence))
      .filter(Boolean)
  ),
  numericTokenSet: new Set(
    (normalizeWhitespace(result.document.pageContent).match(NUMBER_TOKEN_PATTERN) ?? []).map(
      (token) => token.toLowerCase()
    )
  ),
});

const countSharedValues = (leftSet, rightSet) => {
  let count = 0;

  for (const value of leftSet) {
    if (rightSet.has(value)) {
      count += 1;
    }
  }

  return count;
};

const buildUnionSetFromEntries = (entries, fieldName, excludedDocId) => {
  const unionSet = new Set();

  for (const entry of entries) {
    if (entry.docId === excludedDocId) {
      continue;
    }

    for (const value of entry[fieldName]) {
      unionSet.add(value);
    }
  }

  return unionSet;
};

const compareCandidatePriority = (left, right) =>
  right.differentiationScore - left.differentiationScore ||
  (right.result.score ?? 0) - (left.result.score ?? 0) ||
  left.offset - right.offset ||
  left.docId.localeCompare(right.docId);

const buildComparisonExtraCandidates = (alignment) =>
  alignment.perDocument.flatMap((entry) => {
    const otherSentenceSet = buildUnionSetFromEntries(
      alignment.perDocument,
      "canonicalSentenceSet",
      entry.docId
    );
    const otherNumericSet = buildUnionSetFromEntries(
      alignment.perDocument,
      "numericTokenSet",
      entry.docId
    );

    return entry.results
      .slice(1)
      .map((result, index) => {
        const signalSet = buildResultSignalSet(result);
        const uniqueSentenceCount =
          signalSet.canonicalSentenceSet.size -
          countSharedValues(signalSet.canonicalSentenceSet, otherSentenceSet);
        const uniqueNumericCount =
          signalSet.numericTokenSet.size -
          countSharedValues(signalSet.numericTokenSet, otherNumericSet);
        const sharedSentenceCount = countSharedValues(
          signalSet.canonicalSentenceSet,
          otherSentenceSet
        );

        return {
          docId: entry.docId,
          result,
          offset: index + 1,
          differentiationScore:
            uniqueNumericCount * 6 +
            uniqueSentenceCount * 3 -
            sharedSentenceCount * 0.5 +
            (result.score ?? 0) * 0.01 -
            index * 0.1,
        };
      })
      .sort(compareCandidatePriority)
      .slice(0, Math.max(0, MAX_COMPARE_SELECTED_RESULTS_PER_DOC - 1));
  });

const buildDocEvidenceEntries = (bundle) => {
  const entriesByDocId = new Map();

  for (const result of bundle.rankedResults) {
    const docId = result.document.metadata?.docId ?? result.document.id;

    if (!entriesByDocId.has(docId)) {
      entriesByDocId.set(docId, {
        docId,
        fileName: result.document.metadata?.fileName ?? "Unknown document",
        ranks: [],
        sentences: [],
      });
    }

    const entry = entriesByDocId.get(docId);
    entry.ranks.push(result.rank);

    for (const sentence of splitEvidenceSentences(result.document.pageContent)) {
      const canonical = normalizeComparableSentence(sentence);

      if (!canonical) {
        continue;
      }

      entry.sentences.push({
        text: sentence,
        canonical,
      });
    }
  }

  return [...entriesByDocId.values()].map((entry) => ({
    ...entry,
    ranks: [...new Set(entry.ranks)].sort((left, right) => left - right),
    sentences: entry.sentences.filter(
      (sentence, index, allSentences) =>
        allSentences.findIndex(
          (candidate) => candidate.canonical === sentence.canonical
        ) === index
    ),
  }));
};

const collectSharedFactLines = (docEntries, sourceLabels, limit = 3) => {
  if (docEntries.length === 0) {
    return [];
  }

  const canonicalCounts = new Map();

  for (const entry of docEntries) {
    for (const sentence of entry.sentences) {
      canonicalCounts.set(
        sentence.canonical,
        (canonicalCounts.get(sentence.canonical) ?? 0) + 1
      );
    }
  }

  return docEntries[0].sentences
    .filter((sentence) => canonicalCounts.get(sentence.canonical) === docEntries.length)
    .slice(0, limit)
    .map(
      (sentence) => `- ${sentence.text}${sourceLabels ? ` ${sourceLabels}` : ""}`
    );
};

const buildPerDocumentFactLines = (docEntries) =>
  docEntries.map((entry) => {
    const sourceLabels = formatSourceLabels(entry.ranks);
    const sentenceSummary = entry.sentences
      .slice(0, 2)
      .map((sentence) => sentence.text.replace(/[.!?\u3002\uff01\uff1f]+$/, ""))
      .join("; ");

    return `- ${entry.fileName}: ${sentenceSummary || "The retrieved evidence aligns with the other selected documents."}${sourceLabels ? ` ${sourceLabels}` : ""}`;
  });

const buildComparisonDiagnostics = ({ analysis, nearDuplicateGuardEnabled }) => {
  const diagnostics = [
    analysis.sharedTerms.length > 0
      ? `Shared focus terms: ${analysis.sharedTerms.join(", ")}`
      : "Shared focus terms: none detected confidently",
    `Evidence balance: ${analysis.evidenceBalance}`,
    analysis.missingDocuments.length > 0
      ? `Documents without strong evidence: ${analysis.missingDocuments
          .map((document) => document.fileName)
          .join(", ")}`
      : "Documents without strong evidence: none",
  ];

  if (!nearDuplicateGuardEnabled) {
    return diagnostics.join("\n");
  }

  diagnostics.push(
    analysis.nearDuplicatePairs.length > 0
      ? `Near-duplicate evidence pairs: ${formatPairLabels(analysis.nearDuplicatePairs)}`
      : "Near-duplicate evidence pairs: none detected confidently",
    analysis.explicitConflictPairs.length > 0
      ? `Explicit conflict signals: ${analysis.explicitConflictPairs
          .map((pair) => {
            const conflictDetails = [
              pair.numericTokensOnlyInLeft.length > 0
                ? `${pair.leftFileName} only: ${pair.numericTokensOnlyInLeft.join(", ")}`
                : null,
              pair.numericTokensOnlyInRight.length > 0
                ? `${pair.rightFileName} only: ${pair.numericTokensOnlyInRight.join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join(" | ");

            return `${pair.leftFileName} vs ${pair.rightFileName}${conflictDetails ? ` (${conflictDetails})` : ""}`;
          })
          .join("; ")}`
      : "Explicit conflict signals: none",
    analysis.likelyNoMaterialDifferencePairs.length > 0
      ? `High-similarity pairs without explicit conflicts: ${formatPairLabels(
          analysis.likelyNoMaterialDifferencePairs
        )}`
      : "High-similarity pairs without explicit conflicts: none"
  );

  return diagnostics.join("\n");
};

const buildNoMaterialDifferenceAnswer = ({ bundle, analysis }) => {
  const summarySources = formatSourceLabels(bundle.rankedResults.map((result) => result.rank));
  const docEvidenceEntries = buildDocEvidenceEntries(bundle);
  const agreementLines = collectSharedFactLines(docEvidenceEntries, summarySources);
  const perDocumentLines = buildPerDocumentFactLines(docEvidenceEntries);
  const lines = [
    "Summary:",
    `- No evidence-backed material differences were found across the selected documents based on the retrieved evidence.${summarySources ? ` ${summarySources}` : ""}`,
    `- The retrieved evidence aligns on the key facts below.${summarySources ? ` ${summarySources}` : ""}`,
    "Per document:",
    ...perDocumentLines,
    "Agreements:",
    ...(agreementLines.length > 0
      ? agreementLines
      : [
          `- The retrieved passages align on the queried topic across the selected documents.${summarySources ? ` ${summarySources}` : ""}`,
        ]),
    "Differences:",
    `- No conflicting values or conditions were detected in the retrieved evidence.${summarySources ? ` ${summarySources}` : ""}`,
  ];

  if (analysis.missingDocuments.length > 0) {
    lines.push(
      "Gaps or uncertainty:",
      `- Some selected documents lacked strong evidence: ${analysis.missingDocuments
        .map((document) => document.fileName)
        .join(", ")}.`
    );
  }

  return lines.join("\n");
};

export const prepareQASourceBundle = ({ results }) => {
  const rankedResults = results.map((result, index) => ({
    ...result,
    rank: index + 1,
  }));

  return {
    rankedResults,
    citations: dedupeCitations(
      rankedResults.map((result) =>
        buildCitation(result.document, result.score, result.rank)
      )
    ),
    retrievedContexts: rankedResults.map((result) =>
      buildRetrievedContextEntry(result, result.rank)
    ),
    context: rankedResults
      .map((result) => buildContextSection(result.document, result.score, result.rank))
      .join("\n\n"),
  };
};

export const prepareComparisonSourceBundle = ({ alignment }) => {
  const flattenedResults = [];
  const seenResultKeys = new Set();
  const effectiveMaxComparisonSources = Math.min(
    getMaxComparisonSources(),
    Math.max(
      alignment.perDocument.length,
      alignment.perDocument.length * MAX_COMPARE_SELECTED_RESULTS_PER_DOC
    )
  );
  const appendResult = (result) => {
    const resultKey = getResultKey(result);

    if (seenResultKeys.has(resultKey)) {
      return;
    }

    seenResultKeys.add(resultKey);
    flattenedResults.push(result);
  };

  for (const entry of alignment.perDocument) {
    if (entry.results[0]) {
      appendResult(entry.results[0]);
    }

    if (flattenedResults.length >= effectiveMaxComparisonSources) {
      break;
    }
  }

  const extraCandidates = buildComparisonExtraCandidates(alignment).sort(
    compareCandidatePriority
  );

  for (const candidate of extraCandidates) {
    if (flattenedResults.length >= effectiveMaxComparisonSources) {
      break;
    }

    appendResult(candidate.result);
  }

  const rankedResults = flattenedResults.map((result, index) => ({
    ...result,
    rank: index + 1,
  }));
  const rankByResultKey = new Map(
    rankedResults.map((result) => [getResultKey(result), result.rank])
  );
  const selectedResultKeys = new Set(rankByResultKey.keys());

  return {
    rankedResults,
    citations: dedupeCitations(
      rankedResults.map((result) =>
        buildCitation(result.document, result.score, result.rank)
      )
    ),
    retrievedContexts: rankedResults.map((result) =>
      buildRetrievedContextEntry(result, result.rank)
    ),
    context: alignment.perDocument
      .map((entry) => {
        const selectedResults = entry.results.filter((result) =>
          selectedResultKeys.has(getResultKey(result))
        );

        if (selectedResults.length === 0) {
          return [
            `Document: ${entry.fileName}`,
            "No strong evidence was retrieved for this document.",
          ].join("\n");
        }

        return [
          `Document: ${entry.fileName}`,
          entry.focusTerms.length > 0
            ? `Focus terms: ${entry.focusTerms.join(", ")}`
            : null,
          ...selectedResults.map((result) =>
            buildContextSection(
              result.document,
              result.score,
              rankByResultKey.get(getResultKey(result))
            )
          ),
        ]
          .filter(Boolean)
          .join("\n\n");
      })
      .join("\n\n---\n\n"),
  };
};

export const writeQaAnswer = async ({
  query,
  resolvedQuery,
  bundle,
  preferenceBlock = "",
}) => {
  const prompt = await formatSelectedPrompt({
    v1Template: qaPromptV1,
    v2Template: qaPromptV2,
    values: {
      questionBlock: buildQuestionBlock({
        query,
        resolvedQuery,
      }),
      preferenceBlock: buildPreferenceBlock(preferenceBlock),
      context: bundle.context,
    },
  });
  const text = await completeText(prompt);

  return {
    text: text || "I couldn't synthesize an answer from the retrieved document evidence.",
    citations: bundle.citations,
  };
};

export const writeComparisonAnswer = async ({
  query,
  resolvedQuery,
  bundle,
  analysis,
  preferenceBlock = "",
}) => {
  const nearDuplicateGuardEnabled = isNearDuplicateGuardEnabled();

  if (
    nearDuplicateGuardEnabled &&
    analysis.shouldShortCircuitNoMaterialDifference
  ) {
    return {
      text: buildNoMaterialDifferenceAnswer({
        bundle,
        analysis,
      }),
      citations: bundle.citations,
    };
  }

  const diagnostics = buildComparisonDiagnostics({
    analysis,
    nearDuplicateGuardEnabled,
  });

  const selectedPrompt = await formatSelectedPrompt({
    v1Template: nearDuplicateGuardEnabled
      ? guardedComparisonPromptV1
      : comparisonPromptV1,
    v2Template: nearDuplicateGuardEnabled
      ? guardedComparisonPromptV2
      : comparisonPromptV2,
    values: {
      questionBlock: buildQuestionBlock({
        query,
        resolvedQuery,
      }),
      preferenceBlock: buildPreferenceBlock(preferenceBlock),
      diagnostics,
      context: bundle.context,
    },
  });
  const text = await completeText(selectedPrompt);

  return {
    text:
      text ||
      "I couldn't produce a reliable comparison from the retrieved document evidence.",
    citations: bundle.citations,
  };
};
