import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
  normalizeText,
  normalizeTextList,
  toArray,
} from "./shared.js";

const getProvider = (value) => normalizeText(value).toLowerCase();

const formatRecommendationImportText = ({ provider, result = {} } = {}) => {
  const importedCount = Number(result.importedCount ?? 0) || 0;
  const skippedCount = Number(result.skippedCount ?? 0) || 0;
  const failedCount = Number(result.failedCount ?? 0) || 0;
  const providerLabel = provider === "arxiv" ? "arXiv" : provider || "provider";

  return `Imported selected ${providerLabel} recommendations: ${importedCount} imported, ${skippedCount} skipped, ${failedCount} failed.`;
};

const getRecommendationCitations = (result = {}) =>
  [
    ...toArray(result.importedPapers),
    ...toArray(result.skippedPapers),
  ].map((paper) => ({
    arxivId: paper.arxivId,
    docId: paper.docId,
    fileName: paper.fileName,
    title: paper.title,
    url: paper.absUrl,
  }));

export const createRecommendationImportSelectedCapability = ({
  arxivEnrichmentService,
  recommendationImportService,
} = {}) => ({
  id: CAPABILITY_IDS.recommendationImportSelected,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Recommendation Import",
  inputSchema: {
    type: "object",
    required: ["provider", "docId", "selectionToken"],
    properties: {
      docId: {
        type: "string",
      },
      provider: {
        type: "string",
      },
      selectedArxivIds: {
        items: {
          type: "string",
        },
        type: "array",
      },
      selectedIds: {
        items: {
          type: "string",
        },
        type: "array",
      },
      selectionToken: {
        type: "string",
      },
    },
  },
  accessScope: {
    required: true,
  },
  approvalPolicy: {
    mode: "user_confirmation",
    writesWorkspace: true,
    userConfirmationRequired: true,
  },
  privacyPolicy: {
    externalCall: true,
    sanitizedInputFields: ["provider", "docId", "selectedIds", "selectedArxivIds"],
    storesResult: true,
  },
  execute: async ({ accessScope, input }) => {
    const provider = getProvider(input.provider);
    const selectedIds =
      normalizeTextList(input.selectedIds).length > 0
        ? normalizeTextList(input.selectedIds)
        : normalizeTextList(input.selectedArxivIds);
    let result;

    if (recommendationImportService?.importSelected) {
      result = await recommendationImportService.importSelected({
        accessScope,
        docId: normalizeText(input.docId),
        provider,
        selectedIds,
        selectionToken: normalizeText(input.selectionToken),
      });
    } else if (provider === "arxiv" && arxivEnrichmentService?.importForDocument) {
      result = await arxivEnrichmentService.importForDocument({
        accessScope,
        docId: normalizeText(input.docId),
        selectedArxivIds: selectedIds.length > 0 ? selectedIds : undefined,
        selectionToken: normalizeText(input.selectionToken),
      });
    } else {
      const error = new Error(
        `Unsupported recommendation provider for import: ${provider || "unknown"}.`
      );
      error.status = 400;
      throw error;
    }

    return {
      ...result,
      citations: getRecommendationCitations(result),
      text:
        normalizeText(result?.text) ||
        formatRecommendationImportText({
          provider,
          result,
        }),
    };
  },
});
