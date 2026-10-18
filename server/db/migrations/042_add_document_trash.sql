-- Document trash (DOCUMENT_TRASH_RETENTION_HOURS, rag/document-trash.js).
--
-- With the setting above 0, DELETE /documents/:docId and POST /documents/clear
-- no longer delete the document row: they remove its chunks from every live
-- index version table and its queued ingest jobs at once, as a delete does,
-- and keep the row with its stored bytes, marked here. POST
-- /documents/:docId/restore re-chunks and re-embeds those bytes and clears the
-- mark; the retention sweep deletes rows that have been in the trash longer
-- than the setting (and runs DOCUMENT_DELETE_REDACTION then, not at trash
-- time, so a restore loses nothing). With the setting at 0 nothing sets the
-- columns and every row keeps NULL.
--
-- * deleted_at: when the document went into the trash; NULL for a document.
--   Every read of the documents a tenant works with (the registry's loads,
--   the file download, the content-hash lookup, a replacement's row lock, the
--   async enqueue's duplicate check, the index-version builder) adds
--   `deleted_at IS NULL`, whether or not the trash is switched on now, so a
--   row trashed while it was on stays out of search after it is switched off.
-- * deleted_by_user_id / deleted_by_workspace_id: the access scope of the
--   request that deleted it. The purge redacts that scope's records, which is
--   what an immediate delete by the same request would have redacted.
--
-- The row keeps its owner columns, so the tenant_isolation policy of migration
-- 013 and the system_access policy of 035 cover the new columns unchanged; the
-- tenant role's table grant (013) covers the UPDATE that trashes and restores,
-- and the system role's (035) the purge's DELETE, so no grant is added. The
-- storage quota (migration 037's storage_totals) keeps counting a trashed
-- document until it is purged: its bytes are still stored.
--
-- The partial index serves the purge, which reads the oldest trashed rows
-- first; it holds trashed rows only.

ALTER TABLE __DOCUMENTS_TABLE__
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS deleted_by_workspace_id TEXT;

CREATE INDEX IF NOT EXISTS __DOCUMENTS_TABLE___deleted_at_idx
  ON __DOCUMENTS_TABLE__ (deleted_at, doc_id)
  WHERE deleted_at IS NOT NULL;
