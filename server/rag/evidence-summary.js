const toFixedNumber = (value) =>
  Number.isFinite(value) ? Number(value.toFixed(4)) : null;

const getScoreValues = (results = []) =>
  results
    .map((result) => Number(result?.score))
    .filter((score) => Number.isFinite(score));

const buildScoreRange = (results = []) => {
  const scores = getScoreValues(results);

  if (scores.length === 0) {
    return {
      min: null,
      max: null,
      average: null,
    };
  }

  return {
    min: toFixedNumber(Math.min(...scores)),
    max: toFixedNumber(Math.max(...scores)),
    average: toFixedNumber(
      scores.reduce((sum, score) => sum + score, 0) / scores.length
    ),
  };
};

const getDocId = (result) => result?.document?.metadata?.docId ?? null;

const buildRequirementSummaries = (requirements = []) =>
  requirements.map((requirement) => ({
    id: requirement.id,
    label: requirement.label,
    query: requirement.query,
    primary: Boolean(requirement.primary),
  }));

const uniqueValues = (values) => [...new Set(values.filter(Boolean))];

export const buildQaEvidenceSummary = ({
  confidence,
  docIds = [],
  requirements = [],
  results = [],
}) => {
  const usableResults = confidence?.usableResults ?? [];
  const coveredDocIds = uniqueValues(usableResults.map(getDocId));
  const missingDocIds = docIds.filter((docId) => !coveredDocIds.includes(docId));
  const reasons = confidence?.confident
    ? [
        `Evidence passed with ${usableResults.length} usable source${
          usableResults.length === 1 ? "" : "s"
        }.`,
      ]
    : [confidence?.reason ?? "Evidence did not pass confidence checks."];

  return {
    mode: "qa",
    confident: Boolean(confidence?.confident),
    reasons,
    retrievedCount: results.length,
    usableCount: usableResults.length,
    scoreRange: buildScoreRange(results),
    docCoverage: {
      selectedDocIds: docIds,
      coveredDocIds,
      missingDocIds,
    },
    requirements: buildRequirementSummaries(requirements),
  };
};

const flattenPerDocumentResults = (perDocumentResults) =>
  perDocumentResults instanceof Map
    ? [...perDocumentResults.values()].flatMap((results) => results ?? [])
    : [];

const countPerDoc = (resultsByDoc) =>
  resultsByDoc instanceof Map
    ? Object.fromEntries(
        [...resultsByDoc.entries()].map(([docId, results]) => [
          docId,
          Array.isArray(results) ? results.length : 0,
        ])
      )
    : {};

export const buildComparisonEvidenceSummary = ({
  confidence,
  docIds = [],
  perDocumentResults,
  requirements = [],
}) => {
  const usableResultsByDoc = confidence?.usableResultsByDoc ?? new Map();
  const coveredDocIds = docIds.filter(
    (docId) => (usableResultsByDoc.get(docId) ?? []).length > 0
  );
  const missingDocIds = docIds.filter((docId) => !coveredDocIds.includes(docId));
  const allResults = flattenPerDocumentResults(perDocumentResults);
  const usableResults = flattenPerDocumentResults(usableResultsByDoc);
  const reasons = confidence?.confident
    ? [
        `Evidence passed across ${coveredDocIds.length} of ${docIds.length} selected documents.`,
      ]
    : [confidence?.reason ?? "Evidence did not pass comparison confidence checks."];

  return {
    mode: "compare",
    confident: Boolean(confidence?.confident),
    reasons,
    retrievedCount: allResults.length,
    usableCount: usableResults.length,
    scoreRange: buildScoreRange(allResults),
    docCoverage: {
      selectedDocIds: docIds,
      coveredDocIds,
      missingDocIds,
      retrievedCountsByDoc: countPerDoc(perDocumentResults),
      usableCountsByDoc: countPerDoc(usableResultsByDoc),
    },
    requirements: buildRequirementSummaries(requirements),
  };
};
