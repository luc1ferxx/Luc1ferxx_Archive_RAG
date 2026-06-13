import {
  getAgentRunEventsPostgresTable,
  getAgentRunsPostgresTable,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { queryPostgres } from "./postgres.js";
import {
  AGENT_RUN_STATUSES,
  normalizeAgentRun,
  normalizeAgentRunEvent,
} from "./agent-runs.js";
import {
  buildTaskScopeKey,
  normalizeTaskAccessScope,
} from "./tasks.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ensureTableName = (tableName, envName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `${envName} must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

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

const toJsonArrayParam = (value) => JSON.stringify(toArray(value));

const toJsonParam = (value) =>
  value === null || value === undefined ? null : JSON.stringify(value);

const toIsoText = (value) => {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? normalizeText(value) : date.toISOString();
};

const agentRunSelectColumns = `
  user_id,
  workspace_id,
  run_id,
  status,
  goal,
  input,
  plan,
  steps,
  observations,
  decisions,
  approval_gates,
  result,
  error,
  created_at,
  updated_at
`;

const mapRowToAgentRun = (row = {}, events = []) => {
  const accessScope = normalizeTaskAccessScope({
    userId: row.user_id,
    workspaceId: row.workspace_id,
  });
  const normalizedRun = normalizeAgentRun({
    runId: row.run_id,
    status: row.status,
    goal: row.goal,
    input: parseJsonValue(row.input, {}),
    plan: parseJsonValue(row.plan, {}),
    steps: parseJsonValue(row.steps, []),
    observations: parseJsonValue(row.observations, []),
    decisions: parseJsonValue(row.decisions, []),
    approvalGates: parseJsonValue(row.approval_gates, []),
    result: parseJsonValue(row.result, {}),
    error: parseJsonValue(row.error, null),
    events,
    createdAt: toIsoText(row.created_at),
    updatedAt: toIsoText(row.updated_at),
  });

  if (!normalizedRun) {
    return null;
  }

  return {
    ...normalizedRun,
    accessScope,
    scopeKey: buildTaskScopeKey(accessScope),
  };
};

const mapEventRowToAgentRunEvent = (row = {}) =>
  normalizeAgentRunEvent({
    eventId: row.event_id,
    type: row.event_type,
    payload: parseJsonValue(row.event_payload, {}),
    createdAt: toIsoText(row.created_at),
  });

export const createPostgresAgentRunStore = ({
  eventsTableName = getAgentRunEventsPostgresTable(),
  now = () => new Date().toISOString(),
  query = queryPostgres,
  runMigrations = runPostgresMigrations,
  tableName = getAgentRunsPostgresTable(),
} = {}) => {
  const runsTable = ensureTableName(tableName, "AGENT_RUNS_POSTGRES_TABLE");
  const runEventsTable = ensureTableName(
    eventsTableName,
    "AGENT_RUN_EVENTS_POSTGRES_TABLE"
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

  const getEvents = async ({ accessScope = {}, runId } = {}) => {
    const scope = normalizeTaskAccessScope(accessScope);
    const result = await query(
      `
        SELECT event_id, event_type, event_payload, created_at
        FROM ${runEventsTable}
        WHERE user_id = $1
          AND workspace_id = $2
          AND run_id = $3
        ORDER BY created_at ASC, event_id ASC
      `,
      [scope.userId, scope.workspaceId, normalizeText(runId)]
    );

    return result.rows.map(mapEventRowToAgentRunEvent).filter(Boolean);
  };

  const upsertRun = async ({ accessScope = {}, run } = {}) => {
    await initialize();

    const normalizedRun = normalizeAgentRun(run);

    if (!normalizedRun) {
      throw new Error("Agent run requires runId and goal.");
    }

    const scope = normalizeTaskAccessScope(accessScope);
    const timestamp = now();
    const result = await query(
      `
        INSERT INTO ${runsTable} (
          user_id,
          workspace_id,
          run_id,
          status,
          goal,
          input,
          plan,
          steps,
          observations,
          decisions,
          approval_gates,
          result,
          error,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          $7::jsonb,
          $8::jsonb,
          $9::jsonb,
          $10::jsonb,
          $11::jsonb,
          $12::jsonb,
          $13::jsonb,
          COALESCE(NULLIF($14::text, '')::timestamptz, $16::timestamptz),
          COALESCE(NULLIF($15::text, '')::timestamptz, $16::timestamptz)
        )
        ON CONFLICT (user_id, workspace_id, run_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          goal = EXCLUDED.goal,
          input = EXCLUDED.input,
          plan = EXCLUDED.plan,
          steps = EXCLUDED.steps,
          observations = EXCLUDED.observations,
          decisions = EXCLUDED.decisions,
          approval_gates = EXCLUDED.approval_gates,
          result = EXCLUDED.result,
          error = EXCLUDED.error,
          created_at = COALESCE(
            NULLIF($14::text, '')::timestamptz,
            ${runsTable}.created_at
          ),
          updated_at = COALESCE(
            NULLIF($15::text, '')::timestamptz,
            $16::timestamptz
          )
        RETURNING ${agentRunSelectColumns}
      `,
      [
        scope.userId,
        scope.workspaceId,
        normalizedRun.runId,
        normalizedRun.status,
        normalizedRun.goal,
        toJsonObjectParam(normalizedRun.input),
        toJsonObjectParam(normalizedRun.plan),
        toJsonArrayParam(normalizedRun.steps),
        toJsonArrayParam(normalizedRun.observations),
        toJsonArrayParam(normalizedRun.decisions),
        toJsonArrayParam(normalizedRun.approvalGates),
        toJsonObjectParam(normalizedRun.result),
        toJsonParam(normalizedRun.error),
        normalizedRun.createdAt,
        normalizedRun.updatedAt,
        timestamp,
      ]
    );
    const events = await getEvents({
      accessScope: scope,
      runId: normalizedRun.runId,
    });

    return result.rows[0] ? mapRowToAgentRun(result.rows[0], events) : null;
  };

  return {
    async initialize() {
      return initialize();
    },

    async appendEvent({ accessScope = {}, event = {}, runId } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedEvent = normalizeAgentRunEvent(event);

      if (!normalizedEvent) {
        throw new Error("Agent run event requires type.");
      }

      const result = await query(
        `
          INSERT INTO ${runEventsTable} (
            user_id,
            workspace_id,
            run_id,
            event_type,
            event_payload
          )
          VALUES ($1, $2, $3, $4, $5::jsonb)
          RETURNING event_id, event_type, event_payload, created_at
        `,
        [
          scope.userId,
          scope.workspaceId,
          normalizeText(runId),
          normalizedEvent.type,
          JSON.stringify(normalizedEvent.payload ?? {}),
        ]
      );

      await query(
        `
          UPDATE ${runsTable}
          SET updated_at = $4::timestamptz
          WHERE user_id = $1
            AND workspace_id = $2
            AND run_id = $3
        `,
        [scope.userId, scope.workspaceId, normalizeText(runId), now()]
      );

      return result.rows[0] ? mapEventRowToAgentRunEvent(result.rows[0]) : null;
    },

    async create({ accessScope = {}, run } = {}) {
      return upsertRun({
        accessScope,
        run,
      });
    },

    async get({ accessScope = {}, runId } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const result = await query(
        `
          SELECT ${agentRunSelectColumns}
          FROM ${runsTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND run_id = $3
          LIMIT 1
        `,
        [scope.userId, scope.workspaceId, normalizeText(runId)]
      );

      if (!result.rows[0]) {
        return null;
      }

      return mapRowToAgentRun(
        result.rows[0],
        await getEvents({
          accessScope: scope,
          runId,
        })
      );
    },

    async list({ accessScope = {}, status = "" } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedStatus = normalizeText(status);
      const result = await query(
        `
          SELECT ${agentRunSelectColumns}
          FROM ${runsTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND ($3 = '' OR status = $3)
          ORDER BY updated_at DESC, run_id ASC
        `,
        [scope.userId, scope.workspaceId, normalizedStatus]
      );

      return result.rows.map((row) => mapRowToAgentRun(row)).filter(Boolean);
    },

    async listRecoverable({
      statuses = [
        AGENT_RUN_STATUSES.running,
        AGENT_RUN_STATUSES.waitingForUser,
      ],
    } = {}) {
      await initialize();

      const normalizedStatuses = toArray(statuses)
        .map(normalizeText)
        .filter(Boolean);

      if (normalizedStatuses.length === 0) {
        return [];
      }

      const result = await query(
        `
          SELECT ${agentRunSelectColumns}
          FROM ${runsTable}
          WHERE status = ANY($1::text[])
          ORDER BY updated_at ASC, run_id ASC
        `,
        [normalizedStatuses]
      );

      return result.rows.map((row) => mapRowToAgentRun(row)).filter(Boolean);
    },

    async update({ accessScope = {}, patch = {}, runId } = {}) {
      const existingRun = await this.get({
        accessScope,
        runId,
      });

      if (!existingRun) {
        return null;
      }

      return upsertRun({
        accessScope,
        run: {
          ...existingRun,
          ...patch,
          input: {
            ...existingRun.input,
            ...(patch.input && typeof patch.input === "object" ? patch.input : {}),
          },
          result: {
            ...existingRun.result,
            ...(patch.result && typeof patch.result === "object"
              ? patch.result
              : {}),
          },
          updatedAt: patch.updatedAt || now(),
        },
      });
    },
  };
};
