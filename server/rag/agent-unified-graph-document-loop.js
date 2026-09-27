import { buildEvidenceClarification } from "./agent-response-builder.js";
import { buildEvidenceGaps, evaluateDocumentEvidence } from "./agent-self-check.js";
import { buildGapAnalysisSummary, buildSelfCheckSummary } from "./agent-trace.js";
import { describeUnifiedGraphProjectionShape } from "./agent-unified-graph-projection.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";

// The document loop's run-scoped state for a completed v3 graph.
//
// runDocumentRagLoop mutates working memory, the execution loop, and the trace
// while it calls ragService.chat. In the graph those calls are separate nodes
// with persisted typed outputs, so this module derives the same state after
// the graph settles, from those outputs alone: the primary and follow-up
// document results and the evidence checks. Because nothing here reads a
// process-local value, a run resumed in another process (its completed nodes
// reused from the checkpoint) rebuilds identical claims, gaps, and loop
// counters -- evidence gaps survive a restart and a reused follow-up is
// counted once, never charged again.
//
// Differences from V1 that are deliberate and documented: the in-graph check
// is the lexical evaluateDocumentEvidence (the claim judge, when enabled, still
// runs in the finalizer), and whether a follow-up is allowed is the graph's
// decision (a primary check that recommends one with no follow-up node planned
// ends as `follow_up_limit_reached`, as V1 does at its follow-up limit).

const SETTLED = new Set(["completed", "reused"]);

const isSettled = (entry) => Boolean(entry) && SETTLED.has(entry.status);

const checkFromEntry = (entry) => entry?.output?.check ?? null;

const checkFromDocument = ({ docIds, entry }) =>
  evaluateDocumentEvidence({ docIds, ragResult: entry.result });

const withSkillIdentity = (gaps, skill) =>
  gaps.map((gap) => ({
    ...gap,
    skillId: skill.id,
    skillVersion: skill.version,
  }));

const addSelfCheckTrace = ({ addTraceStep, check, label, nodeId }) =>
  addTraceStep?.({
    type: "self_check",
    label,
    status: check.passed ? "completed" : "failed",
    summary: buildSelfCheckSummary(check),
    detail: {
      ...check,
      graphNodeId: nodeId,
    },
  });

/**
 * Apply the document loop's working-memory, gap, and loop-counter effects of
 * a collected v3 graph. Returns the evidence clarification V1 would return and
 * whether a Web node answered (which, as in V1, supersedes it).
 */
export const applyUnifiedGraphDocumentLoop = ({
  addTraceStep,
  collected,
  docIds = [],
  executionLoop,
  graph,
  plan,
  recordExecutionGaps,
  recordWorkingMemoryClaimSupport,
  recordWorkingMemoryGaps,
  registry,
  resolveWorkingMemoryGaps,
} = {}) => {
  const shape = describeUnifiedGraphProjectionShape({ graph, plan, registry });
  const webAnswered = collected.entries.some(
    (entry) => entry.skillId === AGENT_SKILL_IDS.webSearch && isSettled(entry)
  );
  const empty = {
    documentEvidenceClarification: null,
    followUpRan: false,
    webAnswered,
  };

  if (!shape.ok || !shape.primaryDocumentNodeId) {
    return empty;
  }

  const primary = collected.byNodeId.get(shape.primaryDocumentNodeId);
  const followUp = shape.followUpNodeId
    ? collected.byNodeId.get(shape.followUpNodeId)
    : null;
  const skill = registry.get(AGENT_SKILL_IDS.documentRag);

  if (!isSettled(primary) || !skill) {
    return empty;
  }

  const controlEntries = collected.entries.filter(
    (entry) => entry.category === "control" && isSettled(entry)
  );
  const primaryCheckEntry = shape.followUpCheckNodeId
    ? collected.byNodeId.get(shape.followUpCheckNodeId)
    : controlEntries.find(
        (entry) => entry.sourceDocumentNodeId === shape.primaryDocumentNodeId
      );
  const primaryCheck = isSettled(primaryCheckEntry)
    ? checkFromEntry(primaryCheckEntry)
    : checkFromDocument({ docIds, entry: primary });
  let documentEvidenceClarification = null;

  recordWorkingMemoryClaimSupport?.({ skill, phase: "primary", check: primaryCheck });
  addSelfCheckTrace({
    addTraceStep,
    check: primaryCheck,
    label: "Self Check",
    nodeId: primaryCheckEntry?.nodeId ?? primary.nodeId,
  });

  if (!primaryCheck.retryRecommended) {
    return empty;
  }

  if (!shape.followUpNodeId) {
    executionLoop.stoppedReason = "follow_up_limit_reached";

    return {
      ...empty,
      documentEvidenceClarification: buildEvidenceClarification({
        reason: "document_follow_up_limit_reached",
        check: primaryCheck,
        gaps: primaryCheck.gaps?.length
          ? primaryCheck.gaps
          : buildEvidenceGaps(primaryCheck),
      }),
    };
  }

  const gaps = recordExecutionGaps?.({ skill, check: primaryCheck }) ?? [];
  executionLoop.stoppedReason = "follow_up_planned";
  addTraceStep?.({
    type: "gap_analysis",
    label: "Gap Analysis",
    status: gaps.length > 0 ? "completed" : "skipped",
    summary: buildGapAnalysisSummary(gaps),
    detail: {
      skillId: skill.id,
      skillVersion: skill.version,
      followUpRecommended: gaps.length > 0,
      gaps,
      graphNodeId: primaryCheckEntry?.nodeId ?? null,
    },
  });

  if (!isSettled(followUp)) {
    return empty;
  }

  // One follow-up node settles once: completed in this process or reused
  // from the checkpoint. Either way the loop counts it exactly once.
  executionLoop.followUpsRun += 1;
  executionLoop.stoppedReason = "follow_up_completed";

  const followUpCheckEntry = controlEntries.find(
    (entry) => entry.sourceDocumentNodeId === shape.followUpNodeId
  );
  const followUpCheck = followUpCheckEntry
    ? checkFromEntry(followUpCheckEntry)
    : checkFromDocument({ docIds, entry: followUp });

  recordWorkingMemoryClaimSupport?.({
    skill,
    phase: "follow_up",
    check: followUpCheck,
  });
  addSelfCheckTrace({
    addTraceStep,
    check: followUpCheck,
    label: "Follow-up Self Check",
    nodeId: followUpCheckEntry?.nodeId ?? followUp.nodeId,
  });
  executionLoop.stoppedReason = followUpCheck.passed
    ? "follow_up_resolved"
    : "follow_up_unresolved";

  if (followUpCheck.passed) {
    resolveWorkingMemoryGaps?.({ skill, phase: "follow_up" });
  } else {
    const followUpGaps = withSkillIdentity(
      followUpCheck.gaps?.length ? followUpCheck.gaps : buildEvidenceGaps(followUpCheck),
      skill
    );

    recordWorkingMemoryGaps?.({ gaps: followUpGaps, phase: "follow_up" });
    documentEvidenceClarification = buildEvidenceClarification({
      reason: "document_evidence_unresolved_after_follow_up",
      check: followUpCheck,
      gaps: followUpGaps,
    });
  }

  return {
    documentEvidenceClarification,
    followUpRan: true,
    webAnswered,
  };
};
