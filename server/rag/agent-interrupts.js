export const AGENT_INTERRUPT_TYPES = Object.freeze({
  capabilityApprovalRequired: "capability_approval_required",
});

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

export class AgentRunInterruptError extends Error {
  constructor({
    detail = {},
    message = "Agent run requires user input.",
    publicMessage,
    type,
  } = {}) {
    super(normalizeText(message) || "Agent run requires user input.");
    this.name = "AgentRunInterruptError";
    this.agentRunInterrupt = true;
    this.type = normalizeText(type);
    this.publicMessage = normalizeText(publicMessage) || this.message;
    this.detail = normalizeRecord(detail);
  }
}

export const isAgentRunInterrupt = (error) =>
  Boolean(error?.agentRunInterrupt && normalizeText(error.type));
