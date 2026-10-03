import crypto from "node:crypto";

import { addAccessPrincipalAuthorizationMetadata } from "../access-scope.js";
import {
  isServiceAuthModeValid,
  parseServiceSigningKey,
  parseTrustedServiceKeys,
  readServiceAuthMode,
  SERVICE_AUTH_MODES,
  SERVICE_TOKEN_ALGORITHMS,
} from "./service-identity-keys.js";
import { getServiceTokenReplayCache } from "./service-token-replay.js";

// Signed identity for calls between the tiers of a split deployment
// (ARCHIVE_RAG_ROLE, see service-topology.js).
//
// The public edge authenticates the user once (requireApiAuth) and forwards
// work to an internal tier with a short-lived token that carries the caller's
// access scope. The receiving tier accepts nothing else: its
// requireServiceIdentity middleware verifies the token and sets req.accessScope
// in exactly the shape requireApiAuth produces, so bindDatabaseTenant and every
// route behave as they do in the monolith.
//
// How tokens are signed is INTERNAL_SERVICE_AUTH (service-identity-keys.js,
// which also describes the hmac -> ed25519 upgrade and Ed25519 key rotation):
//   hmac (default)  HS256 with INTERNAL_SERVICE_KEYS = "kid1:secret1,kid2:
//                   secret2". The first key signs and every key verifies, so a
//                   key rotates in three rolls: append the new key everywhere
//                   (all tiers verify it), move it to the front (it signs),
//                   then remove the old one. Prepending in one roll would let a
//                   restarted tier sign with a key the tiers not yet restarted
//                   cannot verify. Every tier holds the keys, so the issuer is
//                   self-asserted.
//   ed25519         EdDSA with this process's own INTERNAL_SERVICE_SIGNING_KEY;
//                   verified with INTERNAL_SERVICE_TRUSTED_KEYS, whose public
//                   keys are each bound to an issuer. A token is accepted only
//                   when its key is registered for the issuer it names.
//   mixed           signs EdDSA, accepts both (a rolling upgrade).
// The algorithm is pinned per key: an HS256 key never verifies an EdDSA token
// and an Ed25519 public key never verifies an HS256 one (no alg confusion).
//
// Who may call whom is SERVICE_CALL_POLICY below, enforced at the receiver.
//
// Request binding: the service client signs a fresh token for every attempt
// and binds it to that request: the method (htm), a SHA-256 of the request
// target (htu, path and query; the query can hold a question, so only its
// digest travels), and a SHA-256 of a non-empty body (bdh). The receiver
// checks method and target in requireServiceIdentity and the body in the JSON
// parser's verify hook (verifyServiceRequestBody), so a captured token is no
// use against another route or with another body. Binding is required for
// EdDSA tokens and checked when present on HS256 ones
// (INTERNAL_SERVICE_REQUEST_BINDING=required|optional overrides both).
//
// Replay: with INTERNAL_SERVICE_REPLAY_CACHE on (the default under ed25519 and
// mixed, off under hmac) a token id is accepted once (service-token-replay.js,
// shared through Redis when RAG_SHARED_STATE=redis). Under hmac without it,
// tokens are bearer tokens for their lifetime (60 s by default), so they must
// only travel over the internal network -- which stays true in every mode.
//
// Every internal header shares SERVICE_HEADER_PREFIX, so the public edge can
// strip all of them from inbound requests (stripInternalServiceHeaders) and a
// public client can never present an internal identity.

export const SERVICE_HEADER_PREFIX = "x-archive-service-";
export const SERVICE_TOKEN_HEADER = `${SERVICE_HEADER_PREFIX}token`;
export const SERVICE_DEADLINE_HEADER = `${SERVICE_HEADER_PREFIX}deadline-ms`;
export const SERVICE_REQUEST_ID_HEADER = `${SERVICE_HEADER_PREFIX}request-id`;

// The HS256 algorithm of INTERNAL_SERVICE_AUTH=hmac; SERVICE_TOKEN_ALGORITHMS
// names both.
export const SERVICE_TOKEN_ALGORITHM = "HS256";
export { SERVICE_AUTH_MODES, SERVICE_TOKEN_ALGORITHMS };
export const MIN_SERVICE_KEY_SECRET_LENGTH = 32;
export const DEFAULT_SERVICE_TOKEN_TTL_MS = 60_000;
export const MAX_SERVICE_TOKEN_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_SERVICE_TOKEN_CLOCK_SKEW_MS = 5_000;
const MAX_SERVICE_TOKEN_CLOCK_SKEW_MS = 60_000;
const MAX_SERVICE_TOKEN_LENGTH = 8192;
// A deadline header further out than this is treated as absent: no internal
// call legitimately budgets a day.
const MAX_SERVICE_DEADLINE_MS = 24 * 60 * 60 * 1000;

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const TOKEN_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export const SERVICE_IDENTITY_ERROR_CODES = Object.freeze({
  algorithm: "SERVICE_TOKEN_ALGORITHM",
  audience: "SERVICE_TOKEN_AUDIENCE",
  // The body that arrived is not the one the token was signed for.
  bodyMismatch: "SERVICE_TOKEN_BODY_MISMATCH",
  expired: "SERVICE_TOKEN_EXPIRED",
  issuer: "SERVICE_TOKEN_ISSUER",
  // The token's key is not registered for the issuer the token names.
  keyIssuer: "SERVICE_TOKEN_KEY_ISSUER",
  lifetime: "SERVICE_TOKEN_LIFETIME",
  malformed: "SERVICE_TOKEN_MALFORMED",
  missing: "SERVICE_TOKEN_MISSING",
  notConfigured: "SERVICE_IDENTITY_NOT_CONFIGURED",
  notYetValid: "SERVICE_TOKEN_NOT_YET_VALID",
  replayed: "SERVICE_TOKEN_REPLAYED",
  // The token was signed for another method or request target.
  requestMismatch: "SERVICE_TOKEN_REQUEST_MISMATCH",
  // Request binding is required and the token carries none.
  requestUnbound: "SERVICE_TOKEN_REQUEST_UNBOUND",
  signature: "SERVICE_TOKEN_SIGNATURE",
  systemNotAllowed: "SERVICE_TOKEN_SYSTEM_NOT_ALLOWED",
  unknownKey: "SERVICE_TOKEN_UNKNOWN_KEY",
});

// Who may call which tier. The receiving tier enforces it
// (requireServiceIdentity): `callers` may reach its endpoints, `probers` its
// ping, which answers and does nothing. A call site may narrow these lists,
// never widen them. Every edge is a call the code makes today:
//   api -> agent          the edge forwards chat, tasks, agent runs and admin
//                         actions (agent-service/edge-router.js) and probes the
//                         agent's ping (health.js);
//   all -> agent          a monolith with AGENT_SERVICE_URL does the same;
//   agent -> retrieval    remote retrieval (retrieval-service/remote-retrieval.js);
//   all -> retrieval      a monolith with RETRIEVAL_SERVICE_URL;
//   api -> retrieval      ping only. No code sends it today; the tier has
//                         always answered the edge's probe, and a ping does
//                         nothing;
//   * -> model-gateway    every process with MODEL_GATEWAY_URL sends its model
//                         calls there (model-gateway/client.js): the edge (sync
//                         ingest embeddings), the agent, the retrieval tier
//                         (query embeddings, rerank), a monolith, and a
//                         dedicated ingest worker (INTERNAL_SERVICE_ISSUER=
//                         ingest-worker, service-topology.js getServiceIssuer).
// No tier calls itself and the model gateway calls nobody, so neither appears
// as a caller. Under hmac every tier holds the shared keys and the issuer is
// self-asserted; under ed25519 it is proven by the issuer's own key.
export const SERVICE_CALL_POLICY = Object.freeze({
  agent: Object.freeze({
    callers: Object.freeze(["all", "api"]),
    probers: Object.freeze(["all", "api"]),
  }),
  "model-gateway": Object.freeze({
    callers: Object.freeze(["agent", "all", "api", "ingest-worker", "retrieval"]),
    probers: Object.freeze(["agent", "all", "api", "ingest-worker", "retrieval"]),
  }),
  retrieval: Object.freeze({
    callers: Object.freeze(["agent", "all"]),
    probers: Object.freeze(["agent", "all", "api"]),
  }),
});

/**
 * The issuers SERVICE_CALL_POLICY lets reach `audience` for `purpose` ("call"
 * or "probe"); an empty list for an audience the table does not know.
 */
export const getServiceCallPolicyIssuers = (audience, purpose = "call") => {
  const policy = SERVICE_CALL_POLICY[normalizeText(audience)];

  if (!policy) {
    return [];
  }

  return [...(purpose === "probe" ? policy.probers : policy.callers)];
};

export class ServiceIdentityError extends Error {
  constructor(message, { code, status = 401 } = {}) {
    super(message);
    this.name = "ServiceIdentityError";
    this.code = code;
    this.status = status;
  }
}

const normalizeText = (value) => String(value ?? "").trim();

const toInteger = (rawValue, fallbackValue, { min, max }) => {
  const parsed = Number(rawValue);

  if (!normalizeText(rawValue) || !Number.isFinite(parsed)) {
    return fallbackValue;
  }

  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

export const getServiceTokenTtlMs = (env = process.env) =>
  toInteger(env.INTERNAL_SERVICE_TOKEN_TTL_MS, DEFAULT_SERVICE_TOKEN_TTL_MS, {
    max: MAX_SERVICE_TOKEN_TTL_MS,
    min: 1000,
  });

export const getServiceTokenClockSkewMs = (env = process.env) =>
  toInteger(
    env.INTERNAL_SERVICE_TOKEN_CLOCK_SKEW_MS,
    DEFAULT_SERVICE_TOKEN_CLOCK_SKEW_MS,
    { max: MAX_SERVICE_TOKEN_CLOCK_SKEW_MS, min: 0 }
  );

/**
 * INTERNAL_SERVICE_AUTH, validated. Throws ServiceIdentityError (500,
 * SERVICE_IDENTITY_NOT_CONFIGURED) for an unknown mode, so a typo never falls
 * back to another scheme.
 */
export const getServiceAuthMode = (env = process.env) => {
  const mode = readServiceAuthMode(env);

  if (!isServiceAuthModeValid(mode)) {
    throw new ServiceIdentityError(
      `INTERNAL_SERVICE_AUTH must be one of ${SERVICE_AUTH_MODES.join(", ")}.`,
      { code: SERVICE_IDENTITY_ERROR_CODES.notConfigured, status: 500 }
    );
  }

  return mode;
};

/**
 * Whether a token signed with `algorithm` must carry a request binding:
 * INTERNAL_SERVICE_REQUEST_BINDING=required or optional decides for every
 * token; unset, EdDSA tokens need one and HS256 tokens (which predate it) are
 * checked only when they carry one.
 */
export const isServiceRequestBindingRequired = (algorithm, env = process.env) => {
  const setting = normalizeText(env.INTERNAL_SERVICE_REQUEST_BINDING).toLowerCase();

  if (setting === "required") {
    return true;
  }

  if (setting === "optional") {
    return false;
  }

  return algorithm === SERVICE_TOKEN_ALGORITHMS.ed25519;
};

const REPLAY_CACHE_ON = Object.freeze(["1", "on", "true", "yes"]);
const REPLAY_CACHE_OFF = Object.freeze(["0", "off", "false", "no"]);

/**
 * INTERNAL_SERVICE_REPLAY_CACHE (on/off); unset, on under ed25519 and mixed
 * and off under hmac, where tokens stay bearer tokens for their lifetime.
 */
export const isServiceReplayCacheEnabled = (env = process.env) => {
  const setting = normalizeText(env.INTERNAL_SERVICE_REPLAY_CACHE).toLowerCase();

  if (REPLAY_CACHE_ON.includes(setting)) {
    return true;
  }

  if (REPLAY_CACHE_OFF.includes(setting)) {
    return false;
  }

  return readServiceAuthMode(env) !== "hmac";
};

/**
 * Problems with the request-binding and replay-cache switches, for topology
 * validation: a value the getters above do not know would otherwise quietly
 * become the default (a mistyped "on" leaving the replay cache off under
 * hmac). Unset is fine. Lines name the variable, never echo its value.
 */
export const listServiceIdentitySettingErrors = (env = process.env) => {
  const errors = [];
  const binding = normalizeText(env.INTERNAL_SERVICE_REQUEST_BINDING).toLowerCase();
  const replay = normalizeText(env.INTERNAL_SERVICE_REPLAY_CACHE).toLowerCase();

  if (binding && binding !== "required" && binding !== "optional") {
    errors.push("INTERNAL_SERVICE_REQUEST_BINDING must be required or optional (or unset for the default).");
  }

  if (replay && !REPLAY_CACHE_ON.includes(replay) && !REPLAY_CACHE_OFF.includes(replay)) {
    errors.push("INTERNAL_SERVICE_REPLAY_CACHE must be on or off (or unset for the default).");
  }

  return errors;
};

/**
 * Parses INTERNAL_SERVICE_KEYS. Errors name the entry or key id, never the
 * secret. A secret is everything after the first colon, so it may contain
 * colons but not commas.
 */
export const parseServiceKeys = (rawValue) => {
  const keys = [];
  const errors = [];
  const entries = String(rawValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  entries.forEach((entry, index) => {
    const separator = entry.indexOf(":");
    const keyId = separator > 0 ? entry.slice(0, separator).trim() : "";
    const secret = separator > 0 ? entry.slice(separator + 1).trim() : "";

    if (!KEY_ID_PATTERN.test(keyId)) {
      errors.push(
        `INTERNAL_SERVICE_KEYS entry ${index + 1} needs a key id (letters, digits, ".", "_", "-") followed by ":" and the secret.`
      );
      return;
    }

    if (keys.some((key) => key.keyId === keyId)) {
      errors.push(`INTERNAL_SERVICE_KEYS lists key id "${keyId}" more than once.`);
      return;
    }

    if (secret.length < MIN_SERVICE_KEY_SECRET_LENGTH) {
      errors.push(
        `INTERNAL_SERVICE_KEYS key "${keyId}" is shorter than ${MIN_SERVICE_KEY_SECRET_LENGTH} characters.`
      );
      return;
    }

    keys.push({ keyId, secret });
  });

  return { errors, keys };
};

const describeHmacKeys = (env) => {
  const { errors, keys } = parseServiceKeys(env.INTERNAL_SERVICE_KEYS);

  return {
    configured: keys.length > 0 && errors.length === 0,
    errors,
    keyIds: keys.map((key) => key.keyId),
    signingKeyId: keys[0]?.keyId ?? null,
  };
};

const listKeyIdCollisions = (hmacKeyIds, trustedKeyIds) =>
  hmacKeyIds
    .filter((keyId) => trustedKeyIds.includes(keyId))
    .map(
      (keyId) =>
        `Key id "${keyId}" is listed in both INTERNAL_SERVICE_KEYS and INTERNAL_SERVICE_TRUSTED_KEYS; give each key its own id.`
    );

/**
 * Secret-free key status for topology validation and health output. Under
 * hmac it is { configured, errors, keyIds, signingKeyId } of
 * INTERNAL_SERVICE_KEYS, as it always was. Under ed25519 and mixed it adds
 * { mode, trustedKeys: [{ issuer, keyId }] }; `configured` then means this
 * process can verify (valid trusted keys, and a valid INTERNAL_SERVICE_KEYS
 * under mixed when one is set) and any signing key set is valid, keyIds lists
 * every key id it verifies with, and signingKeyId is its Ed25519 key's id
 * (null for a tier that only verifies). Public keys are never listed.
 */
export const getServiceKeyStatus = (env = process.env) => {
  const mode = readServiceAuthMode(env);

  if (!isServiceAuthModeValid(mode)) {
    return {
      configured: false,
      errors: [`INTERNAL_SERVICE_AUTH must be one of ${SERVICE_AUTH_MODES.join(", ")}.`],
      keyIds: [],
      mode: "invalid",
      signingKeyId: null,
      trustedKeys: [],
    };
  }

  const hmac = describeHmacKeys(env);

  if (mode === "hmac") {
    return hmac;
  }

  const signing = parseServiceSigningKey(env.INTERNAL_SERVICE_SIGNING_KEY, env.INTERNAL_SERVICE_SIGNING_KEY_ID);
  const trusted = parseTrustedServiceKeys(env.INTERNAL_SERVICE_TRUSTED_KEYS);
  const trustedKeyIds = [...trusted.byKeyId.keys()];
  const hmacInUse = mode === "mixed" && normalizeText(env.INTERNAL_SERVICE_KEYS) !== "";
  const errors = [
    ...(signing.error ? [signing.error] : []),
    ...trusted.errors,
    ...(hmacInUse ? hmac.errors : []),
    ...(hmacInUse ? listKeyIdCollisions(hmac.keyIds, trustedKeyIds) : []),
  ];

  return {
    configured: errors.length === 0 && trustedKeyIds.length > 0,
    errors,
    keyIds: [...trustedKeyIds, ...(hmacInUse ? hmac.keyIds : [])],
    mode,
    signingKeyId: signing.key?.keyId ?? null,
    trustedKeys: trusted.entries.map(({ issuer, keyId }) => ({ issuer, keyId })),
  };
};

// Parsed keyrings by their inputs. PEM/DER parsing is not free, and tests
// switch between a handful of environments, so a few are kept.
const keyringCache = new Map();
const KEYRING_CACHE_LIMIT = 8;

const notConfiguredError = (message) =>
  new ServiceIdentityError(message, { code: SERVICE_IDENTITY_ERROR_CODES.notConfigured, status: 500 });

// A keyring: what this process signs with (`signer`, or `signerError`) and the
// keys it verifies with by key id (`verifiers`, or `verifierError`), each
// pinned to one algorithm. A verify-only tier needs no signer and a pure
// signer no verifiers, so each half fails only when it is used.
const buildKeyring = (env, mode) => {
  const keyring = {
    algorithms: new Set(),
    mode,
    signer: null,
    signerError: null,
    verifierError: null,
    verifiers: new Map(),
  };

  if (mode === "hmac" || mode === "mixed") {
    const { errors, keys } = parseServiceKeys(env.INTERNAL_SERVICE_KEYS);

    keyring.algorithms.add(SERVICE_TOKEN_ALGORITHMS.hmac);

    if (errors.length > 0 || (mode === "hmac" && keys.length === 0)) {
      const message = "Internal service identity is not configured: set INTERNAL_SERVICE_KEYS.";

      keyring.verifierError = message;
      keyring.signerError = message;
    } else {
      for (const key of keys) {
        keyring.verifiers.set(key.keyId, { algorithm: SERVICE_TOKEN_ALGORITHMS.hmac, secret: key.secret });
      }

      if (mode === "hmac") {
        keyring.signer = { algorithm: SERVICE_TOKEN_ALGORITHMS.hmac, keyId: keys[0].keyId, secret: keys[0].secret };
      }
    }
  }

  if (mode === "ed25519" || mode === "mixed") {
    const signing = parseServiceSigningKey(env.INTERNAL_SERVICE_SIGNING_KEY, env.INTERNAL_SERVICE_SIGNING_KEY_ID);
    const trusted = parseTrustedServiceKeys(env.INTERNAL_SERVICE_TRUSTED_KEYS);

    keyring.algorithms.add(SERVICE_TOKEN_ALGORITHMS.ed25519);
    keyring.signerError = signing.error
      ? "Internal service identity is not configured: INTERNAL_SERVICE_SIGNING_KEY is invalid."
      : signing.key
        ? null
        : "Internal service identity is not configured: set INTERNAL_SERVICE_SIGNING_KEY.";
    keyring.signer = signing.key
      ? { algorithm: SERVICE_TOKEN_ALGORITHMS.ed25519, keyId: signing.key.keyId, privateKey: signing.key.privateKey }
      : null;

    if (trusted.errors.length > 0) {
      keyring.verifierError = "Internal service identity is not configured: INTERNAL_SERVICE_TRUSTED_KEYS is invalid.";
    } else if (!keyring.verifierError) {
      for (const { issuers, keyId, publicKey } of trusted.byKeyId.values()) {
        if (keyring.verifiers.has(keyId)) {
          keyring.verifierError = `Internal service identity is not configured: key id "${keyId}" is listed in both INTERNAL_SERVICE_KEYS and INTERNAL_SERVICE_TRUSTED_KEYS.`;
          break;
        }

        keyring.verifiers.set(keyId, {
          algorithm: SERVICE_TOKEN_ALGORITHMS.ed25519,
          issuers: new Set(issuers),
          publicKey,
        });
      }
    }
  }

  if (!keyring.verifierError && keyring.verifiers.size === 0) {
    keyring.verifierError =
      mode === "hmac"
        ? "Internal service identity is not configured: set INTERNAL_SERVICE_KEYS."
        : "Internal service identity is not configured: set INTERNAL_SERVICE_TRUSTED_KEYS.";
  }

  if (keyring.verifierError) {
    keyring.verifiers.clear();
  }

  return keyring;
};

const resolveKeyring = (env) => {
  const mode = getServiceAuthMode(env);
  const cacheKey = [
    mode,
    env.INTERNAL_SERVICE_KEYS,
    env.INTERNAL_SERVICE_SIGNING_KEY,
    env.INTERNAL_SERVICE_SIGNING_KEY_ID,
    env.INTERNAL_SERVICE_TRUSTED_KEYS,
  ]
    .map((value) => String(value ?? ""))
    .join("\u0000");
  const cached = keyringCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const keyring = buildKeyring(env, mode);

  keyringCache.set(cacheKey, keyring);

  if (keyringCache.size > KEYRING_CACHE_LIMIT) {
    keyringCache.delete(keyringCache.keys().next().value);
  }

  return keyring;
};

const resolveSigner = (env) => {
  const keyring = resolveKeyring(env);

  if (!keyring.signer) {
    throw notConfiguredError(keyring.signerError ?? "Internal service identity is not configured.");
  }

  return keyring.signer;
};

const resolveVerifiers = (env) => {
  const keyring = resolveKeyring(env);

  if (keyring.verifierError) {
    throw notConfiguredError(keyring.verifierError);
  }

  return keyring;
};

const resolveNowMs = (now) => {
  const value = typeof now === "function" ? now() : now;

  if (value === undefined || value === null) {
    return Date.now();
  }

  const milliseconds = value instanceof Date ? value.getTime() : Number(value);

  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("now must be a Date, a millisecond timestamp, or a function returning one.");
  }

  return milliseconds;
};

const base64UrlEncode = (value) => Buffer.from(value).toString("base64url");

const signInput = (input, secret) =>
  crypto.createHmac("sha256", secret).update(input).digest("base64url");

const timingSafeTextEqual = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const ED25519_SIGNATURE_BYTES = 64;

const signWith = (signer, input) =>
  signer.algorithm === SERVICE_TOKEN_ALGORITHMS.hmac
    ? signInput(input, signer.secret)
    : crypto.sign(null, Buffer.from(input), signer.privateKey).toString("base64url");

// Checks a signature with the key's own algorithm, never the header's: the
// caller has already refused a header whose alg differs from the key's.
const isSignatureValid = (key, input, signature) => {
  if (key.algorithm === SERVICE_TOKEN_ALGORITHMS.hmac) {
    return timingSafeTextEqual(signature, signInput(input, key.secret));
  }

  const bytes = Buffer.from(signature, "base64url");

  if (bytes.length !== ED25519_SIGNATURE_BYTES || bytes.toString("base64url") !== signature) {
    return false;
  }

  try {
    return crypto.verify(null, Buffer.from(input), key.publicKey, bytes);
  } catch {
    return false;
  }
};

const sha256Base64Url = (value) => crypto.createHash("sha256").update(value).digest("base64url");

const BINDING_BASE_URL = "http://service.invalid";

/**
 * The request target as both sides see it: path plus query, after the WHATWG
 * URL parser fetch also applies (percent-encoding, dot segments). The client
 * signs the target it passes to fetch and the receiver checks req.originalUrl,
 * so both go through the same normalization.
 */
export const canonicalizeServiceRequestTarget = (target) => {
  const url = new URL(String(target ?? ""), BINDING_BASE_URL);

  return `${url.pathname}${url.search}`;
};

const digestRequestTarget = (target) => sha256Base64Url(canonicalizeServiceRequestTarget(target));

const toBodyBytes = (body) => {
  if (body === undefined || body === null) {
    return null;
  }

  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  throw new TypeError("A bound request body must be a string, an ArrayBuffer, or a typed array.");
};

/**
 * The digest a token binds a body to: base64url SHA-256 of its bytes, or null
 * for no body or an empty one (the receiver treats both as "no body").
 */
export const digestServiceRequestBody = (body) => {
  const bytes = toBodyBytes(body);

  return bytes && bytes.length > 0 ? sha256Base64Url(bytes) : null;
};

const buildRequestBinding = (request) => {
  if (request === undefined || request === null) {
    return {};
  }

  if (!isPlainObject(request)) {
    throw new TypeError("request must be { method, target, body? }.");
  }

  const method = normalizeText(request.method).toUpperCase();
  const target = normalizeText(request.target);

  if (!/^[A-Z]{1,16}$/u.test(method) || !target.startsWith("/")) {
    throw new TypeError("A bound request needs its method and its target (a path starting with /).");
  }

  const bodyDigest = digestServiceRequestBody(request.body);

  return {
    htm: method,
    htu: digestRequestTarget(target),
    ...(bodyDigest ? { bdh: bodyDigest } : {}),
  };
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The access scope a token carries, reduced to the fields requireApiAuth sets:
 * { authenticated, authProvider?, userId, workspaceId, permissionIds?,
 * roleIds?, allowedWorkspaceIds? }. Anything else on the object (a raw token,
 * a principal's secrets) is dropped, never signed.
 */
export const normalizeServiceAccessScope = (accessScope) => {
  if (!isPlainObject(accessScope)) {
    throw new TypeError("accessScope must be an object.");
  }

  const target = {
    authenticated: accessScope.authenticated === true,
    authProvider: normalizeText(accessScope.authProvider),
    userId: normalizeText(accessScope.userId),
    workspaceId: normalizeText(accessScope.workspaceId),
  };

  if (!target.authProvider) {
    delete target.authProvider;
  }

  return addAccessPrincipalAuthorizationMetadata(target, accessScope);
};

/**
 * Mints a token for one internal call. Either `accessScope` (the caller's
 * req.accessScope, including an auth-disabled scope with empty ids) or
 * `system: true` (a call that acts for no tenant, such as health between
 * services) is required, so a forgotten scope never becomes a system call.
 * `claims` is a small JSON object of extra identifiers (a run id, a purpose);
 * never put questions, prompts, document text, or secrets in it.
 * `request` ({ method, target, body? }) binds the token to one request: the
 * method, a digest of the target (path and query, as passed to fetch) and of
 * the body bytes (a string, ArrayBuffer or typed array). The service client
 * always binds; a token without it is refused wherever binding is required.
 * The algorithm follows INTERNAL_SERVICE_AUTH: HS256 under hmac, EdDSA with
 * this process's own key under ed25519 and mixed.
 */
export const signServiceToken = ({
  accessScope,
  audience,
  claims,
  env = process.env,
  issuer,
  now,
  request,
  system = false,
  ttlMs,
} = {}) => {
  const normalizedAudience = normalizeText(audience);
  const normalizedIssuer = normalizeText(issuer);

  if (!normalizedAudience) {
    throw new TypeError("signServiceToken needs an audience.");
  }

  if (!normalizedIssuer) {
    throw new TypeError("signServiceToken needs an issuer.");
  }

  if (system !== true && !isPlainObject(accessScope)) {
    throw new TypeError(
      "signServiceToken needs the caller's accessScope, or system: true for a call that acts for no tenant."
    );
  }

  if (system === true && accessScope !== undefined && accessScope !== null) {
    throw new TypeError("A system token carries no accessScope.");
  }

  if (claims !== undefined && !isPlainObject(claims)) {
    throw new TypeError("claims must be a plain object.");
  }

  const binding = buildRequestBinding(request);
  const signer = resolveSigner(env);
  const nowMs = resolveNowMs(now);
  const lifetimeMs = Math.min(
    MAX_SERVICE_TOKEN_TTL_MS,
    Math.max(1000, Math.floor(Number(ttlMs ?? getServiceTokenTtlMs(env)) || 0))
  );
  const payload = {
    iss: normalizedIssuer,
    aud: normalizedAudience,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + lifetimeMs) / 1000),
    jti: crypto.randomUUID(),
    ...(system === true
      ? { sys: true }
      : { scope: normalizeServiceAccessScope(accessScope) }),
    ...(claims && Object.keys(claims).length > 0 ? { claims } : {}),
    ...binding,
  };
  const encodedHeader = base64UrlEncode(
    JSON.stringify({ alg: signer.algorithm, kid: signer.keyId, typ: "JWT" })
  );
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const token = `${input}.${signWith(signer, input)}`;

  if (token.length > MAX_SERVICE_TOKEN_LENGTH) {
    throw new RangeError(
      `Internal service token exceeds ${MAX_SERVICE_TOKEN_LENGTH} characters; keep claims small.`
    );
  }

  return token;
};

const rejectToken = (code, status = 401) =>
  new ServiceIdentityError(
    status === 403 ? "Internal service token is not accepted here." : "Invalid internal service token.",
    { code, status }
  );

const parseTokenPart = (segment) => {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
};

const toIssuerList = (issuers) =>
  issuers === undefined || issuers === null
    ? null
    : (Array.isArray(issuers) ? issuers : [issuers]).map(normalizeText).filter(Boolean);

const readBinding = (payload) => {
  const present = ["htm", "htu", "bdh"].some((field) => payload[field] !== undefined);

  if (!present) {
    return null;
  }

  if (
    typeof payload.htm !== "string" ||
    typeof payload.htu !== "string" ||
    (payload.bdh !== undefined && typeof payload.bdh !== "string")
  ) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.malformed);
  }

  return { bodyDigest: payload.bdh ?? null, method: payload.htm, targetDigest: payload.htu };
};

// The request a bound token must match: same method, same target, and a body
// exactly when the token names one (its bytes are checked by
// verifyServiceRequestBody once the parser has read them).
const checkBinding = (binding, request, algorithm, env) => {
  if (!binding) {
    if (isServiceRequestBindingRequired(algorithm, env)) {
      throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.requestUnbound);
    }

    return;
  }

  let targetDigest;

  try {
    targetDigest = digestRequestTarget(request.target);
  } catch {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.requestMismatch);
  }

  if (
    binding.method !== normalizeText(request.method).toUpperCase() ||
    !timingSafeTextEqual(binding.targetDigest, targetDigest)
  ) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.requestMismatch);
  }

  if (request.hasBody !== undefined && Boolean(binding.bodyDigest) !== Boolean(request.hasBody)) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.bodyMismatch);
  }
};

/**
 * Verifies a token for `audience` and returns
 * { issuer, audience, accessScope, claims, system, keyId, tokenId, issuedAt,
 * expiresAt, algorithm, binding } (times in milliseconds; accessScope null
 * for a system token; binding { method, targetDigest, bodyDigest } or null).
 * The token's alg must be one INTERNAL_SERVICE_AUTH accepts and the alg of
 * the key its kid names (each key is pinned to one algorithm); an HMAC
 * signature is compared in constant time; all before the payload is read. An
 * Ed25519 key must be registered for the issuer the token names. exp/iat
 * allow INTERNAL_SERVICE_TOKEN_CLOCK_SKEW_MS of skew. `issuers`, when given,
 * lists the only issuers accepted. `request` ({ method, target, hasBody? }),
 * when given, checks the request binding (requireServiceIdentity always
 * passes it); without it the binding is returned but not checked. Throws
 * ServiceIdentityError.
 */
export const verifyServiceToken = (
  token,
  { audience, clockSkewMs, env = process.env, issuers, now, request } = {}
) => {
  const expectedAudience = normalizeText(audience);

  if (!expectedAudience) {
    throw new TypeError("verifyServiceToken needs the expected audience.");
  }

  const keyring = resolveVerifiers(env);
  const rawToken = normalizeText(token);

  if (!rawToken) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.missing);
  }

  const segments = rawToken.split(".");

  if (
    rawToken.length > MAX_SERVICE_TOKEN_LENGTH ||
    segments.length !== 3 ||
    !segments.every((segment) => TOKEN_SEGMENT_PATTERN.test(segment))
  ) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.malformed);
  }

  const [encodedHeader, encodedPayload, signature] = segments;
  const header = parseTokenPart(encodedHeader);

  if (!header) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.malformed);
  }

  if (!keyring.algorithms.has(header.alg) || header.crit !== undefined) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.algorithm);
  }

  const keyId = typeof header.kid === "string" ? header.kid : "";
  const key = keyring.verifiers.get(keyId);

  if (!key) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.unknownKey);
  }

  // A key verifies only tokens of its own algorithm: an HS256 header naming
  // an Ed25519 key (the public key used as an HMAC secret) or the reverse is
  // refused before any signature is computed.
  if (header.alg !== key.algorithm) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.algorithm);
  }

  if (!isSignatureValid(key, `${encodedHeader}.${encodedPayload}`, signature)) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.signature);
  }

  const payload = parseTokenPart(encodedPayload);

  if (
    !payload ||
    !Number.isFinite(payload.iat) ||
    !Number.isFinite(payload.exp) ||
    typeof payload.iss !== "string" ||
    typeof payload.aud !== "string"
  ) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.malformed);
  }

  // The signature proves which key signed; the key's registration proves
  // which issuer that may be. Another tier's valid key naming this issuer is
  // a forgery.
  if (key.issuers && !key.issuers.has(payload.iss)) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.keyIssuer);
  }

  const nowMs = resolveNowMs(now);
  const skewMs =
    clockSkewMs === undefined
      ? getServiceTokenClockSkewMs(env)
      : Math.max(0, Number(clockSkewMs) || 0);
  const issuedAt = payload.iat * 1000;
  const expiresAt = payload.exp * 1000;

  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_SERVICE_TOKEN_TTL_MS + 1000) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.lifetime);
  }

  if (issuedAt > nowMs + skewMs) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.notYetValid);
  }

  if (nowMs >= expiresAt + skewMs) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.expired);
  }

  if (payload.aud !== expectedAudience) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.audience, 403);
  }

  const allowedIssuers = toIssuerList(issuers);

  if (allowedIssuers && !allowedIssuers.includes(payload.iss)) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.issuer, 403);
  }

  const system = payload.sys === true;

  if (system === isPlainObject(payload.scope)) {
    // Exactly one of a tenant scope and the system marker.
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.malformed);
  }

  if (payload.claims !== undefined && !isPlainObject(payload.claims)) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.malformed);
  }

  const binding = readBinding(payload);

  if (request !== undefined && request !== null) {
    checkBinding(binding, request, key.algorithm, env);
  }

  return {
    accessScope: system ? null : normalizeServiceAccessScope(payload.scope),
    algorithm: key.algorithm,
    audience: payload.aud,
    binding,
    claims: payload.claims ?? {},
    expiresAt,
    issuedAt,
    issuer: payload.iss,
    keyId,
    system,
    tokenId: typeof payload.jti === "string" ? payload.jti : "",
  };
};

const readHeader = (req, name) => {
  const value = typeof req.get === "function" ? req.get(name) : req.headers?.[name];

  return normalizeText(Array.isArray(value) ? value[0] : value);
};

/**
 * The request id the calling tier sent, when it is a plain identifier.
 */
export const getServiceRequestId = (req) => {
  const value = readHeader(req, SERVICE_REQUEST_ID_HEADER);

  return REQUEST_ID_PATTERN.test(value) ? value : null;
};

const readDeadlineAt = (req, nowMs) => {
  const raw = readHeader(req, SERVICE_DEADLINE_HEADER);

  if (!/^\d+$/u.test(raw)) {
    return null;
  }

  const remainingMs = Number(raw);

  return remainingMs <= MAX_SERVICE_DEADLINE_MS ? nowMs + remainingMs : null;
};

/**
 * What is left of the calling tier's budget for this request, in milliseconds
 * (0 once it has passed), or null when the caller sent no deadline. The
 * deadline is fixed when requireServiceIdentity accepts the request, so the
 * time the request spent in this tier counts against it.
 */
export const getServiceDeadlineRemainingMs = (req, { now } = {}) => {
  const deadlineAt = req?.serviceIdentity?.deadlineAt;

  if (!Number.isFinite(deadlineAt)) {
    return null;
  }

  return Math.max(0, deadlineAt - resolveNowMs(now));
};

const removeRawHeaders = (req, shouldRemove) => {
  if (!Array.isArray(req.rawHeaders)) {
    return;
  }

  const kept = [];

  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    if (!shouldRemove(String(req.rawHeaders[index]).toLowerCase())) {
      kept.push(req.rawHeaders[index], req.rawHeaders[index + 1]);
    }
  }

  req.rawHeaders.length = 0;
  req.rawHeaders.push(...kept);
};

const deleteMatchingKeys = (object, shouldRemove) => {
  const removed = [];

  if (isPlainObject(object)) {
    for (const name of Object.keys(object)) {
      if (shouldRemove(name.toLowerCase())) {
        delete object[name];
        removed.push(name.toLowerCase());
      }
    }
  }

  return removed;
};

const removeHeaders = (target, shouldRemove) => {
  const isRequest = isPlainObject(target?.headers);

  if (!isRequest) {
    return [...new Set(deleteMatchingKeys(target, shouldRemove))];
  }

  // Node builds headers and headersDistinct lazily from rawHeaders, counting
  // the original number of entries, so both are materialized (and cleaned)
  // before rawHeaders shrinks.
  const distinct = target.headersDistinct;
  const removed = deleteMatchingKeys(target.headers, shouldRemove);

  deleteMatchingKeys(distinct, shouldRemove);
  removeRawHeaders(target, shouldRemove);

  return [...new Set(removed)];
};

const isInternalHeaderName = (name) => name.startsWith(SERVICE_HEADER_PREFIX);

/**
 * Removes every x-archive-service-* header from an inbound public request (or
 * a plain headers object) and returns the lower-cased names it removed. The
 * public edge runs this before anything reads headers, so a client cannot
 * present an internal token, deadline, or request id.
 */
export const stripInternalServiceHeaders = (target) =>
  target && typeof target === "object" ? removeHeaders(target, isInternalHeaderName) : [];

export const stripInternalServiceHeadersMiddleware = (req, res, next) => {
  stripInternalServiceHeaders(req);
  next();
};

const verifiedRequests = new WeakMap();

const EMPTY_SYSTEM_SCOPE = () => ({ authenticated: false, userId: "", workspaceId: "" });

const sendIdentityError = (res, error) => {
  const status = error instanceof ServiceIdentityError ? error.status : 500;
  const code =
    error instanceof ServiceIdentityError ? error.code : SERVICE_IDENTITY_ERROR_CODES.notConfigured;
  const message =
    status === 401
      ? "Unauthorized."
      : status === 403
        ? "Forbidden."
        : "Internal service identity is not configured.";

  res.status(status).json({ code, error: message });
};

// Bound requests whose body the JSON parser must still check, by request:
// the digest the token names, or null for a token that names no body.
const boundBodies = new WeakMap();

const requestHasBody = (req) => {
  const headers = req.headers ?? {};
  const length = Number(headers["content-length"]);

  return headers["transfer-encoding"] !== undefined || (Number.isFinite(length) && length > 0);
};

// The media type the internal tiers' JSON parser reads (express.json's
// default). verifyServiceRequestBody runs inside that parser only, so a bound
// body of any other type would reach the route unparsed and unchecked.
const isJsonRequest = (req) =>
  readHeader(req, "content-type").split(";")[0].trim().toLowerCase() === "application/json";

/**
 * Express middleware for an internal tier: accepts only a valid token for
 * `audience` in SERVICE_TOKEN_HEADER, then sets
 *   req.accessScope     the caller's scope, shaped as requireApiAuth sets it
 *                       ({ authenticated: false, userId: "", workspaceId: "" }
 *                       for a system call, which bindDatabaseTenant runs as no
 *                       tenant);
 *   req.serviceIdentity { issuer, audience, system, claims, keyId, tokenId,
 *                       expiresAt, requestId, deadlineAt }.
 * Only issuers SERVICE_CALL_POLICY lets reach `audience` get through:
 * `purpose` "call" (default) uses its callers, "probe" (a ping that does
 * nothing) its probers, and `issuers` may narrow that list but not widen it.
 * A system token is refused (403) unless `allowSystem` is true, so a tenant
 * route cannot be reached unscoped by mistake. The token's request binding is
 * checked against this request (method, target, whether it has a body, and
 * that a bound body is application/json); mount the JSON parser with
 * `verify: verifyServiceRequestBody` and handleServiceRequestBodyError after
 * it so the body bytes are checked too.
 * With the replay cache on (isServiceReplayCacheEnabled) a token is accepted
 * once; `replayCache` is injectable for tests. Failures answer 401/403/500
 * JSON { error, code } and never echo the token. The token header is removed
 * from the request once verified, so nothing downstream can log or forward
 * it; mounting the middleware twice for the same audience is a no-op.
 */
export const requireServiceIdentity = ({
  allowSystem = false,
  audience,
  env,
  issuers,
  now,
  purpose = "call",
  replayCache,
} = {}) => {
  const expectedAudience = normalizeText(audience);

  if (!expectedAudience) {
    throw new TypeError("requireServiceIdentity needs an audience.");
  }

  if (!SERVICE_CALL_POLICY[expectedAudience]) {
    throw new TypeError(`No SERVICE_CALL_POLICY entry for the audience "${expectedAudience}".`);
  }

  if (purpose !== "call" && purpose !== "probe") {
    throw new TypeError('requireServiceIdentity purpose must be "call" or "probe".');
  }

  const policyIssuers = getServiceCallPolicyIssuers(expectedAudience, purpose);
  const narrowed = toIssuerList(issuers);

  if (narrowed && narrowed.some((issuer) => !policyIssuers.includes(issuer))) {
    throw new TypeError(
      `requireServiceIdentity issuers for "${expectedAudience}" must be among ${policyIssuers.join(", ")} (SERVICE_CALL_POLICY).`
    );
  }

  const allowedIssuers = narrowed ?? policyIssuers;

  return (req, res, next) => {
    if (verifiedRequests.get(req) === expectedAudience) {
      next();
      return;
    }

    const activeEnv = env ?? process.env;
    let identity;

    try {
      identity = verifyServiceToken(readHeader(req, SERVICE_TOKEN_HEADER), {
        audience: expectedAudience,
        env: activeEnv,
        issuers: allowedIssuers,
        now,
      });

      if (identity.system && allowSystem !== true) {
        throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.systemNotAllowed, 403);
      }

      // Last, so a token this tier would refuse anyway gets the policy's 403.
      checkBinding(
        identity.binding,
        { hasBody: requestHasBody(req), method: req.method, target: req.originalUrl ?? req.url },
        identity.algorithm,
        activeEnv
      );

      // A token that names a body is accepted only with the JSON the parser
      // checks it against; another type would skip that check.
      if (identity.binding?.bodyDigest && !isJsonRequest(req)) {
        throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.bodyMismatch);
      }
    } catch (error) {
      sendIdentityError(res, error);
      return;
    }

    const accept = () => {
      const arrivedAt = resolveNowMs(now);

      req.accessScope = identity.accessScope ?? EMPTY_SYSTEM_SCOPE();
      req.serviceIdentity = {
        audience: identity.audience,
        claims: identity.claims,
        deadlineAt: readDeadlineAt(req, arrivedAt),
        expiresAt: identity.expiresAt,
        issuer: identity.issuer,
        keyId: identity.keyId,
        requestId: getServiceRequestId(req),
        system: identity.system,
        tokenId: identity.tokenId,
      };

      if (identity.binding) {
        boundBodies.set(req, identity.binding.bodyDigest);
      }

      removeHeaders(req, (name) => name === SERVICE_TOKEN_HEADER);
      verifiedRequests.set(req, expectedAudience);
      next();
    };

    if (!isServiceReplayCacheEnabled(activeEnv)) {
      accept();
      return;
    }

    if (!identity.tokenId) {
      sendIdentityError(res, rejectToken(SERVICE_IDENTITY_ERROR_CODES.malformed));
      return;
    }

    const cache = replayCache ?? getServiceTokenReplayCache(activeEnv);
    const settle = (fresh) => {
      if (fresh) {
        accept();
      } else {
        sendIdentityError(res, rejectToken(SERVICE_IDENTITY_ERROR_CODES.replayed));
      }
    };
    // Remembered until the token could no longer pass the expiry check.
    const claimed = cache.claim(
      `${identity.issuer}:${identity.tokenId}`,
      identity.expiresAt + getServiceTokenClockSkewMs(activeEnv)
    );

    if (typeof claimed?.then === "function") {
      claimed.then(settle, () => settle(true));
    } else {
      settle(claimed);
    }
  };
};

/**
 * The JSON parser's `verify` hook on an internal tier
 * (express.json({ verify: verifyServiceRequestBody })): for a request whose
 * token is bound, the body bytes must hash to the digest the token names, and
 * a token that names no body admits only an empty one. Unbound requests pass.
 * Throws a ServiceIdentityError (401) that handleServiceRequestBodyError
 * answers.
 */
export const verifyServiceRequestBody = (req, res, buffer) => {
  if (!boundBodies.has(req)) {
    return;
  }

  const expected = boundBodies.get(req);
  const actual = buffer && buffer.length > 0 ? sha256Base64Url(buffer) : null;

  if (expected === null ? actual === null : actual !== null && timingSafeTextEqual(expected, actual)) {
    return;
  }

  const error = rejectToken(SERVICE_IDENTITY_ERROR_CODES.bodyMismatch);

  error.type = "service.identity.body";
  throw error;
};

/**
 * Error middleware to mount right after a parser that uses
 * verifyServiceRequestBody: answers its refusal like requireServiceIdentity
 * (401 { code, error }) and passes every other error on. The parser attaches
 * the raw body to the error; it is dropped here, never logged or echoed.
 */
export const handleServiceRequestBodyError = (error, req, res, next) => {
  if (!(error instanceof ServiceIdentityError)) {
    next(error);
    return;
  }

  delete error.body;

  if (res.headersSent) {
    next(error);
    return;
  }

  sendIdentityError(res, error);
};
