import { isGraphDrained } from "@langchain/langgraph";

import { resolveAgentRunTermination } from "../dependency-outage.js";
import {
  REQUEST_CANCELLATION_REASONS,
  getRequestSignal,
  isRequestCancelledError,
} from "../request-deadline.js";

// The request's cancellation as a LangGraph drain (docs/adr/0001-langgraph-
// runtime.md, the accepted cancellation decision). The request's signal is
// never handed to LangGraph: a RunnableConfig.signal rejects the invocation at
// once, leaves the node in flight running in the background with its writes
// discarded, and runs that node again on resume. A drain instead asks the
// loop to start no further superstep; the one in flight still commits, and
// every node keeps its native safe points (request-deadline.js) as the
// second, independent stop. Every graph runner in this directory bridges the
// signal the same way and ends with the same error, so both live here.

const noop = () => {};

/**
 * RunControl.requestDrain once the request is cancelled. A signal that has
 * already aborted drains at once (the loop then stops before its first
 * superstep). Returns the listener's removal, to call once the invocation has
 * settled.
 */
export const bridgeRequestSignalToDrain = (runControl) => {
  const requestSignal = getRequestSignal();

  if (!requestSignal) {
    return noop;
  }

  const requestDrain = () =>
    runControl.requestDrain(
      requestSignal.reason?.reason ?? REQUEST_CANCELLATION_REASONS.clientCancelled
    );

  if (requestSignal.aborted) {
    requestDrain();
    return noop;
  }

  requestSignal.addEventListener("abort", requestDrain, { once: true });
  return () => requestSignal.removeEventListener("abort", requestDrain);
};

/**
 * The error a failed invocation ends with: the run's first fatal error
 * (`fatalError`, the original error a node threw, which the node reported to
 * LangGraph only as a code), else LangGraph's own. A GraphDrained is the
 * request's cancellation: resolveAgentRunTermination reads the request's
 * signal and deadline and returns its RequestCancelledError
 * (AGENT_DEADLINE_EXCEEDED / AGENT_CLIENT_CANCELLED), the error the native
 * safe point would have thrown.
 */
export const resolveDrainedInvocationError = ({ error, fatalError = null }) => {
  const original = fatalError ?? error;

  if (isRequestCancelledError(original)) {
    return original;
  }

  if (isGraphDrained(original)) {
    const termination = resolveAgentRunTermination(original);

    if (isRequestCancelledError(termination)) {
      return termination;
    }
  }

  return original;
};
