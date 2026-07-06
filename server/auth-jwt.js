import crypto from "crypto";
import {
  getApiAuthJwtAudience,
  getApiAuthJwtIssuer,
  getApiAuthJwtPermissionsClaim,
  getApiAuthJwtRolesClaim,
  getApiAuthJwtSecret,
  getApiAuthJwtUserClaim,
  getApiAuthJwtWorkspaceClaim,
  getApiAuthJwtWorkspacesClaim,
  getApiAuthRevokedJtis,
  getApiAuthRevokedTokenHashes,
} from "./rag/config.js";

const JWT_ALGORITHM = "HS256";

class JwtAuthError extends Error {
  constructor(message, { status = 401 } = {}) {
    super(message);
    this.name = "JwtAuthError";
    this.status = status;
  }
}

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

const toSet = (value) =>
  new Set(toList(value).map((entry) => normalizeText(entry)).filter(Boolean));

const base64UrlEncode = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const base64UrlDecode = (value) => {
  const normalized = normalizeText(value).replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;

  return Buffer.from(padded, "base64").toString("utf8");
};

const parseJwtPart = (value, label) => {
  try {
    return JSON.parse(base64UrlDecode(value));
  } catch {
    throw new JwtAuthError(`Invalid JWT ${label}.`);
  }
};

const timingSafeTextEqual = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const signInput = ({ input, secret }) =>
  base64UrlEncode(crypto.createHmac("sha256", secret).update(input).digest());

export const createHs256Jwt = ({ header = {}, payload = {}, secret }) => {
  const encodedHeader = base64UrlEncode(
    JSON.stringify({
      alg: JWT_ALGORITHM,
      typ: "JWT",
      ...header,
    })
  );
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = signInput({
    input,
    secret,
  });

  return `${input}.${signature}`;
};

export const hashAuthToken = (token) =>
  crypto.createHash("sha256").update(String(token ?? "")).digest("hex");

const getClaimByPath = (payload, path) => {
  const normalizedPath = normalizeText(path);

  if (!normalizedPath) {
    return undefined;
  }

  return normalizedPath.split(".").reduce((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return current[key];
    }

    return undefined;
  }, payload);
};

const hasAudience = (payloadAudience, expectedAudience) => {
  const expected = normalizeText(expectedAudience);

  if (!expected) {
    return true;
  }

  return toList(payloadAudience).map(normalizeText).includes(expected);
};

const verifyTimestampClaims = ({ nowSeconds, payload }) => {
  if (payload.exp !== undefined && Number(payload.exp) <= nowSeconds) {
    throw new JwtAuthError("JWT is expired.");
  }

  if (payload.nbf !== undefined && Number(payload.nbf) > nowSeconds) {
    throw new JwtAuthError("JWT is not active yet.");
  }
};

export const verifyJwtAuthToken = (
  token,
  {
    audience = getApiAuthJwtAudience(),
    issuer = getApiAuthJwtIssuer(),
    now = () => new Date(),
    permissionsClaim = getApiAuthJwtPermissionsClaim(),
    revokedJtis = getApiAuthRevokedJtis(),
    revokedTokenHashes = getApiAuthRevokedTokenHashes(),
    rolesClaim = getApiAuthJwtRolesClaim(),
    secret = getApiAuthJwtSecret(),
    userClaim = getApiAuthJwtUserClaim(),
    workspaceClaim = getApiAuthJwtWorkspaceClaim(),
    workspacesClaim = getApiAuthJwtWorkspacesClaim(),
  } = {}
) => {
  const normalizedToken = normalizeText(token);
  const normalizedSecret = normalizeText(secret);

  if (!normalizedSecret) {
    throw new JwtAuthError("JWT auth is enabled, but no JWT secret is configured.", {
      status: 500,
    });
  }

  const [encodedHeader, encodedPayload, signature] = normalizedToken.split(".");

  if (!encodedHeader || !encodedPayload || !signature) {
    throw new JwtAuthError("Invalid JWT format.");
  }

  const header = parseJwtPart(encodedHeader, "header");
  const payload = parseJwtPart(encodedPayload, "payload");

  if (header.alg !== JWT_ALGORITHM) {
    throw new JwtAuthError("Unsupported JWT algorithm.");
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = signInput({
    input: signingInput,
    secret: normalizedSecret,
  });

  if (!timingSafeTextEqual(signature, expectedSignature)) {
    throw new JwtAuthError("Invalid JWT signature.");
  }

  const expectedIssuer = normalizeText(issuer);

  if (expectedIssuer && normalizeText(payload.iss) !== expectedIssuer) {
    throw new JwtAuthError("Invalid JWT issuer.");
  }

  if (!hasAudience(payload.aud, audience)) {
    throw new JwtAuthError("Invalid JWT audience.");
  }

  const nowSeconds = Math.floor(now().getTime() / 1000);
  verifyTimestampClaims({
    nowSeconds,
    payload,
  });

  const tokenHash = hashAuthToken(normalizedToken);

  if (toSet(revokedTokenHashes).has(tokenHash)) {
    throw new JwtAuthError("JWT token hash is revoked.");
  }

  if (payload.jti && toSet(revokedJtis).has(normalizeText(payload.jti))) {
    throw new JwtAuthError("JWT id is revoked.");
  }

  const userId = normalizeText(getClaimByPath(payload, userClaim));

  if (!userId) {
    throw new JwtAuthError("JWT user claim is missing.");
  }

  return {
    allowedWorkspaceIds: getClaimByPath(payload, workspacesClaim),
    authProvider: "jwt",
    issuer: normalizeText(payload.iss),
    jwtId: normalizeText(payload.jti),
    permissions: getClaimByPath(payload, permissionsClaim),
    roles: getClaimByPath(payload, rolesClaim),
    subject: normalizeText(payload.sub),
    tokenHash,
    userId,
    workspaceId: normalizeText(getClaimByPath(payload, workspaceClaim)),
  };
};
