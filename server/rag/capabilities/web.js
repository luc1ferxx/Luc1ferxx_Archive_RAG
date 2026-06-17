import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
} from "./shared.js";

export const createWebSearchCapability = ({ webChatService } = {}) => ({
  id: CAPABILITY_IDS.webSearch,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Web Search",
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      question: {
        type: "string",
      },
    },
  },
  accessScope: {
    required: false,
  },
  approvalPolicy: {
    mode: "user_confirmation",
    writesWorkspace: false,
    userConfirmationRequired: true,
  },
  privacyPolicy: {
    externalCall: true,
    sanitizedInputFields: ["question"],
    storesResult: false,
  },
  execute: async ({ input }) => webChatService(input.question),
});
