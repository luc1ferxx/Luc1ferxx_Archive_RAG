import {
  getAdminAuditEventsPostgresTable,
  getAdminAuditRetentionDays,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import {
  queryPostgres,
  queryPostgresAsOwner,
  withPostgresTransaction,
} from "./postgres.js";
import {
  getActiveDatabaseTenant,
  runAsDatabaseSystem,
} from "./postgres-tenant.js";
import {
  buildAdminAuditListResponse,
  compactAdminAuditEvent,
  normalizeAdminAuditQuery,
  toAdminAuditStoredRow,
  toPublicAdminAuditEvent,
} from "./admin-audit.js";
import { createPostgresTenantRecordMethods } from "./tenant-records.js";
import {
  computeAdminAuditRowHash,
  getAdminAuditChainLockKey,
  getAdminAuditChainOwner,
  resolveChainedCreatedAt,
} from "./admin-audit-chain.js";

export const ADMIN_AUDIT_CHAIN_ISOLATION_ERROR_CODE = "ADMIN_AUDIT_CHAIN_ISOLATION";

// The migration that started the chains (db/migrations): the time it ran, in
// the migrator's own bookkeeping, is when chained writes began.
export const ADMIN_AUDIT_CHAIN_MIGRATION_ID = "041_chain_admin_audit_events.sql";
const MIGRATIONS_TABLE = "schema_migrations";

const CHAIN_ROW_COLUMNS = `
  id,
  event_id,
  event_type,
  result,
  user_id,
  workspace_id,
  permission_id,
  action_id,
  method,
  path,
  route,
  authorization_decision,
  principal,
  request,
  data_access,
  details,
  created_at,
  prev_hash,
  row_hash
`;

const DEFAULT_CHAIN_PAGE_SIZE = 1000;
const MAX_CHAIN_PAGE_SIZE = 10000;
// The cursor scanChainRows declares; it lives only inside its transaction.
const CHAIN_SCAN_CURSOR = "archive_rag_admin_audit_chain_scan";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ensureTableName = (tableName, envName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `${envName} must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const parseJsonValue = (value, fallback) => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toJsonObjectParam = (value) =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value) ? value : {}
  );

const normalizeRetentionDays = (value) => {
  const days = Math.floor(Number(value));

  return Number.isFinite(days) && days > 0 ? days : 0;
};

const toIsoText = (value) => {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

const buildRetentionCutoff = ({ now, retentionDays }) => {
  const days = normalizeRetentionDays(retentionDays);

  if (days <= 0) {
    return "";
  }

  const date = new Date(now());

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  date.setUTCDate(date.getUTCDate() - days);

  return date.toISOString();
};

const mapRowToAuditEvent = (row = {}) => ({
  ...compactAdminAuditEvent({
    authorization: parseJsonValue(row.authorization_decision ?? row.authorization, {}),
    createdAt: toIsoText(row.created_at),
    dataAccess: parseJsonValue(row.data_access, {}),
    // Only tenant lifecycle events carry details (migration 038).
    details: parseJsonValue(row.details, null),
    eventId: row.event_id,
    principal: parseJsonValue(row.principal, {}),
    request: parseJsonValue(row.request, {}),
    type: row.event_type,
  }),
  _rowId: Number(row.id ?? 0) || 0,
});

const mapChainRow = (row = {}) => {
  const { details, ...rest } = row;
  const parsedDetails = parseJsonValue(details, null);

  return {
    ...rest,
    authorization_decision: parseJsonValue(row.authorization_decision, {}),
    data_access: parseJsonValue(row.data_access, {}),
    // As toAdminAuditStoredRow: the key exists only on a row that has details.
    ...(parsedDetails ? { details: parsedDetails } : {}),
    id: Number(row.id),
    principal: parseJsonValue(row.principal, {}),
    request: parseJsonValue(row.request, {}),
  };
};

const normalizeChainPageSize = (value) => {
  const size = Math.floor(Number(value));

  return Number.isFinite(size) && size > 0
    ? Math.min(size, MAX_CHAIN_PAGE_SIZE)
    : DEFAULT_CHAIN_PAGE_SIZE;
};

// A store built over an injected `query` (tests, tools) runs its chain
// statements through that same function, as one "client".
const createQueryTransaction = (query) => (callback) => callback({ query });

const buildWhereClause = (query, values) => {
  const clauses = [];

  const addClause = (sql, value) => {
    values.push(value);
    clauses.push(sql.replace("?", `$${values.length}`));
  };

  if (query.scopeMismatch) {
    clauses.push("FALSE");
  }

  if (query.workspaceId) {
    addClause("workspace_id = ?", query.workspaceId);
  }

  if (query.userId) {
    addClause("user_id = ?", query.userId);
  }

  if (query.actionId) {
    addClause("action_id = ?", query.actionId);
  }

  if (query.permissionId) {
    addClause("permission_id = ?", query.permissionId);
  }

  if (query.result) {
    addClause("result = ?", query.result);
  }

  if (query.from) {
    addClause("created_at >= ?::timestamptz", query.from);
  }

  if (query.to) {
    addClause("created_at <= ?::timestamptz", query.to);
  }

  return clauses.length > 0 ? `WHERE ${clauses.join("\n          AND ")}` : "";
};

export const createPostgresAdminAuditStore = ({
  now = () => new Date().toISOString(),
  query = queryPostgres,
  retentionDays = getAdminAuditRetentionDays(),
  runMigrations = runPostgresMigrations,
  tableName = getAdminAuditEventsPostgresTable(),
  transaction = query === queryPostgres
    ? withPostgresTransaction
    : createQueryTransaction(query),
  // schema_migrations belongs to the owner (migration 035 grants the system
  // role nothing on it), so the default store reads it on the owner login.
  ownerQuery = query === queryPostgres ? queryPostgresAsOwner : query,
} = {}) => {
  const auditEventsTable = ensureTableName(
    tableName,
    "ADMIN_AUDIT_EVENTS_POSTGRES_TABLE"
  );
  let initialized = false;

  const initialize = async () => {
    if (initialized) {
      return true;
    }

    await runMigrations();
    initialized = true;
    return true;
  };

  const pruneExpiredEvents = async () => {
    const cutoff = buildRetentionCutoff({
      now,
      retentionDays,
    });

    if (!cutoff) {
      return 0;
    }

    // Retention applies to every tenant's events, and since migration 032 the
    // tenant role may not delete audit events, so the purge runs as the owner
    // even when a tenant request recorded the event that triggered it.
    const result = await runAsDatabaseSystem(() =>
      query(
        `
          DELETE FROM ${auditEventsTable}
          WHERE created_at < $1::timestamptz
        `,
        [cutoff]
      )
    );

    return Number(result.rowCount ?? 0) || 0;
  };

  return {
    async initialize() {
      return initialize();
    },

    // The tenant export (rag/tenant-records.js): the events whose owner
    // columns are the tenant's. A tenant erase keeps them (the retention
    // purge removes them), so this listing cannot delete.
    ...createPostgresTenantRecordMethods({
      allowDelete: false,
      initialize,
      query,
      tables: () => [
        {
          keyColumns: ["id"],
          mapRow: (row) => toPublicAdminAuditEvent(mapRowToAuditEvent(row)),
          name: "admin_audit_events",
          table: auditEventsTable,
          userColumn: "user_id",
        },
      ],
    }),

    async listEvents(queryOptions = {}) {
      await initialize();

      const normalizedQuery = normalizeAdminAuditQuery(queryOptions);
      const filterValues = [];
      const whereClause = buildWhereClause(normalizedQuery, filterValues);
      const countResult = await query(
        `
          SELECT COUNT(*)::int AS total
          FROM ${auditEventsTable}
          ${whereClause}
        `,
        filterValues
      );
      const total = Number(countResult.rows?.[0]?.total ?? 0) || 0;
      const pageValues = [...filterValues, normalizedQuery.limit, normalizedQuery.offset];
      const limitIndex = pageValues.length - 1;
      const offsetIndex = pageValues.length;
      const result = await query(
        `
          SELECT
            id,
            event_id,
            event_type,
            authorization_decision,
            principal,
            request,
            data_access,
            details,
            created_at
          FROM ${auditEventsTable}
          ${whereClause}
          ORDER BY created_at DESC, id DESC
          LIMIT $${limitIndex}
          OFFSET $${offsetIndex}
        `,
        pageValues
      );

      return buildAdminAuditListResponse({
        events: result.rows.map(mapRowToAuditEvent),
        query: normalizedQuery,
        total,
      });
    },

    async recordEvent(event = {}) {
      await initialize();

      const compactEvent = compactAdminAuditEvent(event);
      // Inside a tenant request the row's owner columns are the bound tenant's
      // own ids, exactly as rag/postgres.js sets them, so migration 032's
      // INSERT policy accepts the event. compactAdminAuditEvent collapses
      // whitespace runs in ids and the tenant settings only trim, so an id
      // such as "a<TAB>b" would otherwise fail the check and the record would
      // be lost (or, on a route that requires its audit record, refuse the
      // action). The principal JSON keeps the compacted ids.
      const tenant = getActiveDatabaseTenant();
      const ownerUserId = tenant ? tenant.userId : compactEvent.principal.userId;
      const ownerWorkspaceId = tenant
        ? tenant.workspaceId
        : compactEvent.principal.workspaceId;

      const owner = { userId: ownerUserId, workspaceId: ownerWorkspaceId };
      const chain = getAdminAuditChainOwner(owner);
      let storedEvent = compactEvent;

      // Tamper evidence (migration 041, rag/admin-audit-chain.js): the event
      // extends its chain -- its workspace's, or its user's without one, which
      // is exactly what migration 032 lets this tenant read back -- under a
      // transaction-scoped advisory lock on that chain, so concurrent writers
      // of one chain take the head one after another and the chain's order is
      // the id order. The head is read in a statement of its own after the
      // lock is held, which under READ COMMITTED sees every row committed
      // before the lock was granted; under REPEATABLE READ or SERIALIZABLE the
      // snapshot would predate the lock and two writers could fork the chain,
      // so the transaction pins READ COMMITTED in its BEGIN whatever the
      // database's default, and the check below stays as a guard.
      await transaction(async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [getAdminAuditChainLockKey(auditEventsTable, owner)]
        );

        const headResult = await client.query(
          `
            SELECT
              current_setting('transaction_isolation') AS isolation,
              head.row_hash,
              head.created_at
            FROM (SELECT 1) AS anchor
            LEFT JOIN LATERAL (
              SELECT row_hash, created_at
              FROM ${auditEventsTable}
              WHERE workspace_id = $1
                AND (CASE WHEN workspace_id = '' THEN user_id ELSE '' END) = $2
                AND row_hash IS NOT NULL
              ORDER BY id DESC
              LIMIT 1
            ) AS head ON TRUE
          `,
          [chain.workspaceId, chain.userId]
        );
        const head = headResult.rows?.[0] ?? {};
        const isolation = String(head.isolation ?? "read committed").toLowerCase();

        if (isolation !== "read committed") {
          const error = new Error(
            `Admin audit events are chained under READ COMMITTED; this transaction runs ${isolation}.`
          );

          error.code = ADMIN_AUDIT_CHAIN_ISOLATION_ERROR_CODE;
          throw error;
        }

        const prevHash = head.row_hash ? String(head.row_hash) : null;

        storedEvent = {
          ...compactEvent,
          createdAt: resolveChainedCreatedAt({
            createdAt: compactEvent.createdAt,
            headCreatedAt: head.created_at,
            now,
          }),
        };

        const row = toAdminAuditStoredRow(storedEvent, owner);
        const rowHash = computeAdminAuditRowHash(prevHash, row);

        await client.query(
          `
            INSERT INTO ${auditEventsTable} (
              event_id,
              event_type,
              result,
              user_id,
              workspace_id,
              permission_id,
              action_id,
              method,
              path,
              route,
              authorization_decision,
              principal,
              request,
              created_at,
              data_access,
              prev_hash,
              row_hash,
              details
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10,
              $11::jsonb,
              $12::jsonb,
              $13::jsonb,
              $14::timestamptz,
              $15::jsonb,
              $16,
              $17,
              $18::jsonb
            )
            ON CONFLICT (event_id) DO NOTHING
          `,
          [
            row.event_id,
            row.event_type,
            row.result,
            row.user_id,
            row.workspace_id,
            row.permission_id,
            row.action_id,
            row.method,
            row.path,
            row.route,
            toJsonObjectParam(row.authorization_decision),
            toJsonObjectParam(row.principal),
            toJsonObjectParam(row.request),
            row.created_at,
            toJsonObjectParam(row.data_access),
            prevHash,
            rowHash,
            row.details ? JSON.stringify(row.details) : null,
          ]
        );
      }, { isolationLevel: "read committed" });
      await pruneExpiredEvents();

      return storedEvent;
    },

    /**
     * One page of stored rows with their chain hashes, in id order, for
     * verification (audit:verify). Every tenant's rows: callers run it as the
     * system (runAsDatabaseSystem), after their own permission check if any.
     * `workspaceId` limits it to that workspace's chain.
     */
    async listChainRows({ afterId = 0, limit = DEFAULT_CHAIN_PAGE_SIZE, workspaceId = "" } = {}) {
      await initialize();

      const values = [Math.max(0, Math.floor(Number(afterId) || 0)), normalizeChainPageSize(limit)];
      const workspace = String(workspaceId ?? "").trim();
      let workspaceClause = "";

      if (workspace) {
        values.push(workspace);
        workspaceClause = `AND workspace_id = $${values.length}`;
      }

      const result = await query(
        `
          SELECT ${CHAIN_ROW_COLUMNS}
          FROM ${auditEventsTable}
          WHERE id > $1
            ${workspaceClause}
          ORDER BY id
          LIMIT $2
        `,
        values
      );

      return (result.rows ?? []).map(mapChainRow);
    },

    /**
     * Every stored row after `afterId` (one workspace's chain with
     * `workspaceId`), in id order, handed to `onPage` `pageSize` rows at a
     * time, all read from ONE snapshot: a cursor declared in one transaction
     * (a cursor keeps the snapshot of its DECLARE whatever the isolation
     * level). Paging with listChainRows takes a new snapshot per page, and
     * ids are assigned at INSERT but become visible at COMMIT, so on a live
     * table a page can end past a row that commits a moment later: the next
     * page starts after it, the row is never read, and its chain's next row
     * then looks like a break (prev_hash_mismatch). In one snapshot a chain's
     * row is visible only with every row before it, because one chain's
     * writers commit one after another under its advisory lock. The
     * transaction holds that snapshot for the whole scan; audit:verify is the
     * only caller. Runs as the caller's context (audit:verify: the system).
     */
    async scanChainRows({ afterId = 0, onPage, pageSize = DEFAULT_CHAIN_PAGE_SIZE, workspaceId = "" } = {}) {
      if (typeof onPage !== "function") {
        throw new TypeError("scanChainRows needs an onPage callback.");
      }

      await initialize();

      const values = [Math.max(0, Math.floor(Number(afterId) || 0))];
      const workspace = String(workspaceId ?? "").trim();
      // An integer the normalizer bounds, so it can be part of FETCH's text
      // (FETCH takes no parameter for its count).
      const fetchSize = normalizeChainPageSize(pageSize);
      let workspaceClause = "";

      if (workspace) {
        values.push(workspace);
        workspaceClause = `AND workspace_id = $${values.length}`;
      }

      let rowsRead = 0;

      await transaction(async (client) => {
        await client.query(
          `
            DECLARE ${CHAIN_SCAN_CURSOR} NO SCROLL CURSOR FOR
            SELECT ${CHAIN_ROW_COLUMNS}
            FROM ${auditEventsTable}
            WHERE id > $1
              ${workspaceClause}
            ORDER BY id
          `,
          values
        );

        for (;;) {
          const result = await client.query(`FETCH FORWARD ${fetchSize} FROM ${CHAIN_SCAN_CURSOR}`);
          const rows = (result.rows ?? []).map(mapChainRow);

          if (rows.length > 0) {
            rowsRead += rows.length;
            await onPage(rows);
          }

          if (rows.length < fetchSize) {
            break;
          }
        }

        await client.query(`CLOSE ${CHAIN_SCAN_CURSOR}`);
      });

      return { rowsRead };
    },

    /**
     * When migration 041 ran (ISO), which is when this deployment's first
     * instance began chaining events, or "" when that cannot be read (no
     * bookkeeping row, or no owner login: the role split without
     * POSTGRES_MIGRATION_DATABASE_URL). audit:verify starts its rolling-upgrade
     * window here. Callers run it as the system.
     */
    async readChainActivation() {
      try {
        const result = await ownerQuery(
          `SELECT applied_at FROM ${MIGRATIONS_TABLE} WHERE id = $1`,
          [ADMIN_AUDIT_CHAIN_MIGRATION_ID]
        );
        const appliedAt = result.rows?.[0]?.applied_at;

        return appliedAt ? toIsoText(appliedAt) : "";
      } catch {
        return "";
      }
    },

    describe() {
      return { table: auditEventsTable };
    },
  };
};
