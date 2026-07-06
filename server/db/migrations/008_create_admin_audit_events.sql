CREATE TABLE IF NOT EXISTS __ADMIN_AUDIT_EVENTS_TABLE__ (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  result TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  permission_id TEXT NOT NULL DEFAULT '',
  action_id TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  authorization JSONB NOT NULL DEFAULT '{}'::jsonb,
  principal JSONB NOT NULL DEFAULT '{}'::jsonb,
  request JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS __ADMIN_AUDIT_EVENTS_TABLE___scope_created_idx
  ON __ADMIN_AUDIT_EVENTS_TABLE__ (workspace_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS __ADMIN_AUDIT_EVENTS_TABLE___action_created_idx
  ON __ADMIN_AUDIT_EVENTS_TABLE__ (action_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS __ADMIN_AUDIT_EVENTS_TABLE___permission_created_idx
  ON __ADMIN_AUDIT_EVENTS_TABLE__ (permission_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS __ADMIN_AUDIT_EVENTS_TABLE___result_created_idx
  ON __ADMIN_AUDIT_EVENTS_TABLE__ (result, created_at DESC, id DESC);
