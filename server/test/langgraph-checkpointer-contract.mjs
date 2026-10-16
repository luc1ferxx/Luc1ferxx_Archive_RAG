// Shared by test/langgraph-checkpointer.test.mjs (in-memory run store) and
// test/langgraph-checkpointer-postgres.integration.test.mjs (PostgreSQL run
// store): the BaseCheckpointSaver contract script both run against
// MemorySaver and RunStoreCheckpointSaver, and the small graphs they drive.
// Not a suite (no .test.mjs suffix), so the runner does not pick it up.
import {
  Annotation,
  END,
  START,
  Send,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";

import { getActiveDatabaseTenant } from "../rag/postgres-tenant.js";

export const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};

// Every branch waits until all have arrived, so a test proves they were in
// flight together without any timing assumption.
export const createArrivalBarrier = (count) => {
  const everyone = deferred();
  let arrived = 0;

  return {
    arrive() {
      arrived += 1;
      if (arrived === count) {
        everyone.resolve();
      }
      return everyone.promise;
    },
  };
};

export const collect = async (iterable) => {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
};

export const checkpointId = (n) => `1ef00000-0000-6000-8000-${String(n).padStart(12, "0")}`;

export const makeCheckpoint = (id, channelValues = {}) => ({
  v: 4,
  id,
  ts: "2026-10-14T00:00:00.000Z",
  channel_values: channelValues,
  channel_versions: {},
  versions_seen: {},
});

export const INPUT_METADATA = Object.freeze({ parents: {}, source: "input", step: -1 });
export const loopMetadata = (step) => ({ parents: {}, source: "loop", step });

export const ids = (tuples) => tuples.map((tuple) => tuple.checkpoint.id);

// The same operations against MemorySaver (the reference implementation the
// LangGraph runtime is tested with) and RunStoreCheckpointSaver; every read
// of readContract must agree.
export const applyContractScript = async (saver, threadId) => {
  const root = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
  const first = await saver.put(
    root,
    makeCheckpoint(checkpointId(1), {
      lookup: new Map([["doc-1", 1]]),
      missing: undefined,
      trail: ["plan"],
    }),
    INPUT_METADATA,
    { __start__: 1 }
  );
  const second = await saver.put(
    first,
    makeCheckpoint(checkpointId(2), { trail: ["plan", "gate"] }),
    loopMetadata(0),
    { trail: 2 }
  );
  const third = await saver.put(
    second,
    makeCheckpoint(checkpointId(3), { trail: ["plan", "gate", "finish"] }),
    loopMetadata(1),
    { trail: 3 }
  );

  // Writes arrive out of sort order on purpose.
  await saver.putWrites(second, [["trail", "x"], ["status", "y"]], "task-b", "~__pregel_pull, b");
  await saver.putWrites(second, [["trail", "z"]], "task-a", "~__pregel_pull, a");
  await saver.putWrites(second, [["__error__", { code: "first" }]], "task-a", "~__pregel_pull, a");
  // A special channel overwrites ...
  await saver.putWrites(second, [["__error__", { code: "second" }]], "task-a", "~__pregel_pull, a");
  // ... a regular one is first-writer-wins per (task, index).
  await saver.putWrites(second, [["trail", "late"]], "task-b", "~__pregel_pull, b");
  // No task path (graph input): "" sorts first.
  await saver.putWrites(second, [["__start__", "input"]], "00000000-0000-0000-0000-000000000000");
  await saver.putWrites(second, [["trail", "pushed"]], "task-0", "~__pregel_push, 0, false");

  await saver.put(
    { configurable: { thread_id: threadId, checkpoint_ns: "child:1" } },
    makeCheckpoint(checkpointId(4), { trail: [] }),
    { parents: { "": checkpointId(2) }, source: "loop", step: 0 },
    {}
  );

  return { first, second, third };
};

export const readContract = async (saver, threadId, { second, third }) => {
  const base = { configurable: { thread_id: threadId } };
  const root = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
  return {
    latest: await saver.getTuple(root),
    addressed: await saver.getTuple(second),
    missingId: await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: checkpointId(99) },
    }),
    missingNamespace: await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "nowhere" },
    }),
    child: await saver.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: "child:1" } }),
    listAll: await collect(saver.list(base)),
    listRoot: await collect(saver.list(root)),
    listLimit: await collect(saver.list(root, { limit: 2 })),
    listBefore: await collect(saver.list(root, { before: third })),
    listFilter: await collect(saver.list(base, { filter: { source: "loop" } })),
    listById: await collect(
      saver.list({ configurable: { thread_id: threadId, checkpoint_id: checkpointId(1) } })
    ),
    listChild: await collect(
      saver.list({ configurable: { thread_id: threadId, checkpoint_ns: "child:1" } })
    ),
  };
};

// The pending writes applyContractScript leaves on its second checkpoint, in
// the 1.2.0 writesSortKey order (task path, task id, index).
export const EXPECTED_CONTRACT_PENDING_WRITES = Object.freeze([
  ["00000000-0000-0000-0000-000000000000", "__start__", "input"],
  ["task-a", "__error__", { code: "second" }],
  ["task-a", "trail", "z"],
  ["task-b", "trail", "x"],
  ["task-b", "status", "y"],
  ["task-0", "trail", "pushed"],
]);

// --- Graphs. State channels hold ids and statuses only. ---------------------

const ApprovalState = Annotation.Root({
  trail: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  approval: Annotation(),
});

export const createEffects = () => ({ afterInterrupt: 0, beforeInterrupt: 0, finish: 0, plan: 0 });

export const buildApprovalGraph = ({ checkpointer, effects, tenantsSeen = [] }) =>
  new StateGraph(ApprovalState)
    .addNode("plan", () => {
      effects.plan += 1;
      tenantsSeen.push(getActiveDatabaseTenant());
      return { trail: ["plan"] };
    })
    .addNode("gate", () => {
      effects.beforeInterrupt += 1;
      tenantsSeen.push(getActiveDatabaseTenant());
      const decision = interrupt({ gateId: "gate-1" });
      effects.afterInterrupt += 1;
      return {
        approval: decision?.approved === true ? "approved" : "denied",
        trail: ["gate"],
      };
    })
    .addNode("finish", () => {
      effects.finish += 1;
      tenantsSeen.push(getActiveDatabaseTenant());
      return { trail: ["finish"] };
    })
    .addEdge(START, "plan")
    .addEdge("plan", "gate")
    .addEdge("gate", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer });

/**
 * buildApprovalGraph with `stepsBeforeGate` nodes between plan and gate, so a
 * thread holds more than K checkpoints before it pauses (the retention tests
 * need pruning to have happened before the interrupt).
 */
export const buildLongApprovalGraph = ({ checkpointer, effects, stepsBeforeGate }) => {
  const builder = new StateGraph(ApprovalState).addNode("plan", () => {
    effects.plan += 1;
    return { trail: ["plan"] };
  });
  const stepNames = Array.from({ length: stepsBeforeGate }, (_, index) => `step_${index + 1}`);

  for (const name of stepNames) {
    builder.addNode(name, () => ({ trail: [name] }));
  }

  builder
    .addNode("gate", () => {
      effects.beforeInterrupt += 1;
      const decision = interrupt({ gateId: "gate-1" });
      effects.afterInterrupt += 1;
      return {
        approval: decision?.approved === true ? "approved" : "denied",
        trail: ["gate"],
      };
    })
    .addNode("finish", () => {
      effects.finish += 1;
      return { trail: ["finish"] };
    })
    .addEdge(START, "plan");

  let previous = "plan";

  for (const name of stepNames) {
    builder.addEdge(previous, name);
    previous = name;
  }

  return builder.addEdge(previous, "gate").addEdge("gate", "finish").addEdge("finish", END).compile({ checkpointer });
};

const ChainState = Annotation.Root({
  trail: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
});

export const buildChainGraph = ({ checkpointer, effects }) =>
  new StateGraph(ChainState)
    .addNode("plan", () => {
      effects.plan += 1;
      return { trail: ["plan"] };
    })
    .addNode("work", () => {
      effects.work += 1;
      return { trail: ["work"] };
    })
    .addNode("finish", () => {
      effects.finish += 1;
      return { trail: ["finish"] };
    })
    .addEdge(START, "plan")
    .addEdge("plan", "work")
    .addEdge("work", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer });

const FanOutState = Annotation.Root({
  branchIds: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  done: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
});

export const buildFanOutGraph = ({ branchCount, checkpointer, observed }) => {
  const arrivals = createArrivalBarrier(branchCount);

  return new StateGraph(FanOutState)
    .addNode("fanout", () => ({
      branchIds: Array.from({ length: branchCount }, (_, index) => `branch-${index}`),
    }))
    .addNode("branch", async ({ branchId }) => {
      observed.branchTenants.push(getActiveDatabaseTenant());
      await arrivals.arrive();
      return { done: [branchId] };
    })
    .addNode("join", (state) => {
      observed.joined = [...state.done].sort();
      return {};
    })
    .addEdge(START, "fanout")
    .addConditionalEdges(
      "fanout",
      (state) => state.branchIds.map((branchId) => new Send("branch", { branchId })),
      ["branch"]
    )
    .addEdge("branch", "join")
    .addEdge("join", END)
    .compile({ checkpointer });
};
