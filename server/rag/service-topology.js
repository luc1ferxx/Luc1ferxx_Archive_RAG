import { getServiceKeyStatus } from "./service-identity.js";

// Which part of the system this process runs, and where the other parts are.
//
// One image runs in one of five roles (ARCHIVE_RAG_ROLE):
//   all            today's monolith: the public API, agent orchestration, and
//                  retrieval in one process (the default).
//   api            the public edge: auth, rate limits, CORS, static frontend,
//                  uploads, documents, ingest jobs, admin. Agent work goes to
//                  AGENT_SERVICE_URL.
//   agent          agent orchestration (runAgentRag, tasks, startup recovery).
//   retrieval      query embedding, dense + sparse retrieval, fusion, rerank.
//   model-gateway  an OpenAI-compatible service in front of the chat,
//                  embedding and rerank backends.
//
// AGENT_SERVICE_URL, RETRIEVAL_SERVICE_URL and MODEL_GATEWAY_URL each list one
// or more replicas (comma-separated). A URL switches the matching work to that
// tier in every role except the one that hosts it: a tier never calls itself
// over HTTP, so one shared environment can be handed to every role. Every
// remote URL and every role other than `all` needs INTERNAL_SERVICE_KEYS
// (service-identity.js).
//
// The getters throw on an invalid value instead of falling back, so a typo
// never silently turns a split deployment back into a monolith;
// validateServiceTopology reports the same problems as a list for startup and
// health output.

export const SERVICE_ROLES = Object.freeze([
  "all",
  "api",
  "agent",
  "retrieval",
  "model-gateway",
]);

export const DEFAULT_SERVICE_ROLE = "all";

// The tiers a request can be sent to, which are also the audiences of the
// internal tokens those tiers accept.
export const SERVICE_TIERS = Object.freeze({
  agent: "agent",
  modelGateway: "model-gateway",
  retrieval: "retrieval",
});

const SERVICE_URL_VARIABLES = Object.freeze({
  [SERVICE_TIERS.agent]: "AGENT_SERVICE_URL",
  [SERVICE_TIERS.modelGateway]: "MODEL_GATEWAY_URL",
  [SERVICE_TIERS.retrieval]: "RETRIEVAL_SERVICE_URL",
});

const normalizeText = (value) => String(value ?? "").trim();

const readRole = (env) => normalizeText(env.ARCHIVE_RAG_ROLE).toLowerCase() || DEFAULT_SERVICE_ROLE;

export const getServiceRole = (env = process.env) => {
  const role = readRole(env);

  if (!SERVICE_ROLES.includes(role)) {
    throw new Error(
      `ARCHIVE_RAG_ROLE must be one of ${SERVICE_ROLES.join(", ")}; got "${env.ARCHIVE_RAG_ROLE}".`
    );
  }

  return role;
};

/**
 * One replica base URL: http or https, no credentials, query, or fragment
 * (identity travels in the signed token, never in the URL). A path prefix is
 * kept; trailing slashes are removed. Throws on anything else.
 */
export const normalizeServiceUrl = (rawValue, { variable = "service URL" } = {}) => {
  const text = normalizeText(rawValue);
  let url;

  try {
    url = new URL(text);
  } catch {
    throw new Error(`${variable} contains an entry that is not a URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${variable} entries must use http or https.`);
  }

  if (url.username || url.password) {
    throw new Error(`${variable} entries must not embed credentials.`);
  }

  if (url.search || url.hash) {
    throw new Error(`${variable} entries must not carry a query or fragment.`);
  }

  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
};

const parseServiceUrls = (env, tier) => {
  const variable = SERVICE_URL_VARIABLES[tier];
  const urls = [];
  const errors = [];
  let duplicates = 0;

  for (const entry of String(env[variable] ?? "").split(",")) {
    if (!entry.trim()) {
      continue;
    }

    try {
      const url = normalizeServiceUrl(entry, { variable });

      if (urls.includes(url)) {
        duplicates += 1;
      } else {
        urls.push(url);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  return { duplicates, errors, urls, variable };
};

const readServiceUrls = (env, tier) => {
  const { errors, urls } = parseServiceUrls(env, tier);

  if (errors.length > 0) {
    throw new Error(errors[0]);
  }

  return urls;
};

export const getAgentServiceUrls = (env = process.env) =>
  readServiceUrls(env, SERVICE_TIERS.agent);

export const getRetrievalServiceUrls = (env = process.env) =>
  readServiceUrls(env, SERVICE_TIERS.retrieval);

export const getModelGatewayUrls = (env = process.env) =>
  readServiceUrls(env, SERVICE_TIERS.modelGateway);

export const getServiceUrls = (tier, env = process.env) => {
  if (!SERVICE_URL_VARIABLES[tier]) {
    throw new TypeError(`Unknown service tier "${tier}".`);
  }

  return readServiceUrls(env, tier);
};

// The role whose process serves a tier's internal HTTP endpoints. `all` serves
// none of them: in the monolith that work runs in process.
const SERVING_ROLE = Object.freeze({
  [SERVICE_TIERS.agent]: "agent",
  [SERVICE_TIERS.modelGateway]: "model-gateway",
  [SERVICE_TIERS.retrieval]: "retrieval",
});

const isRemoteTier = (env, tier) =>
  getServiceRole(env) !== SERVING_ROLE[tier] && readServiceUrls(env, tier).length > 0;

/** True when this process sends agent work (chat, tasks, runs) to AGENT_SERVICE_URL. */
export const isRemoteAgentEnabled = (env = process.env) =>
  isRemoteTier(env, SERVICE_TIERS.agent);

/** True when this process sends retrieval to RETRIEVAL_SERVICE_URL. */
export const isRemoteRetrievalEnabled = (env = process.env) =>
  isRemoteTier(env, SERVICE_TIERS.retrieval);

/** True when this process sends every model call to MODEL_GATEWAY_URL. */
export const isModelGatewayEnabled = (env = process.env) =>
  isRemoteTier(env, SERVICE_TIERS.modelGateway);

/**
 * Whether this process owns a tier:
 *   "api"            public routes, uploads, documents, ingest jobs, admin
 *                    (roles all and api);
 *   "agent"          agent orchestration, tasks, agent startup recovery and
 *                    background agent work (role agent, or all without
 *                    AGENT_SERVICE_URL);
 *   "retrieval"      retrieval (role retrieval, or all without
 *                    RETRIEVAL_SERVICE_URL);
 *   "model-gateway"  the OpenAI-compatible gateway endpoints (role
 *                    model-gateway only).
 * Ownership is not the only way work runs in process: role agent without
 * RETRIEVAL_SERVICE_URL still retrieves itself (isRemoteRetrievalEnabled is
 * false there), and validateServiceTopology warns about it.
 */
export const hostsServiceTier = (tier, env = process.env) => {
  const role = getServiceRole(env);

  switch (tier) {
    case "api":
      return role === "all" || role === "api";
    case SERVICE_TIERS.agent:
      return role === "agent" || (role === "all" && !isRemoteAgentEnabled(env));
    case SERVICE_TIERS.retrieval:
      return role === "retrieval" || (role === "all" && !isRemoteRetrievalEnabled(env));
    case SERVICE_TIERS.modelGateway:
      return role === "model-gateway";
    default:
      throw new TypeError(`Unknown service tier "${tier}".`);
  }
};

/**
 * Problems with the configured topology, as { errors, warnings } of plain
 * sentences with no secrets. Pure over `env`; never throws. Errors are setups
 * that cannot work (a startup in strict mode should refuse them); warnings are
 * setups that work but probably are not what was meant.
 */
export const validateServiceTopology = (env = process.env) => {
  const errors = [];
  const warnings = [];
  const role = readRole(env);

  if (!SERVICE_ROLES.includes(role)) {
    errors.push(
      `ARCHIVE_RAG_ROLE must be one of ${SERVICE_ROLES.join(", ")}.`
    );
  }

  const parsed = Object.fromEntries(
    Object.values(SERVICE_TIERS).map((tier) => [tier, parseServiceUrls(env, tier)])
  );

  for (const { duplicates, errors: urlErrors, variable } of Object.values(parsed)) {
    errors.push(...urlErrors);

    if (duplicates > 0) {
      warnings.push(`${variable} lists the same replica more than once; duplicates are ignored.`);
    }
  }

  const hasUrls = (tier) => parsed[tier].urls.length > 0;

  for (const tier of Object.values(SERVICE_TIERS)) {
    if (role === SERVING_ROLE[tier] && hasUrls(tier)) {
      warnings.push(
        `${parsed[tier].variable} is ignored by role ${role}: a tier never calls itself.`
      );
    }
  }

  if (role === "api" && !hasUrls(SERVICE_TIERS.agent)) {
    errors.push("Role api forwards agent work and needs AGENT_SERVICE_URL.");
  }

  if (role === "agent" && !hasUrls(SERVICE_TIERS.retrieval)) {
    warnings.push("Role agent has no RETRIEVAL_SERVICE_URL and retrieves in process.");
  }

  if (
    ["api", "agent", "retrieval"].includes(role) &&
    !hasUrls(SERVICE_TIERS.modelGateway)
  ) {
    warnings.push(
      `Role ${role} has no MODEL_GATEWAY_URL and calls the model backends directly; the concurrency cap, circuit breaker and quotas stay per process.`
    );
  }

  if (role === "model-gateway") {
    for (const tier of [SERVICE_TIERS.agent, SERVICE_TIERS.retrieval]) {
      if (hasUrls(tier)) {
        warnings.push(`${parsed[tier].variable} is not used by role model-gateway.`);
      }
    }
  }

  const callsRemoteTier = Object.values(SERVICE_TIERS).some(
    (tier) => role !== SERVING_ROLE[tier] && hasUrls(tier)
  );
  const keyStatus = getServiceKeyStatus(env);
  const needsKeys = role !== DEFAULT_SERVICE_ROLE || callsRemoteTier;

  // A malformed key list is fatal only where keys are used; the monolith
  // merely reports it.
  (needsKeys ? errors : warnings).push(...keyStatus.errors);

  if (needsKeys && keyStatus.keyIds.length === 0) {
    errors.push(
      role !== DEFAULT_SERVICE_ROLE
        ? `Role ${role} needs INTERNAL_SERVICE_KEYS to sign or verify internal calls.`
        : "A remote service URL is set, so INTERNAL_SERVICE_KEYS is required to sign internal calls."
    );
  }

  return { errors, warnings };
};

// Origin plus path only. normalizeServiceUrl already refuses credentials,
// queries and fragments; this keeps health output safe even for a URL that
// failed validation.
const describeUrl = (url) => {
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return "invalid";
  }
};

/**
 * Secret-free summary for health output: the role, which tiers this process
 * hosts, the replicas it calls, the key ids (never secrets), and the
 * validation result. Never throws.
 */
export const describeServiceTopology = (env = process.env) => {
  const { errors, warnings } = validateServiceTopology(env);
  const role = readRole(env);
  const valid = errors.length === 0;
  const safely = (read, fallback) => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  const remote = (tier) => {
    const { urls } = parseServiceUrls(env, tier);

    return {
      enabled: SERVICE_ROLES.includes(role) && role !== SERVING_ROLE[tier] && urls.length > 0,
      replicas: urls.length,
      urls: urls.map(describeUrl),
    };
  };
  const keyStatus = getServiceKeyStatus(env);

  return {
    errors,
    hosts: {
      agent: safely(() => hostsServiceTier(SERVICE_TIERS.agent, env), false),
      api: safely(() => hostsServiceTier("api", env), false),
      modelGateway: safely(() => hostsServiceTier(SERVICE_TIERS.modelGateway, env), false),
      retrieval: safely(() => hostsServiceTier(SERVICE_TIERS.retrieval, env), false),
    },
    internalIdentity: {
      configured: keyStatus.configured,
      keyIds: keyStatus.keyIds,
      signingKeyId: keyStatus.signingKeyId,
    },
    remotes: {
      agent: remote(SERVICE_TIERS.agent),
      modelGateway: remote(SERVICE_TIERS.modelGateway),
      retrieval: remote(SERVICE_TIERS.retrieval),
    },
    role: SERVICE_ROLES.includes(role) ? role : "invalid",
    status: valid ? (warnings.length > 0 ? "warning" : "ok") : "error",
    warnings,
  };
};
