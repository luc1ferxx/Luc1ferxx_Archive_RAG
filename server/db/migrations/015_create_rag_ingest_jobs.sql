-- Asynchronous upload ingestion (RAG_INGEST_MODE=async).
--
-- The upload request validates the PDF, stores its bytes here and answers 202;
-- a worker claims the job, parses, embeds and indexes it exactly as the
-- synchronous path does, and nulls the bytes once the document is committed.
--
-- Claiming (rag/ingest-job-store.js) is one UPDATE over a FOR UPDATE SKIP
-- LOCKED subselect, run as the owner role because a worker serves every
-- tenant's queue. Every later write is fenced on job_id + claimed_by +
-- attempt_count, so a worker that lost its lease cannot overwrite a newer
-- attempt. A running job whose lease has expired is claimable again.

CREATE TABLE IF NOT EXISTS __INGEST_JOBS_TABLE__ (
  job_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  file_bytes BYTEA,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claimed_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT __INGEST_JOBS_TABLE___status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT __INGEST_JOBS_TABLE___attempts_check
    CHECK (attempt_count >= 0 AND max_attempts > 0)
);

CREATE INDEX IF NOT EXISTS __INGEST_JOBS_TABLE___claim_idx
  ON __INGEST_JOBS_TABLE__ (status, available_at, created_at);

CREATE INDEX IF NOT EXISTS __INGEST_JOBS_TABLE___doc_id_idx
  ON __INGEST_JOBS_TABLE__ (doc_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON __INGEST_JOBS_TABLE__ TO __TENANT_ROLE__;

-- Same rule as the documents they become (migration 013): a job with neither
-- owner nor workspace is never visible to a tenant, and each non-empty owner
-- column must equal the tenant's value.

ALTER TABLE __INGEST_JOBS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __INGEST_JOBS_TABLE__;
CREATE POLICY tenant_isolation ON __INGEST_JOBS_TABLE__
  TO __TENANT_ROLE__
  USING (
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  )
  WITH CHECK (
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  );
