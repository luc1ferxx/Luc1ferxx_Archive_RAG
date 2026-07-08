import {
  getAdminAuditEventsPostgresTable,
  getAdminAuditRetentionDays,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { queryPostgres } from "./postgres.js";
import {
  buildAdminAuditListResponse,
  compactAdminAuditEvent,
  normalizeAdminAuditQuery,
} from "./admin-audit.js";

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
    eventId: row.event_id,
    principal: parseJsonValue(row.principal, {}),
    request: parseJsonValue(row.request, {}),
    type: row.event_type,
  }),
  _rowId: Number(row.id ?? 0) || 0,
});

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

    const result = await query(
      `
        DELETE FROM ${auditEventsTable}
        WHERE created_at < $1::timestamptz
      `,
      [cutoff]
    );

    return Number(result.rowCount ?? 0) || 0;
  };

  return {
    async initialize() {
      return initialize();
    },

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

      await query(
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
            created_at
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
            COALESCE(NULLIF($14::text, '')::timestamptz, NOW())
          )
          ON CONFLICT (event_id) DO NOTHING
        `,
        [
          compactEvent.eventId,
          compactEvent.type,
          compactEvent.result,
          compactEvent.principal.userId,
          compactEvent.principal.workspaceId,
          compactEvent.authorization.permissionId,
          compactEvent.authorization.actionId,
          compactEvent.request.method,
          compactEvent.request.path,
          compactEvent.request.route,
          toJsonObjectParam(compactEvent.authorization),
          toJsonObjectParam(compactEvent.principal),
          toJsonObjectParam(compactEvent.request),
          compactEvent.createdAt,
        ]
      );
      await pruneExpiredEvents();

      return compactEvent;
    },
  };
};
