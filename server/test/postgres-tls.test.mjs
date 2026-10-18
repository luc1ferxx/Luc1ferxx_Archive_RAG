// PostgreSQL TLS options (rag/postgres-tls.js) and every place that builds a
// connection with them: the runtime and owner pools and the dedicated LISTEN
// client (rag/postgres.js), and the read replicas' read and poll pools
// (rag/postgres-replicas.js). Database-free: the options are checked as
// node-pg receives them, never by connecting.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";
import pg from "pg";

import {
  CONNECTION_STRING_TLS_PARAMETERS,
  DEFAULT_POSTGRES_SSL_MODE,
  POSTGRES_SSL_MODES,
  buildPostgresSslOption,
  describePostgresTlsHealth,
  getPostgresSslMode,
} from "../rag/postgres-tls.js";
import {
  checkPostgresTlsHealth,
  createDedicatedPostgresClient,
  getPostgresMigrationPoolOptions,
  getPostgresPoolOptions,
} from "../rag/postgres.js";
import {
  checkReadReplicaHealth,
  configureReadReplicaRouting,
  getReadReplicaConfig,
  isReadReplicaRoutingEnabled,
  pollReadReplicasNow,
  resetReadReplicas,
} from "../rag/postgres-replicas.js";

const URL_WITH_PASSWORD = "postgres://owner:tls-test-password@db.internal:5432/archive";
// A throwaway self-signed CA certificate (its key was discarded when it was
// made): the CA file's certificates must parse (X509Certificate).
const CA_PEM = `${[
  "-----BEGIN CERTIFICATE-----",
  "MIIBkzCCATmgAwIBAgIUcXFlHdmeInL0Y2TsKi6wvMwBh1kwCgYIKoZIzj0EAwIw",
  "HjEcMBoGA1UEAwwTYXJjaGl2ZS1yYWctdGVzdC1jYTAgFw0yNjEwMTgwOTUwMTJa",
  "GA8yMTI2MDkyNDA5NTAxMlowHjEcMBoGA1UEAwwTYXJjaGl2ZS1yYWctdGVzdC1j",
  "YTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJwoo1ZyUmfFEkj2LAfiQjWvqnHg",
  "oaPpv719cnDpbgPqMAjL93a9R3BCGdbNSIcEUMDc+xNJliNaQ/3d73TDRTWjUzBR",
  "MB0GA1UdDgQWBBTjMzMa7UEix5Ev2FXBFHUpqwovYTAfBgNVHSMEGDAWgBTjMzMa",
  "7UEix5Ev2FXBFHUpqwovYTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gA",
  "MEUCIGs4qE0S83L6Nb8vi+8S4i5RKxPNTdseL/cXB5zheeVgAiEAm7vfu0yIK5pT",
  "HmIzY4rycEtfLD4dVdoZhXt74E2OneI=",
  "-----END CERTIFICATE-----",
].join("\n")}\n`;
const ENV_KEYS = [
  "LONG_MEMORY_DATABASE_URL",
  "LONG_MEMORY_POSTGRES_SSL_ENABLED",
  "POSTGRES_DATABASE_URL",
  "POSTGRES_MIGRATION_DATABASE_URL",
  "POSTGRES_READ_REPLICA_URLS",
  "POSTGRES_SSL_CA_FILE",
  "POSTGRES_SSL_ENABLED",
  "POSTGRES_SSL_MODE",
];

const directory = mkdtempSync(join(tmpdir(), "archive-rag-postgres-tls-"));
const caFile = join(directory, "ca.pem");
const notPemFile = join(directory, "not-pem.txt");

writeFileSync(caFile, CA_PEM);
writeFileSync(notPemFile, "not a certificate");

let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  ENV_KEYS.forEach((key) => delete process.env[key]);
});

afterEach(async () => {
  await configureReadReplicaRouting();
  ENV_KEYS.forEach((key) => {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  });
});

after(async () => {
  await resetReadReplicas();
  rmSync(directory, { force: true, recursive: true });
});

const refusedWith = (code) => (error) => {
  assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /tls-test-password/);
  return true;
};

test("modes: verify-full by default, case-insensitive, empty is unset, anything else refuses", () => {
  assert.deepEqual(POSTGRES_SSL_MODES, ["verify-full", "verify-ca", "no-verify"]);
  assert.equal(DEFAULT_POSTGRES_SSL_MODE, "verify-full");
  assert.equal(getPostgresSslMode({}), "verify-full");
  assert.equal(getPostgresSslMode({ POSTGRES_SSL_MODE: "" }), "verify-full");
  assert.equal(getPostgresSslMode({ POSTGRES_SSL_MODE: "  \t" }), "verify-full");
  assert.equal(getPostgresSslMode({ POSTGRES_SSL_MODE: " Verify-CA " }), "verify-ca");
  assert.equal(getPostgresSslMode({ POSTGRES_SSL_MODE: "NO-VERIFY" }), "no-verify");

  for (const value of ["require", "prefer", "disable", "verify_full", "true", "verify-full2"]) {
    assert.throws(
      () => getPostgresSslMode({ POSTGRES_SSL_MODE: value }),
      (error) => error.code === "POSTGRES_SSL_MODE_INVALID" && error.message.includes(`"${value}"`)
    );
  }
});

test("TLS off: no ssl option and the connection string untouched, whatever it says", () => {
  for (const env of [{}, { POSTGRES_SSL_ENABLED: "false" }, { POSTGRES_SSL_ENABLED: "false", POSTGRES_SSL_MODE: "verify-ca" }]) {
    assert.equal(buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env }), undefined);
    assert.equal(
      buildPostgresSslOption({ connectionString: `${URL_WITH_PASSWORD}?sslmode=no-verify`, env }),
      undefined
    );
  }

  // A typo is refused even with TLS off, so it cannot wait for the day TLS is
  // turned on.
  assert.throws(
    () => buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env: { POSTGRES_SSL_MODE: "require" } }),
    refusedWith("POSTGRES_SSL_MODE_INVALID")
  );

  process.env.POSTGRES_DATABASE_URL = `${URL_WITH_PASSWORD}?sslmode=require`;
  const options = getPostgresPoolOptions();

  assert.equal(options.ssl, undefined);
  assert.equal(options.connectionString, `${URL_WITH_PASSWORD}?sslmode=require`);
});

test("verify-full verifies chain and host name, with Node's CAs or POSTGRES_SSL_CA_FILE", () => {
  const env = { POSTGRES_SSL_ENABLED: "true" };

  assert.deepEqual(buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env }), { rejectUnauthorized: true });
  assert.deepEqual(
    buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env: { ...env, POSTGRES_SSL_CA_FILE: caFile } }),
    { ca: CA_PEM, rejectUnauthorized: true }
  );
  // LONG_MEMORY_POSTGRES_SSL_ENABLED is the older spelling of the switch.
  assert.deepEqual(
    buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env: { LONG_MEMORY_POSTGRES_SSL_ENABLED: "true" } }),
    { rejectUnauthorized: true }
  );
});

test("verify-ca verifies the chain but not the host name, and needs a CA file", () => {
  const env = { POSTGRES_SSL_ENABLED: "true", POSTGRES_SSL_MODE: "verify-ca" };

  assert.throws(
    () => buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env }),
    refusedWith("POSTGRES_SSL_CA_FILE_REQUIRED")
  );

  const ssl = buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env: { ...env, POSTGRES_SSL_CA_FILE: caFile } });

  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.ca, CA_PEM);
  assert.equal(typeof ssl.checkServerIdentity, "function");
  // Node's tls calls checkServerIdentity(hostname, cert) and treats undefined
  // as a match; the chain is still checked because rejectUnauthorized is on.
  assert.equal(ssl.checkServerIdentity("some-other-host", { subject: { CN: "db.internal" } }), undefined);
});

test("no-verify is today's option exactly and ignores the CA file", () => {
  const env = { POSTGRES_SSL_ENABLED: "true", POSTGRES_SSL_MODE: "no-verify", POSTGRES_SSL_CA_FILE: join(directory, "missing.pem") };

  assert.deepEqual(buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env }), { rejectUnauthorized: false });
});

test("an unreadable or non-PEM CA file refuses, naming the variable and never the path or URL", () => {
  const env = { POSTGRES_SSL_ENABLED: "true" };

  assert.throws(
    () =>
      buildPostgresSslOption({
        connectionString: URL_WITH_PASSWORD,
        env: { ...env, POSTGRES_SSL_CA_FILE: join(directory, "missing.pem") },
      }),
    (error) =>
      refusedWith("POSTGRES_SSL_CA_FILE_UNREADABLE")(error) &&
      /ENOENT/.test(error.message) &&
      !error.message.includes(directory)
  );
  assert.throws(
    () => buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env: { ...env, POSTGRES_SSL_CA_FILE: notPemFile } }),
    refusedWith("POSTGRES_SSL_CA_FILE_INVALID")
  );

  // Markers alone are not a certificate: a truncated or damaged one, one
  // without its end marker, or one bad certificate in a bundle is refused
  // here instead of failing every handshake later.
  const withCa = (text) => () =>
    buildPostgresSslOption({
      connectionString: URL_WITH_PASSWORD,
      env: { ...env, POSTGRES_SSL_CA_FILE: "/any" },
      readFile: () => text,
    });
  const [beginLine, ...rest] = CA_PEM.trim().split("\n");
  const endLine = rest.pop();
  const truncated = [beginLine, ...rest.slice(0, 2), endLine].join("\n");

  assert.throws(withCa("-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n"), refusedWith("POSTGRES_SSL_CA_FILE_INVALID"));
  assert.throws(withCa(truncated), (error) => refusedWith("POSTGRES_SSL_CA_FILE_INVALID")(error) && /certificate 1 of 1/.test(error.message));
  assert.throws(withCa(CA_PEM.slice(0, CA_PEM.indexOf("-----END"))), refusedWith("POSTGRES_SSL_CA_FILE_INVALID"));
  assert.throws(withCa(`${CA_PEM}${truncated}\n`), (error) => /certificate 2 of 2/.test(error.message));
  assert.throws(withCa(`${CA_PEM}-----BEGIN CERTIFICATE-----\nMIIB\n`), /without its end marker/);
  assert.deepEqual(withCa(`${CA_PEM}${CA_PEM}`)().ca, `${CA_PEM}${CA_PEM}`, "a bundle of good certificates is kept as is");

  let reads = 0;
  const readFile = () => {
    reads += 1;
    return CA_PEM;
  };

  buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env: { ...env, POSTGRES_SSL_CA_FILE: "/any" }, readFile });
  buildPostgresSslOption({ connectionString: URL_WITH_PASSWORD, env: { ...env, POSTGRES_SSL_CA_FILE: "/any" }, readFile });
  assert.equal(reads, 2, "the file is read each time a pool is built");
});

test("node-pg lets a connection string's TLS parameters replace the explicit ssl option", () => {
  // Why TLS parameters in the URL are refused with TLS on: the explicit
  // verify-full option below is silently dropped by node-pg.
  const explicit = { rejectUnauthorized: true };
  const noVerify = new pg.Client({ connectionString: `${URL_WITH_PASSWORD}?sslmode=no-verify`, ssl: explicit });
  const disabled = new pg.Client({ connectionString: `${URL_WITH_PASSWORD}?sslmode=disable`, ssl: explicit });
  const plain = new pg.Client({ connectionString: URL_WITH_PASSWORD, ssl: explicit });

  assert.deepEqual(noVerify.connectionParameters.ssl, { rejectUnauthorized: false });
  assert.equal(disabled.connectionParameters.ssl, false);
  assert.deepEqual(plain.connectionParameters.ssl, explicit);
});

test("TLS on: a connection string with TLS parameters of its own is refused", () => {
  const env = { POSTGRES_SSL_ENABLED: "true" };

  assert.deepEqual(CONNECTION_STRING_TLS_PARAMETERS, ["ssl", "sslcert", "sslkey", "sslmode", "sslrootcert", "uselibpqcompat"]);

  for (const query of [
    "sslmode=no-verify",
    "sslmode=verify-full",
    "sslmode=disable",
    "ssl=false",
    "ssl=true",
    "sslrootcert=/etc/ca.pem",
    "uselibpqcompat=true&sslmode=require",
    "application_name=x&sslmode=prefer",
  ]) {
    assert.throws(
      () => buildPostgresSslOption({ connectionString: `${URL_WITH_PASSWORD}?${query}`, env, label: "POSTGRES_DATABASE_URL" }),
      (error) => refusedWith("POSTGRES_SSL_CONNECTION_STRING_CONFLICT")(error) && error.message.startsWith("POSTGRES_DATABASE_URL sets")
    );
  }

  // Other parameters, a socket path, an empty-host URL and the upper-case
  // spelling node-pg does not read are fine.
  for (const connectionString of [
    `${URL_WITH_PASSWORD}?application_name=archive`,
    "/var/run/postgresql archive",
    "postgres://owner@/archive?host=/var/run/postgresql",
    `${URL_WITH_PASSWORD}?SSLMODE=disable`,
  ]) {
    assert.deepEqual(buildPostgresSslOption({ connectionString, env }), { rejectUnauthorized: true });
  }
});

test("the runtime pool, the owner pool and the LISTEN client all carry the mode", () => {
  process.env.POSTGRES_DATABASE_URL = URL_WITH_PASSWORD;
  process.env.POSTGRES_MIGRATION_DATABASE_URL = "postgres://migrator:tls-test-password@db.internal/archive";
  process.env.POSTGRES_SSL_ENABLED = "true";
  process.env.POSTGRES_SSL_MODE = "verify-ca";
  process.env.POSTGRES_SSL_CA_FILE = caFile;

  for (const options of [getPostgresPoolOptions(), getPostgresMigrationPoolOptions()]) {
    assert.equal(options.ssl.rejectUnauthorized, true);
    assert.equal(options.ssl.ca, CA_PEM);
    assert.equal(typeof options.ssl.checkServerIdentity, "function");
  }

  const client = createDedicatedPostgresClient();

  assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
  assert.equal(client.connectionParameters.ssl.ca, CA_PEM);

  process.env.POSTGRES_SSL_MODE = "no-verify";
  assert.deepEqual(getPostgresPoolOptions().ssl, { rejectUnauthorized: false });
  assert.deepEqual(getPostgresMigrationPoolOptions().ssl, { rejectUnauthorized: false });

  process.env.POSTGRES_SSL_MODE = "verify-full";
  process.env.POSTGRES_MIGRATION_DATABASE_URL = "postgres://migrator:tls-test-password@db.internal/archive?sslmode=no-verify";
  assert.deepEqual(getPostgresPoolOptions().ssl, { ca: CA_PEM, rejectUnauthorized: true });
  assert.throws(
    () => getPostgresMigrationPoolOptions(),
    (error) =>
      refusedWith("POSTGRES_SSL_CONNECTION_STRING_CONFLICT")(error) &&
      error.message.startsWith("POSTGRES_MIGRATION_DATABASE_URL sets sslmode")
  );

  process.env.POSTGRES_DATABASE_URL = `${URL_WITH_PASSWORD}?ssl=false`;
  assert.throws(() => getPostgresPoolOptions(), refusedWith("POSTGRES_SSL_CONNECTION_STRING_CONFLICT"));
  assert.throws(() => createDedicatedPostgresClient(), refusedWith("POSTGRES_SSL_CONNECTION_STRING_CONFLICT"));

  process.env.POSTGRES_SSL_MODE = "require";
  assert.throws(() => getPostgresPoolOptions(), refusedWith("POSTGRES_SSL_MODE_INVALID"));
});

test("replica read and poll pools carry the primary's TLS option; a bad setting fails closed", async () => {
  const primary = "postgres://owner:tls-test-password@primary.internal/archive";
  const replica = "postgres://reader:tls-test-password@replica.internal/archive";
  const created = [];

  process.env.POSTGRES_DATABASE_URL = primary;
  process.env.POSTGRES_READ_REPLICA_URLS = replica;
  process.env.POSTGRES_SSL_ENABLED = "true";
  process.env.POSTGRES_SSL_CA_FILE = caFile;

  await configureReadReplicaRouting({
    createPool: (options) => {
      created.push(options);
      return {
        connect: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        },
        end: async () => {},
      };
    },
  });

  assert.deepEqual(getReadReplicaConfig().ssl, { ca: CA_PEM, rejectUnauthorized: true });
  assert.equal(getReadReplicaConfig().sslMode, "verify-full");

  await pollReadReplicasNow();

  assert.deepEqual(
    created.map((options) => [options.connectionString, options.ssl]).sort(),
    [
      [primary, { ca: CA_PEM, rejectUnauthorized: true }],
      [replica, { ca: CA_PEM, rejectUnauthorized: true }],
    ]
  );

  // The parsed configuration is cached by the variables' text: a CA file
  // replaced in place is read again only after a reset (resetPostgresPool
  // calls resetReadReplicas), which must not keep the old certificate.
  const rotatedCaFile = join(directory, "rotated-ca.pem");

  writeFileSync(rotatedCaFile, CA_PEM);
  process.env.POSTGRES_SSL_CA_FILE = rotatedCaFile;
  assert.equal(getReadReplicaConfig().ssl.ca, CA_PEM);
  writeFileSync(rotatedCaFile, `${CA_PEM}${CA_PEM}`);
  assert.equal(getReadReplicaConfig().ssl.ca, CA_PEM, "cached until a reset");
  await resetReadReplicas();
  assert.equal(getReadReplicaConfig().ssl.ca, `${CA_PEM}${CA_PEM}`, "the reset reads the file again");
  process.env.POSTGRES_SSL_CA_FILE = caFile;

  // TLS off: no ssl option, as before.
  assert.equal(getReadReplicaConfig({ POSTGRES_READ_REPLICA_URLS: replica }).ssl, undefined);
  assert.equal(getReadReplicaConfig({ POSTGRES_READ_REPLICA_URLS: replica }).sslMode, null);

  // A replica URL that sets its own TLS, an invalid mode or a missing CA file:
  // routing throws (every read-only statement then fails) and health is an
  // error, never a weaker replica connection.
  for (const [settings, code] of [
    [{ POSTGRES_READ_REPLICA_URLS: `${replica}?sslmode=no-verify` }, "POSTGRES_SSL_CONNECTION_STRING_CONFLICT"],
    [{ POSTGRES_SSL_MODE: "allow" }, "POSTGRES_SSL_MODE_INVALID"],
    [{ POSTGRES_SSL_CA_FILE: join(directory, "missing.pem") }, "POSTGRES_SSL_CA_FILE_UNREADABLE"],
  ]) {
    const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));

    Object.assign(process.env, settings);
    assert.throws(() => isReadReplicaRoutingEnabled(), refusedWith(code));

    const health = await checkReadReplicaHealth();

    assert.equal(health.status, "error");
    assert.doesNotMatch(health.message, /tls-test-password/);
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
});

test("the health entry: absent with TLS off, ok for verify-*, warning for no-verify, error when refused", () => {
  assert.equal(describePostgresTlsHealth({ env: {} }), null);
  assert.equal(describePostgresTlsHealth({ env: { POSTGRES_SSL_MODE: "no-verify" } }), null);
  assert.deepEqual(describePostgresTlsHealth({ env: { POSTGRES_SSL_MODE: "nope" } }), {
    code: "POSTGRES_SSL_MODE_INVALID",
    message: 'POSTGRES_SSL_MODE "nope" is not supported; use verify-full, verify-ca, no-verify.',
    status: "error",
  });

  const connectionStrings = [{ connectionString: URL_WITH_PASSWORD, label: "POSTGRES_DATABASE_URL" }];

  assert.deepEqual(describePostgresTlsHealth({ connectionStrings, env: { POSTGRES_SSL_ENABLED: "true" } }), {
    caFile: false,
    certificateVerified: true,
    hostnameVerified: true,
    message: "PostgreSQL TLS verifies the server certificate and host name.",
    mode: "verify-full",
    status: "ok",
  });
  assert.equal(
    describePostgresTlsHealth({
      connectionStrings,
      env: { POSTGRES_SSL_CA_FILE: caFile, POSTGRES_SSL_ENABLED: "true", POSTGRES_SSL_MODE: "verify-ca" },
    }).hostnameVerified,
    false
  );

  const noVerify = describePostgresTlsHealth({
    connectionStrings,
    env: { POSTGRES_SSL_ENABLED: "true", POSTGRES_SSL_MODE: "no-verify" },
  });

  assert.equal(noVerify.status, "warning");
  assert.equal(noVerify.certificateVerified, false);

  const conflict = describePostgresTlsHealth({
    connectionStrings: [...connectionStrings, { connectionString: `${URL_WITH_PASSWORD}?sslmode=disable`, label: "POSTGRES_READ_REPLICA_URLS entry 1" }],
    env: { POSTGRES_SSL_ENABLED: "true" },
  });

  assert.equal(conflict.status, "error");
  assert.equal(conflict.code, "POSTGRES_SSL_CONNECTION_STRING_CONFLICT");
  assert.match(conflict.message, /^POSTGRES_READ_REPLICA_URLS entry 1 sets sslmode/);
  assert.doesNotMatch(conflict.message, /tls-test-password/);
});

test("checkPostgresTlsHealth checks the runtime, owner and replica URLs of this process", () => {
  process.env.POSTGRES_DATABASE_URL = URL_WITH_PASSWORD;
  assert.equal(checkPostgresTlsHealth(), null);

  process.env.POSTGRES_SSL_ENABLED = "true";
  assert.equal(checkPostgresTlsHealth().status, "ok");

  process.env.POSTGRES_MIGRATION_DATABASE_URL = `${URL_WITH_PASSWORD}?sslmode=require`;
  assert.match(checkPostgresTlsHealth().message, /^POSTGRES_MIGRATION_DATABASE_URL sets sslmode/);

  delete process.env.POSTGRES_MIGRATION_DATABASE_URL;
  process.env.POSTGRES_READ_REPLICA_URLS = `postgres://r@replica.internal/archive,postgres://r@replica-b.internal/archive?ssl=0`;
  assert.match(checkPostgresTlsHealth().message, /^POSTGRES_READ_REPLICA_URLS entry 2 sets ssl /);

  // An invalid replica list is the readReplicas entry's error.
  process.env.POSTGRES_READ_REPLICA_URLS = ",";
  assert.equal(checkPostgresTlsHealth().status, "ok");
});
