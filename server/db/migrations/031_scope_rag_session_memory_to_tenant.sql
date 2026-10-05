-- Session memory under tenant row-level security.
--
-- Until now session memory was keyed by the client-supplied session id alone
-- and migration 013 left it without a policy, so a tenant who knew or guessed
-- another tenant's session id could read that conversation, add turns to it,
-- or clear it. Two layers close that:
--
-- * rag/memory.js stores an authenticated tenant's session under
--   sha256(user \0 workspace \0 session id), so the same client id names a
--   different row for every (user, workspace) pair, in every session store.
-- * This migration adds the owner columns and the tenant_isolation policy, so
--   PostgreSQL itself refuses a tenant statement on another tenant's row.
--   rag/memory.js fills the owner columns from the active database tenant.
--
-- Rows written before this migration have empty owner columns. No tenant can
-- see them (a tenant always has a user or a workspace, and the policy matches
-- the exact pair, as for tasks and runs): they stay readable only on the owner
-- path (auth disabled without a user id, system work) until the session TTL
-- purge, which runs as the owner, removes them. Tenants therefore lose the
-- conversation context of sessions started before the upgrade.

ALTER TABLE __SESSION_MEMORY_TABLE__
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';

GRANT SELECT, INSERT, UPDATE, DELETE ON __SESSION_MEMORY_TABLE__ TO __TENANT_ROLE__;

ALTER TABLE __SESSION_MEMORY_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __SESSION_MEMORY_TABLE__;
CREATE POLICY tenant_isolation ON __SESSION_MEMORY_TABLE__
  TO __TENANT_ROLE__
  USING (
    owner_user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    owner_user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );
