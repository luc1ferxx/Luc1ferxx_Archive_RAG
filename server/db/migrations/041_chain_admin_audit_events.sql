-- Tamper evidence for admin audit events, and the data-plane access events.
--
-- * prev_hash / row_hash: every event the application writes from now on
--   carries the row_hash of the event before it in its chain (NULL for a
--   chain's first event) and row_hash = sha256(prev_hash || canonical row),
--   hex. A chain is one workspace's events, or, for events without a
--   workspace, one user's: exactly what migration 032 lets one tenant read
--   back, so a tenant request extends its own chain without seeing anyone
--   else's. The store computes the hashes and serializes each chain's writers
--   with a transaction-scoped advisory lock (rag/postgres-admin-audit-store.js,
--   rag/admin-audit-chain.js); `npm run audit:verify` walks every chain in id
--   order and reports the first break of each.
-- * Rows written before this migration keep NULL hashes: each chain starts at
--   its first new row, and the verifier counts the older ones as legacy rows.
-- * data_access: the ids and counts of a data-plane event (document download,
--   delete, clear and replace, memory and session clears, a platform admin's
--   cross-tenant reads), written only with ADMIN_AUDIT_DATA_EVENTS on. An
--   authorization event keeps the empty object.
--
-- No grant changes: the tenant role keeps SELECT and INSERT (migration 032),
-- the system role SELECT, INSERT and DELETE (migration 035), and no one
-- UPDATEs an event, so a stored hash can only change on the owner login.
-- Adding a column with a constant default rewrites no rows.

ALTER TABLE __ADMIN_AUDIT_EVENTS_TABLE__
  ADD COLUMN IF NOT EXISTS data_access JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS prev_hash TEXT,
  ADD COLUMN IF NOT EXISTS row_hash TEXT;

-- The head of one chain: its newest hashed row. The expression is the one the
-- store's head lookup filters on (the user only counts without a workspace).
CREATE INDEX IF NOT EXISTS __ADMIN_AUDIT_EVENTS_TABLE___chain_head_idx
  ON __ADMIN_AUDIT_EVENTS_TABLE__ (
    workspace_id,
    (CASE WHEN workspace_id = '' THEN user_id ELSE '' END),
    id DESC
  )
  WHERE row_hash IS NOT NULL;
