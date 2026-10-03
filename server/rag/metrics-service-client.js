import { getMetricsRegistry, isMetricsEnabled, pickLabel } from "./metrics.js";

// Calls between the tiers of a split deployment (rag/service-client.js),
// labelled by target tier only (agent, retrieval, model-gateway), never a
// replica URL:
//   - calls by code: the status class of the answer the tier gave (2xx, 4xx,
//     5xx...), or the client's own failure code (SERVICE_TIMEOUT,
//     SERVICE_UNAVAILABLE, SERVICE_UNREACHABLE, SERVICE_NOT_CONFIGURED),
//     ABORTED when the caller gave up, ERROR otherwise.
//   - failovers: attempts moved to another replica after one failed.
//   - in flight, replicas and unhealthy replicas per tier, read on scrape from
//     the process's registered clients (the agent and retrieval clients, and
//     the model gateway client).

const TIERS = new Set(["agent", "model-gateway", "retrieval"]);
const CLIENT_CODES = new Set([
  "SERVICE_NOT_CONFIGURED",
  "SERVICE_TIMEOUT",
  "SERVICE_UNAVAILABLE",
  "SERVICE_UNREACHABLE",
]);

const registry = getMetricsRegistry();

const calls = registry.counter({
  help: "Calls to another tier by target tier and code (answer status class, or the client's failure code).",
  labelNames: ["code", "tier"],
  name: "archive_rag_service_client_calls_total",
});
const failovers = registry.counter({
  help: "Attempts a service client moved to another replica of the tier after one failed.",
  labelNames: ["tier"],
  name: "archive_rag_service_client_failovers_total",
});
const inFlight = registry.gauge({
  help: "Requests this process has in flight to each tier (streams count until their body ends).",
  labelNames: ["tier"],
  name: "archive_rag_service_client_in_flight",
});
const replicas = registry.gauge({
  help: "Replicas configured for each tier this process calls.",
  labelNames: ["tier"],
  name: "archive_rag_service_client_replicas",
});
const unhealthy = registry.gauge({
  help: "Replicas of each tier marked unhealthy (a refused connection or 502/503/504 within the cooldown).",
  labelNames: ["tier"],
  name: "archive_rag_service_client_unhealthy_replicas",
});

export const toTierLabel = (tier) => pickLabel(tier, TIERS);

const toStatusClass = (status) => {
  const code = Number(status);

  return Number.isInteger(code) && code >= 100 && code < 600 ? `${Math.floor(code / 100)}xx` : "ERROR";
};

export const classifyServiceCallError = (error) => {
  const code = String(error?.code ?? "");

  if (CLIENT_CODES.has(code)) {
    return code;
  }

  return error?.name === "AbortError" || /ABORT/u.test(code.toUpperCase()) ? "ABORTED" : "ERROR";
};

const observe = (tier, promise) =>
  promise.then(
    (answer) => {
      calls.inc({ code: toStatusClass(answer?.status), tier });
      return answer;
    },
    (error) => {
      calls.inc({ code: classifyServiceCallError(error), tier });
      throw error;
    }
  );

/**
 * The client with request() and stream() counted by outcome. Returns `client`
 * itself while metrics are off.
 */
export const instrumentServiceClient = (client) => {
  if (!isMetricsEnabled() || !client) {
    return client;
  }

  const tier = toTierLabel(client.audience);

  return {
    ...client,
    request: (options) => observe(tier, client.request(options)),
    stream: (options) => observe(tier, client.stream(options)),
  };
};

/** One attempt moved to the next replica of `tier`. */
export const recordServiceFailover = (tier) => {
  if (isMetricsEnabled()) {
    failovers.inc({ tier: toTierLabel(tier) });
  }
};

const addSnapshot = (totals, snapshot, tier) => {
  const entry = totals.get(tier) ?? { inFlight: 0, replicas: 0, unhealthy: 0 };

  for (const replica of snapshot?.replicas ?? []) {
    entry.inFlight += Number(replica?.outstanding) || 0;
    entry.replicas += 1;
    entry.unhealthy += replica?.healthy === false ? 1 : 0;
  }

  totals.set(tier, entry);
};

// Imported on scrape, so this module never loads the clients for its own sake.
export const collectServiceClients = async () => {
  const [{ describeServiceClients }, { describeModelGatewayClient }] = await Promise.all([
    import("./service-client.js"),
    import("./model-gateway/client.js"),
  ]);
  const totals = new Map();

  for (const [tier, snapshot] of Object.entries(describeServiceClients())) {
    addSnapshot(totals, snapshot, toTierLabel(tier));
  }

  const gateway = describeModelGatewayClient();

  if (gateway) {
    addSnapshot(totals, gateway, "model-gateway");
  }

  inFlight.clear();
  replicas.clear();
  unhealthy.clear();

  for (const [tier, entry] of totals) {
    inFlight.set({ tier }, entry.inFlight);
    replicas.set({ tier }, entry.replicas);
    unhealthy.set({ tier }, entry.unhealthy);
  }
};

registry.addCollector("service_clients", collectServiceClients);
