-- Document deletion cascades (rag/document-deletion-cascade.js).
--
-- Deleting a document (DELETE /documents/:docId, POST /documents/clear) used
-- to leave its text behind in other stores. Three additions let the delete
-- path clean them up; no new table, so no new row policy.
--
-- 1. Ingest jobs: canceled_reason. A queued, retry-waiting or dead-lettered
--    job for a deleted document is settled `failed` with canceled_reason
--    'document_deleted', and its bytes and stage outputs are dropped, always
--    (not behind a flag). NULL on every other job, so nothing else changes.
--    It runs in the deleting request's context, which already may update its
--    own jobs (migration 015's tenant grant, 035's system grant).
--
-- 2. Workspace artifacts: source_deleted / source_deleted_doc_ids. With
--    DOCUMENT_DELETE_REDACTION=on an artifact that cites a deleted document
--    has the quoted text removed and is marked here with the ids of the
--    deleted sources. FALSE / [] on every artifact otherwise; the projections
--    only show the flag once it is set.
--
-- 3. Answer feedback: the system role may UPDATE the citations column, and
--    nothing else. Migration 034 made feedback append-only for the tenant
--    role, and 035 gave the system role SELECT and INSERT only, because no
--    request changed feedback. With DOCUMENT_DELETE_REDACTION=on the delete
--    path replaces a deleted document's citation excerpts in the deleting
--    tenant's own feedback records (an exact owner match in the statement,
--    since the system role passes every row policy), on the system path. The
--    tenant role stays append-only: a request cannot rewrite its feedback, and
--    the column grant keeps the question, the answer and the verdict
--    unchangeable for the system role too. Without the role split the system
--    path runs as the owner login, which needs no grant.

ALTER TABLE __INGEST_JOBS_TABLE__
  ADD COLUMN IF NOT EXISTS canceled_reason TEXT;

ALTER TABLE __WORKSPACE_ARTIFACTS_TABLE__
  ADD COLUMN IF NOT EXISTS source_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source_deleted_doc_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

GRANT UPDATE (citations) ON __FEEDBACK_TABLE__ TO __SYSTEM_ROLE__;
