// Tenant erase and export: every record one tenant left in the archive.
//
// A tenant is a selector (rag/tenant-records.js): a workspace (every user of
// it), a user in a workspace, or a user outside any workspace. Both jobs walk
// the same stores in a fixed order and report per table:
//
//   ingest_jobs        jobs, their stage outputs, the ingest attempt files of
//                      those jobs in <uploads>/ingest-tmp
//   upload_sessions    chunked upload sessions on disk (manifest + chunks)
//   tasks              tasks and task events
//   agent_runs         runs, run events, approval snapshots
//   documents          registry rows and bytes; on pgvector their chunks in
//                      EVERY chunk table that still exists (write targets and
//                      any other index version), on local/Qdrant through the
//                      vector store's delete call; this process's registry map
//                      and the semantic cache entries built on them
//   workspace_artifacts
//   feedback           PostgreSQL (migration 034) or the JSONL file
//   session_memory     by the owner columns of migration 031
//   long_memory        LONG_MEMORY_SCOPE=user: per user, only a selector that
//                      names a user; `workspace`: by the (user, workspace_id)
//                      pair of migration 045, like the other tables
//   claim_judge_cache  this process's verdicts and, with RAG_SHARED_STATE=redis,
//                      the tenant's Redis keys (SCAN by partition pattern)
//   semantic_cache     this process's entries cached for the tenant
//   tenant_usage       the usage ledger's hourly rows (migration 037) and this
//                      process's unflushed totals (rag/tenant-usage.js)
//   tenant_registry    the tenant registry (migration 036): a workspace
//                      selector's workspace row and every membership of it; a
//                      user in a workspace, that membership (a user outside
//                      any workspace has none)
//
// The order stops new work from re-creating erased records: ingest jobs go
// first, so a worker that still holds one fails its fenced commit instead of
// registering a document after the documents are gone; then uploads, tasks and
// runs; then the documents and everything that refers to them; the caches;
// the usage ledger; the registry last. A workspace erase also marks the
// registry workspace `deleting` before the first store is erased (once the
// active-work check has passed), so TENANT_MEMBERSHIP=enforce refuses the
// workspace's requests while its data goes (this process at once, others
// within TENANT_REGISTRY_CACHE_TTL_MS); its memberships and its row are
// deleted last, so an erase that fails part-way leaves it `deleting` until a
// later run finishes. A dry run changes nothing, the registry status
// included. Admin audit events are kept (the retention purge removes them);
// an applied erase adds one tombstone event (admin.tenant.erased) with the
// tenant's ids and the per-table counts only.
//
// The erase is system work: everything runs under runAsDatabaseSystem, so
// with the role split on (POSTGRES_MIGRATION_DATABASE_URL) it runs as the
// system role, which may delete in every table it touches (migration 035,
// migration 036 for the registry, 037 for the usage ledger and 038 for
// feedback). It is idempotent: an erase that failed or was interrupted is
// finished by running it again. It refuses a tenant with work in flight (an
// ingest job queued or running, a task queued or running, an agent run
// running) unless forced; see eraseTenant.
//
// The export streams JSON Lines: a header, one line per record (bytes as
// { base64 }, document file bytes included), and a summary. Stored bytes that
// cannot be decrypted (a key destroyed outside an erase, a changed byte) are
// exported as null with the code in the record's `unreadableBytes`, counted in
// the summary's `unreadableRecords`, and make the export `partial`; they do
// not end it. Every PostgreSQL
// read runs under runWithDatabaseTenant for one (user, workspace) pair at a
// time, so row-level security bounds it to that tenant on top of the WHERE
// clause; in-memory stores select by the same exact owner match. Caches and
// derived index data (chunks, embeddings, the parse/chunk/embed stage
// outputs' payloads) are not exported: they are rebuilt from the documents.
//
// Crypto-shred (TENANT_ENCRYPTION, rag/tenant-encryption.js): once every
// store was erased without a failure, an applied erase destroys the tenant's
// key -- a workspace selector the workspace key, a user outside any workspace
// that user's key -- so the file bytes any older database backup still holds
// for the tenant can no longer be decrypted. A user inside a workspace shares
// the workspace key with every other member: that erase deletes the user's
// rows and destroys no key (reported as `kept`). An erase that failed before
// the key step leaves the key; running it again finishes it. The result and
// the tombstone name key ids and versions only (`tenantKeys`); a dry run says
// what would be destroyed. With encryption off and no key on file the erase
// has no key step and its result is exactly what it was before. Chunk text,
// embeddings, runs, feedback and memory are not encrypted (search and the
// agent read them): the erase deletes them, but an older database backup
// still holds them, so backup retention must stay bounded.
//
// Neither job revokes the tenant's credentials. Revoke them first, or new
// requests write new records after the erase (with TENANT_MEMBERSHIP=enforce
// the `deleting` status refuses a workspace's requests, but not those of a
// user-level tenant). Other processes' in-process state (their semantic cache
// and claim-judge verdicts, their document registry map until its next
// refresh, their unflushed usage totals) is not reached from here.
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { ADMIN_AUDIT_EVENT_TYPES } from "./admin-audit.js";
import { getDocumentRegistryTenantRecordStore } from "./doc-registry.js";
import { countTenantDocuments, eraseTenantDocuments } from "./index.js";
import { INGEST_TEMP_SUBDIRECTORY } from "./ingest-worker.js";
import { getLongMemoryTenantRecordStore, longMemoryAppliesToTenantSelector } from "./long-memory.js";
import { getSessionMemoryTenantRecordStore } from "./memory.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";
import { eraseClaimJudgeTenantVerdicts } from "./self-check/claim-judge.js";
import {
  countSemanticCacheTenantEntries,
  invalidateSemanticCacheTenant,
} from "./semantic-cache.js";
import { describeTenantKeysForErase, destroyTenantKeysForErase } from "./tenant-encryption.js";
import {
  TENANT_ACTIVE_STATUSES,
  normalizeTenantSelector,
  tenantSelectorMatches,
  toTenantExportValue,
} from "./tenant-records.js";
import { getDefaultTenantRegistry } from "./tenant-registry.js";
import { createTenantUsageRecordStore } from "./tenant-usage.js";

export const TENANT_LIFECYCLE_ERROR_CODES = Object.freeze({
  activeWork: "TENANT_ERASE_ACTIVE_WORK",
});

export const TENANT_EXPORT_FORMAT = "archive-rag-tenant-export";
export const TENANT_EXPORT_VERSION = 1;

export const TENANT_STORE_IDS = Object.freeze([
  "ingest_jobs",
  "upload_sessions",
  "tasks",
  "agent_runs",
  "documents",
  "workspace_artifacts",
  "feedback",
  "session_memory",
  "long_memory",
  "claim_judge_cache",
  "semantic_cache",
  "tenant_usage",
  "tenant_registry",
]);

// What a store adapter resolves to: usable, a store that cannot list or
// delete a tenant's records, or nothing configured to hold any (no database).
export const TENANT_STORE_STATUSES = Object.freeze({
  failed: "failed",
  notApplicable: "not_applicable",
  notConfigured: "not_configured",
  ok: "ok",
  unsupported: "unsupported",
});

const INGEST_TEMP_FILE_PATTERN =
  /^ingest-(.+)-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/i;

const hasTenantRecordCalls = (store) =>
  Boolean(store) &&
  typeof store.countTenantRecords === "function" &&
  typeof store.deleteTenantRecords === "function";

const resolveRecordStore = (store) =>
  hasTenantRecordCalls(store)
    ? { status: TENANT_STORE_STATUSES.ok, store }
    : {
        status: store ? TENANT_STORE_STATUSES.unsupported : TENANT_STORE_STATUSES.notConfigured,
        store: null,
      };

const toAsyncIterable = async function* (store, selector) {
  if (typeof store?.iterateTenantRecords === "function") {
    yield* store.iterateTenantRecords(selector);
    return;
  }

  if (typeof store?.listTenantRecords === "function") {
    yield* await store.listTenantRecords(selector);
  }
};

const describeError = (error) => ({
  code: typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "ERROR",
});

/**
 * The ingest attempt files of the selector's jobs: `<uploads>/ingest-tmp/
 * ingest-<jobId>-<attempt>-<uuid>.pdf` (rag/ingest-worker.js), looked up while
 * the jobs still exist. A worker process with its own temp directory is not
 * reached; its files go when its attempt ends or its sweep runs.
 */
const listTenantIngestTempFiles = async ({ ingestJobStore, selector, uploadsDirectory }) => {
  if (!uploadsDirectory || typeof ingestJobStore?.get !== "function") {
    return [];
  }

  const directory = path.join(uploadsDirectory, INGEST_TEMP_SUBDIRECTORY);
  let entries;

  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = [];

  for (const entry of entries) {
    const match = entry.match(INGEST_TEMP_FILE_PATTERN);

    if (!match) {
      continue;
    }

    const job = await ingestJobStore.get(match[1], {});

    if (job && tenantSelectorMatches(selector, job)) {
      files.push(path.join(directory, entry));
    }
  }

  return files;
};

const mergeCounts = (counted = {}, deleted = {}) => {
  const tables = {};

  for (const table of new Set([...Object.keys(counted), ...Object.keys(deleted)])) {
    tables[table] = {
      ...(counted[table] ?? {}),
      ...(deleted[table] ? { deleted: deleted[table].deleted } : {}),
    };
  }

  return tables;
};

/**
 * The service behind npm run tenant:erase / tenant:export and the admin
 * routes (routes/admin-tenant-lifecycle.js). Every store is passed in the way
 * createAppServices built it; a store left out or without the tenant record
 * calls is reported (`not_configured`, `unsupported`) rather than skipped in
 * silence, and an erase that could not reach every store says
 * `complete: false`. The defaults are the module-level stores (documents,
 * session and long-term memory, the caches).
 */
export const createTenantLifecycleService = ({
  adminAuditService = null,
  agentRunStore = null,
  claimJudge = { erase: eraseClaimJudgeTenantVerdicts },
  documents = {
    count: countTenantDocuments,
    erase: eraseTenantDocuments,
    resolveRecordStore: getDocumentRegistryTenantRecordStore,
  },
  feedbackStore = null,
  ingestJobStore = null,
  logger = console,
  longMemory = getLongMemoryTenantRecordStore,
  now = () => new Date().toISOString(),
  semanticCache = {
    count: countSemanticCacheTenantEntries,
    erase: invalidateSemanticCacheTenant,
  },
  sessionMemory = getSessionMemoryTenantRecordStore,
  taskStore = null,
  // The crypto-shred step (rag/tenant-encryption.js): `describe(selector)`
  // and `destroy(selector)` over the configured KMS. Null leaves it out.
  tenantKeys = { describe: describeTenantKeysForErase, destroy: destroyTenantKeysForErase },
  // The registry service (rag/tenant-registry.js) whose workspace a workspace
  // erase marks `deleting` and whose rows it deletes last: the instance the
  // app's enforcement reads, so this process's lookup cache is dropped at
  // once. A function is called on first use; null leaves the registry out
  // (reported as not configured).
  tenantRegistry = getDefaultTenantRegistry,
  // The usage ledger's records (rag/tenant-usage.js): the table's rows and
  // this process's unflushed totals.
  tenantUsageStore = createTenantUsageRecordStore(),
  uploadStore = null,
  uploadsDirectory = null,
  workspaceArtifactStore = null,
} = {}) => {
  const recordAdapter = (id, store) => ({
    count: (target, selector) => target.countTenantRecords(selector),
    erase: (target, selector) => target.deleteTenantRecords(selector),
    export: (target, selector) => toAsyncIterable(target, selector),
    id,
    resolve: () => resolveRecordStore(store),
  });

  const resolveModuleStore = (resolveStore) => () => {
    const resolved = resolveStore();

    return resolved.status === TENANT_STORE_STATUSES.ok && !hasTenantRecordCalls(resolved.store)
      ? { status: TENANT_STORE_STATUSES.unsupported, store: null }
      : resolved;
  };

  // A registry is usable only when it can also mark a workspace deleting: a
  // workspace erase must never remove the rows of a workspace whose requests
  // it did not stop first.
  const resolveTenantRegistry = () => {
    const registry = typeof tenantRegistry === "function" ? tenantRegistry() : tenantRegistry;

    return hasTenantRecordCalls(registry) && typeof registry.markWorkspaceDeleting === "function"
      ? { status: TENANT_STORE_STATUSES.ok, store: registry }
      : {
          status: registry ? TENANT_STORE_STATUSES.unsupported : TENANT_STORE_STATUSES.notConfigured,
          store: null,
        };
  };

  const adapters = [
    {
      ...recordAdapter("ingest_jobs", ingestJobStore),
      async count(target, selector) {
        const tables = await target.countTenantRecords(selector);
        const files = await listTenantIngestTempFiles({ ingestJobStore: target, selector, uploadsDirectory });

        return { ...tables, ingest_temp_files: { records: files.length } };
      },
      async erase(target, selector) {
        // The attempt files are matched to their jobs before the jobs go.
        const files = await listTenantIngestTempFiles({ ingestJobStore: target, selector, uploadsDirectory });
        const tables = await target.deleteTenantRecords(selector);

        for (const file of files) {
          await rm(file, { force: true });
        }

        return { ...tables, ingest_temp_files: { deleted: files.length } };
      },
    },
    {
      count: async (target, selector) => ({
        upload_sessions: { records: (await target.listUploadSessionsForTenant(selector)).length },
      }),
      erase: async (target, selector) => ({
        upload_sessions: { deleted: await target.eraseUploadSessionsForTenant(selector) },
      }),
      async *export(target, selector) {
        for (const session of await target.listUploadSessionsForTenant(selector)) {
          yield {
            record: { chunkFiles: session.chunkFiles, manifest: session.manifest },
            table: "upload_sessions",
          };
        }
      },
      id: "upload_sessions",
      resolve: () =>
        uploadStore &&
        typeof uploadStore.listUploadSessionsForTenant === "function" &&
        typeof uploadStore.eraseUploadSessionsForTenant === "function"
          ? { status: TENANT_STORE_STATUSES.ok, store: uploadStore }
          : {
              status: uploadStore ? TENANT_STORE_STATUSES.unsupported : TENANT_STORE_STATUSES.notConfigured,
              store: null,
            },
    },
    recordAdapter("tasks", taskStore),
    recordAdapter("agent_runs", agentRunStore),
    {
      async count(target, selector) {
        const { chunks, documents: stored } = await target.count(selector);

        return {
          documents: { records: stored.length },
          ...Object.fromEntries(
            Object.entries(chunks ?? {}).map(([table, count]) => [`chunks:${table}`, { records: count }])
          ),
        };
      },
      async erase(target, selector) {
        const { chunks, documents: erased } = await target.erase(selector);

        return {
          documents: { deleted: erased.length },
          ...Object.fromEntries(
            Object.entries(chunks ?? {}).map(([table, count]) => [`chunks:${table}`, { deleted: count }])
          ),
        };
      },
      async *export(target, selector) {
        const resolved = target.resolveRecordStore?.() ?? { status: TENANT_STORE_STATUSES.notConfigured };

        if (resolved.status !== TENANT_STORE_STATUSES.ok) {
          return;
        }

        yield* toAsyncIterable(resolved.store, selector);
      },
      exportStatus: (target) =>
        (target.resolveRecordStore?.() ?? { status: TENANT_STORE_STATUSES.notConfigured }).status,
      id: "documents",
      resolve: () =>
        documents && typeof documents.count === "function" && typeof documents.erase === "function"
          ? { status: TENANT_STORE_STATUSES.ok, store: documents }
          : { status: TENANT_STORE_STATUSES.unsupported, store: null },
    },
    recordAdapter("workspace_artifacts", workspaceArtifactStore),
    recordAdapter("feedback", feedbackStore),
    { ...recordAdapter("session_memory", null), resolve: resolveModuleStore(sessionMemory) },
    {
      ...recordAdapter("long_memory", null),
      appliesTo: longMemoryAppliesToTenantSelector,
      resolve: resolveModuleStore(longMemory),
    },
    {
      count: async (target, selector) => {
        const counted = await target.erase(selector, { dryRun: true });

        return {
          "claim_judge_cache:local": { records: counted.local },
          "claim_judge_cache:shared": { records: counted.shared },
        };
      },
      erase: async (target, selector) => {
        const erased = await target.erase(selector, { dryRun: false });

        return {
          "claim_judge_cache:local": { deleted: erased.local },
          "claim_judge_cache:shared": { deleted: erased.shared },
        };
      },
      exported: false,
      id: "claim_judge_cache",
      resolve: () =>
        typeof claimJudge?.erase === "function"
          ? { status: TENANT_STORE_STATUSES.ok, store: claimJudge }
          : { status: TENANT_STORE_STATUSES.notConfigured, store: null },
    },
    {
      count: (target, selector) => ({
        semantic_cache: {
          records: target.count((tenant) => tenantSelectorMatches(selector, tenant)),
        },
      }),
      erase: (target, selector) => ({
        semantic_cache: {
          deleted: target.erase((tenant) => tenantSelectorMatches(selector, tenant)),
        },
      }),
      exported: false,
      id: "semantic_cache",
      resolve: () =>
        typeof semanticCache?.count === "function" && typeof semanticCache?.erase === "function"
          ? { status: TENANT_STORE_STATUSES.ok, store: semanticCache }
          : { status: TENANT_STORE_STATUSES.notConfigured, store: null },
    },
    recordAdapter("tenant_usage", tenantUsageStore),
    {
      ...recordAdapter("tenant_registry", null),
      // Before any store is erased: a workspace erase stops the workspace's
      // requests (TENANT_MEMBERSHIP=enforce refuses a deleting workspace).
      // Its rows are deleted by `erase`, in TENANT_STORE_IDS order: last.
      async beforeErase(target, selector) {
        if (selector.userId !== null) {
          return null;
        }

        return {
          workspaceStatus: (await target.markWorkspaceDeleting(selector.workspaceId))
            ? "deleting"
            : "not_registered",
        };
      },
      resolve: resolveTenantRegistry,
    },
  ];

  const resolveAdapters = (selector) =>
    adapters.map((adapter) => {
      if (adapter.appliesTo && !adapter.appliesTo(selector)) {
        return { adapter, status: TENANT_STORE_STATUSES.notApplicable, target: null };
      }

      const resolved = adapter.resolve();

      return { adapter, status: resolved.status, target: resolved.store };
    });

  const countAll = async (selector, resolved) => {
    const stores = [];

    for (const { adapter, status, target } of resolved) {
      stores.push({
        store: adapter.id,
        status,
        tables: status === TENANT_STORE_STATUSES.ok ? await adapter.count(target, selector) : {},
      });
    }

    return stores;
  };

  const describeActiveWork = (stores) => {
    const activeWork = {};

    for (const { tables } of stores) {
      for (const [table, count] of Object.entries(tables)) {
        if (TENANT_ACTIVE_STATUSES[table] && Number(count.active) > 0) {
          activeWork[table] = Number(count.active);
        }
      }
    }

    return activeWork;
  };

  const totalCounts = (stores, field) =>
    Object.fromEntries(
      stores.flatMap(({ tables }) =>
        Object.entries(tables)
          .filter(([, entry]) => entry && entry[field] !== undefined)
          .map(([table, entry]) => [table, Number(entry[field]) || 0])
      )
    );

  // What the erase does to keys, or null when it does nothing with them
  // (encryption off and no key on file), so such an erase reports exactly
  // what it did before. A keystore that cannot be read is reported, not
  // thrown: the rows can still go, and the key step then fails.
  const planTenantKeys = async (selector) => {
    if (typeof tenantKeys?.describe !== "function" || typeof tenantKeys?.destroy !== "function") {
      return null;
    }

    try {
      const plan = await tenantKeys.describe(selector);

      return plan?.applies ? { destroy: plan.destroy ?? [], kept: plan.kept ?? [] } : null;
    } catch (error) {
      logger.error?.("[tenant-lifecycle] reading the tenant keys failed.", error);
      return { destroy: [], error: describeError(error), kept: [] };
    }
  };

  // The tombstone's form of the key step: key ids and versions only.
  const toAuditTenantKeys = (tenantKeysResult) => ({
    destroyed: (tenantKeysResult.destroyed ?? []).map(({ destroyedVersions, keyId }) => ({
      keyId,
      versions: destroyedVersions,
    })),
    kept: (tenantKeysResult.kept ?? []).map(({ keyId }) => ({ keyId })),
    status: tenantKeysResult.status,
  });

  const recordLifecycleEvent = async ({ actor, details, permissionId, reason, request, type, actionId }) => {
    if (typeof adminAuditService?.recordTenantLifecycleEvent !== "function") {
      return false;
    }

    try {
      await adminAuditService.recordTenantLifecycleEvent({
        accessScope: actor,
        actionId,
        details,
        permissionId,
        reason,
        request,
        type,
      });
      return true;
    } catch (error) {
      logger.error?.("[tenant-lifecycle] failed to record the audit event.", error);
      return false;
    }
  };

  /**
   * Counts (dryRun, the default) or erases every record of `workspaceId` /
   * `userId` (normalizeTenantSelector). The result lists every store with its
   * status and per-table `records` (counted first) and, when applied,
   * `deleted`.
   *
   * Running work: an applied erase first counts, and refuses (status
   * `refused`, error code TENANT_ERASE_ACTIVE_WORK, nothing deleted) while
   * the tenant has an ingest job queued or running, a task queued or running,
   * or an agent run running. Erasing under them would race their writes: a
   * job could commit a document, a run could append events, after their
   * records went. Cancel or finish that work, or pass `force: true` for work
   * that is stuck (a crashed worker's lease, a run that never settled); the
   * fences then make the in-flight writers fail (an ingest commit is fenced on
   * its job row, run and task updates are revision or claim checked), and a
   * record that still lands after the erase is removed by running it again.
   *
   * Stores are erased in TENANT_STORE_IDS order; the first that fails stops
   * the erase (status `failed`), and the audit tombstone records the outcome
   * either way. `actor` and `request` describe who ran it for that event.
   *
   * The registry: once the erase may run, a workspace selector's workspace is
   * marked `deleting` before the first store is erased (its store entry says
   * `workspaceStatus: "deleting"`, or `"not_registered"`); a failure to mark
   * it stops the erase with nothing deleted. Its memberships and its row go
   * last. A dry run and a refused erase leave the status as it was.
   */
  const eraseTenant = async ({
    actor = {},
    dryRun = true,
    force = false,
    permissionId = "",
    request = {},
    userId = null,
    workspaceId = "",
  } = {}) => {
    const selector = normalizeTenantSelector({ userId, workspaceId });

    return runAsDatabaseSystem(async () => {
      const resolved = resolveAdapters(selector);
      const counted = await countAll(selector, resolved);
      const activeWork = describeActiveWork(counted);
      const tenant = { userId: selector.userId, workspaceId: selector.workspaceId };
      const skippedStores = counted
        .filter(
          ({ status }) =>
            status === TENANT_STORE_STATUSES.unsupported || status === TENANT_STORE_STATUSES.notConfigured
        )
        .map(({ store }) => store);
      const base = {
        activeWork,
        dryRun: dryRun !== false,
        force: force === true,
        skippedStores,
        tenant,
      };

      const keyPlan = await planTenantKeys(selector);

      if (dryRun !== false) {
        return {
          ...base,
          complete: skippedStores.length === 0,
          status: "dry_run",
          stores: counted,
          ...(keyPlan ? { tenantKeys: { status: "dry_run", ...keyPlan } } : {}),
          totals: { records: totalCounts(counted, "records") },
        };
      }

      if (Object.keys(activeWork).length > 0 && force !== true) {
        return {
          ...base,
          code: TENANT_LIFECYCLE_ERROR_CODES.activeWork,
          complete: false,
          status: "refused",
          stores: counted,
          totals: { records: totalCounts(counted, "records") },
        };
      }

      const stores = [];
      const prepared = new Map();
      let failure = null;
      let failedIndex = -1;

      // Every adapter's first step, before any store is erased (the registry
      // marks a workspace deleting). One that fails stops the erase before
      // anything was deleted.
      for (const [index, { adapter, status, target }] of resolved.entries()) {
        if (status !== TENANT_STORE_STATUSES.ok || typeof adapter.beforeErase !== "function") {
          continue;
        }

        try {
          const preparation = await adapter.beforeErase(target, selector);

          if (preparation) {
            prepared.set(index, preparation);
          }
        } catch (error) {
          logger.error?.(`[tenant-lifecycle] preparing ${adapter.id} for the erase failed.`, error);
          failure = { store: adapter.id, ...describeError(error) };
          failedIndex = index;
          break;
        }
      }

      for (const [index, { adapter, status, target }] of resolved.entries()) {
        if (index === failedIndex) {
          stores.push({
            error: { code: failure.code },
            store: adapter.id,
            status: TENANT_STORE_STATUSES.failed,
            tables: counted[index].tables,
          });
          continue;
        }

        if (failure) {
          stores.push({ store: adapter.id, status: "not_attempted", tables: counted[index].tables });
          continue;
        }

        if (status !== TENANT_STORE_STATUSES.ok) {
          stores.push({ store: adapter.id, status, tables: {} });
          continue;
        }

        try {
          const deleted = await adapter.erase(target, selector);

          stores.push({
            store: adapter.id,
            status,
            tables: mergeCounts(counted[index].tables, deleted),
            ...(prepared.get(index) ?? {}),
          });
        } catch (error) {
          logger.error?.(`[tenant-lifecycle] erasing ${adapter.id} failed.`, error);
          failure = { store: adapter.id, ...describeError(error) };
          stores.push({
            error: describeError(error),
            store: adapter.id,
            status: TENANT_STORE_STATUSES.failed,
            tables: counted[index].tables,
          });
        }
      }

      // The key step, last: only after every store went without a failure
      // (a store left out as unsupported or not configured does not stop
      // it; its file bytes become unreadable with the key). A failed erase
      // keeps the key for the rerun that finishes it.
      let tenantKeysResult = null;

      if (keyPlan && failure) {
        tenantKeysResult = { ...keyPlan, status: "not_attempted" };
      } else if (keyPlan) {
        try {
          tenantKeysResult = {
            destroyed: await tenantKeys.destroy(selector),
            kept: keyPlan.kept,
            status: "destroyed",
          };
        } catch (error) {
          logger.error?.("[tenant-lifecycle] destroying the tenant keys failed.", error);
          failure = { store: "tenant_keys", ...describeError(error) };
          tenantKeysResult = { ...keyPlan, error: describeError(error), status: "failed" };
        }
      }

      const deletedTotals = totalCounts(stores, "deleted");
      const outcome = failure
        ? "failed"
        : skippedStores.length > 0
          ? "partial"
          : "completed";
      const tombstoneRecorded = await recordLifecycleEvent({
        actionId: "tenant.erase",
        actor,
        details: {
          counts: deletedTotals,
          force: force === true,
          outcome,
          skippedStores,
          tenant,
          ...(tenantKeysResult ? { tenantKeys: toAuditTenantKeys(tenantKeysResult) } : {}),
        },
        permissionId,
        reason: `tenant_erase_${outcome}`,
        request,
        type: ADMIN_AUDIT_EVENT_TYPES.tenantErased,
      });

      return {
        ...base,
        complete: outcome === "completed",
        ...(failure ? { failure } : {}),
        status: outcome,
        stores,
        ...(tenantKeysResult ? { tenantKeys: tenantKeysResult } : {}),
        tombstoneRecorded,
        totals: { deleted: deletedTotals, records: totalCounts(counted, "records") },
      };
    });
  };

  /**
   * The JSON Lines export of every record of the selector, as an async
   * iterable of lines (each a JSON text without the newline): a header, the
   * records ({ type: "record", store, table, record }) and a summary with the
   * per-table counts. An export that could not reach a store says so in the
   * header and the summary (`complete: false`). A failure part-way yields an
   * error line ({ type: "error", store, code }) and ends the bundle; the
   * caller has already sent the lines before it. The export is recorded as an
   * audit event (admin.tenant.exported, ids and counts only) at the end, and
   * also when the caller stops reading early (a client that disconnects, a
   * file that cannot be written): then with outcome `aborted` and the counts
   * of the records handed out so far, so records that left are never
   * unaccounted for.
   */
  const exportTenant = ({
    actor = {},
    permissionId = "",
    request = {},
    userId = null,
    workspaceId = "",
  } = {}) => {
    const selector = normalizeTenantSelector({ userId, workspaceId });
    const tenant = { userId: selector.userId, workspaceId: selector.workspaceId };

    return (async function* exportLines() {
      const resolved = resolveAdapters(selector)
        .filter(({ adapter }) => adapter.exported !== false)
        .map((entry) =>
          entry.adapter.exportStatus && entry.status === TENANT_STORE_STATUSES.ok
            ? { ...entry, status: entry.adapter.exportStatus(entry.target) }
            : entry
        );
      const auditListing =
        typeof adminAuditService?.iterateTenantRecords === "function" ||
        typeof adminAuditService?.listTenantRecords === "function";
      const stores = [
        ...resolved.map(({ adapter, status }) => ({ status, store: adapter.id })),
        {
          status: auditListing ? TENANT_STORE_STATUSES.ok : TENANT_STORE_STATUSES.notConfigured,
          store: "admin_audit_events",
        },
      ];
      const skippedStores = stores
        .filter(
          ({ status }) =>
            status === TENANT_STORE_STATUSES.unsupported || status === TENANT_STORE_STATUSES.notConfigured
        )
        .map(({ store }) => store);
      const counts = {};
      const unreadableRecords = {};
      let failure = null;
      let recorded = false;
      let escaped = false;
      const recordExport = (outcome) =>
        recordLifecycleEvent({
          actionId: "tenant.export",
          actor,
          details: { counts: { ...counts }, outcome, skippedStores, tenant },
          permissionId,
          reason: `tenant_export_${outcome}`,
          request,
          type: ADMIN_AUDIT_EVENT_TYPES.tenantExported,
        });

      try {
        yield JSON.stringify({
          exportedAt: now(),
          format: TENANT_EXPORT_FORMAT,
          omitted: [
            "document chunks and embeddings",
            "ingest stage output payloads other than document_file",
            "caches",
            "usage totals not flushed to the ledger yet",
          ],
          stores,
          tenant,
          type: "header",
          version: TENANT_EXPORT_VERSION,
        });

        const sources = [
          ...resolved
            .filter(({ status }) => status === TENANT_STORE_STATUSES.ok)
            .map(({ adapter, target }) => ({ id: adapter.id, iterate: () => adapter.export(target, selector) })),
          ...(auditListing
            ? [{ id: "admin_audit_events", iterate: () => toAsyncIterable(adminAuditService, selector) }]
            : []),
        ];

        for (const source of sources) {
          try {
            for await (const { record, table } of source.iterate()) {
              counts[table] = (counts[table] ?? 0) + 1;

              if (record?.unreadableBytes) {
                unreadableRecords[table] = (unreadableRecords[table] ?? 0) + 1;
              }

              yield JSON.stringify({
                record: toTenantExportValue(record),
                store: source.id,
                table,
                type: "record",
              });
            }
          } catch (error) {
            logger.error?.(`[tenant-lifecycle] exporting ${source.id} failed.`, error);
            failure = { store: source.id, ...describeError(error) };
            yield JSON.stringify({ ...failure, type: "error" });
            break;
          }
        }

        const unreadable = Object.keys(unreadableRecords).length > 0;
        const outcome = failure ? "failed" : skippedStores.length > 0 || unreadable ? "partial" : "completed";

        // Before the summary: a caller that stops after the last record has
        // the export recorded with its outcome, not as aborted.
        recorded = true;
        await recordExport(outcome);

        if (!failure) {
          yield JSON.stringify({
            complete: outcome === "completed",
            counts,
            records: Object.values(counts).reduce((total, count) => total + count, 0),
            skippedStores,
            status: outcome,
            type: "summary",
            ...(unreadable ? { unreadableRecords } : {}),
          });
        }
      } catch (error) {
        escaped = true;
        throw error;
      } finally {
        // The caller stopped reading before the end (for await ... break, or
        // a throw in its loop body, both return() the generator at a yield),
        // or the bundle itself failed: the records already handed out are
        // recorded all the same. Nothing is yielded here.
        if (!recorded) {
          await recordExport(escaped || failure ? "failed" : "aborted");
        }
      }
    })();
  };

  return { eraseTenant, exportTenant };
};
