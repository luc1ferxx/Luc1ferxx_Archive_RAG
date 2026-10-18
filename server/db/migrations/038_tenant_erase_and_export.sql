-- Tenant erase and export (rag/tenant-lifecycle.js: npm run tenant:erase and
-- tenant:export, POST /admin/tenants/erase and GET /admin/tenants/export).
--
-- No new table. Two changes:
--
-- * The erase is system work (runAsDatabaseSystem). Migration 035 gave the
--   system role SELECT and INSERT on answer feedback because nothing removed
--   feedback; the erase does now, so the system role may DELETE there too.
--   It still may not UPDATE feedback, and the tenant role stays append-only
--   (migration 034): no request removes feedback, and a tenant cannot erase
--   itself through a statement it runs. Running the feedback delete on the
--   owner pool instead was rejected: that pool is for migrations and DDL, and
--   using it for rows would make the erase need the migration credential at
--   run time and let an erase bug touch the schema. Without the role split
--   (POSTGRES_MIGRATION_DATABASE_URL unset) nothing switches into the system
--   role, the erase runs as the owner login, and this grant is inert.
--
-- * Admin audit events get a nullable `details` column. Only tenant lifecycle
--   events fill it: the erased or exported tenant's ids, per-table counts and
--   an outcome word (normalizeAdminAuditDetails in rag/admin-audit.js), never
--   a record's content. An erase keeps every audit event (the retention purge
--   removes them) and adds its own as a tombstone. Existing rows and every
--   other event keep NULL; the tenant role's INSERT policy (migration 032) is
--   unchanged, and its grant covers the new column.

GRANT DELETE ON __FEEDBACK_TABLE__ TO __SYSTEM_ROLE__;

ALTER TABLE __ADMIN_AUDIT_EVENTS_TABLE__
  ADD COLUMN IF NOT EXISTS details JSONB NULL;
