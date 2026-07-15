CREATE TABLE IF NOT EXISTS __WORKSPACE_ARTIFACTS_TABLE__ (
  owner_user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  artifact_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL
    CHECK (artifact_type IN ('report', 'summary', 'document_collection')),
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  format TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT ''
    CHECK (octet_length(content) <= 524288),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(payload::text) <= 262144),
  doc_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  citation_manifest JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_task_id TEXT NOT NULL DEFAULT '',
  source_run_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ NULL,
  PRIMARY KEY (owner_user_id, workspace_id, artifact_id),
  UNIQUE (owner_user_id, workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS __WORKSPACE_ARTIFACTS_TABLE___scope_status_type_created_idx
  ON __WORKSPACE_ARTIFACTS_TABLE__ (
    owner_user_id,
    workspace_id,
    status,
    artifact_type,
    created_at DESC,
    artifact_id ASC
  );
