import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
} from "./shared.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
  SKILL_VALUE_TYPES,
} from "../skills/skill-contract.js";

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
  executionGraph: {
    budgetKey: "webSearchCalls",
    effects: SKILL_EFFECTS.externalRead,
    idempotency: SKILL_IDEMPOTENCY.nondeterministic,
    inputSchema: {
      question: { required: true, type: SKILL_VALUE_TYPES.string },
    },
    outputSchema: {
      text: { required: true, type: SKILL_VALUE_TYPES.string },
      citations: { required: true, type: SKILL_VALUE_TYPES.citationArray },
      abstained: { required: true, type: SKILL_VALUE_TYPES.boolean },
    },
    parallelSafe: false,
    replaySafe: false,
    retryable: false,
    plannerSummary: "Search the external Web after a runtime-owned user confirmation.",
    projectOutput: (value) => ({
      text: value?.text,
      citations: value?.citations ?? [],
      abstained: value?.abstained ?? false,
    }),
  },
  execute: async ({ input }) => webChatService(input.question),
});
