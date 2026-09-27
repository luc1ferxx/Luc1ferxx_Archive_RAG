-- Staged asynchronous ingestion (rag/ingest-pipeline.js, rag/ingest-worker.js).
--
-- A job now runs parse -> chunk -> embed -> index. `stage` is the stage the
-- next attempt runs; each stage's output is stored in the outputs table below
-- before the job moves on, so a retry resumes at the stage that failed rather
-- than from the upload. The upload's bytes leave the job row when parse
-- succeeds: they become the parse stage's `document_file` output, which the
-- index stage stores with the document.
--
-- attempt_count still counts every claim and stays part of the write fence
-- (job_id + claimed_by + attempt_count). stage_attempts counts the claims of
-- the current stage and max_attempts is that stage's budget; a stage that
-- exhausts it moves the job to dead_letter with the stage and a reason, from
-- where an operator requeues it (ingest-jobs.mjs, POST
-- /admin/ingest-jobs/:jobId/requeue). `failed` stays for problems with the
-- upload itself (no extractable text), which a retry cannot fix.
--
-- kind 'replace' is PUT /documents/:docId: the index stage swaps the
-- document's chunks in one transaction and bumps its content version.
-- content_sha256 + deduplicate let the index stage resolve a job whose bytes
-- the tenant already stored to that document (resolved_doc_id, duplicate).

ALTER TABLE __INGEST_JOBS_TABLE__
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'create',
  ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'parse',
  ADD COLUMN IF NOT EXISTS stage_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS content_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS deduplicate BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resolved_doc_id TEXT,
  ADD COLUMN IF NOT EXISTS duplicate BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS document_version INTEGER,
  ADD COLUMN IF NOT EXISTS dead_letter_stage TEXT,
  ADD COLUMN IF NOT EXISTS dead_letter_reason TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requeue_count INTEGER NOT NULL DEFAULT 0;

-- Jobs from before this migration ran as one step: their claims so far were
-- all claims of that step.
UPDATE __INGEST_JOBS_TABLE__
SET stage_attempts = attempt_count
WHERE stage_attempts = 0 AND attempt_count > 0;

ALTER TABLE __INGEST_JOBS_TABLE__
  DROP CONSTRAINT IF EXISTS __INGEST_JOBS_TABLE___status_check;

ALTER TABLE __INGEST_JOBS_TABLE__
  ADD CONSTRAINT __INGEST_JOBS_TABLE___status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  ADD CONSTRAINT __INGEST_JOBS_TABLE___stage_check
    CHECK (stage IN ('parse', 'chunk', 'embed', 'index')),
  ADD CONSTRAINT __INGEST_JOBS_TABLE___kind_check
    CHECK (kind IN ('create', 'replace')),
  ADD CONSTRAINT __INGEST_JOBS_TABLE___stage_attempts_check
    CHECK (stage_attempts >= 0 AND requeue_count >= 0);

CREATE INDEX IF NOT EXISTS __INGEST_JOBS_TABLE___dead_letter_idx
  ON __INGEST_JOBS_TABLE__ (owner_user_id, workspace_id, dead_lettered_at)
  WHERE status = 'dead_letter';

-- One row per stage output. The worker writes and reads them as the owner
-- role, fenced on the job. They hold tenant document text, so they carry the
-- owner columns, the tenant grant and the same row policy as the jobs: a
-- tenant session that ever reads them sees its own jobs' outputs only.
CREATE TABLE IF NOT EXISTS __INGEST_JOB_OUTPUTS_TABLE__ (
  job_id TEXT NOT NULL REFERENCES __INGEST_JOBS_TABLE__ (job_id) ON DELETE CASCADE,
  output TEXT NOT NULL,
  payload BYTEA NOT NULL,
  byte_size BIGINT NOT NULL,
  owner_user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, output),
  CONSTRAINT __INGEST_JOB_OUTPUTS_TABLE___output_check
    CHECK (output IN ('document_file', 'pages', 'chunks', 'embeddings'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON __INGEST_JOB_OUTPUTS_TABLE__ TO __TENANT_ROLE__;

ALTER TABLE __INGEST_JOB_OUTPUTS_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __INGEST_JOB_OUTPUTS_TABLE__;
CREATE POLICY tenant_isolation ON __INGEST_JOB_OUTPUTS_TABLE__
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
