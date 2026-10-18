import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isPostgresSslEnabled } from "./config.js";

// TLS settings of every PostgreSQL connection the app opens: the runtime pool,
// the owner pool of the role split, the dedicated LISTEN session, and the read
// replicas' read and poll pools (rag/postgres.js, rag/postgres-replicas.js).
//
// POSTGRES_SSL_ENABLED (or LONG_MEMORY_POSTGRES_SSL_ENABLED) turns TLS on;
// POSTGRES_SSL_MODE says how the server's certificate is checked:
//   verify-full (default)  the chain against the trusted CAs and the host name
//   verify-ca              the chain only (the host name is not compared); it
//                          needs POSTGRES_SSL_CA_FILE, because a chain to a
//                          public CA proves nothing about whose server it is
//   no-verify              nothing (the behaviour before this setting existed)
// POSTGRES_SSL_CA_FILE (PEM, read when a pool is built; every certificate in
// it must parse) replaces Node's default trusted CAs for verify-full and
// verify-ca; no-verify ignores it.
// Any other mode refuses: never a silent fallback to a weaker check.
//
// With TLS off nothing changes: no ssl option is passed, and the connection
// string's own sslmode, if any, applies exactly as node-pg reads it.
//
// With TLS on, the connection string must not carry TLS parameters of its own.
// node-pg applies the parsed connection string over the explicit options
// (ConnectionParameters: Object.assign({}, config, parse(connectionString))),
// so `?sslmode=no-verify` or `?ssl=false` would silently replace the ssl option
// built here and turn verification, or TLS itself, off behind
// POSTGRES_SSL_MODE. Such a connection string is refused instead.

export const POSTGRES_SSL_MODES = Object.freeze(["verify-full", "verify-ca", "no-verify"]);
export const DEFAULT_POSTGRES_SSL_MODE = "verify-full";

// The parameters pg-connection-string turns into TLS settings (pg 8), with the
// spelling it reads (the names are case-sensitive there too).
export const CONNECTION_STRING_TLS_PARAMETERS = Object.freeze([
  "ssl",
  "sslcert",
  "sslkey",
  "sslmode",
  "sslrootcert",
  "uselibpqcompat",
]);

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----/;
const PEM_CERTIFICATE_GLOBAL = /-----BEGIN CERTIFICATE-----/g;
const PEM_CERTIFICATE_BLOCKS = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const MAX_QUOTED_MODE_LENGTH = 64;

const tlsError = (code, message) => Object.assign(new Error(message), { code });

/** The configured mode, validated; throws POSTGRES_SSL_MODE_INVALID. */
export const getPostgresSslMode = (env = process.env) => {
  const raw = typeof env.POSTGRES_SSL_MODE === "string" ? env.POSTGRES_SSL_MODE.trim() : "";

  if (!raw) {
    return DEFAULT_POSTGRES_SSL_MODE;
  }

  const mode = raw.toLowerCase();

  if (!POSTGRES_SSL_MODES.includes(mode)) {
    throw tlsError(
      "POSTGRES_SSL_MODE_INVALID",
      `POSTGRES_SSL_MODE "${raw.slice(0, MAX_QUOTED_MODE_LENGTH)}" is not supported; use ${POSTGRES_SSL_MODES.join(", ")}.`
    );
  }

  return mode;
};

export const getPostgresSslCaFile = (env = process.env) =>
  typeof env.POSTGRES_SSL_CA_FILE === "string" ? env.POSTGRES_SSL_CA_FILE.trim() : "";

// The connection string's query parameters as node-pg sees them: it resolves
// the string against postgres://base and retries an empty host with a dummy
// one. A string node-pg cannot parse either is left to node-pg to refuse, and
// a socket path (leading "/") carries no parameters.
const readConnectionStringParameters = (connectionString) => {
  const text = String(connectionString ?? "");

  if (!text || text.startsWith("/")) {
    return [];
  }

  for (const candidate of [text, text.replace("@/", "@___DUMMY___/")]) {
    try {
      return [...new URL(candidate, "postgres://base").searchParams.keys()];
    } catch {
      // Try the next spelling.
    }
  }

  return [];
};

/**
 * Refuses a connection string with TLS parameters while POSTGRES_SSL_ENABLED is
 * on. `label` names the variable in the error; the string itself (it may carry
 * a password) never appears.
 */
export const assertConnectionStringHasNoTlsParameters = (connectionString, label = "POSTGRES_DATABASE_URL") => {
  const found = [...new Set(readConnectionStringParameters(connectionString))]
    .filter((name) => CONNECTION_STRING_TLS_PARAMETERS.includes(name))
    .sort();

  if (found.length > 0) {
    throw tlsError(
      "POSTGRES_SSL_CONNECTION_STRING_CONFLICT",
      `${label} sets ${found.join(", ")} while POSTGRES_SSL_ENABLED is on; node-pg would let it replace POSTGRES_SSL_MODE. Remove it from the URL and use POSTGRES_SSL_MODE / POSTGRES_SSL_CA_FILE, or turn POSTGRES_SSL_ENABLED off to let the URL decide.`
    );
  }
};

const readCaFile = (path, readFile) => {
  let text;

  try {
    text = String(readFile(path, "utf8"));
  } catch (error) {
    throw tlsError(
      "POSTGRES_SSL_CA_FILE_UNREADABLE",
      `POSTGRES_SSL_CA_FILE cannot be read (${error?.code ?? "read failed"}).`
    );
  }

  const blocks = text.match(PEM_CERTIFICATE_BLOCKS) ?? [];

  if (!PEM_CERTIFICATE.test(text) || blocks.length === 0) {
    throw tlsError("POSTGRES_SSL_CA_FILE_INVALID", "POSTGRES_SSL_CA_FILE holds no PEM certificate.");
  }

  // Every certificate of the bundle must parse: a truncated or damaged one
  // would pass a marker check here and the health report, and then fail
  // every connection's handshake. Begin markers without their end count too.
  if ((text.match(PEM_CERTIFICATE_GLOBAL) ?? []).length !== blocks.length) {
    throw tlsError("POSTGRES_SSL_CA_FILE_INVALID", "POSTGRES_SSL_CA_FILE holds a PEM certificate without its end marker.");
  }

  blocks.forEach((block, index) => {
    try {
      new X509Certificate(block);
    } catch {
      throw tlsError(
        "POSTGRES_SSL_CA_FILE_INVALID",
        `POSTGRES_SSL_CA_FILE certificate ${index + 1} of ${blocks.length} cannot be parsed.`
      );
    }
  });

  return text;
};

// verify-ca: Node still verifies the chain (rejectUnauthorized), only the host
// name comparison is replaced by one that accepts every name.
const acceptAnyServerName = () => undefined;

/**
 * The `ssl` option for one pool or client: undefined with TLS off, otherwise
 * the mode's TLS settings. Throws (code POSTGRES_SSL_*) on an unknown mode, a
 * connection string with TLS parameters, verify-ca without a CA file, or a CA
 * file that cannot be read or holds no certificate. The mode is validated even
 * with TLS off, so a typo cannot wait for the day TLS is turned on.
 */
export const buildPostgresSslOption = ({
  connectionString,
  env = process.env,
  label = "POSTGRES_DATABASE_URL",
  readFile = readFileSync,
} = {}) => {
  const mode = getPostgresSslMode(env);

  if (!isPostgresSslEnabled(env)) {
    return undefined;
  }

  assertConnectionStringHasNoTlsParameters(connectionString, label);

  if (mode === "no-verify") {
    return { rejectUnauthorized: false };
  }

  const caFile = getPostgresSslCaFile(env);

  if (mode === "verify-ca" && !caFile) {
    throw tlsError(
      "POSTGRES_SSL_CA_FILE_REQUIRED",
      "POSTGRES_SSL_MODE=verify-ca needs POSTGRES_SSL_CA_FILE: without a private CA a chain check alone proves nothing about the server."
    );
  }

  return {
    rejectUnauthorized: true,
    ...(caFile ? { ca: readCaFile(caFile, readFile) } : {}),
    ...(mode === "verify-ca" ? { checkServerIdentity: acceptAnyServerName } : {}),
  };
};

/**
 * The TLS entry of the health report: null with TLS off and a valid (or unset)
 * mode, so the report is unchanged then. "error" when any connection would be
 * refused (each URL is checked, the CA file read), "warning" for no-verify,
 * "ok" otherwise. Names variables, never a URL.
 */
export const describePostgresTlsHealth = ({ connectionStrings = [], env = process.env, readFile = readFileSync } = {}) => {
  let mode;

  try {
    mode = getPostgresSslMode(env);
  } catch (error) {
    return { code: error.code, message: error.message, status: "error" };
  }

  if (!isPostgresSslEnabled(env)) {
    return null;
  }

  const caFile = Boolean(getPostgresSslCaFile(env));

  try {
    for (const { connectionString, label } of connectionStrings) {
      buildPostgresSslOption({ connectionString, env, label, readFile });
    }
  } catch (error) {
    return { caFile, code: error.code, message: error.message, mode, status: "error" };
  }

  if (mode === "no-verify") {
    return {
      caFile,
      certificateVerified: false,
      hostnameVerified: false,
      message: "PostgreSQL TLS is on but the server certificate is not verified (POSTGRES_SSL_MODE=no-verify).",
      mode,
      status: "warning",
    };
  }

  return {
    caFile,
    certificateVerified: true,
    hostnameVerified: mode === "verify-full",
    message:
      mode === "verify-full"
        ? "PostgreSQL TLS verifies the server certificate and host name."
        : "PostgreSQL TLS verifies the server certificate chain, not the host name.",
    mode,
    status: "ok",
  };
};
