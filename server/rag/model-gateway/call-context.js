import { AsyncLocalStorage } from "node:async_hooks";

import { recordRagTrace } from "../observability.js";

// The model gateway request a model call runs for, found through
// AsyncLocalStorage so the existing call paths in openai.js and reranker.js need
// no new parameter: inside a gateway request every LLMOps event they record is
// handed to that request's `meter`, which tags it with the tenant, adds it to
// the usage ledger and the token quotas, and returns the event to write.
//
// Its presence also means "this process is the gateway serving a call": a model
// call made inside one never goes back out to a gateway, even when this process
// could see a MODEL_GATEWAY_URL.

const storage = new AsyncLocalStorage();

export const runWithModelGatewayCall = (call, action) => storage.run(call, action);

export const getModelGatewayCall = () => storage.getStore() ?? null;

/**
 * The recorder every model call in openai.js and reranker.js passes to its
 * LLMOps metric. Outside a gateway request it is exactly recordRagTrace.
 */
export const recordModelMetricEvent = (event) => {
  const call = getModelGatewayCall();

  return recordRagTrace(call ? call.meter(event) : event);
};
