import { randomBytes } from "node:crypto";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import {
  getAgentRunRetentionDays,
  getFeedbackRetentionDays,
  getRagObservabilityRetentionDays,
  getRetentionSweepBatchSize,
  getRetentionSweepIntervalMs,
  getTaskRetentionDays,
  getWorkspaceArtifactRetentionDays,
} from "./config.js";
import { getTenantRegistryTableNames } from "./db-migrations.js";
import { getObservabilityEventsPath } from "./observability.js";
import { isPostgresConfigured, queryPostgres } from "./postgres.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";
import { computeRetentionCutoff } from "./retention-sql.js";
import {
  parseWorkspaceRetentionPolicy,
  readWorkspaceRetentionPolicyDays,
} from "./workspace-retention-policy.js";

// Retention: a periodic sweep that deletes data older than its configured
// number of days. Every setting defaults to 0 (keep forever), and with all of
// them at 0 no sweeper is created at all: no timer, no statement.
//
//   agent_runs           AGENT_RUN_RETENTION_DAYS: finished runs (completed,
//                        failed, canceled) last updated before the cutoff,
//                        with their events and approval snapshots. A running
//                        or waiting_for_user run (an approval pause, a
//                        clarification, a manual-recovery hand-off: everything
//                        startup recovery lists or an operator resumes) is
//                        never deleted. Swept by the agent tier.
//   tasks                TASK_RETENTION_DAYS: finished tasks (completed,
//                        failed, canceled) and their events. Agent tier.
//   workspace_artifacts  WORKSPACE_ARTIFACT_RETENTION_DAYS: archived artifacts
//                        archived before the cutoff. An active artifact is a
//                        deliverable someone kept, so age alone never deletes
//                        it; archiving starts its clock. API tier.
//   feedback             FEEDBACK_RETENTION_DAYS: answer feedback in
//                        PostgreSQL created before the cutoff (migration 039
//                        lets the system role delete it). The JSONL file store
//                        of the no-database profile is never rewritten. API
//                        tier.
//   rag_observability    RAG_OBSERVABILITY_RETENTION_DAYS: the JSONL trace file
//                        (RAG_OBSERVABILITY_EVENTS_PATH, default
//                        data/rag-observability/events.jsonl) is rotated into a
//                        dated segment once a day, and a segment whose last
//                        write is older than the cutoff is deleted. Files on
//                        one host: swept by every process that runs the
//                        sweeper (API and agent tiers).
//
// Database work runs under runAsDatabaseSystem in batches of
// RETENTION_SWEEP_BATCH_SIZE rows, one statement each (the stores'
// deleteExpired, rag/retention-sql.js). Each statement holds a transaction
// advisory try-lock on its table while it runs, so two instances never delete
// from one table at the same moment: the one that loses the lock stops that
// type for this sweep. A sweep runs one minute after start-up (or one
// interval, when shorter) and then every RETENTION_SWEEP_INTERVAL_MS after the
// previous one finished, so sweeps never overlap. It reports counts in the log
// only (no metrics).
//
// Per-workspace policies: the tenant registry's workspaces (migration 036,
// rag/tenant-registry.js) carry a jsonb `retention_policy`, which may set the
// days of a data type for that workspace. Its format is defined once, in
// rag/workspace-retention-policy.js, and the registry refuses anything else:
// keys agentRuns, tasks, workspaceArtifacts and feedback, each a whole number
// of days from 0 to 36500, e.g. {"agentRuns": 30, "feedback": 0}. A policy
// only adjusts a type that is enabled globally (its variable above 0): it may
// shorten or lengthen the period, and 0 keeps that workspace's data forever.
// A key it leaves out, an unregistered workspace and an unreadable value use
// the global value. The policies are read from the registry's table
// (WORKSPACES_POSTGRES_TABLE, default rag_workspaces) with a database, and
// from the process's in-memory registry without one.
//
// Deletion fails closed on the policies: when they cannot be read (a dropped
// connection, a statement timeout, a failover, a permission error, a table
// name that is not valid), the sweep deletes nothing from the database that
// pass and tries again one interval later. Falling back to the global cutoffs
// would delete, for good, what a workspace's policy keeps longer or forever.
// Only a registry table that does not exist yet (before migration 036) reads
// as "no policies". The observability files carry no workspace and are swept
// either way.

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;
const MAX_BATCHES_PER_TYPE = 1000;
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REGISTRY_PAGE_SIZE = 1000;

export const RETENTION_DATA_TYPES = Object.freeze({
  agentRuns: "agent_runs",
  feedback: "feedback",
  ragObservability: "rag_observability",
  tasks: "tasks",
  workspaceArtifacts: "workspace_artifacts",
});

// What each database type deletes, through the service the routes use (so an
// injected service without a retention delete is skipped, never bypassed).
const DATABASE_TYPES = Object.freeze([
  {
    envName: "AGENT_RUN_RETENTION_DAYS",
    getDays: getAgentRunRetentionDays,
    id: RETENTION_DATA_TYPES.agentRuns,
    resolveDelete: (services) =>
      typeof services?.agentRunService?.deleteExpiredRuns === "function"
        ? (options) => services.agentRunService.deleteExpiredRuns(options)
        : null,
    tier: "agent",
  },
  {
    envName: "TASK_RETENTION_DAYS",
    getDays: getTaskRetentionDays,
    id: RETENTION_DATA_TYPES.tasks,
    resolveDelete: (services) =>
      typeof services?.taskService?.deleteExpiredTasks === "function"
        ? (options) => services.taskService.deleteExpiredTasks(options)
        : null,
    tier: "agent",
  },
  {
    envName: "WORKSPACE_ARTIFACT_RETENTION_DAYS",
    getDays: getWorkspaceArtifactRetentionDays,
    id: RETENTION_DATA_TYPES.workspaceArtifacts,
    resolveDelete: (services) =>
      typeof services?.workspaceArtifactService?.deleteExpiredArtifacts === "function"
        ? (options) => services.workspaceArtifactService.deleteExpiredArtifacts(options)
        : null,
    tier: "api",
  },
  {
    envName: "FEEDBACK_RETENTION_DAYS",
    getDays: getFeedbackRetentionDays,
    id: RETENTION_DATA_TYPES.feedback,
    resolveDelete: (services) =>
      typeof services?.feedbackService?.deleteExpiredFeedback === "function"
        ? (options) => services.feedbackService.deleteExpiredFeedback(options)
        : null,
    tier: "api",
  },
]);

const describeError = (error) =>
  [error?.code, error?.message].filter(Boolean).join(" ") || String(error?.name ?? "Error");

// ---------------------------------------------------------------------------
// Per-workspace policies
// ---------------------------------------------------------------------------

export const RETENTION_POLICIES_UNAVAILABLE_ERROR_CODE = "RETENTION_POLICIES_UNAVAILABLE";

// What a sweep reports for each database type it skipped because the
// policies could not be read.
export const RETENTION_SKIP_REASONS = Object.freeze({
  policiesUnavailable: "workspace_policies_unavailable",
});

/**
 * The workspace retention policies could not be read. The sweep deletes
 * nothing from the database when it sees this (or any other error from its
 * policy loader), so a policy that keeps a workspace's data is never replaced
 * by the global cutoff.
 */
export class RetentionPoliciesUnavailableError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RetentionPoliciesUnavailableError";
    this.code = RETENTION_POLICIES_UNAVAILABLE_ERROR_CODE;
  }
}

const policiesUnavailable = (message, cause) =>
  new RetentionPoliciesUnavailableError(
    cause === undefined ? message : `${message} (${describeError(cause)})`,
    { cause }
  );

const parsePolicy = parseWorkspaceRetentionPolicy;

/**
 * The days a workspace's retention_policy sets for `dataType`, or undefined
 * when it sets none (or a value the format does not allow, which is ignored
 * rather than read as 0). The format is rag/workspace-retention-policy.js's:
 * the key agentRuns, tasks, workspaceArtifacts or feedback with a whole
 * number of days from 0 to 36500; 0 keeps that workspace's data of this type
 * forever.
 */
export const readWorkspaceRetentionDays = (policy, dataType) =>
  readWorkspaceRetentionPolicyDays(policy, dataType);

// The registry's configured workspaces table. A name that is not valid (the
// migrations refuse it too) leaves the policies unknown, so it throws.
const resolveRegistryWorkspacesTable = () => {
  try {
    return getTenantRegistryTableNames().workspacesTable;
  } catch (error) {
    throw policiesUnavailable(
      "workspace retention policies could not be read: the tenant registry's table name is not valid",
      error
    );
  }
};

/**
 * Every workspace's retention policy, as a Map of workspace id to its policy
 * object, read from `table` (default: the tenant registry's workspaces table,
 * WORKSPACES_POSTGRES_TABLE) when that table exists with a `workspace_id` and
 * a `retention_policy` column; an empty Map when it does not exist yet (before
 * migration 036 ran). Runs as system work. Any failure to read it (a table the
 * system role may not read, a dropped connection, a timeout, a name that is
 * not valid) rejects with a RetentionPoliciesUnavailableError instead of
 * answering "no policies": the sweep then deletes nothing from the database,
 * because the global cutoff would delete what a policy keeps.
 */
export const loadWorkspaceRetentionPolicies = async ({
  logger = console,
  query = queryPostgres,
  table,
} = {}) => {
  const configuredTable = table === undefined ? resolveRegistryWorkspacesTable() : table;
  const tableName = String(configuredTable ?? "").trim().toLowerCase();

  if (!TABLE_NAME_PATTERN.test(tableName) || Buffer.byteLength(tableName, "utf8") > 63) {
    throw policiesUnavailable(
      `workspace retention policies could not be read: "${configuredTable}" is not a simple table name`
    );
  }

  return runAsDatabaseSystem(async () => {
    try {
      // The shape comes from pg_attribute, which every role may read:
      // information_schema.columns lists only the columns the current role
      // holds a privilege on, so a revoked grant would read as "no
      // retention_policy column", that is as "no policies", and the sweep
      // would fall back to the global cutoffs. With the catalog the table
      // shows its columns and the SELECT below fails instead.
      const probe = await query(
        `
          SELECT
            probe.relation IS NOT NULL AS table_exists,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = probe.relation
                AND attribute.attname = 'workspace_id'
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
            ) AS has_workspace_id,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = probe.relation
                AND attribute.attname = 'retention_policy'
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
            ) AS has_retention_policy
          FROM (
            SELECT to_regclass(format('%I.%I', current_schema(), $1::text)) AS relation
          ) AS probe
        `,
        [tableName]
      );
      const shape = probe.rows?.[0] ?? {};

      if (shape.table_exists !== true || shape.has_retention_policy !== true) {
        return new Map();
      }

      if (shape.has_workspace_id !== true) {
        logger.warn?.(
          `[retention] workspace policies: table ${tableName} has a retention_policy column but no workspace_id column; global settings apply.`
        );
        return new Map();
      }

      const result = await query(
        `
          SELECT workspace_id, retention_policy
          FROM ${tableName}
          WHERE retention_policy IS NOT NULL
        `
      );
      const policies = new Map();

      for (const row of result.rows ?? []) {
        const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : "";
        const policy = parsePolicy(row.retention_policy);

        if (workspaceId && policy && Object.keys(policy).length > 0) {
          policies.set(workspaceId, policy);
        }
      }

      return policies;
    } catch (error) {
      throw policiesUnavailable(
        `workspace retention policies could not be read from table ${tableName}`,
        error
      );
    }
  });
};

/**
 * Without a database: every workspace's retention policy from the process's
 * in-memory tenant registry (the one the admin routes write,
 * services.tenantRegistry), page by page through its listWorkspaces. The
 * in-memory stores' retention deletes take the same overrides. A failure
 * rejects with a RetentionPoliciesUnavailableError, as the table read does.
 */
export const loadWorkspaceRetentionPoliciesFromRegistry = async ({ registry } = {}) => {
  const policies = new Map();

  if (typeof registry?.listWorkspaces !== "function") {
    return policies;
  }

  try {
    for (let offset = 0; ; offset += REGISTRY_PAGE_SIZE) {
      const page = (await registry.listWorkspaces({ limit: REGISTRY_PAGE_SIZE, offset })) ?? [];

      for (const workspace of page) {
        const workspaceId = typeof workspace?.workspaceId === "string" ? workspace.workspaceId : "";
        const policy = parsePolicy(workspace?.retentionPolicy);

        if (workspaceId && policy && Object.keys(policy).length > 0) {
          policies.set(workspaceId, policy);
        }
      }

      if (page.length < REGISTRY_PAGE_SIZE) {
        return policies;
      }
    }
  } catch (error) {
    throw policiesUnavailable(
      "workspace retention policies could not be read from the tenant registry",
      error
    );
  }
};

/**
 * The policies a sweep uses: the registry's PostgreSQL table with a
 * database, else the in-memory `registry` (none without one). Rejects when
 * they cannot be read.
 */
export const loadDefaultWorkspaceRetentionPolicies = ({ logger = console, registry = null } = {}) =>
  isPostgresConfigured()
    ? loadWorkspaceRetentionPolicies({ logger })
    : loadWorkspaceRetentionPoliciesFromRegistry({ registry });

/**
 * The { workspaceId, cutoff } overrides of one data type: one entry per
 * workspace whose policy sets that type's days (cutoff null when it keeps the
 * data forever).
 */
export const buildWorkspaceCutoffs = ({ dataType, now, policies = new Map() }) => {
  const cutoffs = [];

  for (const [workspaceId, policy] of policies) {
    const days = readWorkspaceRetentionDays(policy, dataType);

    if (days !== undefined) {
      cutoffs.push({ cutoff: computeRetentionCutoff({ days, now }), workspaceId });
    }
  }

  return cutoffs;
};

// ---------------------------------------------------------------------------
// RAG observability files
// ---------------------------------------------------------------------------

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const formatSegmentStamp = (timestamp) =>
  new Date(timestamp).toISOString().replace(/[-:.]/g, "");

const parseSegmentStamp = (stamp) => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);

  if (!match) {
    return Number.NaN;
  }

  const [, year, month, day, hour, minute, second, millisecond] = match;

  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`);
};

/**
 * Where the rotated segments of `eventsPath` live and how they are named:
 * `<base>-<UTC stamp>-<6 hex><ext>` next to the live file (events.jsonl ->
 * events-20261017T120000000Z-1a2b3c.jsonl). The segments sort before the live
 * file, so the observability report, which reads every *.jsonl file of the
 * directory in name order, still reads the events in order. Only files that
 * match this pattern are ever deleted.
 */
export const describeObservabilitySegments = (eventsPath = getObservabilityEventsPath()) => {
  const directory = path.dirname(eventsPath);
  const extension = path.extname(eventsPath);
  const base = path.basename(eventsPath, extension);
  const pattern = new RegExp(
    `^${escapeRegExp(base)}-(\\d{8}T\\d{9}Z)-[0-9a-f]{6}${escapeRegExp(extension)}$`
  );

  return {
    directory,
    liveName: path.basename(eventsPath),
    matchSegment: (name) => {
      const match = pattern.exec(name);

      return match ? parseSegmentStamp(match[1]) : Number.NaN;
    },
    segmentName: (timestamp) =>
      `${base}-${formatSegmentStamp(timestamp)}-${randomBytes(3).toString("hex")}${extension}`,
  };
};

const isMissing = (error) => error?.code === "ENOENT";

/**
 * One pass over the observability files: rotate the live file into a segment
 * when it holds events and no segment was started within the last day, then
 * delete every segment whose last write is older than the cutoff (all its
 * events are older still; an event therefore lives between `days` and
 * `days` + 1 days). Appends that opened the live file just before the rename
 * land in the segment, which is why a segment is judged by its modification
 * time and not by its name. Resolves to { rotated, deleted, deletedBytes }.
 */
export const pruneRagObservabilityFiles = async ({
  days = getRagObservabilityRetentionDays(),
  eventsPath = getObservabilityEventsPath(),
  fs = { readdir, rename, stat, unlink },
  now = Date.now(),
} = {}) => {
  const cutoff = computeRetentionCutoff({ days, now });

  if (!cutoff) {
    return { deleted: 0, deletedBytes: 0, rotated: false };
  }

  const segments = describeObservabilitySegments(eventsPath);
  let names;

  try {
    names = await fs.readdir(segments.directory);
  } catch (error) {
    if (isMissing(error)) {
      return { deleted: 0, deletedBytes: 0, rotated: false };
    }

    throw error;
  }

  const existing = names
    .map((name) => ({ name, startedAt: segments.matchSegment(name) }))
    .filter((segment) => Number.isFinite(segment.startedAt));
  const newestStart = Math.max(Number.NEGATIVE_INFINITY, ...existing.map((segment) => segment.startedAt));
  let rotated = false;

  if (names.includes(segments.liveName) && newestStart <= now - DAY_MS) {
    const livePath = path.join(segments.directory, segments.liveName);

    try {
      const live = await fs.stat(livePath);

      if (live.isFile() && live.size > 0) {
        await fs.rename(livePath, path.join(segments.directory, segments.segmentName(now)));
        rotated = true;
      }
    } catch (error) {
      // Another process rotated or removed it first.
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  const cutoffMs = Date.parse(cutoff);
  let deleted = 0;
  let deletedBytes = 0;

  for (const segment of existing) {
    const segmentPath = path.join(segments.directory, segment.name);

    try {
      const info = await fs.stat(segmentPath);

      if (!info.isFile() || info.mtimeMs >= cutoffMs) {
        continue;
      }

      await fs.unlink(segmentPath);
      deleted += 1;
      deletedBytes += Number(info.size) || 0;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  return { deleted, deletedBytes, rotated };
};

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * The data types this process sweeps: agent runs and tasks where it hosts
 * the agent tier, feedback and workspace artifacts where it hosts the API
 * tier, the observability files in either case. Each entry carries its
 * configured days; types at 0 are left out.
 */
export const resolveRetentionTargets = ({
  hostsAgentTier = false,
  hostsApiTier = false,
  observabilityDays = getRagObservabilityRetentionDays(),
  services = {},
} = {}) => {
  const hosted = new Set([...(hostsAgentTier ? ["agent"] : []), ...(hostsApiTier ? ["api"] : [])]);
  const database = DATABASE_TYPES.filter((type) => hosted.has(type.tier))
    .map((type) => ({
      days: type.getDays(),
      deleteBatch: type.resolveDelete(services),
      envName: type.envName,
      id: type.id,
    }))
    .filter((type) => type.days > 0);
  const observability =
    hosted.size > 0 && Math.floor(Number(observabilityDays)) > 0
      ? { days: Math.floor(Number(observabilityDays)), id: RETENTION_DATA_TYPES.ragObservability }
      : null;

  return { database, observability };
};

const sweepDatabaseType = async ({
  batchSize,
  isStopping,
  logger,
  maxBatches,
  now,
  policies,
  target,
  warned,
}) => {
  const cutoff = computeRetentionCutoff({ days: target.days, now });

  if (!cutoff) {
    return null;
  }

  if (!target.deleteBatch) {
    if (!warned.has(target.id)) {
      warned.add(target.id);
      logger.warn?.(
        `[retention] ${target.id}: ${target.envName} is set, but this process's store has no retention delete; skipped.`
      );
    }

    return null;
  }

  const workspaceCutoffs = buildWorkspaceCutoffs({ dataType: target.id, now, policies });
  const summary = { batches: 0, cutoff, deleted: 0, deletedEvents: 0, locked: false, more: false };

  while (!isStopping()) {
    if (summary.batches >= maxBatches) {
      summary.more = true;
      break;
    }

    const result = await runAsDatabaseSystem(() =>
      target.deleteBatch({ cutoff, limit: batchSize, workspaceCutoffs })
    );

    if (result === null || result === undefined) {
      if (!warned.has(target.id)) {
        warned.add(target.id);
        logger.warn?.(
          `[retention] ${target.id}: ${target.envName} is set, but this process's store has no retention delete; skipped.`
        );
      }

      return null;
    }

    summary.batches += 1;

    if (result.acquired === false) {
      summary.locked = true;
      break;
    }

    const deleted = Number(result.deleted) || 0;

    summary.deleted += deleted;
    summary.deletedEvents += Number(result.deletedEvents) || 0;

    if (deleted < batchSize) {
      break;
    }
  }

  return summary;
};

const logDatabaseSummary = (logger, target, summary) => {
  if (summary.locked && summary.deleted === 0) {
    logger.log?.(`[retention] ${target.id}: another instance holds this table's sweep; skipped.`);
    return;
  }

  if (summary.deleted === 0) {
    return;
  }

  const events = summary.deletedEvents > 0 ? ` (and ${summary.deletedEvents} events)` : "";
  const more = summary.more ? "; more remain for the next sweep" : "";

  logger.log?.(
    `[retention] ${target.id}: deleted ${summary.deleted}${events} older than ${target.days} days (before ${summary.cutoff})${more}.`
  );
};

/**
 * The sweeper over resolved targets. `sweep()` runs one pass (every type,
 * one failing type never stops the others) and resolves to a report;
 * `start()` schedules passes; `stop()` cancels the next pass, lets the one in
 * flight finish its current batch, and resolves when it has. Everything that
 * touches time or the database is injectable for tests.
 */
export const createRetentionSweeper = ({
  batchSize = getRetentionSweepBatchSize(),
  clearTimer = clearTimeout,
  eventsPath,
  initialDelayMs,
  intervalMs = getRetentionSweepIntervalMs(),
  // The tenant registry without a database (services.tenantRegistry); with
  // one the policies come from its table.
  tenantRegistry = null,
  loadPolicies = ({ logger }) =>
    loadDefaultWorkspaceRetentionPolicies({ logger, registry: tenantRegistry }),
  logger = console,
  maxBatchesPerType = MAX_BATCHES_PER_TYPE,
  now = () => Date.now(),
  pruneObservability = pruneRagObservabilityFiles,
  setTimer = setTimeout,
  targets = { database: [], observability: null },
} = {}) => {
  const warned = new Set();
  const delay = Math.max(0, Math.floor(Number(intervalMs)) || 0);
  const firstDelay =
    initialDelayMs === undefined ? Math.min(INITIAL_DELAY_MS, delay) : Math.max(0, Number(initialDelayMs) || 0);
  let timer = null;
  let inFlight = null;
  let stopping = false;
  let started = false;

  const sweepOnce = async () => {
    const sweepNow = now();
    const report = {};
    let database = targets.database ?? [];
    let policies = new Map();

    if (database.some((target) => target.deleteBatch)) {
      try {
        policies = (await loadPolicies({ logger })) ?? new Map();
      } catch (error) {
        // Fail closed: without the policies a global cutoff could delete what
        // a workspace keeps longer or forever, so no database type is swept
        // this pass. The next pass reads them again.
        const skipped = database.filter((target) => target.deleteBatch);

        logger.error?.(
          `[retention] workspace retention policies could not be read (${describeError(error)}); nothing is deleted from ${skipped
            .map((target) => target.id)
            .join(", ")} this sweep, the next one tries again.`
        );

        for (const target of skipped) {
          report[target.id] = {
            error: describeError(error),
            skipped: RETENTION_SKIP_REASONS.policiesUnavailable,
          };
        }

        database = database.filter((target) => !target.deleteBatch);
      }
    }

    for (const target of database) {
      if (stopping) {
        break;
      }

      try {
        const summary = await sweepDatabaseType({
          batchSize,
          isStopping: () => stopping,
          logger,
          maxBatches: maxBatchesPerType,
          now: sweepNow,
          policies,
          target,
          warned,
        });

        if (summary) {
          report[target.id] = summary;
          logDatabaseSummary(logger, target, summary);
        }
      } catch (error) {
        report[target.id] = { error: describeError(error) };
        logger.error?.(`[retention] ${target.id}: sweep failed (${describeError(error)}).`);
      }
    }

    if (targets.observability && !stopping) {
      const { id, days } = targets.observability;

      try {
        const summary = await pruneObservability({
          days,
          ...(eventsPath ? { eventsPath } : {}),
          now: sweepNow,
        });

        report[id] = summary;

        if (summary.deleted > 0 || summary.rotated) {
          logger.log?.(
            `[retention] ${id}: ${summary.rotated ? "rotated the live file; " : ""}deleted ${summary.deleted} segments (${summary.deletedBytes} bytes) older than ${days} days.`
          );
        }
      } catch (error) {
        report[id] = { error: describeError(error) };
        logger.error?.(`[retention] ${id}: sweep failed (${describeError(error)}).`);
      }
    }

    return report;
  };

  const sweep = () => {
    inFlight ??= sweepOnce().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  const schedule = (wait) => {
    if (stopping || delay <= 0) {
      return;
    }

    timer = setTimer(() => {
      timer = null;
      sweep()
        .catch((error) => {
          logger.error?.(`[retention] sweep failed (${describeError(error)}).`);
        })
        .finally(() => schedule(delay));
    }, wait);
    timer?.unref?.();
  };

  return {
    get running() {
      return started && !stopping;
    },

    start() {
      if (started || stopping) {
        return this;
      }

      started = true;
      schedule(firstDelay);
      return this;
    },

    stop() {
      stopping = true;

      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }

      return inFlight ? inFlight.then(() => undefined, () => undefined) : Promise.resolve();
    },

    sweep,
  };
};

/**
 * Starts the sweeper for this process when it has anything to sweep, and
 * returns it (null otherwise: every type at 0, a type not hosted here, or
 * RETENTION_SWEEP_INTERVAL_MS=0). server.js and startServiceRole call it with
 * the tiers the process hosts and stop it alongside the drain on shutdown.
 */
export const startRetentionSweeper = ({
  hostsAgentTier = false,
  hostsApiTier = false,
  logger = console,
  services = {},
  ...options
} = {}) => {
  const targets = resolveRetentionTargets({ hostsAgentTier, hostsApiTier, services });

  if (targets.database.length === 0 && !targets.observability) {
    return null;
  }

  const intervalMs = options.intervalMs ?? getRetentionSweepIntervalMs();
  const described = [
    ...targets.database.map((target) => `${target.id}=${target.days}d`),
    ...(targets.observability ? [`${targets.observability.id}=${targets.observability.days}d`] : []),
  ].join(", ");

  if (!(Number(intervalMs) > 0)) {
    logger.warn?.(
      `[retention] retention is configured (${described}) but RETENTION_SWEEP_INTERVAL_MS is 0, so nothing is swept.`
    );
    return null;
  }

  const sweeper = createRetentionSweeper({
    tenantRegistry: services?.tenantRegistry ?? null,
    ...options,
    intervalMs,
    logger,
    targets,
  });

  logger.log?.(`[retention] sweeping every ${intervalMs} ms: ${described}.`);

  return sweeper.start();
};
