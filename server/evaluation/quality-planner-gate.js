const toPlannerPayloads = ({
  latestPlannerPayload = null,
  latestPlannerPayloads = null,
} = {}) => {
  if (Array.isArray(latestPlannerPayloads)) {
    return latestPlannerPayloads.filter(Boolean);
  }

  return latestPlannerPayload ? [latestPlannerPayload] : [];
};

const buildPlannerProviderGate = ({ latestPlannerPayload = null } = {}) => {
  if (!latestPlannerPayload) {
    return {
      status: "pass",
      skipped: true,
      currentRunId: null,
      provider: null,
      failedCaseCount: 0,
      failedCheckCount: 0,
      caseCount: 0,
      checkCount: 0,
      failedCases: [],
      summary: "No planner evaluation report is available; planner gate skipped.",
    };
  }

  const summary = latestPlannerPayload.summary ?? {};
  const metrics = summary.metrics ?? {};
  const cases = Array.isArray(latestPlannerPayload.cases)
    ? latestPlannerPayload.cases
    : [];
  const failedCases = cases
    .filter((caseResult) => !caseResult.passed)
    .map((caseResult) => ({
      id: caseResult.id,
      label: caseResult.label,
      failedCheckCount: caseResult.failedCheckCount ?? 0,
      failedChecks: (caseResult.checks ?? [])
        .filter((check) => !check.passed)
        .map((check) => ({
          id: check.id,
          label: check.label,
          category: check.category,
          detail: check.detail ?? null,
        })),
    }));
  const failedCaseCount = metrics.failedCaseCount ?? failedCases.length;
  const failedCheckCount = metrics.failedCheckCount ??
    failedCases.reduce(
      (sum, caseResult) =>
        sum + (caseResult.failedChecks?.length ?? caseResult.failedCheckCount ?? 0),
      0
    );
  const caseCount = metrics.caseCount ?? cases.length;
  const checkCount = metrics.checkCount ??
    cases.reduce((sum, caseResult) => sum + (caseResult.checks?.length ?? 0), 0);
  const provider = summary.provider ?? "unknown";
  const status =
    failedCaseCount > 0 || failedCheckCount > 0 || summary.status === "fail"
      ? "fail"
      : "pass";

  return {
    status,
    skipped: false,
    currentRunId: summary.runId ?? null,
    provider,
    failedCaseCount,
    failedCheckCount,
    caseCount,
    checkCount,
    failedCases,
    summary:
      status === "fail"
        ? `Planner evaluation (${provider}) failed ${failedCaseCount} of ${caseCount} case${
            caseCount === 1 ? "" : "s"
          } and ${failedCheckCount} of ${checkCount} check${
            checkCount === 1 ? "" : "s"
          }.`
        : `Planner evaluation (${provider}) passed all ${caseCount} case${
            caseCount === 1 ? "" : "s"
          } and ${checkCount} check${checkCount === 1 ? "" : "s"}.`,
  };
};

export const buildPlannerGate = ({
  latestPlannerPayload = null,
  latestPlannerPayloads = null,
} = {}) => {
  const payloads = toPlannerPayloads({
    latestPlannerPayload,
    latestPlannerPayloads,
  });

  if (payloads.length <= 1) {
    return buildPlannerProviderGate({
      latestPlannerPayload: payloads[0] ?? null,
    });
  }

  const providerGates = payloads.map((payload) =>
    buildPlannerProviderGate({
      latestPlannerPayload: payload,
    })
  );
  const failedCaseCount = providerGates.reduce(
    (sum, gate) => sum + (gate.failedCaseCount ?? 0),
    0
  );
  const failedCheckCount = providerGates.reduce(
    (sum, gate) => sum + (gate.failedCheckCount ?? 0),
    0
  );
  const caseCount = providerGates.reduce(
    (sum, gate) => sum + (gate.caseCount ?? 0),
    0
  );
  const checkCount = providerGates.reduce(
    (sum, gate) => sum + (gate.checkCount ?? 0),
    0
  );
  const providers = providerGates
    .map((gate) => gate.provider)
    .filter(Boolean);
  const currentRunIds = providerGates
    .map((gate) => gate.currentRunId)
    .filter(Boolean);
  const failedCases = providerGates.flatMap((gate) =>
    (gate.failedCases ?? []).map((failedCase) => ({
      ...failedCase,
      provider: gate.provider,
    }))
  );
  const status = failedCaseCount > 0 || failedCheckCount > 0 ? "fail" : "pass";
  const providerLabel = providers.join(", ");

  return {
    status,
    skipped: false,
    currentRunId: currentRunIds[0] ?? null,
    currentRunIds,
    provider: providerLabel,
    providers,
    failedCaseCount,
    failedCheckCount,
    caseCount,
    checkCount,
    failedCases,
    providerGates,
    summary:
      status === "fail"
        ? `Planner evaluations (${providerLabel}) failed ${failedCaseCount} of ${caseCount} case${
            caseCount === 1 ? "" : "s"
          } and ${failedCheckCount} of ${checkCount} check${
            checkCount === 1 ? "" : "s"
          }.`
        : `Planner evaluations (${providerLabel}) passed all ${caseCount} case${
            caseCount === 1 ? "" : "s"
          } and ${checkCount} check${checkCount === 1 ? "" : "s"}.`,
  };
};

export const buildPlannerGateChecks = ({ plannerGate = {} } = {}) =>
  plannerGate.skipped
    ? []
    : [
        {
          metric: "plannerFailedCaseCount",
          label: "Planner failed cases",
          status: (plannerGate.failedCaseCount ?? 0) > 0 ? "fail" : "pass",
          currentValue: plannerGate.failedCaseCount ?? 0,
          baselineValue: 0,
          delta: plannerGate.failedCaseCount ?? 0,
        },
        {
          metric: "plannerFailedCheckCount",
          label: "Planner failed checks",
          status: (plannerGate.failedCheckCount ?? 0) > 0 ? "fail" : "pass",
          currentValue: plannerGate.failedCheckCount ?? 0,
          baselineValue: 0,
          delta: plannerGate.failedCheckCount ?? 0,
        },
      ];
