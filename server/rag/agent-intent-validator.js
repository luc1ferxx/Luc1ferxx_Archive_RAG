export const normalizeIntentText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

export const normalizePlannerId = (plannerAdapter) =>
  normalizeIntentText(plannerAdapter?.id) || "unknown";

export const serializePlannerError = (error) =>
  normalizeIntentText(error instanceof Error ? error.message : error).slice(0, 500);

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
      selectedIntentId: normalizeIntentText(selection),
      reason: null,
    };
  }

  if (!selection || typeof selection !== "object") {
    return {
      selectedIntentId: "",
      reason: null,
    };
  }

  return {
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
  selectionReason = null,
}) => ({
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
});
