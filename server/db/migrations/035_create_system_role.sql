-- The system role: owner-path work without the owner (tenant isolation phase 2).
--
-- Row-level security only binds statements that rag/postgres.js runs after
-- switching into the tenant role (migration 013). Everything else -- start-up
-- loads, the ingest worker's claims, cross-tenant recovery scans, the audit
-- retention purge, auth-disabled requests -- ran as the login itself, which
-- owns every table and therefore bypasses every policy (ENABLE, not FORCE, ROW
-- LEVEL SECURITY). A call chain that lost its tenant context ran there too and
-- read every tenant.
--
-- This migration adds a second NOLOGIN role for that work. It owns nothing; it
-- holds exactly the table privileges the owner path uses and, on every table
-- under row-level security, a permissive policy `system_access` (USING (true)
-- WITH CHECK (true)) that applies to it alone. The tenant_isolation policies
-- apply to the tenant role alone, so neither role ever sees the other's
-- policy, and the SECURITY DEFINER search functions keep their tenant filter
-- (it tests current_setting('role') against the tenant role).
--
-- With POSTGRES_MIGRATION_DATABASE_URL set (the role split), the application
-- logs in with POSTGRES_DATABASE_URL as a runtime login that owns nothing,
-- switches into the tenant role for tenant work and into this role for system
-- work, and runs migrations and DDL on a separate owner pool. The migrator then
-- grants both roles to the runtime login (SET, never INHERIT) on every run
-- (rag/db-migrations.js), not here: a deployment that applies this migration
-- before switching to the split must not need another step. Without the split
-- nothing switches into this role; it and its policies are inert, so the
-- switch later is only a change of URLs.
--
-- Privileges, by table:
--
-- * Every tenant-owned table and the index version registry: SELECT, INSERT,
--   UPDATE, DELETE, which is what start-up, workers, recovery, CLI tools and
--   the index version lifecycle's DML run.
-- * Admin audit events: SELECT, INSERT and DELETE (the retention purge). The
--   tenant role stays append-only (migration 032); no one updates an event.
-- * Answer feedback: SELECT, INSERT (feedback:import). No one changes or
--   removes feedback (migration 034).
-- * Chunk tables, migration 012's and every index version's:
--   <base>_install_system_access(table) below grants them, adds the policy on
--   them and on their BM25 statistics tables (migration 030; like the tenant
--   role, no grant there: only the owner-run triggers and search function read
--   them), and EXECUTE on their sparse-rank and sparse-search functions, which
--   the owner path calls (migrations 014/033 and 030 grant only the tenant
--   role). It runs here for the migration-012 table and every version whose
--   table still exists, and the version lifecycle calls it for every version
--   it creates (vector-store-pgvector-version-lifecycle.js).
-- * Not schema_migrations: the migrator always runs as the owner.
-- * No TRUNCATE, no ownership, no DDL: retiring version 1 empties its table on
--   the owner pool.

DO $$
DECLARE
  system_role CONSTANT text := '__SYSTEM_ROLE__';
  tenant_role CONSTANT text := '__TENANT_ROLE__';
BEGIN
  IF system_role = tenant_role THEN
    RAISE EXCEPTION 'POSTGRES_SYSTEM_ROLE and POSTGRES_TENANT_ROLE must differ (both are "%")', system_role;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = system_role) THEN
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', system_role);
    EXCEPTION
      -- Another database of the same cluster migrating at the same moment.
      WHEN duplicate_object OR unique_violation THEN
        NULL;
      -- A migration login without CREATEROLE (its tenant role was created by
      -- a DBA, as migration 013 allows): the DBA creates this one too.
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'Migration 035 needs the NOLOGIN role "%", and the migration login "%" may not create roles.', system_role, current_user
          USING HINT = format('Create it as a role administrator, then restart: CREATE ROLE %I NOLOGIN;', system_role);
    END;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', current_schema(), system_role);
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  __DOCUMENTS_TABLE__,
  __TASKS_TABLE__,
  __TASK_EVENTS_TABLE__,
  __AGENT_RUNS_TABLE__,
  __AGENT_RUN_EVENTS_TABLE__,
  __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__,
  __WORKSPACE_ARTIFACTS_TABLE__,
  __LONG_MEMORY_TABLE__,
  __SESSION_MEMORY_TABLE__,
  __INGEST_JOBS_TABLE__,
  __INGEST_JOB_OUTPUTS_TABLE__,
  __INDEX_VERSIONS_TABLE__,
  __INDEX_VERSIONS_POINTER_TABLE__,
  __INDEX_VERSION_BUILD_PROGRESS_TABLE__
TO __SYSTEM_ROLE__;

GRANT SELECT, INSERT, DELETE ON __ADMIN_AUDIT_EVENTS_TABLE__ TO __SYSTEM_ROLE__;
GRANT SELECT, INSERT ON __FEEDBACK_TABLE__ TO __SYSTEM_ROLE__;

DO $$
DECLARE
  sequence_name text;
BEGIN
  FOREACH sequence_name IN ARRAY ARRAY[
    pg_get_serial_sequence('__TASK_EVENTS_TABLE__', 'event_id'),
    pg_get_serial_sequence('__AGENT_RUN_EVENTS_TABLE__', 'event_id'),
    pg_get_serial_sequence('__ADMIN_AUDIT_EVENTS_TABLE__', 'id'),
    pg_get_serial_sequence('__FEEDBACK_TABLE__', 'id')
  ] LOOP
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO %I', sequence_name, '__SYSTEM_ROLE__');
    END IF;
  END LOOP;
END
$$;

-- Every table migrations 013, 015, 017, 031, 032 and 034 put under row-level
-- security. Permissive and for the system role only: it changes nothing for
-- the tenant role, whose tenant_isolation policies stay the only ones that
-- apply to it.
DO $$
DECLARE
  system_role CONSTANT text := '__SYSTEM_ROLE__';
  covered_table text;
BEGIN
  FOREACH covered_table IN ARRAY ARRAY[
    lower('__DOCUMENTS_TABLE__'),
    lower('__TASKS_TABLE__'),
    lower('__TASK_EVENTS_TABLE__'),
    lower('__AGENT_RUNS_TABLE__'),
    lower('__AGENT_RUN_EVENTS_TABLE__'),
    lower('__AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__'),
    lower('__WORKSPACE_ARTIFACTS_TABLE__'),
    lower('__LONG_MEMORY_TABLE__'),
    lower('__SESSION_MEMORY_TABLE__'),
    lower('__INGEST_JOBS_TABLE__'),
    lower('__INGEST_JOB_OUTPUTS_TABLE__'),
    lower('__ADMIN_AUDIT_EVENTS_TABLE__'),
    lower('__FEEDBACK_TABLE__')
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS system_access ON %I.%I', current_schema(), covered_table);
    EXECUTE format(
      'CREATE POLICY system_access ON %I.%I TO %I USING (true) WITH CHECK (true)',
      current_schema(),
      covered_table,
      system_role
    );
  END LOOP;
END
$$;

-- The system role's access to one chunk table and what migrations 014/033 and
-- 030 installed next to it. Owner only (it grants and creates policies), like
-- migration 030's _install_bm25 and 033's _install_sparse_rank; idempotent.
CREATE OR REPLACE FUNCTION __DOCUMENT_CHUNKS_TABLE___install_system_access(target_table text)
RETURNS void
LANGUAGE plpgsql
AS $install$
DECLARE
  schema_name CONSTANT text := current_schema();
  system_role CONSTANT text := '__SYSTEM_ROLE__';
  chunk_table CONSTANT text := lower(target_table);
  rank_signature CONSTANT text := '(tsquery, text[], integer)';
  search_signature CONSTANT text :=
    '(tsquery, tsvector, text[], integer, text, double precision, double precision, double precision, bigint, integer)';
  statistics_table text;
BEGIN
  IF chunk_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'install_system_access: "%" is not a simple lower-case table name', target_table;
  END IF;

  IF octet_length(chunk_table || '_sparse_scope_log') > 63 THEN
    RAISE EXCEPTION 'install_system_access: the derived names of "%" are longer than 63 bytes', chunk_table;
  END IF;

  IF to_regclass(format('%I.%I', schema_name, chunk_table)) IS NULL THEN
    RAISE EXCEPTION 'install_system_access: table "%" does not exist', chunk_table;
  END IF;

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO %I', schema_name, chunk_table, system_role);
  EXECUTE format('DROP POLICY IF EXISTS system_access ON %I.%I', schema_name, chunk_table);
  EXECUTE format(
    'CREATE POLICY system_access ON %I.%I TO %I USING (true) WITH CHECK (true)',
    schema_name, chunk_table, system_role
  );

  FOREACH statistics_table IN ARRAY ARRAY[
    chunk_table || '_sparse_scopes',
    chunk_table || '_sparse_terms',
    chunk_table || '_sparse_scope_log',
    chunk_table || '_sparse_term_log'
  ] LOOP
    IF to_regclass(format('%I.%I', schema_name, statistics_table)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS system_access ON %I.%I', schema_name, statistics_table);
      EXECUTE format(
        'CREATE POLICY system_access ON %I.%I TO %I USING (true) WITH CHECK (true)',
        schema_name, statistics_table, system_role
      );
    END IF;
  END LOOP;

  IF to_regprocedure(format('%I.%I%s', schema_name, chunk_table || '_sparse_rank', rank_signature)) IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.%I%s TO %I',
      schema_name, chunk_table || '_sparse_rank', rank_signature, system_role
    );
  END IF;

  IF to_regprocedure(format('%I.%I%s', schema_name, chunk_table || '_sparse_search', search_signature)) IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.%I%s TO %I',
      schema_name, chunk_table || '_sparse_search', search_signature, system_role
    );
  END IF;
END
$install$;

REVOKE ALL ON FUNCTION __DOCUMENT_CHUNKS_TABLE___install_system_access(text) FROM PUBLIC;

SELECT __DOCUMENT_CHUNKS_TABLE___install_system_access('__DOCUMENT_CHUNKS_TABLE__');

-- Every index version whose table still exists, whatever its status (as
-- migration 033 does): a failed or retired version whose drop has not
-- succeeded yet keeps its table and functions.
DO $migration$
DECLARE
  base_table CONSTANT text := lower('__DOCUMENT_CHUNKS_TABLE__');
  version_row record;
BEGIN
  FOR version_row IN
    SELECT lower(v.chunk_table) AS chunk_table
    FROM __INDEX_VERSIONS_TABLE__ AS v
    WHERE lower(v.chunk_table) <> base_table
      AND to_regclass(format('%I.%I', current_schema(), lower(v.chunk_table))) IS NOT NULL
    ORDER BY v.version_id
  LOOP
    PERFORM __DOCUMENT_CHUNKS_TABLE___install_system_access(version_row.chunk_table);
  END LOOP;
END
$migration$;
