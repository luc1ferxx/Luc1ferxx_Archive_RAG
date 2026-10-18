-- Personal long-term memory under LONG_MEMORY_SCOPE=workspace.
--
-- Migration 045 gave every row a workspace_id and made '' mean "user-level":
-- visible in every workspace of the user. A user acting in no workspace (a
-- user-only tenant, the SPA's "Personal" choice) also wrote its notes and
-- agent experience with workspace_id '', so a note taken in the personal
-- scope was recalled in every workspace, and a DELETE /memory in any
-- workspace removed it. '' cannot tell the two apart, and no workspace id
-- value can serve as a marker instead: a workspace is whatever string a
-- token, a claim or a request names, so any marker could be a real one.
--
-- `personal` marks the free-text rows written in the personal scope. Under
-- LONG_MEMORY_SCOPE=workspace rag/long-memory.js writes them with
-- workspace_id '' and personal TRUE; the fixed-enum preferences and every row
-- from before stay workspace_id '' with personal FALSE (the column default),
-- user-level as before. A read in workspace W sees the user's rows of W and
-- the user-level rows; a read in the personal scope (workspace '') sees the
-- user-level rows and the personal ones.
--
-- The policy enforces the same for the tenant role, for reads and writes:
-- same user AND (a row of the active workspace, '' for the personal scope,
-- OR a user-level row that is not personal). Under the default `user` scope
-- every row keeps '' and FALSE (the store's statements name neither column),
-- so the policy admits exactly what 013's and 045's did. A tenant in W can
-- neither read a personal row nor write one (WITH CHECK), nor turn a
-- user-level row personal. The system role's grant and system_access policy
-- (migration 035) cover the new column.
--
-- Rows written with LONG_MEMORY_SCOPE=workspace before this migration by a
-- user-only tenant carry '' and FALSE: they cannot be told apart from
-- user-level rows and stay visible in every workspace of the user until
-- deleted, cleared or erased with a user-only tenant selector, as 045's
-- legacy rows do.

ALTER TABLE __LONG_MEMORY_TABLE__
  ADD COLUMN IF NOT EXISTS personal BOOLEAN NOT NULL DEFAULT FALSE;

-- A personal row is a row of no workspace.
ALTER TABLE __LONG_MEMORY_TABLE__
  DROP CONSTRAINT IF EXISTS __LONG_MEMORY_TABLE___personal_check;

ALTER TABLE __LONG_MEMORY_TABLE__
  ADD CONSTRAINT __LONG_MEMORY_TABLE___personal_check CHECK (NOT personal OR workspace_id = '');

ALTER TABLE __LONG_MEMORY_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __LONG_MEMORY_TABLE__;
CREATE POLICY tenant_isolation ON __LONG_MEMORY_TABLE__
  TO __TENANT_ROLE__
  USING (
    user_id = current_setting('archive_rag.user_id', true)
    AND (
      workspace_id = current_setting('archive_rag.workspace_id', true)
      OR (workspace_id = '' AND NOT personal)
    )
  )
  WITH CHECK (
    user_id = current_setting('archive_rag.user_id', true)
    AND (
      workspace_id = current_setting('archive_rag.workspace_id', true)
      OR (workspace_id = '' AND NOT personal)
    )
  );
