import { summarizeQualityCaseResults } from "./quality-case-results.js";

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
  const caseSummary = summarizeQualityCaseResults({
    cases: latestPlannerPayload.cases,
    metrics,
  });
  const provider = summary.provider ?? "unknown";
  const status =
    caseSummary.failedCaseCount > 0 ||
    caseSummary.failedCheckCount > 0 ||
    summary.status === "fail"
      ? "fail"
      : "pass";

  return {
    status,
    skipped: false,
    failedProviderCount: status === "fail" ? 1 : 0,
    currentRunId: summary.runId ?? null,
    provider,
    failedCaseCount: caseSummary.failedCaseCount,
    failedCheckCount: caseSummary.failedCheckCount,
    caseCount: caseSummary.caseCount,
    checkCount: caseSummary.checkCount,
    failedCases: caseSummary.failedCases,
    summary:
      status === "fail"
        ? `Planner evaluation (${provider}) failed ${caseSummary.failedCaseCount} of ${caseSummary.caseCount} case${
            caseSummary.caseCount === 1 ? "" : "s"
          } and ${caseSummary.failedCheckCount} of ${caseSummary.checkCount} check${
            caseSummary.checkCount === 1 ? "" : "s"
          }.`
        : `Planner evaluation (${provider}) passed all ${caseSummary.caseCount} case${
            caseSummary.caseCount === 1 ? "" : "s"
          } and ${caseSummary.checkCount} check${
            caseSummary.checkCount === 1 ? "" : "s"
          }.`,
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
  const failedProviderCount = providerGates.filter(
    (gate) => gate.status === "fail"
  ).length;
  const status =
    failedProviderCount > 0 || failedCaseCount > 0 || failedCheckCount > 0
      ? "fail"
      : "pass";
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
    failedProviderCount,
    caseCount,
    checkCount,
    failedCases,
    providerGates,
    summary:
      status === "fail" && failedCaseCount + failedCheckCount > 0
        ? `Planner evaluations (${providerLabel}) failed ${failedCaseCount} of ${caseCount} case${
            caseCount === 1 ? "" : "s"
          } and ${failedCheckCount} of ${checkCount} check${
            checkCount === 1 ? "" : "s"
          }.`
        : status === "fail"
          ? `Planner evaluations (${providerLabel}) include ${failedProviderCount} failing provider report${
              failedProviderCount === 1 ? "" : "s"
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
          metric: "plannerFailedProviderCount",
          label: "Planner failed providers",
          status: (plannerGate.failedProviderCount ?? 0) > 0 ? "fail" : "pass",
          currentValue: plannerGate.failedProviderCount ?? 0,
          baselineValue: 0,
          delta: plannerGate.failedProviderCount ?? 0,
        },
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
