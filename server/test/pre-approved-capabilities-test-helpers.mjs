import { runAgentRag } from "../rag/agent.js";
import { createDefaultCapabilityRegistry } from "../rag/capabilities/index.js";

// A request carries no approvals: in production a gated Capability asks at its
// gate, and the gate is decided through the run's approval path (the step
// executor's applyApprovalAction), for the chat page and a background task
// alike. These tests drive the outer plan's inline run of a gated Capability,
// so they build the registry the agent would build from the same services and
// attach the approval to each call here.
export const createPreApprovedCapabilityRegistry = ({
  approvals,
  arxivImportService,
  ragService,
  webChatService,
}) => {
  const registry = createDefaultCapabilityRegistry({
    arxivImportService,
    ragService,
    webChatService,
  });

  return {
    ...registry,
    execute: (capabilityId, payload = {}) =>
      registry.execute(capabilityId, {
        ...payload,
        approval: payload.approval ?? approvals[capabilityId],
      }),
  };
};

export const runAgentRagWithPreApprovedCapabilities = ({ preApproved, ...request }) =>
  runAgentRag({
    ...request,
    capabilityRegistry: createPreApprovedCapabilityRegistry({
      approvals: preApproved,
      arxivImportService: request.arxivImportService,
      ragService: request.ragService,
      webChatService: request.webChatService,
    }),
  });
