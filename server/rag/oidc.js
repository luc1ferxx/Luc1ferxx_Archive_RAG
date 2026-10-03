// OpenID Connect resource server: verifies access tokens an external IdP
// issued (API_AUTH_OIDC_ENABLED=true) and maps their claims onto the principal
// shape requireApiAuth already builds for static tokens and HS256 JWTs.
//
// Discovery and JWKS are cached in process. An unknown kid refreshes the JWKS
// at most once per API_AUTH_OIDC_JWKS_MIN_REFRESH_MS, so a rotated key is
// picked up and a flood of bad kids cannot hammer the IdP; when the IdP is
// down the last good keys keep serving. Only asymmetric algorithms are
// accepted, and the token's alg must match the selected key's kty/crv, so an
// HS256 token signed with a public key or an EC key claiming RS256 is refused.
// Errors never echo the token or its claims.
import crypto from "node:crypto";

import { normalizeScopeId, normalizeScopeIds } from "../access-scope.js";
import { getAuthTokenRevocation, hashAuthToken } from "../auth-jwt.js";
import {
  OIDC_DEFAULT_ALGORITHMS,
  getApiAuthOidcAlgorithms,
  getApiAuthOidcAudience,
  getApiAuthOidcClientId,
  getApiAuthOidcClockSkewSec,
  getApiAuthOidcGroupRoleMap,
  getApiAuthOidcGroupsClaim,
  getApiAuthOidcHttpTimeoutMs,
  getApiAuthOidcIssuer,
  getApiAuthOidcJwksMinRefreshMs,
  getApiAuthOidcJwksTtlMs,
  getApiAuthOidcPermissionsClaim,
  getApiAuthOidcRolesClaim,
  getApiAuthOidcScopes,
  getApiAuthOidcUserClaim,
  getApiAuthOidcWorkspaceClaim,
  getApiAuthOidcWorkspaceRolesClaim,
  getApiAuthOidcWorkspacesClaim,
  isApiAuthEnabled,
  isApiAuthOidcEnabled,
  isApiAuthOidcTypRequired,
} from "./config.js";

const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_JWKS_KEYS = 100;
const MAX_WORKSPACE_ROLE_ENTRIES = 500;
const MIN_RSA_MODULUS_BITS = 2048;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

// alg -> what the verifying key must be. HS*, "none" and anything else are
// absent on purpose: a symmetric or unsigned token is never an OIDC token here.
const ALGORITHM_SPECS = Object.freeze({
  RS256: { kty: "RSA", hash: "sha256", padding: crypto.constants.RSA_PKCS1_PADDING },
  PS256: {
    kty: "RSA",
    hash: "sha256",
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  },
  ES256: {
    kty: "EC",
    crv: ["P-256"],
    hash: "sha256",
    dsaEncoding: "ieee-p1363",
    signatureLength: 64,
  },
  EdDSA: { kty: "OKP", crv: ["Ed25519", "Ed448"], hash: null },
});

export const SUPPORTED_OIDC_ALGORITHMS = Object.freeze(Object.keys(ALGORITHM_SPECS));

export class OidcAuthError extends Error {
  constructor(message, { status = 401, code = "invalid_token" } = {}) {
    super(message);
    this.name = "OidcAuthError";
    this.status = status;
    this.code = code;
  }
}

const invalidToken = (message) => new OidcAuthError(message);
const providerUnavailable = () =>
  new OidcAuthError("OIDC provider is unavailable.", {
    status: 503,
    code: "oidc_provider_unavailable",
  });
const configError = (message) =>
  new OidcAuthError(message, { status: 500, code: "oidc_config" });

const normalizeText = (value) => String(value ?? "").trim();

const toList = (value) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return value.split(",");
  }

  return value === undefined || value === null ? [] : [value];
};

const uniqueTexts = (values) => [
  ...new Set(
    values
      .filter((entry) => typeof entry === "string" || typeof entry === "number")
      .map((entry) => normalizeText(entry))
      .filter(Boolean)
  ),
];

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const base64UrlDecode = (value) => {
  if (!BASE64URL_PATTERN.test(value)) {
    throw invalidToken("Invalid token encoding.");
  }

  return Buffer.from(value, "base64url");
};

const parseJsonPart = (value, label) => {
  let parsed = null;

  try {
    parsed = JSON.parse(base64UrlDecode(value).toString("utf8"));
  } catch {
    throw invalidToken(`Invalid token ${label}.`);
  }

  if (!isPlainObject(parsed)) {
    throw invalidToken(`Invalid token ${label}.`);
  }

  return parsed;
};

const splitToken = (token) => {
  const normalized = typeof token === "string" ? token.trim() : "";

  if (!normalized || normalized.length > MAX_TOKEN_LENGTH) {
    throw invalidToken("Invalid token format.");
  }

  const parts = normalized.split(".");

  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw invalidToken("Invalid token format.");
  }

  return { normalized, parts };
};

/**
 * Reads a compact JWS header without verifying anything, for routing a bearer
 * token to the right verifier. Returns null for anything that is not one.
 */
export const peekJwtHeader = (token) => {
  try {
    const { parts } = splitToken(token);
    return parseJsonPart(parts[0], "header");
  } catch {
    return null;
  }
};

const getClaimByPath = (payload, path) => {
  const normalizedPath = normalizeText(path);

  if (!normalizedPath) {
    return undefined;
  }

  return normalizedPath.split(".").reduce((current, key) => {
    if (current && typeof current === "object" && Object.hasOwn(current, key)) {
      return current[key];
    }

    return undefined;
  }, payload);
};

const isLoopbackHostname = (hostname) => {
  const host = String(hostname ?? "").toLowerCase();

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
};

/**
 * Issuer and JWKS URLs must be https; plain http is accepted for loopback
 * hosts only (the local dev IdP).
 */
export const isAllowedOidcUrl = (value) => {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
};

const fetchJsonDocument = async ({ fetchImpl, timeoutMs, url }) => {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OIDC document request failed with HTTP ${response.status}.`);
  }

  const text = await response.text();

  if (text.length > MAX_DOCUMENT_BYTES) {
    throw new Error("OIDC document is too large.");
  }

  const parsed = JSON.parse(text);

  if (!isPlainObject(parsed)) {
    throw new Error("OIDC document is not a JSON object.");
  }

  return parsed;
};

const buildDiscoveryUrl = (issuer) =>
  `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;

// Only the public members of a JWK reach createPublicKey, so a JWKS that
// leaks private parameters never turns into a private key object here.
const PUBLIC_JWK_MEMBERS = Object.freeze({
  RSA: ["kty", "n", "e"],
  EC: ["kty", "crv", "x", "y"],
  OKP: ["kty", "crv", "x"],
});

const importJwk = (jwk) => {
  if (!isPlainObject(jwk)) {
    return null;
  }

  const members = PUBLIC_JWK_MEMBERS[jwk.kty];

  if (!members) {
    // "oct" (symmetric) and unknown key types are never verification keys.
    return null;
  }

  if (jwk.use !== undefined && jwk.use !== "sig") {
    return null;
  }

  if (
    jwk.key_ops !== undefined &&
    !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify"))
  ) {
    return null;
  }

  const publicJwk = Object.fromEntries(
    members.filter((member) => jwk[member] !== undefined).map((member) => [member, jwk[member]])
  );

  let keyObject = null;

  try {
    keyObject = crypto.createPublicKey({ format: "jwk", key: publicJwk });
  } catch {
    return null;
  }

  if (
    jwk.kty === "RSA" &&
    Number(keyObject.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_MODULUS_BITS
  ) {
    return null;
  }

  return {
    alg: typeof jwk.alg === "string" ? jwk.alg : "",
    crv: typeof jwk.crv === "string" ? jwk.crv : "",
    keyObject,
    kid: typeof jwk.kid === "string" ? jwk.kid : "",
    kty: jwk.kty,
  };
};

const isKeyCompatible = (key, alg) => {
  const spec = ALGORITHM_SPECS[alg];

  if (!spec || key.kty !== spec.kty) {
    return false;
  }

  if (spec.crv && !spec.crv.includes(key.crv)) {
    return false;
  }

  return !key.alg || key.alg === alg;
};

const verifySignature = ({ alg, key, signature, signingInput }) => {
  const spec = ALGORITHM_SPECS[alg];

  if (spec.signatureLength && signature.length !== spec.signatureLength) {
    return false;
  }

  try {
    if (spec.kty === "OKP") {
      return crypto.verify(null, Buffer.from(signingInput), key.keyObject, signature);
    }

    const keyInput = { key: key.keyObject };

    if (spec.padding !== undefined) {
      keyInput.padding = spec.padding;
    }

    if (spec.saltLength !== undefined) {
      keyInput.saltLength = spec.saltLength;
    }

    if (spec.dsaEncoding) {
      keyInput.dsaEncoding = spec.dsaEncoding;
    }

    return crypto.verify(spec.hash, Buffer.from(signingInput), keyInput, signature);
  } catch {
    return false;
  }
};

const toNumericDate = (value) => {
  if (value === undefined) {
    return undefined;
  }

  const numeric = typeof value === "number" ? value : Number.NaN;

  if (!Number.isFinite(numeric)) {
    throw invalidToken("Invalid token time claim.");
  }

  return numeric;
};

export const parseOidcGroupRoleMap = (rawValue) => {
  if (isPlainObject(rawValue)) {
    return rawValue;
  }

  const text = normalizeText(rawValue);

  if (!text) {
    return {};
  }

  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw configError("API_AUTH_OIDC_GROUP_ROLE_MAP must be a JSON object.");
  }

  if (!isPlainObject(parsed)) {
    throw configError("API_AUTH_OIDC_GROUP_ROLE_MAP must be a JSON object.");
  }

  return parsed;
};

const mapGroupsToRoles = (groups, groupRoleMap) =>
  uniqueTexts(
    toList(groups).flatMap((group) => {
      if (typeof group !== "string" || !Object.hasOwn(groupRoleMap, group)) {
        return [];
      }

      return toList(groupRoleMap[group]);
    })
  );

/**
 * Normalizes per-workspace role grants to { [workspaceId]: roleId[] } with the
 * same lowercase ids requireApiAuth uses for roleIds and workspace ids.
 * Accepts an object ({ "ws-a": ["editor"] } or { "ws-a": "editor,viewer" }) or
 * an array of { workspaceId | workspace_id, roles | role }. Returns {} for
 * anything else.
 */
export const normalizeWorkspaceRoles = (value) => {
  const entries = [];

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, MAX_WORKSPACE_ROLE_ENTRIES)) {
      if (isPlainObject(entry)) {
        entries.push([
          entry.workspaceId ?? entry.workspace_id,
          entry.roles ?? entry.roleIds ?? entry.role,
        ]);
      }
    }
  } else if (isPlainObject(value)) {
    entries.push(...Object.entries(value).slice(0, MAX_WORKSPACE_ROLE_ENTRIES));
  }

  // A Map, so a workspace named "constructor" or "toString" reads no
  // inherited property (a plain object made such a token a 500).
  const normalized = new Map();

  for (const [rawWorkspaceId, rawRoles] of entries) {
    if (typeof rawWorkspaceId !== "string") {
      continue;
    }

    const workspaceId = normalizeScopeId(rawWorkspaceId);
    const roles = normalizeScopeIds(
      toList(rawRoles).filter((role) => typeof role === "string")
    );

    if (!workspaceId || roles.length === 0) {
      continue;
    }

    normalized.set(workspaceId, [...new Set([...(normalized.get(workspaceId) ?? []), ...roles])]);
  }

  return Object.fromEntries(normalized);
};

const DEFAULT_CLAIMS = Object.freeze({
  groups: "groups",
  permissions: "permissions",
  roles: "roles",
  user: "sub",
  workspace: "workspace_id",
  workspaceRoles: "workspace_roles",
  workspaces: "workspaces",
});

export const createOidcVerifier = ({
  algorithms = OIDC_DEFAULT_ALGORITHMS,
  audience,
  claims = {},
  clientId = "",
  clockSkewSec = 60,
  fetchImpl = globalThis.fetch,
  groupRoleMap = {},
  httpTimeoutMs = 5000,
  issuer,
  jwksMinRefreshMs = 30_000,
  jwksTtlMs = 10 * 60 * 1000,
  now = () => Date.now(),
  requireTyp = false,
  revokedJtis,
  revokedTokenHashes,
} = {}) => {
  const expectedIssuer = normalizeText(issuer);
  const expectedAudience = normalizeText(audience);
  const expectedClientId = normalizeText(clientId);
  const claimNames = { ...DEFAULT_CLAIMS, ...claims };
  const parsedGroupRoleMap = parseOidcGroupRoleMap(groupRoleMap);
  const allowedAlgorithms = new Set(
    toList(algorithms)
      .map((entry) => normalizeText(entry))
      .filter((entry) => Object.hasOwn(ALGORITHM_SPECS, entry))
  );

  const assertConfigured = () => {
    if (!expectedIssuer || !isAllowedOidcUrl(expectedIssuer)) {
      throw configError(
        "API_AUTH_OIDC_ISSUER must be an https URL (http only for loopback hosts)."
      );
    }

    if (!expectedAudience) {
      throw configError("API_AUTH_OIDC_AUDIENCE must be set when OIDC is enabled.");
    }

    if (allowedAlgorithms.size === 0) {
      throw configError(
        `API_AUTH_OIDC_ALGORITHMS must list at least one of ${SUPPORTED_OIDC_ALGORITHMS.join(", ")}.`
      );
    }

    if (typeof fetchImpl !== "function") {
      throw configError("OIDC verification needs a fetch implementation.");
    }
  };

  const state = {
    discovery: null,
    discoveryFetchedAt: -Infinity,
    jwks: null,
    jwksFetchedAt: -Infinity,
    lastJwksAttemptAt: -Infinity,
    lastError: "",
    inflight: null,
  };

  const fetchDiscovery = async () => {
    const document = await fetchJsonDocument({
      fetchImpl,
      timeoutMs: httpTimeoutMs,
      url: buildDiscoveryUrl(expectedIssuer),
    });

    // OpenID Connect Discovery 1.0 section 4.3: exact match, no normalization.
    if (document.issuer !== expectedIssuer) {
      throw new Error("OIDC discovery issuer does not match API_AUTH_OIDC_ISSUER.");
    }

    if (typeof document.jwks_uri !== "string" || !isAllowedOidcUrl(document.jwks_uri)) {
      throw new Error("OIDC discovery jwks_uri is missing or not allowed.");
    }

    return document;
  };

  const fetchKeys = async () => {
    const timestamp = now();
    let discovery = state.discovery;

    if (!discovery || timestamp - state.discoveryFetchedAt >= jwksTtlMs) {
      try {
        discovery = await fetchDiscovery();
        state.discovery = discovery;
        state.discoveryFetchedAt = timestamp;
      } catch (error) {
        if (!state.discovery) {
          throw error;
        }

        // A stale discovery document still names the right JWKS endpoint.
        discovery = state.discovery;
        state.lastError = "discovery_refresh_failed";
      }
    }

    const document = await fetchJsonDocument({
      fetchImpl,
      timeoutMs: httpTimeoutMs,
      url: discovery.jwks_uri,
    });

    if (!Array.isArray(document.keys)) {
      throw new Error("OIDC JWKS has no keys array.");
    }

    return document.keys.slice(0, MAX_JWKS_KEYS).map(importJwk).filter(Boolean);
  };

  // Refreshes the key set unless one was attempted within jwksMinRefreshMs.
  // A failure keeps the last good keys; with none cached it is a 503.
  const refreshKeys = async () => {
    if (state.inflight) {
      return state.inflight;
    }

    if (now() - state.lastJwksAttemptAt < jwksMinRefreshMs) {
      if (state.jwks) {
        return state.jwks;
      }

      throw providerUnavailable();
    }

    state.lastJwksAttemptAt = now();
    state.inflight = (async () => {
      try {
        const keys = await fetchKeys();
        state.jwks = keys;
        state.jwksFetchedAt = now();
        state.lastError = "";
        return keys;
      } catch {
        state.lastError = "jwks_refresh_failed";

        if (state.jwks) {
          return state.jwks;
        }

        throw providerUnavailable();
      } finally {
        state.inflight = null;
      }
    })();

    return state.inflight;
  };

  const getKeys = async () => {
    if (state.jwks && now() - state.jwksFetchedAt < jwksTtlMs) {
      return state.jwks;
    }

    return refreshKeys();
  };

  const selectKey = async ({ alg, kid }) => {
    const pick = (keys) => {
      if (kid) {
        return { found: keys.filter((key) => key.kid === kid) };
      }

      return { found: keys.filter((key) => isKeyCompatible(key, alg)) };
    };

    let keys = await getKeys();
    let { found } = pick(keys);

    if (found.length === 0) {
      // An unknown kid may be a freshly rotated key: refresh (rate limited).
      keys = await refreshKeys();
      ({ found } = pick(keys));
    }

    if (found.length === 0) {
      throw invalidToken("No matching signing key.");
    }

    if (!kid && found.length > 1) {
      throw invalidToken("Token has no kid and the key set is ambiguous.");
    }

    const compatible = found.filter((key) => isKeyCompatible(key, alg));

    if (compatible.length === 0) {
      throw invalidToken("Token algorithm does not match the signing key.");
    }

    return compatible;
  };

  const verifyClaims = (payload) => {
    if (payload.iss !== expectedIssuer) {
      throw invalidToken("Invalid token issuer.");
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

    if (!audiences.some((entry) => typeof entry === "string" && entry === expectedAudience)) {
      throw invalidToken("Invalid token audience.");
    }

    if (expectedClientId) {
      const authorizedParty = payload.azp ?? payload.client_id;

      if (authorizedParty !== expectedClientId) {
        throw invalidToken("Invalid token authorized party.");
      }
    }

    const nowSeconds = Math.floor(now() / 1000);
    const exp = toNumericDate(payload.exp);
    const nbf = toNumericDate(payload.nbf);
    const iat = toNumericDate(payload.iat);

    if (exp === undefined) {
      throw invalidToken("Token has no expiry.");
    }

    if (nowSeconds >= exp + clockSkewSec) {
      throw invalidToken("Token is expired.");
    }

    if (nbf !== undefined && nbf > nowSeconds + clockSkewSec) {
      throw invalidToken("Token is not active yet.");
    }

    if (iat !== undefined && iat > nowSeconds + clockSkewSec) {
      throw invalidToken("Token was issued in the future.");
    }
  };

  const mapPrincipal = ({ payload, tokenHash }) => {
    const userClaimValue = getClaimByPath(payload, claimNames.user);
    const userId =
      typeof userClaimValue === "string" || typeof userClaimValue === "number"
        ? normalizeText(userClaimValue)
        : "";

    if (!userId) {
      throw invalidToken("Token user claim is missing.");
    }

    const workspaceClaimValue = getClaimByPath(payload, claimNames.workspace);
    const roles = uniqueTexts([
      ...toList(getClaimByPath(payload, claimNames.roles)),
      ...mapGroupsToRoles(getClaimByPath(payload, claimNames.groups), parsedGroupRoleMap),
    ]);
    const permissions = uniqueTexts(toList(getClaimByPath(payload, claimNames.permissions)));
    const allowedWorkspaceIds = uniqueTexts(
      toList(getClaimByPath(payload, claimNames.workspaces))
    );
    const workspaceRoles = normalizeWorkspaceRoles(
      getClaimByPath(payload, claimNames.workspaceRoles)
    );

    return {
      allowedWorkspaceIds,
      authProvider: "oidc",
      issuer: expectedIssuer,
      jwtId: typeof payload.jti === "string" ? payload.jti : "",
      permissions,
      roles,
      subject: typeof payload.sub === "string" ? payload.sub : "",
      tokenHash,
      userId,
      workspaceId:
        typeof workspaceClaimValue === "string" ? normalizeText(workspaceClaimValue) : "",
      workspaceRoles,
    };
  };

  const verify = async (token) => {
    assertConfigured();

    const { normalized, parts } = splitToken(token);
    const header = parseJsonPart(parts[0], "header");
    const payload = parseJsonPart(parts[1], "payload");
    const alg = header.alg;

    if (
      typeof alg !== "string" ||
      !Object.hasOwn(ALGORITHM_SPECS, alg) ||
      !allowedAlgorithms.has(alg)
    ) {
      throw invalidToken("Unsupported token algorithm.");
    }

    // RFC 7515 section 4.1.11: no critical extension is understood here.
    if (header.crit !== undefined) {
      throw invalidToken("Unsupported critical token header.");
    }

    if (requireTyp) {
      const typ = typeof header.typ === "string" ? header.typ.toLowerCase() : "";

      if (typ !== "at+jwt" && typ !== "application/at+jwt") {
        throw invalidToken("Token is not an access token.");
      }
    }

    const kid = typeof header.kid === "string" ? header.kid : "";

    if (header.kid !== undefined && !kid) {
      throw invalidToken("Invalid token key id.");
    }

    const signature = base64UrlDecode(parts[2]);
    const signingInput = `${parts[0]}.${parts[1]}`;
    const keys = await selectKey({ alg, kid });

    if (!keys.some((key) => verifySignature({ alg, key, signature, signingInput }))) {
      throw invalidToken("Invalid token signature.");
    }

    verifyClaims(payload);

    const tokenHash = hashAuthToken(normalized);
    const revocation = getAuthTokenRevocation({
      jti: payload.jti,
      revokedJtis,
      revokedTokenHashes,
      tokenHash,
    });

    if (revocation) {
      throw invalidToken("Token is revoked.");
    }

    return mapPrincipal({ payload, tokenHash });
  };

  const getStatus = () => ({
    issuer: expectedIssuer,
    keyCount: state.jwks?.length ?? 0,
    keysFetchedAt: Number.isFinite(state.jwksFetchedAt)
      ? new Date(state.jwksFetchedAt).toISOString()
      : null,
    lastError: state.lastError,
  });

  return { getStatus, refreshKeys, verify };
};

const readOidcVerifierOptionsFromConfig = () => ({
  algorithms: getApiAuthOidcAlgorithms(),
  audience: getApiAuthOidcAudience(),
  claims: {
    groups: getApiAuthOidcGroupsClaim(),
    permissions: getApiAuthOidcPermissionsClaim(),
    roles: getApiAuthOidcRolesClaim(),
    user: getApiAuthOidcUserClaim(),
    workspace: getApiAuthOidcWorkspaceClaim(),
    workspaceRoles: getApiAuthOidcWorkspaceRolesClaim(),
    workspaces: getApiAuthOidcWorkspacesClaim(),
  },
  clientId: getApiAuthOidcClientId(),
  clockSkewSec: getApiAuthOidcClockSkewSec(),
  groupRoleMap: getApiAuthOidcGroupRoleMap(),
  httpTimeoutMs: getApiAuthOidcHttpTimeoutMs(),
  issuer: getApiAuthOidcIssuer(),
  jwksMinRefreshMs: getApiAuthOidcJwksMinRefreshMs(),
  jwksTtlMs: getApiAuthOidcJwksTtlMs(),
  requireTyp: isApiAuthOidcTypRequired(),
});

let defaultVerifier = null;
let defaultVerifierFingerprint = "";

/**
 * The process-wide verifier for the configured issuer. It is rebuilt (with an
 * empty key cache) only when the OIDC configuration changes.
 */
export const getDefaultOidcVerifier = () => {
  const options = readOidcVerifierOptionsFromConfig();
  const fingerprint = JSON.stringify(options);

  if (!defaultVerifier || fingerprint !== defaultVerifierFingerprint) {
    defaultVerifier = createOidcVerifier(options);
    defaultVerifierFingerprint = fingerprint;
  }

  return defaultVerifier;
};

export const resetDefaultOidcVerifier = () => {
  defaultVerifier = null;
  defaultVerifierFingerprint = "";
};

export const verifyOidcAccessToken = (token) => getDefaultOidcVerifier().verify(token);

/**
 * What the SPA needs to start a login (GET /auth/config). Public and free of
 * secrets: mode is "disabled" (API auth off), "token" (static tokens / HS256
 * JWT) or "oidc"; oidc is null unless OIDC is enabled.
 */
export const buildPublicAuthConfig = () => {
  const oidcEnabled = isApiAuthOidcEnabled();
  const mode = !isApiAuthEnabled() ? "disabled" : oidcEnabled ? "oidc" : "token";

  return {
    mode,
    oidc: oidcEnabled
      ? {
          audience: getApiAuthOidcAudience(),
          clientId: getApiAuthOidcClientId(),
          issuer: getApiAuthOidcIssuer(),
          scopes: getApiAuthOidcScopes().split(/\s+/u).filter(Boolean),
        }
      : null,
  };
};
