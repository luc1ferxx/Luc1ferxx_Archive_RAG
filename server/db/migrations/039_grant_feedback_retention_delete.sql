-- Retention of answer feedback (FEEDBACK_RETENTION_DAYS, rag/retention.js).
--
-- Migration 035 gave the system role SELECT and INSERT on the feedback table
-- (migration 034), because until now nothing removed feedback. The retention
-- sweep deletes records older than the configured number of days, of every
-- tenant, as system work (runAsDatabaseSystem): with the role split on
-- (POSTGRES_MIGRATION_DATABASE_URL) that statement runs as the system role,
-- which therefore needs DELETE. Its system_access policy (migration 035) is
-- FOR ALL and already admits the delete. Without the split the statement runs
-- as the login that owns the table, and this grant changes nothing.
--
-- Only DELETE: the sweep's statement takes no row lock (SELECT ... FOR UPDATE
-- would need UPDATE), and no one updates feedback. The tenant role keeps
-- SELECT and INSERT only, so no request may remove a record; retention is the
-- only path that does, and only when an operator sets FEEDBACK_RETENTION_DAYS
-- (default 0, keep forever).

GRANT DELETE ON __FEEDBACK_TABLE__ TO __SYSTEM_ROLE__;
