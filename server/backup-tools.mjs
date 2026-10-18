#!/usr/bin/env node
// Backup, restore and backup verification of the PostgreSQL database
// (docs/operations.md "备份与恢复"). The shell wrappers in scripts/
// (backup-postgres.sh, restore-postgres.sh, verify-backup.sh) find the
// PostgreSQL client binaries and call this with one subcommand:
//
//   node backup-tools.mjs backup  --database-url <url> --out <dir> [--name <base>] [--with-files]
//   node backup-tools.mjs restore --database-url <url> --dump <file> [--manifest <file>] [--force] [--dry-run]
//   node backup-tools.mjs verify  --database-url <url> --manifest <file> [--allow-pending-migrations]
//
// - The database URL comes from --database-url, else BACKUP_DATABASE_URL in
//   the environment. This tool never reads server/.env (no dotenv): an
//   operator passes the URL on purpose. It must be the login that owns the
//   tables (the migration login under the role split): the owner path reads
//   every tenant's rows past row-level security, which a backup needs.
// - Credentials never reach a command line or the manifest: pg_dump and
//   pg_restore get them through PG* environment variables, and the manifest
//   names only host, port and database.
// - One server for every connection: the tool's own pg.Clients (the
//   inventory, the role checks, verify) and pg_dump / pg_restore are given the
//   same host, port, database, user and password, resolved from the URL alone
//   (resolveBackupConnection). The children run without the caller's PG*
//   variables, and the clients are built with them hidden, because node-pg
//   would otherwise fill any part the URL leaves out from the shell's
//   PGHOST / PGPORT / PGPASSWORD. A URL without a host (libpq's default
//   socket, node-pg's localhost) is refused for the same reason.
// - TLS as the app resolves it (rag/postgres-tls.js): with
//   POSTGRES_SSL_ENABLED on, POSTGRES_SSL_MODE and POSTGRES_SSL_CA_FILE set
//   the clients' ssl option exactly as for the app's pools, and pg_dump /
//   pg_restore get the libpq equivalent (verify-full -> PGSSLMODE=verify-full
//   with PGSSLROOTCERT the CA file, or "system" without one, which needs libpq
//   16; verify-ca -> verify-ca with the CA file; no-verify -> require); a URL
//   that carries TLS parameters of its own is then refused before anything
//   connects (POSTGRES_SSL_CONNECTION_STRING_CONFLICT), as the app and verify's
//   health probe would refuse it. With it off, the URL's own sslmode,
//   sslrootcert, sslcert and sslkey decide for both, as before; a URL with
//   none connects the clients without TLS and leaves pg_dump / pg_restore at
//   libpq's default (prefer).
// - Every file a backup writes (dump, manifest, files archive) is created
//   0600, and an --out directory the tool creates 0700.
// - backup: pg_dump -Fc inside an exported REPEATABLE READ snapshot, and in
//   that same snapshot the manifest's inventory (applied migrations, every
//   table's row count, per-tenant document counts, the head of every admin
//   audit chain), so the counts describe exactly what the dump holds. Then
//   the dump's SHA-256. --with-files adds a tar of the on-disk state outside
//   PostgreSQL (uploads, upload sessions, the data directory) without the
//   tenant keystore (see below).
// - restore: checks the dump against the manifest's checksum, refuses a
//   target that already holds tables unless --force (which restores with
//   --clean), prints its plan, creates the NOLOGIN roles the row policies
//   name if they are missing, and runs pg_restore --no-owner --exit-on-error
//   --single-transaction (all or nothing), then grants the tenant role to the
//   restoring login as migration 013 does. --dry-run prints the plan only.
// - verify: everything a restore drill must show before the backup counts as
//   good: the dump's checksum (the --dump given, else the dump the manifest
//   names when it lies next to it) and the files archive's when it does,
//   every migration file applied and none unknown, every table's row count
//   and every tenant's document counts equal to the manifest, the health
//   check's rowLevelSecurity entry without an error, every admin audit chain
//   verifying (audit:verify's own code) and ending where the manifest says it
//   ended. Exit 0 when all hold, 1 when one does not. It never migrates the
//   restored database: with --allow-pending-migrations and migrations pending,
//   the rowLevelSecurity check (which migrates first) is skipped as
//   `pending_migrations`, and the audit chains are read without migrating.
//
// Not in a backup, deliberately: the tenant keystore of envelope encryption
// (TENANT_KEYSTORE_DIR) and the local KMS master key that wraps it
// (TENANT_KMS_MASTER_KEY_FILE), kept outside PostgreSQL and outside this tar so that
// erasing a tenant's key also makes that tenant's bytes in every backup copy
// unreadable; back it up separately, on its own schedule and retention, or
// not at all. The tar leaves them out three ways, because this process never
// reads server/.env where those two settings usually live: by path (the
// --keystore-dir / --kms-master-key-file flags, else the variables, else the
// defaults under the data root), by name (*keystore*, *kms-master*), and by
// content (any file of at most 1 MiB in the archived directories whose JSON
// `format` is a local KMS key file's, tombstones included, or the master
// key's), and the manifest lists what the content check found, by path and
// format only. Also not in it: server/.env and every other secret, role
// passwords and role memberships (cluster-wide, not part of a database dump),
// Redis shared state (rebuilt at run time), and the in-process caches.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

import { isPostgresSslEnabled } from "./rag/config.js";
import { LOCAL_KMS_FILE_FORMATS, resolveLocalKmsPaths } from "./rag/kms/local-provider.js";
import {
  CONNECTION_STRING_TLS_PARAMETERS,
  buildPostgresSslOption,
  getPostgresSslCaFile,
  getPostgresSslMode,
} from "./rag/postgres-tls.js";

const __filename = fileURLToPath(import.meta.url);
const SERVER_DIRECTORY = path.dirname(__filename);
const MIGRATIONS_DIRECTORY = path.join(SERVER_DIRECTORY, "db", "migrations");

export const BACKUP_MANIFEST_FORMAT = "archive-rag-backup/1";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
// By name too, for a keystore or master key copied under another path.
const KEY_MATERIAL_EXCLUDE_PATTERNS = ["*keystore*", "*kms-master*"];
// And by content: files no larger than this are read for a local KMS format.
export const KEY_MATERIAL_SCAN_MAX_BYTES = 1024 * 1024;
// An extension's own entry, or its comment, in pg_restore --list output.
const EXTENSION_TOC_ENTRY = /^\d+;\s+\d+\s+\d+\s+(COMMENT\s+-\s+)?EXTENSION\s/;

export const USAGE = `Usage:
  node backup-tools.mjs backup  --database-url <url> [--out <dir>] [--name <base>] [--with-files]
                                [--uploads-dir <dir>] [--upload-sessions-dir <dir>] [--data-dir <dir>]
                                [--keystore-dir <dir>] [--kms-master-key-file <file>]
  node backup-tools.mjs restore --database-url <url> --dump <file> [--manifest <file>] [--force] [--dry-run]
  node backup-tools.mjs verify  --database-url <url> --manifest <file> [--dump <file>] [--allow-pending-migrations]

The database URL may come from BACKUP_DATABASE_URL instead of --database-url.
server/.env is never read. Binaries: --pg-dump / --pg-restore, else PG_DUMP /
PG_RESTORE, else the ones on PATH. --keystore-dir and --kms-master-key-file
(else TENANT_KEYSTORE_DIR / TENANT_KMS_MASTER_KEY_FILE) name the tenant keystore
and master key to leave out of --with-files; files holding local KMS key
material are left out by their content too. TLS follows POSTGRES_SSL_ENABLED /
POSTGRES_SSL_MODE / POSTGRES_SSL_CA_FILE in the environment, else the URL's
own sslmode.
`;

// ---------------------------------------------------------------------------
// Arguments and connections
// ---------------------------------------------------------------------------

const FLAGS = new Set(["--allow-pending-migrations", "--dry-run", "--force", "--help", "--json", "--with-files"]);

export const parseBackupArgs = (argv = []) => {
  const [command = "", ...rest] = argv;
  const options = { command };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = String(rest[index]);
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];

    if (!name.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}".`);
    }

    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    if (FLAGS.has(name)) {
      options[key] = true;
      continue;
    }

    const value = inline ?? rest[++index];

    if (value === undefined || String(value).trim() === "") {
      throw new Error(`${name} needs a value.`);
    }

    options[key] = String(value).trim();
  }

  return options;
};

const resolveDatabaseUrl = (options) => {
  const url = String(options.databaseUrl ?? process.env.BACKUP_DATABASE_URL ?? "").trim();

  if (!url) {
    throw new Error("Pass --database-url (or set BACKUP_DATABASE_URL); server/.env is not read.");
  }

  return url;
};

/** Host, port and database of a URL, never its user or password. */
export const describeDatabaseUrl = (url) => {
  const parsed = new URL(url);
  const socketHost = parsed.searchParams.get("host");

  return {
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || null,
    host: socketHost || parsed.hostname || null,
    port: parsed.port ? Number(parsed.port) : 5432,
  };
};

// Where every connection of a command goes, from the URL alone: libpq's own
// defaults for what it leaves out (port 5432, the login's OS user name, a
// database named like the user), never the caller's PG* variables.
const resolveConnectionParts = (url) => {
  const parsed = new URL(url);
  const host = parsed.searchParams.get("host") || parsed.hostname.replace(/^\[(.*)\]$/, "$1");

  if (!host) {
    throw new Error(
      "The database URL names no host. Name one, or a socket directory with ?host=/path/to/socket/dir: without it pg_dump and pg_restore would use libpq's default socket while this tool's own connections went to localhost, which need not be the same server."
    );
  }

  const user = parsed.username ? decodeURIComponent(parsed.username) : os.userInfo().username;

  return {
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || user,
    host,
    password: parsed.password ? decodeURIComponent(parsed.password) : null,
    port: parsed.searchParams.get("port") || parsed.port || "5432",
    user,
  };
};

const URL_TLS_VARIABLES = Object.freeze([
  ["sslmode", "PGSSLMODE"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["sslcert", "PGSSLCERT"],
  ["sslkey", "PGSSLKEY"],
]);

// POSTGRES_SSL_MODE as libpq spells it (rag/postgres-tls.js has the modes).
const LIBPQ_SSL_MODES = Object.freeze({ "no-verify": "require", "verify-ca": "verify-ca", "verify-full": "verify-full" });

// Runs `build` with every PG* variable of this process hidden, and puts them
// back: node-pg's constructor reads them for any value its config leaves out
// (the password, ssl, the connect timeout, the application name), and the
// children never see them either (runProcess). Synchronous, so nothing else
// runs while they are gone.
const withoutPgVariables = (build) => {
  const hidden = Object.entries(process.env).filter(([key]) => key.startsWith("PG"));

  for (const [key] of hidden) {
    delete process.env[key];
  }

  try {
    return build();
  } finally {
    for (const [key, value] of hidden) {
      process.env[key] = value;
    }
  }
};

// The TLS of a command's connections (see the header): { clientSsl, pgEnv }.
const resolveBackupTls = (url, env) => {
  // Validates the mode even with TLS off, refuses a URL with TLS parameters
  // with it on, and reads the CA file: the app's own rules.
  const clientSsl = buildPostgresSslOption({ connectionString: url, env, label: "The backup database URL" });

  if (isPostgresSslEnabled(env)) {
    const mode = getPostgresSslMode(env);
    const caFile = getPostgresSslCaFile(env);

    return {
      clientSsl,
      pgEnv: {
        PGSSLMODE: LIBPQ_SSL_MODES[mode],
        ...(mode !== "no-verify" && caFile
          ? { PGSSLROOTCERT: path.resolve(caFile) }
          : mode === "verify-full"
            ? { PGSSLROOTCERT: "system" }
            : {}),
      },
    };
  }

  const parsed = new URL(url);
  const pgEnv = Object.fromEntries(
    URL_TLS_VARIABLES.filter(([param]) => parsed.searchParams.get(param)).map(([param, variable]) => [
      variable,
      parsed.searchParams.get(param),
    ])
  );

  // The URL's TLS parameters as node-pg reads them (they used to reach the
  // client through its connection string); none: no TLS.
  return {
    clientSsl: [...parsed.searchParams.keys()].some((name) => CONNECTION_STRING_TLS_PARAMETERS.includes(name))
      ? withoutPgVariables(() => new pg.Client({ connectionString: url }).connectionParameters.ssl)
      : false,
    pgEnv,
  };
};

/**
 * Every connection setting of a command, resolved once: `clientConfig` for
 * this tool's pg.Clients and `pgEnv`, the PG* variables of pg_dump and
 * pg_restore, naming the same server, login and TLS (see the header). Throws
 * on a URL without a host and on TLS settings the app would refuse.
 */
export const resolveBackupConnection = (url, env = process.env) => {
  const parts = resolveConnectionParts(url);
  const { clientSsl, pgEnv: tlsEnv } = resolveBackupTls(url, env);

  return {
    clientConfig: {
      database: parts.database,
      host: parts.host,
      ...(parts.password === null ? {} : { password: parts.password }),
      port: Number(parts.port),
      ssl: clientSsl,
      user: parts.user,
    },
    pgEnv: {
      PGDATABASE: parts.database,
      PGHOST: parts.host,
      ...(parts.password === null ? {} : { PGPASSWORD: parts.password }),
      PGPORT: parts.port,
      PGUSER: parts.user,
      ...tlsEnv,
    },
  };
};

/** PG* variables for pg_dump / pg_restore, so no credential is on a command line. */
export const toPgEnvironment = (url, env = process.env) => resolveBackupConnection(url, env).pgEnv;

/**
 * `url` with every part a connection takes from it spelled out (host or
 * socket, port, user, database; its query kept), for the app code verify runs
 * in process: node-pg fills a part a connection string leaves out from the
 * shell's PG* variables, which must not send the health probe to another
 * server than the inventory read.
 */
export const toCanonicalDatabaseUrl = (url) => {
  const parts = resolveConnectionParts(url);
  const parsed = new URL(url);
  const canonical = new URL("postgresql://localhost");

  if (!parsed.searchParams.get("host")) {
    canonical.hostname = parts.host.includes(":") ? `[${parts.host}]` : parts.host;
  }

  canonical.port = parts.port;
  canonical.username = encodeURIComponent(parts.user);

  if (parts.password !== null) {
    canonical.password = encodeURIComponent(parts.password);
  }

  canonical.pathname = `/${encodeURIComponent(parts.database)}`;

  for (const [key, value] of parsed.searchParams) {
    canonical.searchParams.append(key, value);
  }

  return canonical.href;
};

const quoteIdentifier = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** An unconnected pg.Client for `connection` (resolveBackupConnection), built with PG* hidden. */
export const createBackupClient = (connection) => withoutPgVariables(() => new pg.Client(connection.clientConfig));

const connect = async (connection) => {
  const client = createBackupClient(connection);

  await client.connect();
  return client;
};

const runProcess = (command, args, { env = {}, stdio = ["ignore", "pipe", "pipe"] } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // The PG* variables of the caller's own shell must not decide which
      // database a backup reads or a restore overwrites.
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
        ...env,
      },
      stdio,
    });
    let stderr = "";

    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr });
      } else {
        reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim().slice(-2000)}`));
      }
    });
  });

// A command's standard output (pg_restore --list), with no database access.
const captureProcess = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim()}`))
    );
  });

const readToolVersion = async (command) =>
  new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(output.trim() || null));
  });

export const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });

// ---------------------------------------------------------------------------
// The inventory: what the manifest records and verify compares
// ---------------------------------------------------------------------------

const tableExists = async (client, table) =>
  Boolean(
    (await client.query("SELECT to_regclass(format('%I.%I', current_schema(), $1::text)) AS relation", [table]))
      .rows[0]?.relation
  );

const columnExists = async (client, table, column) =>
  (
    await client.query(
      `SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = to_regclass(format('%I.%I', current_schema(), $1::text))
         AND attname = $2 AND attnum > 0 AND NOT attisdropped`,
      [table, column]
    )
  ).rows.length > 0;

// The application's tables: every ordinary or partitioned table of the
// current schema that no extension owns.
const listTables = async (client) =>
  (
    await client.query(`
      SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
        )
      ORDER BY c.relname
    `)
  ).rows.map((row) => String(row.relname));

/**
 * Applied migrations, every table's row count, per-tenant document counts
 * (active and in the trash, migration 042) and the head of every admin audit
 * chain (migration 041), read on `client` (inside the backup's snapshot, or
 * on the restored database).
 */
export const readDatabaseInventory = async (
  client,
  { auditTable = "rag_admin_audit_events", documentsTable = "rag_documents" } = {}
) => {
  const migrations = (await tableExists(client, "schema_migrations"))
    ? (await client.query("SELECT id FROM schema_migrations ORDER BY id")).rows.map((row) => String(row.id))
    : [];
  const tables = {};

  for (const table of await listTables(client)) {
    tables[table] = Number(
      (await client.query(`SELECT COUNT(*)::bigint AS n FROM ${quoteIdentifier(table)}`)).rows[0].n
    );
  }

  let tenants = [];

  if (IDENTIFIER.test(documentsTable) && (await tableExists(client, documentsTable))) {
    const trash = await columnExists(client, documentsTable, "deleted_at");

    tenants = (
      await client.query(`
        SELECT owner_user_id, workspace_id,
               COUNT(*) ${trash ? "FILTER (WHERE deleted_at IS NULL)" : ""}::bigint AS documents,
               ${trash ? "COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)" : "0"}::bigint AS trashed_documents,
               COALESCE(SUM(file_size), 0)::bigint AS document_bytes
        FROM ${quoteIdentifier(documentsTable)}
        GROUP BY owner_user_id, workspace_id
        ORDER BY owner_user_id, workspace_id
      `)
    ).rows.map((row) => ({
      documentBytes: Number(row.document_bytes),
      documents: Number(row.documents),
      ownerUserId: String(row.owner_user_id),
      trashedDocuments: Number(row.trashed_documents),
      workspaceId: String(row.workspace_id),
    }));
  }

  let auditChains = [];

  if (
    IDENTIFIER.test(auditTable) &&
    (await tableExists(client, auditTable)) &&
    (await columnExists(client, auditTable, "row_hash"))
  ) {
    // A chain is one workspace's events, or one user's without a workspace
    // (rag/admin-audit-chain.js getAdminAuditChainOwner).
    auditChains = (
      await client.query(`
        SELECT DISTINCT ON (chain_workspace, chain_user)
               chain_workspace, chain_user, id, row_hash
        FROM (
          SELECT id, row_hash, btrim(workspace_id) AS chain_workspace,
                 CASE WHEN btrim(workspace_id) = '' THEN btrim(user_id) ELSE '' END AS chain_user
          FROM ${quoteIdentifier(auditTable)}
          WHERE row_hash IS NOT NULL
        ) AS chained
        ORDER BY chain_workspace, chain_user, id DESC
      `)
    ).rows.map((row) => ({
      headHash: String(row.row_hash),
      lastId: Number(row.id),
      userId: String(row.chain_user),
      workspaceId: String(row.chain_workspace),
    }));
  }

  return { auditChains, migrations, tables, tenants };
};

// The table names the application uses, from the same environment the app
// reads (no .env file).
const loadTableNames = async () => {
  const config = await import("./rag/config.js");

  return {
    auditTable: config.getAdminAuditEventsPostgresTable(),
    documentsTable: config.getDocumentsPostgresTable(),
  };
};

// The roles the row policies name: the tenant role is the one migration 013's
// tenant_isolation policies apply to, the system role the one of migration
// 035's system_access policies (read from the database, so a deployment with
// its own POSTGRES_TENANT_ROLE needs no setting here); the configured names
// only when the policies do not say.
const readRoles = async (client) => {
  const config = await import("./rag/config.js");
  const rows = (
    await client.query(`
      SELECT DISTINCT policyname, role_name
      FROM pg_catalog.pg_policies, unnest(roles) AS role_name
      WHERE schemaname = current_schema() AND role_name <> 'public'
      ORDER BY policyname, role_name
    `)
  ).rows.map((row) => ({ policy: String(row.policyname), role: String(row.role_name) }));
  const only = (policy) => {
    const names = [...new Set(rows.filter((row) => row.policy === policy).map((row) => row.role))];

    return names.length === 1 ? names[0] : null;
  };

  return {
    policyRoles: [...new Set(rows.map((row) => row.role))].sort(),
    system: only("system_access") ?? config.getPostgresSystemRole(),
    tenant: only("tenant_isolation") ?? config.getPostgresTenantRole(),
  };
};

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

const formatStamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

// The on-disk state outside PostgreSQL, each directory stored under its own
// name (uploads, upload-sessions, data by default) so the archive unpacks
// next to the server directory it came from.
const resolveFileSources = (options) => ({
  data: path.resolve(options.dataDir ?? path.join(SERVER_DIRECTORY, "data")),
  uploadSessions: path.resolve(
    options.uploadSessionsDir ?? process.env.UPLOAD_SESSION_DIRECTORY ?? path.join(SERVER_DIRECTORY, "upload-sessions")
  ),
  uploads: path.resolve(options.uploadsDir ?? process.env.UPLOADS_DIRECTORY ?? path.join(SERVER_DIRECTORY, "uploads")),
});

// The keystore and master key a backup leaves out by path: the flags, else
// the settings in the environment, else their defaults under the data root.
const resolveKeyMaterialPaths = (options) => {
  const configured = resolveLocalKmsPaths();

  return {
    keystoreDirectory: options.keystoreDir ? path.resolve(options.keystoreDir) : configured.keystoreDirectory,
    masterKeyFile: options.kmsMasterKeyFile ? path.resolve(options.kmsMasterKeyFile) : configured.masterKeyFile,
  };
};

const KEY_MATERIAL_FORMATS = new Set(Object.values(LOCAL_KMS_FILE_FORMATS));

// The local KMS format a file's JSON names, or null: only regular files of
// at most `maxBytes` whose first byte is "{" are read whole.
const readKeyMaterialFormat = async (filePath, maxBytes) => {
  let handle;

  try {
    handle = await open(filePath, "r");

    const { size } = await handle.stat();

    if (size === 0 || size > maxBytes) {
      return null;
    }

    const first = Buffer.alloc(1);

    await handle.read(first, 0, 1, 0);

    if (first[0] !== 0x7b) {
      return null;
    }

    // From the same handle, so a file that grew since the size check is not
    // read past it.
    const parsed = JSON.parse(await handle.readFile("utf8"));

    return typeof parsed?.format === "string" && KEY_MATERIAL_FORMATS.has(parsed.format) ? parsed.format : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
};

/**
 * The files under `sources` that hold local KMS key material by their
 * content (a key file, a destroyed key's tombstone, a key file's temp copy,
 * the master key), wherever they lie and whatever their name, as tar member
 * paths (each source under its own name) with the format found: { file,
 * format }. Symbolic links are archived as links and not followed.
 */
export const findKeyMaterialFiles = async (sources, { maxBytes = KEY_MATERIAL_SCAN_MAX_BYTES } = {}) => {
  const found = [];
  const visit = async (directory, member) => {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return;
      }

      throw error;
    }

    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const filePath = path.join(directory, entry.name);
      const memberPath = `${member}/${entry.name}`;

      if (entry.isDirectory()) {
        await visit(filePath, memberPath);
      } else if (entry.isFile()) {
        const format = await readKeyMaterialFormat(filePath, maxBytes);

        if (format) {
          found.push({ file: memberPath, format });
        }
      }
    }
  };

  for (const source of sources) {
    await visit(source, path.basename(source));
  }

  return found;
};

// An exact member path as a tar --exclude pattern (GNU tar and bsdtar both
// read wildcards there; a backslash quotes one).
const toExactTarPattern = (member) => member.replace(/[\\*?[]/g, "\\$&");

// A new file only this login can read, which pg_dump and tar then write into
// (they truncate it and keep its mode).
const createPrivateFile = async (filePath) => {
  const handle = await open(filePath, "wx", 0o600);

  await handle.close();
};

const writeFilesArchive = async ({ archivePath, options, tar }) => {
  const sources = Object.values(resolveFileSources(options));
  const present = sources.filter((source) => existsSync(source));
  // The tenant keystore and the local KMS master key stay out (see the
  // header): by path when they lie inside one of the directories, by name
  // everywhere, and by content.
  const { keystoreDirectory, masterKeyFile } = resolveKeyMaterialPaths(options);
  const excluded = [
    ...present.flatMap((source) =>
      [keystoreDirectory, masterKeyFile].flatMap((keyPath) => {
        const relative = path.relative(source, keyPath);

        return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
          ? [path.join(path.basename(source), relative)]
          : [];
      })
    ),
    ...KEY_MATERIAL_EXCLUDE_PATTERNS,
  ];

  if (present.length === 0) {
    return { excluded, included: [], keyMaterialExcluded: [], missing: sources };
  }

  const keyMaterialExcluded = await findKeyMaterialFiles(present);

  await createPrivateFile(archivePath);
  await runProcess(tar, [
    "-czf",
    archivePath,
    ...excluded.map((pattern) => `--exclude=${pattern}`),
    ...keyMaterialExcluded.map(({ file }) => `--exclude=${toExactTarPattern(file)}`),
    ...present.flatMap((source) => ["-C", path.dirname(source), path.basename(source)]),
  ]);

  return {
    bytes: (await stat(archivePath)).size,
    excluded,
    file: path.basename(archivePath),
    included: present,
    keyMaterialExcluded,
    missing: sources.filter((source) => !present.includes(source)),
    sha256: await sha256File(archivePath),
  };
};

export const runBackup = async (options, { log = (line) => process.stderr.write(`${line}\n`) } = {}) => {
  const databaseUrl = resolveDatabaseUrl(options);
  const connection = resolveBackupConnection(databaseUrl);
  const pgDump = options.pgDump ?? process.env.PG_DUMP ?? "pg_dump";
  const outDirectory = path.resolve(options.out ?? path.join(SERVER_DIRECTORY, "backups"));
  const createdAt = new Date();
  const base = options.name ?? `archive-rag-${formatStamp(createdAt)}`;
  const dumpPath = path.join(outDirectory, `${base}.dump`);
  const manifestPath = path.join(outDirectory, `${base}.manifest.json`);

  if (existsSync(dumpPath) || existsSync(manifestPath)) {
    throw new Error(`${dumpPath} or its manifest already exists; pick another --name or --out.`);
  }

  // 0700 for every directory this creates; one that exists is the operator's.
  // The dump file is created 0600 before pg_dump writes into it, and removed
  // again when this run cannot finish it.
  await mkdir(outDirectory, { mode: 0o700, recursive: true });
  await createPrivateFile(dumpPath);

  let inventory;
  let roles;
  let serverVersion;
  let snapshot;
  let tableNames;

  try {
    tableNames = await loadTableNames();
    const client = await connect(connection);

    try {
      // One snapshot for the dump and the inventory: the counts are the dump's.
      // row_security off, as pg_dump sets it: a login the row policies would
      // filter gets an error instead of short counts.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL row_security = off");
      snapshot = String((await client.query("SELECT pg_export_snapshot() AS id")).rows[0].id);
      serverVersion = String((await client.query("SHOW server_version")).rows[0].server_version);
      log(`[backup] dumping ${JSON.stringify(describeDatabaseUrl(databaseUrl))} to ${dumpPath}`);

      const dump = runProcess(
        pgDump,
        ["--format=custom", `--snapshot=${snapshot}`, `--file=${dumpPath}`, "--no-password"],
        { env: connection.pgEnv }
      );

      [inventory, roles] = await Promise.all([readDatabaseInventory(client, tableNames), readRoles(client)]);
      await dump;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  } catch (error) {
    await rm(dumpPath, { force: true }).catch(() => {});
    throw error;
  }

  const dumpStat = await stat(dumpPath);
  const files = options.withFiles
    ? await writeFilesArchive({
        archivePath: path.join(outDirectory, `${base}.files.tar.gz`),
        options,
        tar: options.tar ?? process.env.TAR ?? "tar",
      })
    : null;
  const manifest = {
    createdAt: createdAt.toISOString(),
    database: { ...describeDatabaseUrl(databaseUrl), serverVersion },
    dump: {
      bytes: dumpStat.size,
      file: path.basename(dumpPath),
      format: "custom",
      pgDumpVersion: await readToolVersion(pgDump),
      sha256: await sha256File(dumpPath),
      snapshot,
    },
    files,
    format: BACKUP_MANIFEST_FORMAT,
    notIncluded: [
      "the tenant keystore (TENANT_KEYSTORE_DIR) and the local KMS master key (TENANT_KMS_MASTER_KEY_FILE): kept out of every backup on purpose, so erasing a tenant's key makes its bytes in old backups unreadable; back it up separately or not at all",
      "server/.env and every other secret",
      "role passwords and role memberships (cluster-wide; the restore recreates the NOLOGIN roles the policies name)",
      "Redis shared state and in-process caches (rebuilt at run time)",
    ],
    roles,
    tableNames,
    ...inventory,
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  log(`[backup] wrote ${manifestPath}`);

  return { dumpPath, manifest, manifestPath };
};

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export const defaultManifestPath = (dumpPath) =>
  dumpPath.endsWith(".dump") ? `${dumpPath.slice(0, -".dump".length)}.manifest.json` : `${dumpPath}.manifest.json`;

const readManifest = async (manifestPath) => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  if (manifest?.format !== BACKUP_MANIFEST_FORMAT) {
    throw new Error(`${manifestPath} is not an ${BACKUP_MANIFEST_FORMAT} manifest.`);
  }

  return manifest;
};

// Relations of the target that the restore would collide with: anything in a
// non-system schema that no extension owns.
const countTargetRelations = async (client) =>
  Number(
    (
      await client.query(`
        SELECT COUNT(*)::int AS n
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend d
            WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
          )
      `)
    ).rows[0].n
  );

const validRoleNames = (manifest) =>
  [
    ...new Set([
      ...(manifest.roles?.policyRoles ?? []),
      manifest.roles?.tenant,
      manifest.roles?.system,
    ]),
  ].filter((role) => typeof role === "string" && IDENTIFIER.test(role));

export const runRestore = async (options, { log = (line) => process.stderr.write(`${line}\n`) } = {}) => {
  const databaseUrl = resolveDatabaseUrl(options);
  const connection = resolveBackupConnection(databaseUrl);
  const pgRestore = options.pgRestore ?? process.env.PG_RESTORE ?? "pg_restore";

  if (!options.dump) {
    throw new Error("restore needs --dump <file>.");
  }

  const dumpPath = path.resolve(options.dump);
  const manifestPath = path.resolve(options.manifest ?? defaultManifestPath(dumpPath));
  const manifest = await readManifest(manifestPath);
  const checksum = await sha256File(dumpPath);

  if (checksum !== manifest.dump?.sha256) {
    throw new Error(
      `${dumpPath} does not match its manifest (sha256 ${checksum}, manifest ${manifest.dump?.sha256}); refusing to restore it.`
    );
  }

  const target = describeDatabaseUrl(databaseUrl);
  const roles = validRoleNames(manifest);
  // The dump's table of contents (read from the file, no database), and the
  // extensions it creates.
  const toc = (await captureProcess(pgRestore, ["--list", dumpPath])).split("\n");
  const extensions = [
    ...new Set(
      toc
        .map((line) => /^\d+;\s+\d+\s+\d+\s+EXTENSION\s+-\s+(\S+)/.exec(line)?.[1])
        .filter((name) => name && IDENTIFIER.test(name))
    ),
  ];
  const client = await connect(connection);

  try {
    const relations = await countTargetRelations(client);
    const existingRoles = new Set(
      (await client.query("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])", [roles])).rows.map(
        (row) => String(row.rolname)
      )
    );
    const missingRoles = roles.filter((role) => !existingRoles.has(role));
    const plan = [
      `[restore] target: ${JSON.stringify(target)} (${relations} relation(s) present)`,
      `[restore] dump: ${dumpPath} (${manifest.dump.bytes} bytes, sha256 ${checksum}, taken ${manifest.createdAt} from ${JSON.stringify(manifest.database)})`,
      `[restore] ${manifest.migrations.length} migration(s), ${Object.keys(manifest.tables).length} table(s), ${manifest.tenants.length} document owner(s) in the manifest`,
      missingRoles.length > 0
        ? `[restore] will create NOLOGIN role(s): ${missingRoles.join(", ")}`
        : "[restore] every role the row policies name exists already",
      `[restore] will create extension(s) if missing: ${extensions.join(", ") || "none"}`,
      `[restore] will run pg_restore --no-owner --exit-on-error --single-transaction${options.force ? " --clean --if-exists (replaces the target's objects)" : ""}`,
      `[restore] will grant ${manifest.roles?.tenant ?? "the tenant role"} to the restoring login (migration 013's grant; the role split's runtime login is granted by the migrator at start-up)`,
    ];

    for (const line of plan) {
      log(line);
    }

    if (relations > 0 && !options.force) {
      throw Object.assign(
        new Error(
          `The target database already holds ${relations} relation(s); refusing to restore into it. Restore into an empty database, or pass --force to replace its objects.`
        ),
        { exitCode: 3 }
      );
    }

    if (options.dryRun) {
      log("[restore] --dry-run: nothing was changed.");
      return { dryRun: true, plan };
    }

    for (const role of missingRoles) {
      try {
        await client.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN`);
      } catch (error) {
        if (error?.code === "42501") {
          throw new Error(
            `The restoring login may not create role "${role}". Create it as a role administrator first (CREATE ROLE ${role} NOLOGIN;), then run the restore again.`
          );
        }

        if (error?.code !== "42710") {
          throw error;
        }
      }
    }

    // The dump's extensions (pgvector) are created before the restore, here,
    // and their entries left out of it: CREATE, DROP (--clean) and COMMENT ON
    // EXTENSION need a superuser or the extension's owner, which the
    // restoring login usually is not.
    for (const extension of extensions) {
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)}`);
      } catch (error) {
        throw new Error(
          `The target has no ${extension} extension and the restoring login may not create it (${error?.code ?? error?.name}). A superuser runs CREATE EXTENSION ${extension}; in the target database first.`
        );
      }
    }
  } finally {
    await client.end();
  }

  const listDirectory = await mkdtemp(path.join(os.tmpdir(), "archive-rag-restore-"));
  const listPath = path.join(listDirectory, "toc.list");

  try {
    await writeFile(listPath, toc.filter((line) => !EXTENSION_TOC_ENTRY.test(line)).join("\n"));
    await runProcess(
      pgRestore,
      [
        "--no-owner",
        "--exit-on-error",
        "--single-transaction",
        "--no-password",
        ...(options.force ? ["--clean", "--if-exists"] : []),
        `--use-list=${listPath}`,
        `--dbname=${connection.pgEnv.PGDATABASE}`,
        dumpPath,
      ],
      { env: connection.pgEnv }
    );
  } finally {
    await rm(listDirectory, { force: true, recursive: true });
  }

  const grantClient = await connect(connection);

  try {
    const tenantRole = manifest.roles?.tenant;

    if (typeof tenantRole === "string" && IDENTIFIER.test(tenantRole)) {
      const versionNumber = Number((await grantClient.query("SHOW server_version_num")).rows[0].server_version_num);
      const member = (
        await grantClient.query("SELECT pg_has_role(current_user, $1, $2) AS ok", [
          tenantRole,
          versionNumber >= 160000 ? "SET" : "MEMBER",
        ])
      ).rows[0].ok;

      if (!member) {
        try {
          await grantClient.query(
            `GRANT ${quoteIdentifier(tenantRole)} TO CURRENT_USER${versionNumber >= 160000 ? " WITH SET TRUE" : ""}`
          );
        } catch (error) {
          log(
            `[restore] could not grant ${tenantRole} to the restoring login (${error?.code ?? error?.name}); a role administrator runs: GRANT ${tenantRole} TO <login> WITH SET TRUE;`
          );
        }
      }
    }
  } finally {
    await grantClient.end();
  }

  log(`[restore] restored ${dumpPath} into ${JSON.stringify(target)}`);
  return { dryRun: false, plan: null };
};

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

const compareCounts = (expected = {}, actual = {}) => {
  const mismatches = [];

  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[key] !== actual[key]) {
      mismatches.push({ actual: actual[key] ?? null, expected: expected[key] ?? null, table: key });
    }
  }

  return mismatches;
};

const tenantKey = (tenant) => JSON.stringify([tenant.ownerUserId, tenant.workspaceId]);
const chainKey = (chain) => JSON.stringify([chain.workspaceId, chain.userId]);

// A file the manifest names (a bare file name) in the manifest's directory,
// or null when the name is not a bare file name or nothing is there.
const findNextToManifest = (manifestPath, fileName) => {
  if (typeof fileName !== "string" || !fileName || path.basename(fileName) !== fileName) {
    return null;
  }

  const candidate = path.join(path.dirname(manifestPath), fileName);

  return existsSync(candidate) ? candidate : null;
};

const checksumCheck = async (filePath, expected) => {
  const checksum = await sha256File(filePath);

  return { ok: checksum === expected, actual: checksum, expected: expected ?? null, file: path.basename(filePath) };
};

export const runVerify = async (options, { log = (line) => process.stderr.write(`${line}\n`) } = {}) => {
  const databaseUrl = resolveDatabaseUrl(options);
  const connection = resolveBackupConnection(databaseUrl);

  if (!options.manifest) {
    throw new Error("verify needs --manifest <file>.");
  }

  const manifestPath = path.resolve(options.manifest);
  const manifest = await readManifest(manifestPath);
  const checks = {};
  // The dump: the one given, else the one the manifest names next to it; the
  // files archive when it lies next to the manifest. Absent files are not
  // checked (a drill may restore from a copy elsewhere).
  const dumpPath = options.dump ? path.resolve(options.dump) : findNextToManifest(manifestPath, manifest.dump?.file);
  const filesPath = manifest.files?.file ? findNextToManifest(manifestPath, manifest.files.file) : null;

  if (dumpPath) {
    checks.dumpChecksum = await checksumCheck(dumpPath, manifest.dump?.sha256);
  }

  if (filesPath) {
    checks.filesChecksum = await checksumCheck(filesPath, manifest.files.sha256);
  }

  // The application code reads the restored database from here on, as the
  // owner login with row-level security enforced and the manifest's roles.
  Object.assign(process.env, {
    POSTGRES_DATABASE_URL: toCanonicalDatabaseUrl(databaseUrl),
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    ...(manifest.roles?.tenant ? { POSTGRES_TENANT_ROLE: manifest.roles.tenant } : {}),
    ...(manifest.roles?.system ? { POSTGRES_SYSTEM_ROLE: manifest.roles.system } : {}),
    ...(manifest.tableNames?.auditTable ? { ADMIN_AUDIT_EVENTS_POSTGRES_TABLE: manifest.tableNames.auditTable } : {}),
    ...(manifest.tableNames?.documentsTable ? { DOCUMENTS_POSTGRES_TABLE: manifest.tableNames.documentsTable } : {}),
  });
  delete process.env.POSTGRES_MIGRATION_DATABASE_URL;
  delete process.env.LONG_MEMORY_DATABASE_URL;

  const client = await connect(connection);
  let inventory;

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL row_security = off");
    inventory = await readDatabaseInventory(client, manifest.tableNames ?? {});
    await client.query("COMMIT");
  } finally {
    await client.end();
  }

  const codeMigrations = (await readdir(MIGRATIONS_DIRECTORY)).filter((name) => /^\d+.*\.sql$/i.test(name)).sort();
  const applied = new Set(inventory.migrations);
  const pending = codeMigrations.filter((name) => !applied.has(name));
  const unknown = inventory.migrations.filter((name) => !codeMigrations.includes(name));

  checks.migrations = {
    ok:
      unknown.length === 0 &&
      (pending.length === 0 || options.allowPendingMigrations === true) &&
      JSON.stringify(inventory.migrations) === JSON.stringify(manifest.migrations),
    applied: inventory.migrations.length,
    differsFromManifest: JSON.stringify(inventory.migrations) !== JSON.stringify(manifest.migrations),
    pending,
    unknown,
  };

  const tableMismatches = compareCounts(manifest.tables, inventory.tables);

  checks.rowCounts = { ok: tableMismatches.length === 0, mismatches: tableMismatches, tables: Object.keys(inventory.tables).length };

  const expectedTenants = new Map(manifest.tenants.map((tenant) => [tenantKey(tenant), tenant]));
  const actualTenants = new Map(inventory.tenants.map((tenant) => [tenantKey(tenant), tenant]));
  const tenantMismatches = [...new Set([...expectedTenants.keys(), ...actualTenants.keys()])]
    .filter((key) => JSON.stringify(expectedTenants.get(key) ?? null) !== JSON.stringify(actualTenants.get(key) ?? null))
    .map((key) => ({ actual: actualTenants.get(key) ?? null, expected: expectedTenants.get(key) ?? null }));

  checks.tenantDocuments = { ok: tenantMismatches.length === 0, mismatches: tenantMismatches, owners: actualTenants.size };

  // Row-level security as the health report checks it. It runs the
  // migrations first, so it waits for the migration check and runs only when
  // none is pending: a restored database is never migrated behind the
  // operator's back. With --allow-pending-migrations and migrations pending
  // it is skipped (the operator accepted an older schema; the check would
  // migrate it).
  if (checks.migrations.ok && pending.length === 0) {
    const { checkRowLevelSecurityHealth } = await import("./health.js");
    const { runAsDatabaseSystem } = await import("./rag/postgres-tenant.js");
    const entry = await runAsDatabaseSystem(() => checkRowLevelSecurityHealth());

    checks.rowLevelSecurity = { ok: entry.status !== "error", message: entry.message ?? null, status: entry.status };
  } else if (checks.migrations.ok) {
    checks.rowLevelSecurity = { ok: true, skipped: "pending_migrations", status: null };
    log(`[verify] rowLevelSecurity skipped: ${pending.length} migration(s) pending, and the check would apply them.`);
  } else {
    checks.rowLevelSecurity = { ok: false, skipped: "migrations_not_verified", status: null };
  }

  // The admin audit chains with audit:verify's own code (in process: the
  // command itself would read server/.env), over a store that does not run
  // the migrations, and each chain's head against the manifest, which also
  // catches rows lost from a chain's end.
  const { runAuditVerifyCommand } = await import("./audit-verify.mjs");
  const { createPostgresAdminAuditStore } = await import("./rag/postgres-admin-audit-store.js");
  const audit = await runAuditVerifyCommand(["--json"], {
    createStore: () => createPostgresAdminAuditStore({ runMigrations: async () => ({ appliedMigrations: [] }) }),
    write: () => {},
  });
  const restoredHeads = new Map(inventory.auditChains.map((chain) => [chainKey(chain), chain]));
  const headMismatches = (manifest.auditChains ?? [])
    .filter((chain) => {
      const restored = restoredHeads.get(chainKey(chain));

      return !restored || restored.headHash !== chain.headHash || restored.lastId !== chain.lastId;
    })
    .map((chain) => ({ expected: chain, restored: restoredHeads.get(chainKey(chain)) ?? null }));

  checks.auditChains = {
    ok: audit?.status === "ok" && headMismatches.length === 0 && restoredHeads.size === (manifest.auditChains ?? []).length,
    brokenChains: audit?.brokenChainCount ?? null,
    chains: audit?.chainCount ?? null,
    headMismatches,
    status: audit?.status ?? null,
  };

  const { resetPostgresPool } = await import("./rag/postgres.js");

  await resetPostgresPool();

  const ok = Object.values(checks).every((check) => check.ok === true);
  const report = { checks, manifest: manifestPath, ok, target: describeDatabaseUrl(databaseUrl) };

  log(`[verify] ${ok ? "OK" : "FAILED"}: ${Object.entries(checks).map(([name, check]) => `${name}=${check.ok ? "ok" : "failed"}`).join(" ")}`);
  return report;
};

// ---------------------------------------------------------------------------

const COMMANDS = { backup: runBackup, restore: runRestore, verify: runVerify };

export const runBackupToolsCommand = async (argv) => {
  const options = parseBackupArgs(argv);

  if (options.help || !COMMANDS[options.command]) {
    process.stdout.write(USAGE);
    return options.help ? 0 : 2;
  }

  const result = await COMMANDS[options.command](options);

  if (options.command === "verify") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  if (options.command === "backup") {
    process.stdout.write(`${JSON.stringify({ dump: result.dumpPath, manifest: result.manifestPath }, null, 2)}\n`);
  }

  return 0;
};

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runBackupToolsCommand(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
    });
}
