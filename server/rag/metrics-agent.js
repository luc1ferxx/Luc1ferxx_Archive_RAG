import {
  getMetricsRegistry,
  isMetricsEnabled,
  secondsSince,
  toIdentifierLabel,
} from "./metrics.js";

// Agent runs and their steps. One observation per invocation of runAgentRag,
// an approval continuation, or a graph resume (agent.js wraps each in
// observeAgentRun), so a run that pauses for approval and resumes counts as a
// clarification and then as whatever the resume ended in.
//
// Outcomes and reasons are fixed vocabularies:
//   completed      answered (reason `answered`, or `abstained` when document
//                  RAG abstained)
//   clarification  the run asked the user (reason: the clarification reason,
//                  a code-defined snake_case id such as
//                  capability_approval_required)
//   failed         an answer with status >= 400 (`http_4xx`/`http_5xx`) or a
//                  thrown error: `deadline_exceeded` (the request deadline
//                  passed; rag/request-deadline.js), `dependency_<kind>` (a
//                  dependency outage, kind database/model/retrieval/service/
//                  other; rag/dependency-outage.js), `budget_exceeded`,
//                  `circuit_open`, `model_unavailable`, `service_unavailable`,
//                  `timeout`, `error`
//   cancelled      the caller abandoned the work: `client_cancelled` (it left;
//                  also an answer with status 499), `aborted`, `cancelled`
// Deadline and outage are failures, as the run store records them; only a
// caller that left is a cancellation.

export const AGENT_RUN_OUTCOMES = Object.freeze({
  cancelled: "cancelled",
  clarification: "clarification",
  completed: "completed",
  failed: "failed",
});

export const AGENT_RUN_DURATION_BUCKETS = Object.freeze([
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300, 600,
]);

const registry = getMetricsRegistry();

const runs = registry.counter({
  help: "Agent run invocations by outcome and reason (fixed vocabularies; see rag/metrics-agent.js).",
  labelNames: ["outcome", "reason"],
  name: "archive_rag_agent_runs_total",
});
const runDuration = registry.histogram({
  buckets: AGENT_RUN_DURATION_BUCKETS,
  help: "Duration of one agent run invocation, in seconds.",
  labelNames: ["outcome"],
  name: "archive_rag_agent_run_duration_seconds",
});
const steps = registry.counter({
  help: "Agent trace steps recorded, by step type and status.",
  labelNames: ["status", "type"],
  name: "archive_rag_agent_steps_total",
});

const errorText = (error) =>
  `${String(error?.name ?? "")} ${String(error?.code ?? "")}`.toUpperCase();

const DEPENDENCY_KINDS = new Set(["database", "model", "retrieval", "service"]);

// Work that stopped early: the caller left (AGENT_CLIENT_CANCELLED, an
// AbortError) or the deadline passed (AGENT_DEADLINE_EXCEEDED);
// rag/request-deadline.js.
const classifyEarlyStop = (text) => {
  if (/CLIENT_CANCEL/u.test(text)) {
    return { outcome: AGENT_RUN_OUTCOMES.cancelled, reason: "client_cancelled" };
  }

  if (/DEADLINE/u.test(text)) {
    return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "deadline_exceeded" };
  }

  if (/ABORT/u.test(text)) {
    return { outcome: AGENT_RUN_OUTCOMES.cancelled, reason: "aborted" };
  }

  if (/CANCEL/u.test(text)) {
    return { outcome: AGENT_RUN_OUTCOMES.cancelled, reason: "cancelled" };
  }

  return null;
};

/** { outcome, reason } for an invocation that threw. */
export const classifyAgentRunError = (error) => {
  const text = errorText(error);
  const earlyStop = classifyEarlyStop(text);

  if (earlyStop) {
    return earlyStop;
  }

  if (/AGENT_DEPENDENCY_/u.test(text)) {
    return {
      outcome: AGENT_RUN_OUTCOMES.failed,
      reason: `dependency_${DEPENDENCY_KINDS.has(error?.dependency) ? error.dependency : "other"}`,
    };
  }

  if (/BUDGET/u.test(text)) {
    return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "budget_exceeded" };
  }

  if (/CIRCUIT_OPEN/u.test(text)) {
    return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "circuit_open" };
  }

  if (/TIMEOUT/u.test(text)) {
    return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "timeout" };
  }

  if (/MODEL_GATEWAY|MODEL_UPSTREAM/u.test(text)) {
    return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "model_unavailable" };
  }

  if (/SERVICE_/u.test(text) || error?.name === "ServiceUnavailableError") {
    return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "service_unavailable" };
  }

  return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "error" };
};

/** { outcome, reason } for an invocation that answered `response`. */
export const classifyAgentRunResponse = (response) => {
  const status = Number(response?.status);
  const body = response?.body ?? {};
  const earlyStop =
    status === 499 || status === 504 ? classifyEarlyStop(String(body.code ?? "").toUpperCase()) : null;

  if (earlyStop || status === 499) {
    return earlyStop ?? { outcome: AGENT_RUN_OUTCOMES.cancelled, reason: "client_cancelled" };
  }

  if (status >= 500) {
    return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "http_5xx" };
  }

  if (status >= 400) {
    return { outcome: AGENT_RUN_OUTCOMES.failed, reason: "http_4xx" };
  }

  if (body.clarification?.needed || body.agentMode === "clarification") {
    return {
      outcome: AGENT_RUN_OUTCOMES.clarification,
      reason: body.clarification?.reason ? toIdentifierLabel(body.clarification.reason) : "unspecified",
    };
  }

  return {
    outcome: AGENT_RUN_OUTCOMES.completed,
    reason: body.ragAbstained ? "abstained" : "answered",
  };
};

const recordRun = ({ outcome, reason }, startedAt) => {
  runs.inc({ outcome, reason });
  runDuration.observe({ outcome }, secondsSince(startedAt));
};

const observeRun = async (run) => {
  const startedAt = performance.now();
  let response;

  try {
    response = await run();
  } catch (error) {
    recordRun(classifyAgentRunError(error), startedAt);
    throw error;
  }

  recordRun(classifyAgentRunResponse(response), startedAt);
  return response;
};

/**
 * Runs `run` (an agent invocation resolving to { status, body }) and records
 * its outcome and duration. The result and any error pass through unchanged;
 * while metrics are off this is `run()` itself.
 */
export const observeAgentRun = (run) => (isMetricsEnabled() ? observeRun(run) : run());

/** One trace step that made it into the run's trace. */
export const recordAgentStep = (step) => {
  if (!isMetricsEnabled()) {
    return;
  }

  steps.inc({
    status: toIdentifierLabel(step?.status),
    type: toIdentifierLabel(step?.type),
  });
};
