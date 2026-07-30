import {
  getTaskEventsPostgresTable,
  getTasksPostgresTable,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { queryPostgres } from "./postgres.js";
import {
  buildTaskScopeKey,
  DEFAULT_TASK_CLAIM_LEASE_MS,
  normalizeTask,
  normalizeTaskAccessScope,
  TASK_MUTATION_OUTCOMES,
  TASK_STATUSES,
} from "./tasks.js";
import { normalizeText } from "../lib/normalize-text.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ensureTableName = (tableName, envName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `${envName} must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

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

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;
const MIN_LIST_LIMIT = 1;

const normalizePaginationParams = ({ limit, offset } = {}) => {
  let normalizedLimit = Number(limit);

  if (limit === "all") {
    // Internal callers pass "all" when correctness needs the complete result
    // set; LIMIT NULL means no limit in PostgreSQL.
    normalizedLimit = null;
  } else if (!Number.isFinite(normalizedLimit) || normalizedLimit < MIN_LIST_LIMIT) {
    normalizedLimit = DEFAULT_LIST_LIMIT;
  } else if (normalizedLimit > MAX_LIST_LIMIT) {
    normalizedLimit = MAX_LIST_LIMIT;
  } else {
    normalizedLimit = Math.floor(normalizedLimit);
  }

  let normalizedOffset = Number(offset);

  if (!Number.isFinite(normalizedOffset) || normalizedOffset < 0) {
    normalizedOffset = 0;
  } else {
    normalizedOffset = Math.floor(normalizedOffset);
  }

  return { limit: normalizedLimit, offset: normalizedOffset };
};

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

const normalizeAttemptCount = (value) => {
  const attemptCount = Number(value);

  return Number.isSafeInteger(attemptCount) && attemptCount >= 0
    ? attemptCount
    : 0;
};

const normalizeLeaseMs = (value) => {
  const leaseMs = Number(value);

  return Number.isFinite(leaseMs) && leaseMs > 0
    ? Math.floor(leaseMs)
    : DEFAULT_TASK_CLAIM_LEASE_MS;
};

const getRetryAt = ({ leaseMs, task } = {}) => {
  if (!task) {
    return "";
  }

  if (task.status === TASK_STATUSES.queued && task.nextRunAt) {
    return toIsoText(task.nextRunAt);
  }

  if (task.status !== TASK_STATUSES.running) {
    return "";
  }

  const leaseStartedAt = new Date(task.claimedAt || task.updatedAt).getTime();

  return Number.isFinite(leaseStartedAt)
    ? new Date(leaseStartedAt + normalizeLeaseMs(leaseMs)).toISOString()
    : "";
};

const mergeTaskPatch = ({ existingTask, patch = {}, timestamp } = {}) => ({
  ...existingTask,
  ...patch,
  attemptCount:
    patch.attemptCount === undefined
      ? normalizeAttemptCount(existingTask.attemptCount)
      : normalizeAttemptCount(patch.attemptCount),
  claimedAt:
    patch.claimedAt === undefined
      ? normalizeText(existingTask.claimedAt)
      : normalizeText(patch.claimedAt),
  claimedBy:
    patch.claimedBy === undefined
      ? normalizeText(existingTask.claimedBy)
      : normalizeText(patch.claimedBy),
  counts: {
    ...existingTask.counts,
    ...(patch.counts && typeof patch.counts === "object" ? patch.counts : {}),
  },
  input: {
    ...existingTask.input,
    ...(patch.input && typeof patch.input === "object" ? patch.input : {}),
  },
  items: patch.items ?? existingTask.items,
  nextRunAt:
    patch.nextRunAt === undefined
      ? normalizeText(existingTask.nextRunAt)
      : normalizeText(patch.nextRunAt),
  payload: patch.payload === undefined ? existingTask.payload : patch.payload,
  result: {
    ...existingTask.result,
    ...(patch.result && typeof patch.result === "object" ? patch.result : {}),
  },
  updatedAt: patch.updatedAt || timestamp,
});

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

  const getTask = async ({ accessScope = {}, taskId } = {}) => {
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
  };

  const getTaskClaimState = async ({
    accessScope = {},
    leaseMs = DEFAULT_TASK_CLAIM_LEASE_MS,
    taskId,
  } = {}) => {
    const scope = normalizeTaskAccessScope(accessScope);
    const normalizedLeaseMs = normalizeLeaseMs(leaseMs);
    const result = await query(
      `
        SELECT
          ${taskSelectColumns},
          CASE
            WHEN status = $5 AND next_run_at IS NOT NULL THEN next_run_at
            WHEN status = $6 THEN
              COALESCE(claimed_at, updated_at)
                + ($4::double precision * INTERVAL '1 millisecond')
            ELSE NULL
          END AS retry_at,
          CASE
            WHEN status = $5 AND next_run_at IS NOT NULL THEN
              GREATEST(
                0,
                CEIL(
                  EXTRACT(EPOCH FROM (next_run_at - clock_timestamp())) * 1000
                )
              )::bigint
            WHEN status = $6 THEN
              GREATEST(
                0,
                CEIL(
                  EXTRACT(
                    EPOCH FROM (
                      COALESCE(claimed_at, updated_at)
                        + ($4::double precision * INTERVAL '1 millisecond')
                        - clock_timestamp()
                    )
                  ) * 1000
                )
              )::bigint
            ELSE 0
          END AS retry_after_ms
        FROM ${tasksTable}
        WHERE user_id = $1
          AND workspace_id = $2
          AND task_id = $3
        LIMIT 1
      `,
      [
        scope.userId,
        scope.workspaceId,
        normalizeText(taskId),
        normalizedLeaseMs,
        TASK_STATUSES.queued,
        TASK_STATUSES.running,
      ]
    );
    const row = result.rows[0];

    if (!row) {
      return {
        retryAfterMs: 0,
        retryAt: "",
        task: null,
      };
    }

    const retryAfterMs = Number(row.retry_after_ms);

    return {
      retryAfterMs:
        Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? Math.ceil(retryAfterMs)
          : normalizedLeaseMs,
      retryAt: toIsoText(row.retry_at) || getRetryAt({
        leaseMs: normalizedLeaseMs,
        task: mapRowToTask(row),
      }),
      task: mapRowToTask(row),
    };
  };

  const updateTaskSnapshot = async ({
    accessScope = {},
    expectedAttemptCount,
    expectedClaimId,
    expectedStatuses = [],
    eventType,
    existingTask,
    patch = {},
    requireClaim = false,
    taskId,
  } = {}) => {
    const scope = normalizeTaskAccessScope(accessScope);
    const timestamp = now();
    const nextTask = mergeTaskPatch({
      existingTask,
      patch,
      timestamp,
    });
    const normalizedTask = normalizeTask(nextTask);
    const result = await query(
      `
        WITH updated_task AS (
          UPDATE ${tasksTable} AS task
          SET
            type = $8,
            status = $9,
            label = $10,
            summary = $11,
            provider = $12::jsonb,
            subject = $13::jsonb,
            runner_id = $14,
            action = $15,
            counts = $16::jsonb,
            input = $17::jsonb,
            items = $18::jsonb,
            result = $19::jsonb,
            error = $20::jsonb,
            payload = $21::jsonb,
            required_user_action = $22,
            next_run_at = NULLIF($23::text, '')::timestamptz,
            claimed_by = $24,
            claimed_at = CASE
              WHEN NULLIF($24::text, '') IS NULL THEN NULL
              ELSE clock_timestamp()
            END,
            updated_at = $25::timestamptz
          WHERE task.user_id = $1
            AND task.workspace_id = $2
            AND task.task_id = $3
            AND task.status = ANY($4::text[])
            AND (
              $5::boolean = false
              OR (
                task.claimed_by = $6
                AND task.attempt_count = $7
              )
            )
          RETURNING ${taskSelectColumns}
        ),
        recorded_event AS (
          INSERT INTO ${taskEventsTable} (
            user_id,
            workspace_id,
            task_id,
            event_type,
            event_payload
          )
          SELECT
            $1,
            $2,
            $3,
            $26,
            jsonb_build_object(
              'attemptCount',
              updated_task.attempt_count,
              'status',
              updated_task.status
            )
          FROM updated_task
          RETURNING 1
        )
        SELECT updated_task.*
        FROM updated_task
        CROSS JOIN recorded_event
      `,
      [
        scope.userId,
        scope.workspaceId,
        normalizeText(taskId),
        toArray(expectedStatuses).map(normalizeText).filter(Boolean),
        Boolean(requireClaim),
        normalizeText(expectedClaimId),
        expectedAttemptCount === undefined
          ? null
          : normalizeAttemptCount(expectedAttemptCount),
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
        normalizeText(nextTask.nextRunAt),
        normalizeText(nextTask.claimedBy),
        normalizedTask.updatedAt || timestamp,
        normalizeText(eventType),
      ]
    );

    return result.rows[0] ? mapRowToTask(result.rows[0]) : null;
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
      return getTask({
        accessScope,
        taskId,
      });
    },

    async list({ accessScope = {}, type = "", limit, offset } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedType = normalizeText(type);
      const pagination = normalizePaginationParams({ limit, offset });
      const result = await query(
        `
          SELECT ${taskSelectColumns}
          FROM ${tasksTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND ($3 = '' OR type = $3)
          ORDER BY updated_at DESC, task_id ASC
          LIMIT $4 OFFSET $5
        `,
        [scope.userId, scope.workspaceId, normalizedType, pagination.limit, pagination.offset]
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

    async claim({
      accessScope = {},
      claimId,
      leaseMs = DEFAULT_TASK_CLAIM_LEASE_MS,
      taskId,
    } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedClaimId = normalizeText(claimId);
      const normalizedLeaseMs = normalizeLeaseMs(leaseMs);

      if (!normalizedClaimId) {
        const claimState = await getTaskClaimState({
          accessScope: scope,
          leaseMs: normalizedLeaseMs,
          taskId,
        });
        const currentTask = claimState.task;

        return {
          applied: false,
          outcome: currentTask
            ? TASK_MUTATION_OUTCOMES.notRunnable
            : TASK_MUTATION_OUTCOMES.notFound,
          retryAfterMs: claimState.retryAfterMs,
          retryAt: claimState.retryAt,
          task: currentTask,
        };
      }

      const result = await query(
        `
          WITH task_clock AS (
            SELECT clock_timestamp() AS current_time
          ),
          claimed_task AS (
            UPDATE ${tasksTable} AS task
            SET
              status = $6,
              attempt_count = task.attempt_count + 1,
              next_run_at = NULL,
              claimed_by = $4,
              claimed_at = task_clock.current_time,
              updated_at = task_clock.current_time
            FROM task_clock
            WHERE task.user_id = $1
              AND task.workspace_id = $2
              AND task.task_id = $3
              AND (
                (
                  task.status = $7
                  AND (
                    task.next_run_at IS NULL
                    OR task.next_run_at <= task_clock.current_time
                  )
                )
                OR (
                  task.status = $6
                  AND COALESCE(task.claimed_at, task.updated_at)
                    <= task_clock.current_time
                      - ($5::double precision * INTERVAL '1 millisecond')
                )
              )
            RETURNING ${taskSelectColumns}
          ),
          recorded_event AS (
            INSERT INTO ${taskEventsTable} (
              user_id,
              workspace_id,
              task_id,
              event_type,
              event_payload
            )
            SELECT
              $1,
              $2,
              $3,
              $8,
              jsonb_build_object(
                'attemptCount',
                claimed_task.attempt_count,
                'status',
                claimed_task.status
              )
            FROM claimed_task
            RETURNING 1
          )
          SELECT claimed_task.*
          FROM claimed_task
          CROSS JOIN recorded_event
        `,
        [
          scope.userId,
          scope.workspaceId,
          normalizeText(taskId),
          normalizedClaimId,
          normalizedLeaseMs,
          TASK_STATUSES.running,
          TASK_STATUSES.queued,
          "task_claim",
        ]
      );
      const task = result.rows[0] ? mapRowToTask(result.rows[0]) : null;

      if (task) {
        return {
          applied: true,
          attemptCount: task.attemptCount,
          outcome: TASK_MUTATION_OUTCOMES.claimed,
          retryAfterMs: 0,
          retryAt: "",
          task,
        };
      }

      const claimState = await getTaskClaimState({
        accessScope: scope,
        leaseMs: normalizedLeaseMs,
        taskId,
      });
      const currentTask = claimState.task;

      return {
        applied: false,
        outcome: currentTask
          ? TASK_MUTATION_OUTCOMES.notRunnable
          : TASK_MUTATION_OUTCOMES.notFound,
        retryAfterMs: claimState.retryAfterMs,
        retryAt: claimState.retryAt,
        task: currentTask,
      };
    },

    async patchClaimed({
      accessScope = {},
      attemptCount,
      claimId,
      patch = {},
      taskId,
    } = {}) {
      const existingTask = await getTask({
        accessScope,
        taskId,
      });

      if (!existingTask) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notFound,
          task: null,
        };
      }

      const normalizedAttempt = normalizeAttemptCount(attemptCount);
      const normalizedClaimId = normalizeText(claimId);

      if (!normalizedClaimId || normalizedAttempt <= 0) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.claimLost,
          task: existingTask,
        };
      }

      const nextStatus =
        patch.status === undefined
          ? existingTask.status
          : normalizeText(patch.status);
      const shouldReleaseClaim = nextStatus !== TASK_STATUSES.running;
      const task = await updateTaskSnapshot({
        accessScope,
        eventType: "task_claim_patch",
        expectedAttemptCount: normalizedAttempt,
        expectedClaimId: normalizedClaimId,
        expectedStatuses: [TASK_STATUSES.running],
        existingTask,
        patch: {
          ...patch,
          claimedAt: "",
          claimedBy: shouldReleaseClaim ? "" : normalizedClaimId,
        },
        requireClaim: true,
        taskId,
      });

      if (!task) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.claimLost,
          task: await getTask({
            accessScope,
            taskId,
          }),
        };
      }

      return {
        applied: true,
        outcome: TASK_MUTATION_OUTCOMES.updated,
        task,
      };
    },

    async renewClaim({
      accessScope = {},
      attemptCount,
      claimId,
      taskId,
    } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedAttempt = normalizeAttemptCount(attemptCount);
      const normalizedClaimId = normalizeText(claimId);

      if (!normalizedClaimId || normalizedAttempt <= 0) {
        const currentTask = await getTask({
          accessScope: scope,
          taskId,
        });

        return {
          applied: false,
          outcome: currentTask
            ? TASK_MUTATION_OUTCOMES.claimLost
            : TASK_MUTATION_OUTCOMES.notFound,
          task: currentTask,
        };
      }

      const result = await query(
        `
          UPDATE ${tasksTable}
          SET
            claimed_at = clock_timestamp(),
            updated_at = clock_timestamp()
          WHERE user_id = $1
            AND workspace_id = $2
            AND task_id = $3
            AND status = $4
            AND claimed_by = $5
            AND attempt_count = $6
          RETURNING ${taskSelectColumns}
        `,
        [
          scope.userId,
          scope.workspaceId,
          normalizeText(taskId),
          TASK_STATUSES.running,
          normalizedClaimId,
          normalizedAttempt,
        ]
      );
      const task = result.rows[0] ? mapRowToTask(result.rows[0]) : null;

      return {
        applied: Boolean(task),
        outcome: task
          ? TASK_MUTATION_OUTCOMES.renewed
          : TASK_MUTATION_OUTCOMES.claimLost,
        task:
          task ??
          (await getTask({
            accessScope: scope,
            taskId,
          })),
      };
    },

    async transition({
      accessScope = {},
      expectedStatuses = [],
      patch = {},
      taskId,
    } = {}) {
      const existingTask = await getTask({
        accessScope,
        taskId,
      });

      if (!existingTask) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notFound,
          task: null,
        };
      }

      const normalizedExpectedStatuses = toArray(expectedStatuses)
        .map(normalizeText)
        .filter(Boolean);

      if (normalizedExpectedStatuses.length === 0) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notAllowed,
          task: existingTask,
        };
      }

      const nextStatus =
        patch.status === undefined
          ? existingTask.status
          : normalizeText(patch.status);
      const task = await updateTaskSnapshot({
        accessScope,
        eventType: "task_transition",
        expectedStatuses: normalizedExpectedStatuses,
        existingTask,
        patch: {
          ...patch,
          claimedAt: "",
          claimedBy: "",
        },
        taskId,
      });

      if (!task) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notAllowed,
          task: await getTask({
            accessScope,
            taskId,
          }),
        };
      }

      return {
        applied: true,
        outcome: TASK_MUTATION_OUTCOMES.transitioned,
        task,
      };
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
