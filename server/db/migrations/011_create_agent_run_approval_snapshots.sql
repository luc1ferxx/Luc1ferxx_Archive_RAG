CREATE TABLE IF NOT EXISTS __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__ (
  user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  capability_version TEXT NOT NULL,
  approval_object_hash TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  execution_input JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, workspace_id, run_id, gate_id),
  FOREIGN KEY (user_id, workspace_id, run_id)
    REFERENCES __AGENT_RUNS_TABLE__ (user_id, workspace_id, run_id)
    ON DELETE CASCADE,
  CHECK (gate_id <> ''),
  CHECK (capability_id <> ''),
  CHECK (capability_version <> ''),
  CHECK (approval_object_hash <> ''),
  CHECK (snapshot_version > 0),
  CHECK (jsonb_typeof(execution_input) = 'object')
);
