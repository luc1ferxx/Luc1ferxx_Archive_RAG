-- Admin audit events under tenant row-level security.
--
-- Migration 013 granted the tenant role SELECT, INSERT, UPDATE and DELETE on
-- the audit table without a policy, so any statement a tenant request ran
-- against it saw, changed or removed every tenant's audit trail. Now:
--
-- * A tenant reads the events of its own workspace (workspace admins read
--   across the workspace's users under the admin permission check), or, for a
--   tenant without a workspace, only its own user's events.
-- * A tenant inserts only events that name itself, which is what
--   recordAuthorizationDecision writes for the request's own scope.
-- * The tenant role can no longer UPDATE or DELETE audit events. The retention
--   purge runs as the owner (runAsDatabaseSystem in
--   rag/postgres-admin-audit-store.js), and an admin without a workspace reads
--   across tenants on the owner path after its permission check
--   (routes/admin.js).

REVOKE UPDATE, DELETE ON __ADMIN_AUDIT_EVENTS_TABLE__ FROM __TENANT_ROLE__;
GRANT SELECT, INSERT ON __ADMIN_AUDIT_EVENTS_TABLE__ TO __TENANT_ROLE__;

ALTER TABLE __ADMIN_AUDIT_EVENTS_TABLE__ ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON __ADMIN_AUDIT_EVENTS_TABLE__;
CREATE POLICY tenant_isolation ON __ADMIN_AUDIT_EVENTS_TABLE__
  FOR SELECT
  TO __TENANT_ROLE__
  USING (
    (
      workspace_id <> ''
      AND workspace_id = current_setting('archive_rag.workspace_id', true)
    )
    OR (
      workspace_id = ''
      AND current_setting('archive_rag.workspace_id', true) = ''
      AND user_id <> ''
      AND user_id = current_setting('archive_rag.user_id', true)
    )
  );

DROP POLICY IF EXISTS tenant_isolation_insert ON __ADMIN_AUDIT_EVENTS_TABLE__;
CREATE POLICY tenant_isolation_insert ON __ADMIN_AUDIT_EVENTS_TABLE__
  FOR INSERT
  TO __TENANT_ROLE__
  WITH CHECK (
    user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );
