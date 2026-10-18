// Shared pieces of the retention deletes (rag/retention.js). Each store owns
// its own statement; this module only normalizes the cutoffs the sweep hands
// it and renders the two CTEs every PostgreSQL statement starts with.
//
// A sweep passes each store one global cutoff (an ISO timestamp: rows last
// touched before it have expired) and, when per-workspace retention policies
// exist, a list of { workspaceId, cutoff } overrides. An override's cutoff is
// an ISO timestamp or null, and null means "keep this workspace's rows
// forever".

const DAY_MS = 24 * 60 * 60 * 1000;

// What PostgreSQL reads as "earlier than every timestamp": a row is never
// older than it, so a workspace whose policy keeps its data forever matches
// nothing.
export const RETENTION_KEEP_FOREVER = "-infinity";

const toTimestamp = (value) => {
  if (value === null || value === undefined || value === "") {
    return Number.NaN;
  }

  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));

  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
};

/**
 * The cutoff `days` whole days before `now` (milliseconds), or null when the
 * data is kept forever (0 or fewer days, or a date JavaScript cannot
 * represent).
 */
export const computeRetentionCutoff = ({ days, now }) => {
  const wholeDays = Math.floor(Number(days));

  if (!Number.isFinite(wholeDays) || wholeDays <= 0) {
    return null;
  }

  const date = new Date(Number(now) - wholeDays * DAY_MS);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Validates the cutoffs a store is handed. Returns
 *   { cutoff, upperBound, workspaceIds, workspaceCutoffs, overrides }
 * where `upperBound` is the latest cutoff of all (every expired row is older
 * than it, which lets the statement use its timestamp index), the two arrays
 * are the overrides as bind values (RETENTION_KEEP_FOREVER for a kept
 * workspace), and `overrides` is a Map of workspace id to a timestamp in
 * milliseconds (-Infinity for a kept workspace) for in-memory stores. Throws a
 * TypeError on a missing or invalid global cutoff, so a bug never turns into
 * "delete everything".
 */
export const normalizeRetentionCutoffs = ({ cutoff, workspaceCutoffs = [] } = {}) => {
  const globalTimestamp = toTimestamp(cutoff);

  if (!Number.isFinite(globalTimestamp)) {
    throw new TypeError("A retention delete needs a valid cutoff timestamp.");
  }

  const overrides = new Map();

  for (const entry of Array.isArray(workspaceCutoffs) ? workspaceCutoffs : []) {
    const workspaceId = typeof entry?.workspaceId === "string" ? entry.workspaceId : "";

    if (!workspaceId || overrides.has(workspaceId)) {
      continue;
    }

    if (entry.cutoff === null || entry.cutoff === undefined) {
      overrides.set(workspaceId, Number.NEGATIVE_INFINITY);
      continue;
    }

    const timestamp = toTimestamp(entry.cutoff);

    if (!Number.isFinite(timestamp)) {
      throw new TypeError(`The retention cutoff of workspace "${workspaceId}" is not a valid timestamp.`);
    }

    overrides.set(workspaceId, timestamp);
  }

  const upperBound = Math.max(
    globalTimestamp,
    ...[...overrides.values()].filter((timestamp) => Number.isFinite(timestamp))
  );

  return {
    cutoff: new Date(globalTimestamp).toISOString(),
    overrides,
    upperBound: new Date(upperBound).toISOString(),
    workspaceCutoffs: [...overrides.values()].map((timestamp) =>
      Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : RETENTION_KEEP_FOREVER
    ),
    workspaceIds: [...overrides.keys()],
  };
};

/**
 * For in-memory stores: whether a record of `workspaceId` last touched at
 * `timestamp` (ISO text) has expired under the normalized cutoffs. A record
 * whose timestamp cannot be read never expires.
 */
export const isRetentionExpired = (normalized, { timestamp, workspaceId }) => {
  const recordTimestamp = toTimestamp(timestamp);

  if (!Number.isFinite(recordTimestamp)) {
    return false;
  }

  const override = normalized.overrides.get(String(workspaceId ?? ""));
  const cutoff = override === undefined ? Date.parse(normalized.cutoff) : override;

  return recordTimestamp < cutoff;
};

/** A positive whole batch size, 500 when the caller passed none. */
export const normalizeRetentionBatchLimit = (limit) => {
  const value = Math.floor(Number(limit));

  return Number.isFinite(value) && value > 0 ? Math.min(value, 10_000) : 500;
};

/** The advisory-lock key of one table's retention delete. */
export const buildRetentionLockKey = (tableName) => `archive_rag:retention:${tableName}`;

/**
 * The CTEs every PostgreSQL retention statement starts with:
 *
 *   retention_lock       a transaction-scoped try-lock on the table's key. The
 *                        statement is its own implicit transaction, so the
 *                        lock is held exactly while it runs; a second
 *                        instance sweeping the same table at the same moment
 *                        gets `acquired = false` and deletes nothing. The
 *                        function is volatile, so the CTE is evaluated once.
 *   retention_overrides  the per-workspace cutoffs as rows.
 *
 * `lockKey`, `workspaceIds` and `workspaceCutoffs` are the numbers of the
 * bind parameters that carry them.
 */
export const renderRetentionPreludeCtes = ({ lockKey, workspaceCutoffs, workspaceIds }) => `
  retention_lock AS (
    SELECT pg_try_advisory_xact_lock(hashtextextended($${lockKey}::text, 0)) AS acquired
  ),
  retention_overrides AS (
    SELECT o.workspace_id, o.cutoff::timestamptz AS cutoff
    FROM unnest($${workspaceIds}::text[], $${workspaceCutoffs}::text[]) AS o(workspace_id, cutoff)
  )`;

/** `acquired` as the statement returned it; a row without one counts as acquired. */
export const readRetentionLockAcquired = (row) => row?.acquired !== false;
