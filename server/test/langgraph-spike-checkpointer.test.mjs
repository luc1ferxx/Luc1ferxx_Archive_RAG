import "./langgraph-spike/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";

import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  Send,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";

import {
  EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY,
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createExecutionGraph } from "../rag/agent-execution-graph.js";
import { isAgentRunRevisionConflictError } from "../rag/agent-run-revision.js";
import {
  createAgentRunCursor,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  getActiveDatabaseTenant,
  runAsDatabaseSystem,
  runWithDatabaseTenant,
  toDatabaseTenant,
} from "../rag/postgres-tenant.js";
import {
  LANGGRAPH_CHECKPOINTED_EVENT,
  LANGGRAPH_CHECKPOINT_FORMAT,
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  LANGGRAPH_RESUME_CLAIMED_EVENT,
  LANGGRAPH_SAVER_MAX_CAS_RETRIES,
  RunStoreCheckpointSaver,
  deriveLangGraphThreadId,
} from "./langgraph-spike/run-store-checkpoint-saver.mjs";

const ALICE = Object.freeze({ userId: "alice", workspaceId: "workspace-a" });
const BOB = Object.freeze({ userId: "bob", workspaceId: "workspace-a" });
const QUESTION = "What is the notice period?";
const DOC_IDS = ["doc-1"];
const SESSION_ID = "session-1";
const PLAN = { mode: "document_qa" };

const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};

// Every branch waits until all have arrived, so the test proves they were in
// flight together without any timing assumption.
const createArrivalBarrier = (count) => {
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

const collect = async (iterable) => {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
};

const rejectsWithCode = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) {
      assert.equal(error.status, status);
    }
    return true;
  });

const checkpointId = (n) => `1ef00000-0000-6000-8000-${String(n).padStart(12, "0")}`;

const makeCheckpoint = (id, channelValues = {}) => ({
  v: 4,
  id,
  ts: "2026-10-14T00:00:00.000Z",
  channel_values: channelValues,
  channel_versions: {},
  versions_seen: {},
});

const createRunFixture = async ({
  accessScope = ALICE,
  agentRunStore = createInMemoryAgentRunStore(),
  runId = "lg-run-1",
} = {}) => {
  const agentRunService = createAgentRunService({ agentRunStore });
  await agentRunService.createRun({
    accessScope,
    goal: QUESTION,
    input: { docIds: DOC_IDS, sessionId: SESSION_ID, userId: accessScope.userId },
    plan: PLAN,
    runId,
  });

  return { accessScope, agentRunService, agentRunStore, runId };
};

const readRun = ({ accessScope, agentRunStore, runId }) =>
  agentRunStore.get({ accessScope, runId });

const readRecord = async (fixture) =>
  (await readRun(fixture))?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY];

// What a recovery worker inspected before it claims: the record's sequence
// (0 for a run with no record yet).
const inspectedSequence = async (fixture) => (await readRecord(fixture))?.sequence ?? 0;

const createSaver = (fixture, options = {}) =>
  new RunStoreCheckpointSaver({
    agentRunStore: fixture.agentRunStore,
    accessScope: fixture.accessScope,
    runId: fixture.runId,
    ...options,
  });

const threadConfig = (saver, configurable = {}) => ({
  configurable: { thread_id: saver.threadId, checkpoint_ns: "", ...configurable },
});

// Wraps a store so a test can (a) hold the saver right after it read the run,
// before its CAS, and (b) run a foreign write before every saver write. The
// foreign writer always uses the inner store directly.
const createInstrumentedStore = (inner) => {
  const store = {};
  const stats = { conflicts: 0, writes: 0 };
  let pausedGet = null;
  let beforeWrite = null;
  let afterWrite = null;

  for (const [name, value] of Object.entries(inner)) {
    if (typeof value === "function") {
      store[name] = value.bind(inner);
    }
  }

  const write = async (method, args) => {
    stats.writes += 1;
    await beforeWrite?.();
    let result;
    try {
      result = await inner[method](args);
    } catch (error) {
      if (isAgentRunRevisionConflictError(error)) {
        stats.conflicts += 1;
      }
      throw error;
    }
    // Runs after the write committed and before the saver learns it did.
    await afterWrite?.({ args, method });
    return result;
  };

  store.get = async (args) => {
    const run = await inner.get(args);
    if (pausedGet) {
      const control = pausedGet;
      pausedGet = null;
      control.reached.resolve();
      await control.release.promise;
    }
    return run;
  };
  store.update = (args) => write("update", args);
  store.updateWithEvent = (args) => write("updateWithEvent", args);

  return {
    stats,
    store,
    pauseNextGet() {
      pausedGet = { reached: deferred(), release: deferred() };
      return pausedGet;
    },
    setBeforeWrite(hook) {
      beforeWrite = hook;
    },
    setAfterWrite(hook) {
      afterWrite = hook;
    },
  };
};

const collectObjectKeys = (value, keys = []) => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjectKeys(item, keys));
  } else if (value && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      keys.push(key);
      collectObjectKeys(value[key], keys);
    }
  }
  return keys;
};

const assertPlainJsonRecord = (record) => {
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  const keys = collectObjectKeys(record);
  for (const forbidden of ["__proto__", "constructor", "prototype"]) {
    assert.equal(keys.includes(forbidden), false, `record has a ${forbidden} key`);
  }
  assert.equal(keys.some((key) => typeof key === "symbol"), false);
};

// --- Graphs. State channels hold ids and statuses only. ---------------------

const ApprovalState = Annotation.Root({
  trail: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  approval: Annotation(),
});

const buildApprovalGraph = ({ checkpointer, effects, tenantsSeen = [] }) =>
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

const createEffects = () => ({ afterInterrupt: 0, beforeInterrupt: 0, finish: 0, plan: 0 });

const ChainState = Annotation.Root({
  trail: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
});

const buildChainGraph = ({ checkpointer, effects }) =>
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

const buildFanOutGraph = ({ branchCount, checkpointer, observed }) => {
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

// Counts putWrites calls that are in flight at once, to show Send branches
// really hand the saver overlapping writes.
class OverlapObservingSaver extends RunStoreCheckpointSaver {
  inFlight = 0;
  maxInFlight = 0;
  putWritesCalls = 0;

  async putWrites(...args) {
    this.putWritesCalls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await super.putWrites(...args);
    } finally {
      this.inFlight -= 1;
    }
  }
}

// --- Thread identity ---------------------------------------------------------

test("thread ids are deterministic per tenant and run, normalized, and carry no user id", () => {
  const threadId = deriveLangGraphThreadId(ALICE, "lg-run-1");

  assert.match(threadId, /^agent-run:v1:[0-9a-f]{64}$/);
  assert.equal(threadId.includes("alice"), false);
  assert.equal(threadId.includes("workspace-a"), false);
  assert.equal(
    deriveLangGraphThreadId({ userId: "  alice ", workspaceId: "workspace-a" }, " lg-run-1 "),
    threadId
  );
  assert.notEqual(deriveLangGraphThreadId(BOB, "lg-run-1"), threadId);
  assert.notEqual(deriveLangGraphThreadId({ userId: "alice", workspaceId: "workspace-b" }, "lg-run-1"), threadId);
  assert.notEqual(deriveLangGraphThreadId(ALICE, "lg-run-2"), threadId);
  // The \0 separators keep (user "a", workspace "b c") apart from ("a b", "c").
  assert.notEqual(
    deriveLangGraphThreadId({ userId: "a", workspaceId: "bc" }, "r"),
    deriveLangGraphThreadId({ userId: "ab", workspaceId: "c" }, "r")
  );
  assert.throws(() => deriveLangGraphThreadId(ALICE, "  "), { code: "LANGGRAPH_RUN_ID_REQUIRED" });

  const saver = new RunStoreCheckpointSaver({
    agentRunStore: createInMemoryAgentRunStore(),
    accessScope: ALICE,
    runId: "lg-run-1",
  });
  assert.equal(saver.threadId, threadId);
});

// --- Contract round trips ----------------------------------------------------

// The same operations against MemorySaver (the reference implementation the
// LangGraph runtime is tested with) and this saver; every read must agree.
const applyContractScript = async (saver, threadId) => {
  const root = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
  const first = await saver.put(
    root,
    makeCheckpoint(checkpointId(1), {
      lookup: new Map([["doc-1", 1]]),
      missing: undefined,
      trail: ["plan"],
    }),
    { parents: {}, source: "input", step: -1 },
    { __start__: 1 }
  );
  const second = await saver.put(
    first,
    makeCheckpoint(checkpointId(2), { trail: ["plan", "gate"] }),
    { parents: {}, source: "loop", step: 0 },
    { trail: 2 }
  );
  const third = await saver.put(
    second,
    makeCheckpoint(checkpointId(3), { trail: ["plan", "gate", "finish"] }),
    { parents: {}, source: "loop", step: 1 },
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

const readContract = async (saver, threadId, { second, third }) => {
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

const ids = (tuples) => tuples.map((tuple) => tuple.checkpoint.id);

test("put/getTuple/list/putWrites match MemorySaver over the run row", async () => {
  const fixture = await createRunFixture();
  const saver = createSaver(fixture);
  const reference = new MemorySaver();

  const ours = await applyContractScript(saver, saver.threadId);
  const theirs = await applyContractScript(reference, saver.threadId);
  const actual = await readContract(saver, saver.threadId, ours);
  const expected = await readContract(reference, saver.threadId, theirs);

  assert.deepStrictEqual(actual, expected);

  // And the reads themselves, so a shared bug in both cannot pass.
  assert.equal(actual.latest.checkpoint.id, checkpointId(3));
  assert.deepStrictEqual(actual.latest.config, {
    configurable: { thread_id: saver.threadId, checkpoint_id: checkpointId(3), checkpoint_ns: "" },
  });
  assert.deepStrictEqual(actual.latest.parentConfig, {
    configurable: { thread_id: saver.threadId, checkpoint_ns: "", checkpoint_id: checkpointId(2) },
  });
  assert.equal(actual.addressed.config, ours.second);
  assert.equal(actual.missingId, undefined);
  assert.equal(actual.missingNamespace, undefined);

  const firstTuple = actual.listRoot.at(-1);
  assert.equal(firstTuple.parentConfig, undefined);
  assert.deepStrictEqual(firstTuple.metadata, { parents: {}, source: "input", step: -1 });
  // JsonPlusSerializer encodings survive the text round trip.
  assert.ok(firstTuple.checkpoint.channel_values.lookup instanceof Map);
  assert.equal(firstTuple.checkpoint.channel_values.lookup.get("doc-1"), 1);
  assert.ok(Object.hasOwn(firstTuple.checkpoint.channel_values, "missing"));

  assert.deepStrictEqual(actual.addressed.pendingWrites, [
    ["00000000-0000-0000-0000-000000000000", "__start__", "input"],
    ["task-a", "__error__", { code: "second" }],
    ["task-a", "trail", "z"],
    ["task-b", "trail", "x"],
    ["task-b", "status", "y"],
    ["task-0", "trail", "pushed"],
  ]);

  assert.deepStrictEqual(ids(actual.listAll), [3, 2, 1, 4].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listRoot), [3, 2, 1].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listLimit), [3, 2].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listBefore), [2, 1].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listFilter), [3, 2, 4].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listById), [checkpointId(1)]);
  assert.deepStrictEqual(ids(actual.listChild), [checkpointId(4)]);

  const record = await readRecord(fixture);
  assert.equal(record.format, LANGGRAPH_CHECKPOINT_FORMAT);
  assert.equal(record.threadId, saver.threadId);
  assert.deepStrictEqual(record.owner, { userId: "alice", workspaceId: "workspace-a", runId: "lg-run-1" });
  assert.equal(record.claim, null);
  assertPlainJsonRecord(record);
});

test("a replayed put is a no-op, a conflicting one is refused, and missing reads are undefined", async () => {
  const fixture = await createRunFixture();
  const saver = createSaver(fixture);

  assert.equal(await saver.getTuple(threadConfig(saver)), undefined);
  assert.deepStrictEqual(await collect(saver.list(threadConfig(saver))), []);

  const first = await saver.put(
    threadConfig(saver),
    makeCheckpoint(checkpointId(1)),
    { parents: {}, source: "input", step: -1 },
    {}
  );
  const before = await readRun(fixture);

  assert.deepStrictEqual(
    await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {}),
    first
  );
  const after = await readRun(fixture);
  assert.equal(after.revision, before.revision);
  assert.equal(after.events.length, before.events.length);

  await rejectsWithCode(
    saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1), { trail: ["other"] }), { parents: {}, source: "input", step: -1 }, {}),
    "LANGGRAPH_CHECKPOINT_CONFLICT",
    409
  );
  await rejectsWithCode(
    saver.putWrites(threadConfig(saver), [["trail", "x"]], "task-1"),
    "LANGGRAPH_CHECKPOINT_ID_REQUIRED",
    400
  );

  // A bytes value is stored as base64 text and comes back as bytes.
  await saver.putWrites(first, [["blob", new Uint8Array([1, 2, 3])]], "task-bytes", "~p");
  const tuple = await saver.getTuple(first);
  assert.deepStrictEqual(tuple.pendingWrites, [["task-bytes", "blob", new Uint8Array([1, 2, 3])]]);
  const record = await readRecord(fixture);
  assert.deepStrictEqual(record.namespaces[0].writes[0].value, { t: "bytes", d: "AQID" });

  // The put event carries ids, step, source and the record sequence only.
  const events = (await readRun(fixture)).events.filter(
    (event) => event.type === LANGGRAPH_CHECKPOINTED_EVENT
  );
  assert.equal(events.length, 1);
  assert.deepStrictEqual(events[0].payload, {
    checkpointId: checkpointId(1),
    parentCheckpointId: null,
    sequence: 1,
    source: "input",
    step: -1,
  });
  // putWrites wrote no event and bumped the sequence.
  assert.equal(record.sequence, 2);
});

test("deleteThread writes a null tombstone and leaves the run's steps, events and graph checkpoint alone", async () => {
  const fixture = await createRunFixture();
  const saver = createSaver(fixture);
  await fixture.agentRunService.updateRun({
    accessScope: ALICE,
    runId: fixture.runId,
    patch: {
      result: { answerReceipt: { digest: "sha256:receipt" } },
      steps: [{ id: "outer:plan", label: "Plan", status: "completed", type: "plan" }],
    },
  });
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  await saver.putWrites(first, [["trail", "x"]], "task-1", "~p");
  const before = await readRun(fixture);

  await rejectsWithCode(
    saver.deleteThread(deriveLangGraphThreadId(BOB, fixture.runId)),
    "LANGGRAPH_THREAD_SCOPE_MISMATCH",
    409
  );
  await saver.deleteThread(saver.threadId);

  const after = await readRun(fixture);
  assert.ok(Object.hasOwn(after.result, LANGGRAPH_CHECKPOINT_RESULT_KEY));
  assert.equal(after.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  assert.deepStrictEqual(after.result.answerReceipt, before.result.answerReceipt);
  assert.deepStrictEqual(after.steps, before.steps);
  assert.deepStrictEqual(after.events, before.events);
  assert.equal(await saver.getTuple(threadConfig(saver)), undefined);
  assert.deepStrictEqual(await collect(saver.list(threadConfig(saver))), []);

  // Deleting again is a no-op; a later put starts a fresh record.
  await saver.deleteThread(saver.threadId);
  assert.equal((await readRun(fixture)).revision, after.revision);
  await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(2)), { parents: {}, source: "input", step: -1 }, {});
  assert.equal((await readRecord(fixture)).sequence, 1);
});

// --- A real StateGraph -------------------------------------------------------

test("a StateGraph interrupts, persists in the run row, and resumes from a new saver instance", async () => {
  const fixture = await createRunFixture();
  await fixture.agentRunService.updateRun({
    accessScope: ALICE,
    runId: fixture.runId,
    patch: {
      result: { answerReceipt: { digest: "sha256:receipt" } },
      steps: [{ id: "outer:plan", label: "Plan", status: "completed", type: "plan" }],
    },
  });
  const effects = createEffects();
  const runCursor = createAgentRunCursor();
  const firstSaver = createSaver(fixture, { runCursor });
  const firstGraph = buildApprovalGraph({ checkpointer: firstSaver, effects });
  const config = { configurable: { thread_id: firstSaver.threadId }, durability: "sync" };

  const interrupted = await firstGraph.invoke({ trail: [] }, config);

  assert.deepStrictEqual(interrupted.trail, ["plan"]);
  assert.equal(interrupted.__interrupt__.length, 1);
  assert.deepStrictEqual(interrupted.__interrupt__[0].value, { gateId: "gate-1" });
  assert.deepStrictEqual(effects, { afterInterrupt: 0, beforeInterrupt: 1, finish: 0, plan: 1 });

  const paused = await readRun(fixture);
  const pausedRecord = paused.result[LANGGRAPH_CHECKPOINT_RESULT_KEY];
  assert.ok(pausedRecord.namespaces[0].checkpoints.length >= 2);
  assert.ok(
    pausedRecord.namespaces[0].writes.some((write) => write.channel === "__interrupt__"),
    "the interrupt is a persisted pending write"
  );
  assert.deepStrictEqual(paused.result.answerReceipt, { digest: "sha256:receipt" });
  assert.deepStrictEqual(paused.steps.map((step) => [step.id, step.status]), [["outer:plan", "completed"]]);
  assert.equal(paused.status, "running");
  // The saver kept the request's CAS base current.
  assert.equal(runCursor.read({ accessScope: ALICE, runId: fixture.runId }).revision, paused.revision);

  await fixture.agentRunService.updateRun({
    accessScope: ALICE,
    runId: fixture.runId,
    patch: { status: "waiting_for_user" },
  });

  // Simulated restart: nothing survives but the run store.
  const secondSaver = createSaver(fixture);
  const secondGraph = buildApprovalGraph({ checkpointer: secondSaver, effects });
  const pendingState = await secondGraph.getState({ configurable: { thread_id: secondSaver.threadId } });
  assert.deepStrictEqual(pendingState.next, ["gate"]);
  assert.deepStrictEqual(pendingState.tasks[0].interrupts.map((entry) => entry.value), [{ gateId: "gate-1" }]);

  // Resumed while the run waits for the user, as an approval continuation is.
  const completed = await secondGraph.invoke(new Command({ resume: { approved: true } }), {
    configurable: { thread_id: secondSaver.threadId },
    durability: "sync",
  });

  assert.deepStrictEqual(completed, { approval: "approved", trail: ["plan", "gate", "finish"] });
  // Code before interrupt() ran twice, after it once; the finished node did
  // not run again.
  assert.deepStrictEqual(effects, { afterInterrupt: 1, beforeInterrupt: 2, finish: 1, plan: 1 });

  const finalState = await secondGraph.getState({ configurable: { thread_id: secondSaver.threadId } });
  assert.deepStrictEqual(finalState.next, []);
  assert.deepStrictEqual(finalState.values, completed);

  const history = await collect(secondGraph.getStateHistory({ configurable: { thread_id: secondSaver.threadId } }));
  const finished = await readRun(fixture);
  const record = finished.result[LANGGRAPH_CHECKPOINT_RESULT_KEY];
  assert.equal(history.length, record.namespaces[0].checkpoints.length);
  assert.equal(history[0].config.configurable.checkpoint_id, finalState.config.configurable.checkpoint_id);
  const steps = history.map((snapshot) => snapshot.metadata.step);
  assert.deepStrictEqual(steps, [...steps].sort((left, right) => right - left));
  assert.deepStrictEqual(history.at(-1).metadata.source, "input");

  // One ids-only event per stored checkpoint; nothing else of the run moved.
  const checkpointEvents = finished.events.filter((event) => event.type === LANGGRAPH_CHECKPOINTED_EVENT);
  assert.equal(checkpointEvents.length, record.namespaces[0].checkpoints.length);
  for (const event of checkpointEvents) {
    assert.deepStrictEqual(Object.keys(event.payload).sort(), [
      "checkpointId",
      "parentCheckpointId",
      "sequence",
      "source",
      "step",
    ]);
  }
  assert.deepStrictEqual(finished.result.answerReceipt, { digest: "sha256:receipt" });
  assert.deepStrictEqual(finished.steps, paused.steps);
  assert.equal(finished.status, "waiting_for_user");
  assert.equal(Object.hasOwn(finished.result, EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY), false);
  assertPlainJsonRecord(record);
});

test("the saver sees the invoking request's database tenant on every store call", async () => {
  const fixture = await createRunFixture();
  const storeCalls = [];
  const tenantsSeen = [];
  const effects = createEffects();
  const onStoreCall = (call) => storeCalls.push(call);
  const firstSaver = createSaver(fixture, { onStoreCall });
  const config = { configurable: { thread_id: firstSaver.threadId }, durability: "sync" };

  await runWithDatabaseTenant(ALICE, () =>
    buildApprovalGraph({ checkpointer: firstSaver, effects, tenantsSeen }).invoke({ trail: [] }, config)
  );
  const resumed = await runWithDatabaseTenant(ALICE, () =>
    buildApprovalGraph({ checkpointer: createSaver(fixture, { onStoreCall }), effects, tenantsSeen }).invoke(
      new Command({ resume: { approved: false } }),
      config
    )
  );

  assert.equal(resumed.approval, "denied");
  assert.ok(storeCalls.length > 0);
  assert.deepStrictEqual(
    [...new Set(storeCalls.map((call) => call.method))].sort(),
    ["get", "update", "updateWithEvent"]
  );
  assert.deepStrictEqual(
    [...new Set(storeCalls.map((call) => call.operation))].sort(),
    ["getTuple", "put", "putWrites"]
  );
  for (const call of [...storeCalls, ...tenantsSeen.map((tenant) => ({ tenant }))]) {
    assert.deepStrictEqual(call.tenant, toDatabaseTenant(ALICE));
  }

  // Outside any tenant (system context) is allowed; another tenant is not.
  await runAsDatabaseSystem(() => createSaver(fixture).getTuple(threadConfig(firstSaver)));
  await rejectsWithCode(
    runWithDatabaseTenant(BOB, () =>
      buildApprovalGraph({ checkpointer: createSaver(fixture), effects }).invoke({ trail: [] }, config)
    ),
    "LANGGRAPH_TENANT_MISMATCH"
  );
  await assert.rejects(
    runWithDatabaseTenant(BOB, async () => collect(createSaver(fixture).list({ configurable: {} }))),
    { code: "LANGGRAPH_TENANT_MISMATCH" }
  );
});

test("concurrent Send branches hand the saver overlapping putWrites and all of them persist", async () => {
  const fixture = await createRunFixture();
  const storeCalls = [];
  const saver = new OverlapObservingSaver({
    agentRunStore: fixture.agentRunStore,
    accessScope: ALICE,
    runId: fixture.runId,
    onStoreCall: (call) => storeCalls.push(call),
  });
  const observed = { branchTenants: [], joined: null };
  const graph = buildFanOutGraph({ branchCount: 4, checkpointer: saver, observed });

  const result = await runWithDatabaseTenant(ALICE, () =>
    graph.invoke({}, { configurable: { thread_id: saver.threadId }, durability: "sync" })
  );

  assert.deepStrictEqual([...result.done].sort(), ["branch-0", "branch-1", "branch-2", "branch-3"]);
  assert.deepStrictEqual(observed.joined, ["branch-0", "branch-1", "branch-2", "branch-3"]);
  assert.ok(saver.maxInFlight >= 2, `putWrites overlapped (max ${saver.maxInFlight})`);
  assert.equal(saver.inFlight, 0);

  const record = await readRecord(fixture);
  const branchWrites = record.namespaces[0].writes.filter((write) => write.channel === "done");
  assert.equal(branchWrites.length, 4);
  assert.equal(new Set(branchWrites.map((write) => write.taskId)).size, 4);
  assert.ok(branchWrites.every((write) => write.taskPath.startsWith("~__pregel_push")));
  // The Send arguments are persisted as pending task writes: ids only.
  const sendWrites = record.namespaces[0].writes.filter((write) => write.channel === "__pregel_tasks");
  assert.equal(sendWrites.length, 4);
  for (const write of sendWrites) {
    assert.match(JSON.parse(write.value.d).args.branchId, /^branch-\d$/);
  }

  for (const tenant of [...observed.branchTenants, ...storeCalls.map((call) => call.tenant)]) {
    assert.deepStrictEqual(tenant, toDatabaseTenant(ALICE));
  }
  assertPlainJsonRecord(record);
});

test("a foreign writer that bumps the revision mid-write forces a CAS retry and both writes survive", async () => {
  const inner = createInMemoryAgentRunStore();
  const fixture = await createRunFixture({ agentRunStore: inner });
  const instrumented = createInstrumentedStore(inner);
  const saver = new RunStoreCheckpointSaver({
    agentRunStore: instrumented.store,
    accessScope: ALICE,
    runId: fixture.runId,
  });

  const foreignWrite = async (patchResult) => {
    const raw = await inner.get({ accessScope: ALICE, runId: fixture.runId });
    await inner.update({
      accessScope: ALICE,
      expectedRevision: raw.revision,
      patch: { result: patchResult },
      runId: fixture.runId,
    });
  };

  const putControl = instrumented.pauseNextGet();
  const pendingPut = saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  await putControl.reached.promise;
  await foreignWrite({ foreignReceipt: { id: "receipt-1" } });
  putControl.release.resolve();
  const first = await pendingPut;

  assert.equal(instrumented.stats.conflicts, 1);

  const writesControl = instrumented.pauseNextGet();
  const pendingWrites = saver.putWrites(first, [["trail", "x"]], "task-1", "~p");
  await writesControl.reached.promise;
  await foreignWrite({ foreignStep: { id: "step-1" } });
  writesControl.release.resolve();
  await pendingWrites;

  assert.equal(instrumented.stats.conflicts, 2);
  const run = await readRun(fixture);
  assert.deepStrictEqual(run.result.foreignReceipt, { id: "receipt-1" });
  assert.deepStrictEqual(run.result.foreignStep, { id: "step-1" });
  const tuple = await saver.getTuple(threadConfig(saver));
  assert.equal(tuple.checkpoint.id, checkpointId(1));
  assert.deepStrictEqual(tuple.pendingWrites, [["task-1", "trail", "x"]]);
});

test("the CAS loop gives up after its retry budget against a writer that always wins", async () => {
  const inner = createInMemoryAgentRunStore();
  const fixture = await createRunFixture({ agentRunStore: inner });
  const instrumented = createInstrumentedStore(inner);
  const saver = new RunStoreCheckpointSaver({
    agentRunStore: instrumented.store,
    accessScope: ALICE,
    runId: fixture.runId,
  });
  let foreignWrites = 0;
  instrumented.setBeforeWrite(async () => {
    const raw = await inner.get({ accessScope: ALICE, runId: fixture.runId });
    await inner.update({
      accessScope: ALICE,
      expectedRevision: raw.revision,
      patch: { result: { foreignCounter: foreignWrites } },
      runId: fixture.runId,
    });
    foreignWrites += 1;
  });

  await rejectsWithCode(
    saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {}),
    "AGENT_RUN_REVISION_CONFLICT",
    409
  );
  assert.equal(instrumented.stats.writes, LANGGRAPH_SAVER_MAX_CAS_RETRIES + 1);
  assert.equal(instrumented.stats.conflicts, LANGGRAPH_SAVER_MAX_CAS_RETRIES + 1);
  assert.equal(Object.hasOwn((await readRun(fixture)).result, LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
});

// --- Isolation and fencing ---------------------------------------------------

test("another tenant's saver cannot read or write the run, and a foreign thread id is refused", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const fixture = await createRunFixture({ agentRunStore });
  const alice = createSaver(fixture);
  const first = await alice.put(threadConfig(alice), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  const before = await readRun(fixture);

  // Bob addresses the same runId with his own scope: there is no such run.
  const bob = new RunStoreCheckpointSaver({ agentRunStore, accessScope: BOB, runId: fixture.runId });
  await rejectsWithCode(bob.getTuple(threadConfig(bob)), "LANGGRAPH_RUN_NOT_FOUND", 404);
  await rejectsWithCode(collect(bob.list({ configurable: {} })), "LANGGRAPH_RUN_NOT_FOUND", 404);
  await rejectsWithCode(
    bob.put(threadConfig(bob), makeCheckpoint(checkpointId(2)), { parents: {}, source: "input", step: -1 }, {}),
    "LANGGRAPH_RUN_NOT_FOUND",
    404
  );
  await rejectsWithCode(bob.claim({ expectedSequence: 0 }), "LANGGRAPH_RUN_NOT_FOUND", 404);
  // Bob presenting Alice's thread id is refused before any store access.
  await rejectsWithCode(bob.getTuple(threadConfig(alice)), "LANGGRAPH_THREAD_SCOPE_MISMATCH", 409);
  await rejectsWithCode(bob.putWrites(first, [["trail", "x"]], "task-1"), "LANGGRAPH_THREAD_SCOPE_MISMATCH", 409);

  // Alice's saver refuses every foreign or missing thread id.
  for (const call of [
    () => alice.getTuple(threadConfig(bob)),
    () => alice.getTuple({ configurable: {} }),
    () => collect(alice.list(threadConfig(bob))),
    () => alice.put(threadConfig(bob), makeCheckpoint(checkpointId(3)), { parents: {}, source: "input", step: -1 }, {}),
    () => alice.putWrites({ configurable: { thread_id: bob.threadId, checkpoint_id: checkpointId(1) } }, [["trail", "x"]], "task-1"),
    () => alice.deleteThread(bob.threadId),
  ]) {
    await rejectsWithCode(call(), "LANGGRAPH_THREAD_SCOPE_MISMATCH", 409);
  }

  const after = await readRun(fixture);
  assert.equal(after.revision, before.revision);
  assert.deepStrictEqual(after.result, before.result);

  // list() without a thread id yields only the bound run, even with another
  // run of the same tenant in the same store.
  const sibling = await createRunFixture({ agentRunStore, runId: "lg-run-2" });
  const siblingSaver = createSaver(sibling);
  await siblingSaver.put(threadConfig(siblingSaver), makeCheckpoint(checkpointId(9)), { parents: {}, source: "input", step: -1 }, {});
  const listed = await collect(alice.list({ configurable: {} }));
  assert.deepStrictEqual(ids(listed), [checkpointId(1)]);
  assert.ok(listed.every((tuple) => tuple.config.configurable.thread_id === alice.threadId));
});

test("a record copied onto another run is refused as belonging to another thread", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const source = await createRunFixture({ agentRunStore });
  const target = await createRunFixture({ agentRunStore, runId: "lg-run-2" });
  const sourceSaver = createSaver(source);
  await sourceSaver.put(threadConfig(sourceSaver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  const copied = structuredClone(await readRecord(source));
  const raw = await readRun(target);
  await agentRunStore.update({
    accessScope: ALICE,
    expectedRevision: raw.revision,
    patch: { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: copied } },
    runId: target.runId,
  });
  const targetSaver = createSaver(target);

  await rejectsWithCode(targetSaver.getTuple(threadConfig(targetSaver)), "LANGGRAPH_CHECKPOINT_OWNER_MISMATCH", 409);
  await rejectsWithCode(
    targetSaver.put(threadConfig(targetSaver), makeCheckpoint(checkpointId(2)), { parents: {}, source: "input", step: -1 }, {}),
    "LANGGRAPH_CHECKPOINT_OWNER_MISMATCH",
    409
  );
});

const createV2GraphRun = async () => {
  const fixture = await createRunFixture();
  const graph = createExecutionGraph({
    nodes: [{ nodeId: "document:primary", skillId: "document_rag", dependsOn: [] }],
    version: "v3",
  });
  const owner = buildExecutionGraphCheckpointOwner({
    accessScope: ALICE,
    budgetState: { limits: {}, used: {} },
    docIds: DOC_IDS,
    plan: PLAN,
    question: QUESTION,
    retrievalPlan: null,
    selectedSkills: [],
    sessionId: SESSION_ID,
    taskMemory: null,
    userId: ALICE.userId,
  });
  const checkpoint = createExecutionGraphCheckpoint({ graph, owner, version: "v2" });
  await fixture.agentRunService.saveExecutionGraphCheckpoint({
    accessScope: ALICE,
    checkpoint,
    runId: fixture.runId,
  });

  return { ...fixture, checkpoint };
};

test("with a v2 graph checkpoint the saver is fenced by its resume claim", async () => {
  const fixture = await createV2GraphRun();
  const original = createSaver(fixture);

  // Unclaimed: the original request's worker (claim null) owns the graph.
  const first = await original.put(threadConfig(original), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  await rejectsWithCode(
    original.claim({ expectedSequence: await inspectedSequence(fixture) }),
    "LANGGRAPH_CLAIM_REQUIRES_GRAPH_RESUME",
    409
  );

  const claim = await fixture.agentRunService.claimExecutionGraphResume({
    accessScope: ALICE,
    checkpointDigest: fixture.checkpoint.digest,
    runId: fixture.runId,
  });
  assert.equal(claim.claimed, true);
  const claimId = claim.checkpoint.resumeClaim.claimId;

  await rejectsWithCode(
    original.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  await rejectsWithCode(original.putWrites(first, [["trail", "x"]], "task-1"), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  await rejectsWithCode(original.deleteThread(original.threadId), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  await rejectsWithCode(
    createSaver(fixture, { claimId: "another-claim" }).put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  // Reads stay open to the stale worker; only writes are fenced.
  assert.equal((await original.getTuple(threadConfig(original))).checkpoint.id, checkpointId(1));

  const recovery = createSaver(fixture, { claimId });
  await recovery.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {});
  assert.equal((await recovery.getTuple(threadConfig(recovery))).checkpoint.id, checkpointId(2));

  // The v2 checkpoint itself was not touched by the saver, not even by
  // deleteThread, which only tombstones the saver's own key.
  const beforeDelete = await readRun(fixture);
  assert.deepStrictEqual(beforeDelete.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY], claim.checkpoint);
  await recovery.deleteThread(recovery.threadId);
  const run = await readRun(fixture);
  assert.equal(run.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  assert.deepStrictEqual(run.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY], claim.checkpoint);
  assert.deepStrictEqual(run.steps, beforeDelete.steps);
  assert.deepStrictEqual(run.events, beforeDelete.events);

  // A v2 checkpoint whose digest no longer reseals fences every writer.
  await fixture.agentRunStore.update({
    accessScope: ALICE,
    expectedRevision: run.revision,
    patch: {
      result: {
        [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: {
          ...run.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY],
          phase: "completed",
        },
      },
    },
    runId: fixture.runId,
  });
  await rejectsWithCode(
    recovery.put(threadConfig(recovery), makeCheckpoint(checkpointId(3)), { parents: {}, source: "input", step: -1 }, {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
});

test("without a v2 checkpoint the saver's own claim fences writers, and a second claimant skips", async () => {
  const fixture = await createRunFixture();
  const unclaimed = createSaver(fixture);
  const first = await unclaimed.put(threadConfig(unclaimed), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});

  // Two recovery workers inspect the same record and race for the claim:
  // exactly one wins.
  const inspected = await inspectedSequence(fixture);
  const outcomes = await Promise.all([
    createSaver(fixture).claim({ expectedSequence: inspected }),
    createSaver(fixture).claim({ expectedSequence: inspected }),
  ]);
  const winners = outcomes.filter((outcome) => outcome.claimed);
  assert.equal(winners.length, 1);
  assert.match(winners[0].claimId, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(outcomes.find((outcome) => !outcome.claimed), { claimed: false, claimId: null });
  assert.deepStrictEqual(
    await createSaver(fixture).claim({ expectedSequence: await inspectedSequence(fixture) }),
    { claimed: false, claimId: null }
  );

  await rejectsWithCode(
    unclaimed.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  const claimed = createSaver(fixture, { claimId: winners[0].claimId });
  await claimed.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {});

  const run = await readRun(fixture);
  const record = run.result[LANGGRAPH_CHECKPOINT_RESULT_KEY];
  assert.equal(record.claim.claimId, winners[0].claimId);
  assert.equal(
    run.events.filter((event) => event.type === LANGGRAPH_RESUME_CLAIMED_EVENT).length,
    1
  );
  assert.deepStrictEqual(
    Object.keys(run.events.find((event) => event.type === LANGGRAPH_RESUME_CLAIMED_EVENT).payload),
    ["sequence"]
  );
});

// Pins actual behaviour, not a goal: the fence is checked when the stale
// worker next persists, so a node LangGraph starts after another worker took
// the claim still runs once. Node starts need their own fence (the step
// lifecycle's startGraphStep with the graph claim), which this saver does not
// provide.
test("pins: the saver fences what a stale worker persists, not which node it starts", async () => {
  const inner = createInMemoryAgentRunStore();
  const fixture = await createRunFixture({ agentRunStore: inner });
  const instrumented = createInstrumentedStore(inner);
  const stale = new RunStoreCheckpointSaver({
    agentRunStore: instrumented.store,
    accessScope: ALICE,
    runId: fixture.runId,
  });
  const effects = { finish: 0, plan: 0, work: 0 };
  const config = { configurable: { thread_id: stale.threadId }, durability: "sync" };
  let recoveryClaim = null;

  instrumented.setAfterWrite(async ({ method }) => {
    // The checkpoint holding plan's result has just committed. A recovery
    // worker claims the run before the stale worker's LangGraph loop learns
    // the put succeeded and starts the next node.
    if (method === "updateWithEvent" && effects.plan === 1 && recoveryClaim === null) {
      recoveryClaim = await createSaver(fixture).claim({
        expectedSequence: await inspectedSequence(fixture),
      });
    }
  });

  await rejectsWithCode(
    buildChainGraph({ checkpointer: stale, effects }).invoke({ trail: [] }, config),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );

  assert.equal(recoveryClaim.claimed, true);
  // "work" started and ran after the claim; only its writes were refused.
  assert.deepStrictEqual(effects, { finish: 0, plan: 1, work: 1 });
  const isWorkWrite = (write) => write.channel === "trail" && write.value.d === "[\"work\"]";
  assert.equal((await readRecord(fixture)).namespaces[0].writes.some(isWorkWrite), false);

  // The claimant resumes from the last committed boundary and runs "work"
  // again: across a takeover the node is at-least-once.
  const recovery = createSaver(fixture, { claimId: recoveryClaim.claimId });
  const recoveryGraph = buildChainGraph({ checkpointer: recovery, effects });
  assert.deepStrictEqual(
    (await recoveryGraph.getState({ configurable: { thread_id: recovery.threadId } })).next,
    ["work"]
  );
  const result = await recoveryGraph.invoke(null, config);
  assert.deepStrictEqual(result.trail, ["plan", "work", "finish"]);
  assert.deepStrictEqual(effects, { finish: 1, plan: 1, work: 2 });
  // The same predicate does match once the claimant persisted "work".
  assert.equal((await readRecord(fixture)).namespaces[0].writes.some(isWorkWrite), true);
});

test("a run marked for manual recovery or already settled is fenced, and the size cap fails closed", async () => {
  const manual = await createRunFixture();
  const saver = createSaver(manual);
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  const marked = await manual.agentRunService.markManualRecovery({
    accessScope: ALICE,
    recovery: { reason: "spike_test" },
    runId: manual.runId,
  });
  assert.equal(marked.marked, true);

  await rejectsWithCode(
    saver.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  await rejectsWithCode(saver.putWrites(first, [["trail", "x"]], "task-1"), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  assert.deepStrictEqual(
    await saver.claim({ expectedSequence: await inspectedSequence(manual) }),
    { claimed: false, claimId: null }
  );

  const canceled = await createRunFixture({ runId: "lg-run-canceled" });
  const canceledSaver = createSaver(canceled);
  await canceled.agentRunService.cancelRun({ accessScope: ALICE, reason: "spike_test", runId: canceled.runId });
  await rejectsWithCode(
    canceledSaver.put(threadConfig(canceledSaver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {}),
    "LANGGRAPH_RUN_NOT_WRITABLE",
    409
  );
  assert.deepStrictEqual(await canceledSaver.claim({ expectedSequence: 0 }), { claimed: false, claimId: null });

  const capped = await createRunFixture({ runId: "lg-run-capped" });
  const small = createSaver(capped, { maxRecordBytes: 4096 });
  await small.put(threadConfig(small), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  const before = await readRun(capped);
  await rejectsWithCode(
    small.put(
      threadConfig(small, { checkpoint_id: checkpointId(1) }),
      makeCheckpoint(checkpointId(2), { padding: "x".repeat(8192) }),
      { parents: {}, source: "loop", step: 0 },
      {}
    ),
    "LANGGRAPH_CHECKPOINT_TOO_LARGE",
    413
  );
  const after = await readRun(capped);
  assert.equal(after.revision, before.revision);
  assert.deepStrictEqual(after.result, before.result);
  // The queue is not poisoned by the refused write.
  await small.putWrites(threadConfig(small, { checkpoint_id: checkpointId(1) }), [["trail", "x"]], "task-1");
});

// Writes run fields straight through the store, as another worker's commit
// would land: the saver sees them only through its next read.
const patchRun = async (fixture, patch) => {
  const raw = await readRun(fixture);
  await fixture.agentRunStore.update({
    accessScope: fixture.accessScope,
    expectedRevision: raw.revision,
    patch,
    runId: fixture.runId,
  });
  return readRun(fixture);
};

test("a claim refuses a run with a step still in flight or a pending approval gate, and applies only to the record state the caller inspected", async () => {
  // Unknown in-flight work: a step another worker may still be executing.
  // Native claimExecutionGraphResume sends it to an operator, never to a
  // second worker that would run the node again.
  for (const status of ["running", "paused", "pending"]) {
    const fixture = await createRunFixture({ runId: `lg-run-step-${status}` });
    const before = await patchRun(fixture, {
      steps: [{ id: "node:a", label: "a", status, type: "document_rag" }],
    });

    assert.deepStrictEqual(
      await createSaver(fixture).claim({ expectedSequence: 0 }),
      { claimed: false, claimId: null },
      `a ${status} step`
    );
    assert.equal((await readRun(fixture)).revision, before.revision);

    // Control: the same run is claimable once that step has settled.
    await patchRun(fixture, {
      steps: [{ id: "node:a", label: "a", status: "completed", type: "document_rag" }],
    });
    assert.equal((await createSaver(fixture).claim({ expectedSequence: 0 })).claimed, true);
  }

  // A pending approval gate belongs to the user's decision, not a takeover.
  const gated = await createRunFixture({ runId: "lg-run-gate" });
  const beforeGate = await patchRun(gated, {
    approvalGates: [{ capabilityId: "task.create", id: "gate-1", status: "pending", type: "capability_approval" }],
  });
  assert.equal(beforeGate.approvalGates[0].status, "pending");
  assert.deepStrictEqual(
    await createSaver(gated).claim({ expectedSequence: 0 }),
    { claimed: false, claimId: null }
  );
  assert.equal((await readRun(gated)).revision, beforeGate.revision);
  await patchRun(gated, {
    approvalGates: [{ capabilityId: "task.create", id: "gate-1", status: "denied", type: "capability_approval" }],
  });
  assert.equal((await createSaver(gated).claim({ expectedSequence: 0 })).claimed, true);

  // The record moved past what the worker inspected: no claim.
  const moved = await createRunFixture({ runId: "lg-run-moved" });
  const writer = createSaver(moved);
  await writer.put(threadConfig(writer), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  assert.equal(await inspectedSequence(moved), 1);
  const beforeStale = await readRun(moved);
  assert.deepStrictEqual(
    await createSaver(moved).claim({ expectedSequence: 0 }),
    { claimed: false, claimId: null }
  );
  assert.equal((await readRun(moved)).revision, beforeStale.revision);
  assert.equal((await createSaver(moved).claim({ expectedSequence: 1 })).claimed, true);

  // A claim that names no inspected state is refused before any store call.
  const storeCalls = [];
  const unnamed = await createRunFixture({ runId: "lg-run-unnamed" });
  for (const options of [undefined, {}, { expectedSequence: -1 }, { expectedSequence: "0" }]) {
    await rejectsWithCode(
      createSaver(unnamed, { onStoreCall: (call) => storeCalls.push(call) }).claim(options),
      "LANGGRAPH_CHECKPOINT_INVALID_ARGUMENT",
      400
    );
  }
  assert.deepStrictEqual(storeCalls, []);
});

test("with a v2 graph checkpoint the saver writes only while the run and its graph are running", async () => {
  const fixture = await createV2GraphRun();
  const saver = createSaver(fixture);
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  const running = (await readRun(fixture)).result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY];
  const attempts = () => [
    () => saver.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {}),
    () => saver.putWrites(first, [["trail", "x"]], "task-1"),
    () => saver.deleteThread(saver.threadId),
  ];

  // Paused for approval, as pauseExecutionGraphForApproval leaves it: the
  // graph is awaiting the user and the run waits for them. No worker owns a
  // LangGraph write until the decision CAS reopens both.
  const paused = await patchRun(fixture, {
    result: {
      [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: updateExecutionGraphCheckpoint(running, {
        phase: "awaiting_approval",
      }),
    },
    status: "waiting_for_user",
  });
  for (const attempt of attempts()) {
    await rejectsWithCode(attempt(), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  }
  assert.equal((await readRun(fixture)).revision, paused.revision);

  // Each rule alone: a running graph on a run waiting for the user, and a
  // graph phase that is not running on a running run.
  const reopenedGraph = updateExecutionGraphCheckpoint(
    paused.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY],
    { phase: "running" }
  );
  const graphOnly = await patchRun(fixture, {
    result: { [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: reopenedGraph },
  });
  assert.equal(graphOnly.status, "waiting_for_user");
  for (const attempt of attempts()) {
    await rejectsWithCode(attempt(), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  }
  const partial = await patchRun(fixture, {
    result: {
      [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: updateExecutionGraphCheckpoint(reopenedGraph, {
        phase: "partial",
      }),
    },
    status: "running",
  });
  for (const attempt of attempts()) {
    await rejectsWithCode(attempt(), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  }
  assert.equal((await readRun(fixture)).revision, partial.revision);

  // Control: running run, running graph, same (null) claim: the write lands.
  await patchRun(fixture, {
    result: {
      [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: updateExecutionGraphCheckpoint(
        partial.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY],
        { phase: "running" }
      ),
    },
  });
  await saver.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {});
  assert.equal((await saver.getTuple(threadConfig(saver))).checkpoint.id, checkpointId(2));
});

test("saver writes commit in call order, whatever each one's serialization costs", async () => {
  const fixture = await createRunFixture();
  const committed = [];
  const saver = createSaver(fixture, {
    onStoreCall: ({ method, operation }) => {
      if (method !== "get") {
        committed.push(operation);
      }
    },
  });
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  committed.length = 0;

  // Three values to serialize against one checkpoint, called first, then a
  // put called before the writes were awaited: LangGraph's loop issues a
  // fork's __resume__ write and its put in this order without awaiting.
  const writes = saver.putWrites(first, [["a", 1], ["b", 2], ["c", 3]], "task-1", "~p");
  const put = saver.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {});
  await Promise.all([writes, put]);

  assert.deepStrictEqual(committed, ["putWrites", "put"]);
  const tuple = await saver.getTuple(threadConfig(saver, { checkpoint_id: checkpointId(1) }));
  assert.deepStrictEqual(tuple.pendingWrites, [
    ["task-1", "a", 1],
    ["task-1", "b", 2],
    ["task-1", "c", 3],
  ]);
});

test("given the request's run cursor, saver writes start from its snapshot and a foreign writer still forces a fresh read", async () => {
  const inner = createInMemoryAgentRunStore();
  const fixture = await createRunFixture({ agentRunStore: inner });
  const instrumented = createInstrumentedStore(inner);
  const calls = [];
  const runCursor = createAgentRunCursor();
  const saver = new RunStoreCheckpointSaver({
    agentRunStore: instrumented.store,
    accessScope: ALICE,
    onStoreCall: ({ method, operation }) => calls.push(`${operation}:${method}`),
    runCursor,
    runId: fixture.runId,
  });

  // An empty cursor: the first write reads the run.
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), { parents: {}, source: "input", step: -1 }, {});
  assert.deepStrictEqual(calls.splice(0), ["put:get", "put:updateWithEvent"]);

  // The cursor now holds the snapshot that write returned: no read.
  const second = await saver.put(first, makeCheckpoint(checkpointId(2)), { parents: {}, source: "loop", step: 0 }, {});
  await saver.putWrites(second, [["trail", "x"]], "task-1");
  assert.deepStrictEqual(calls.splice(0), ["put:updateWithEvent", "putWrites:update"]);

  // Another worker commits behind the cursor's back: the cursor's revision
  // loses the CAS, and the retry reads the run fresh and keeps both writes.
  const raw = await inner.get({ accessScope: ALICE, runId: fixture.runId });
  await inner.update({
    accessScope: ALICE,
    expectedRevision: raw.revision,
    patch: { result: { foreignReceipt: { id: "receipt-1" } } },
    runId: fixture.runId,
  });
  await saver.put(second, makeCheckpoint(checkpointId(3)), { parents: {}, source: "loop", step: 1 }, {});
  assert.deepStrictEqual(calls.splice(0), ["put:updateWithEvent", "put:get", "put:updateWithEvent"]);
  assert.equal(instrumented.stats.conflicts, 1);

  const run = await readRun(fixture);
  assert.deepStrictEqual(run.result.foreignReceipt, { id: "receipt-1" });
  assert.equal((await saver.getTuple(threadConfig(saver))).checkpoint.id, checkpointId(3));
  // Reads never come from the cursor.
  assert.deepStrictEqual(calls.splice(0), ["getTuple:get"]);
});
