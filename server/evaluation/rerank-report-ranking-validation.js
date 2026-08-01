import { buildExpectedEvidenceUnits } from "./eval-case-helpers.js";
import { chunkDocumentWithConfig } from "../rag/chunker.js";
import {
  buildRerankReplayContext,
  getUnsupportedRerankReplayConfig,
  replayRerankCaseRankings,
} from "./rerank-report-replay.js";

const EPSILON = 0.000001;

const METRIC_KEYS = Object.freeze([
  "ndcgAtK",
  "precisionAtK",
  "recallAtK",
  "mrr",
  "noiseRateAtK",
  "relevantCountAtK",
  "noiseCountAtK",
  "expectedRelevantCount",
  "evaluatedCountAtK",
]);

const LIFT_METRIC_KEYS = Object.freeze([
  "ndcgAtK",
  "precisionAtK",
  "recallAtK",
  "mrr",
]);

const round = (value, precision = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(precision)) : null;

const average = (values) => {
  const safeValues = values.filter((value) => Number.isFinite(value));

  return safeValues.length > 0
    ? round(
        safeValues.reduce((sum, value) => sum + value, 0) /
          safeValues.length
      )
    : null;
};

const samePrimitiveArray = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const toUnitKeys = (units = []) =>
  units.map((unit) => `${unit.docKey}:${unit.pageNumber ?? "*"}`).sort();

const normalizeSourceText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

const buildDocumentContract = (document, expectedConfig = {}) => {
  const chunks = chunkDocumentWithConfig({
    docId: `rerank-contract:${document?.key ?? "unknown"}`,
    fileName: document?.fileName,
    publicFilePath: "/evaluation-contract",
    pages: (document?.pages ?? []).map((text, index) => ({
      pageNumber: index + 1,
      text,
    })),
    chunkStrategy: expectedConfig.chunkStrategy ?? "structured",
    chunkSize: expectedConfig.chunkSize ?? 900,
    chunkOverlap: expectedConfig.chunkOverlap ?? 180,
  });

  return {
    ...document,
    chunksByIndex: new Map(
      chunks.map((chunk) => [chunk.metadata.chunkIndex, chunk])
    ),
  };
};

const buildIssue = ({
  actual,
  caseId = null,
  expected,
  path,
  reasonCode,
}) => ({
  reasonCode,
  ...(caseId ? { caseId } : {}),
  path,
  expected: expected ?? null,
  actual: actual ?? null,
});

const appendPath = (basePath, field) =>
  basePath ? `${basePath}.${field}` : field;

const validateK = ({ caseId, issues, k, path }) => {
  if (typeof k !== "number" || !Number.isInteger(k) || k <= 0) {
    issues.push(
      buildIssue({
        actual: k,
        caseId,
        expected: "positive integer",
        path,
        reasonCode: "ranking_k_invalid",
      })
    );
    return null;
  }

  return k;
};

const validateExpectedUnits = ({ caseId, expectedUnits, issues, path }) => {
  if (!Array.isArray(expectedUnits)) {
    issues.push(
      buildIssue({
        actual: expectedUnits,
        caseId,
        expected: "non-empty array",
        path,
        reasonCode: "expected_units_missing",
      })
    );
    return null;
  }

  if (expectedUnits.length === 0) {
    issues.push(
      buildIssue({
        actual: 0,
        caseId,
        expected: "> 0",
        path,
        reasonCode: "expected_units_empty",
      })
    );
    return null;
  }

  const normalizedUnits = [];
  const seenUnitKeys = new Set();

  expectedUnits.forEach((unit, index) => {
    const unitPath = `${path}[${index}]`;
    const docKey = typeof unit?.docKey === "string" ? unit.docKey.trim() : "";
    const pageNumber = unit?.pageNumber;
    const validPageNumber =
      pageNumber === null ||
      (typeof pageNumber === "number" &&
        Number.isInteger(pageNumber) &&
        pageNumber > 0);

    if (!docKey) {
      issues.push(
        buildIssue({
          actual: unit?.docKey,
          caseId,
          expected: "non-empty string",
          path: `${unitPath}.docKey`,
          reasonCode: "expected_unit_doc_key_invalid",
        })
      );
    }

    if (!validPageNumber) {
      issues.push(
        buildIssue({
          actual: pageNumber,
          caseId,
          expected: "null or positive integer",
          path: `${unitPath}.pageNumber`,
          reasonCode: "expected_unit_page_number_invalid",
        })
      );
    }

    if (!docKey || !validPageNumber) {
      return;
    }

    const unitKey = `${docKey}:${pageNumber ?? "*"}`;

    if (unit?.key !== unitKey) {
      issues.push(
        buildIssue({
          actual: unit?.key,
          caseId,
          expected: unitKey,
          path: `${unitPath}.key`,
          reasonCode: "expected_unit_key_mismatch",
        })
      );
      return;
    }

    if (seenUnitKeys.has(unitKey)) {
      issues.push(
        buildIssue({
          actual: unitKey,
          caseId,
          expected: "unique expected unit",
          path: unitPath,
          reasonCode: "expected_unit_duplicate",
        })
      );
      return;
    }

    seenUnitKeys.add(unitKey);
    normalizedUnits.push({
      key: unitKey,
      docKey,
      pageNumber,
    });
  });

  return normalizedUnits.length === expectedUnits.length
    ? normalizedUnits
    : null;
};

const validateRanking = ({
  caseId,
  documentsByKey = null,
  issues,
  maxLength,
  path,
  ranking,
  requireNonEmpty = false,
  requireSourceText = false,
}) => {
  if (!Array.isArray(ranking)) {
    issues.push(
      buildIssue({
        actual: ranking,
        caseId,
        expected: "array",
        path,
        reasonCode: "ranking_missing",
      })
    );
    return null;
  }

  let valid = true;

  if (requireNonEmpty && ranking.length === 0) {
    valid = false;
    issues.push(
      buildIssue({
        actual: 0,
        caseId,
        expected: "> 0",
        path,
        reasonCode: "ranking_empty",
      })
    );
  }

  if (ranking.length > maxLength) {
    valid = false;
    issues.push(
      buildIssue({
        actual: ranking.length,
        caseId,
        expected: `<= ${maxLength}`,
        path,
        reasonCode: "ranking_length_invalid",
      })
    );
  }

  const seenResultKeys = new Set();
  const normalizedRanking = [];

  ranking.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const expectedRank = index + 1;
    const resultKey =
      typeof entry?.resultKey === "string" ? entry.resultKey.trim() : "";
    const docKey =
      typeof entry?.docKey === "string" ? entry.docKey.trim() : "";
    const fileName =
      typeof entry?.fileName === "string" ? entry.fileName.trim() : "";
    const pageNumber = entry?.pageNumber;
    const chunkIndex = entry?.chunkIndex;
    const validPageNumber =
      pageNumber === null ||
      (typeof pageNumber === "number" &&
        Number.isInteger(pageNumber) &&
        pageNumber > 0);
    const validChunkIndex =
      chunkIndex === null ||
      (typeof chunkIndex === "number" &&
        Number.isInteger(chunkIndex) &&
        chunkIndex >= 0);

    if (
      typeof entry?.rank !== "number" ||
      !Number.isInteger(entry.rank) ||
      entry.rank !== expectedRank ||
      entry.rank > maxLength
    ) {
      valid = false;
      issues.push(
        buildIssue({
          actual: entry?.rank,
          caseId,
          expected: expectedRank,
          path: `${entryPath}.rank`,
          reasonCode: "ranking_rank_invalid",
        })
      );
    }

    if (!resultKey) {
      valid = false;
      issues.push(
        buildIssue({
          actual: entry?.resultKey,
          caseId,
          expected: "non-empty string",
          path: `${entryPath}.resultKey`,
          reasonCode: "ranking_result_key_invalid",
        })
      );
    } else if (seenResultKeys.has(resultKey)) {
      valid = false;
      issues.push(
        buildIssue({
          actual: resultKey,
          caseId,
          expected: "unique resultKey within ranking",
          path: `${entryPath}.resultKey`,
          reasonCode: "ranking_result_duplicate",
        })
      );
    } else {
      seenResultKeys.add(resultKey);
    }

    if (!docKey) {
      valid = false;
      issues.push(
        buildIssue({
          actual: entry?.docKey,
          caseId,
          expected: "non-empty string",
          path: `${entryPath}.docKey`,
          reasonCode: "ranking_doc_key_invalid",
        })
      );
    }

    if (!validPageNumber) {
      valid = false;
      issues.push(
        buildIssue({
          actual: pageNumber,
          caseId,
          expected: "null or positive integer",
          path: `${entryPath}.pageNumber`,
          reasonCode: "ranking_page_number_invalid",
        })
      );
    }

    if (!validChunkIndex) {
      valid = false;
      issues.push(
        buildIssue({
          actual: chunkIndex,
          caseId,
          expected: "null or non-negative integer",
          path: `${entryPath}.chunkIndex`,
          reasonCode: "ranking_chunk_index_invalid",
        })
      );
    }

    if (requireSourceText) {
      const document = documentsByKey?.get(docKey);
      const expectedChunk = document?.chunksByIndex?.get(chunkIndex);
      const normalizedEntryText = normalizeSourceText(entry?.text);
      const normalizedChunkText = normalizeSourceText(
        expectedChunk?.pageContent
      );

      if (
        !document ||
        !fileName ||
        fileName !== document.fileName ||
        !expectedChunk ||
        pageNumber !== expectedChunk.metadata.pageNumber ||
        !normalizedEntryText ||
        normalizedEntryText !== normalizedChunkText
      ) {
        valid = false;
        issues.push(
          buildIssue({
            actual: {
              docKey,
              fileName,
              pageNumber,
              text: entry?.text,
            },
            caseId,
            expected:
              "exact candidate chunk text and identity rebuilt from configured corpus",
            path: entryPath,
            reasonCode: "candidate_corpus_source_mismatch",
          })
        );
      }
    }

    normalizedRanking.push({
      rank: entry?.rank,
      resultKey,
      docKey,
      fileName,
      pageNumber,
      chunkIndex,
    });
  });

  return valid ? normalizedRanking : null;
};

const validateRankingIdentity = ({
  baselineRanking,
  caseId,
  issues,
  path,
  rerankedRanking,
}) => {
  const baselineByResultKey = new Map(
    baselineRanking.map((entry) => [entry.resultKey, entry])
  );

  rerankedRanking.forEach((entry, index) => {
    const baselineEntry = baselineByResultKey.get(entry.resultKey);

    if (!baselineEntry) {
      return;
    }

    const baselineIdentity = [
      baselineEntry.docKey,
      baselineEntry.fileName,
      baselineEntry.pageNumber,
      baselineEntry.chunkIndex,
    ];
    const rerankedIdentity = [
      entry.docKey,
      entry.fileName,
      entry.pageNumber,
      entry.chunkIndex,
    ];

    if (!samePrimitiveArray(baselineIdentity, rerankedIdentity)) {
      issues.push(
        buildIssue({
          actual: rerankedIdentity,
          caseId,
          expected: baselineIdentity,
          path: `${appendPath(path, "rerankedRanking")}[${index}]`,
          reasonCode: "ranking_result_identity_mismatch",
        })
      );
    }
  });
};

const sameRankingIdentity = (left, right) =>
  left?.resultKey === right?.resultKey &&
  left?.docKey === right?.docKey &&
  left?.fileName === right?.fileName &&
  left?.pageNumber === right?.pageNumber &&
  left?.chunkIndex === right?.chunkIndex;

const sameReplayIdentity = (left, right) =>
  left?.docKey === right?.docKey &&
  left?.fileName === right?.fileName &&
  left?.pageNumber === right?.pageNumber &&
  left?.chunkIndex === right?.chunkIndex;

const validateReplayRanking = ({
  actualRanking,
  caseId,
  expectedRanking,
  issues,
  path,
  reasonCode,
}) => {
  if (!actualRanking || !Array.isArray(expectedRanking)) {
    return;
  }

  if (
    actualRanking.length !== expectedRanking.length ||
    actualRanking.some(
      (entry, index) => !sameReplayIdentity(entry, expectedRanking[index])
    )
  ) {
    issues.push(
      buildIssue({
        actual: actualRanking.map((entry) => [
          entry.docKey,
          entry.fileName,
          entry.pageNumber,
          entry.chunkIndex,
        ]),
        caseId,
        expected: expectedRanking.map((entry) => [
          entry.docKey,
          entry.fileName,
          entry.pageNumber,
          entry.chunkIndex,
        ]),
        path,
        reasonCode,
      })
    );
  }
};

const validateReplayBinding = ({
  baselineRanking,
  candidateRanking,
  caseId,
  expectedReplay,
  issues,
  path,
  rerankedRanking,
}) => {
  if (!expectedReplay) {
    return;
  }

  validateReplayRanking({
    actualRanking: candidateRanking,
    caseId,
    expectedRanking: expectedReplay.candidateRanking,
    issues,
    path: appendPath(path, "candidateRanking"),
    reasonCode: "candidate_replay_mismatch",
  });
  validateReplayRanking({
    actualRanking: baselineRanking,
    caseId,
    expectedRanking: expectedReplay.baselineRanking,
    issues,
    path: appendPath(path, "baselineRanking"),
    reasonCode: "baseline_replay_mismatch",
  });
  validateReplayRanking({
    actualRanking: rerankedRanking,
    caseId,
    expectedRanking: expectedReplay.rerankedRanking,
    issues,
    path: appendPath(path, "rerankedRanking"),
    reasonCode: "reranked_replay_mismatch",
  });
};

const validateCandidateBinding = ({
  baselineRanking,
  candidateRanking,
  caseId,
  entry,
  issues,
  k,
  path,
  rerankedRanking,
}) => {
  const candidateCount = entry?.candidateCount;

  if (
    typeof candidateCount !== "number" ||
    !Number.isInteger(candidateCount) ||
    candidateCount < 1 ||
    candidateCount !== candidateRanking.length
  ) {
    issues.push(
      buildIssue({
        actual: candidateCount,
        caseId,
        expected: candidateRanking.length,
        path: appendPath(path, "candidateCount"),
        reasonCode: "candidate_count_mismatch",
      })
    );
  }

  const expectedBaseline = candidateRanking.slice(0, k);

  if (
    baselineRanking.length !== expectedBaseline.length ||
    baselineRanking.some(
      (entry, index) => !sameRankingIdentity(entry, expectedBaseline[index])
    )
  ) {
    issues.push(
      buildIssue({
        actual: baselineRanking.map((entry) => entry.resultKey),
        caseId,
        expected: expectedBaseline.map((entry) => entry.resultKey),
        path: appendPath(path, "baselineRanking"),
        reasonCode: "baseline_candidate_prefix_mismatch",
      })
    );
  }

  const candidateByResultKey = new Map(
    candidateRanking.map((entry) => [entry.resultKey, entry])
  );

  rerankedRanking.forEach((entry, index) => {
    const candidate = candidateByResultKey.get(entry.resultKey);

    if (!candidate) {
      issues.push(
        buildIssue({
          actual: entry.resultKey,
          caseId,
          expected: "resultKey from candidateRanking",
          path: `${appendPath(path, "rerankedRanking")}[${index}].resultKey`,
          reasonCode: "reranked_candidate_missing",
        })
      );
    } else if (!sameRankingIdentity(entry, candidate)) {
      issues.push(
        buildIssue({
          actual: [
            entry.docKey,
            entry.fileName,
            entry.pageNumber,
            entry.chunkIndex,
          ],
          caseId,
          expected: [
            candidate.docKey,
            candidate.fileName,
            candidate.pageNumber,
            candidate.chunkIndex,
          ],
          path: `${appendPath(path, "rerankedRanking")}[${index}]`,
          reasonCode: "reranked_candidate_identity_mismatch",
        })
      );
    }
  });
};

const validateUnitBinding = ({
  actualUnits,
  caseId,
  expectedUnits,
  issues,
  path,
}) => {
  if (!actualUnits || !expectedUnits) {
    return;
  }

  const actualKeys = toUnitKeys(actualUnits);
  const expectedKeys = toUnitKeys(expectedUnits);

  if (!samePrimitiveArray(actualKeys, expectedKeys)) {
    issues.push(
      buildIssue({
        actual: actualKeys,
        caseId,
        expected: expectedKeys,
        path,
        reasonCode: "expected_units_corpus_mismatch",
      })
    );
  }
};

const validateRankingScope = ({
  allowedDocKeys,
  caseId,
  issues,
  path,
  ranking,
}) => {
  if (!ranking || !allowedDocKeys) {
    return;
  }

  const allowed = new Set(allowedDocKeys);

  ranking.forEach((entry, index) => {
    if (!allowed.has(entry.docKey)) {
      issues.push(
        buildIssue({
          actual: entry.docKey,
          caseId,
          expected: [...allowed],
          path: `${path}[${index}].docKey`,
          reasonCode: "ranking_doc_key_out_of_scope",
        })
      );
    }
  });
};

const dcg = (grades, k) =>
  grades
    .slice(0, k)
    .reduce(
      (sum, grade, index) =>
        sum + (2 ** grade - 1) / Math.log2(index + 2),
      0
    );

const labelRanking = ({ expectedUnits, ranking }) => {
  const matchedUnitKeys = new Set();

  return ranking.map((entry) => {
    const expectedUnit = expectedUnits.find(
      (unit) =>
        unit.docKey === entry.docKey &&
        (unit.pageNumber === null || unit.pageNumber === entry.pageNumber)
    );

    if (!expectedUnit || matchedUnitKeys.has(expectedUnit.key)) {
      return {
        ...entry,
        exactRelevant: false,
        relevanceGrade: 0,
        matchedUnitKey: expectedUnit?.key ?? null,
      };
    }

    matchedUnitKeys.add(expectedUnit.key);
    return {
      ...entry,
      exactRelevant: true,
      relevanceGrade: 2,
      matchedUnitKey: expectedUnit.key,
    };
  });
};

const calculateRankingMetrics = ({ expectedUnits, k, ranking }) => {
  const topRanking = ranking.slice(0, k);
  const labeledRanking = labelRanking({
    expectedUnits,
    ranking: topRanking,
  });
  const relevantEntries = labeledRanking.filter(
    (entry) => entry.exactRelevant
  );
  const matchedUnits = new Set(
    labeledRanking.map((entry) => entry.matchedUnitKey).filter(Boolean)
  );
  const firstRelevantIndex = labeledRanking.findIndex(
    (entry) => entry.exactRelevant
  );
  const topCount = topRanking.length;
  const relevantCount = relevantEntries.length;
  const noiseCount = Math.max(0, topCount - relevantCount);
  const idealDcg = dcg(
    expectedUnits.map(() => 2),
    k
  );
  const actualDcg = dcg(
    labeledRanking.map((entry) => entry.relevanceGrade),
    k
  );

  return {
    ndcgAtK: idealDcg > 0 ? round(actualDcg / idealDcg) : null,
    precisionAtK: topCount > 0 ? round(relevantCount / topCount) : null,
    recallAtK:
      expectedUnits.length > 0
        ? round(matchedUnits.size / expectedUnits.length)
        : null,
    mrr: firstRelevantIndex >= 0 ? round(1 / (firstRelevantIndex + 1)) : 0,
    noiseRateAtK: topCount > 0 ? round(noiseCount / topCount) : null,
    relevantCountAtK: relevantCount,
    noiseCountAtK: noiseCount,
    expectedRelevantCount: expectedUnits.length,
    evaluatedCountAtK: topCount,
  };
};

const calculateLift = (baselineMetrics, rerankedMetrics) => {
  const lift = {};

  for (const metric of LIFT_METRIC_KEYS) {
    const baselineValue = baselineMetrics?.[metric];
    const rerankedValue = rerankedMetrics?.[metric];
    const absolute =
      Number.isFinite(baselineValue) && Number.isFinite(rerankedValue)
        ? round(rerankedValue - baselineValue)
        : null;

    lift[metric] = {
      absolute,
      relative:
        absolute !== null && baselineValue > 0
          ? round(absolute / baselineValue)
          : null,
    };
  }

  const baselineNoiseRate = baselineMetrics?.noiseRateAtK;
  const rerankedNoiseRate = rerankedMetrics?.noiseRateAtK;

  lift.noiseRateAtK = {
    absoluteReduction:
      Number.isFinite(baselineNoiseRate) &&
      Number.isFinite(rerankedNoiseRate)
        ? round(baselineNoiseRate - rerankedNoiseRate)
        : null,
    relativeReduction:
      Number.isFinite(baselineNoiseRate) &&
      baselineNoiseRate > 0 &&
      Number.isFinite(rerankedNoiseRate)
        ? round(
            (baselineNoiseRate - rerankedNoiseRate) /
              baselineNoiseRate
          )
        : null,
  };

  return lift;
};

const calculateNoiseFilteringRate = ({
  baselineRanking,
  expectedUnits,
  rerankedRanking,
}) => {
  const baselineLabels = labelRanking({
    expectedUnits,
    ranking: baselineRanking,
  });
  const baselineNoiseKeys = baselineRanking
    .filter((_entry, index) => !baselineLabels[index].exactRelevant)
    .map((entry) => entry.resultKey);

  if (baselineNoiseKeys.length === 0) {
    return null;
  }

  const rerankedKeys = new Set(
    rerankedRanking.map((entry) => entry.resultKey)
  );
  const removedNoiseCount = baselineNoiseKeys.filter(
    (resultKey) => !rerankedKeys.has(resultKey)
  ).length;

  return round(removedNoiseCount / baselineNoiseKeys.length);
};

const valuesMatch = (actual, expected) =>
  actual === expected ||
  (Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) <= EPSILON);

const validateReportedValue = ({
  actual,
  caseId,
  expected,
  issues,
  path,
}) => {
  const validType =
    expected === null
      ? actual === null
      : typeof actual === "number" && Number.isFinite(actual);

  if (!validType) {
    issues.push(
      buildIssue({
        actual,
        caseId,
        expected: expected === null ? null : "finite number",
        path,
        reasonCode: "reported_ranking_metric_invalid",
      })
    );
    return;
  }

  if (!valuesMatch(actual, expected)) {
    issues.push(
      buildIssue({
        actual,
        caseId,
        expected,
        path,
        reasonCode: "reported_ranking_metric_mismatch",
      })
    );
  }
};

const validateReportedMetrics = ({
  caseId,
  expected,
  issues,
  path,
  reported,
}) => {
  for (const metric of METRIC_KEYS) {
    validateReportedValue({
      actual: reported?.[metric],
      caseId,
      expected: expected[metric],
      issues,
      path: `${path}.${metric}`,
    });
  }
};

const validateReportedLift = ({
  caseId,
  expected,
  issues,
  path,
  reported,
}) => {
  for (const metric of LIFT_METRIC_KEYS) {
    for (const component of ["absolute", "relative"]) {
      validateReportedValue({
        actual: reported?.[metric]?.[component],
        caseId,
        expected: expected[metric][component],
        issues,
        path: `${path}.${metric}.${component}`,
      });
    }
  }

  for (const component of ["absoluteReduction", "relativeReduction"]) {
    validateReportedValue({
      actual: reported?.noiseRateAtK?.[component],
      caseId,
      expected: expected.noiseRateAtK[component],
      issues,
      path: `${path}.noiseRateAtK.${component}`,
    });
  }
};

const recomputeRankingEntry = ({
  allowedDocKeys = null,
  caseId,
  candidateMultiplier = null,
  documentsByKey = null,
  entry,
  expectedContractUnits = null,
  expectedK = null,
  expectedReplay = null,
  issues,
  path,
}) => {
  const initialIssueCount = issues.length;
  const k = validateK({
    caseId,
    issues,
    k: entry?.k,
    path: appendPath(path, "k"),
  });
  const expectedUnits = validateExpectedUnits({
    caseId,
    expectedUnits: entry?.expectedUnits,
    issues,
    path: appendPath(path, "expectedUnits"),
  });
  const maxCandidateCount =
    k !== null && candidateMultiplier !== null
      ? k * candidateMultiplier
      : Number.MAX_SAFE_INTEGER;
  const candidateRanking = validateRanking({
    caseId,
    documentsByKey,
    issues,
    maxLength: maxCandidateCount,
    path: appendPath(path, "candidateRanking"),
    ranking: entry?.candidateRanking,
    requireNonEmpty: true,
    requireSourceText: documentsByKey !== null,
  });
  const baselineRanking = validateRanking({
    caseId,
    issues,
    maxLength: k ?? 0,
    path: appendPath(path, "baselineRanking"),
    ranking: entry?.baselineRanking,
  });
  const rerankedRanking = validateRanking({
    caseId,
    issues,
    maxLength: k ?? 0,
    path: appendPath(path, "rerankedRanking"),
    ranking: entry?.rerankedRanking,
  });

  if (k !== null && expectedK !== null && k !== expectedK) {
    issues.push(
      buildIssue({
        actual: k,
        caseId,
        expected: expectedK,
        path: appendPath(path, "k"),
        reasonCode: "ranking_k_config_mismatch",
      })
    );
  }

  validateUnitBinding({
    actualUnits: expectedUnits,
    caseId,
    expectedUnits: expectedContractUnits,
    issues,
    path: appendPath(path, "expectedUnits"),
  });
  validateRankingScope({
    allowedDocKeys,
    caseId,
    issues,
    path: appendPath(path, "candidateRanking"),
    ranking: candidateRanking,
  });
  validateRankingScope({
    allowedDocKeys,
    caseId,
    issues,
    path: appendPath(path, "baselineRanking"),
    ranking: baselineRanking,
  });
  validateRankingScope({
    allowedDocKeys,
    caseId,
    issues,
    path: appendPath(path, "rerankedRanking"),
    ranking: rerankedRanking,
  });

  if (candidateRanking && baselineRanking && rerankedRanking && k !== null) {
    validateCandidateBinding({
      baselineRanking,
      candidateRanking,
      caseId,
      entry,
      issues,
      k,
      path,
      rerankedRanking,
    });
    validateRankingIdentity({
      baselineRanking,
      caseId,
      issues,
      path,
      rerankedRanking,
    });
    validateReplayBinding({
      baselineRanking,
      candidateRanking,
      caseId,
      expectedReplay,
      issues,
      path,
      rerankedRanking,
    });
  }

  if (
    issues.length !== initialIssueCount ||
    k === null ||
    expectedUnits === null ||
    candidateRanking === null ||
    baselineRanking === null ||
    rerankedRanking === null
  ) {
    return null;
  }

  const baselineMetrics = calculateRankingMetrics({
    expectedUnits,
    k,
    ranking: baselineRanking,
  });
  const rerankedMetrics = calculateRankingMetrics({
    expectedUnits,
    k,
    ranking: rerankedRanking,
  });

  return {
    candidateCount: candidateRanking.length,
    baselineMetrics,
    rerankedMetrics,
    lift: calculateLift(baselineMetrics, rerankedMetrics),
    noiseFilteringRate: calculateNoiseFilteringRate({
      baselineRanking,
      expectedUnits,
      rerankedRanking,
    }),
  };
};

const validateReportedEntry = ({ caseId, entry, issues, path, recomputed }) => {
  validateReportedMetrics({
    caseId,
    expected: recomputed.baselineMetrics,
    issues,
    path: appendPath(path, "baselineMetrics"),
    reported: entry?.baselineMetrics,
  });
  validateReportedMetrics({
    caseId,
    expected: recomputed.rerankedMetrics,
    issues,
    path: appendPath(path, "rerankedMetrics"),
    reported: entry?.rerankedMetrics,
  });
  validateReportedLift({
    caseId,
    expected: recomputed.lift,
    issues,
    path: appendPath(path, "lift"),
    reported: entry?.lift,
  });
  validateReportedValue({
    actual: entry?.noiseFilteringRate,
    caseId,
    expected: recomputed.noiseFilteringRate,
    issues,
    path: appendPath(path, "noiseFilteringRate"),
  });
};

const averageMetrics = (entries) =>
  Object.fromEntries(
    METRIC_KEYS.map((metric) => [
      metric,
      average(entries.map((entry) => entry?.[metric])),
    ])
  );

const buildAggregate = (entries) => {
  const baselineMetrics = averageMetrics(
    entries.map((entry) => entry.baselineMetrics)
  );
  const rerankedMetrics = averageMetrics(
    entries.map((entry) => entry.rerankedMetrics)
  );

  return {
    baselineMetrics,
    rerankedMetrics,
    lift: calculateLift(baselineMetrics, rerankedMetrics),
    noiseFilteringRate: average(
      entries.map((entry) => entry.noiseFilteringRate)
    ),
    averageCandidateCount: average(
      entries.map((entry) => entry.candidateCount)
    ),
  };
};

const getCaseRankingEntries = (caseResult = {}) => {
  const rankingFields = [
    "candidateRanking",
    "baselineRanking",
    "rerankedRanking",
  ];
  const containers =
    caseResult.retrievalMode === "per-document" &&
    Array.isArray(caseResult.perDocument)
      ? caseResult.perDocument
      : [caseResult];

  return containers.flatMap((container) =>
    rankingFields.flatMap((field) =>
      Array.isArray(container?.[field]) ? container[field] : []
    )
  );
};

const validateReportWideResultIdentity = ({ cases, issues }) => {
  const identityByResultKey = new Map();
  const resultKeyByIdentity = new Map();

  cases.forEach((caseResult, caseIndex) => {
    getCaseRankingEntries(caseResult).forEach((entry) => {
      if (typeof entry?.resultKey !== "string" || !entry.resultKey.trim()) {
        return;
      }

      const resultKey = entry.resultKey.trim();
      const identity = [
        entry.docKey,
        entry.fileName,
        entry.pageNumber,
        entry.chunkIndex,
      ];
      const identityKey = JSON.stringify(identity);
      const priorIdentity = identityByResultKey.get(resultKey);
      const priorResultKey = resultKeyByIdentity.get(identityKey);

      if (priorIdentity && !samePrimitiveArray(priorIdentity, identity)) {
        issues.push(
          buildIssue({
            actual: identity,
            caseId: caseResult?.id,
            expected: priorIdentity,
            path: `cases[${caseIndex}]`,
            reasonCode: "report_result_identity_mismatch",
          })
        );
      } else if (!priorIdentity) {
        identityByResultKey.set(resultKey, identity);
      }

      if (priorResultKey && priorResultKey !== resultKey) {
        issues.push(
          buildIssue({
            actual: resultKey,
            caseId: caseResult?.id,
            expected: priorResultKey,
            path: `cases[${caseIndex}]`,
            reasonCode: "report_chunk_result_key_mismatch",
          })
        );
      } else if (!priorResultKey) {
        resultKeyByIdentity.set(identityKey, resultKey);
      }
    });
  });
};

export const validateRerankCaseRanking = (
  caseResult = {},
  {
    caseContract = null,
    documentContracts = [],
    expectedConfig = null,
    expectedReplay = null,
  } = {}
) => {
  const caseId =
    typeof caseResult.id === "string" && caseResult.id.trim()
      ? caseResult.id.trim()
      : null;
  const issues = [];
  let recomputed = null;
  const contractDocKeys = Array.isArray(caseContract?.docKeys)
    ? caseContract.docKeys
    : null;
  const contractExpectedUnits = caseContract
    ? buildExpectedEvidenceUnits(caseContract.expectedEvidence)
    : null;
  const expectedRetrievalMode = caseContract
    ? caseContract.type === "compare" && contractDocKeys?.length > 1
      ? "per-document"
      : "global"
    : null;
  const documentsByKey = new Map(
    documentContracts.map((document) => [
      document?.key,
      buildDocumentContract(document, expectedConfig ?? {}),
    ])
  );

  if (!caseId) {
    issues.push(
      buildIssue({
        actual: caseResult.id,
        expected: "non-empty string",
        path: "id",
        reasonCode: "report_case_id_invalid",
      })
    );
  }

  if (caseContract && caseResult.question !== caseContract.question) {
    issues.push(
      buildIssue({
        actual: caseResult.question,
        caseId,
        expected: caseContract.question,
        path: "question",
        reasonCode: "ranking_question_corpus_mismatch",
      })
    );
  }

  if (caseContract && caseResult.type !== caseContract.type) {
    issues.push(
      buildIssue({
        actual: caseResult.type,
        caseId,
        expected: caseContract.type,
        path: "type",
        reasonCode: "ranking_case_type_corpus_mismatch",
      })
    );
  }

  if (contractDocKeys && !samePrimitiveArray(caseResult.docKeys, contractDocKeys)) {
    issues.push(
      buildIssue({
        actual: caseResult.docKeys,
        caseId,
        expected: contractDocKeys,
        path: "docKeys",
        reasonCode: "ranking_doc_keys_corpus_mismatch",
      })
    );
  }

  if (
    expectedRetrievalMode &&
    caseResult.retrievalMode !== expectedRetrievalMode
  ) {
    issues.push(
      buildIssue({
        actual: caseResult.retrievalMode,
        caseId,
        expected: expectedRetrievalMode,
        path: "retrievalMode",
        reasonCode: "retrieval_mode_corpus_mismatch",
      })
    );
  }

  if (caseResult.retrievalMode === "global") {
    recomputed = recomputeRankingEntry({
      allowedDocKeys: contractDocKeys,
      caseId,
      candidateMultiplier: expectedConfig?.candidateMultiplier ?? null,
      documentsByKey: documentsByKey.size > 0 ? documentsByKey : null,
      entry: caseResult,
      expectedContractUnits: contractExpectedUnits,
      expectedK: expectedConfig?.topK ?? null,
      expectedReplay,
      issues,
      path: "",
    });

    if (recomputed) {
      validateReportedEntry({
        caseId,
        entry: caseResult,
        issues,
        path: "",
        recomputed,
      });
    }
  } else if (caseResult.retrievalMode === "per-document") {
    const perDocument = caseResult.perDocument;
    const normalizedTopLevelUnits = validateExpectedUnits({
      caseId,
      expectedUnits: caseResult.expectedUnits,
      issues,
      path: "expectedUnits",
    });

    validateUnitBinding({
      actualUnits: normalizedTopLevelUnits,
      caseId,
      expectedUnits: contractExpectedUnits,
      issues,
      path: "expectedUnits",
    });

    const caseK = validateK({
      caseId,
      issues,
      k: caseResult.k,
      path: "k",
    });

    if (
      caseK !== null &&
      expectedConfig?.topKPerDoc !== undefined &&
      caseK !== expectedConfig.topKPerDoc
    ) {
      issues.push(
        buildIssue({
          actual: caseK,
          caseId,
          expected: expectedConfig.topKPerDoc,
          path: "k",
          reasonCode: "ranking_k_config_mismatch",
        })
      );
    }

    if (!Array.isArray(perDocument) || perDocument.length === 0) {
      issues.push(
        buildIssue({
          actual: perDocument,
          caseId,
          expected: "non-empty array",
          path: "perDocument",
          reasonCode: "per_document_entries_invalid",
        })
      );
    } else {
      const seenDocKeys = new Set();
      const perDocumentRecomputed = [];
      const contractUnitsByDocKey = new Map();
      const expectedReplayDocKeys = expectedReplay?.perDocument?.map(
        (entry) => entry.docKey
      );

      for (const unit of contractExpectedUnits ?? []) {
        const units = contractUnitsByDocKey.get(unit.docKey) ?? [];
        units.push(unit);
        contractUnitsByDocKey.set(unit.docKey, units);
      }

      if (
        expectedReplayDocKeys &&
        !samePrimitiveArray(
          perDocument.map((entry) => entry?.docKey),
          expectedReplayDocKeys
        )
      ) {
        issues.push(
          buildIssue({
            actual: perDocument.map((entry) => entry?.docKey),
            caseId,
            expected: expectedReplayDocKeys,
            path: "perDocument",
            reasonCode: "per_document_replay_order_mismatch",
          })
        );
      }

      perDocument.forEach((entry, index) => {
        const path = `perDocument[${index}]`;
        const docKey =
          typeof entry?.docKey === "string" ? entry.docKey.trim() : "";

        if (!docKey) {
          issues.push(
            buildIssue({
              actual: entry?.docKey,
              caseId,
              expected: "non-empty string",
              path: `${path}.docKey`,
              reasonCode: "per_document_doc_key_invalid",
            })
          );
        } else if (seenDocKeys.has(docKey)) {
          issues.push(
            buildIssue({
              actual: docKey,
              caseId,
              expected: "unique per-document docKey",
              path: `${path}.docKey`,
              reasonCode: "per_document_entry_duplicate",
            })
          );
        } else {
          seenDocKeys.add(docKey);
        }

        if (
          contractUnitsByDocKey.size > 0 &&
          !contractUnitsByDocKey.has(docKey)
        ) {
          issues.push(
            buildIssue({
              actual: docKey,
              caseId,
              expected: [...contractUnitsByDocKey.keys()],
              path: `${path}.docKey`,
              reasonCode: "per_document_doc_key_corpus_mismatch",
            })
          );
        }

        const entryRecomputed = recomputeRankingEntry({
          allowedDocKeys: docKey ? [docKey] : [],
          caseId,
          candidateMultiplier: expectedConfig?.candidateMultiplier ?? null,
          documentsByKey: documentsByKey.size > 0 ? documentsByKey : null,
          entry,
          expectedContractUnits: contractUnitsByDocKey.get(docKey) ?? null,
          expectedK: expectedConfig?.topKPerDoc ?? null,
          expectedReplay: expectedReplay?.perDocument?.find(
            (candidate) => candidate.docKey === docKey
          ) ?? null,
          issues,
          path,
        });

        if (entryRecomputed) {
          validateReportedEntry({
            caseId,
            entry,
            issues,
            path,
            recomputed: entryRecomputed,
          });
          perDocumentRecomputed.push({
            docKey,
            ...entryRecomputed,
          });
        }
      });

      if (
        contractUnitsByDocKey.size > 0 &&
        !samePrimitiveArray(
          [...seenDocKeys].sort(),
          [...contractUnitsByDocKey.keys()].sort()
        )
      ) {
        issues.push(
          buildIssue({
            actual: [...seenDocKeys].sort(),
            caseId,
            expected: [...contractUnitsByDocKey.keys()].sort(),
            path: "perDocument",
            reasonCode: "per_document_partition_corpus_mismatch",
          })
        );
      }

      const expectedCandidateCount = perDocument.reduce(
        (sum, entry) =>
          sum +
          (typeof entry?.candidateCount === "number" &&
          Number.isInteger(entry.candidateCount)
            ? entry.candidateCount
            : 0),
        0
      );

      if (caseResult.candidateCount !== expectedCandidateCount) {
        issues.push(
          buildIssue({
            actual: caseResult.candidateCount,
            caseId,
            expected: expectedCandidateCount,
            path: "candidateCount",
            reasonCode: "candidate_count_mismatch",
          })
        );
      }

      if (perDocumentRecomputed.length === perDocument.length) {
        recomputed = {
          ...buildAggregate(perDocumentRecomputed),
          candidateCount: perDocumentRecomputed.reduce(
            (sum, entry) => sum + entry.candidateCount,
            0
          ),
          perDocument: perDocumentRecomputed,
        };
        validateReportedEntry({
          caseId,
          entry: caseResult,
          issues,
          path: "",
          recomputed,
        });
      }
    }
  } else {
    issues.push(
      buildIssue({
        actual: caseResult.retrievalMode,
        caseId,
        expected: "global | per-document",
        path: "retrievalMode",
        reasonCode: "retrieval_mode_invalid",
      })
    );
  }

  return {
    status: issues.length === 0 ? "pass" : "fail",
    reasonCode:
      issues.length === 0 ? "ok" : "rerank_case_ranking_invalid",
    recomputed,
    issues,
  };
};

export const validateRerankReportRankings = (
  payload = {},
  {
    caseContracts = [],
    documentContracts = [],
    expectedConfig = null,
  } = {}
) => {
  const cases = payload.cases;
  const issues = [];
  let replayContext = null;

  if (expectedConfig) {
    for (const [field, expected] of Object.entries(expectedConfig)) {
      const actual = payload.summary?.config?.[field];

      if (actual !== expected) {
        issues.push(
          buildIssue({
            actual,
            expected,
            path: `summary.config.${field}`,
            reasonCode: "ranking_config_mismatch",
          })
        );
      }
    }

    const unsupportedReplayConfig = getUnsupportedRerankReplayConfig(
      expectedConfig
    );

    if (unsupportedReplayConfig.length > 0) {
      issues.push(
        buildIssue({
          actual: unsupportedReplayConfig,
          expected:
            "deterministic/local/non-hybrid/combined/heuristic replay config",
          path: "expectedConfig",
          reasonCode: "ranking_replay_config_unsupported",
        })
      );
    } else if (
      Array.isArray(documentContracts) &&
      documentContracts.length > 0
    ) {
      try {
        replayContext = buildRerankReplayContext({
          config: expectedConfig,
          documentContracts,
        });
      } catch (error) {
        issues.push(
          buildIssue({
            actual: error?.message ?? String(error),
            expected: "replayable checked corpus",
            path: "documentContracts",
            reasonCode: "ranking_replay_setup_failed",
          })
        );
      }
    }
  }

  if (!Array.isArray(caseContracts) || caseContracts.length === 0) {
    issues.push(
      buildIssue({
        actual: caseContracts,
        expected: "non-empty checked corpus case contracts",
        path: "caseContracts",
        reasonCode: "ranking_case_contracts_missing",
      })
    );
  }

  if (!Array.isArray(documentContracts) || documentContracts.length === 0) {
    issues.push(
      buildIssue({
        actual: documentContracts,
        expected: "non-empty configured corpus document contracts",
        path: "documentContracts",
        reasonCode: "ranking_document_contracts_missing",
      })
    );
  }

  if (!Array.isArray(cases) || cases.length === 0) {
    issues.push(
      buildIssue({
        actual: cases,
        expected: "non-empty array",
        path: "cases",
        reasonCode: "report_cases_invalid",
      })
    );
    return {
      status: "fail",
      reasonCode: "rerank_report_ranking_invalid",
      metrics: null,
      cases: [],
      issues,
    };
  }

  const seenCaseIds = new Set();
  const caseContractById = new Map(
    caseContracts.map((caseContract) => [caseContract?.id, caseContract])
  );
  const caseResults = cases.map((caseResult, index) => {
    const caseId =
      typeof caseResult?.id === "string" ? caseResult.id.trim() : "";

    if (caseId && seenCaseIds.has(caseId)) {
      issues.push(
        buildIssue({
          actual: caseId,
          caseId,
          expected: "unique report case id",
          path: `cases[${index}].id`,
          reasonCode: "report_case_id_duplicate",
        })
      );
    } else if (caseId) {
      seenCaseIds.add(caseId);
    }

    const caseContract = caseContractById.get(caseId) ?? null;
    let expectedReplay = null;

    if (caseContractById.size > 0 && !caseContract) {
      issues.push(
        buildIssue({
          actual: caseId,
          caseId,
          expected: "case id from configured corpus",
          path: `cases[${index}].id`,
          reasonCode: "ranking_case_contract_missing",
        })
      );
    }


    if (caseContract && replayContext) {
      try {
        expectedReplay = replayRerankCaseRankings({
          caseContract,
          replayContext,
        });
      } catch (error) {
        issues.push(
          buildIssue({
            actual: error?.message ?? String(error),
            caseId,
            expected: "replayable checked corpus case",
            path: `cases[${index}]`,
            reasonCode: "ranking_case_replay_failed",
          })
        );
      }
    }

    const result = validateRerankCaseRanking(caseResult, {
      caseContract,
      documentContracts,
      expectedConfig,
      expectedReplay,
    });
    issues.push(...result.issues);
    return {
      id: caseId || null,
      ...result,
    };
  });
  validateReportWideResultIdentity({ cases, issues });
  const recomputedCases = caseResults
    .map((result) => result.recomputed)
    .filter(Boolean);
  const metrics =
    recomputedCases.length === cases.length
      ? (() => {
          const aggregate = buildAggregate(recomputedCases);

          return {
            baseline: aggregate.baselineMetrics,
            reranked: aggregate.rerankedMetrics,
            lift: aggregate.lift,
            noiseFilteringRate: aggregate.noiseFilteringRate,
            averageCandidateCount: aggregate.averageCandidateCount,
          };
        })()
      : null;

  return {
    status: issues.length === 0 ? "pass" : "fail",
    reasonCode:
      issues.length === 0 ? "ok" : "rerank_report_ranking_invalid",
    metrics,
    cases: caseResults,
    issues,
  };
};
