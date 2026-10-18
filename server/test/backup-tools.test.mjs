// backup-tools.mjs without a database: every connection of a command (the
// tool's own pg.Clients and pg_dump / pg_restore) is resolved from the URL
// alone, never from the caller's PG* variables, with the TLS the app would
// use (rag/postgres-tls.js); and the files archive finds local KMS key
// material by its content wherever it lies. The dump, restore and verify on a
// real PostgreSQL are backup-restore-postgres.integration.test.mjs.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";

import pg from "pg";

import {
  createBackupClient,
  findKeyMaterialFiles,
  resolveBackupConnection,
  toCanonicalDatabaseUrl,
  toPgEnvironment,
} from "../backup-tools.mjs";
import { LOCAL_KMS_FILE_FORMATS } from "../rag/kms/local-provider.js";

// A throwaway self-signed CA certificate (its key was discarded when it was
// made), so the CA file parses as the app requires.
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
const SHELL_PG_VARIABLES = {
  PGDATABASE: "shell_db",
  PGHOST: "shell.example",
  PGPASSWORD: "shell-password",
  PGPORT: "6543",
  PGSSLMODE: "require",
  PGUSER: "shell_user",
};
const TLS_VARIABLES = ["LONG_MEMORY_POSTGRES_SSL_ENABLED", "POSTGRES_SSL_CA_FILE", "POSTGRES_SSL_ENABLED", "POSTGRES_SSL_MODE"];

let directory;
let caFile;
let savedEnv;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "backup-tools-"));
  caFile = path.join(directory, "ca.pem");
  await writeFile(caFile, CA_PEM);
});

after(async () => {
  await rm(directory, { force: true, recursive: true });
});

beforeEach(() => {
  savedEnv = Object.fromEntries(
    [...Object.keys(SHELL_PG_VARIABLES), ...TLS_VARIABLES].map((key) => [key, process.env[key]])
  );
  TLS_VARIABLES.forEach((key) => delete process.env[key]);
  Object.assign(process.env, SHELL_PG_VARIABLES);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("the clients and pg_dump get the URL's server and nothing from the shell's PG* variables", () => {
  // A URL without a port or a password: node-pg used to fill both from the
  // shell (PGPORT, PGPASSWORD), while pg_dump ran without them.
  const connection = resolveBackupConnection("postgres://owner@db.internal/archive");
  const parameters = createBackupClient(connection).connectionParameters;

  assert.deepEqual(
    {
      database: parameters.database,
      host: parameters.host,
      password: parameters.password,
      port: parameters.port,
      ssl: parameters.ssl,
      user: parameters.user,
    },
    { database: "archive", host: "db.internal", password: null, port: 5432, ssl: false, user: "owner" }
  );
  assert.deepEqual(connection.pgEnv, {
    PGDATABASE: "archive",
    PGHOST: "db.internal",
    PGPORT: "5432",
    PGUSER: "owner",
  });
  assert.equal(process.env.PGHOST, "shell.example", "the shell's variables are back after the client is built");

  // No user or database in the URL: libpq's defaults (the OS user, a
  // database named like it), spelled out for both.
  const bare = resolveBackupConnection("postgres://db.internal:5433");

  assert.equal(bare.pgEnv.PGUSER, os.userInfo().username);
  assert.equal(bare.pgEnv.PGDATABASE, os.userInfo().username);
  assert.equal(createBackupClient(bare).connectionParameters.user, os.userInfo().username);
  assert.equal(createBackupClient(bare).connectionParameters.port, 5433);

  // The password reaches both, never a command line.
  assert.equal(toPgEnvironment("postgres://owner:p%40ss@db.internal/archive").PGPASSWORD, "p@ss");
  assert.equal(
    createBackupClient(resolveBackupConnection("postgres://owner:p%40ss@db.internal/archive")).connectionParameters.password,
    "p@ss"
  );
});

test("a URL without a host is refused; a socket directory and IPv6 resolve alike everywhere", () => {
  assert.throws(() => resolveBackupConnection("postgresql:///archive"), /names no host/);

  const socket = "postgresql://drill@localhost:55432/scratch?host=/tmp/drill-socket";
  const connection = resolveBackupConnection(socket);
  const canonical = new pg.Client({ connectionString: toCanonicalDatabaseUrl(socket) }).connectionParameters;

  assert.deepEqual([connection.pgEnv.PGHOST, connection.pgEnv.PGPORT], ["/tmp/drill-socket", "55432"]);
  assert.deepEqual([connection.clientConfig.host, connection.clientConfig.port], ["/tmp/drill-socket", 55432]);
  assert.deepEqual(
    [canonical.host, canonical.port, canonical.user, canonical.database],
    ["/tmp/drill-socket", 55432, "drill", "scratch"],
    "the URL verify hands the app code names the same server, with nothing left to the shell"
  );

  const ipv6 = resolveBackupConnection("postgres://owner@[::1]:5432/archive");

  assert.equal(ipv6.pgEnv.PGHOST, "::1", "libpq takes the address without brackets");
  assert.equal(new pg.Client({ connectionString: toCanonicalDatabaseUrl("postgres://owner@[::1]/archive") }).connectionParameters.port, 5432);
});

test("with POSTGRES_SSL_ENABLED the clients take the app's TLS option and pg_dump the libpq equivalent", () => {
  process.env.POSTGRES_SSL_ENABLED = "true";

  const url = "postgres://owner:secret@db.internal/archive";
  const verifyFull = resolveBackupConnection(url);

  assert.deepEqual(verifyFull.clientConfig.ssl, { rejectUnauthorized: true });
  assert.equal(verifyFull.pgEnv.PGSSLMODE, "verify-full");
  assert.equal(verifyFull.pgEnv.PGSSLROOTCERT, "system", "Node's trusted CAs: libpq's system store");

  process.env.POSTGRES_SSL_CA_FILE = caFile;

  const withCa = resolveBackupConnection(url);

  assert.deepEqual(withCa.clientConfig.ssl, { ca: CA_PEM, rejectUnauthorized: true });
  assert.equal(withCa.pgEnv.PGSSLROOTCERT, caFile);
  assert.deepEqual(createBackupClient(withCa).connectionParameters.ssl, { ca: CA_PEM, rejectUnauthorized: true });

  process.env.POSTGRES_SSL_MODE = "verify-ca";

  const verifyCa = resolveBackupConnection(url);

  assert.equal(verifyCa.pgEnv.PGSSLMODE, "verify-ca");
  assert.equal(verifyCa.pgEnv.PGSSLROOTCERT, caFile);
  assert.equal(typeof verifyCa.clientConfig.ssl.checkServerIdentity, "function");

  process.env.POSTGRES_SSL_MODE = "no-verify";

  const noVerify = resolveBackupConnection(url);

  assert.deepEqual(noVerify.clientConfig.ssl, { rejectUnauthorized: false });
  assert.equal(noVerify.pgEnv.PGSSLMODE, "require");
  assert.equal(noVerify.pgEnv.PGSSLROOTCERT, undefined);

  // One TLS setting, never two: a URL with its own sslmode is refused before
  // anything connects, as the app (and so verify's health probe) refuses it.
  process.env.POSTGRES_SSL_MODE = "verify-full";
  assert.throws(
    () => resolveBackupConnection(`${url}?sslmode=disable`),
    (error) => error.code === "POSTGRES_SSL_CONNECTION_STRING_CONFLICT" && !error.message.includes("secret")
  );

  process.env.POSTGRES_SSL_MODE = "allow";
  assert.throws(() => resolveBackupConnection(url), { code: "POSTGRES_SSL_MODE_INVALID" });
});

test("with TLS off the URL's own TLS parameters decide for both, and a URL without any means no TLS", () => {
  const url = `postgres://owner@db.internal/archive?sslmode=verify-full&sslrootcert=${encodeURIComponent(caFile)}`;
  const connection = resolveBackupConnection(url);

  assert.equal(connection.pgEnv.PGSSLMODE, "verify-full");
  assert.equal(connection.pgEnv.PGSSLROOTCERT, caFile);
  assert.deepEqual(connection.clientConfig.ssl, { ca: CA_PEM });

  const plain = resolveBackupConnection("postgres://owner@db.internal/archive");

  assert.equal(plain.clientConfig.ssl, false, "not the shell's PGSSLMODE");
  assert.equal(plain.pgEnv.PGSSLMODE, undefined, "pg_dump keeps libpq's default");
});

test("the files archive finds local KMS key material by content, wherever it lies and whatever its name", async () => {
  const root = path.join(directory, "state");
  const data = path.join(root, "data");
  const uploads = path.join(root, "uploads");
  const keyFile = (extra = {}) =>
    JSON.stringify({ format: LOCAL_KMS_FILE_FORMATS.keyFile, formatVersion: 1, keyId: "tk_x", versions: [], ...extra });

  await mkdir(path.join(data, "vault", "deep"), { recursive: true });
  await mkdir(uploads, { recursive: true });
  await writeFile(path.join(data, "vault", "deep", "tk_a.json"), keyFile({ versions: [{ version: 1, wrappedKey: "AAAA" }] }));
  // A destroyed key's tombstone keeps the key file's format.
  await writeFile(path.join(data, "vault", "tk_b.json"), keyFile({ currentVersion: null, destroyedThroughVersion: 2 }));
  // A key file's temp copy, and the master key under a name no pattern knows.
  await writeFile(path.join(data, "vault", "tk_c.json.1234.tmp"), keyFile());
  await writeFile(path.join(uploads, "wrapping.bin"), JSON.stringify({ format: LOCAL_KMS_FILE_FORMATS.masterKey, key: "AAAA" }));
  // Not key material: other JSON, JSON lines, a PDF, a file over the bound.
  await writeFile(path.join(data, "documents.json"), JSON.stringify([{ format: LOCAL_KMS_FILE_FORMATS.keyFile }]));
  await writeFile(path.join(data, "events.jsonl"), `${JSON.stringify({ format: LOCAL_KMS_FILE_FORMATS.keyFile })}\n{}\n`);
  await writeFile(path.join(uploads, "doc.pdf"), "%PDF-1.4");
  await writeFile(path.join(data, "big.json"), keyFile({ padding: "x".repeat(2048) }));
  // A link is archived as a link: its target is not read through it.
  await symlink(path.join(data, "vault", "tk_b.json"), path.join(uploads, "link.json"));

  const found = await findKeyMaterialFiles([uploads, data, path.join(root, "missing")], { maxBytes: 1024 });

  assert.deepEqual(found, [
    { file: "uploads/wrapping.bin", format: LOCAL_KMS_FILE_FORMATS.masterKey },
    { file: "data/vault/deep/tk_a.json", format: LOCAL_KMS_FILE_FORMATS.keyFile },
    { file: "data/vault/tk_b.json", format: LOCAL_KMS_FILE_FORMATS.keyFile },
    { file: "data/vault/tk_c.json.1234.tmp", format: LOCAL_KMS_FILE_FORMATS.keyFile },
  ]);
  assert.equal(JSON.stringify(found).includes("AAAA"), false, "paths and formats only");
});
