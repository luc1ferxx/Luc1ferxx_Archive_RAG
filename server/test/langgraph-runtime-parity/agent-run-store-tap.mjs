// Stands in for rag/agent-runs.js inside the evaluation modules while
// test/langgraph-runtime-parity.test.mjs runs them (redirect-hooks.mjs does
// the redirect). The trajectory, planner and recovery cases build their own
// in-memory run store and keep it private; recording each store as it is
// built, and each run as it is created, lets the parity suite read every
// run's events after a case finishes without changing a case. The real
// factory builds every store; this module only keeps references.
import { createInMemoryAgentRunStore as createRealInMemoryAgentRunStore } from "../../rag/agent-runs.js";

export * from "../../rag/agent-runs.js";

const createdRuns = [];

export const createInMemoryAgentRunStore = (options) => {
  const store = createRealInMemoryAgentRunStore(options);
  const create = store.create;

  // createWithEvent creates through this.create, so both entries pass here.
  store.create = function createRecordedRun(args = {}) {
    const run = create.call(this, args);

    createdRuns.push({ accessScope: args.accessScope ?? {}, runId: run.runId, store });
    return run;
  };

  return store;
};

/**
 * Every run created since the last call, in creation order, as the store
 * holds it now: the stored run (private result keys included) with its
 * events. Clears the record.
 */
export const takeCreatedAgentRuns = async () => {
  const taken = createdRuns.splice(0);
  const runs = [];

  for (const { accessScope, runId, store } of taken) {
    runs.push(await store.get({ accessScope, runId }));
  }

  return runs;
};
