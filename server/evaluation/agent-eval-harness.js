export const createEvalTelemetry = () => ({
  chatCalls: [],
  listDocumentScopes: [],
});

export const createAccessScopeMatcher = (expectedScope = {}) => (scope) =>
  scope?.userId === expectedScope.userId &&
  scope?.workspaceId === expectedScope.workspaceId;

export const buildCheck = ({ id, label, category, passed, detail = null }) => ({
  id,
  label,
  category,
  passed: Boolean(passed),
  detail,
});

export const buildSource = ({
  docId = "doc-1",
  fileName = "document.pdf",
  pageNumber = 1,
  excerpt,
} = {}) => ({
  docId,
  fileName,
  pageNumber,
  excerpt,
});

export const buildScopedRagService = ({
  chat,
  documents = [],
  sameScope = () => true,
  telemetry = createEvalTelemetry(),
}) => ({
  chat: async (docIds, question, options = {}) => {
    telemetry.chatCalls.push({
      accessScope: options.accessScope ?? null,
      docIds,
      question,
      retrievalPlan: options.retrievalPlan ?? null,
    });

    return chat({
      callIndex: telemetry.chatCalls.length,
      docIds,
      options,
      question,
    });
  },
  listDocuments: (accessScope) => {
    telemetry.listDocumentScopes.push(accessScope ?? null);

    return sameScope(accessScope) ? documents : [];
  },
});

export const finishCase = ({
  buildResponseSummary,
  checks,
  description,
  id,
  label,
  response,
  telemetry = createEvalTelemetry(),
}) => {
  const failedChecks = checks.filter((check) => !check.passed);

  return {
    checks,
    description,
    failedCheckCount: failedChecks.length,
    id,
    label,
    passed: failedChecks.length === 0,
    response: buildResponseSummary({
      response,
      telemetry,
    }),
  };
};

export const createCaseFinisher = ({ buildResponseSummary }) => (caseResult) =>
  finishCase({
    ...caseResult,
    buildResponseSummary,
  });

export const runCaseSafely = async (
  caseDefinition,
  {
    errorCategory = "execution",
    errorLabel = "Case completed without throwing",
    finishCase: finishEvalCase,
  } = {}
) => {
  try {
    return await caseDefinition.run();
  } catch (error) {
    return finishEvalCase({
      checks: [
        buildCheck({
          category: errorCategory,
          detail: error instanceof Error ? error.message : String(error),
          id: "case_error",
          label: errorLabel,
          passed: false,
        }),
      ],
      description: caseDefinition.description,
      id: caseDefinition.id,
      label: caseDefinition.label,
      response: null,
      telemetry: createEvalTelemetry(),
    });
  }
};

const ratio = ({ numerator, denominator }) =>
  denominator === 0 ? null : Number((numerator / denominator).toFixed(4));

export const buildMetricSummary = ({
  caseResults = [],
  categoryLabels = {},
} = {}) => {
  const checks = caseResults.flatMap((caseResult) => caseResult.checks);
  const categoryEntries = Object.entries(categoryLabels).map(
    ([category, label]) => {
      const categoryChecks = checks.filter((check) => check.category === category);
      const passedCheckCount = categoryChecks.filter((check) => check.passed)
        .length;

      return [
        category,
        {
          checkCount: categoryChecks.length,
          failedCheckCount: categoryChecks.length - passedCheckCount,
          label,
          passedCheckCount,
          passRate: ratio({
            denominator: categoryChecks.length,
            numerator: passedCheckCount,
          }),
        },
      ];
    }
  );
  const passedCaseCount = caseResults.filter((caseResult) => caseResult.passed)
    .length;
  const passedCheckCount = checks.filter((check) => check.passed).length;

  return {
    caseCount: caseResults.length,
    checkCount: checks.length,
    checkPassRate: ratio({
      denominator: checks.length,
      numerator: passedCheckCount,
    }),
    categories: Object.fromEntries(categoryEntries),
    failedCaseCount: caseResults.length - passedCaseCount,
    failedCheckCount: checks.length - passedCheckCount,
    overallPassRate: ratio({
      denominator: caseResults.length,
      numerator: passedCaseCount,
    }),
    passedCaseCount,
    passedCheckCount,
  };
};

export const formatPercent = (value) =>
  typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "N/A";

export const appendCategoryMetricsTable = ({ categories = {}, lines }) => {
  lines.push(
    "",
    "## Category Metrics",
    "",
    "| Category | Passed | Failed | Pass rate |",
    "| --- | ---: | ---: | ---: |"
  );

  for (const [category, categoryMetrics] of Object.entries(categories)) {
    lines.push(
      `| ${categoryMetrics.label ?? category} | ${
        categoryMetrics.passedCheckCount ?? 0
      } | ${categoryMetrics.failedCheckCount ?? 0} | ${formatPercent(
        categoryMetrics.passRate
      )} |`
    );
  }
};

export const appendCaseCheckTable = ({
  categoryLabels = {},
  checks = [],
  lines,
}) => {
  lines.push("", "| Check | Category | Status |", "| --- | --- | --- |");

  for (const check of checks) {
    lines.push(
      `| ${check.label} | ${categoryLabels[check.category] ?? check.category} | ${
        check.passed ? "pass" : "fail"
      } |`
    );
  }
};
