-- Answer feedback (POST /feedback, GET /feedback, npm run feedback:corpus) per
-- tenant.
--
-- Until now every tenant's feedback went into one JSONL file
-- (data/feedback/feedback.jsonl) that only the application filtered, and an
-- empty scope read all of it. With PostgreSQL configured the feedback store
-- (rag/postgres-feedback-store.js) writes here instead; the file is kept only
-- for the profile without a database. `npm run feedback:import` copies an
-- existing file into this table.
--
-- * owner_user_id / workspace_id are the record's userId / workspaceId, which
--   come from the request's access scope only (feedback.js
--   buildFeedbackRecord).
-- * The tenant_isolation policy matches the exact (user, workspace) pair,
--   empty strings included, as for tasks and runs (migration 013). A record
--   written without a tenant (auth disabled, no user) is visible to no tenant
--   and stays on the owner path.
-- * The tenant role may read and append. No request changes or removes
--   feedback, so UPDATE and DELETE are not granted.
-- * id is the insertion order. GET /feedback lists newest first and keeps
--   insertion order among equal timestamps, as the file's line order did.
-- * The structured fields are json, not jsonb, so a record reads back exactly
--   as it was written: jsonb reorders object keys and refuses the \u0000
--   escape, which the file accepted.
-- * extra holds the top-level fields of an imported record that no column
--   holds (a hand-curated expectedAnswerIncludes, for one), so the import is
--   lossless for feedback:corpus.

CREATE TABLE IF NOT EXISTS __FEEDBACK_TABLE__ (
  id BIGSERIAL PRIMARY KEY,
  feedback_id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT NOT NULL DEFAULT '',
  -- NUMERIC rather than INTEGER: the record keeps any integer the client sent.
  turn_index NUMERIC NULL,
  question TEXT NOT NULL DEFAULT '',
  doc_ids JSON NOT NULL DEFAULT '[]',
  feedback_type TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  answer_text TEXT NOT NULL DEFAULT '',
  agent_mode TEXT NOT NULL DEFAULT '',
  skills JSON NOT NULL DEFAULT '[]',
  claim_checks JSON NOT NULL DEFAULT '[]',
  agent_observability JSON NULL,
  citations JSON NOT NULL DEFAULT '[]',
  extra JSON NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS __FEEDBACK_TABLE___scope_created_idx
  ON __FEEDBACK_TABLE__ (owner_user_id, workspace_id, created_at DESC, id ASC);

-- The owner path (auth disabled without a user) lists every record.
CREATE INDEX IF NOT EXISTS __FEEDBACK_TABLE___created_idx
  ON __FEEDBACK_TABLE__ (created_at DESC, id ASC);

GRANT SELECT, INSERT ON __FEEDBACK_TABLE__ TO __TENANT_ROLE__;

DO $$
DECLARE
  sequence_name text := pg_get_serial_sequence('__FEEDBACK_TABLE__', 'id');
BEGIN
  IF sequence_name IS NOT NULL THEN
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %s TO %I',
      sequence_name,
      '__TENANT_ROLE__'
    );
  END IF;
END
$$;

ALTER TABLE __FEEDBACK_TABLE__ ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON __FEEDBACK_TABLE__;
CREATE POLICY tenant_isolation ON __FEEDBACK_TABLE__
  TO __TENANT_ROLE__
  USING (
    owner_user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  )
  WITH CHECK (
    owner_user_id = current_setting('archive_rag.user_id', true)
    AND workspace_id = current_setting('archive_rag.workspace_id', true)
  );
