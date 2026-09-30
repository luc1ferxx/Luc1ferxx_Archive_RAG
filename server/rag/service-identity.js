import crypto from "node:crypto";

import { addAccessPrincipalAuthorizationMetadata } from "../access-scope.js";

// Signed identity for calls between the tiers of a split deployment
// (ARCHIVE_RAG_ROLE, see service-topology.js).
//
// The public edge authenticates the user once (requireApiAuth) and forwards
// work to an internal tier with a short-lived HS256 token that carries the
// caller's access scope. The receiving tier accepts nothing else: its
// requireServiceIdentity middleware verifies the token and sets req.accessScope
// in exactly the shape requireApiAuth produces, so bindDatabaseTenant and every
// route behave as they do in the monolith.
//
// Keys come from INTERNAL_SERVICE_KEYS = "kid1:secret1,kid2:secret2". The first
// key signs and every key verifies, so a key rotates in three rolls: append the
// new key everywhere (all tiers verify it), move it to the front (it signs),
// then remove the old one. Prepending in one roll would let a restarted tier
// sign with a key the tiers not yet restarted cannot verify. Tokens are bearer tokens for
// their lifetime (60 s by default); they are not bound to one request and there
// is no replay cache, so they must only travel over the internal network.
//
// Every internal header shares SERVICE_HEADER_PREFIX, so the public edge can
// strip all of them from inbound requests (stripInternalServiceHeaders) and a
// public client can never present an internal identity.

export const SERVICE_HEADER_PREFIX = "x-archive-service-";
export const SERVICE_TOKEN_HEADER = `${SERVICE_HEADER_PREFIX}token`;
export const SERVICE_DEADLINE_HEADER = `${SERVICE_HEADER_PREFIX}deadline-ms`;
export const SERVICE_REQUEST_ID_HEADER = `${SERVICE_HEADER_PREFIX}request-id`;

export const SERVICE_TOKEN_ALGORITHM = "HS256";
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
  expired: "SERVICE_TOKEN_EXPIRED",
  issuer: "SERVICE_TOKEN_ISSUER",
  lifetime: "SERVICE_TOKEN_LIFETIME",
  malformed: "SERVICE_TOKEN_MALFORMED",
  missing: "SERVICE_TOKEN_MISSING",
  notConfigured: "SERVICE_IDENTITY_NOT_CONFIGURED",
  notYetValid: "SERVICE_TOKEN_NOT_YET_VALID",
  signature: "SERVICE_TOKEN_SIGNATURE",
  systemNotAllowed: "SERVICE_TOKEN_SYSTEM_NOT_ALLOWED",
  unknownKey: "SERVICE_TOKEN_UNKNOWN_KEY",
});

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

/**
 * Secret-free key status for topology validation and health output.
 */
export const getServiceKeyStatus = (env = process.env) => {
  const { errors, keys } = parseServiceKeys(env.INTERNAL_SERVICE_KEYS);

  return {
    configured: keys.length > 0 && errors.length === 0,
    errors,
    keyIds: keys.map((key) => key.keyId),
    signingKeyId: keys[0]?.keyId ?? null,
  };
};

let cachedKeyring = { keyring: null, rawValue: undefined };

const resolveKeyring = (env) => {
  const rawValue = String(env.INTERNAL_SERVICE_KEYS ?? "");

  if (cachedKeyring.rawValue === rawValue && cachedKeyring.keyring) {
    return cachedKeyring.keyring;
  }

  const { errors, keys } = parseServiceKeys(rawValue);

  if (keys.length === 0 || errors.length > 0) {
    throw new ServiceIdentityError(
      "Internal service identity is not configured: set INTERNAL_SERVICE_KEYS.",
      { code: SERVICE_IDENTITY_ERROR_CODES.notConfigured, status: 500 }
    );
  }

  const keyring = {
    byId: new Map(keys.map((key) => [key.keyId, key.secret])),
    signingKey: keys[0],
  };
  cachedKeyring = { keyring, rawValue };

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
 */
export const signServiceToken = ({
  accessScope,
  audience,
  claims,
  env = process.env,
  issuer,
  now,
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

  const { signingKey } = resolveKeyring(env);
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
  };
  const encodedHeader = base64UrlEncode(
    JSON.stringify({ alg: SERVICE_TOKEN_ALGORITHM, kid: signingKey.keyId, typ: "JWT" })
  );
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const token = `${input}.${signInput(input, signingKey.secret)}`;

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

/**
 * Verifies a token for `audience` and returns
 * { issuer, audience, accessScope, claims, system, keyId, tokenId, issuedAt,
 * expiresAt } (times in milliseconds; accessScope null for a system token).
 * The algorithm is pinned to HS256, the key id must be configured, the
 * signature is compared in constant time before the payload is read, and
 * exp/iat allow INTERNAL_SERVICE_TOKEN_CLOCK_SKEW_MS of skew. `issuers`, when
 * given, lists the only issuers accepted. Throws ServiceIdentityError.
 */
export const verifyServiceToken = (
  token,
  { audience, clockSkewMs, env = process.env, issuers, now } = {}
) => {
  const expectedAudience = normalizeText(audience);

  if (!expectedAudience) {
    throw new TypeError("verifyServiceToken needs the expected audience.");
  }

  const keyring = resolveKeyring(env);
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

  if (header.alg !== SERVICE_TOKEN_ALGORITHM || header.crit !== undefined) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.algorithm);
  }

  const keyId = typeof header.kid === "string" ? header.kid : "";
  const secret = keyring.byId.get(keyId);

  if (!secret) {
    throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.unknownKey);
  }

  if (!timingSafeTextEqual(signature, signInput(`${encodedHeader}.${encodedPayload}`, secret))) {
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

  return {
    accessScope: system ? null : normalizeServiceAccessScope(payload.scope),
    audience: payload.aud,
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

/**
 * Express middleware for an internal tier: accepts only a valid token for
 * `audience` in SERVICE_TOKEN_HEADER, then sets
 *   req.accessScope     the caller's scope, shaped as requireApiAuth sets it
 *                       ({ authenticated: false, userId: "", workspaceId: "" }
 *                       for a system call, which bindDatabaseTenant runs as no
 *                       tenant);
 *   req.serviceIdentity { issuer, audience, system, claims, keyId, tokenId,
 *                       expiresAt, requestId, deadlineAt }.
 * A system token is refused (403) unless `allowSystem` is true, so a tenant
 * route cannot be reached unscoped by mistake. Failures answer 401/403/500
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
} = {}) => {
  const expectedAudience = normalizeText(audience);

  if (!expectedAudience) {
    throw new TypeError("requireServiceIdentity needs an audience.");
  }

  return (req, res, next) => {
    if (verifiedRequests.get(req) === expectedAudience) {
      next();
      return;
    }

    let identity;

    try {
      identity = verifyServiceToken(readHeader(req, SERVICE_TOKEN_HEADER), {
        audience: expectedAudience,
        env: env ?? process.env,
        issuers,
        now,
      });

      if (identity.system && allowSystem !== true) {
        throw rejectToken(SERVICE_IDENTITY_ERROR_CODES.systemNotAllowed, 403);
      }
    } catch (error) {
      sendIdentityError(res, error);
      return;
    }

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
    removeHeaders(req, (name) => name === SERVICE_TOKEN_HEADER);
    verifiedRequests.set(req, expectedAudience);
    next();
  };
};
