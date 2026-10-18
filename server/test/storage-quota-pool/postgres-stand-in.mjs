// Stand-in for rag/postgres.js as rag/index.js and rag/tenant-storage-quota.js
// import it in test/storage-quota-pool.test.mjs (redirected with
// test/langgraph-runtime-parity/redirect-hooks.mjs). Everything else is the
// real module; the database is a pool of `max` connections in memory, handed
// out first come first served like node-pg's with no connection timeout, so a
// caller that holds a connection and waits for another can wait forever.
// Transaction-scoped advisory locks are held until the transaction ends.
export * from "../../rag/postgres.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });

  return { promise, resolve };
};

export const createFakePool = () => {
  const state = {
    advisoryLocks: new Map(),
    inUse: 0,
    max: 2,
    peak: 0,
    // (workspaceId, userId) -> { documentBytes, documentCount }: what migration
    // 037's storage_totals function would count.
    readTotals: () => ({ documentBytes: 0, documentCount: 0 }),
    statements: [],
    waiting: [],
  };

  const acquire = async () => {
    if (state.inUse < state.max) {
      state.inUse += 1;
      state.peak = Math.max(state.peak, state.inUse);
      return;
    }

    const turn = deferred();

    state.waiting.push(turn.resolve);
    await turn.promise;
  };

  // A freed connection goes to the oldest waiter, still counted in use.
  const release = () => {
    const next = state.waiting.shift();

    if (next) {
      next();
    } else {
      state.inUse -= 1;
    }
  };

  const lockAdvisory = async (key, held) => {
    for (;;) {
      const current = state.advisoryLocks.get(key);

      if (!current) {
        const unlock = deferred();

        state.advisoryLocks.set(key, unlock);
        held.push(() => {
          state.advisoryLocks.delete(key);
          unlock.resolve();
        });
        return;
      }

      await current.promise;
    }
  };

  const run = async (text, values = [], { held = null, onClient = false } = {}) => {
    state.statements.push({ onClient, text });

    if (/pg_advisory_xact_lock/.test(text)) {
      if (!held) {
        throw new Error("a transaction-scoped advisory lock needs a transaction");
      }

      await lockAdvisory(String(values[0]), held);
      return { rows: [] };
    }

    if (/storage_totals/.test(text)) {
      const totals = state.readTotals(values[0], values[1]);

      return { rows: [{ document_bytes: String(totals.documentBytes), document_count: String(totals.documentCount) }] };
    }

    return { rows: [] };
  };

  return {
    configure: (settings) => Object.assign(state, settings),
    get inUse() {
      return state.inUse;
    },
    get peak() {
      return state.peak;
    },
    get waiting() {
      return state.waiting.length;
    },
    query: async (text, values) => {
      await acquire();

      try {
        return await run(text, values);
      } finally {
        release();
      }
    },
    reset: () => {
      Object.assign(state, {
        advisoryLocks: new Map(),
        inUse: 0,
        max: 2,
        peak: 0,
        readTotals: () => ({ documentBytes: 0, documentCount: 0 }),
        statements: [],
        waiting: [],
      });
    },
    statements: () => [...state.statements],
    transaction: async (callback) => {
      await acquire();

      const held = [];
      const client = { query: (text, values) => run(text, values, { held, onClient: true }) };

      try {
        return await callback(client);
      } finally {
        held.splice(0).forEach((unlock) => unlock());
        release();
      }
    },
  };
};

export const fakePool = createFakePool();

export const isPostgresConfigured = () => true;
export const queryPostgres = (text, values) => fakePool.query(text, values);
export const withPostgresTransaction = (callback) => fakePool.transaction(callback);
