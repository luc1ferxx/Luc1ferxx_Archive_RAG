import { listModelCallGuardSnapshots } from "./model-call-guard.js";
import { getModelGatewayCall } from "./model-gateway/call-context.js";
import { getMetricsRegistry, isMetricsEnabled, pickLabel } from "./metrics.js";

// Model calls, from the LLMOps event every model call already records
// (recordLlmOpsMetric in llmops-metrics.js hands each event to
// recordModelCallMetric), plus the model-call guard's state and the gateway's
// quota rejections.
//
// `model` is the registry model id the route picked (`openai.chat`,
// `openai.chat.fallback`, `openai.embedding`), never a URL. `metering` says
// which side's count is authoritative in a split deployment, exactly as the
// LLMOps events do (rag/model-gateway/protocol.js):
//   direct   a model call made in this process (no gateway involved)
//   gateway  a call the model gateway made for a caller (authoritative)
//   mirror   the caller's record of one gateway call; skip it in totals over
//            a deployment, or every gateway call counts twice
//
// The guard families are read on scrape from model-call-guard.js. Its keys are
// `<endpoint>|<model name>`; only the model name becomes the label, so several
// replicas of one model add up and no endpoint URL reaches a series.

export const MODEL_LATENCY_BUCKETS = Object.freeze([
  0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120,
]);

const OPERATIONS = new Set(["embedding", "llm_completion", "rerank"]);
const STATUSES = new Set(["error", "ok", "skipped"]);
const QUOTAS = new Set(["daily_tokens", "requests_per_minute", "tokens_per_minute"]);
const CIRCUIT_STATES = ["closed", "half_open", "open"];
const MIRROR_ANNOTATION_ID = "model_gateway_mirror";

const registry = getMetricsRegistry();

const calls = registry.counter({
  help: "Model calls (each model tried counts once) by operation, registry model id, status and metering side; sum metering!=\"mirror\" across a deployment.",
  labelNames: ["metering", "model", "operation", "status"],
  name: "archive_rag_model_calls_total",
});
const latency = registry.histogram({
  buckets: MODEL_LATENCY_BUCKETS,
  help: "Latency of one model call (one model tried), in seconds.",
  labelNames: ["metering", "model", "operation"],
  name: "archive_rag_model_call_duration_seconds",
});
const tokens = registry.counter({
  help: "Model tokens by direction (input/output), as the provider reported or the client estimated.",
  labelNames: ["direction", "metering", "model", "operation"],
  name: "archive_rag_model_tokens_total",
});
const cost = registry.counter({
  help: "Estimated model cost in US dollars, from the model contract's pricing (0 where it has none).",
  labelNames: ["metering", "model", "operation"],
  name: "archive_rag_model_estimated_cost_usd_total",
});
const guardInFlight = registry.gauge({
  help: "Model requests holding a concurrency slot of this process's model-call guards, by model name.",
  labelNames: ["model"],
  name: "archive_rag_model_guard_in_flight",
});
const guardWaiting = registry.gauge({
  help: "Model requests queued for a concurrency slot of this process's model-call guards, by model name.",
  labelNames: ["model"],
  name: "archive_rag_model_guard_waiting",
});
const circuits = registry.gauge({
  help: "Model-call guards (endpoint and model) in each circuit state, by model name; open means calls fail fast with CIRCUIT_OPEN.",
  labelNames: ["model", "state"],
  name: "archive_rag_model_circuits",
});
const quotaRejections = registry.counter({
  help: "Model gateway requests refused with 429 by a workspace quota, by quota kind.",
  labelNames: ["quota"],
  name: "archive_rag_model_gateway_quota_rejections_total",
});

const isMirrorEvent = (event) =>
  Array.isArray(event?.annotations) &&
  event.annotations.some((annotation) => annotation?.id === MIRROR_ANNOTATION_ID);

export const resolveModelMetering = (event) => {
  if (isMirrorEvent(event)) {
    return "mirror";
  }

  return getModelGatewayCall() ? "gateway" : "direct";
};

const toModelLabel = (event) =>
  String(event?.modelRoute?.modelId || event?.modelRoute?.providerId || "unknown");

const addPositive = (family, labels, value) => {
  const amount = Number(value);

  if (Number.isFinite(amount) && amount > 0) {
    family.inc(labels, amount);
  }
};

/** One normalized LLMOps metric event (llmops-metrics.js). */
export const recordModelCallMetric = (event) => {
  if (!isMetricsEnabled() || !event) {
    return;
  }

  const base = {
    metering: resolveModelMetering(event),
    model: toModelLabel(event),
    operation: pickLabel(event.operation, OPERATIONS),
  };

  calls.inc({ ...base, status: pickLabel(event.status, STATUSES, "unknown") });

  if (Number.isFinite(event.latencyMs)) {
    latency.observe(base, event.latencyMs / 1000);
  }

  addPositive(tokens, { ...base, direction: "input" }, event.inputTokens);
  addPositive(tokens, { ...base, direction: "output" }, event.outputTokens);
  addPositive(cost, base, event.estimatedCostUsd);
};

/** A gateway request refused by `quota` (MODEL_GATEWAY_QUOTAS value). */
export const recordGatewayQuotaRejection = (quota) => {
  if (!isMetricsEnabled()) {
    return;
  }

  quotaRejections.inc({ quota: pickLabel(quota, QUOTAS) });
};

/** The model name of a guard key `<endpoint>|<model>`. */
export const toGuardModelLabel = (key) => {
  const text = String(key ?? "");
  const separator = text.lastIndexOf("|");

  return separator >= 0 && separator < text.length - 1 ? text.slice(separator + 1) : "unknown";
};

export const collectModelCallGuards = () => {
  const inFlightByModel = new Map();
  const waitingByModel = new Map();
  const statesByModel = new Map();

  for (const [key, snapshot] of listModelCallGuardSnapshots()) {
    const model = toGuardModelLabel(key);
    const state = CIRCUIT_STATES.includes(snapshot?.breaker?.state) ? snapshot.breaker.state : "closed";
    const counts = statesByModel.get(model) ?? Object.fromEntries(CIRCUIT_STATES.map((name) => [name, 0]));

    inFlightByModel.set(model, (inFlightByModel.get(model) ?? 0) + (Number(snapshot?.limiter?.inFlight) || 0));
    waitingByModel.set(model, (waitingByModel.get(model) ?? 0) + (Number(snapshot?.limiter?.waiting) || 0));
    counts[state] += 1;
    statesByModel.set(model, counts);
  }

  // Rebuilt each scrape: a guard map reset by a test or a reconfiguration
  // leaves no stale model behind.
  guardInFlight.clear();
  guardWaiting.clear();
  circuits.clear();

  for (const [model, value] of inFlightByModel) {
    guardInFlight.set({ model }, value);
    guardWaiting.set({ model }, waitingByModel.get(model) ?? 0);
  }

  for (const [model, counts] of statesByModel) {
    for (const state of CIRCUIT_STATES) {
      circuits.set({ model, state }, counts[state]);
    }
  }
};

registry.addCollector("model_call_guards", collectModelCallGuards);
