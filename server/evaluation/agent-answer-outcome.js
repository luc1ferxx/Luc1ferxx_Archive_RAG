// Whether an agent /chat body answered the question, for the answer-rate
// evaluations (run-answer-draft-eval.mjs, run-qasper-answer-eval.mjs --surface
// agent).
//
// A clarification is not an answer, and neither is the grounded abstention
// sentence: the finalizer writes it when it removes every claim, and the
// research brief and the timeline Skill end with it when nothing survives.
// Such a body is not a clarification (agentMode stays document or the Skill's
// id), so counting only clarifications as abstentions overstated the answer
// rate and scored the abstention sentence as a wrong answer.

import { GROUNDED_ABSTENTION_TEXT } from "../rag/agent-finalizer.js";
import { attachRetrievedEvidence } from "../rag/citations.js";
import { CHECKABLE_CITATION_FIELDS } from "../rag/self-check/patterns.js";
import { haveSameValues } from "../rag/self-check/text.js";
import { getExecutionLoop } from "./chat-response-contract.js";

export const AGENT_ABSTAIN_SOURCES = Object.freeze({
  clarification: "clarification",
  emptyAnswer: "empty_answer",
  groundedAbstention: "grounded_abstention",
});

export const classifyAgentAnswer = (body = {}) => {
  if (body?.agentMode === "clarification") {
    return { abstainSource: AGENT_ABSTAIN_SOURCES.clarification, answered: false };
  }

  const text = String(body?.agentAnswer ?? "").trim();

  if (!text) {
    return { abstainSource: AGENT_ABSTAIN_SOURCES.emptyAnswer, answered: false };
  }

  // Exactly the sentence, or a brief built around it that the finalizer
  // marked abstained.
  if (text === GROUNDED_ABSTENTION_TEXT || (body?.ragAbstained === true && text.includes(GROUNDED_ABSTENTION_TEXT))) {
    return { abstainSource: AGENT_ABSTAIN_SOURCES.groundedAbstention, answered: false };
  }

  return { abstainSource: null, answered: true };
};

/** The document loop's follow-up, as a report row records it. */
export const describeAgentFollowUp = (body = {}) => {
  const executionLoop = getExecutionLoop(body);

  return {
    followUpRan: Number(executionLoop.followUpsRun ?? 0) > 0,
    stoppedReason: executionLoop.stoppedReason ?? null,
  };
};

const RAG_STEP_TYPES = new Set(["document_rag", "follow_up_retrieval"]);

/**
 * True when an output limit cut off the answer model's reply in a document RAG
 * call of the run (RAG_ANSWER_MAX_TOKENS; its trace step output says so).
 */
export const isAgentAnswerTruncated = (body = {}) =>
  (Array.isArray(body?.agentTrace) ? body.agentTrace : []).some(
    (step) => RAG_STEP_TYPES.has(step?.type) && step?.output?.answerTruncated === true
  );

// What the claim check reads of a cited source (self-check/support.js,
// attribution.js): its text fields, the attached chunk text (evidenceText)
// among them, and the heading RAG_CLAIM_HEADING_CONTEXT puts before them.
const CHECKED_SOURCE_FIELDS = ["pageNumber", "sectionHeading", ...CHECKABLE_CITATION_FIELDS];

// [Source N] as the check resolves it (self-check/evaluate.js): the first
// citation whose own rank, or else position, is N.
const findCitedSource = (citations, rank) =>
  citations.find((citation, index) => {
    const ownRank = Number(citation?.rank);

    return (Number.isInteger(ownRank) && ownRank > 0 ? ownRank : index + 1) === rank;
  });

const describeCheck = (check, phase, reply) => {
  // The citations as evaluateDocumentEvidence hands them to the claim check.
  const citations = reply
    ? attachRetrievedEvidence({ citations: reply.citations ?? [], retrievedContexts: reply.retrievedContexts ?? [] })
    : null;

  return {
    phase,
    passed: check?.passed === true,
    reasons: check?.reasons ?? [],
    answer: typeof reply?.text === "string" ? reply.text : null,
    // The claim judge's summary (self-check/claim-judge.js); null when the
    // check ran without the judge.
    judge: check?.claimSupport?.judge ?? null,
    supportedClaimCount: check?.claimSupport?.supportedClaimCount ?? null,
    unsupportedClaimCount: check?.claimSupport?.unsupportedClaimCount ?? null,
    // Each claim with the check's own fields, plus the sources it cites.
    unsupportedClaims: (check?.claimSupport?.claims ?? [])
      .filter((claim) => !claim.supported)
      .map((claim) => ({
        ...claim,
        sources: citations
          ? (claim.sourceRanks ?? []).flatMap((rank) => {
              const citation = findCitedSource(citations, rank);

              return citation
                ? [{ rank, ...Object.fromEntries(CHECKED_SOURCE_FIELDS.filter((field) => citation[field] !== undefined).map((field) => [field, citation[field]])) }]
                : [];
            })
          : null,
      })),
  };
};

/**
 * Every self_check step of an agent body, in trace order, as a report row
 * records it. `ragReplies` are the run's document RAG replies in call order,
 * each { question, value }: the check read a reply's text and its citations
 * with their retrieved chunks, and the trace keeps none of them. A check's
 * reply is the earliest unused one asking the question of the document_rag or
 * follow_up_retrieval step before it. A final self-check (research brief,
 * custom Skill, Skill chain) reads the finalizer's evidence rather than one
 * reply, so its answer and sources are null.
 */
export const describeAgentChecks = (body = {}, ragReplies = []) => {
  const unused = [...ragReplies];
  const checks = [];
  let phase = null;
  let reply = null;

  for (const step of Array.isArray(body?.agentTrace) ? body.agentTrace : []) {
    if (RAG_STEP_TYPES.has(step?.type)) {
      const index = unused.findIndex((call) => call.question === step.input?.question);

      phase = step.type === "document_rag" ? "primary" : "follow_up";
      reply = index >= 0 ? unused.splice(index, 1)[0].value : null;
    } else if (step?.type === "self_check") {
      checks.push(
        step.detail?.finalAnswer === true
          ? describeCheck(step.detail, "final", null)
          : describeCheck(step.detail, phase, reply)
      );
    }
  }

  return checks;
};

const CLAIM_SOURCE_FAILURE_FIELDS = ["missingSourceRanks", "ambiguousSourceRanks", "misattributedCitationIdentities"];

/**
 * The failure fields and codes of one unsupported claim, each once:
 * "sourceRanks: none" when it cites no source, a source field that is set,
 * and every missingAnchors entry by its code: "term" or "subject" for term:...
 * and subject:..., "anchor" for one of the claim's own anchors (a number, date,
 * code, modality or document fact), else the entry itself (polarity,
 * relation_order, ...). With none of these, the field that failed is
 * verifiedSourceRanks.
 */
export const describeClaimFailures = (claim = {}) => {
  const anchors = new Set(claim.anchors ?? []);
  const failures = new Set([
    ...(claim.sourceRanks?.length > 0 ? [] : ["sourceRanks: none"]),
    ...CLAIM_SOURCE_FAILURE_FIELDS.filter((field) => claim[field]?.length > 0),
    ...(claim.missingAnchors ?? []).map(
      (entry) =>
        `missingAnchors: ${anchors.has(entry) ? "anchor" : /^[a-z_]+:/.test(entry) ? entry.slice(0, entry.indexOf(":")) : entry}`
    ),
  ]);

  if (failures.size === 0) {
    failures.add(
      haveSameValues(claim.sourceRanks, claim.verifiedSourceRanks)
        ? "no failure field set"
        : "verifiedSourceRanks ≠ sourceRanks"
    );
  }

  return [...failures];
};

const tally = (pairs) => {
  const counts = new Map();

  for (const [key, rowId] of pairs) {
    const entry = counts.get(key) ?? { count: 0, rowIds: new Set() };

    entry.count += 1;
    entry.rowIds.add(rowId);
    counts.set(key, entry);
  }

  return [...counts]
    .map(([key, { count, rowIds }]) => ({ count, key, rows: rowIds.size }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
};

/**
 * Over every self-check of every row carrying describeAgentChecks: checks per
 * phase and per claim judge status ("none" without a judge summary), failed
 * checks and unsupported claims, then unsupported claims by failure
 * (describeClaimFailures) and failed checks by reason, each with the rows it
 * occurs in, most frequent first.
 */
export const summarizeAgentChecks = (rows = []) => {
  const checks = rows.flatMap((row) => (row.checks ?? []).map((check) => ({ check, rowId: row.id })));
  const failed = checks.filter(({ check }) => !check.passed);
  const phases = {};
  const judgeStatuses = {};

  for (const { check } of checks) {
    const judgeStatus = check.judge?.status ?? "none";

    phases[check.phase] = (phases[check.phase] ?? 0) + 1;
    judgeStatuses[judgeStatus] = (judgeStatuses[judgeStatus] ?? 0) + 1;
  }

  return {
    checks: checks.length,
    claimFailures: tally(
      checks.flatMap(({ check, rowId }) =>
        check.unsupportedClaims.flatMap((claim) => describeClaimFailures(claim).map((failure) => [failure, rowId]))
      )
    ).map(({ count, key, rows: rowCount }) => ({ claims: count, failure: key, rows: rowCount })),
    failedCheckReasons: tally(failed.flatMap(({ check, rowId }) => check.reasons.map((reason) => [reason, rowId]))).map(
      ({ count, key, rows: rowCount }) => ({ checks: count, reason: key, rows: rowCount })
    ),
    failedChecks: failed.length,
    judgeStatuses,
    phases,
    unsupportedClaims: checks.reduce((sum, { check }) => sum + check.unsupportedClaims.length, 0),
  };
};

/** Counts over rows that carry classifyAgentAnswer and describeAgentFollowUp fields. */
export const summarizeAgentOutcomes = (rows = []) => {
  const agentRows = rows.filter((row) => typeof row.answered === "boolean");
  const abstainSources = {};

  for (const row of agentRows) {
    if (row.abstainSource) {
      abstainSources[row.abstainSource] = (abstainSources[row.abstainSource] ?? 0) + 1;
    }
  }

  return {
    abstainSources,
    answered: agentRows.filter((row) => row.answered).length,
    cases: agentRows.length,
    followUpResolved: agentRows.filter((row) => row.stoppedReason === "follow_up_resolved").length,
    followUpRuns: agentRows.filter((row) => row.followUpRan).length,
  };
};
