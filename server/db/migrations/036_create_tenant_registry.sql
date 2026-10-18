-- The tenant registry: which workspaces exist and who belongs to each
-- (tenant isolation phase 3, rag/tenant-registry.js).
--
-- Until now a workspace was whatever string a token, an OIDC claim or the
-- x-workspace-id header named, and workspace roles came only from token
-- claims. These two tables let an operator register a workspace, suspend it,
-- and list its members with their roles. With TENANT_MEMBERSHIP=enforce,
-- requireApiAuth (auth.js) refuses a request whose workspace is not
-- registered or not active, or whose user is not a member, and merges the
-- membership's roles into the request's workspace roles. With it off
-- (default) nothing reads these tables for requests: only the admin routes
-- (routes/admin-tenants.js), `npm run tenant:registry`, the retention sweep
-- (the retention_policy column) and the tenant erase and export
-- (rag/tenant-lifecycle.js) do.
--
-- * workspace_id is the database tenant's workspace exactly as requests
--   resolve it. The registry service only accepts canonical (trimmed,
--   lower-case) ids, the form a token's workspace list resolves to.
-- * status: active, suspended (requests refused with WORKSPACE_SUSPENDED) or
--   deleting (WORKSPACE_DELETING). Only the registry service sets deleting,
--   for offboarding (a workspace erase sets it before erasing the workspace's
--   data and deletes the row last); suspend and activate refuse a deleting
--   workspace.
-- * plan and region are descriptive; nothing enforces them yet.
--   retention_policy is the workspace's retention override, which the
--   retention sweep reads (rag/retention.js) in the format
--   rag/workspace-retention-policy.js defines and the registry service
--   enforces: keys agentRuns, tasks, workspaceArtifacts, feedback, each a
--   whole number of days from 0 (keep forever) to 36500. It is jsonb: read as
--   a value, never echoed byte for byte.
-- * A membership names one user of one workspace with the role ids granted
--   inside it (RBAC role ids such as workspace.viewer). Removing the
--   workspace row removes its memberships.
--
-- Row-level security:
--
-- * The tenant role may only read: its own workspace's row, and its own
--   user's membership rows (in the active workspace, or in every workspace
--   for a tenant without one). That is what the enforcement lookups read; they
--   bind the tenant they check. Every write goes through the system path
--   (runAsDatabaseSystem: the admin routes after their permission check, the
--   CLI), so no tenant statement can register, suspend or join a workspace.
-- * The system role (migration 035) gets full DML and its permissive
--   system_access policy, like every other table under row-level security.

CREATE TABLE IF NOT EXISTS __WORKSPACES_TABLE__ (
  workspace_id TEXT PRIMARY KEY CHECK (workspace_id <> ''),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleting')),
  plan TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  retention_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS __WORKSPACES_TABLE___status_idx
  ON __WORKSPACES_TABLE__ (status, workspace_id);

CREATE TABLE IF NOT EXISTS __WORKSPACE_MEMBERS_TABLE__ (
  workspace_id TEXT NOT NULL
    REFERENCES __WORKSPACES_TABLE__ (workspace_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL CHECK (user_id <> ''),
  roles TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

-- A user's memberships across workspaces (the tenant read without a
-- workspace).
CREATE INDEX IF NOT EXISTS __WORKSPACE_MEMBERS_TABLE___user_idx
  ON __WORKSPACE_MEMBERS_TABLE__ (user_id, workspace_id);

GRANT SELECT ON __WORKSPACES_TABLE__, __WORKSPACE_MEMBERS_TABLE__ TO __TENANT_ROLE__;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON __WORKSPACES_TABLE__, __WORKSPACE_MEMBERS_TABLE__
  TO __SYSTEM_ROLE__;

ALTER TABLE __WORKSPACES_TABLE__ ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON __WORKSPACES_TABLE__;
CREATE POLICY tenant_isolation ON __WORKSPACES_TABLE__
  FOR SELECT
  TO __TENANT_ROLE__
  USING (
    workspace_id <> ''
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );

DROP POLICY IF EXISTS system_access ON __WORKSPACES_TABLE__;
CREATE POLICY system_access ON __WORKSPACES_TABLE__
  TO __SYSTEM_ROLE__
  USING (true)
  WITH CHECK (true);

ALTER TABLE __WORKSPACE_MEMBERS_TABLE__ ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON __WORKSPACE_MEMBERS_TABLE__;
CREATE POLICY tenant_isolation ON __WORKSPACE_MEMBERS_TABLE__
  FOR SELECT
  TO __TENANT_ROLE__
  USING (
    user_id <> ''
    AND user_id = current_setting('archive_rag.user_id', true)
    AND (
      workspace_id = current_setting('archive_rag.workspace_id', true)
      OR COALESCE(current_setting('archive_rag.workspace_id', true), '') = ''
    )
  );

DROP POLICY IF EXISTS system_access ON __WORKSPACE_MEMBERS_TABLE__;
CREATE POLICY system_access ON __WORKSPACE_MEMBERS_TABLE__
  TO __SYSTEM_ROLE__
  USING (true)
  WITH CHECK (true);
