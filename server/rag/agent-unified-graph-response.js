import { buildClarificationResponse } from "./agent-response-builder.js";
import { CAPABILITY_IDS } from "./capabilities/shared.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";

// This is the public /chat shape for a completed v3 graph. The caller must
// first collect the run with its live, scoped registry and derive its answer;
// this module neither executes nodes nor decides which evidence is supported.
const SETTLED = new Set(["completed", "reused"]);
const ANSWER_STATUSES = new Set(["answered", "clarification", "abstained"]);
const WEB_SKILL_IDS = new Set([
  AGENT_SKILL_IDS.webSearch,
  `capability:${CAPABILITY_IDS.webSearch}`,
]);
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const fail = (reason) => {
  const error = new Error(`Unified graph chat response is invalid: ${reason}.`);
  error.code = "AGENT_UNIFIED_GRAPH_RESPONSE_INVALID";
  error.status = 409;
  throw error;
};

const validateResponseInputs = ({
  answer,
  collected,
  question,
  trace,
  agentSkills,
  agentObservability,
  workingMemory,
}) => {
  if (
    collected?.graphVersion !== "v3" ||
    !Array.isArray(collected.entries) ||
    !(collected.byNodeId instanceof Map) ||
    collected.entries.length !== collected.byNodeId.size ||
    collected.entries.some((entry) =>
      !isRecord(entry) || collected.byNodeId.get(entry.nodeId) !== entry
    )
  ) {
    fail("validated node-indexed v3 results are required");
  }

  if (
    !isRecord(answer) ||
    !ANSWER_STATUSES.has(answer.status) ||
    !hasText(answer.agentMode) ||
    !hasText(answer.text) ||
    !Array.isArray(answer.citations) ||
    !answer.citations.every(isRecord) ||
    !Array.isArray(answer.sourceNodeIds) ||
    new Set(answer.sourceNodeIds).size !== answer.sourceNodeIds.length ||
    !Array.isArray(answer.capabilityReceipts) ||
    (answer.selectedDocumentNodeId !== null &&
      !hasText(answer.selectedDocumentNodeId)) ||
    !hasText(question) ||
    !Array.isArray(trace) ||
    !Array.isArray(agentSkills) ||
    !isRecord(agentObservability) ||
    !isRecord(workingMemory)
  ) {
    fail("answer and public response context are required");
  }

  if (
    (answer.status === "clarification") !== isRecord(answer.clarification) ||
    (answer.status === "clarification" &&
      (answer.agentMode !== "clarification" ||
        !hasText(answer.clarification.question) ||
        !hasText(answer.clarification.reason))) ||
    (agentObservability.agentMode != null &&
      agentObservability.agentMode !== answer.agentMode)
  ) {
    fail("answer status, clarification, and observability disagree");
  }

  for (const nodeId of answer.sourceNodeIds) {
    const entry = collected.byNodeId.get(nodeId);
    if (
      !entry ||
      !SETTLED.has(entry.status) ||
      entry.result?.ok !== true ||
      !["answer", "direct", "capability"].includes(entry.category)
    ) {
      fail(`source node ${nodeId} is not a successful answer source`);
    }
  }

  const selectedDocument = answer.selectedDocumentNodeId == null
    ? null
    : collected.byNodeId.get(answer.selectedDocumentNodeId);
  if (
    answer.selectedDocumentNodeId != null &&
    (selectedDocument?.category !== "answer" ||
      selectedDocument.skillId !== AGENT_SKILL_IDS.documentRag ||
      !answer.sourceNodeIds.includes(answer.selectedDocumentNodeId) ||
      !isRecord(selectedDocument.result?.value))
  ) {
    fail("selected document does not identify a successful source node");
  }

  if (
    answer.citations.length > 0 &&
    !answer.sourceNodeIds.some((nodeId) => {
      const entry = collected.byNodeId.get(nodeId);
      return entry.category === "answer" || WEB_SKILL_IDS.has(entry.skillId);
    })
  ) {
    fail("citations have no grounded source node");
  }

  for (const receipt of answer.capabilityReceipts) {
    const entry = collected.byNodeId.get(receipt?.nodeId);
    if (
      !isRecord(receipt) ||
      !entry ||
      entry.category !== "capability" ||
      entry.skillId !== receipt.skillId ||
      entry.stepId !== receipt.stepId ||
      !answer.sourceNodeIds.includes(receipt.nodeId) ||
      receipt.text !== entry.output?.text?.trim()
    ) {
      fail("capability receipt has no matching completed source node");
    }
  }

  return { selectedDocument };
};

/**
 * Builds the stable /chat response from deriveUnifiedGraphAnswer's result.
 * A failed or interrupted graph must be handled before calling this function.
 */
export const buildUnifiedGraphChatResponse = ({
  answer,
  collected,
  question,
  trace,
  agentSkills,
  agentObservability,
  workingMemory,
} = {}) => {
  const { selectedDocument } = validateResponseInputs({
    answer,
    collected,
    question,
    trace,
    agentSkills,
    agentObservability,
    workingMemory,
  });
  const selectedRagValue = selectedDocument?.result.value ?? null;
  const hasWebSource = answer.sourceNodeIds.some((nodeId) =>
    WEB_SKILL_IDS.has(collected.byNodeId.get(nodeId).skillId)
  );
  const ragResolvedQuestion = hasText(selectedRagValue?.resolvedQuery)
    ? selectedRagValue.resolvedQuery
    : question;
  const common = {
    agentAnswer: answer.text,
    agentMode: answer.agentMode,
    agentTrace: trace,
    agentSkills,
    agentObservability: { ...agentObservability, agentMode: answer.agentMode },
    agentWorkingMemory: workingMemory,
    researchBrief: null,
    ragAnswer: answer.text,
    // These are the finalizer-projected citations, with their original document
    // or URL identity and final source ranks intact.
    ragSources: answer.citations,
    ragResolvedQuestion,
    ragMemoryApplied: Boolean(selectedRagValue?.memoryApplied),
    ragAbstained: answer.status !== "answered",
    ragAbstainReason: answer.clarification?.summary ??
      selectedRagValue?.abstainReason ?? null,
    ragGapPlan: selectedRagValue?.gapPlan ?? null,
    ragEvidenceSummary: selectedRagValue?.evidenceSummary ?? null,
    mcpAnswer: hasWebSource
      ? answer.text
      : answer.status === "clarification"
        ? "Web search not used: clarification needed."
        : ["direct", "capability"].includes(answer.agentMode)
          ? "Web search not used for this direct agent skill."
          : "Web search not used: document evidence was sufficient.",
    errors: { rag: null, mcp: null },
  };

  if (answer.status === "clarification") {
    const base = buildClarificationResponse({
      clarification: answer.clarification,
      agentMode: answer.agentMode,
      trace,
      agentSkills,
      agentObservability: common.agentObservability,
      workingMemory,
      question,
    });

    return { status: base.status, body: { ...base.body, ...common } };
  }

  return { status: 200, body: common };
};
