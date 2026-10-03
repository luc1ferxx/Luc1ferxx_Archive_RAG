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
 * True when a document RAG call of the run answered a NOT_IN_EVIDENCE reply
 * through RAG_QA_VERDICT_OVERRIDE (its trace step output says so).
 */
export const isAgentVerdictOverridden = (body = {}) =>
  (Array.isArray(body?.agentTrace) ? body.agentTrace : []).some(
    (step) => RAG_STEP_TYPES.has(step?.type) && step?.output?.verdictOverridden === true
  );

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
