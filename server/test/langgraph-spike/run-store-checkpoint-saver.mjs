// Phase-0 spike: a LangGraph checkpointer whose only storage is the agent run
// row the rest of the runtime already writes. Not on any production path.
import "./langsmith-off.mjs";

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { BaseCheckpointSaver, copyCheckpoint } from "@langchain/langgraph";
import {
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  getCheckpointId,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";

import { normalizeText } from "../../lib/normalize-text.js";
import {
  EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY,
  sealExecutionGraphCheckpoint,
} from "../../rag/agent-execution-graph-checkpoint.js";
import {
  isAgentRunRevisionConflictError,
  normalizeAgentRunRevision,
} from "../../rag/agent-run-revision.js";
import { AGENT_RUN_STATUSES } from "../../rag/agent-run-state-machine.js";
import {
  getActiveDatabaseTenant,
  toDatabaseTenant,
} from "../../rag/postgres-tenant.js";
import { normalizeTaskAccessScope } from "../../rag/tasks.js";

// A private key next to the v2 graph checkpoint, not inside it. The v2 object
// is sealed, owner-checked and sequence-checked per save, and its mere
// presence routes re-entry, standalone steps and startup recovery
// (agent-runs.js saveExecutionGraphCheckpoint / updateRun graphReentryGuard,
// agent-run-recovery.js). Folding LangGraph supersteps into it would change
// all of those; a sibling key changes none of them.
export const LANGGRAPH_CHECKPOINT_RESULT_KEY = "__langGraphCheckpoint";
export const LANGGRAPH_CHECKPOINT_FORMAT = "archive-rag.langgraph-saver/v1";
export const LANGGRAPH_THREAD_ID_PREFIX = "agent-run:v1:";
export const LANGGRAPH_CHECKPOINTED_EVENT = "langgraph_checkpointed";
export const LANGGRAPH_RESUME_CLAIMED_EVENT = "langgraph_resume_claimed";
export const DEFAULT_LANGGRAPH_MAX_RECORD_BYTES = 262_144;

// The run service retries a revision conflict this many times
// (DEFAULT_AGENT_RUN_MUTATION_RETRIES in agent-runs.js, not exported). The
// saver races the same writers -- step lifecycle, graph checkpoint saves,
// approval decisions -- so it gets the same budget.
export const LANGGRAPH_SAVER_MAX_CAS_RETRIES = 32;

export const LANGGRAPH_SAVER_ERROR_CODES = Object.freeze({
  checkpointConflict: "LANGGRAPH_CHECKPOINT_CONFLICT",
  checkpointIdRequired: "LANGGRAPH_CHECKPOINT_ID_REQUIRED",
  claimRequiresGraphResume: "LANGGRAPH_CLAIM_REQUIRES_GRAPH_RESUME",
  executionFenced: "AGENT_GRAPH_EXECUTION_FENCED",
  invalidArgument: "LANGGRAPH_CHECKPOINT_INVALID_ARGUMENT",
  invalidRecord: "LANGGRAPH_CHECKPOINT_INVALID_RECORD",
  ownerMismatch: "LANGGRAPH_CHECKPOINT_OWNER_MISMATCH",
  runIdRequired: "LANGGRAPH_RUN_ID_REQUIRED",
  runNotFound: "LANGGRAPH_RUN_NOT_FOUND",
  runNotWritable: "LANGGRAPH_RUN_NOT_WRITABLE",
  tenantMismatch: "LANGGRAPH_TENANT_MISMATCH",
  threadScopeMismatch: "LANGGRAPH_THREAD_SCOPE_MISMATCH",
  tooLarge: "LANGGRAPH_CHECKPOINT_TOO_LARGE",
});

// A run without a v2 graph checkpoint (a LangGraph-only run) may also be
// written while it waits for the user, as an approval continuation resumes
// it. A run with one is held to the graph's own rule (#assertWritable).
const WRITABLE_RUN_STATUSES = new Set([
  AGENT_RUN_STATUSES.running,
  AGENT_RUN_STATUSES.waitingForUser,
]);

// ACTIVE_AGENT_RUN_STEP_STATUSES in agent-runs.js (not exported): a step in
// one of these may still be executing in another worker.
const ACTIVE_STEP_STATUSES = new Set(["paused", "pending", "running"]);

// Messages are fixed strings. A saver error can surface through LangGraph's
// own error handling and logs, so it never carries ids, values or text.
const createSaverError = (code, status, message) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

const isPlainRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isIdentifier = (value) => typeof value === "string" && value !== "";

// Checkpoint ids are uuid6 (time ordered, lowercase hex), so plain code-unit
// order is time order. MemorySaver sorts the same keys with the default
// Array#sort; never localeCompare (langgraph #2987).
const compareIds = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The LangGraph thread id of one agent run. A hash keeps user and workspace
 * ids out of LangGraph config, stream metadata and traces (LangGraph copies
 * primitive configurable values into run metadata), and binds the thread to
 * the tenant as well as the run: another tenant's run with the same runId has
 * another thread id. Same normalization and domain-separated pattern as
 * resolveSessionMemoryKey (rag/memory.js).
 */
export const deriveLangGraphThreadId = (accessScope, runId) => {
  const { userId, workspaceId } = normalizeTaskAccessScope(accessScope ?? {});
  const normalizedRunId = normalizeText(runId);

  if (!normalizedRunId) {
    throw createSaverError(
      LANGGRAPH_SAVER_ERROR_CODES.runIdRequired,
      400,
      "A LangGraph thread requires an agent run id."
    );
  }

  return `${LANGGRAPH_THREAD_ID_PREFIX}${sha256Hex(
    `archive-rag-langgraph-thread:v1\0${userId}\0${workspaceId}\0${normalizedRunId}`
  )}`;
};

// Serde output is stored as text, not as parsed JSON: the run row is JSONB
// on PostgreSQL, which would reorder keys and drop JsonPlusSerializer's exact
// encodings (undefined, Map, Set, Send). Keeping the string also keeps the
// digest stable across both stores.
const encodeTyped = ([type, bytes]) => ({
  t: type,
  d:
    type === "bytes"
      ? Buffer.from(bytes).toString("base64")
      : new TextDecoder().decode(bytes),
});

const digestCheckpointEntry = (checkpoint, metadata) =>
  `sha256:${sha256Hex(
    `${checkpoint.t}\0${checkpoint.d}\0${metadata.t}\0${metadata.d}`
  )}`;

const findNamespace = (record, ns) =>
  record.namespaces.find((namespace) => namespace.ns === ns) ?? null;

const findOrCreateNamespace = (record, ns) => {
  const existing = findNamespace(record, ns);

  if (existing) {
    return existing;
  }

  const namespace = { ns, checkpoints: [], writes: [] };
  record.namespaces.push(namespace);
  return namespace;
};

const latestCheckpointEntry = (namespace) =>
  namespace.checkpoints.reduce(
    (latest, entry) =>
      latest === null || compareIds(entry.id, latest.id) > 0 ? entry : latest,
    null
  );

const isValidTypedValue = (value) =>
  isPlainRecord(value) &&
  (value.t === "json" || value.t === "bytes") &&
  typeof value.d === "string";

// Rejects anything this module did not write. A record is only ever produced
// here, so a malformed one means another writer touched the private key.
const isValidRecordShape = (record) =>
  isPlainRecord(record) &&
  record.format === LANGGRAPH_CHECKPOINT_FORMAT &&
  typeof record.threadId === "string" &&
  isPlainRecord(record.owner) &&
  (record.claim === null || isPlainRecord(record.claim)) &&
  Number.isSafeInteger(record.sequence) &&
  Array.isArray(record.namespaces) &&
  record.namespaces.every(
    (namespace) =>
      isPlainRecord(namespace) &&
      typeof namespace.ns === "string" &&
      Array.isArray(namespace.checkpoints) &&
      Array.isArray(namespace.writes) &&
      namespace.checkpoints.every(
        (entry) =>
          isPlainRecord(entry) &&
          isIdentifier(entry.id) &&
          (entry.parentId === null || isIdentifier(entry.parentId)) &&
          isValidTypedValue(entry.checkpoint) &&
          isValidTypedValue(entry.metadata)
      ) &&
      namespace.writes.every(
        (write) =>
          isPlainRecord(write) &&
          isIdentifier(write.checkpointId) &&
          isIdentifier(write.taskId) &&
          Number.isSafeInteger(write.idx) &&
          typeof write.channel === "string" &&
          typeof write.taskPath === "string" &&
          isValidTypedValue(write.value)
      )
  );

const isV2CheckpointIntact = (checkpoint) => {
  try {
    return sealExecutionGraphCheckpoint(checkpoint).digest === checkpoint.digest;
  } catch {
    return false;
  }
};

/**
 * A BaseCheckpointSaver bound to exactly one agent run of one tenant. Its
 * state lives at run.result.__langGraphCheckpoint on the existing run row of
 * whichever agent run store it is given (in-memory or PostgreSQL); it adds no
 * table, no second store, and holds nothing of its own between calls.
 *
 * Semantics follow MemorySaver (@langchain/langgraph-checkpoint
 * dist/memory.js) except where noted: a replayed put of an identical
 * checkpoint is a no-op and a different one under the same id is refused,
 * list() never walks other threads, and a missing run fails closed instead
 * of reading as an empty thread.
 *
 * Every write is one revision CAS on the run row, fenced on the same owner
 * the run service fences graph writes on (the v2 resumeClaim when the run has
 * a graph checkpoint, the record's own claim otherwise), so a stale worker's
 * superstep fails instead of overwriting a recovery worker's progress.
 *
 * Cost. A write reads the run once (or not at all when a run cursor holds the
 * latest snapshot, the CAS base mutateStoredRun uses too) and commits once;
 * getTuple and list always read the run fresh. On PostgreSQL every read of a
 * run returns its whole event list (postgres-agent-run-store.js getRun runs
 * getEvents), and every put appends one event, so a cursor-less saver reads
 * O(supersteps x events) event rows per run: quadratic in the number of
 * supersteps. Measure with a cursor before quoting PostgreSQL numbers.
 */
export class RunStoreCheckpointSaver extends BaseCheckpointSaver {
  #agentRunStore;
  #accessScope;
  #runId;
  #threadId;
  #owner;
  #tenant;
  #claimId;
  #runCursor;
  #maxRecordBytes;
  #onStoreCall;
  // LangGraph calls putWrites fire-and-forget once per finished task, so
  // Send branches of one superstep arrive concurrently and overlap the next
  // put (pregel/loop.js putWrites / _checkpointerPutAfterPrevious). One
  // in-process queue keeps them from burning CAS retries on each other; the
  // CAS loop stays the backstop against every other writer of the run row.
  // Same pattern as persistCheckpoint in agent-unified-graph-stage.js.
  #queue = Promise.resolve();

  constructor({
    agentRunStore,
    accessScope,
    runId,
    claimId = null,
    runCursor = null,
    maxRecordBytes = DEFAULT_LANGGRAPH_MAX_RECORD_BYTES,
    onStoreCall = null,
  } = {}) {
    super();

    if (
      typeof agentRunStore?.get !== "function" ||
      typeof agentRunStore?.update !== "function" ||
      typeof agentRunStore?.updateWithEvent !== "function"
    ) {
      // updateWithEvent is required, not optional: a put and its event must
      // commit in one CAS, or recovery could see a checkpoint event for a
      // checkpoint that was never stored (or the reverse).
      throw new TypeError(
        "RunStoreCheckpointSaver needs an agent run store with get, update and updateWithEvent."
      );
    }

    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
      throw new TypeError("maxRecordBytes must be a positive integer.");
    }

    const scope = normalizeTaskAccessScope(accessScope ?? {});

    this.#agentRunStore = agentRunStore;
    // The store normalizes the scope itself; the raw ids are kept for the
    // tenant comparison, which uses postgres-tenant's own (trim-only) rule.
    this.#accessScope = Object.freeze({
      userId: accessScope?.userId,
      workspaceId: accessScope?.workspaceId,
    });
    this.#threadId = deriveLangGraphThreadId(scope, runId);
    this.#runId = normalizeText(runId);
    this.#owner = Object.freeze({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      runId: this.#runId,
    });
    this.#tenant = toDatabaseTenant(this.#accessScope);
    this.#claimId = normalizeText(claimId) || null;
    this.#runCursor = runCursor;
    this.#maxRecordBytes = maxRecordBytes;
    this.#onStoreCall = typeof onStoreCall === "function" ? onStoreCall : null;
  }

  get threadId() {
    return this.#threadId;
  }

  get runId() {
    return this.#runId;
  }

  get claimId() {
    return this.#claimId;
  }

  async getTuple(config) {
    this.#assertCallScope("getTuple", config?.configurable?.thread_id);
    const ns = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = getCheckpointId(config);
    const record = await this.#enqueue(() => this.#readRecord("getTuple"));
    const namespace = record ? findNamespace(record, ns) : null;

    if (!namespace) {
      return undefined;
    }

    if (checkpointId) {
      const entry = namespace.checkpoints.find(
        (candidate) => candidate.id === checkpointId
      );

      // MemorySaver hands back the caller's config unchanged for an
      // addressed checkpoint and a rebuilt one for the latest.
      return entry ? this.#buildTuple(namespace, entry, config) : undefined;
    }

    const entry = latestCheckpointEntry(namespace);

    return entry
      ? this.#buildTuple(namespace, entry, {
          configurable: {
            thread_id: this.#threadId,
            checkpoint_id: entry.id,
            checkpoint_ns: ns,
          },
        })
      : undefined;
  }

  async *list(config, options) {
    // MemorySaver.list without a thread_id walks every stored thread. Here
    // the only thread is the bound one, so "no thread_id" means this run,
    // never a scan of the tenant's (or anyone's) runs.
    this.#assertCallScope("list", config?.configurable?.thread_id, {
      allowMissing: true,
    });
    const { before, filter, limit } = options ?? {};
    const nsFilter = config?.configurable?.checkpoint_ns;
    const idFilter = config?.configurable?.checkpoint_id;
    const beforeId = before?.configurable?.checkpoint_id;
    const record = await this.#enqueue(() => this.#readRecord("list"));
    let remaining = limit;

    if (!record) {
      return;
    }

    for (const namespace of record.namespaces) {
      if (nsFilter !== undefined && namespace.ns !== nsFilter) {
        continue;
      }

      const newestFirst = [...namespace.checkpoints].sort((left, right) =>
        compareIds(right.id, left.id)
      );

      for (const entry of newestFirst) {
        if (idFilter && entry.id !== idFilter) {
          continue;
        }

        if (beforeId && entry.id >= beforeId) {
          continue;
        }

        const metadata = await this.serde.loadsTyped(
          entry.metadata.t,
          this.#decodeTypedData(entry.metadata)
        );

        // Shallow strict equality per key, as MemorySaver.
        if (
          filter &&
          !Object.entries(filter).every(([key, value]) => metadata?.[key] === value)
        ) {
          continue;
        }

        if (remaining !== undefined) {
          if (remaining <= 0) {
            break;
          }

          remaining -= 1;
        }

        yield await this.#buildTuple(
          namespace,
          entry,
          {
            configurable: {
              thread_id: this.#threadId,
              checkpoint_ns: namespace.ns,
              checkpoint_id: entry.id,
            },
          },
          metadata
        );
      }
    }
  }

  async put(config, checkpoint, metadata, _newVersions) {
    const threadId = this.#assertCallScope("put", config?.configurable?.thread_id);
    const ns = config.configurable?.checkpoint_ns ?? "";

    if (!isIdentifier(checkpoint?.id) || typeof ns !== "string") {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.invalidArgument,
        400,
        "LangGraph checkpoint requires a string id and namespace."
      );
    }

    const parentCandidate = config.configurable?.checkpoint_id;
    const parentId = isIdentifier(parentCandidate) ? parentCandidate : null;
    // Serialized at call time, before any await, as MemorySaver does: the
    // loop may build the next checkpoint while this one waits in the queue.
    const serialization = Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    // Handled here so a failure that waits behind other queued operations is
    // not reported as unhandled; awaiting it below still rejects.
    serialization.catch(() => {});

    // Joined synchronously, in call order, and the serialization is awaited
    // inside the queued operation: commit order is call order by
    // construction, so a put called after a putWrites (loop.js schedules the
    // __resume__ write of a fork checkpoint right after its put) never
    // overtakes it, whatever each one's serialization costs.
    await this.#enqueue(async () => {
      const [checkpointTyped, metadataTyped] = (await serialization).map(encodeTyped);
      const entry = {
        id: checkpoint.id,
        parentId,
        step: Number.isSafeInteger(metadata?.step) ? metadata.step : null,
        source: typeof metadata?.source === "string" ? metadata.source : null,
        digest: digestCheckpointEntry(checkpointTyped, metadataTyped),
        checkpoint: checkpointTyped,
        metadata: metadataTyped,
      };

      return this.#mutate("put", ({ record }) => {
        const next = record ?? this.#createRecord();
        const namespace = findOrCreateNamespace(next, ns);
        const existing = namespace.checkpoints.find(
          (candidate) => candidate.id === entry.id
        );

        if (existing) {
          // put is not idempotent in MemorySaver (it overwrites). Here a
          // retried put after a lost response is a no-op, and anything else
          // under the same id is a second writer: refuse it.
          if (existing.digest === entry.digest && existing.parentId === entry.parentId) {
            return null;
          }

          throw createSaverError(
            LANGGRAPH_SAVER_ERROR_CODES.checkpointConflict,
            409,
            "LangGraph checkpoint conflicts with the stored checkpoint of the same id."
          );
        }

        namespace.checkpoints.push(entry);
        namespace.checkpoints.sort((left, right) => compareIds(left.id, right.id));
        next.sequence += 1;

        return {
          record: next,
          // Ids, step and source only; the checkpoint itself never enters
          // the event log.
          event: {
            type: LANGGRAPH_CHECKPOINTED_EVENT,
            payload: {
              checkpointId: entry.id,
              parentCheckpointId: entry.parentId,
              source: entry.source,
              step: entry.step,
              sequence: next.sequence,
            },
          },
        };
      });
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config, writes, taskId, taskPath) {
    this.#assertCallScope("putWrites", config?.configurable?.thread_id);
    const ns = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (checkpointId === undefined) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.checkpointIdRequired,
        400,
        "LangGraph pending writes require a checkpoint id."
      );
    }

    if (
      !isIdentifier(checkpointId) ||
      !isIdentifier(taskId) ||
      typeof ns !== "string" ||
      !Array.isArray(writes) ||
      writes.some((write) => !Array.isArray(write) || typeof write[0] !== "string")
    ) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.invalidArgument,
        400,
        "LangGraph pending writes require string ids and channels."
      );
    }

    if (writes.length === 0) {
      return;
    }

    const storedTaskPath = taskPath ?? "";
    // Serialized at call time, before any await, as MemorySaver does.
    const serialization = Promise.all(
      writes.map(async ([channel, value], index) => ({
        checkpointId,
        taskId,
        // WRITES_IDX_MAP[channel] || index in MemorySaver; Object.hasOwn keeps
        // a channel named after an Object.prototype member ("toString") from
        // resolving to a function.
        idx: Object.hasOwn(WRITES_IDX_MAP, channel) ? WRITES_IDX_MAP[channel] : index,
        channel,
        taskPath: storedTaskPath,
        value: encodeTyped(await this.serde.dumpsTyped(value)),
      }))
    );
    serialization.catch(() => {});

    // No event: one per finished task would grow the event log per superstep
    // and per Send branch. The put that follows the superstep records it.
    // Queued at call time like put, so commit order is call order.
    await this.#enqueue(async () => {
      const serialized = await serialization;

      return this.#mutate("putWrites", ({ record }) => {
        const next = record ?? this.#createRecord();
        const namespace = findOrCreateNamespace(next, ns);
        let changed = false;

        for (const write of serialized) {
          const index = namespace.writes.findIndex(
            (candidate) =>
              candidate.checkpointId === write.checkpointId &&
              candidate.taskId === write.taskId &&
              candidate.idx === write.idx
          );

          if (index < 0) {
            namespace.writes.push(write);
            changed = true;
            continue;
          }

          // A task's regular write is first-writer-wins (a re-run task must
          // not change what the superstep already recorded); the special
          // channels (__error__, __scheduled__, __interrupt__, __resume__)
          // carry negative indexes and overwrite. MemorySaver putWrites.
          if (write.idx >= 0 || isDeepStrictEqual(namespace.writes[index], write)) {
            continue;
          }

          namespace.writes[index] = write;
          changed = true;
        }

        if (!changed) {
          return null;
        }

        next.sequence += 1;
        return { record: next };
      });
    });
  }

  async deleteThread(threadId) {
    this.#assertCallScope("deleteThread", threadId);

    // The run store merges result shallowly, so a key can be overwritten but
    // never removed: null is the tombstone. The run, its steps, its events
    // and the v2 graph checkpoint are never touched. Fenced like any write,
    // so only the current owner can drop the thread (and with it the
    // record's claim).
    await this.#enqueue(() =>
      this.#mutate("deleteThread", ({ record }) =>
        record === null ? null : { record: null }
      )
    );
  }

  /**
   * Claims the run for this worker, for a run that has no v2 graph
   * checkpoint (a run that has one is claimed through
   * agentRunService.claimExecutionGraphResume, whose resumeClaim then fences
   * this saver). Mirrors claimExecutionGraphResume (agent-runs.js): one CAS
   * sets the claim only when none exists, the run is still open and not
   * manual, no step of the run may still be executing (pending, running or
   * paused: unknown in-flight work is an operator's call, never a takeover),
   * no approval gate is pending, and the record is still at
   * `expectedSequence`, the record sequence the caller inspected (0 for a run
   * with no record). That last check is the native digest check's analog: a
   * claim applies only to the state the recovery worker looked at. Of two
   * racing workers the second re-reads, sees the claim, and skips.
   *
   * What the record claim fences: this saver's writes only. completeRun,
   * failRun and recordRunStep fence on the v2 resumeClaim alone, so on a run
   * without a v2 checkpoint a stale worker can still settle steps and the run
   * itself; node starts need the step lifecycle's own fence. The caller binds
   * a new saver to the returned claimId; this instance keeps the claim it was
   * built with.
   */
  async claim({ expectedSequence } = {}) {
    this.#assertTenant("claim");

    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.invalidArgument,
        400,
        "A LangGraph claim requires the record sequence the caller inspected."
      );
    }

    const claimId = randomUUID();
    const claimed = await this.#enqueue(() =>
      this.#mutate(
        "claim",
        ({ record, run }) => {
          if (run.result?.[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]) {
            throw createSaverError(
              LANGGRAPH_SAVER_ERROR_CODES.claimRequiresGraphResume,
              409,
              "A run with a graph checkpoint is claimed through the graph resume claim."
            );
          }

          if (
            record?.claim ||
            (record?.sequence ?? 0) !== expectedSequence ||
            !WRITABLE_RUN_STATUSES.has(run.status) ||
            run.result?.recovery?.mode === "manual" ||
            (Array.isArray(run.steps) ? run.steps : []).some((step) =>
              ACTIVE_STEP_STATUSES.has(step?.status)
            ) ||
            (Array.isArray(run.approvalGates) ? run.approvalGates : []).some(
              (gate) => gate?.status === "pending"
            )
          ) {
            return null;
          }

          const next = record ?? this.#createRecord();
          next.claim = { claimId, claimedAt: new Date().toISOString() };
          next.sequence += 1;

          return {
            record: next,
            event: {
              type: LANGGRAPH_RESUME_CLAIMED_EVENT,
              payload: { sequence: next.sequence },
            },
            value: claimId,
          };
        },
        { fenced: false }
      )
    );

    return claimed
      ? { claimed: true, claimId: claimed }
      : { claimed: false, claimId: null };
  }

  // One saver operation at a time. A failed operation must not poison the
  // queue for the next one, so the chain swallows it; the caller still sees
  // the rejection through the returned promise.
  #enqueue(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  // Thread and tenant checks run synchronously at call time, so a refused
  // call never reaches the store.
  #assertCallScope(operation, threadId, { allowMissing = false } = {}) {
    this.#assertTenant(operation);

    if (allowMissing && threadId === undefined) {
      return this.#threadId;
    }

    if (threadId !== this.#threadId) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.threadScopeMismatch,
        409,
        "LangGraph thread does not belong to this agent run."
      );
    }

    return threadId;
  }

  // Defence in depth. The store is addressed with the bound scope, which is
  // the real boundary; this catches a saver that leaked into another
  // tenant's request (the tenant context of the request is what the
  // PostgreSQL store's row-level security would act for).
  #assertTenant(_operation) {
    const active = getActiveDatabaseTenant();

    if (
      active !== null &&
      !(
        this.#tenant !== null &&
        active.userId === this.#tenant.userId &&
        active.workspaceId === this.#tenant.workspaceId
      )
    ) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.tenantMismatch,
        409,
        "LangGraph checkpoint access does not match the active database tenant."
      );
    }
  }

  async #storeCall(operation, method, args) {
    this.#assertTenant(operation);
    this.#onStoreCall?.({
      method,
      operation,
      tenant: getActiveDatabaseTenant(),
    });

    return this.#agentRunStore[method](args);
  }

  async #getRun(operation) {
    const raw = await this.#storeCall(operation, "get", {
      accessScope: this.#accessScope,
      runId: this.#runId,
    });

    if (!raw) {
      // Fail closed: a wrong scope reads exactly like a missing run, and an
      // empty thread would let LangGraph start the graph over.
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.runNotFound,
        404,
        "Agent run not found."
      );
    }

    return raw;
  }

  #extractRecord(run) {
    const record = run.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY];

    if (record === undefined || record === null) {
      return null;
    }

    if (!isValidRecordShape(record)) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.invalidRecord,
        409,
        "Stored LangGraph checkpoint record is not valid."
      );
    }

    if (
      record.threadId !== this.#threadId ||
      !isDeepStrictEqual(record.owner, { ...this.#owner })
    ) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.ownerMismatch,
        409,
        "Stored LangGraph checkpoint belongs to another thread."
      );
    }

    return record;
  }

  // Reads are never answered from the run cursor: AGENTS.md allows it only
  // as a CAS base. Every read is a fresh store read, cloned because the
  // in-memory store returns its own nested objects.
  async #readRecord(operation) {
    const run = structuredClone(await this.#getRun(operation));

    return this.#extractRecord(run);
  }

  #createRecord() {
    return {
      format: LANGGRAPH_CHECKPOINT_FORMAT,
      threadId: this.#threadId,
      owner: { ...this.#owner },
      claim: null,
      sequence: 0,
      namespaces: [],
    };
  }

  // The fences of agent-runs.js, applied to the run snapshot the CAS will
  // commit against, so a fence decision and the write it admits share one
  // revision.
  #assertWritable(run, record) {
    if (!WRITABLE_RUN_STATUSES.has(run.status)) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.runNotWritable,
        409,
        "LangGraph checkpoint cannot change a settled agent run."
      );
    }

    if (run.result?.recovery?.mode === "manual") {
      // saveExecutionGraphCheckpoint uses the same code for the same case.
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.executionFenced,
        409,
        "LangGraph checkpoint cannot change after manual recovery was required."
      );
    }

    const graphCheckpoint = run.result?.[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY];

    if (graphCheckpoint) {
      // assertExecutionGraphRunOwner / recordRunStep with a graph claim: an
      // intact digest and the exact resume claim (null for the original
      // request's worker, a UUID for a startup-recovery worker).
      //
      // Also the run-status and phase rules saveExecutionGraphCheckpoint and
      // recordRunStep apply to a graph writer: the run must be running and
      // the graph phase running. A graph paused for approval
      // (awaiting_approval, waiting_for_user) or settled (completed, partial)
      // has no LangGraph writer: the approval decision CAS sets both back to
      // running before any continuation runs, and the runner writes its final
      // phase only after invoke has returned and every saver write settled.
      if (
        run.status !== AGENT_RUN_STATUSES.running ||
        graphCheckpoint.phase !== "running" ||
        !isV2CheckpointIntact(graphCheckpoint) ||
        normalizeText(graphCheckpoint.resumeClaim?.claimId) !==
          normalizeText(this.#claimId)
      ) {
        throw createSaverError(
          LANGGRAPH_SAVER_ERROR_CODES.executionFenced,
          409,
          "LangGraph checkpoint writer does not own the run's running graph."
        );
      }

      return;
    }

    if (normalizeText(record?.claim?.claimId) !== normalizeText(this.#claimId)) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.executionFenced,
        409,
        "LangGraph checkpoint writer does not own the run's claim."
      );
    }
  }

  #assertSize(record) {
    if (record === null) {
      return;
    }

    if (Buffer.byteLength(JSON.stringify(record), "utf8") > this.#maxRecordBytes) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.tooLarge,
        413,
        "LangGraph checkpoint record exceeds its size limit."
      );
    }
  }

  // Decide-and-commit against one run snapshot, retried from a fresh read on
  // a revision conflict, the way mutateStoredRun does it (agent-runs.js; it
  // is closure-private, so this is a copy). `decide` gets a private clone and
  // returns null for a no-op or { record, event?, value? }.
  //
  // The first attempt may start from the run cursor's snapshot instead of a
  // store read: the cursor is an optimistic CAS base, never an answer (the
  // revision CAS refuses a stale one and the retry reads fresh), exactly as
  // createAgentRunCursor documents. Reads (getTuple, list) never use it.
  async #mutate(operation, decide, { fenced = true } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const cached = attempt === 0 ? this.#readCursorBase() : null;
      const raw = cached ?? (await this.#getRun(operation));
      const run = structuredClone(raw);
      const record = this.#extractRecord(run);

      if (fenced) {
        this.#assertWritable(run, record);
      }

      const decision = await decide({ record, run });

      if (!decision) {
        return undefined;
      }

      this.#assertSize(decision.record);

      const update = {
        accessScope: this.#accessScope,
        // The PostgreSQL store merges the patch onto this snapshot instead
        // of reading the row again; the revision CAS still guards the write.
        baseRun: raw,
        expectedRevision: normalizeAgentRunRevision(raw.revision),
        // The shallow result merge keeps every other result key, including
        // the v2 graph checkpoint and the finalization receipt. The record
        // is a fresh clone, and the in-memory store keeps it by reference,
        // so nothing here touches it after the write.
        patch: { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: decision.record } },
        runId: this.#runId,
      };

      try {
        const updated = decision.event
          ? await this.#storeCall(operation, "updateWithEvent", {
              ...update,
              event: decision.event,
            })
          : await this.#storeCall(operation, "update", update);

        if (!updated) {
          throw createSaverError(
            LANGGRAPH_SAVER_ERROR_CODES.runNotFound,
            404,
            "Agent run not found."
          );
        }

        // Keep the request's CAS base current, or the step lifecycle's next
        // optimistic write fails once on the revision this write bumped.
        this.#runCursor?.remember?.({ accessScope: this.#accessScope, run: updated });

        return decision.value;
      } catch (error) {
        if (
          !isAgentRunRevisionConflictError(error) ||
          attempt >= LANGGRAPH_SAVER_MAX_CAS_RETRIES
        ) {
          throw error;
        }
      }
    }
  }

  #readCursorBase() {
    const snapshot = this.#runCursor?.read?.({
      accessScope: this.#accessScope,
      runId: this.#runId,
    });

    return snapshot && Number.isSafeInteger(Number(snapshot.revision)) ? snapshot : null;
  }

  #decodeTypedData(typed) {
    return typed.t === "bytes"
      ? new Uint8Array(Buffer.from(typed.d, "base64"))
      : typed.d;
  }

  async #load(typed) {
    return this.serde.loadsTyped(typed.t, this.#decodeTypedData(typed));
  }

  // Pending writes in writesSortKey order (task path, task id, index), the
  // order live execution applies a superstep's writes in. Required of every
  // saver since langgraph-checkpoint 1.2.0 (base.d.ts).
  async #pendingWrites(namespace, checkpointId) {
    const ordered = namespace.writes
      .filter((write) => write.checkpointId === checkpointId)
      .map((write) => ({
        key: writesSortKey(write.taskPath, write.taskId, write.idx),
        write,
      }))
      .sort((left, right) => compareWritesSortKeys(left.key, right.key));

    return Promise.all(
      ordered.map(async ({ write }) => [
        write.taskId,
        write.channel,
        await this.#load(write.value),
      ])
    );
  }

  // Checkpoints are only ever written by LangGraph 1.5 (format v4, which
  // keeps Sends as pending writes), so MemorySaver's _migratePendingSends for
  // v < 4 has nothing to migrate here.
  async #buildTuple(namespace, entry, config, loadedMetadata = undefined) {
    const tuple = {
      config,
      checkpoint: await this.#load(entry.checkpoint),
      metadata: loadedMetadata ?? (await this.#load(entry.metadata)),
      pendingWrites: await this.#pendingWrites(namespace, entry.id),
    };

    if (entry.parentId !== null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: this.#threadId,
          checkpoint_ns: namespace.ns,
          checkpoint_id: entry.parentId,
        },
      };
    }

    return tuple;
  }
}
