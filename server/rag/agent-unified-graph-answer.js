import { buildGroundedAbstention, finalizeAgentAnswer } from "./agent-finalizer.js";
import { evaluateFinalAnswerEvidence } from "./agent-answer-verification.js";
import { buildEvidenceClarification } from "./agent-response-builder.js";
import { projectGroundedAnswer } from "./grounded-answer-projection.js";
import { attachRetrievedEvidence } from "./citations.js";
import { selectBetterRagResult } from "./agent-self-check.js";
import { rebaseEvidenceResults } from "./source-labels.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";
import { CAPABILITY_IDS } from "./capabilities/shared.js";

// A completed v3 graph can have several results for the same Skill. This
// boundary consumes collectUnifiedGraphResults' node-indexed output, never a
// V1 plan mode or singleton RAG/Web projection. It does not execute or persist.
const SETTLED = new Set(["completed", "reused"]);
const WEB_CAPABILITY_ID = `capability:${CAPABILITY_IDS.webSearch}`;
const RECEIPT_CAPABILITY_IDS = new Set([
  `capability:${CAPABILITY_IDS.taskCreate}`,
]);
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const fail = (reason) => {
  const error = new Error(`Unified graph answer is invalid: ${reason}.`);
  error.code = "AGENT_UNIFIED_GRAPH_ANSWER_INVALID";
  error.status = 409;
  throw error;
};

const assertCollected = (collected) => {
  if (
    collected?.graphVersion !== "v3" ||
    !Array.isArray(collected.entries) ||
    !(collected.byNodeId instanceof Map) ||
    !isRecord(collected.groups) ||
    collected.entries.length !== collected.byNodeId.size ||
    collected.entries.some((entry) =>
      !isRecord(entry) ||
      collected.byNodeId.get(entry.nodeId) !== entry ||
      !["answer", "control", "direct", "capability"].includes(entry.category) ||
      ![...SETTLED, "skipped"].includes(entry.status) ||
      (SETTLED.has(entry.status) &&
        (!entry.result?.ok || !isRecord(entry.output) || !hasText(entry.stepId)))
    )
  ) {
    fail("a complete collected v3 result is required");
  }
};

const selectCheckedDocument = (collected) => {
  const documents = collected.entries.filter((entry) =>
    entry.category === "answer" &&
    entry.skillId === AGENT_SKILL_IDS.documentRag &&
    SETTLED.has(entry.status)
  );
  const checks = new Map();

  for (const entry of collected.entries) {
    if (entry.category !== "control" || !SETTLED.has(entry.status)) continue;
    if (entry.skillId !== AGENT_SKILL_IDS.documentEvidenceCheck) {
      fail(`unsupported control node ${entry.nodeId}`);
    }
    if (checks.has(entry.sourceDocumentNodeId)) {
      fail(`document ${entry.sourceDocumentNodeId} has ambiguous evidence checks`);
    }
    checks.set(entry.sourceDocumentNodeId, entry);
  }

  let selected = null;
  let bestFailure = null;

  for (const document of documents) {
    const check = checks.get(document.nodeId);
    if (!check) continue;

    if (!bestFailure || selectBetterRagResult({
      primary: bestFailure.document.result,
      retry: document.result,
    }) === document.result) {
      bestFailure = { document, check };
    }

    if (check.output.passed !== true || document.output.abstained) continue;
    if (!selected || selectBetterRagResult({
      primary: selected.document.result,
      retry: document.result,
    }) === document.result) {
      selected = { document, check };
    }
  }

  return { documents, selected, bestFailure };
};

const verifiedGroundedAnswer = (entries) => {
  if (entries.length === 0) return null;

  const evidenceInputs = entries.map((entry) => ({
    text: entry.result.text,
    citations: attachRetrievedEvidence({
      citations: entry.result.citations,
      retrievedContexts:
        entry.skillId === AGENT_SKILL_IDS.documentRag
          ? entry.result.value.retrievedContexts ?? []
          : entry.result.retrievedContexts ??
            entry.result.value?.retrievedContexts ?? [],
    }),
  }));
  const rebased = rebaseEvidenceResults(evidenceInputs);
  const answerText = rebased.results.map((result) => result.text.trim()).join("\n\n");
  const comparisonAnalysisSummary = entries.length === 1
    ? entries[0].result.value?.comparisonAnalysisSummary ??
      entries[0].result.comparisonAnalysisSummary ?? null
    : null;
  const finalizer = finalizeAgentAnswer({
    answerText,
    citations: rebased.citations,
    evidenceCitations: rebased.citations,
    comparisonAnalysisSummary,
  });
  const projected = projectGroundedAnswer({
    text: finalizer.text,
    citations: rebased.citations,
    retrievedContexts: rebased.citations
      .filter((citation) => hasText(citation.evidenceText))
      .map((citation) => ({ ...citation, text: citation.evidenceText })),
    claimSupport: finalizer.claimSupport,
  });
  const check = evaluateFinalAnswerEvidence({
    answerText: projected.text,
    citations: projected.citations,
    evidenceCitations: projected.citations,
    comparisonAnalysisSummary,
  });

  if (finalizer.abstained || !check.passed) {
    return {
      accepted: false,
      check,
      finalizer: buildGroundedAbstention({
        answerText,
        claimSupport: check.claimSupport ?? finalizer.claimSupport,
      }),
    };
  }

  return {
    accepted: true,
    check,
    finalizer: {
      ...finalizer,
      text: projected.text,
      claimSupport: projected.claimSupport,
    },
    text: projected.text,
    citations: projected.citations.map(({ evidenceText: _evidenceText, ...citation }) =>
      citation
    ),
    retrievedContexts: projected.retrievedContexts,
    sourceNodeIds: entries
      .filter((_entry, index) => rebased.results[index].citations.some((citation) =>
        projected.sourceRankMap.has(citation.rank)
      ))
      .map((entry) => entry.nodeId),
  };
};

const deriveMode = ({ documentAttempted, groundedEntries, directEntries, capabilityEntries }) => {
  const hasDocument = groundedEntries.some((entry) =>
    entry.skillId === AGENT_SKILL_IDS.documentRag
  );
  const hasWeb = groundedEntries.some((entry) =>
    entry.skillId === AGENT_SKILL_IDS.webSearch ||
    entry.skillId === WEB_CAPABILITY_ID
  );
  const hasCustom = groundedEntries.some((entry) =>
    entry.skillId !== AGENT_SKILL_IDS.documentRag &&
    entry.skillId !== AGENT_SKILL_IDS.webSearch &&
    entry.skillId !== WEB_CAPABILITY_ID
  );
  const types = [hasDocument, hasWeb, hasCustom, directEntries.length > 0,
    capabilityEntries.length > 0].filter(Boolean).length;
  if (types > 1 && !(hasDocument && hasWeb && types === 2)) return "mixed";
  if (hasDocument && hasWeb) return "document_web";
  if (hasDocument) return "document";
  if (hasWeb) return documentAttempted ? "document_web" : "web";
  if (hasCustom) return "custom";
  if (directEntries.length > 0) return "direct";
  if (capabilityEntries.length > 0) return "capability";
  return "clarification";
};

export const deriveUnifiedGraphAnswer = ({ collected } = {}) => {
  assertCollected(collected);
  if (collected.entries.some((entry) =>
    entry.category === "capability" &&
    entry.skillId !== WEB_CAPABILITY_ID &&
    !RECEIPT_CAPABILITY_IDS.has(entry.skillId)
  )) {
    fail("a capability has no supported answer projection");
  }
  const { documents, selected, bestFailure } = selectCheckedDocument(collected);
  const groundedEntries = collected.entries.filter((entry) =>
    (entry.category === "answer" || entry.skillId === WEB_CAPABILITY_ID) &&
    entry.skillId !== AGENT_SKILL_IDS.documentRag &&
    SETTLED.has(entry.status) &&
    !entry.output.abstained &&
    hasText(entry.output.text)
  );
  if (selected) groundedEntries.push(selected.document);
  const orderedGrounded = collected.entries.filter((entry) =>
    groundedEntries.includes(entry)
  );
  const directEntries = collected.entries.filter((entry) =>
    entry.category === "direct" && SETTLED.has(entry.status) &&
    !entry.output.abstained && hasText(entry.output.text)
  );
  const capabilityEntries = collected.entries.filter((entry) =>
    entry.category === "capability" &&
    RECEIPT_CAPABILITY_IDS.has(entry.skillId) &&
    SETTLED.has(entry.status) &&
    entry.result.ok === true && !entry.output.abstained &&
    hasText(entry.output.text)
  );

  // Metadata responses and action receipts are trusted node outcomes, not
  // document claims. Keep them outside citation-based filtering.
  if ([...directEntries, ...capabilityEntries].some((entry) =>
    entry.output.citations.length > 0
  )) {
    fail("direct and capability receipts need a separate citation contract");
  }

  const grounded = verifiedGroundedAnswer(orderedGrounded);
  const acceptedGrounded = grounded?.accepted === true ? orderedGrounded : [];
  const capabilityReceipts = capabilityEntries.map((entry) => ({
    nodeId: entry.nodeId,
    skillId: entry.skillId,
    stepId: entry.stepId,
    text: entry.output.text.trim(),
  }));
  const segments = [
    ...(grounded?.accepted ? [grounded.text] : []),
    ...directEntries.map((entry) => entry.output.text.trim()),
    ...capabilityReceipts.map((receipt) => receipt.text),
  ];
  const evidenceNeedsClarification = orderedGrounded.length > 0 &&
    !grounded?.accepted;
  const documentNeedsClarification = documents.length > 0 &&
    !grounded?.accepted;
  const clarification = documentNeedsClarification
    ? buildEvidenceClarification({
        reason: "document_evidence_insufficient",
        check: grounded?.check ?? bestFailure?.check.output.check,
        gaps: grounded?.check?.gaps ?? bestFailure?.check.output.check?.gaps ?? [],
      })
    : evidenceNeedsClarification
    ? {
        reason: "evidence_insufficient",
        summary: "The agent could not verify the answer from the available evidence.",
        question: "I could not verify the answer from the available evidence. Which source or detail should I use?",
        detail: { reasons: grounded?.check?.reasons ?? [], gaps: grounded?.check?.gaps ?? [] },
      }
    : null;

  if (clarification) segments.push(clarification.question);
  const status = clarification
    ? "clarification"
    : segments.length > 0
    ? "answered"
    : "abstained";

  return {
    status,
    agentMode: clarification ? "clarification" : deriveMode({
      documentAttempted: documents.length > 0,
      groundedEntries: acceptedGrounded,
      directEntries,
      capabilityEntries,
    }),
    text: segments.join("\n\n") || grounded?.finalizer.text ||
      buildGroundedAbstention().text,
    citations: grounded?.accepted ? grounded.citations : [],
    retrievedContexts: grounded?.accepted ? grounded.retrievedContexts : [],
    finalizer: grounded?.finalizer ?? null,
    finalCheck: grounded?.check ?? null,
    clarification,
    selectedDocumentNodeId: grounded?.accepted
      ? selected?.document.nodeId ?? null
      : null,
    sourceNodeIds: [
      ...(grounded?.accepted ? grounded.sourceNodeIds : []),
      ...directEntries.map((entry) => entry.nodeId),
      ...capabilityEntries.map((entry) => entry.nodeId),
    ],
    capabilityReceipts,
  };
};
