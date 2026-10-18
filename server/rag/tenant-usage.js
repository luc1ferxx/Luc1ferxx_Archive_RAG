import { AsyncLocalStorage } from "node:async_hooks";

import {
  getTenantUsageFlushMs,
  getTenantUsagePostgresTable,
  isTenantUsageLedgerEnabled,
} from "./config.js";
import { getTenantUsageTableName } from "./db-migrations.js";
import { isPostgresConfigured, queryPostgres as queryDefaultPostgres } from "./postgres.js";
import { getActiveDatabaseTenant, runAsDatabaseSystem } from "./postgres-tenant.js";
import { createPostgresTenantRecordMethods, tenantSelectorMatches } from "./tenant-records.js";
import {
  fromTenantRefusalLedgerMetric,
  isTenantRefusalReason,
  TENANT_REFUSAL_LEDGER_METRICS,
  toTenantRefusalLedgerMetric,
} from "./tenant-refusal-reasons.js";

// The tenant usage ledger (migration 037): hourly aggregates per tenant of
// what a deployment spends on it.
//
// Every process aggregates in memory, keyed by (workspace, user, metric, UTC
// hour), and adds its totals to the table every TENANT_USAGE_FLUSH_MS as
// system work, one upsert per batch of rows. Recording never touches the
// database and never throws, so no request waits on the ledger or fails
// because of it; a flush that fails keeps its totals for the next one. Without
// a database (or with TENANT_USAGE_LEDGER=off) nothing is kept at all.
//
// Fed by:
//   model_tokens, model_cost_micro_usd  every successful model call's LLMOps
//       event (llmops-metrics.js recordLlmOpsMetric), charged to the active
//       database tenant. A caller behind the model gateway records a mirror
//       event per gateway call (model-gateway/protocol.js); mirrors are skipped
//       here exactly as observability-report.js skips them, because the
//       gateway meters the same call itself, under the tenant of the token.
//       A merged ingest embedding request carries several tenants' texts and
//       runs as no tenant's call: its events are skipped here
//       (runWithCallerAttributedModelUsage) and the batcher books each
//       tenant's share by its texts' estimated tokens
//       (rag/ingest-embedding-batcher.js, recordTenantModelUsageShares).
//   chat_requests  one per /chat or /chat/stream request (routes/chat.js).
//   ingested_bytes, documents  one per committed ingest (rag/index.js
//       commitDocument): the bytes of a new or replaced document, and 1 for a
//       new document. A duplicate upload or a superseded replacement stores
//       nothing and counts nothing.
//   refused_<reason>  one per per-tenant refusal (rag/tenant-refusals.js
//       recordTenantRefusal): a rate or concurrency limit, a membership or
//       workspace-status check, a storage, model, task, upload-session or
//       ingest-queue cap; one metric per stable code
//       (rag/tenant-refusal-reasons.js), charged to the tenant the refusal
//       was decided for. They are ordinary rows of the same table, so the
//       flush, the tenant policy, the erase and the export cover them as they
//       are; GET /admin/usage?metric=refusals reads them. Refusals hold at
//       most TENANT_USAGE_MAX_PENDING_REFUSAL_ENTRIES of the pending totals,
//       so a flood of them (a client probing workspace ids) cannot crowd out
//       the usage totals while the database is away.
// The tenant is the (user, workspace) pair; usage outside a tenant (auth
// disabled, system work) is recorded under ('', '').

export const TENANT_USAGE_METRICS = Object.freeze({
  chatRequests: "chat_requests",
  documents: "documents",
  ingestedBytes: "ingested_bytes",
  modelCostMicroUsd: "model_cost_micro_usd",
  modelTokens: "model_tokens",
});

// GET /admin/usage's view over every refused_<reason> metric at once.
export const TENANT_USAGE_REFUSALS_METRIC = "refusals";

const KNOWN_METRICS = new Set(Object.values(TENANT_USAGE_METRICS));
const REFUSAL_METRICS = new Set(TENANT_REFUSAL_LEDGER_METRICS);
const LEDGER_METRICS = new Set([...KNOWN_METRICS, ...REFUSAL_METRICS]);
const HOUR_MS = 60 * 60 * 1000;
const MIRROR_ANNOTATION_ID = "model_gateway_mirror";
// Distinct (tenant, metric, hour) keys kept between flushes. Far above what
// one process produces in a flush interval; past it new keys are dropped (and
// counted) rather than growing without bound while the database is away.
export const TENANT_USAGE_MAX_PENDING_ENTRIES = 50_000;
// The share of those keys refusal totals may hold.
export const TENANT_USAGE_MAX_PENDING_REFUSAL_ENTRIES = 10_000;
// The longest user or workspace id a row may carry (the registry's
// MAX_TENANT_ID_LENGTH). A client-chosen id (an x-workspace-id a membership
// check refused) can be far longer, and one row whose primary key exceeds
// PostgreSQL's index tuple limit, or an id holding U+0000 (which text cannot
// store), would fail its whole batch at every flush. Such usage is dropped
// and counted (snapshot().unstorableEntries) instead.
export const TENANT_USAGE_MAX_ID_LENGTH = 256;
const FLUSH_BATCH_ROWS = 500;

const normalizeId = (value) => String(value ?? "").trim();

const isStorableId = (id) => id.length <= TENANT_USAGE_MAX_ID_LENGTH && !id.includes("\u0000");

const toAmount = (value) => {
  const amount = Math.round(Number(value));

  return Number.isFinite(amount) && amount > 0 ? Math.min(amount, Number.MAX_SAFE_INTEGER) : 0;
};

const toPeriodStart = (at) => {
  const time = at instanceof Date ? at.getTime() : Number(at);

  return Math.floor((Number.isFinite(time) ? time : Date.now()) / HOUR_MS) * HOUR_MS;
};

const comparePendingEntries = (left, right) =>
  left.workspaceId.localeCompare(right.workspaceId) ||
  left.userId.localeCompare(right.userId) ||
  left.metric.localeCompare(right.metric) ||
  left.periodStart - right.periodStart;

export const isModelGatewayMirrorEvent = (event = {}) =>
  Array.isArray(event?.annotations) &&
  event.annotations.some((annotation) => annotation?.id === MIRROR_ANNOTATION_ID);

/**
 * The upsert one flush batch runs: the batch's rows (unique keys, sorted by
 * the primary key so concurrent flushes from several processes lock rows in
 * the same order) added to whatever the table already holds.
 */
export const buildTenantUsageUpsertSql = (table) => `
  INSERT INTO ${table} (workspace_id, owner_user_id, metric, period_start, value)
  SELECT workspace_id, owner_user_id, metric, period_start, value
  FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::bigint[])
    AS batch (workspace_id, owner_user_id, metric, period_start, value)
  ON CONFLICT (workspace_id, owner_user_id, metric, period_start)
  DO UPDATE SET value = ${table}.value + EXCLUDED.value, updated_at = NOW()
`;

export const createTenantUsageLedger = ({
  clearTimer = clearInterval,
  getFlushMs = getTenantUsageFlushMs,
  getTable = getTenantUsagePostgresTable,
  isDatabaseConfigured = isPostgresConfigured,
  isEnabled = isTenantUsageLedgerEnabled,
  logger = console,
  maxPendingEntries = TENANT_USAGE_MAX_PENDING_ENTRIES,
  maxPendingRefusalEntries = TENANT_USAGE_MAX_PENDING_REFUSAL_ENTRIES,
  now = Date.now,
  query = queryDefaultPostgres,
  runAsSystem = runAsDatabaseSystem,
  setTimer = setInterval,
} = {}) => {
  const pending = new Map();
  let timer = null;
  let flushing = null;
  let droppedEntries = 0;
  let droppedRefusalEntries = 0;
  let pendingRefusalEntries = 0;
  let unstorableEntries = 0;
  let failedFlushes = 0;
  let flushedRows = 0;
  let lastFlushError = null;

  const isActive = () => {
    try {
      return isEnabled() && isDatabaseConfigured();
    } catch {
      return false;
    }
  };

  const ensureTimer = () => {
    if (timer !== null) {
      return;
    }

    timer = setTimer(() => {
      void flush();
    }, getFlushMs());
    timer?.unref?.();
  };

  const add = ({ metric, periodStart, userId, value, workspaceId }) => {
    const key = JSON.stringify([workspaceId, userId, metric, periodStart]);
    const existing = pending.get(key);

    if (existing) {
      existing.value = Math.min(existing.value + value, Number.MAX_SAFE_INTEGER);
      return true;
    }

    const refusal = REFUSAL_METRICS.has(metric);

    if (refusal && pendingRefusalEntries >= maxPendingRefusalEntries) {
      droppedRefusalEntries += 1;
      return false;
    }

    if (pending.size >= maxPendingEntries) {
      droppedEntries += 1;
      return false;
    }

    pending.set(key, { metric, periodStart, userId, value, workspaceId });
    pendingRefusalEntries += refusal ? 1 : 0;
    return true;
  };

  const forget = (key, entry) => {
    pending.delete(key);
    pendingRefusalEntries -= REFUSAL_METRICS.has(entry.metric) ? 1 : 0;
  };

  /**
   * Adds `values` ({ metric: amount }) to the tenant's current hour. Unknown
   * metrics and amounts that are not positive are ignored. Returns whether
   * anything was kept.
   */
  const record = (tenant, values = {}, { at = now() } = {}) => {
    try {
      if (!isActive()) {
        return false;
      }

      const workspaceId = normalizeId(tenant?.workspaceId);
      const userId = normalizeId(tenant?.userId);
      const periodStart = toPeriodStart(at);
      let kept = false;

      for (const [metric, rawValue] of Object.entries(values ?? {})) {
        const value = toAmount(rawValue);

        if (!LEDGER_METRICS.has(metric) || value === 0) {
          continue;
        }

        if (!isStorableId(workspaceId) || !isStorableId(userId)) {
          unstorableEntries += 1;
          continue;
        }

        kept = add({ metric, periodStart, userId, value, workspaceId }) || kept;
      }

      if (kept) {
        ensureTimer();
      }

      return kept;
    } catch (error) {
      logger.error?.("Failed to record tenant usage.", error);
      return false;
    }
  };

  /**
   * One refusal with `reason` (a rag/tenant-refusal-reasons.js code) for the
   * tenant it was decided for (null = ('', '')). An unknown reason is
   * ignored. Never throws.
   */
  const recordRefusal = (tenant, reason, options) => {
    const metric = isTenantRefusalReason(reason) ? toTenantRefusalLedgerMetric(reason) : null;

    return metric ? record(tenant, { [metric]: 1 }, options) : false;
  };

  const writeBatch = async (table, batch) =>
    runAsSystem(() =>
      query(buildTenantUsageUpsertSql(table), [
        batch.map((entry) => entry.workspaceId),
        batch.map((entry) => entry.userId),
        batch.map((entry) => entry.metric),
        batch.map((entry) => new Date(entry.periodStart).toISOString()),
        batch.map((entry) => String(entry.value)),
      ])
    );

  /**
   * Writes every pending total. One flush at a time; a call during a flush
   * waits for it. A batch that fails goes back into the pending totals (with
   * whatever was recorded since), so nothing is counted twice or lost while
   * the database is briefly away.
   */
  const flush = async () => {
    if (flushing) {
      return flushing;
    }

    if (pending.size === 0) {
      return { rows: 0 };
    }

    const entries = [...pending.values()].sort(comparePendingEntries);

    pending.clear();
    pendingRefusalEntries = 0;
    flushing = (async () => {
      let written = 0;
      let index = 0;

      try {
        const table = getTenantUsageTableName(getTable());

        for (; index < entries.length; index += FLUSH_BATCH_ROWS) {
          const batch = entries.slice(index, index + FLUSH_BATCH_ROWS);

          await writeBatch(table, batch);
          written += batch.length;
        }

        lastFlushError = null;
      } catch (error) {
        failedFlushes += 1;
        lastFlushError = error instanceof Error ? error.message : String(error);
        logger.error?.(
          `Failed to flush tenant usage (${entries.length - written} totals kept for the next flush): ${
            error?.code ? `${error.code} ` : ""
          }${error?.name ?? "Error"}.`
        );

        for (const entry of entries.slice(written)) {
          add(entry);
        }
      } finally {
        flushedRows += written;
        flushing = null;
      }

      return { rows: written };
    })();

    return flushing;
  };

  /** Stops the timer and writes what is pending (graceful shutdown). */
  const stop = async () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }

    if (flushing) {
      await flushing;
    }

    if (isActive()) {
      await flush();
    }
  };

  const snapshot = () => ({
    active: isActive(),
    droppedEntries,
    droppedRefusalEntries,
    failedFlushes,
    flushedRows,
    lastFlushError,
    pendingEntries: pending.size,
    pendingRefusalEntries,
    timerRunning: timer !== null,
    unstorableEntries,
  });

  const matchesSelector = (selector, entry) =>
    tenantSelectorMatches(selector, { userId: entry.userId, workspaceId: entry.workspaceId });

  /** The tenant erase's count: this process's unflushed totals of `selector`. */
  const countPending = (selector) =>
    [...pending.values()].filter((entry) => matchesSelector(selector, entry)).length;

  /**
   * The tenant erase (rag/tenant-lifecycle.js): drops this process's unflushed
   * totals of `selector`, so the next flush cannot write them back after the
   * table's rows went. It waits for a flush in flight first: that flush holds
   * entries taken out of the pending map, and one that fails puts them back.
   * Other processes' totals are not reached; usage recorded after the erase
   * (a request still running) is kept as new usage.
   */
  const erasePending = async (selector) => {
    if (flushing) {
      await flushing;
    }

    let erased = 0;

    for (const [key, entry] of [...pending.entries()]) {
      if (matchesSelector(selector, entry)) {
        forget(key, entry);
        erased += 1;
      }
    }

    return erased;
  };

  return { countPending, erasePending, flush, record, recordRefusal, snapshot, stop };
};

let defaultLedger = null;

export const getTenantUsageLedger = () => {
  defaultLedger ??= createTenantUsageLedger();
  return defaultLedger;
};

/** Test seam: replaces (or with null resets) the process-wide ledger. */
export const configureTenantUsageLedger = (ledger) => {
  defaultLedger = ledger ?? null;
};

export const recordTenantUsage = (tenant, values, options) =>
  getTenantUsageLedger().record(tenant, values, options);

export const flushTenantUsage = () => getTenantUsageLedger().flush();

export const stopTenantUsageLedger = () => (defaultLedger ? defaultLedger.stop() : undefined);

// Model calls whose usage the caller books itself, per tenant: the ingest
// embedding batcher's merged requests (rag/ingest-embedding-batcher.js) run as
// no tenant's call because they carry several tenants' texts, so the active
// database tenant would book every token under ('', ''). Inside this scope
// recordTenantModelUsage leaves such events alone, and the caller records
// each tenant's share (recordTenantModelUsageShares).
const callerAttributedModelUsage = new AsyncLocalStorage();

/** Runs `callback` with its model calls' ledger usage left to the caller. */
export const runWithCallerAttributedModelUsage = (callback) => callerAttributedModelUsage.run(true, callback);

/**
 * The ledger amounts of one normalized LLMOps event: { tokens, costMicroUsd },
 * or null for a gateway mirror event or a call that did not succeed.
 */
export const describeTenantModelUsage = (event) => {
  if (!event || event.status !== "ok" || isModelGatewayMirrorEvent(event)) {
    return null;
  }

  const totalTokens =
    event.totalTokens ?? (Number(event.inputTokens) || 0) + (Number(event.outputTokens) || 0);
  const costUsd = Number(event.estimatedCostUsd);

  return {
    costMicroUsd: Number.isFinite(costUsd) ? costUsd * 1_000_000 : 0,
    tokens: Number(totalTokens) || 0,
  };
};

/**
 * Books caller-attributed model usage: `shares` is [{ tenant, tokens,
 * costMicroUsd }], each added to its tenant (null = ('', '')). Never throws.
 */
export const recordTenantModelUsageShares = (shares, { ledger = null } = {}) => {
  try {
    const target = ledger ?? getTenantUsageLedger();
    let kept = false;

    for (const share of shares ?? []) {
      kept =
        target.record(share?.tenant ?? null, {
          [TENANT_USAGE_METRICS.modelTokens]: share?.tokens,
          [TENANT_USAGE_METRICS.modelCostMicroUsd]: share?.costMicroUsd,
        }) || kept;
    }

    return kept;
  } catch {
    return false;
  }
};

/**
 * One normalized LLMOps metric event (llmops-metrics.js): a successful model
 * call adds its tokens and estimated cost to the active database tenant. A
 * gateway mirror event, a failed or skipped call, a call without usage and,
 * without an explicit `tenant`, a call inside runWithCallerAttributedModelUsage
 * (its caller books it) add nothing.
 */
export const recordTenantModelUsage = (event, { ledger = null, tenant = undefined } = {}) => {
  try {
    const usage = describeTenantModelUsage(event);

    if (!usage || (tenant === undefined && callerAttributedModelUsage.getStore() === true)) {
      return false;
    }

    const target = ledger ?? getTenantUsageLedger();

    return target.record(tenant === undefined ? getActiveDatabaseTenant() : tenant, {
      [TENANT_USAGE_METRICS.modelTokens]: usage.tokens,
      [TENANT_USAGE_METRICS.modelCostMicroUsd]: usage.costMicroUsd,
    });
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Tenant erase and export (rag/tenant-lifecycle.js)
// ---------------------------------------------------------------------------

export const TENANT_USAGE_RECORD_TABLES = Object.freeze({
  pending: "tenant_usage:pending",
  rows: "tenant_usage",
});

const toUsageValue = (value) => {
  const number = Number(value);

  return Number.isSafeInteger(number) ? number : String(value ?? "0");
};

const toIsoText = (value) => {
  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? String(value ?? "") : date.toISOString();
};

export const mapTenantUsageRow = (row = {}) => ({
  metric: String(row.metric ?? ""),
  periodStart: toIsoText(row.period_start),
  updatedAt: toIsoText(row.updated_at),
  userId: String(row.owner_user_id ?? ""),
  value: toUsageValue(row.value),
  workspaceId: String(row.workspace_id ?? ""),
});

/**
 * The ledger's records of one tenant (a rag/tenant-records.js selector),
 * matched on the exact (workspace_id, owner_user_id) pair like every other
 * store:
 *
 *   tenant_usage          the table's hourly rows (with a database). Counted
 *                         and deleted in the caller's context (the erase runs
 *                         as the system, which migration 037 lets delete);
 *                         each export page is read bound to its tenant, so the
 *                         tenant policy bounds it too.
 *   tenant_usage:pending  this process's totals not flushed yet: counted, and
 *                         dropped before the rows are deleted so the next
 *                         flush cannot write them back (ledger.erasePending).
 *                         Not exported: they reach the table within
 *                         TENANT_USAGE_FLUSH_MS.
 *
 * Without a database the ledger keeps nothing, so both are empty.
 */
export const createTenantUsageRecordStore = ({
  getTable = getTenantUsagePostgresTable,
  isDatabaseConfigured = isPostgresConfigured,
  ledger = null,
  query = queryDefaultPostgres,
} = {}) => {
  const resolveLedger = () => ledger ?? getTenantUsageLedger();
  const database = createPostgresTenantRecordMethods({
    query,
    tables: () => [
      {
        keyColumns: ["metric", "period_start"],
        mapRow: mapTenantUsageRow,
        name: TENANT_USAGE_RECORD_TABLES.rows,
        table: getTenantUsageTableName(getTable()),
        userColumn: "owner_user_id",
      },
    ],
  });

  return {
    async countTenantRecords(selector) {
      const pending = resolveLedger().countPending?.(selector) ?? 0;
      const rows = isDatabaseConfigured()
        ? await database.countTenantRecords(selector)
        : { [TENANT_USAGE_RECORD_TABLES.rows]: { records: 0 } };

      return { ...rows, [TENANT_USAGE_RECORD_TABLES.pending]: { records: pending } };
    },

    async deleteTenantRecords(selector) {
      const pending = (await resolveLedger().erasePending?.(selector)) ?? 0;
      const rows = isDatabaseConfigured()
        ? await database.deleteTenantRecords(selector)
        : { [TENANT_USAGE_RECORD_TABLES.rows]: { deleted: 0 } };

      return { ...rows, [TENANT_USAGE_RECORD_TABLES.pending]: { deleted: pending } };
    },

    async *iterateTenantRecords(selector) {
      if (isDatabaseConfigured()) {
        yield* database.iterateTenantRecords(selector);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Reading (GET /admin/usage)
// ---------------------------------------------------------------------------

export const TENANT_USAGE_GROUP_BY = Object.freeze({
  tenant: "tenant",
  workspace: "workspace",
});

export const TENANT_USAGE_MAX_TOP = 100;

const invalidUsageQuery = (message) => Object.assign(new Error(message), { expose: true, status: 400 });

const toUsageRange = ({ from, limit, to, workspaceId }) => ({
  filterWorkspace: workspaceId === null || workspaceId === undefined ? null : String(workspaceId),
  fromStart: new Date(toPeriodStart(new Date(from))).toISOString(),
  safeLimit: Math.max(1, Math.min(TENANT_USAGE_MAX_TOP, Math.floor(Number(limit) || 10))),
  toEnd: new Date(to).toISOString(),
});

/**
 * The top `limit` tenants (or workspaces) by refusals over the hours that
 * start in [from rounded down to its hour, to): every refused_<reason> metric
 * added up, or only `reason`'s (a rag/tenant-refusal-reasons.js code). Each
 * row also carries `refusals`, its count per reason code over the range.
 * Same context rules as listTenantUsageTop.
 */
export const listTenantRefusalsTop = async ({
  from,
  getTable = getTenantUsagePostgresTable,
  groupBy = TENANT_USAGE_GROUP_BY.tenant,
  limit = 10,
  query = queryDefaultPostgres,
  reason = null,
  to,
  workspaceId = null,
} = {}) => {
  const reasonMetric = reason === null || reason === undefined ? null : toTenantRefusalLedgerMetric(reason);

  if (reason !== null && reason !== undefined && !reasonMetric) {
    throw invalidUsageQuery(`Unknown refusal reason "${reason}".`);
  }

  const table = getTenantUsageTableName(getTable());
  const byWorkspace = groupBy === TENANT_USAGE_GROUP_BY.workspace;
  const { filterWorkspace, fromStart, safeLimit, toEnd } = toUsageRange({ from, limit, to, workspaceId });
  const owner = byWorkspace ? "''::text" : "owner_user_id";
  const result = await query(
    `
      WITH per_reason AS (
        SELECT workspace_id, ${owner} AS owner_user_id, metric, SUM(value) AS value
        FROM ${table}
        WHERE metric = ANY($1::text[])
          AND period_start >= $2::timestamptz
          AND period_start < $3::timestamptz
          AND ($4::text IS NULL OR workspace_id = $4::text)
        GROUP BY workspace_id${byWorkspace ? "" : ", owner_user_id"}, metric
      )
      SELECT workspace_id, owner_user_id, SUM(value)::text AS value,
             array_agg(metric ORDER BY metric) AS reason_metrics,
             array_agg(value::text ORDER BY metric) AS reason_values
      FROM per_reason
      GROUP BY workspace_id, owner_user_id
      ORDER BY SUM(value) DESC, workspace_id ASC, owner_user_id ASC
      LIMIT $5
    `,
    [reasonMetric ? [reasonMetric] : [...TENANT_REFUSAL_LEDGER_METRICS], fromStart, toEnd, filterWorkspace, safeLimit]
  );

  return {
    from: fromStart,
    rows: (result?.rows ?? []).map((row) => {
      const metrics = Array.isArray(row.reason_metrics) ? row.reason_metrics : [];
      const values = Array.isArray(row.reason_values) ? row.reason_values : [];
      const refusals = {};

      metrics.forEach((metric, index) => {
        const code = fromTenantRefusalLedgerMetric(metric);

        if (code) {
          refusals[code] = Number(values[index] ?? 0);
        }
      });

      return {
        refusals,
        ...(byWorkspace ? {} : { userId: String(row.owner_user_id ?? "") }),
        value: Number(row.value ?? 0),
        workspaceId: String(row.workspace_id ?? ""),
      };
    }),
    to: toEnd,
  };
};

/**
 * The top `limit` tenants (or workspaces) by `metric` over the hours that
 * start in [from rounded down to its hour, to). `workspaceId` narrows to one
 * workspace. Runs in whatever database context the caller bound: the route
 * binds the system context for the platform and workspace views.
 * `metric: "refusals"` (TENANT_USAGE_REFUSALS_METRIC) is
 * listTenantRefusalsTop, with its optional `reason`.
 */
export const listTenantUsageTop = async ({
  from,
  getTable = getTenantUsagePostgresTable,
  groupBy = TENANT_USAGE_GROUP_BY.tenant,
  limit = 10,
  metric,
  query = queryDefaultPostgres,
  reason = null,
  to,
  workspaceId = null,
} = {}) => {
  if (metric === TENANT_USAGE_REFUSALS_METRIC) {
    return listTenantRefusalsTop({ from, getTable, groupBy, limit, query, reason, to, workspaceId });
  }

  if (!KNOWN_METRICS.has(metric)) {
    throw invalidUsageQuery(`Unknown usage metric "${metric}".`);
  }

  if (reason !== null && reason !== undefined) {
    throw invalidUsageQuery(`reason applies only to metric ${TENANT_USAGE_REFUSALS_METRIC}.`);
  }

  const table = getTenantUsageTableName(getTable());
  const byWorkspace = groupBy === TENANT_USAGE_GROUP_BY.workspace;
  const { filterWorkspace, fromStart, safeLimit, toEnd } = toUsageRange({ from, limit, to, workspaceId });
  const result = await query(
    `
      SELECT workspace_id, ${byWorkspace ? "''::text AS owner_user_id" : "owner_user_id"},
             SUM(value)::text AS value
      FROM ${table}
      WHERE metric = $1
        AND period_start >= $2::timestamptz
        AND period_start < $3::timestamptz
        AND ($4::text IS NULL OR workspace_id = $4::text)
      GROUP BY workspace_id${byWorkspace ? "" : ", owner_user_id"}
      ORDER BY SUM(value) DESC, workspace_id ASC${byWorkspace ? "" : ", owner_user_id ASC"}
      LIMIT $5
    `,
    [metric, fromStart, toEnd, filterWorkspace, safeLimit]
  );

  return {
    from: fromStart,
    rows: (result?.rows ?? []).map((row) => ({
      ...(byWorkspace ? {} : { userId: String(row.owner_user_id ?? "") }),
      value: Number(row.value ?? 0),
      workspaceId: String(row.workspace_id ?? ""),
    })),
    to: toEnd,
  };
};
