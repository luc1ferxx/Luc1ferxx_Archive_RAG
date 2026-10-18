import { createHash } from "node:crypto";

// Tamper evidence for admin audit events (migration 041).
//
// Every event a store writes from migration 041 on carries `prev_hash` (the
// `row_hash` of the event before it in the same chain, null for the first) and
// `row_hash` = sha256(prev_hash || canonical row), hex. A chain is what one
// tenant can read back under migration 032's policy, so a tenant request can
// extend its own chain without seeing anyone else's:
//
//   * a workspace's events (workspace_id <> ''), whichever user wrote them;
//   * for events without a workspace, one user's events.
//
// The PostgreSQL store serializes the writers of one chain with a
// transaction-scoped advisory lock (rag/postgres-admin-audit-store.js), so
// concurrent inserts extend the head one after another and the chain's order
// is the table's id order. `npm run audit:verify` (audit-verify.mjs) walks
// every chain in id order with createAdminAuditChainVerifier and reports the
// first break of each:
//
//   row_hash_mismatch   the row's content no longer hashes to its row_hash: the
//                       row was changed after it was written.
//   prev_hash_mismatch  the row does not name the row before it: a row was
//                       deleted, reordered or rewritten (hash included) before
//                       it.
//   unchained_row       a row without hashes after the chain started: written
//                       around the store, or its hashes were removed.
//
// What a chain cannot show by itself: rows removed from its start (the
// retention purge does that by design, so a first row that names a
// predecessor is reported as `startsAfterPurge`, not as a break) or from its
// end. Recording each chain's head hash somewhere else (audit:verify prints
// them) and comparing on the next run closes the second gap.
//
// Rows written before migration 041 have no hashes; a chain starts at its
// first hashed row and the older rows are counted as legacy rows.
//
// A rolling upgrade writes unhashed rows after a chain started: the first new
// instance runs migration 041 and chains its events, while an instance still
// on older code keeps inserting rows without hashes into the same chains. The
// writer's head lookup skips unhashed rows, so the hashed rows around them
// still link up. The verifier therefore takes an upgrade window
// (`upgradeWindowEndsAt`, audit:verify: when migration 041 ran plus a grace
// period): an unhashed row is counted as an upgrade row, not a break, when its
// own created_at and the created_at of its chain's head at that point are both
// at or before the window's end. Outside the window it is still an
// unchained_row break. An upgrade row is not verified (like a legacy row); the
// head stays the last hashed row, so a hashed row whose hashes were removed
// is still caught at the next row of its chain (prev_hash_mismatch).

export const ADMIN_AUDIT_CHAIN_VERSION = 1;

export const ADMIN_AUDIT_CHAIN_BREAKS = Object.freeze({
  prevHashMismatch: "prev_hash_mismatch",
  rowHashMismatch: "row_hash_mismatch",
  unchainedRow: "unchained_row",
});

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * JSON with every object's keys sorted (code unit order) and no whitespace, so
 * an object read back from JSONB (which reorders keys) serializes exactly as
 * the object that was written. Members whose value is undefined are left out,
 * as JSON.stringify leaves them out.
 */
export const canonicalizeAuditJson = (value) => {
  if (value === undefined || value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeAuditJson(entry)).join(",")}]`;
  }

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeAuditJson(value[key])}`)
    .join(",")}}`;
};

const toText = (value) => (value === null || value === undefined ? "" : String(value));

const toJsonObject = (value) => {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return isPlainObject(value) ? value : {};
};

/**
 * An ISO timestamp with millisecond precision, the precision the store writes
 * and node-pg reads back, or "" when the value is not a date.
 */
export const normalizeAuditTimestamp = (value) => {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

// A JSON column as a value: text is parsed (and kept as text when it is not
// JSON), anything else is taken as read.
const toJsonValue = (value) => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const hasStoredValue = (value) => value !== null && value !== undefined;

/**
 * What a row's hash covers: every stored column except `id` (assigned by the
 * sequence after the hash is computed) and the two hash columns. The owner
 * columns are the ones the row was written under, so moving a row to another
 * chain changes its hash too.
 *
 * `details` (migration 038, a nullable column only tenant lifecycle events
 * fill: the erase tombstone and the export record) is covered only when the
 * row has one, so every row without it hashes exactly as before the column
 * existed, and setting, changing or clearing a tombstone's details breaks the
 * chain like any other change.
 */
export const buildAdminAuditChainPayload = (row = {}) => ({
  action_id: toText(row.action_id),
  authorization_decision: toJsonObject(row.authorization_decision),
  created_at: normalizeAuditTimestamp(row.created_at),
  data_access: toJsonObject(row.data_access),
  ...(hasStoredValue(row.details) ? { details: toJsonValue(row.details) } : {}),
  event_id: toText(row.event_id),
  event_type: toText(row.event_type),
  method: toText(row.method),
  path: toText(row.path),
  permission_id: toText(row.permission_id),
  principal: toJsonObject(row.principal),
  request: toJsonObject(row.request),
  result: toText(row.result),
  route: toText(row.route),
  user_id: toText(row.user_id),
  v: ADMIN_AUDIT_CHAIN_VERSION,
  workspace_id: toText(row.workspace_id),
});

export const computeAdminAuditRowHash = (prevHash, row = {}) =>
  createHash("sha256")
    .update(`${prevHash ?? ""}${canonicalizeAuditJson(buildAdminAuditChainPayload(row))}`, "utf8")
    .digest("hex");

/**
 * The chain a row with these owner columns belongs to: its workspace, or, for
 * a row without one, its user. Two rows are in one chain exactly when the
 * returned pairs are equal.
 */
export const getAdminAuditChainOwner = ({ userId = "", workspaceId = "" } = {}) => {
  const workspace = toText(workspaceId);

  return workspace
    ? { userId: "", workspaceId: workspace }
    : { userId: toText(userId), workspaceId: "" };
};

const describeChainKey = (owner) => JSON.stringify([owner.workspaceId, owner.userId]);

/**
 * The advisory lock key of one chain of one table (JSON keeps the parts apart
 * whatever an id contains).
 */
export const getAdminAuditChainLockKey = (tableName, owner = {}) => {
  const chain = getAdminAuditChainOwner(owner);

  return JSON.stringify([
    "archive_rag:admin_audit_chain",
    toText(tableName),
    chain.workspaceId,
    chain.userId,
  ]);
};

/**
 * The newer of the event's own time and the chain head's, so a chain's
 * created_at never goes backwards in id order (an instance whose clock lags
 * would otherwise write an older time after a newer one, and the retention
 * purge, which deletes by time, could then remove a row from the middle of a
 * chain instead of from its start).
 */
export const resolveChainedCreatedAt = ({ createdAt, headCreatedAt, now = () => new Date().toISOString() } = {}) => {
  const own = normalizeAuditTimestamp(createdAt) || normalizeAuditTimestamp(now());
  const head = normalizeAuditTimestamp(headCreatedAt);

  return head && head > own ? head : own;
};

const toRowId = (value) => {
  const id = Number(value);

  return Number.isFinite(id) ? id : NaN;
};

const toPublicChain = (chain) => ({
  break: chain.break,
  firstId: chain.firstId,
  headHash: chain.headHash,
  lastId: chain.lastId,
  rows: chain.rows,
  startsAfterPurge: chain.startsAfterPurge,
  upgradeRows: chain.upgradeRows,
  userId: chain.owner.userId,
  workspaceId: chain.owner.workspaceId,
});

/**
 * Verifies chains row by row. `add(row)` takes stored rows (the table's column
 * names; JSON columns as objects or text) in ascending id order, across
 * chains; `report()` summarizes. After a chain's first break its later rows
 * are counted but not checked.
 *
 * `upgradeWindowEndsAt` (a time; none by default): an unhashed row after its
 * chain started is an upgrade row rather than an unchained_row break when it
 * and its chain's head were both written at or before that time (see the
 * header).
 */
export const createAdminAuditChainVerifier = ({ upgradeWindowEndsAt = "" } = {}) => {
  const chains = new Map();
  const windowEndsAt = normalizeAuditTimestamp(upgradeWindowEndsAt);
  let lastId = -Infinity;
  let legacyRows = 0;
  let rowsScanned = 0;
  let chainedRows = 0;
  let upgradeRows = 0;

  // ISO timestamps of one precision compare as text.
  const isUpgradeRow = (row, chain) => {
    if (!windowEndsAt || !chain.headCreatedAt) {
      return false;
    }

    const createdAt = normalizeAuditTimestamp(row.created_at);

    return Boolean(createdAt) && createdAt <= windowEndsAt && chain.headCreatedAt <= windowEndsAt;
  };

  const getChain = (row) => {
    const owner = getAdminAuditChainOwner({ userId: row.user_id, workspaceId: row.workspace_id });
    const key = describeChainKey(owner);
    let chain = chains.get(key);

    if (!chain) {
      chain = {
        break: null,
        firstId: null,
        headCreatedAt: "",
        headHash: null,
        lastId: null,
        owner,
        rows: 0,
        startsAfterPurge: false,
        started: false,
        upgradeRows: 0,
      };
      chains.set(key, chain);
    }

    return chain;
  };

  const recordBreak = (chain, row, kind) => {
    chain.break = {
      eventId: toText(row.event_id),
      kind,
      rowId: toRowId(row.id),
    };
  };

  return {
    add(row = {}) {
      const id = toRowId(row.id);

      if (!Number.isFinite(id) || id <= lastId) {
        throw new Error(
          `Admin audit rows must be verified in ascending id order (row ${String(row.id)} after ${String(lastId)}).`
        );
      }

      lastId = id;
      rowsScanned += 1;

      const chain = getChain(row);
      const rowHash = row.row_hash ? String(row.row_hash) : null;
      const prevHash = row.prev_hash ? String(row.prev_hash) : null;

      if (!chain.started && !rowHash) {
        legacyRows += 1;
        return;
      }

      // An older instance's insert during a rolling upgrade: not chained and
      // not verified, and the head stays the last hashed row.
      if (!rowHash && !chain.break && isUpgradeRow(row, chain)) {
        upgradeRows += 1;
        chain.upgradeRows += 1;
        return;
      }

      chainedRows += 1;
      chain.rows += 1;
      chain.lastId = id;

      if (chain.break) {
        return;
      }

      if (!rowHash) {
        recordBreak(chain, row, ADMIN_AUDIT_CHAIN_BREAKS.unchainedRow);
        return;
      }

      if (!chain.started) {
        chain.started = true;
        chain.firstId = id;
        chain.startsAfterPurge = prevHash !== null;
      } else if (prevHash !== chain.headHash) {
        recordBreak(chain, row, ADMIN_AUDIT_CHAIN_BREAKS.prevHashMismatch);
        return;
      }

      if (computeAdminAuditRowHash(prevHash, row) !== rowHash) {
        recordBreak(chain, row, ADMIN_AUDIT_CHAIN_BREAKS.rowHashMismatch);
        return;
      }

      chain.headHash = rowHash;
      chain.headCreatedAt = normalizeAuditTimestamp(row.created_at);
    },

    report() {
      const started = [...chains.values()].filter((chain) => chain.started || chain.break);
      const brokenChains = started.filter((chain) => chain.break);

      return {
        brokenChainCount: brokenChains.length,
        chainCount: started.length,
        chainedRows,
        chains: started.map(toPublicChain),
        legacyRows,
        rowsScanned,
        status: brokenChains.length > 0 ? "broken" : "ok",
        upgradeRows,
        upgradeWindowEndsAt: windowEndsAt || null,
      };
    },
  };
};

export const verifyAdminAuditChains = (rows = [], options = {}) => {
  const verifier = createAdminAuditChainVerifier(options);

  for (const row of rows) {
    verifier.add(row);
  }

  return verifier.report();
};
