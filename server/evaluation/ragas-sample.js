const roundScore = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(4))
    : null;

const buildContextId = ({ docKey = null, pageNumber = null }) =>
  [docKey, pageNumber].filter((value) => value !== null && value !== undefined).join(":");

export const summarizeRetrievedContexts = (retrievedContexts, docKeyByDocId) =>
  (retrievedContexts ?? []).map((context) => ({
    rank: context.rank ?? null,
    score: roundScore(context.score),
    docId: context.docId ?? null,
    docKey: context.docId ? docKeyByDocId.get(context.docId) ?? null : null,
    fileName: context.fileName ?? null,
    pageNumber: context.pageNumber ?? null,
    chunkIndex: context.chunkIndex ?? null,
    sectionHeading: context.sectionHeading ?? null,
    text: context.text ?? "",
  }));

export const buildReferenceContextsFromPages = ({
  expectedEvidence,
  pagesByDocKey,
}) =>
  (expectedEvidence ?? []).flatMap((expected) =>
    (expected.pages ?? []).flatMap((pageNumber) => {
      const pages = pagesByDocKey.get(expected.docKey) ?? [];
      const pageText = pages[pageNumber - 1];

      if (!pageText) {
        return [];
      }

      return [
        {
          docKey: expected.docKey,
          pageNumber,
          text: pageText,
        },
      ];
    })
  );

const buildFallbackReference = (testCase) =>
  Array.isArray(testCase.expectedAnswerIncludes) &&
  testCase.expectedAnswerIncludes.length > 0
    ? testCase.expectedAnswerIncludes.join("; ")
    : null;

export const buildRagasSample = ({
  testCase,
  response,
  docKeyByDocId,
  referenceContexts = [],
}) => {
  const retrievedContexts = summarizeRetrievedContexts(
    response.retrievedContexts,
    docKeyByDocId
  );
  const reference = testCase.referenceAnswer ?? buildFallbackReference(testCase);

  return {
    caseId: testCase.id,
    user_input: testCase.question,
    response: response.text,
    retrieved_contexts: retrievedContexts.map((context) => context.text),
    retrieved_context_ids: retrievedContexts
      .map((context) =>
        buildContextId({
          docKey: context.docKey,
          pageNumber: context.pageNumber,
        })
      )
      .filter(Boolean),
    reference,
    reference_contexts: referenceContexts.map((context) => context.text),
    reference_context_ids: referenceContexts
      .map((context) =>
        buildContextId({
          docKey: context.docKey,
          pageNumber: context.pageNumber,
        })
      )
      .filter(Boolean),
    metadata: {
      type: testCase.type,
      docKeys: testCase.docKeys,
      shouldAbstain: Boolean(testCase.shouldAbstain),
      abstained: Boolean(response.abstained),
      resolvedQuery: response.resolvedQuery ?? testCase.question,
    },
  };
};
