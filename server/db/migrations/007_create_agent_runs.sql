CREATE TABLE IF NOT EXISTS __AGENT_RUNS_TABLE__ (
  user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  observations JSONB NOT NULL DEFAULT '[]'::jsonb,
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_gates JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, workspace_id, run_id)
);

CREATE INDEX IF NOT EXISTS __AGENT_RUNS_TABLE___scope_status_updated_idx
  ON __AGENT_RUNS_TABLE__ (user_id, workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS __AGENT_RUNS_TABLE___status_updated_idx
  ON __AGENT_RUNS_TABLE__ (status, updated_at ASC);

CREATE TABLE IF NOT EXISTS __AGENT_RUN_EVENTS_TABLE__ (
  event_id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS __AGENT_RUN_EVENTS_TABLE___run_created_idx
  ON __AGENT_RUN_EVENTS_TABLE__ (user_id, workspace_id, run_id, created_at ASC);
