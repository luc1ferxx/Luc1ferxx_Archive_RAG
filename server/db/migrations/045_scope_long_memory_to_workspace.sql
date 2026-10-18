-- Long-term memory per workspace (LONG_MEMORY_SCOPE=workspace).
--
-- Until now long-term memory was keyed by user alone and migration 013's
-- policy matched the user only, so a user who belongs to two workspaces had a
-- note taken in one recalled into answers in the other: a flow between two
-- tenants. Under LONG_MEMORY_SCOPE=workspace rag/long-memory.js writes notes
-- and agent experience with the active workspace and reads, in workspace W,
-- the user's rows of W plus the user-level rows (workspace_id ''): the
-- fixed-enum preferences and every row written before the scope was on.
--
-- The policy below makes PostgreSQL enforce the same rule for the tenant role,
-- whatever the setting: same user AND (a user-level row OR the active
-- workspace's), for reads and for writes. Under the default `user` scope every
-- row keeps workspace_id '' (the column default; the store's statements do not
-- name the column), so the policy admits exactly what 013's did. The system
-- role's grant and system_access policy (migration 035) already cover the
-- table; the new column needs no grant.
--
-- Rows from before this migration get ''. They stay user-level: visible in
-- every workspace of their user until deleted (DELETE /memory/:memoryId) or
-- cleared (DELETE /memory, from any workspace), or erased with a tenant erase
-- of the user outside any workspace.

ALTER TABLE __LONG_MEMORY_TABLE__
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';

-- A workspace erase or export (rag/tenant-records.js) selects by workspace;
-- partial, so it stays empty while no row has a workspace.
CREATE INDEX IF NOT EXISTS __LONG_MEMORY_TABLE___workspace_user_idx
ON __LONG_MEMORY_TABLE__ (workspace_id, user_id)
WHERE workspace_id <> '';

ALTER TABLE __LONG_MEMORY_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __LONG_MEMORY_TABLE__;
CREATE POLICY tenant_isolation ON __LONG_MEMORY_TABLE__
  TO __TENANT_ROLE__
  USING (
    user_id = current_setting('archive_rag.user_id', true)
    AND (
      workspace_id = ''
      OR workspace_id = current_setting('archive_rag.workspace_id', true)
    )
  )
  WITH CHECK (
    user_id = current_setting('archive_rag.user_id', true)
    AND (
      workspace_id = ''
      OR workspace_id = current_setting('archive_rag.workspace_id', true)
    )
  );
