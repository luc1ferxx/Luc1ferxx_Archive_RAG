// Bulk work on the stored tenant file bytes (npm run tenant:keys, tenant
// isolation phase 5): how many are envelopes, encrypting the legacy
// plaintext ones (`encrypt-existing`), and moving envelopes' data keys to
// their tenant key's newest version without re-encrypting the payload
// (`rewrap`).
//
// Covered: rag_documents.file_bytes, rag_ingest_jobs.file_bytes and the
// staged outputs' payload (rag_ingest_jobs_outputs), in PostgreSQL. Not
// covered: the standalone profile's file-backed registry (its files are
// encrypted when a document is written again, and read either way) and
// upload session chunks (they expire with their session).
//
// Every statement runs as the system (runAsDatabaseSystem): with the role
// split on, the system role may update these tables (migration 035). Rows
// are listed by key in pages, then each is changed in its own short
// transaction that locks it FOR UPDATE SKIP LOCKED and re-checks it, so a
// writer holding the row is skipped (and counted) rather than waited for, and
// a rerun picks it up. An ingest job that is running is skipped too, and so
// are the outputs of one: its worker reads them in slices across statements,
// and a change between two slices would hand it half of each form; locking
// the job row keeps a claim from starting it while its bytes change.
import { createHash } from "node:crypto";

import {
  getDocumentsPostgresTable,
  getIngestJobOutputsPostgresTable,
  getIngestJobsPostgresTable,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import {
  queryPostgres as queryDefaultPostgres,
  withPostgresTransaction as withDefaultPostgresTransaction,
} from "./postgres.js";
import { isTenantEncryptionError } from "./kms/index.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";
import {
  TENANT_ENVELOPE_MAGIC,
  documentFileContext,
  encryptTenantBytes,
  ingestJobFileContext,
  ingestJobOutputContext,
  isTenantEnvelope,
  rewrapTenantEnvelope,
} from "./tenant-encryption.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAGIC_LENGTH = TENANT_ENVELOPE_MAGIC.length;

const assertTableName = (name, variable) => {
  if (!TABLE_NAME_PATTERN.test(String(name ?? ""))) {
    throw new Error(`${variable} must be a simple PostgreSQL identifier. Received "${name}".`);
  }

  return name;
};

/**
 * The tables holding tenant file bytes, in the order the CLI walks them.
 * `running` is an SQL expression over alias `t` (true for bytes a running
 * ingest attempt may be reading); `lockJoin` the job row locked with it.
 */
export const describeTenantFileTables = ({
  getDocumentsTable = getDocumentsPostgresTable,
  getJobsTable = getIngestJobsPostgresTable,
  getOutputsTable = getIngestJobOutputsPostgresTable,
} = {}) => {
  const documents = assertTableName(getDocumentsTable(), "DOCUMENTS_POSTGRES_TABLE");
  const jobs = assertTableName(getJobsTable(), "INGEST_JOBS_POSTGRES_TABLE");
  const outputs = assertTableName(getOutputsTable(), "INGEST_JOBS_POSTGRES_TABLE");

  return [
    {
      column: "file_bytes",
      contextFor: (row) =>
        documentFileContext({ docId: row.doc_id, userId: row.owner_user_id, workspaceId: row.workspace_id }),
      hashColumn: "content_sha256",
      keyColumns: ["doc_id"],
      lockFrom: `${documents} AS t`,
      lockOf: "t",
      name: "documents",
      running: "false",
      table: documents,
    },
    {
      column: "file_bytes",
      contextFor: (row) =>
        ingestJobFileContext({ jobId: row.job_id, userId: row.owner_user_id, workspaceId: row.workspace_id }),
      keyColumns: ["job_id"],
      lockFrom: `${jobs} AS t`,
      lockOf: "t",
      name: "ingest_jobs",
      running: "t.status = 'running'",
      table: jobs,
    },
    {
      column: "payload",
      contextFor: (row) =>
        ingestJobOutputContext({
          jobId: row.job_id,
          output: row.output,
          userId: row.owner_user_id,
          workspaceId: row.workspace_id,
        }),
      keyColumns: ["job_id", "output"],
      lockFrom: `${outputs} AS t JOIN ${jobs} AS j ON j.job_id = t.job_id`,
      lockOf: "t, j",
      name: "ingest_job_outputs",
      running: "j.status = 'running'",
      table: outputs,
    },
  ];
};

const keyMatch = (spec, offset = 0) =>
  spec.keyColumns.map((column, index) => `t.${column} = $${offset + index + 1}`).join(" AND ");

/**
 * Per table: rows holding an envelope, rows holding plaintext (null bytes are
 * neither). Reads the first bytes of every row; for the CLI's status.
 */
export const countTenantFileEncryption = async ({
  queryPostgres = queryDefaultPostgres,
  runMigrations = runPostgresMigrations,
  tables = describeTenantFileTables(),
} = {}) =>
  runAsDatabaseSystem(async () => {
    await runMigrations();

    const counts = {};

    for (const spec of tables) {
      const result = await queryPostgres(
        `
          SELECT
            COUNT(*) FILTER (WHERE substring(${spec.column} FROM 1 FOR ${MAGIC_LENGTH}) = $1::bytea)::int AS encrypted,
            COUNT(*) FILTER (
              WHERE ${spec.column} IS NOT NULL
                AND substring(${spec.column} FROM 1 FOR ${MAGIC_LENGTH}) <> $1::bytea
            )::int AS plaintext
          FROM ${spec.table}
        `,
        [TENANT_ENVELOPE_MAGIC]
      );

      counts[spec.name] = {
        encrypted: Number(result.rows[0]?.encrypted) || 0,
        plaintext: Number(result.rows[0]?.plaintext) || 0,
      };
    }

    return counts;
  });

// The keys of the rows to visit, a page at a time: plaintext rows for
// `encrypt`, envelopes for `rewrap`.
async function* listCandidateKeys({ batchSize, mode, queryPostgres, spec }) {
  let after = null;

  for (;;) {
    const values = [TENANT_ENVELOPE_MAGIC];
    const keyset = after
      ? ` AND (${spec.keyColumns.map((column) => `t.${column}`).join(", ")}) > (${after
          .map((value) => {
            values.push(value);
            return `$${values.length}`;
          })
          .join(", ")})`
      : "";

    values.push(batchSize);

    const result = await queryPostgres(
      `
        SELECT ${spec.keyColumns.map((column) => `t.${column}`).join(", ")}
        FROM ${spec.table} AS t
        WHERE t.${spec.column} IS NOT NULL
          AND substring(t.${spec.column} FROM 1 FOR ${MAGIC_LENGTH}) ${mode === "encrypt" ? "<>" : "="} $1::bytea${keyset}
        ORDER BY ${spec.keyColumns.map((column) => `t.${column}`).join(", ")}
        LIMIT $${values.length}
      `,
      values
    );
    const rows = result?.rows ?? [];

    for (const row of rows) {
      yield spec.keyColumns.map((column) => row[column]);
    }

    if (rows.length < batchSize) {
      return;
    }

    after = spec.keyColumns.map((column) => rows[rows.length - 1][column]);
  }
}

// One row in its own transaction: { outcome } changed | unchanged | locked |
// running | gone. A dry run reads the row without locking it and writes
// nothing (`changed` then means it would change).
const processRow = async ({ apply, key, mode, spec, withPostgresTransaction }) =>
  withPostgresTransaction(async (client) => {
    const locked = await client.query(
      `
        SELECT t.*, (${spec.running}) AS archive_rag_running
        FROM ${spec.lockFrom}
        WHERE ${keyMatch(spec)}
        ${apply ? `FOR UPDATE OF ${spec.lockOf} SKIP LOCKED` : ""}
      `,
      key
    );
    const row = locked.rows[0];

    if (!row) {
      return { outcome: "locked" };
    }

    if (row.archive_rag_running === true) {
      return { outcome: "running" };
    }

    const stored = row[spec.column];

    if (stored === null || stored === undefined) {
      return { outcome: "gone" };
    }

    const context = spec.contextFor(row);
    let next = null;
    let plaintextHash = null;

    if (mode === "encrypt") {
      if (isTenantEnvelope(stored)) {
        return { outcome: "unchanged" };
      }

      plaintextHash = spec.hashColumn ? createHash("sha256").update(stored).digest("hex") : null;
      next = apply ? await encryptTenantBytes(stored, context) : null;
    } else {
      // Unwraps with the old version and wraps with the current one in
      // memory; only an applied run writes the new header. An envelope that
      // cannot be unwrapped (a destroyed key, a changed byte) is counted, not
      // fatal: the others still move.
      let rewrapped;

      try {
        rewrapped = await rewrapTenantEnvelope(stored, context);
      } catch (error) {
        if (isTenantEncryptionError(error)) {
          return { code: error.code, outcome: "failed" };
        }

        throw error;
      }

      if (!rewrapped.changed) {
        return { outcome: "unchanged" };
      }

      next = rewrapped.bytes;
    }

    if (!apply) {
      return { outcome: "changed" };
    }

    // The plaintext's hash goes in with the envelope, so content_sha256 never
    // has to be computed from stored bytes again (doc-registry.js backfill).
    const hashAssignment = plaintextHash
      ? `, ${spec.hashColumn} = COALESCE(t.${spec.hashColumn}, $${spec.keyColumns.length + 2})`
      : "";

    await client.query(
      `
        UPDATE ${spec.table} AS t
        SET ${spec.column} = $${spec.keyColumns.length + 1}${hashAssignment}
        WHERE ${keyMatch(spec)}
      `,
      [...key, next, ...(plaintextHash ? [plaintextHash] : [])]
    );

    return { outcome: "changed" };
  });

const runOverTables = async ({
  apply,
  batchSize,
  mode,
  onProgress,
  queryPostgres,
  runMigrations,
  tables,
  withPostgresTransaction,
}) =>
  runAsDatabaseSystem(async () => {
    await runMigrations();

    const report = {};
    const limit = Math.max(1, Math.floor(Number(batchSize) || 50));

    for (const spec of tables) {
      const counts = { changed: 0, failed: 0, locked: 0, running: 0, unchanged: 0, visited: 0 };
      const failureCodes = {};

      for await (const key of listCandidateKeys({ batchSize: limit, mode, queryPostgres, spec })) {
        const { code, outcome } = await processRow({ apply, key, mode, spec, withPostgresTransaction });

        counts.visited += 1;

        if (outcome in counts) {
          counts[outcome] += 1;
        }

        if (code) {
          failureCodes[code] = (failureCodes[code] ?? 0) + 1;
        }

        if (counts.visited % limit === 0) {
          await onProgress?.({ table: spec.name, ...counts });
        }
      }

      report[spec.name] = Object.keys(failureCodes).length > 0 ? { ...counts, failureCodes } : counts;
    }

    return { apply, mode, tables: report };
  });

/**
 * Encrypts every legacy plaintext value of the tables (dry run unless
 * `apply`): each under its record's tenant key, as a write would. Values
 * already enveloped are left alone, so a rerun only finishes what was left.
 */
export const encryptExistingTenantFiles = ({
  apply = false,
  batchSize = 50,
  onProgress = null,
  queryPostgres = queryDefaultPostgres,
  runMigrations = runPostgresMigrations,
  tables = describeTenantFileTables(),
  withPostgresTransaction = withDefaultPostgresTransaction,
} = {}) =>
  runOverTables({
    apply,
    batchSize,
    mode: "encrypt",
    onProgress,
    queryPostgres,
    runMigrations,
    tables,
    withPostgresTransaction,
  });

/**
 * Re-wraps every envelope whose data key sits under an older version of its
 * tenant key, under the current version: only the header changes, the
 * payload and its tag stay. A dry run counts them and writes nothing. An
 * envelope under a destroyed version fails (nothing can unwrap it).
 */
export const rewrapTenantFiles = ({
  apply = false,
  batchSize = 50,
  onProgress = null,
  queryPostgres = queryDefaultPostgres,
  runMigrations = runPostgresMigrations,
  tables = describeTenantFileTables(),
  withPostgresTransaction = withDefaultPostgresTransaction,
} = {}) =>
  runOverTables({
    apply,
    batchSize,
    mode: "rewrap",
    onProgress,
    queryPostgres,
    runMigrations,
    tables,
    withPostgresTransaction,
  });
