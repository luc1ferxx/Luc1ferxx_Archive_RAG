import crypto from "node:crypto";

// Key material for the internal service identity (service-identity.js).
//
// INTERNAL_SERVICE_AUTH picks how the tokens between tiers are signed:
//   hmac     (default, the original scheme) HS256 with the shared
//            INTERNAL_SERVICE_KEYS. Every tier holds every key, so any tier
//            can sign as any issuer for any audience.
//   ed25519  EdDSA over Ed25519. Each process holds only its own private key
//            (INTERNAL_SERVICE_SIGNING_KEY) and verifies with public keys that
//            are each bound to an issuer (INTERNAL_SERVICE_TRUSTED_KEYS), so a
//            compromised retrieval tier can sign as retrieval and nothing else.
//            HS256 tokens are refused.
//   mixed    signs EdDSA and accepts both EdDSA and HS256: the step between
//            the two during a rolling upgrade.
//
// Moving a split deployment from hmac to ed25519 without downtime:
//   1. generate one key pair per signing tier (node service-keys.mjs), give
//      every tier INTERNAL_SERVICE_TRUSTED_KEYS and its own signing key;
//   2. roll every tier to INTERNAL_SERVICE_AUTH=mixed, callees first
//      (model-gateway, retrieval, agent, api): a mixed tier signs EdDSA, so
//      the tiers it calls must already accept EdDSA, and it still accepts the
//      HS256 tokens of its callers that have not moved yet;
//   3. roll every tier to ed25519 (any order: every tier now signs EdDSA), then
//      drop INTERNAL_SERVICE_KEYS.
// Going back is the reverse: every tier to mixed (any order), then to hmac
// callers first (api, agent, retrieval, model-gateway).
//
// Rotating one tier's Ed25519 key, three rolls, as for the HS256 keyring:
//   1. append the new public entry to INTERNAL_SERVICE_TRUSTED_KEYS on every
//      tier (all of them verify it from now on);
//   2. switch that tier's INTERNAL_SERVICE_SIGNING_KEY to the new private key
//      (it signs with it; its old tokens stay valid for their lifetime);
//   3. once the token lifetime has passed, remove the old public entry
//      everywhere.
// The key id defaults to a fingerprint of the public key, so the old and the
// new entry never share an id.
//
// Errors name variables, entries and key ids, never key material.

export const SERVICE_AUTH_MODES = Object.freeze(["hmac", "ed25519", "mixed"]);
export const DEFAULT_SERVICE_AUTH_MODE = "hmac";

export const SERVICE_TOKEN_ALGORITHMS = Object.freeze({
  ed25519: "EdDSA",
  hmac: "HS256",
});

// Every name a token can carry as its issuer: the process roles of
// service-topology.js, plus a dedicated ingest worker (a role-all process that
// only drains the ingest queue and signs as ingest-worker, see
// getServiceIssuer). A trusted key bound to any other name is a typo.
export const SERVICE_ISSUERS = Object.freeze([
  "agent",
  "all",
  "api",
  "ingest-worker",
  "model-gateway",
  "retrieval",
]);

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/u;
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

const normalizeText = (value) => String(value ?? "").trim();

/** The configured mode, lower-cased, without validation ("" counts as hmac). */
export const readServiceAuthMode = (env = process.env) =>
  normalizeText(env.INTERNAL_SERVICE_AUTH).toLowerCase() || DEFAULT_SERVICE_AUTH_MODE;

export const isServiceAuthModeValid = (mode) => SERVICE_AUTH_MODES.includes(mode);

// Node's base64 decoder reads the standard and the URL-safe alphabet alike;
// the pattern only refuses text that is not base64 at all, which the decoder
// would otherwise skip over silently.
const decodeBase64 = (text) => {
  const compact = text.replace(/\s+/gu, "");

  return BASE64_PATTERN.test(compact) ? Buffer.from(compact, "base64") : null;
};

/**
 * A key id derived from the public key: "ed25519-" plus the first 20 hex
 * digits of the SHA-256 of its SPKI encoding. Stable for a key, different for
 * every other key.
 */
export const fingerprintServiceKeyId = (spkiDer) =>
  `ed25519-${crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 20)}`;

const exportSpki = (publicKey) => publicKey.export({ format: "der", type: "spki" });

/**
 * Parses INTERNAL_SERVICE_SIGNING_KEY (an Ed25519 private key as PKCS8 PEM,
 * literal "\n" escapes allowed, or as base64 of the PKCS8 DER) and
 * INTERNAL_SERVICE_SIGNING_KEY_ID (optional; the fingerprint by default).
 * Returns { error, key } with key = { keyId, privateKey, publicKey,
 * publicKeyBase64 } or null when the variable is empty.
 */
export const parseServiceSigningKey = (rawKey, rawKeyId) => {
  const text = normalizeText(rawKey).replace(/\\n/gu, "\n");

  if (!text) {
    return { error: null, key: null };
  }

  let privateKey;

  try {
    if (PEM_PRIVATE_KEY_PATTERN.test(text)) {
      privateKey = crypto.createPrivateKey({ format: "pem", key: text });
    } else {
      const der = decodeBase64(text);

      if (!der) {
        throw new Error("not base64");
      }

      privateKey = crypto.createPrivateKey({ format: "der", key: der, type: "pkcs8" });
    }
  } catch {
    return {
      error: "INTERNAL_SERVICE_SIGNING_KEY is not an unencrypted PKCS8 private key (PEM, or base64 of the DER).",
      key: null,
    };
  }

  if (privateKey.asymmetricKeyType !== "ed25519") {
    return { error: "INTERNAL_SERVICE_SIGNING_KEY must be an Ed25519 key.", key: null };
  }

  const publicKey = crypto.createPublicKey(privateKey);
  const spki = exportSpki(publicKey);
  const keyId = normalizeText(rawKeyId) || fingerprintServiceKeyId(spki);

  if (!KEY_ID_PATTERN.test(keyId)) {
    return {
      error: "INTERNAL_SERVICE_SIGNING_KEY_ID must be 1-64 letters, digits, \".\", \"_\" or \"-\".",
      key: null,
    };
  }

  return {
    error: null,
    key: { keyId, privateKey, publicKey, publicKeyBase64: spki.toString("base64") },
  };
};

/**
 * Parses INTERNAL_SERVICE_TRUSTED_KEYS = "issuer:kid:base64spki,...": the
 * Ed25519 public keys this process accepts, each bound to the issuer named in
 * its entry. One key id may be listed for several issuers (that key then
 * speaks for each of them; validation warns), never with two different keys.
 * Returns { errors, entries: [{ issuer, keyId, publicKeyBase64 }], byKeyId:
 * Map keyId -> { keyId, publicKey, publicKeyBase64, issuers } }.
 */
export const parseTrustedServiceKeys = (rawValue) => {
  const errors = [];
  const entries = [];
  const byKeyId = new Map();
  const parts = String(rawValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  parts.forEach((entry, index) => {
    const [issuerPart, keyIdPart, keyPart, ...rest] = entry.split(":");
    const issuer = normalizeText(issuerPart).toLowerCase();
    const keyId = normalizeText(keyIdPart);
    const label = `INTERNAL_SERVICE_TRUSTED_KEYS entry ${index + 1}`;

    if (rest.length > 0 || keyPart === undefined) {
      errors.push(`${label} must be issuer:keyId:publicKey.`);
      return;
    }

    if (!SERVICE_ISSUERS.includes(issuer)) {
      errors.push(`${label} names an unknown issuer; use one of ${SERVICE_ISSUERS.join(", ")}.`);
      return;
    }

    if (!KEY_ID_PATTERN.test(keyId)) {
      errors.push(`${label} needs a key id of letters, digits, ".", "_" or "-".`);
      return;
    }

    let publicKey;
    const der = decodeBase64(normalizeText(keyPart));

    try {
      if (!der) {
        throw new Error("not base64");
      }

      publicKey = crypto.createPublicKey({ format: "der", key: der, type: "spki" });
    } catch {
      errors.push(`${label} (key id "${keyId}") is not a base64 SPKI public key.`);
      return;
    }

    if (publicKey.asymmetricKeyType !== "ed25519") {
      errors.push(`${label} (key id "${keyId}") is not an Ed25519 key.`);
      return;
    }

    const publicKeyBase64 = exportSpki(publicKey).toString("base64");
    const existing = byKeyId.get(keyId);

    if (existing && existing.publicKeyBase64 !== publicKeyBase64) {
      errors.push(`INTERNAL_SERVICE_TRUSTED_KEYS lists key id "${keyId}" with two different keys.`);
      return;
    }

    if (existing?.issuers.includes(issuer)) {
      errors.push(`INTERNAL_SERVICE_TRUSTED_KEYS lists ${issuer}:${keyId} more than once.`);
      return;
    }

    if (existing) {
      existing.issuers.push(issuer);
    } else {
      byKeyId.set(keyId, { issuers: [issuer], keyId, publicKey, publicKeyBase64 });
    }

    entries.push({ issuer, keyId, publicKeyBase64 });
  });

  return { byKeyId, entries, errors };
};

/**
 * A fresh Ed25519 key pair for one issuer, in the forms the environment takes:
 * { issuer, keyId, privateKeyBase64 (PKCS8 DER), publicKeyBase64 (SPKI DER),
 * trustedEntry ("issuer:keyId:publicKey") }. The key id is the fingerprint
 * unless `keyId` is given.
 */
export const generateServiceKeyPair = ({ issuer, keyId } = {}) => {
  const normalizedIssuer = normalizeText(issuer).toLowerCase();

  if (!SERVICE_ISSUERS.includes(normalizedIssuer)) {
    throw new TypeError(`The issuer must be one of ${SERVICE_ISSUERS.join(", ")}.`);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const spki = exportSpki(publicKey);
  const resolvedKeyId = normalizeText(keyId) || fingerprintServiceKeyId(spki);

  if (!KEY_ID_PATTERN.test(resolvedKeyId)) {
    throw new TypeError("The key id must be 1-64 letters, digits, \".\", \"_\" or \"-\".");
  }

  const publicKeyBase64 = spki.toString("base64");

  return {
    issuer: normalizedIssuer,
    keyId: resolvedKeyId,
    privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKeyBase64,
    trustedEntry: `${normalizedIssuer}:${resolvedKeyId}:${publicKeyBase64}`,
  };
};
