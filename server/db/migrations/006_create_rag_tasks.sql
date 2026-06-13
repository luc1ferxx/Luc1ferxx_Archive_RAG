CREATE TABLE IF NOT EXISTS __TASKS_TABLE__ (
  user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  provider JSONB NULL,
  subject JSONB NULL,
  runner_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB NULL,
  payload JSONB NULL,
  required_user_action TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NULL,
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, workspace_id, task_id)
);

CREATE INDEX IF NOT EXISTS __TASKS_TABLE___scope_type_updated_idx
  ON __TASKS_TABLE__ (user_id, workspace_id, type, updated_at DESC);

CREATE INDEX IF NOT EXISTS __TASKS_TABLE___status_updated_idx
  ON __TASKS_TABLE__ (status, updated_at ASC);

CREATE TABLE IF NOT EXISTS __TASK_EVENTS_TABLE__ (
  event_id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS __TASK_EVENTS_TABLE___task_created_idx
  ON __TASK_EVENTS_TABLE__ (user_id, workspace_id, task_id, created_at DESC);
