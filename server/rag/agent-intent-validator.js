export const normalizeIntentText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

export const normalizePlannerId = (plannerAdapter) =>
  normalizeIntentText(plannerAdapter?.id) || "unknown";

export const serializePlannerError = (error) =>
  normalizeIntentText(error instanceof Error ? error.message : error).slice(0, 500);

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeModelRoute = (modelRoute = null) => {
  if (!modelRoute || typeof modelRoute !== "object" || Array.isArray(modelRoute)) {
    return null;
  }

  return {
    candidateModelIds: toArray(modelRoute.candidateModelIds).map(normalizeIntentText),
    capability: normalizeIntentText(modelRoute.capability),
    fallbackModelIds: toArray(modelRoute.fallbackModelIds).map(normalizeIntentText),
    modelId: normalizeIntentText(modelRoute.modelId) || null,
    providerId: normalizeIntentText(modelRoute.providerId) || null,
    rejectedModelIds: toArray(modelRoute.rejectedModelIds).map(normalizeIntentText),
    routeId: normalizeIntentText(modelRoute.routeId) || null,
    status: normalizeIntentText(modelRoute.status) || "unknown",
  };
};

export const compactPlanCandidate = (candidate = {}) => {
  const plan = candidate.plan ?? {};

  return {
    id: candidate.id,
    mode: plan.mode ?? null,
    reason: candidate.reason ?? null,
    requiresDocuments: Boolean(plan.requiresDocuments),
    skillChain: Array.isArray(plan.skillChain) ? plan.skillChain : [],
    summary: plan.summary ?? candidate.summary ?? null,
    wants: {
      arxivImport: Boolean(plan.wantsArxivImport),
      compareDocuments: Boolean(plan.wantsCompareDocuments),
      contractSummary: Boolean(plan.wantsContractSummary),
      discovery: Boolean(plan.wantsDiscovery),
      documentRag: Boolean(plan.wantsDocumentRag),
      inventory: Boolean(plan.wantsInventory),
      research: Boolean(plan.wantsResearch),
      riskReview: Boolean(plan.wantsRiskReview),
      timeline: Boolean(plan.wantsTimeline),
      web: Boolean(plan.wantsWeb),
    },
  };
};

export const normalizeIntentSelection = (selection) => {
  if (typeof selection === "string") {
    return {
      modelRoute: null,
      selectedIntentId: normalizeIntentText(selection),
      reason: null,
    };
  }

  if (!selection || typeof selection !== "object") {
    return {
      modelRoute: null,
      selectedIntentId: "",
      reason: null,
    };
  }

  return {
    modelRoute: normalizeModelRoute(selection.modelRoute),
    selectedIntentId: normalizeIntentText(
      selection.selectedIntentId ?? selection.intentId ?? selection.id
    ),
    reason: normalizeIntentText(selection.reason),
  };
};

export const resolveSelectedCandidate = ({ candidates = [], selection } = {}) => {
  const normalizedSelection = normalizeIntentSelection(selection);
  const selectedCandidate = candidates.find(
    (candidate) => candidate.id === normalizedSelection.selectedIntentId
  );

  if (!selectedCandidate) {
    throw new Error(
      `Invalid AgentRAG intent selection: ${
        normalizedSelection.selectedIntentId || "none"
      }.`
    );
  }

  return {
    modelRoute: normalizedSelection.modelRoute,
    selectedCandidate,
    selectionReason: normalizedSelection.reason,
  };
};

export const buildPlannerSelection = ({
  candidates,
  experienceMemory,
  fallback = false,
  fallbackReason = null,
  requestedPlannerId,
  selectedCandidate,
  selectedPlannerId,
  modelRoute = null,
  selectionReason = null,
}) => {
  const normalizedModelRoute = normalizeModelRoute(modelRoute);
  const planner = {
    candidateIntentIds: candidates.map((candidate) => candidate.id),
    experienceMemory: {
      applied: Boolean(experienceMemory?.memoryApplied),
      hintCount: experienceMemory?.planningHints?.length ?? 0,
    },
    fallback,
    fallbackReason: fallbackReason ? serializePlannerError(fallbackReason) : null,
    requestedPlannerId,
    selectedIntentId: selectedCandidate?.id ?? null,
    selectedMode: selectedCandidate?.plan?.mode ?? null,
    selectedPlannerId,
    selectionReason: normalizeIntentText(selectionReason) || null,
    status: fallback ? "fallback" : "selected",
  };

  return normalizedModelRoute
    ? {
        ...planner,
        modelRoute: normalizedModelRoute,
      }
    : planner;
};
