import {
  DEFAULT_ARXIV_MAX_RESULTS,
  normalizeArxivMaxResults,
} from "../arxiv-client.js";
import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
  normalizeText,
} from "./shared.js";

export const createArxivImportTopicCapability = ({ arxivImportService } = {}) => ({
  id: CAPABILITY_IDS.arxivImportTopic,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "arXiv Topic Import",
  inputSchema: {
    type: "object",
    required: ["topic"],
    properties: {
      maxResults: {
        type: "integer",
      },
      topic: {
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
    sanitizedInputFields: ["topic", "maxResults"],
    storesResult: true,
  },
  execute: async ({ accessScope, input }) =>
    arxivImportService.importTopic({
      accessScope,
      maxResults: normalizeArxivMaxResults(
        input.maxResults,
        DEFAULT_ARXIV_MAX_RESULTS
      ),
      topic: normalizeText(input.topic),
    }),
});
