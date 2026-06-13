import {
  getTaskEventsPostgresTable,
  getTasksPostgresTable,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { queryPostgres } from "./postgres.js";
import {
  buildTaskScopeKey,
  normalizeTask,
  normalizeTaskAccessScope,
  TASK_STATUSES,
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

const toJsonParam = (value) =>
  value === null || value === undefined ? null : JSON.stringify(value);

const toJsonObjectParam = (value) =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value) ? value : {}
  );

const toIsoText = (value) => {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? normalizeText(value) : date.toISOString();
};

const taskSelectColumns = `
  user_id,
  workspace_id,
  task_id,
  type,
  status,
  label,
  summary,
  provider,
  subject,
  runner_id,
  action,
  counts,
  input,
  items,
  result,
  error,
  payload,
  required_user_action,
  attempt_count,
  next_run_at,
  claimed_by,
  claimed_at,
  created_at,
  updated_at
`;

const mapRowToTask = (row = {}) => {
  const accessScope = normalizeTaskAccessScope({
    userId: row.user_id,
    workspaceId: row.workspace_id,
  });
  const normalizedTask = normalizeTask({
    id: row.task_id,
    type: row.type,
    status: row.status,
    label: row.label,
    summary: row.summary,
    provider: parseJsonValue(row.provider, null),
    subject: parseJsonValue(row.subject, null),
    runnerId: row.runner_id,
    action: row.action,
    counts: parseJsonValue(row.counts, {}),
    input: parseJsonValue(row.input, {}),
    items: parseJsonValue(row.items, []),
    result: parseJsonValue(row.result, {}),
    error: parseJsonValue(row.error, null),
    payload: parseJsonValue(row.payload, null),
    requiredUserAction: row.required_user_action,
    createdAt: toIsoText(row.created_at),
    updatedAt: toIsoText(row.updated_at),
  });

  if (!normalizedTask) {
    return null;
  }

  return {
    ...normalizedTask,
    accessScope,
    attemptCount: Number(row.attempt_count ?? 0) || 0,
    claimedAt: toIsoText(row.claimed_at),
    claimedBy: normalizeText(row.claimed_by),
    nextRunAt: toIsoText(row.next_run_at),
    scopeKey: buildTaskScopeKey(accessScope),
  };
};

export const createPostgresTaskStore = ({
  eventsTableName = getTaskEventsPostgresTable(),
  now = () => new Date().toISOString(),
  query = queryPostgres,
  runMigrations = runPostgresMigrations,
  tableName = getTasksPostgresTable(),
} = {}) => {
  const tasksTable = ensureTableName(tableName, "TASKS_POSTGRES_TABLE");
  const taskEventsTable = ensureTableName(
    eventsTableName,
    "TASK_EVENTS_POSTGRES_TABLE"
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

  const recordEvent = async ({
    accessScope = {},
    eventPayload = {},
    eventType,
    taskId,
  } = {}) => {
    const scope = normalizeTaskAccessScope(accessScope);

    await query(
      `
        INSERT INTO ${taskEventsTable} (
          user_id,
          workspace_id,
          task_id,
          event_type,
          event_payload
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        scope.userId,
        scope.workspaceId,
        normalizeText(taskId),
        normalizeText(eventType),
        JSON.stringify(eventPayload ?? {}),
      ]
    );
  };

  return {
    async initialize() {
      return initialize();
    },

    async delete({ accessScope = {}, taskId } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedTaskId = normalizeText(taskId);
      const result = await query(
        `
          DELETE FROM ${tasksTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND task_id = $3
        `,
        [scope.userId, scope.workspaceId, normalizedTaskId]
      );
      const deleted = Number(result.rowCount ?? 0) > 0;

      if (deleted) {
        await recordEvent({
          accessScope: scope,
          eventPayload: {
            taskId: normalizedTaskId,
          },
          eventType: "task_delete",
          taskId: normalizedTaskId,
        });
      }

      return deleted;
    },

    async get({ accessScope = {}, taskId } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const result = await query(
        `
          SELECT ${taskSelectColumns}
          FROM ${tasksTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND task_id = $3
          LIMIT 1
        `,
        [scope.userId, scope.workspaceId, normalizeText(taskId)]
      );

      return result.rows[0] ? mapRowToTask(result.rows[0]) : null;
    },

    async list({ accessScope = {}, type = "" } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedType = normalizeText(type);
      const result = await query(
        `
          SELECT ${taskSelectColumns}
          FROM ${tasksTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND ($3 = '' OR type = $3)
          ORDER BY updated_at DESC, task_id ASC
        `,
        [scope.userId, scope.workspaceId, normalizedType]
      );

      return result.rows.map(mapRowToTask).filter(Boolean);
    },

    async listRecoverable({
      statuses = [TASK_STATUSES.queued, TASK_STATUSES.running],
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
          SELECT ${taskSelectColumns}
          FROM ${tasksTable}
          WHERE status = ANY($1::text[])
          ORDER BY updated_at ASC, task_id ASC
        `,
        [normalizedStatuses]
      );

      return result.rows.map(mapRowToTask).filter(Boolean);
    },

    async patch({ accessScope = {}, taskId, patch = {} } = {}) {
      const existingTask = await this.get({
        accessScope,
        taskId,
      });

      if (!existingTask) {
        return null;
      }

      const task = await this.upsert({
        accessScope,
        task: {
          ...existingTask,
          ...patch,
          counts: {
            ...existingTask.counts,
            ...(patch.counts && typeof patch.counts === "object"
              ? patch.counts
              : {}),
          },
          input: {
            ...existingTask.input,
            ...(patch.input && typeof patch.input === "object"
              ? patch.input
              : {}),
          },
          items: patch.items ?? existingTask.items,
          result: {
            ...existingTask.result,
            ...(patch.result && typeof patch.result === "object"
              ? patch.result
              : {}),
          },
          payload:
            patch.payload === undefined ? existingTask.payload : patch.payload,
        },
      });

      await recordEvent({
        accessScope,
        eventPayload: {
          patch,
          status: task?.status,
        },
        eventType: "task_patch",
        taskId,
      });

      return task;
    },

    async upsert({ accessScope = {}, task } = {}) {
      await initialize();

      const normalizedTask = normalizeTask(task);

      if (!normalizedTask) {
        throw new Error("Task requires id and type.");
      }

      const scope = normalizeTaskAccessScope(accessScope);
      const timestamp = now();
      const result = await query(
        `
          INSERT INTO ${tasksTable} (
            user_id,
            workspace_id,
            task_id,
            type,
            status,
            label,
            summary,
            provider,
            subject,
            runner_id,
            action,
            counts,
            input,
            items,
            result,
            error,
            payload,
            required_user_action,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8::jsonb,
            $9::jsonb,
            $10,
            $11,
            $12::jsonb,
            $13::jsonb,
            $14::jsonb,
            $15::jsonb,
            $16::jsonb,
            $17::jsonb,
            $18,
            COALESCE(NULLIF($19::text, '')::timestamptz, $21::timestamptz),
            COALESCE(NULLIF($20::text, '')::timestamptz, $21::timestamptz)
          )
          ON CONFLICT (user_id, workspace_id, task_id)
          DO UPDATE SET
            type = EXCLUDED.type,
            status = EXCLUDED.status,
            label = EXCLUDED.label,
            summary = EXCLUDED.summary,
            provider = EXCLUDED.provider,
            subject = EXCLUDED.subject,
            runner_id = EXCLUDED.runner_id,
            action = EXCLUDED.action,
            counts = EXCLUDED.counts,
            input = EXCLUDED.input,
            items = EXCLUDED.items,
            result = EXCLUDED.result,
            error = EXCLUDED.error,
            payload = EXCLUDED.payload,
            required_user_action = EXCLUDED.required_user_action,
            created_at = COALESCE(
              NULLIF($19::text, '')::timestamptz,
              ${tasksTable}.created_at
            ),
            updated_at = COALESCE(
              NULLIF($20::text, '')::timestamptz,
              $21::timestamptz
            )
          RETURNING ${taskSelectColumns}
        `,
        [
          scope.userId,
          scope.workspaceId,
          normalizedTask.id,
          normalizedTask.type,
          normalizedTask.status,
          normalizedTask.label,
          normalizedTask.summary,
          toJsonParam(normalizedTask.provider),
          toJsonParam(normalizedTask.subject),
          normalizedTask.runnerId,
          normalizedTask.action,
          toJsonObjectParam(normalizedTask.counts),
          toJsonObjectParam(normalizedTask.input),
          JSON.stringify(normalizedTask.items),
          toJsonObjectParam(normalizedTask.result),
          toJsonParam(normalizedTask.error),
          toJsonParam(normalizedTask.payload),
          normalizedTask.requiredUserAction,
          normalizedTask.createdAt,
          normalizedTask.updatedAt,
          timestamp,
        ]
      );
      const storedTask = result.rows[0] ? mapRowToTask(result.rows[0]) : null;

      await recordEvent({
        accessScope: scope,
        eventPayload: {
          status: storedTask?.status,
        },
        eventType: "task_upsert",
        taskId: normalizedTask.id,
      });

      return storedTask;
    },
  };
};
