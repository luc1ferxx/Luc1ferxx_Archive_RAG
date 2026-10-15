import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";

import { normalizeText } from "../../lib/normalize-text.js";
import { LANGGRAPH_CHECKPOINT_RESULT_KEY } from "../agent-runs.js";
import { getActiveDatabaseTenant, toDatabaseTenant } from "../postgres-tenant.js";
import { normalizeTaskAccessScope } from "../tasks.js";
import { assertLangSmithTracingDisabled } from "./langsmith-guard.js";

// The production LangGraph checkpointer (docs/adr/0001-langgraph-runtime.md,
// phase 2), ported from the phase-0 spike
// (test/langgraph-spike/run-store-checkpoint-saver.mjs).
//
// Its only storage is the agent run row the rest of the runtime already
// writes: run.result.__langGraphCheckpoint, read and written through the run
// service (getLangGraphCheckpointRecord / mutateLangGraphCheckpointRecord in
// agent-runs.js). No table, no second run store, no CAS loop of its own: the
// service's revision CAS (32 retries, cursor-aware) commits every write after
// the same writer fence the graph's node steps pass, and strips the key from
// every public projection. The graph checkpoint
// (run.result.__skillGraphCheckpoint) stays the authority for recovery, node
// reuse, fencing and replay safety; this record only lets LangGraph resume its
// own loop, so it holds ids, statuses and digests -- whatever the graph's
// state channels hold -- and nothing of LangGraph's own config.
//
// Differences from the spike: writes record no event (the ADR's write
// amplification item), and there is no record-level claim. A run that has a
// graph checkpoint is claimed through claimExecutionGraphResume, whose
// resumeClaim fences this saver; a run without one has no claim to hold.

export { LANGGRAPH_CHECKPOINT_RESULT_KEY };
export const LANGGRAPH_CHECKPOINT_FORMAT = "archive-rag.langgraph-saver/v1";
export const LANGGRAPH_THREAD_ID_PREFIX = "agent-run:v1:";
export const DEFAULT_LANGGRAPH_MAX_RECORD_BYTES = 262_144;

export const LANGGRAPH_SAVER_ERROR_CODES = Object.freeze({
  checkpointConflict: "LANGGRAPH_CHECKPOINT_CONFLICT",
  checkpointIdRequired: "LANGGRAPH_CHECKPOINT_ID_REQUIRED",
  invalidArgument: "LANGGRAPH_CHECKPOINT_INVALID_ARGUMENT",
  invalidRecord: "LANGGRAPH_CHECKPOINT_INVALID_RECORD",
  ownerMismatch: "LANGGRAPH_CHECKPOINT_OWNER_MISMATCH",
  runIdRequired: "LANGGRAPH_RUN_ID_REQUIRED",
  runNotFound: "LANGGRAPH_RUN_NOT_FOUND",
  tenantMismatch: "LANGGRAPH_TENANT_MISMATCH",
  threadScopeMismatch: "LANGGRAPH_THREAD_SCOPE_MISMATCH",
  tooLarge: "LANGGRAPH_CHECKPOINT_TOO_LARGE",
});

// Messages are fixed strings. A saver error can surface through LangGraph's
// own error handling (as a task's __error__ write) and logs, so it never
// carries ids, values or text.
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

// What a write decision returns to drop the thread: the record becomes null.
const TOMBSTONE = Symbol("langgraph-checkpoint-tombstone");

// Checkpoint ids are uuid6 (time ordered, lowercase hex), so plain code-unit
// order is time order. MemorySaver sorts the same keys with the default
// Array#sort; never localeCompare (langgraph #2987).
const compareIds = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The LangGraph thread id of one agent run: pass it as
 * configurable.thread_id. A hash keeps user and workspace ids out of LangGraph
 * config, stream metadata and traces (LangGraph copies primitive configurable
 * values into run metadata), and binds the thread to the tenant as well as
 * the run: another tenant's run with the same runId has another thread id.
 * Same normalization and domain-separated pattern as resolveSessionMemoryKey
 * (rag/memory.js); recovery can recompute it from a listed run's scope.
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

const decodeTypedData = (typed) =>
  typed.t === "bytes" ? new Uint8Array(Buffer.from(typed.d, "base64")) : typed.d;

const digestCheckpointEntry = (checkpoint, metadata) =>
  `sha256:${sha256Hex(
    `${checkpoint.t}\0${checkpoint.d}\0${metadata.t}\0${metadata.d}`
  )}`;

// Namespaces and writes are arrays, never objects keyed by an id, so no
// "__proto__" or other inherited name ever reaches a bracket assignment.
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

/**
 * A BaseCheckpointSaver bound to exactly one agent run of one tenant, and to
 * the graph resume claim its worker holds (null for the request that started
 * the graph, the claimId claimExecutionGraphResume returned for a recovery
 * worker). Build one per invocation, the way createAgentRunStepLifecycle
 * binds its scope, run and cursor, and invoke with
 * configurable.thread_id = saver.threadId and durability "sync".
 *
 * Semantics follow MemorySaver (@langchain/langgraph-checkpoint
 * dist/memory.js) except where noted: a replayed put of an identical
 * checkpoint is a no-op and a different one under the same id is refused,
 * list() never walks other threads, and a missing run (or another tenant's)
 * fails closed instead of reading as an empty thread.
 *
 * Every write is one fenced revision CAS through
 * agentRunService.mutateLangGraphCheckpointRecord, so a stale worker's
 * superstep fails with AGENT_GRAPH_EXECUTION_FENCED once a recovery worker
 * claimed the graph or an operator took the run. The fence applies to what a
 * worker persists, not to which node LangGraph starts: node starts are fenced
 * by the step lifecycle (startGraphStep with the same claim).
 *
 * Cost. A write reads the run once (or not at all when the run cursor holds
 * the latest snapshot) and commits once, with no event; getTuple and list
 * always read the run fresh. On PostgreSQL every read of a run also returns
 * its whole event list.
 */
export class RunStoreCheckpointSaver extends BaseCheckpointSaver {
  #agentRunService;
  #accessScope;
  #runId;
  #threadId;
  #owner;
  #tenant;
  #graphResumeClaimId;
  #runCursor;
  #maxRecordBytes;
  // LangGraph calls putWrites fire-and-forget once per finished task, so
  // Send branches of one superstep arrive concurrently and overlap the next
  // put (pregel/loop.js putWrites / _checkpointerPutAfterPrevious). One
  // in-process queue keeps them from burning CAS retries on each other and
  // commits them in call order; the service's CAS stays the backstop against
  // every other writer of the run row. Same pattern as persistCheckpoint in
  // agent-unified-graph-stage.js.
  #queue = Promise.resolve();

  constructor({
    agentRunService,
    accessScope,
    runId,
    graphResumeClaimId = null,
    runCursor = null,
    maxRecordBytes = DEFAULT_LANGGRAPH_MAX_RECORD_BYTES,
  } = {}) {
    // Before super(): nothing of LangChain is constructed while LangSmith
    // tracing is switched on (langsmith-guard.js).
    assertLangSmithTracingDisabled();
    super();

    if (
      typeof agentRunService?.getLangGraphCheckpointRecord !== "function" ||
      typeof agentRunService?.mutateLangGraphCheckpointRecord !== "function"
    ) {
      throw new TypeError(
        "RunStoreCheckpointSaver needs an agent run service with the LangGraph checkpoint methods."
      );
    }

    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
      throw new TypeError("maxRecordBytes must be a positive integer.");
    }

    const scope = normalizeTaskAccessScope(accessScope ?? {});

    this.#agentRunService = agentRunService;
    // The service normalizes the scope itself; the raw ids are kept for the
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
    this.#graphResumeClaimId = normalizeText(graphResumeClaimId) || null;
    this.#runCursor = runCursor;
    this.#maxRecordBytes = maxRecordBytes;
  }

  get threadId() {
    return this.#threadId;
  }

  get runId() {
    return this.#runId;
  }

  get graphResumeClaimId() {
    return this.#graphResumeClaimId;
  }

  async getTuple(config) {
    this.#assertCallScope(config?.configurable?.thread_id);
    const ns = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = getCheckpointId(config);
    const record = await this.#enqueue(() => this.#readRecord());
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
    this.#assertCallScope(config?.configurable?.thread_id, { allowMissing: true });
    const { before, filter, limit } = options ?? {};
    const nsFilter = config?.configurable?.checkpoint_ns;
    const idFilter = config?.configurable?.checkpoint_id;
    const beforeId = before?.configurable?.checkpoint_id;
    const record = await this.#enqueue(() => this.#readRecord());
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

        const metadata = await this.#load(entry.metadata);

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
    const threadId = this.#assertCallScope(config?.configurable?.thread_id);
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

      return this.#mutate((record) => {
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
        return next;
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
    this.#assertCallScope(config?.configurable?.thread_id);
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

    // Queued at call time like put, so commit order is call order.
    await this.#enqueue(async () => {
      const serialized = await serialization;

      return this.#mutate((record) => {
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
        return next;
      });
    });
  }

  async deleteThread(threadId) {
    this.#assertCallScope(threadId);

    // The run store merges result shallowly, so a key can be overwritten but
    // never removed: null is the tombstone. The run, its steps, its events
    // and the graph checkpoint are never touched. Fenced like any write, so
    // only the graph's current owner can drop the thread.
    await this.#enqueue(() =>
      this.#mutate((record) => (record === null ? null : TOMBSTONE))
    );
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
  // call never reaches the run service.
  #assertCallScope(threadId, { allowMissing = false } = {}) {
    this.#assertTenant();

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

  // Defence in depth. The run service is addressed with the bound scope,
  // which is the real boundary; this catches a saver that leaked into another
  // tenant's request (the tenant context of the request is what the
  // PostgreSQL store's row-level security acts for). Checked again before
  // every service call, since a queued operation runs later than its call.
  #assertTenant() {
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

  // Fail closed: a wrong scope reads exactly like a missing run, and an
  // empty thread would let LangGraph start the graph over.
  #runNotFound() {
    return createSaverError(
      LANGGRAPH_SAVER_ERROR_CODES.runNotFound,
      404,
      "Agent run not found."
    );
  }

  #extractRecord(record) {
    if (record === null) {
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

  // A fresh read every time: the service never answers it from the cursor.
  async #readRecord() {
    this.#assertTenant();
    const loaded = await this.#agentRunService.getLangGraphCheckpointRecord({
      accessScope: this.#accessScope,
      runId: this.#runId,
    });

    if (!loaded) {
      throw this.#runNotFound();
    }

    return this.#extractRecord(loaded.record ?? null);
  }

  #createRecord() {
    return {
      format: LANGGRAPH_CHECKPOINT_FORMAT,
      threadId: this.#threadId,
      owner: { ...this.#owner },
      sequence: 0,
      namespaces: [],
    };
  }

  #assertSize(record) {
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > this.#maxRecordBytes) {
      throw createSaverError(
        LANGGRAPH_SAVER_ERROR_CODES.tooLarge,
        413,
        "LangGraph checkpoint record exceeds its size limit."
      );
    }
  }

  // `decide` gets the stored record (a private copy, already validated and
  // owner-checked; null when there is none) and returns the next record, null
  // for a no-op, or TOMBSTONE. The service may call it once per CAS
  // attempt, each time on that attempt's snapshot, and decides the writer
  // fence on the same snapshot first.
  async #mutate(decide) {
    this.#assertTenant();
    const outcome = await this.#agentRunService.mutateLangGraphCheckpointRecord({
      accessScope: this.#accessScope,
      graphResumeClaimId: this.#graphResumeClaimId,
      // Keeps the request's CAS base current: the service starts from the
      // cursor's snapshot and remembers what it commits, so the step
      // lifecycle's next optimistic write does not fail on the revision this
      // write bumped.
      runCursor: this.#runCursor,
      runId: this.#runId,
      decide: (stored) => {
        const next = decide(this.#extractRecord(stored));

        if (next === null) {
          return null;
        }

        if (next === TOMBSTONE) {
          return { record: null };
        }

        this.#assertSize(next);
        return { record: next };
      },
    });

    if (!outcome) {
      throw this.#runNotFound();
    }
  }

  async #load(typed) {
    return this.serde.loadsTyped(typed.t, decodeTypedData(typed));
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
