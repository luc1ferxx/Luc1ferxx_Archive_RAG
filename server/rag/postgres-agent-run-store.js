import {
  getAgentRunEventsPostgresTable,
  getAgentRunsPostgresTable,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { queryPostgres } from "./postgres.js";
import { createExportEventOrdinalMapper, createPostgresTenantRecordMethods } from "./tenant-records.js";
import {
  AGENT_RUN_STATUSES,
  normalizeAgentRun,
  normalizeAgentRunEvent,
} from "./agent-runs.js";
import {
  createAgentRunAlreadyExistsError,
  createAgentRunRevisionConflictError,
  normalizeAgentRunRevision,
} from "./agent-run-revision.js";
import {
  buildTaskScopeKey,
  normalizeTaskAccessScope,
} from "./tasks.js";
import { AGENT_RUN_STATUSES as RUN_STATUSES } from "./agent-run-state-machine.js";
import {
  buildRetentionLockKey,
  normalizeRetentionBatchLimit,
  normalizeRetentionCutoffs,
  readRetentionLockAcquired,
  renderRetentionPreludeCtes,
} from "./retention-sql.js";
import { normalizeText } from "../lib/normalize-text.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const APPROVAL_SNAPSHOT_ROLLBACK_SQLSTATE = "22012";

// The only statuses retention may delete: a finished run. Running and
// waiting_for_user runs (an approval pause, a clarification, a run marked for
// manual recovery) are what startup recovery lists, so they always stay.
const RETAINABLE_AGENT_RUN_STATUSES = Object.freeze([
  RUN_STATUSES.canceled,
  RUN_STATUSES.completed,
  RUN_STATUSES.failed,
]);

const ensureTableName = (tableName, envName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `${envName} must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  if (Buffer.byteLength(tableName, "utf8") > 63) {
    throw new Error(
      `${envName} must be at most 63 bytes so PostgreSQL does not truncate it.`
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
  revision,
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
    revision: normalizeAgentRunRevision(row.revision),
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

const agentRunEventColumns = "event_id, event_type, event_payload, created_at";
// A run's events in commit order: every event insert takes the run row's lock
// first and draws its id under it, so ids grow in commit order. created_at is
// the writing transaction's start, taken before that lock, so two appends
// racing for it could list in the other order (rag/agent-runs.js numbers the
// public ids by id rank).
const RUN_EVENT_ORDER = "ORDER BY event_id ASC";

/**
 * A write that already touches a run returns the run's whole event list in
 * the same statement: the rows visible to the statement's snapshot plus the
 * one this statement records (a data-modifying CTE is invisible to the rest of
 * its own statement, so the two sets never overlap). The list is ordered
 * exactly as getEvents() orders it and comes back as parallel arrays, so
 * node-pg parses every value with the same type parser a plain event row gets
 * (int8 as text, jsonb as an object, timestamptz as a Date).
 *
 * The snapshot is taken when the statement starts. A revision CAS that then
 * waits for the run row lock (an appendEvent holds it without bumping the
 * revision) would still pass its re-check but miss the event that writer
 * committed, so the CAS writes take that lock first (lockRunRowFirst): every
 * event writer locks the run row, which makes the list complete as of the
 * write's commit.
 */
const buildRunEventListCte = ({ eventsTable, recordedEventCte }) => `
  run_events AS (
    SELECT
      array_agg(event_id ${RUN_EVENT_ORDER}) AS run_event_ids,
      array_agg(event_type ${RUN_EVENT_ORDER}) AS run_event_types,
      array_agg(event_payload ${RUN_EVENT_ORDER}) AS run_event_payloads,
      array_agg(created_at ${RUN_EVENT_ORDER}) AS run_event_created_ats
    FROM (
      SELECT ${agentRunEventColumns}
      FROM ${eventsTable}
      WHERE user_id = $1
        AND workspace_id = $2
        AND run_id = $3
      UNION ALL
      SELECT ${agentRunEventColumns}
      FROM ${recordedEventCte}
    ) AS run_event_rows
  )
`;

const isUsableBaseRun = ({
  accessScope = {},
  baseRun,
  expectedRevision,
  runId,
} = {}) =>
  Boolean(baseRun) &&
  normalizeText(baseRun.runId) === normalizeText(runId) &&
  buildTaskScopeKey(normalizeTaskAccessScope(baseRun.accessScope)) ===
    buildTaskScopeKey(normalizeTaskAccessScope(accessScope)) &&
  normalizeAgentRunRevision(baseRun.revision) ===
    normalizeAgentRunRevision(expectedRevision);

const hasReturnedRunEvents = (row) =>
  Boolean(row) && Object.hasOwn(row, "run_event_ids");

const mapReturnedRunEvents = (row = {}) =>
  toArray(row.run_event_ids)
    .map((eventId, index) =>
      mapEventRowToAgentRunEvent({
        event_id: eventId,
        event_type: toArray(row.run_event_types)[index],
        event_payload: toArray(row.run_event_payloads)[index],
        created_at: toArray(row.run_event_created_ats)[index],
      })
    )
    .filter(Boolean);

const mapRowToApprovalSnapshot = (row = {}) => ({
  gateId: normalizeText(row.gate_id),
  capabilityId: normalizeText(row.capability_id),
  capabilityVersion: normalizeText(row.capability_version),
  approvalObjectHash: normalizeText(row.approval_object_hash),
  snapshotVersion: Number(row.snapshot_version),
  executionInput: parseJsonValue(row.execution_input, {}),
});

const normalizeApprovalSnapshot = (snapshot = {}) => {
  const executionInput =
    snapshot.executionInput &&
    typeof snapshot.executionInput === "object" &&
    !Array.isArray(snapshot.executionInput)
      ? snapshot.executionInput
      : null;
  const normalizedSnapshot = {
    gateId: normalizeText(snapshot.gateId),
    capabilityId: normalizeText(snapshot.capabilityId),
    capabilityVersion: normalizeText(snapshot.capabilityVersion),
    approvalObjectHash: normalizeText(snapshot.approvalObjectHash),
    snapshotVersion: Number(snapshot.snapshotVersion),
    executionInput,
  };

  if (
    !normalizedSnapshot.gateId ||
    !normalizedSnapshot.capabilityId ||
    !normalizedSnapshot.capabilityVersion ||
    !normalizedSnapshot.approvalObjectHash ||
    !Number.isInteger(normalizedSnapshot.snapshotVersion) ||
    normalizedSnapshot.snapshotVersion <= 0 ||
    !normalizedSnapshot.executionInput
  ) {
    const error = new Error(
      "Approval snapshot requires gateId, capabilityId, capabilityVersion, approvalObjectHash, a positive snapshotVersion, and object executionInput."
    );
    error.status = 400;
    throw error;
  }

  return normalizedSnapshot;
};

const normalizeApprovalSnapshots = (snapshots = []) => {
  const normalizedSnapshots = toArray(snapshots).map(normalizeApprovalSnapshot);
  const gateIds = new Set();

  for (const snapshot of normalizedSnapshots) {
    if (gateIds.has(snapshot.gateId)) {
      const error = new Error(
        `Approval snapshot gateId must be unique per update: ${snapshot.gateId}.`
      );
      error.status = 400;
      throw error;
    }

    gateIds.add(snapshot.gateId);
  }

  return normalizedSnapshots;
};

const createApprovalSnapshotConflictError = ({
  gateIds = [],
  runId,
} = {}) => {
  const error = new Error(
    "Agent run approval snapshot conflicts with the immutable stored snapshot."
  );
  error.code = "AGENT_RUN_APPROVAL_SNAPSHOT_CONFLICT";
  error.status = 409;
  error.runId = normalizeText(runId);
  error.gateIds = gateIds.map(normalizeText).filter(Boolean);
  return error;
};

export const createPostgresAgentRunStore = ({
  eventsTableName = getAgentRunEventsPostgresTable(),
  now = () => new Date().toISOString(),
  query = queryPostgres,
  runMigrations = runPostgresMigrations,
  tableName = getAgentRunsPostgresTable(),
} = {}) => {
  const runsTable = ensureTableName(tableName, "AGENT_RUNS_POSTGRES_TABLE");
  const approvalSnapshotsTable = ensureTableName(
    `${runsTable}_approval_snapshots`,
    "derived agent run approval snapshots table"
  );
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
        ${RUN_EVENT_ORDER}
      `,
      [scope.userId, scope.workspaceId, normalizeText(runId)]
    );

    return result.rows.map(mapEventRowToAgentRunEvent).filter(Boolean);
  };

  // The event list a write returned with its row. An injected query function
  // that does not model the aggregate (a unit-test fake) gets the separate
  // read the store always used to make, and so does the plain UPDATE, which
  // returns no list -- unless the caller supplied the list of the base it
  // decided the write on (`knownEvents`), in which case that list is the
  // returned run's, as of that base.
  const resolveWrittenRunEvents = async ({ accessScope, knownEvents = null, row, runId }) =>
    hasReturnedRunEvents(row)
      ? mapReturnedRunEvents(row)
      : Array.isArray(knownEvents)
        ? knownEvents
        : getEvents({
            accessScope,
            runId,
          });

  const runEventListCte = buildRunEventListCte({
    eventsTable: runEventsTable,
    recordedEventCte: "recorded_event",
  });

  // Run before a revision CAS in the same transaction and round trip
  // (queryPostgres's prelude): it waits for any writer holding the run row,
  // so the CAS statement's snapshot, taken after it, includes that writer's
  // events. FOR NO KEY UPDATE is the lock the UPDATE takes anyway.
  const lockRunRowFirst = ({ runId, scope }) => ({
    prelude: [
      {
        text: `
          SELECT 1
          FROM ${runsTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND run_id = $3
          FOR NO KEY UPDATE
        `,
        values: [scope.userId, scope.workspaceId, normalizeText(runId)],
      },
    ],
  });

  const getRun = async ({ accessScope = {}, runId } = {}) => {
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
  };

  const insertRun = async ({
    accessScope = {},
    event = null,
    run,
  } = {}) => {
    await initialize();

    const normalizedRun = normalizeAgentRun(run);

    if (!normalizedRun) {
      throw new Error("Agent run requires runId and goal.");
    }

    const normalizedEvent =
      event === null || event === undefined
        ? null
        : normalizeAgentRunEvent(event);

    if (event !== null && event !== undefined && !normalizedEvent) {
      throw new Error("Agent run event requires type.");
    }

    const scope = normalizeTaskAccessScope(accessScope);
    const timestamp = now();
    const insertParameters = [
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
    ];
    const insertStatement = `
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
      DO NOTHING
      RETURNING ${agentRunSelectColumns}
    `;
    const result = normalizedEvent
      ? await query(
          `
            WITH inserted_run AS (
              ${insertStatement}
            ),
            recorded_event AS (
              INSERT INTO ${runEventsTable} (
                user_id,
                workspace_id,
                run_id,
                event_type,
                event_payload
              )
              SELECT $1, $2, $3, $17, $18::jsonb
              FROM inserted_run
              RETURNING ${agentRunEventColumns}
            ),
            ${runEventListCte}
            SELECT inserted_run.*, run_events.*
            FROM inserted_run
            CROSS JOIN recorded_event
            CROSS JOIN run_events
          `,
          [
            ...insertParameters,
            normalizedEvent.type,
            JSON.stringify(normalizedEvent.payload ?? {}),
          ]
        )
      : await query(insertStatement, insertParameters);

    if (!result.rows[0]) {
      throw createAgentRunAlreadyExistsError({
        runId: normalizedRun.runId,
      });
    }

    const events = await resolveWrittenRunEvents({
      accessScope: scope,
      row: result.rows[0],
      runId: normalizedRun.runId,
    });

    return mapRowToAgentRun(result.rows[0], events);
  };

  const commitRunUpdate = async ({
    accessScope = {},
    approvalSnapshots = [],
    baseRun = null,
    event = null,
    expectedRevision,
    patch = {},
    reuseBaseEvents = false,
    runId,
  } = {}) => {
    // The caller already holds the run at expectedRevision when it decided
    // this patch. A row at the same revision is the same row (every write
    // other than the updated_at touch bumps it, and updatedAt is replaced
    // below), and the CAS rejects the write when the stored revision moved,
    // so reading it again here would only repeat the caller's read.
    const existingRun = isUsableBaseRun({
      accessScope,
      baseRun,
      expectedRevision,
      runId,
    })
      ? baseRun
      : await getRun({
          accessScope,
          runId,
        });

    if (!existingRun) {
      return null;
    }

    const normalizedEvent =
      event === null || event === undefined
        ? null
        : normalizeAgentRunEvent(event);

    if (event !== null && event !== undefined && !normalizedEvent) {
      throw new Error("Agent run event requires type.");
    }
    const normalizedApprovalSnapshots =
      normalizeApprovalSnapshots(approvalSnapshots);

    if (normalizedApprovalSnapshots.length > 0 && !normalizedEvent) {
      const error = new Error(
        "Approval snapshots require a bound agent run event."
      );
      error.status = 400;
      throw error;
    }

    const scope = normalizeTaskAccessScope(accessScope);
    const normalizedExpectedRevision = normalizeAgentRunRevision(
      expectedRevision
    );
    const nextRun = normalizeAgentRun({
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
      revision: normalizedExpectedRevision + 1,
      updatedAt: patch.updatedAt || now(),
    });
    const updateParameters = [
      scope.userId,
      scope.workspaceId,
      normalizeText(runId),
      normalizedExpectedRevision,
      nextRun.status,
      nextRun.goal,
      toJsonObjectParam(nextRun.input),
      toJsonObjectParam(nextRun.plan),
      toJsonArrayParam(nextRun.steps),
      toJsonArrayParam(nextRun.observations),
      toJsonArrayParam(nextRun.decisions),
      toJsonArrayParam(nextRun.approvalGates),
      toJsonObjectParam(nextRun.result),
      toJsonParam(nextRun.error),
      nextRun.updatedAt,
    ];
    let result;

    try {
      if (normalizedEvent && normalizedApprovalSnapshots.length > 0) {
        result = await query(
          `
              WITH requested_approval_snapshots AS (
                SELECT
                  $1::text AS user_id,
                  $2::text AS workspace_id,
                  $3::text AS run_id,
                  snapshot ->> 'gateId' AS gate_id,
                  snapshot ->> 'capabilityId' AS capability_id,
                  snapshot ->> 'capabilityVersion' AS capability_version,
                  snapshot ->> 'approvalObjectHash' AS approval_object_hash,
                  (snapshot ->> 'snapshotVersion')::integer AS snapshot_version,
                  snapshot -> 'executionInput' AS execution_input
                FROM jsonb_array_elements($18::jsonb) AS snapshot
              ),
              approval_snapshot_conflicts AS (
                SELECT 1
                FROM requested_approval_snapshots AS requested
                INNER JOIN ${approvalSnapshotsTable} AS existing
                  ON existing.user_id = requested.user_id
                  AND existing.workspace_id = requested.workspace_id
                  AND existing.run_id = requested.run_id
                  AND existing.gate_id = requested.gate_id
                WHERE existing.capability_id IS DISTINCT FROM requested.capability_id
                  OR existing.capability_version IS DISTINCT FROM requested.capability_version
                  OR existing.approval_object_hash IS DISTINCT FROM requested.approval_object_hash
                  OR existing.snapshot_version IS DISTINCT FROM requested.snapshot_version
                  OR existing.execution_input IS DISTINCT FROM requested.execution_input
              ),
              updated_run AS (
                UPDATE ${runsTable}
                SET
                  status = $5,
                  goal = $6,
                  input = $7::jsonb,
                  plan = $8::jsonb,
                  steps = $9::jsonb,
                  observations = $10::jsonb,
                  decisions = $11::jsonb,
                  approval_gates = $12::jsonb,
                  result = $13::jsonb,
                  error = $14::jsonb,
                  revision = revision + 1,
                  updated_at = $15::timestamptz
                WHERE user_id = $1
                  AND workspace_id = $2
                  AND run_id = $3
                  AND revision = $4
                  AND NOT EXISTS (
                    SELECT 1 FROM approval_snapshot_conflicts
                  )
                RETURNING ${agentRunSelectColumns}
              ),
              inserted_approval_snapshots AS (
                INSERT INTO ${approvalSnapshotsTable} (
                  user_id,
                  workspace_id,
                  run_id,
                  gate_id,
                  capability_id,
                  capability_version,
                  approval_object_hash,
                  snapshot_version,
                  execution_input
                )
                SELECT
                  requested.user_id,
                  requested.workspace_id,
                  requested.run_id,
                  requested.gate_id,
                  requested.capability_id,
                  requested.capability_version,
                  requested.approval_object_hash,
                  requested.snapshot_version,
                  requested.execution_input
                FROM requested_approval_snapshots AS requested
                CROSS JOIN updated_run
                ON CONFLICT (user_id, workspace_id, run_id, gate_id)
                DO UPDATE SET
                  approval_object_hash =
                    ${approvalSnapshotsTable}.approval_object_hash
                WHERE ${approvalSnapshotsTable}.capability_id =
                    EXCLUDED.capability_id
                  AND ${approvalSnapshotsTable}.capability_version =
                    EXCLUDED.capability_version
                  AND ${approvalSnapshotsTable}.approval_object_hash =
                    EXCLUDED.approval_object_hash
                  AND ${approvalSnapshotsTable}.snapshot_version =
                    EXCLUDED.snapshot_version
                  AND ${approvalSnapshotsTable}.execution_input =
                    EXCLUDED.execution_input
                RETURNING gate_id
              ),
              approval_snapshot_write_guard AS (
                SELECT
                  CASE
                    -- A missing updated_run means the revision CAS or the
                    -- immutable-snapshot precheck failed. Let the caller
                    -- classify that empty result without manufacturing a
                    -- database error.
                    WHEN NOT run_updated THEN TRUE
                    WHEN requested_count = inserted_count THEN TRUE
                    -- PostgreSQL does not roll back data-modifying CTEs just
                    -- because the final SELECT returns no row. A concurrent
                    -- conflicting insert can therefore be discovered only by
                    -- ON CONFLICT, after updated_run succeeded. Force SQLSTATE
                    -- 22012 so the whole statement rolls back; the catch below
                    -- maps it to the stable domain conflict error.
                    ELSE (
                      requested_count /
                      (inserted_count - inserted_count)
                    ) = 0
                  END AS complete
                FROM (
                  SELECT
                    EXISTS (
                      SELECT 1
                      FROM updated_run
                    ) AS run_updated,
                    (
                      SELECT COUNT(*)
                      FROM requested_approval_snapshots
                    ) AS requested_count,
                    (
                      SELECT COUNT(*)
                      FROM inserted_approval_snapshots
                    ) AS inserted_count
                ) AS snapshot_counts
              ),
              recorded_event AS (
                INSERT INTO ${runEventsTable} (
                  user_id,
                  workspace_id,
                  run_id,
                  event_type,
                  event_payload
                )
                SELECT $1, $2, $3, $16, $17::jsonb
                FROM updated_run
                CROSS JOIN approval_snapshot_write_guard
                WHERE approval_snapshot_write_guard.complete
                RETURNING ${agentRunEventColumns}
              ),
              ${runEventListCte}
              SELECT updated_run.*, run_events.*
              FROM updated_run
              CROSS JOIN recorded_event
              CROSS JOIN run_events
          `,
          [
            ...updateParameters,
            normalizedEvent.type,
            JSON.stringify(normalizedEvent.payload ?? {}),
            JSON.stringify(normalizedApprovalSnapshots),
          ],
          lockRunRowFirst({ runId, scope })
        );
      } else if (normalizedEvent) {
        result = await query(
          `
            WITH updated_run AS (
              UPDATE ${runsTable}
              SET
                status = $5,
                goal = $6,
                input = $7::jsonb,
                plan = $8::jsonb,
                steps = $9::jsonb,
                observations = $10::jsonb,
                decisions = $11::jsonb,
                approval_gates = $12::jsonb,
                result = $13::jsonb,
                error = $14::jsonb,
                revision = revision + 1,
                updated_at = $15::timestamptz
              WHERE user_id = $1
                AND workspace_id = $2
                AND run_id = $3
                AND revision = $4
              RETURNING ${agentRunSelectColumns}
            ),
            recorded_event AS (
              INSERT INTO ${runEventsTable} (
                user_id,
                workspace_id,
                run_id,
                event_type,
                event_payload
              )
              SELECT $1, $2, $3, $16, $17::jsonb
              FROM updated_run
              RETURNING ${agentRunEventColumns}
            ),
            ${runEventListCte}
            SELECT updated_run.*, run_events.*
            FROM updated_run
            CROSS JOIN recorded_event
            CROSS JOIN run_events
          `,
          [
            ...updateParameters,
            normalizedEvent.type,
            JSON.stringify(normalizedEvent.payload ?? {}),
          ],
          lockRunRowFirst({ runId, scope })
        );
      } else {
        result = await query(
          `
            UPDATE ${runsTable}
            SET
              status = $5,
              goal = $6,
              input = $7::jsonb,
              plan = $8::jsonb,
              steps = $9::jsonb,
              observations = $10::jsonb,
              decisions = $11::jsonb,
              approval_gates = $12::jsonb,
              result = $13::jsonb,
              error = $14::jsonb,
              revision = revision + 1,
              updated_at = $15::timestamptz
            WHERE user_id = $1
              AND workspace_id = $2
              AND run_id = $3
              AND revision = $4
            RETURNING ${agentRunSelectColumns}
          `,
          updateParameters
        );
      }
    } catch (error) {
      if (
        normalizedEvent &&
        normalizedApprovalSnapshots.length > 0 &&
        error?.code === APPROVAL_SNAPSHOT_ROLLBACK_SQLSTATE
      ) {
        throw createApprovalSnapshotConflictError({
          gateIds: normalizedApprovalSnapshots.map(
            (snapshot) => snapshot.gateId
          ),
          runId,
        });
      }

      throw error;
    }

    if (!result.rows[0]) {
      const currentRun = await getRun({
        accessScope: scope,
        runId,
      });

      if (!currentRun) {
        return null;
      }

      if (
        normalizedApprovalSnapshots.length > 0 &&
        currentRun &&
        normalizeAgentRunRevision(currentRun.revision) ===
          normalizedExpectedRevision
      ) {
        throw createApprovalSnapshotConflictError({
          gateIds: normalizedApprovalSnapshots.map(
            (snapshot) => snapshot.gateId
          ),
          runId,
        });
      }

      throw createAgentRunRevisionConflictError({
        actualRevision: currentRun?.revision,
        expectedRevision: normalizedExpectedRevision,
        runId,
      });
    }

    return mapRowToAgentRun(
      result.rows[0],
      await resolveWrittenRunEvents({
        accessScope: scope,
        // Only the event-less UPDATE returns no list, and only a caller that
        // decided the write on `baseRun` and asked for its list gets it
        // (agent-runs.js mutateStoredRun reuseBaseEvents); a write that
        // records an event returns the exact list from its CTE.
        knownEvents:
          reuseBaseEvents && existingRun === baseRun && !normalizedEvent
            ? toArray(existingRun.events)
            : null,
        row: result.rows[0],
        runId,
      })
    );
  };

  return {
    async initialize() {
      return initialize();
    },

    // The tenant erase and export (rag/tenant-records.js). The approval
    // snapshots cascade with their run; they and the events (no foreign key)
    // are deleted before the runs and swept again after them, so an event a
    // run appended between the statements does not stay behind. An exported
    // event names `${runId}:n` as the API does, never the shared id.
    ...createPostgresTenantRecordMethods({
      initialize,
      query,
      tables: () => [
        {
          keyColumns: ["user_id", "workspace_id", "run_id", "gate_id"],
          name: "agent_run_approval_snapshots",
          sweepAfter: true,
          table: approvalSnapshotsTable,
          userColumn: "user_id",
        },
        {
          keyColumns: ["event_id"],
          mapRow: createExportEventOrdinalMapper("run_id"),
          name: "agent_run_events",
          sweepAfter: true,
          table: runEventsTable,
          userColumn: "user_id",
        },
        {
          keyColumns: ["user_id", "workspace_id", "run_id"],
          name: "agent_runs",
          pageSize: 50,
          table: runsTable,
          userColumn: "user_id",
        },
      ],
    }),

    async appendEvent({ accessScope = {}, event = {}, runId } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedEvent = normalizeAgentRunEvent(event);

      if (!normalizedEvent) {
        throw new Error("Agent run event requires type.");
      }

      const result = await query(
        `
          WITH touched_run AS (
            UPDATE ${runsTable}
            SET updated_at = GREATEST(updated_at, clock_timestamp())
            WHERE user_id = $1
              AND workspace_id = $2
              AND run_id = $3
            RETURNING run_id
          ),
          recorded_event AS (
            INSERT INTO ${runEventsTable} (
              user_id,
              workspace_id,
              run_id,
              event_type,
              event_payload
            )
            SELECT $1, $2, $3, $4, $5::jsonb
            FROM touched_run
            RETURNING event_id, event_type, event_payload, created_at
          )
          SELECT event_id, event_type, event_payload, created_at
          FROM recorded_event
        `,
        [
          scope.userId,
          scope.workspaceId,
          normalizeText(runId),
          normalizedEvent.type,
          JSON.stringify(normalizedEvent.payload ?? {}),
        ]
      );

      return result.rows[0] ? mapEventRowToAgentRunEvent(result.rows[0]) : null;
    },

    async create({ accessScope = {}, run } = {}) {
      return insertRun({
        accessScope,
        run,
      });
    },

    async createWithEvent({
      accessScope = {},
      event = {},
      run,
    } = {}) {
      return insertRun({
        accessScope,
        event,
        run,
      });
    },

    async get({ accessScope = {}, runId } = {}) {
      return getRun({
        accessScope,
        runId,
      });
    },

    async getApprovalSnapshot({
      accessScope = {},
      gateId,
      runId,
    } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const result = await query(
        `
          SELECT
            gate_id,
            capability_id,
            capability_version,
            approval_object_hash,
            snapshot_version,
            execution_input
          FROM ${approvalSnapshotsTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND run_id = $3
            AND gate_id = $4
          LIMIT 1
        `,
        [
          scope.userId,
          scope.workspaceId,
          normalizeText(runId),
          normalizeText(gateId),
        ]
      );

      return result.rows[0]
        ? mapRowToApprovalSnapshot(result.rows[0])
        : null;
    },

    async list({ accessScope = {}, status = "", limit, offset } = {}) {
      await initialize();

      const scope = normalizeTaskAccessScope(accessScope);
      const normalizedStatus = normalizeText(status);
      const pagination = normalizePaginationParams({ limit, offset });
      const result = await query(
        `
          SELECT ${agentRunSelectColumns}
          FROM ${runsTable}
          WHERE user_id = $1
            AND workspace_id = $2
            AND ($3 = '' OR status = $3)
          ORDER BY updated_at DESC, run_id ASC
          LIMIT $4 OFFSET $5
        `,
        [scope.userId, scope.workspaceId, normalizedStatus, pagination.limit, pagination.offset]
      );

      return result.rows.map((row) => mapRowToAgentRun(row)).filter(Boolean);
    },

    /**
     * Runs whose steps, observations, decisions or result serialize a member
     * from `needles` (rag/document-deletion-redaction.js
     * buildDocumentReferenceNeedles: a deleted document's `"docId": ...`), in
     * primary-key order from `after` ({ userId, workspaceId, runId }, the
     * previous page's `next`). A scope naming a user or a workspace reads
     * exactly that pair, as every other method does; one naming neither
     * reads every pair (the unscoped context: auth off, the single shared
     * token). Under a request's tenant the row policy applies as well. The
     * runs keep their internal fields (revision, scope, the private result
     * keys), so the caller can CAS each one through update().
     */
    async listRunsReferencingDocuments({ accessScope = {}, after = null, limit = 25, needles = [] } = {}) {
      await initialize();

      const values = toArray(needles).map(String).filter(Boolean);

      if (values.length === 0) {
        return { next: null, runs: [] };
      }

      const scope = normalizeTaskAccessScope(accessScope);
      const scoped = Boolean(scope.userId || scope.workspaceId);
      const cursor = after ? normalizeTaskAccessScope(after) : null;
      const pageSize = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 25));
      const result = await query(
        `
          SELECT ${agentRunSelectColumns}
          FROM ${runsTable}
          WHERE ($1::boolean = FALSE OR (user_id = $2 AND workspace_id = $3))
            AND ($4::text IS NULL OR (user_id, workspace_id, run_id) > ($4::text, $5::text, $6::text))
            AND EXISTS (
              SELECT 1
              FROM unnest($7::text[]) AS needle(value)
              WHERE strpos(steps::text, needle.value) > 0
                 OR strpos(observations::text, needle.value) > 0
                 OR strpos(decisions::text, needle.value) > 0
                 OR strpos(result::text, needle.value) > 0
            )
          ORDER BY user_id, workspace_id, run_id
          LIMIT $8
        `,
        [
          scoped,
          scope.userId,
          scope.workspaceId,
          cursor ? cursor.userId : null,
          cursor ? cursor.workspaceId : null,
          cursor ? normalizeText(after.runId) : null,
          values,
          pageSize,
        ]
      );
      const rows = result.rows ?? [];
      const last = rows.at(-1);

      return {
        next:
          rows.length === pageSize && last
            ? { runId: String(last.run_id), userId: String(last.user_id ?? ""), workspaceId: String(last.workspace_id ?? "") }
            : null,
        runs: rows.map((row) => mapRowToAgentRun(row)).filter(Boolean),
      };
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

    /**
     * Retention (rag/retention.js): deletes at most `limit` finished runs
     * (completed, failed, canceled) of every tenant last updated before their
     * workspace's cutoff, with their events; their approval snapshots go by
     * the foreign key's cascade. A running or waiting run -- paused for an
     * approval, waiting for the user, marked for manual recovery, or
     * listable by startup recovery -- is never touched, and neither is a row
     * another transaction holds (SKIP LOCKED: a run being written right now
     * waits for the next sweep). One statement, so the advisory try-lock that
     * keeps two instances from sweeping this table at once is held exactly
     * while it runs. System work: the caller binds runAsDatabaseSystem.
     * Resolves to { acquired, deleted, deletedEvents }.
     */
    async deleteExpired({ cutoff, limit, workspaceCutoffs = [] } = {}) {
      await initialize();

      const normalized = normalizeRetentionCutoffs({ cutoff, workspaceCutoffs });
      const result = await query(
        `
          WITH ${renderRetentionPreludeCtes({ lockKey: 1, workspaceCutoffs: 6, workspaceIds: 5 })},
          expired AS (
            SELECT r.user_id, r.workspace_id, r.run_id
            FROM ${runsTable} AS r
            LEFT JOIN retention_overrides AS o ON o.workspace_id = r.workspace_id
            WHERE (SELECT acquired FROM retention_lock)
              AND r.status = ANY($2::text[])
              AND r.updated_at < $4::timestamptz
              AND r.updated_at < COALESCE(o.cutoff, $3::timestamptz)
            ORDER BY r.updated_at ASC, r.run_id ASC
            LIMIT $7
            FOR UPDATE OF r SKIP LOCKED
          ),
          deleted_events AS (
            DELETE FROM ${runEventsTable} AS e
            USING expired AS x
            WHERE e.user_id = x.user_id
              AND e.workspace_id = x.workspace_id
              AND e.run_id = x.run_id
            RETURNING 1
          ),
          deleted_runs AS (
            DELETE FROM ${runsTable} AS r
            USING expired AS x
            WHERE r.user_id = x.user_id
              AND r.workspace_id = x.workspace_id
              AND r.run_id = x.run_id
            RETURNING 1
          )
          SELECT
            (SELECT acquired FROM retention_lock) AS acquired,
            (SELECT COUNT(*) FROM deleted_runs)::int AS deleted,
            (SELECT COUNT(*) FROM deleted_events)::int AS deleted_events
        `,
        [
          buildRetentionLockKey(runsTable),
          RETAINABLE_AGENT_RUN_STATUSES,
          normalized.cutoff,
          normalized.upperBound,
          normalized.workspaceIds,
          normalized.workspaceCutoffs,
          normalizeRetentionBatchLimit(limit),
        ]
      );
      const row = result.rows?.[0];

      return {
        acquired: readRetentionLockAcquired(row),
        deleted: Number(row?.deleted ?? 0) || 0,
        deletedEvents: Number(row?.deleted_events ?? 0) || 0,
      };
    },

    async update({
      accessScope = {},
      baseRun = null,
      expectedRevision,
      patch = {},
      reuseBaseEvents = false,
      runId,
    } = {}) {
      return commitRunUpdate({
        accessScope,
        baseRun,
        expectedRevision,
        patch,
        reuseBaseEvents: reuseBaseEvents === true,
        runId,
      });
    },

    async updateWithEvent({
      accessScope = {},
      approvalSnapshots = [],
      baseRun = null,
      event = {},
      expectedRevision,
      patch = {},
      runId,
    } = {}) {
      return commitRunUpdate({
        accessScope,
        approvalSnapshots,
        baseRun,
        event,
        expectedRevision,
        patch,
        runId,
      });
    },
  };
};
