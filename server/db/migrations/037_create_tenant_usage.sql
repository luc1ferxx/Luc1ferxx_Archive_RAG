-- Per-tenant usage ledger and storage-quota totals (tenant isolation phase 3).
--
-- 1. __TENANT_USAGE_TABLE__ holds hourly aggregates per tenant: model tokens,
--    estimated model cost in micro-USD, chat requests, ingested bytes and
--    ingested documents (rag/tenant-usage.js). Each process aggregates in
--    memory and adds its totals here every TENANT_USAGE_FLUSH_MS as system
--    work (runAsDatabaseSystem), one upsert per batch, so no request waits on
--    it. GET /admin/usage reads it.
--
--    * (workspace_id, owner_user_id) is the tenant pair the usage was charged
--      to, '' for a part the scope did not name. Usage outside any tenant
--      (auth disabled, system work such as an index version build) is
--      recorded under ('', ''), which no tenant sees.
--    * period_start is the start of a UTC hour (checked on the epoch, so the
--      session's TimeZone cannot matter); value only grows.
--    * The tenant role may read its own rows (the exact pair, as for tasks and
--      feedback) and nothing else; it never writes. The system role writes and
--      reads every row (migration 035's pattern).
--
-- 2. __DOCUMENTS_TABLE___storage_totals(workspace_id, user_id) answers how
--    many documents and how many stored bytes a quota scope holds
--    (TENANT_MAX_DOCUMENTS, TENANT_MAX_DOCUMENT_BYTES; rag/tenant-storage-
--    quota.js): every document of the workspace when it names one, else the
--    user's documents without a workspace. A workspace's documents belong to
--    several users, and the documents policy (migration 013) shows a tenant
--    only its own, so the count runs as the table owner (SECURITY DEFINER)
--    -- inside the tenant's own ingest transaction, where the quota is
--    checked under the commit's locks. Called as the tenant role
--    (current_setting('role'), as migrations 030 and 033 test it) it answers
--    only for the caller's own scope and refuses any other with 42501, so a
--    tenant learns nothing about another workspace. It returns two numbers
--    and nothing else.
--
-- 3. An index on the documents table's workspace_id for that count.

CREATE TABLE IF NOT EXISTS __TENANT_USAGE_TABLE__ (
  workspace_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  value BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT __TENANT_USAGE_TABLE___metric_check CHECK (metric ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT __TENANT_USAGE_TABLE___period_check
    CHECK (MOD(EXTRACT(EPOCH FROM period_start)::bigint, 3600) = 0),
  CONSTRAINT __TENANT_USAGE_TABLE___value_check CHECK (value >= 0),
  PRIMARY KEY (workspace_id, owner_user_id, metric, period_start)
);

-- Top-N over a time range for one metric (the platform view of GET /admin/usage).
CREATE INDEX IF NOT EXISTS __TENANT_USAGE_TABLE___metric_period_idx
  ON __TENANT_USAGE_TABLE__ (metric, period_start);

GRANT SELECT ON __TENANT_USAGE_TABLE__ TO __TENANT_ROLE__;
GRANT SELECT, INSERT, UPDATE, DELETE ON __TENANT_USAGE_TABLE__ TO __SYSTEM_ROLE__;

ALTER TABLE __TENANT_USAGE_TABLE__ ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON __TENANT_USAGE_TABLE__;
CREATE POLICY tenant_isolation ON __TENANT_USAGE_TABLE__
  TO __TENANT_ROLE__
  USING (
    owner_user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    owner_user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );

DROP POLICY IF EXISTS system_access ON __TENANT_USAGE_TABLE__;
CREATE POLICY system_access ON __TENANT_USAGE_TABLE__
  TO __SYSTEM_ROLE__
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS __DOCUMENTS_TABLE___workspace_id_idx
  ON __DOCUMENTS_TABLE__ (workspace_id);

-- Created through format() so the body can name the documents table with its
-- schema: a SECURITY DEFINER function pins its search_path to pg_catalog and
-- pg_temp (migrations 014, 030 and 033 do the same), so an unqualified name
-- would not resolve. %1$L is the tenant role, %2$I the schema, %3$I the
-- documents table.
DO $migration$
DECLARE
  schema_name CONSTANT text := current_schema();
  documents_table CONSTANT text := lower('__DOCUMENTS_TABLE__');
  totals_function CONSTANT text := lower('__DOCUMENTS_TABLE__') || '_storage_totals';
  tenant_role CONSTANT text := '__TENANT_ROLE__';
  system_role CONSTANT text := '__SYSTEM_ROLE__';
  totals_body CONSTANT text := $body$
DECLARE
  tenant_scoped CONSTANT boolean := current_setting('role') = %1$L;
  safe_workspace_id CONSTANT text := COALESCE(scope_workspace_id, '');
  safe_user_id CONSTANT text := COALESCE(scope_user_id, '');
BEGIN
  IF safe_workspace_id = '' AND safe_user_id = '' THEN
    RAISE EXCEPTION 'storage_totals: a quota scope names a workspace or a user'
      USING ERRCODE = '22023';
  END IF;

  -- The tenant role may ask only about its own scope.
  IF tenant_scoped AND NOT (
    CASE
      WHEN safe_workspace_id <> '' THEN
        safe_workspace_id = COALESCE(current_setting('archive_rag.workspace_id', true), '')
      ELSE
        safe_user_id = COALESCE(current_setting('archive_rag.user_id', true), '')
        AND COALESCE(current_setting('archive_rag.workspace_id', true), '') = ''
    END
  ) THEN
    RAISE EXCEPTION 'storage_totals: a tenant may read only its own quota scope'
      USING ERRCODE = '42501';
  END IF;

  IF safe_workspace_id <> '' THEN
    RETURN QUERY
      SELECT COUNT(*)::bigint, COALESCE(SUM(d.file_size), 0)::bigint
      FROM %2$I.%3$I AS d
      WHERE d.workspace_id = safe_workspace_id;
  ELSE
    RETURN QUERY
      SELECT COUNT(*)::bigint, COALESCE(SUM(d.file_size), 0)::bigint
      FROM %2$I.%3$I AS d
      WHERE d.owner_user_id = safe_user_id
        AND d.workspace_id = '';
  END IF;
END
$body$;
BEGIN
  IF octet_length(totals_function) > 63 THEN
    RAISE EXCEPTION 'migration 037: the derived name "%" is longer than 63 bytes', totals_function;
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION %I.%I(scope_workspace_id text, scope_user_id text)
     RETURNS TABLE (document_count bigint, document_bytes bigint)
     LANGUAGE plpgsql
     STABLE
     SECURITY DEFINER
     SET search_path = pg_catalog, pg_temp
     AS %L',
    schema_name,
    totals_function,
    format(totals_body, tenant_role, schema_name, documents_table)
  );
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(text, text) FROM PUBLIC', schema_name, totals_function);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(text, text) TO %I', schema_name, totals_function, tenant_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(text, text) TO %I', schema_name, totals_function, system_role);
END
$migration$;
