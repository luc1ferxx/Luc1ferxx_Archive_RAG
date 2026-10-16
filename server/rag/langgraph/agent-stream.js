import {
  emitAgentEvent,
  hasAgentEventSink,
  runWithAgentEventSink,
} from "../agent-event-stream.js";
import { assertLangSmithTracingDisabled } from "./langsmith-guard.js";

// /chat/stream with the outer plan on LangGraph (docs/adr/0001-langgraph-
// runtime.md, phase 3; routes/chat.js uses it only under the experimental
// AGENT_OUTER_PLAN_RUNTIME=langgraph): the agent run as an async generator of
// the events the native route sends, in the same order, ending with the
// result event (the /chat status and body) or the error event the route
// derives from the run's failure, then done.
//
// The native route binds one event sink (agent-event-stream.js) around the
// whole run and writes each event to the response as it is emitted. This
// module keeps that sink -- it is bound around the whole run here too, so the
// planner steps before any graph, the finalizer step after it and the steps
// of whichever graph answers the request (the V1 outer plan on LangGraph,
// a guarded v3 graph) all reach the client -- and adds the bridge a graph
// needs: inside a node of a graph that streams with the "custom" mode, the
// sink's events go to LangGraph's config.writer, come out of graph.stream()
// as custom chunks in emission order, and the graph's consumer loop hands
// them to the outer sink. A graph invoked without the relay (invoke, or a
// stream without "custom") leaves the outer sink in place and loses nothing.
//
// Raw answer tokens never leave the server: the only events are compact step
// summaries and the verified answer drafts of answer-drafts.js, exactly what
// the native sink carries. "messages" is never a stream mode here.

export const AGENT_STREAM_EVENT_TYPES = Object.freeze({
  done: "done",
  error: "error",
  result: "result",
});

// The configurable key a graph runner sets on an invocation that consumes
// custom chunks: without it a node keeps emitting to the outer sink directly,
// because LangGraph's config.writer is a no-op unless "custom" is streamed,
// and events handed to it would be dropped.
export const AGENT_STREAM_RELAY_KEY = "archive_rag_agent_event_relay";

/**
 * Runs a node's work with the agent event sink pointed at `config.writer`,
 * when the invocation declared the relay and a streaming client is attached;
 * otherwise runs it as it is. A run without a sink (plain /chat, tasks,
 * evals) nests nothing, so hasAgentEventSink() stays false inside the node
 * and no answer-draft channel opens there.
 */
export const relayAgentEventsThroughWriter = (config, work) => {
  const writer = config?.writer;

  if (
    !hasAgentEventSink() ||
    config?.configurable?.[AGENT_STREAM_RELAY_KEY] !== true ||
    typeof writer !== "function"
  ) {
    return work();
  }

  return runWithAgentEventSink((event) => writer(event), work);
};

/**
 * One `[mode, payload]` chunk of graph.stream({ streamMode: ["updates",
 * "custom"] }): a custom chunk is an agent event a node relayed, emitted to
 * the sink bound around the run; an updates chunk is returned as
 * `{ [nodeName]: update }` for the caller to read; anything else is ignored.
 */
export const forwardAgentStreamChunk = (chunk) => {
  if (!Array.isArray(chunk)) {
    return null;
  }

  const [mode, payload] = chunk;

  if (mode === "custom") {
    emitAgentEvent(payload);
    return null;
  }

  return mode === "updates" ? payload : null;
};

// Events in emission order; the consumer awaits the next one. `end(event)`
// delivers a last event and closes.
const createEventQueue = () => {
  const items = [];
  let wake = null;
  let closed = false;

  const signal = () => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };

  return {
    end(event) {
      if (!closed) {
        items.push(event);
        closed = true;
        signal();
      }
    },
    push(event) {
      if (!closed) {
        items.push(event);
        signal();
      }
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length > 0) {
          yield items.shift();
          continue;
        }

        if (closed) {
          return;
        }

        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

/**
 * The /chat/stream event sequence of one agent run. `answer()` runs the agent
 * and resolves to the /chat `{ status, body }`; `describeError(error,
 * fallbackMessage)` is the route's own failure description (`{ body, status
 * }`), so an error event here is byte for byte what the native route sends.
 *
 * Yields each agent event the run emits (`type` trace_step, answer_draft,
 * answer_draft_reset) as emitted, then `{ type: "result", body, status }` or
 * `{ type: "error", body, status }`, then `{ type: "done" }`. The generator
 * starts the run on its first next(), inside the caller's async context, so
 * the request's deadline, tenant and run usage bind as they do for the
 * native route. A LangSmith tracer switched on is refused before the run
 * starts, as the error/done sequence.
 */
export async function* streamAgentRun({
  answer,
  describeError,
  fallbackMessage = "Failed to answer the question.",
} = {}) {
  if (typeof answer !== "function" || typeof describeError !== "function") {
    throw new TypeError("streamAgentRun needs answer() and describeError().");
  }

  const queue = createEventQueue();
  const failWith = (error) => {
    const { body, status } = describeError(error, fallbackMessage);

    queue.end({ body, status, type: AGENT_STREAM_EVENT_TYPES.error });
  };

  try {
    // Before anything LangGraph: a graph invocation configures the LangSmith
    // tracer, with its input, before any node could refuse it.
    assertLangSmithTracingDisabled();

    runWithAgentEventSink(
      (event) => queue.push(event),
      () => Promise.resolve().then(answer)
    ).then(
      (response) =>
        queue.end({
          body: response?.body,
          status: response?.status,
          type: AGENT_STREAM_EVENT_TYPES.result,
        }),
      failWith
    );
  } catch (error) {
    failWith(error);
  }

  for await (const event of queue) {
    yield event;
  }

  yield { type: AGENT_STREAM_EVENT_TYPES.done };
}

/**
 * The SSE frame of one yielded event: `{ event, data }` as the native route
 * writes them (`event: <name>`, `data: <JSON>`): an agent event is sent whole
 * under its type; result as `{ body, status }`; error as the failure body
 * plus `status`; done as `{}`.
 */
export const toAgentStreamFrame = (event = {}) => {
  switch (event.type) {
    case AGENT_STREAM_EVENT_TYPES.result:
      return { data: { body: event.body, status: event.status }, event: event.type };
    case AGENT_STREAM_EVENT_TYPES.error:
      return { data: { ...event.body, status: event.status }, event: event.type };
    case AGENT_STREAM_EVENT_TYPES.done:
      return { data: {}, event: event.type };
    default:
      return { data: event, event: event.type };
  }
};
