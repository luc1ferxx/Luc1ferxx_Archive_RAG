import { AsyncLocalStorage } from "node:async_hooks";

// Progress events for a streaming /chat request.
//
// The sink travels with the request's async context rather than through every
// function signature between the route and the agent run context, so emitting a
// step costs one call where the step is recorded and nothing anywhere else. A
// request without a sink (plain /chat, background tasks, evals) emits nothing.
//
// Events are progress, plus verified answer drafts (answer-drafts.js). Raw tokens
// are never sent: a draft is a whole sentence that already passed the same claim
// check the finalizer runs. Drafts are still provisional -- a follow-up answer
// or the finalizer can revise them -- so the authoritative answer is only the
// result event, sent once the finalizer has run.

const eventSinkStorage = new AsyncLocalStorage();

export const AGENT_EVENT_TYPES = Object.freeze({
  answerDraft: "answer_draft",
  answerDraftReset: "answer_draft_reset",
  traceStep: "trace_step",
});

export const runWithAgentEventSink = (sink, callback) =>
  eventSinkStorage.run(sink, callback);

export const hasAgentEventSink = () =>
  typeof eventSinkStorage.getStore() === "function";

// Only the public summary of a step goes out: its detail can carry retrieved
// evidence and planner internals that the final response filters or redacts.
const compactTraceStep = (step = {}) => ({
  id: step.id ?? null,
  label: step.label ?? null,
  status: step.status ?? null,
  summary: step.summary ?? null,
  type: step.type ?? null,
});

export const emitAgentEvent = (event) => {
  const sink = eventSinkStorage.getStore();

  if (typeof sink !== "function") {
    return;
  }

  try {
    sink(event);
  } catch {
    // A client that disconnected mid-run must never fail the run itself.
  }
};

export const emitTraceStep = (step) =>
  emitAgentEvent({
    step: compactTraceStep(step),
    type: AGENT_EVENT_TYPES.traceStep,
  });
