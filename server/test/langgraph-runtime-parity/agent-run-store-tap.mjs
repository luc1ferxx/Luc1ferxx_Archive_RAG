// Stands in for rag/agent-runs.js inside the evaluation modules while
// test/langgraph-runtime-parity.test.mjs runs them (redirect-hooks.mjs does
// the redirect). The trajectory, planner and recovery cases build their own
// in-memory run store and keep it private; recording each store as it is
// built, and each run as it is created, lets the parity suite read every
// run's events after a case finishes without changing a case. The real
// factory builds every store; this module only keeps references.
//
// It also keeps a copy of every LangGraph thread record a write hands the
// store (the saver's event-less CAS puts the whole record in its patch). The
// save that settles a graph drops the record, so a finished run holds only
// the null tombstone, and these copies are what the suite can still check
// (format, thread id, namespace, no text). They are taken from the patch,
// synchronously before the write, so the store's timing is unchanged; a
// write a revision conflict refuses is kept too, which only adds records to
// check.
import {
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  createInMemoryAgentRunStore as createRealInMemoryAgentRunStore,
} from "../../rag/agent-runs.js";

export * from "../../rag/agent-runs.js";

const createdRuns = [];

export const createInMemoryAgentRunStore = (options) => {
  const store = createRealInMemoryAgentRunStore(options);
  const create = store.create;
  const writtenRecords = new Map();
  const runKey = ({ accessScope = {}, runId } = {}) =>
    JSON.stringify([accessScope.userId ?? null, accessScope.workspaceId ?? null, runId]);

  // createWithEvent creates through this.create, so both entries pass here.
  store.create = function createRecordedRun(args = {}) {
    const run = create.call(this, args);

    createdRuns.push({ accessScope: args.accessScope ?? {}, runId: run.runId, store, writtenRecords });
    return run;
  };

  for (const method of ["update", "updateWithEvent"]) {
    const write = store[method];

    if (typeof write !== "function") {
      continue;
    }

    store[method] = function recordLangGraphRecord(args = {}) {
      const record = args.patch?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY];

      if (record !== null && record !== undefined) {
        const key = runKey(args);

        writtenRecords.set(key, [...(writtenRecords.get(key) ?? []), structuredClone(record)]);
      }

      return write.call(this, args);
    };
  }

  return store;
};

/**
 * Every run created since the last call, in creation order, as the store
 * holds it now: the stored run (private result keys included) with its
 * events, plus `langGraphRecordsWritten`, every non-null LangGraph record a
 * write handed the store for that run. Clears the record.
 */
export const takeCreatedAgentRuns = async () => {
  const taken = createdRuns.splice(0);
  const runs = [];

  for (const { accessScope, runId, store, writtenRecords } of taken) {
    const key = JSON.stringify([accessScope.userId ?? null, accessScope.workspaceId ?? null, runId]);

    runs.push({
      ...(await store.get({ accessScope, runId })),
      langGraphRecordsWritten: writtenRecords.get(key) ?? [],
    });
  }

  return runs;
};
