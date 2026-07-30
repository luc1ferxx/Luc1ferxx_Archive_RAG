import {
  buildRecoveryObservabilityCases,
} from "./recovery-observability-cases.js";

const toArray = (value) => (Array.isArray(value) ? value : []);

const isObject = (value) =>
  value !== null && typeof value === "object";

const collectProjectionMismatches = ({
  actual,
  expected,
  path = "response",
}) => {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [
        {
          actual: actual ?? null,
          expected,
          path,
        },
      ];
    }

    if (actual.length !== expected.length) {
      return [
        {
          actual: {
            length: actual.length,
          },
          expected: {
            length: expected.length,
          },
          path,
        },
      ];
    }

    return expected.flatMap((expectedItem, index) =>
      collectProjectionMismatches({
        actual: actual[index],
        expected: expectedItem,
        path: `${path}[${index}]`,
      })
    );
  }

  if (isObject(expected)) {
    if (!isObject(actual) || Array.isArray(actual)) {
      return [
        {
          actual: actual ?? null,
          expected,
          path,
        },
      ];
    }

    return Object.entries(expected).flatMap(
      ([key, expectedValue]) =>
        collectProjectionMismatches({
          actual: actual[key],
          expected: expectedValue,
          path: `${path}.${key}`,
        })
    );
  }

  return Object.is(actual, expected)
    ? []
    : [
        {
          actual: actual ?? null,
          expected: expected ?? null,
          path,
        },
      ];
};

const toRecoveryCaseProjection = (caseResult) => ({
  checks: toArray(caseResult?.checks).map((check) => ({
    id: check?.id ?? null,
    passed: check?.passed === true,
  })),
  failedCheckCount: caseResult?.failedCheckCount ?? null,
  id: caseResult?.id ?? null,
  passed: caseResult?.passed === true,
  response: caseResult?.response ?? null,
});

const validateResponseProjections = ({
  cases,
  responseProjectionByCase,
}) => {
  if (!responseProjectionByCase) {
    return [];
  }

  const casesById = new Map(
    toArray(cases).map((caseResult) => [
      caseResult?.id,
      caseResult,
    ])
  );
  const errors = [];

  for (const [caseId, expectedProjection] of Object.entries(
    responseProjectionByCase
  )) {
    const caseResult = casesById.get(caseId);
    const mismatches = collectProjectionMismatches({
      actual: caseResult?.response,
      expected: expectedProjection,
    });

    if (mismatches.length > 0) {
      errors.push({
        actual: mismatches,
        expected: "versioned raw response projection",
        id: `case.${caseId}.response_contract`,
      });
    }
  }

  return errors;
};

const validateRecoveryRecomputation = ({ cases, report }) => {
  const recovery =
    isObject(report?.recovery) && !Array.isArray(report.recovery)
      ? report.recovery
      : {};
  const recomputedCases = buildRecoveryObservabilityCases({
    recovery,
  });
  const actualProjection = toArray(cases).map(
    toRecoveryCaseProjection
  );
  const recomputedProjection = recomputedCases.map(
    toRecoveryCaseProjection
  );

  return JSON.stringify(actualProjection) ===
    JSON.stringify(recomputedProjection)
    ? []
    : [
        {
          actual: actualProjection,
          expected: recomputedProjection,
          id: "recovery.recomputed_cases",
        },
      ];
};

export const validateCheckSuiteRawIntegrity = ({
  cases,
  manifest,
  report,
  specId,
}) => [
  ...validateResponseProjections({
    cases,
    responseProjectionByCase:
      manifest?.responseProjectionByCase,
  }),
  ...(specId === "recovery"
    ? validateRecoveryRecomputation({
        cases,
        report,
      })
    : []),
];
