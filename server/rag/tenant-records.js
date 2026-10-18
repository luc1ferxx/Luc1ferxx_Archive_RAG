// What one tenant holds in a store, for the tenant erase and export
// (rag/tenant-lifecycle.js).
//
// A tenant selector names a workspace, a user, or both:
//
//   { workspaceId: "acme" }                 every record of workspace acme,
//                                           whichever user it belongs to
//   { workspaceId: "acme", userId: "ann" }  ann's records in acme only
//   { workspaceId: "", userId: "ann" }      ann's records outside any
//                                           workspace (her personal tenant)
//
// A record matches on its stored owner columns exactly (trimmed), never on the
// looser document visibility rule (documentMatchesAccessScope), under which
// ann in acme also sees the workspace's shared documents and her personal ones.
// Long-term memory under LONG_MEMORY_SCOPE=user (the default) belongs to the
// user in every workspace: a selector that names a user takes every row of
// the user, and a workspace-wide one only the rows that carry the workspace
// (written while the scope was `workspace`; userWide below). Under
// `workspace` its rows carry a workspace (migration 045) and match like any
// other table, rows of no workspace (user-level and personal, migration 046)
// only by a selector of the user outside any workspace.
//
// Every store that keeps tenant records offers the same three calls:
//   countTenantRecords(selector)   -> { [table]: { records, active? } }
//   listTenantRecords(selector)    -> [{ table, record }] (memory stores) or
//   iterateTenantRecords(selector) -> async iterable of { table, record }
//   deleteTenantRecords(selector)  -> { [table]: { deleted } }
// The in-memory stores implement them over their maps; the PostgreSQL stores
// build them with createPostgresTenantRecordMethods below.
import { runAsDatabaseSystem, runWithDatabaseTenant } from "./postgres-tenant.js";

export const TENANT_SELECTOR_ERROR_CODE = "TENANT_SELECTOR_INVALID";
export const TENANT_SELECTOR_MAX_ID_LENGTH = 256;

// The statuses that mean "work is in flight" for a record kind. The erase
// refuses a tenant with such work unless it is forced (rag/tenant-lifecycle.js).
export const TENANT_ACTIVE_STATUSES = Object.freeze({
  agent_runs: Object.freeze(["running"]),
  ingest_jobs: Object.freeze(["queued", "running"]),
  tasks: Object.freeze(["queued", "running"]),
});

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const createSelectorError = (message) => {
  const error = new Error(message);

  error.code = TENANT_SELECTOR_ERROR_CODE;
  error.status = 400;
  error.expose = true;
  return error;
};

const normalizeSelectorId = (value, name) => {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw createSelectorError(`${name} must be a string.`);
  }

  const trimmed = value.trim();

  if (trimmed.length > TENANT_SELECTOR_MAX_ID_LENGTH) {
    throw createSelectorError(`${name} must be at most ${TENANT_SELECTOR_MAX_ID_LENGTH} characters.`);
  }

  if (CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw createSelectorError(`${name} must not contain control characters.`);
  }

  return trimmed;
};

/**
 * The normalized, frozen selector. `userId` is null when the selector names no
 * user (a workspace-wide selector): only an absent userId (undefined or null)
 * means that. Throws (status 400, TENANT_SELECTOR_INVALID) when neither a
 * workspace nor a user is named, and when a userId is given but empty after
 * trimming: an empty variable in `--user "$UID"` or a body's `"userId": ""`
 * must not widen a one-user erase or export to every user of the workspace.
 */
export const normalizeTenantSelector = ({ userId = null, workspaceId = "" } = {}) => {
  const normalizedWorkspaceId = normalizeSelectorId(workspaceId, "workspaceId");
  const normalizedUserId = normalizeSelectorId(userId, "userId");

  if (userId !== null && userId !== undefined && !normalizedUserId) {
    throw createSelectorError(
      "userId must not be empty; leave it out to select every user of the workspace."
    );
  }

  if (!normalizedWorkspaceId && !normalizedUserId) {
    throw createSelectorError("Name a workspaceId, a userId, or both.");
  }

  return Object.freeze({
    userId: normalizedUserId || null,
    workspaceId: normalizedWorkspaceId,
  });
};

/** Whether a record whose owner columns are `owner` belongs to `selector`. */
export const tenantSelectorMatches = (selector, owner = {}) => {
  const workspaceId = String(owner?.workspaceId ?? owner?.workspace_id ?? "").trim();
  const userId = String(
    owner?.userId ?? owner?.ownerUserId ?? owner?.user_id ?? owner?.owner_user_id ?? ""
  ).trim();

  return (
    workspaceId === selector.workspaceId &&
    (selector.userId === null || userId === selector.userId)
  );
};

/** For a user-only store (long-term memory, LONG_MEMORY_SCOPE=user): the selector's user, if any. */
export const tenantSelectorMatchesUser = (selector, userId) =>
  selector.userId !== null && String(userId ?? "").trim() === selector.userId;

/**
 * JSON-safe export form of a stored value: bytes as { base64 }, dates as ISO
 * text, bigints as text, Maps and Sets as arrays.
 */
export const toTenantExportValue = (value) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { base64: Buffer.from(value).toString("base64") };
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => [toTenantExportValue(key), toTenantExportValue(entry)]);
  }

  if (value instanceof Set) {
    return [...value].map(toTenantExportValue);
  }

  if (Array.isArray(value)) {
    return value.map(toTenantExportValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toTenantExportValue(entry)])
    );
  }

  return value;
};

/**
 * Counts of listed { table, record } entries per table, with an `active` count
 * for the tables TENANT_ACTIVE_STATUSES names. Every table in `tables`
 * appears, with zero when nothing matched.
 */
export const summarizeTenantRecords = (entries = [], tables = []) => {
  const counts = {};

  for (const table of tables) {
    counts[table] = TENANT_ACTIVE_STATUSES[table] ? { active: 0, records: 0 } : { records: 0 };
  }

  for (const { record, table } of entries) {
    const count =
      counts[table] ??
      (counts[table] = TENANT_ACTIVE_STATUSES[table] ? { active: 0, records: 0 } : { records: 0 });

    count.records += 1;

    if (TENANT_ACTIVE_STATUSES[table]?.includes(String(record?.status ?? ""))) {
      count.active += 1;
    }
  }

  return counts;
};

const SIMPLE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertIdentifier = (value, description) => {
  if (!SIMPLE_IDENTIFIER_PATTERN.test(String(value ?? ""))) {
    throw new Error(`${description} must be a simple PostgreSQL identifier. Received "${value}".`);
  }

  return value;
};

const DEFAULT_PAGE_SIZE = 200;

/**
 * The tenant record calls of a PostgreSQL store over its tables. `tables()`
 * returns, in deletion order:
 *
 *   { name, table, userColumn, workspaceColumn = "workspace_id",
 *     keyColumns, userOnly = false, sweepAfter = false, pageSize,
 *     mapRow(row) }
 *
 * - `name` is the report key (TENANT_ACTIVE_STATUSES names the ones with an
 *   `active` count, read from their `status` column).
 * - `userOnly`: matched on the user alone, whatever its workspace column
 *   holds, and skipped by a workspace-wide selector.
 * - `userWide` (long-term memory under LONG_MEMORY_SCOPE=user): a selector
 *   that names a user matches on the user alone, as `userOnly` does; a
 *   workspace-wide selector matches the workspace column like any table, so
 *   rows that carry the workspace (written while LONG_MEMORY_SCOPE was
 *   `workspace`) go with a workspace erase. Its export reads the user's rows
 *   per workspace they carry, each bound to that (user, workspace) tenant.
 * - `workspaceOnly` (the tenant registry's workspace rows): the table has no
 *   user column (`userColumn` is not needed); it is matched on the workspace
 *   alone and skipped by every selector that names a user. Its pages are
 *   read bound to the workspace without a user.
 * - `sweepAfter`: a child table (events, snapshots, stage outputs) listed
 *   before its parent. It is deleted once more after every table, so a row a
 *   racing writer appended between the two statements does not stay behind.
 * - `keyColumns`: the primary key, for keyset pages in a stable order.
 * - `mapRow(row)`: the exported form of a row (may return a promise).
 *
 * Counting and deleting run in whatever database context the caller bound;
 * rag/tenant-lifecycle.js runs them as the system (runAsDatabaseSystem).
 * Listing binds each (user, workspace) pair as the database tenant
 * (runWithDatabaseTenant), so row-level security bounds every page to that
 * tenant on top of the explicit WHERE; a workspace-wide selector first reads
 * the distinct users of the workspace as the system (ids only). With
 * `allowDelete: false` (the audit log, which an erase keeps) the delete call
 * refuses.
 */
export const createPostgresTenantRecordMethods = ({
  allowDelete = true,
  initialize = async () => true,
  query,
  tables,
}) => {
  const resolveTables = () =>
    tables().map((spec) => ({
      sweepAfter: false,
      mapRow: (row) => row,
      pageSize: DEFAULT_PAGE_SIZE,
      userOnly: false,
      userWide: false,
      workspaceColumn: "workspace_id",
      workspaceOnly: false,
      ...spec,
      table: assertIdentifier(spec.table, `${spec.name} table`),
      userColumn: spec.workspaceOnly
        ? null
        : assertIdentifier(spec.userColumn, `${spec.name} user column`),
      ...(spec.userOnly
        ? {}
        : {
            workspaceColumn: assertIdentifier(
              spec.workspaceColumn ?? "workspace_id",
              `${spec.name} workspace column`
            ),
          }),
      keyColumns: (spec.keyColumns ?? []).map((column) =>
        assertIdentifier(column, `${spec.name} key column`)
      ),
    }));

  const isApplicable = (spec, selector) =>
    (!spec.userOnly || selector.userId !== null) &&
    (!spec.workspaceOnly || selector.userId === null);

  // The selector as SQL over one table, its values appended to `values`.
  const buildWhere = (spec, selector, values) => {
    const clauses = [];

    if (spec.userWide && selector.userId !== null) {
      values.push(selector.userId);
      return `${spec.userColumn} = $${values.length}`;
    }

    if (!spec.userOnly) {
      values.push(selector.workspaceId);
      clauses.push(`${spec.workspaceColumn} = $${values.length}`);
    }

    if (selector.userId !== null && !spec.workspaceOnly) {
      values.push(selector.userId);
      clauses.push(`${spec.userColumn} = $${values.length}`);
    }

    return clauses.join(" AND ");
  };

  const countTable = async (spec, selector) => {
    const values = [];
    const where = buildWhere(spec, selector, values);
    const activeStatuses = TENANT_ACTIVE_STATUSES[spec.name];
    let activeColumn = "";

    if (activeStatuses) {
      values.push([...activeStatuses]);
      activeColumn = `, COUNT(*) FILTER (WHERE status = ANY($${values.length}::text[]))::int AS active`;
    }

    const result = await query(
      `SELECT COUNT(*)::int AS records${activeColumn} FROM ${spec.table} WHERE ${where}`,
      values
    );
    const row = result?.rows?.[0] ?? {};

    return activeStatuses
      ? { active: Number(row.active) || 0, records: Number(row.records) || 0 }
      : { records: Number(row.records) || 0 };
  };

  const deleteTable = async (spec, selector) => {
    const values = [];
    const where = buildWhere(spec, selector, values);
    const result = await query(`DELETE FROM ${spec.table} WHERE ${where}`, values);

    return Number(result?.rowCount ?? 0) || 0;
  };

  const listPairs = async (spec, selector) => {
    if (spec.workspaceOnly) {
      return [{ userId: "", workspaceId: selector.workspaceId }];
    }

    if (selector.userId !== null && spec.userWide) {
      // Every row of the user, each page read as the tenant its row belongs
      // to, so the policy of every workspace (and of the personal scope)
      // admits it: the distinct workspaces of the user's rows, as the system.
      const result = await runAsDatabaseSystem(() =>
        query(
          `SELECT DISTINCT ${spec.workspaceColumn} AS workspace_id FROM ${spec.table} WHERE ${spec.userColumn} = $1 ORDER BY 1`,
          [selector.userId]
        )
      );

      return (result?.rows ?? []).map((row) => ({
        userId: selector.userId,
        workspaceId: String(row.workspace_id ?? ""),
      }));
    }

    if (selector.userId !== null) {
      return [{ userId: selector.userId, workspaceId: selector.workspaceId }];
    }

    const result = await runAsDatabaseSystem(() =>
      query(
        `SELECT DISTINCT ${spec.userColumn} AS user_id FROM ${spec.table} WHERE ${spec.workspaceColumn} = $1 ORDER BY 1`,
        [selector.workspaceId]
      )
    );

    return (result?.rows ?? []).map((row) => ({
      userId: String(row.user_id ?? ""),
      workspaceId: selector.workspaceId,
    }));
  };

  async function* iterateTable(spec, selector) {
    // The pages of a `userWide` table are read per (user, workspace) pair
    // (listPairs), each with that pair's WHERE.
    const pageSpec = spec.userWide ? { ...spec, userWide: false } : spec;

    for (const pair of await listPairs(spec, selector)) {
      const pairSelector = { userId: pair.userId, workspaceId: pair.workspaceId };
      let after = null;

      for (;;) {
        const values = [];
        let where = buildWhere(pageSpec, pairSelector, values);

        if (after && spec.keyColumns.length > 0) {
          const placeholders = after.map((value) => {
            values.push(value);
            return `$${values.length}`;
          });

          where += ` AND (${spec.keyColumns.join(", ")}) > (${placeholders.join(", ")})`;
        }

        values.push(spec.pageSize);

        const orderBy = spec.keyColumns.length > 0 ? ` ORDER BY ${spec.keyColumns.join(", ")}` : "";
        const limit = spec.keyColumns.length > 0 ? ` LIMIT $${values.length}` : "";
        const statementValues = spec.keyColumns.length > 0 ? values : values.slice(0, -1);
        const result = await runWithDatabaseTenant(
          { userId: pair.userId, workspaceId: pair.workspaceId },
          () => query(`SELECT * FROM ${spec.table} WHERE ${where}${orderBy}${limit}`, statementValues)
        );
        const rows = result?.rows ?? [];

        for (const row of rows) {
          // mapRow may be async (it decrypts file bytes, rag/tenant-encryption.js).
          yield { record: toTenantExportValue(await spec.mapRow(row)), table: spec.name };
        }

        if (spec.keyColumns.length === 0 || rows.length < spec.pageSize) {
          break;
        }

        const last = rows[rows.length - 1];

        after = spec.keyColumns.map((column) => last[column]);
      }
    }
  }

  return {
    async countTenantRecords(selector) {
      await initialize();

      const counts = {};

      for (const spec of resolveTables()) {
        counts[spec.name] = isApplicable(spec, selector)
          ? await countTable(spec, selector)
          : { records: 0, notApplicable: true };
      }

      return counts;
    },

    async deleteTenantRecords(selector) {
      if (!allowDelete) {
        throw new Error("These records are kept by a tenant erase.");
      }

      await initialize();

      const specs = resolveTables().filter((spec) => isApplicable(spec, selector));
      const deleted = {};

      for (const spec of specs) {
        deleted[spec.name] = { deleted: await deleteTable(spec, selector) };
      }

      for (const spec of specs.filter((candidate) => candidate.sweepAfter)) {
        deleted[spec.name].deleted += await deleteTable(spec, selector);
      }

      return deleted;
    },

    async *iterateTenantRecords(selector) {
      await initialize();

      for (const spec of resolveTables()) {
        if (isApplicable(spec, selector)) {
          yield* iterateTable(spec, selector);
        }
      }
    },
  };
};

/**
 * The export's mapRow of an event table keyed by a BIGSERIAL every tenant
 * shares (agent run events, task events): the raw id, whose gaps count other
 * tenants' events, becomes `${parent}:${n}`, the event's ordinal among its
 * parent's (`parentColumn`: run_id, task_id) events in id order -- the form
 * the API hands out for run events (rag/agent-runs.js). The listing's keyset
 * pages still use the raw id. Rows must arrive in id order within a (user,
 * workspace) pair, as iterateTenantRecords reads them; make one per listing
 * (inside `tables()`), so the counts start from 1 each time.
 */
export const createExportEventOrdinalMapper = (parentColumn) => {
  const counts = new Map();

  return (row) => {
    const parent = String(row[parentColumn] ?? "");
    const key = JSON.stringify([String(row.user_id ?? ""), String(row.workspace_id ?? ""), parent]);
    const ordinal = (counts.get(key) ?? 0) + 1;

    counts.set(key, ordinal);
    return { ...row, event_id: `${parent}:${ordinal}` };
  };
};
