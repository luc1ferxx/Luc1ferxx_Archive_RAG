import { normalizeText } from "../lib/normalize-text.js";

export const AGENT_INTERRUPT_TYPES = Object.freeze({
  capabilityApprovalRequired: "capability_approval_required",
});

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const privateInterruptDetails = new WeakMap();

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

export const setAgentRunInterruptPrivateDetail = (error, detail = {}) => {
  if (
    error &&
    typeof error === "object" &&
    detail &&
    typeof detail === "object" &&
    !Array.isArray(detail)
  ) {
    privateInterruptDetails.set(error, detail);
  }

  return error;
};

export const getAgentRunInterruptPrivateDetail = (error) =>
  privateInterruptDetails.get(error) ?? null;

export const isAgentRunInterrupt = (error) =>
  Boolean(error?.agentRunInterrupt && normalizeText(error.type));
