-- Tenant row-level security.
--
-- The stores already filter every tenant-owned table by user/workspace in the
-- application. These policies make PostgreSQL enforce the same rule, so a query
-- that forgets its WHERE clause returns no other tenant's rows and cannot write
-- one. They apply to the tenant role only: rag/postgres.js switches a scoped
-- request's transaction into that role (SET LOCAL ROLE) and sets
-- archive_rag.user_id / archive_rag.workspace_id. The owner role that runs
-- migrations, startup loads and cross-tenant recovery scans is not forced
-- through the policies (ENABLE, not FORCE, ROW LEVEL SECURITY).
--
-- Out of scope: session memory is keyed by session id and has no owner
-- columns, and admin audit events are read across users by workspace admins
-- under the admin permission check. The tenant role may use both tables
-- without a policy.

DO $$
DECLARE
  tenant_role CONSTANT text := '__TENANT_ROLE__';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = tenant_role) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', tenant_role);
  END IF;

  -- The login role switches into the tenant role per transaction, which needs
  -- membership with the SET option (PostgreSQL 16 split it out of plain
  -- membership). Superusers may switch to any role.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF current_setting('server_version_num')::int >= 160000 THEN
      IF NOT pg_has_role(current_user, tenant_role, 'SET') THEN
        EXECUTE format('GRANT %I TO %I WITH SET TRUE', tenant_role, current_user);
      END IF;
    ELSIF NOT pg_has_role(current_user, tenant_role, 'MEMBER') THEN
      EXECUTE format('GRANT %I TO %I', tenant_role, current_user);
    END IF;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', current_schema(), tenant_role);
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  __DOCUMENTS_TABLE__,
  __DOCUMENT_CHUNKS_TABLE__,
  __TASKS_TABLE__,
  __TASK_EVENTS_TABLE__,
  __AGENT_RUNS_TABLE__,
  __AGENT_RUN_EVENTS_TABLE__,
  __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__,
  __WORKSPACE_ARTIFACTS_TABLE__,
  __LONG_MEMORY_TABLE__,
  __SESSION_MEMORY_TABLE__,
  __ADMIN_AUDIT_EVENTS_TABLE__
TO __TENANT_ROLE__;

DO $$
DECLARE
  sequence_name text;
BEGIN
  FOREACH sequence_name IN ARRAY ARRAY[
    pg_get_serial_sequence('__TASK_EVENTS_TABLE__', 'event_id'),
    pg_get_serial_sequence('__AGENT_RUN_EVENTS_TABLE__', 'event_id'),
    pg_get_serial_sequence('__ADMIN_AUDIT_EVENTS_TABLE__', 'id')
  ] LOOP
    IF sequence_name IS NOT NULL THEN
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE %s TO %I',
        sequence_name,
        '__TENANT_ROLE__'
      );
    END IF;
  END LOOP;
END
$$;

-- Documents and their chunks follow documentMatchesAccessScope in
-- rag/doc-registry.js: a row with neither owner nor workspace is never visible
-- to a tenant, and each non-empty owner column must equal the tenant's value.

ALTER TABLE __DOCUMENTS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __DOCUMENTS_TABLE__;
CREATE POLICY tenant_isolation ON __DOCUMENTS_TABLE__
  TO __TENANT_ROLE__
  USING (
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  )
  WITH CHECK (
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  );

ALTER TABLE __DOCUMENT_CHUNKS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __DOCUMENT_CHUNKS_TABLE__;
CREATE POLICY tenant_isolation ON __DOCUMENT_CHUNKS_TABLE__
  TO __TENANT_ROLE__
  USING (
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  )
  WITH CHECK (
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  );

-- Tasks, agent runs and artifacts are keyed by the exact (user, workspace)
-- pair, empty strings included, as their stores' WHERE clauses are.

ALTER TABLE __TASKS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __TASKS_TABLE__;
CREATE POLICY tenant_isolation ON __TASKS_TABLE__
  TO __TENANT_ROLE__
  USING (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );

ALTER TABLE __TASK_EVENTS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __TASK_EVENTS_TABLE__;
CREATE POLICY tenant_isolation ON __TASK_EVENTS_TABLE__
  TO __TENANT_ROLE__
  USING (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );

ALTER TABLE __AGENT_RUNS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __AGENT_RUNS_TABLE__;
CREATE POLICY tenant_isolation ON __AGENT_RUNS_TABLE__
  TO __TENANT_ROLE__
  USING (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );

ALTER TABLE __AGENT_RUN_EVENTS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __AGENT_RUN_EVENTS_TABLE__;
CREATE POLICY tenant_isolation ON __AGENT_RUN_EVENTS_TABLE__
  TO __TENANT_ROLE__
  USING (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );

ALTER TABLE __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__;
CREATE POLICY tenant_isolation ON __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__
  TO __TENANT_ROLE__
  USING (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );

ALTER TABLE __WORKSPACE_ARTIFACTS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __WORKSPACE_ARTIFACTS_TABLE__;
CREATE POLICY tenant_isolation ON __WORKSPACE_ARTIFACTS_TABLE__
  TO __TENANT_ROLE__
  USING (
    owner_user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    owner_user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );

-- Long-term memory belongs to a user across workspaces.

ALTER TABLE __LONG_MEMORY_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __LONG_MEMORY_TABLE__;
CREATE POLICY tenant_isolation ON __LONG_MEMORY_TABLE__
  TO __TENANT_ROLE__
  USING (user_id = current_setting('archive_rag.user_id', true))
  WITH CHECK (user_id = current_setting('archive_rag.user_id', true));
