// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-spike/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";

import { Command, MemorySaver } from "@langchain/langgraph";

import {
  EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY,
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createExecutionGraph } from "../rag/agent-execution-graph.js";
import { isAgentRunRevisionConflictError } from "../rag/agent-run-revision.js";
import {
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  createAgentRunCursor,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  LANGGRAPH_CHECKPOINT_RETENTION,
  RunStoreCheckpointSaver,
} from "../rag/langgraph/checkpointer.js";
import {
  INPUT_METADATA,
  applyContractScript,
  buildApprovalGraph,
  buildLongApprovalGraph,
  checkpointId,
  collect,
  createEffects,
  ids,
  loopMetadata,
  makeCheckpoint,
  readContract,
} from "./langgraph-checkpointer-contract.mjs";

// The thread record's write amplification (docs/adr/0001-langgraph-runtime.md,
// phase 2 open item; the header of rag/langgraph/checkpointer.js): the
// retention of K checkpoints per namespace, the thread write that changes
// nothing and costs no read on a cursor-held run, and the graph's final
// checkpoint save that drops the record in its own CAS. The MemorySaver
// contract, fencing and tenancy of the saver are pinned by
// langgraph-checkpointer.test.mjs and are not repeated here.

const ALICE = Object.freeze({ userId: "alice", workspaceId: "workspace-a" });
const QUESTION = "What is the notice period?";
const DOC_IDS = ["doc-1"];
const SESSION_ID = "session-1";

const createRunFixture = async ({
  accessScope = ALICE,
  agentRunStore = createInMemoryAgentRunStore(),
  plan = { mode: "document_qa" },
  runId = "lg-wa-run-1",
} = {}) => {
  const agentRunService = createAgentRunService({ agentRunStore });
  await agentRunService.createRun({
    accessScope,
    goal: QUESTION,
    input: { docIds: DOC_IDS, sessionId: SESSION_ID, userId: accessScope.userId },
    plan,
    runId,
  });

  return { accessScope, agentRunService, agentRunStore, plan, runId };
};

const readRun = ({ accessScope, agentRunStore, runId }) =>
  agentRunStore.get({ accessScope, runId });

const readRecord = async (fixture) =>
  (await readRun(fixture))?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY];

const createSaver = (fixture, options = {}) =>
  new RunStoreCheckpointSaver({
    agentRunService: fixture.agentRunService,
    accessScope: fixture.accessScope,
    runId: fixture.runId,
    ...options,
  });

const threadConfig = (saver, configurable = {}) => ({
  configurable: { thread_id: saver.threadId, checkpoint_ns: "", ...configurable },
});

const eventTypes = (run) => run.events.map((event) => event.type);

// Records every store call the service makes (get, update, updateWithEvent)
// and counts revision conflicts; the foreign writer uses the inner store.
const createInstrumentedStore = (inner) => {
  const store = {};
  const stats = { conflicts: 0 };
  const calls = [];

  for (const [name, value] of Object.entries(inner)) {
    if (typeof value === "function") {
      store[name] = value.bind(inner);
    }
  }

  const write = async (method, args) => {
    calls.push(method);
    try {
      return await inner[method](args);
    } catch (error) {
      if (isAgentRunRevisionConflictError(error)) {
        stats.conflicts += 1;
      }
      throw error;
    }
  };

  store.get = (args) => {
    calls.push("get");
    return inner.get(args);
  };
  store.update = (args) => write("update", args);
  store.updateWithEvent = (args) => write("updateWithEvent", args);

  return { calls, stats, store };
};

const createInstrumentedFixture = async (options = {}) => {
  const inner = createInMemoryAgentRunStore();
  const fixture = await createRunFixture({ ...options, agentRunStore: inner });
  const instrumented = createInstrumentedStore(inner);

  return {
    ...fixture,
    instrumented,
    instrumentedService: createAgentRunService({ agentRunStore: instrumented.store }),
  };
};

// --- Graph checkpoint fixtures ----------------------------------------------

const requestBinding = (field) => ({ source: "request", field });

const buildOwner = (fixture) =>
  buildExecutionGraphCheckpointOwner({
    accessScope: fixture.accessScope,
    budgetState: { limits: {}, used: {} },
    docIds: DOC_IDS,
    plan: fixture.plan,
    question: QUESTION,
    retrievalPlan: null,
    selectedSkills: [],
    sessionId: SESSION_ID,
    taskMemory: null,
    userId: fixture.accessScope.userId,
  });

// The custom-Skill typed DAG's v1 checkpoint, as agent-custom-skill-stage.js
// persists it before the graph's first node.
const createV1SkillGraphRun = async (options = {}) => {
  const fixture = await createRunFixture({ plan: { mode: "skill_chain" }, ...options });
  const graph = createExecutionGraph({
    nodes: [
      {
        dependsOn: [],
        failurePolicy: "continue",
        inputBindings: { docIds: requestBinding("docIds"), question: requestBinding("question") },
        nodeId: "compare",
        skillId: "compare_documents",
      },
    ],
  });
  const checkpoint = createExecutionGraphCheckpoint({ graph, owner: buildOwner(fixture), version: "v1" });
  await fixture.agentRunService.saveExecutionGraphCheckpoint({
    accessScope: fixture.accessScope,
    checkpoint,
    runId: fixture.runId,
  });

  return { ...fixture, checkpoint };
};

const settle = (checkpoint, phase) =>
  updateExecutionGraphCheckpoint(checkpoint, { phase });

const saveCheckpoint = (fixture, checkpoint, options = {}) =>
  fixture.agentRunService.saveExecutionGraphCheckpoint({
    accessScope: fixture.accessScope,
    checkpoint,
    runId: fixture.runId,
    ...options,
  });

const rejectsWithCode = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) {
      assert.equal(error.status, status);
    }
    return true;
  });

// --- Retention ----------------------------------------------------------------

test("retainCheckpoints is a positive integer or null, and the default keeps everything", async () => {
  const fixture = await createRunFixture();

  assert.equal(LANGGRAPH_CHECKPOINT_RETENTION, 2);
  assert.equal(createSaver(fixture).retainCheckpoints, null);
  assert.equal(createSaver(fixture, { retainCheckpoints: 1 }).retainCheckpoints, 1);

  for (const retainCheckpoints of [0, -1, 1.5, "2", Number.NaN, Infinity, undefined]) {
    if (retainCheckpoints === undefined) {
      assert.equal(createSaver(fixture, { retainCheckpoints }).retainCheckpoints, null);
      continue;
    }

    assert.throws(() => createSaver(fixture, { retainCheckpoints }), TypeError);
  }
});

test("with retention K, a put keeps the K newest checkpoints of its namespace and the writes of those ids, and every read of them matches MemorySaver", async () => {
  const fixture = await createRunFixture();
  const saver = createSaver(fixture, { retainCheckpoints: LANGGRAPH_CHECKPOINT_RETENTION });
  const reference = new MemorySaver();

  const ours = await applyContractScript(saver, saver.threadId);
  const theirs = await applyContractScript(reference, saver.threadId);
  const actual = await readContract(saver, saver.threadId, ours);
  const expected = await readContract(reference, saver.threadId, theirs);

  // What a resume reads: the newest checkpoint, its pending writes, an
  // addressed retained checkpoint, the child namespace, and the newest two of
  // a listing. All identical to MemorySaver's.
  for (const key of ["latest", "addressed", "child", "listLimit", "listChild", "missingId", "missingNamespace"]) {
    assert.deepStrictEqual(actual[key], expected[key], key);
  }
  assert.deepStrictEqual(actual.addressed.pendingWrites, expected.addressed.pendingWrites);
  // The retained window is exactly the K newest per namespace: the root's
  // first checkpoint (the input) is gone, the child namespace is untouched.
  assert.deepStrictEqual(ids(actual.listRoot), [3, 2].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listAll), [3, 2, 4].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listBefore), [2].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listFilter), [3, 2, 4].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listById), []);
  assert.deepStrictEqual(ids(expected.listRoot), [3, 2, 1].map(checkpointId));
  assert.equal(await saver.getTuple(ours.first), undefined);
  // A retained checkpoint still names its pruned parent.
  assert.deepStrictEqual(actual.listRoot.at(-1).parentConfig, {
    configurable: { thread_id: saver.threadId, checkpoint_ns: "", checkpoint_id: checkpointId(1) },
  });

  const record = await readRecord(fixture);
  const root = record.namespaces.find((namespace) => namespace.ns === "");
  assert.deepStrictEqual(root.checkpoints.map((entry) => entry.id), [2, 3].map(checkpointId));
  assert.ok(root.writes.length > 0);
  assert.ok(root.writes.every((write) => write.checkpointId === checkpointId(2)));

  // The next put pushes the second checkpoint out together with its writes,
  // in that one write: no separate cleanup CAS.
  const run = await readRun(fixture);
  await saver.put(ours.third, makeCheckpoint(checkpointId(5), { trail: ["plan", "gate", "finish", "x"] }), loopMetadata(2), {});
  const pruned = await readRun(fixture);
  const prunedRoot = pruned.result[LANGGRAPH_CHECKPOINT_RESULT_KEY].namespaces.find((namespace) => namespace.ns === "");

  assert.equal(pruned.revision, run.revision + 1);
  assert.deepStrictEqual(prunedRoot.checkpoints.map((entry) => entry.id), [3, 5].map(checkpointId));
  assert.deepStrictEqual(prunedRoot.writes, []);
  assert.equal(await saver.getTuple(ours.second), undefined);
  assert.equal((await saver.getTuple(threadConfig(saver))).checkpoint.id, checkpointId(5));
  assert.deepStrictEqual((await saver.getTuple(threadConfig(saver))).pendingWrites, []);

  // A checkpoint older than the retained window is dropped by its own put:
  // the window is the K newest, whatever order they arrive in.
  await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(0), { trail: [] }), INPUT_METADATA, {});
  assert.deepStrictEqual(
    (await readRecord(fixture)).namespaces.find((namespace) => namespace.ns === "").checkpoints.map((entry) => entry.id),
    [3, 5].map(checkpointId)
  );
  // Every write was a CAS without an event.
  assert.deepStrictEqual(eventTypes(await readRun(fixture)), ["run_created"]);
});

test("a StateGraph that interrupts and resumes over retention K runs exactly as unbounded, and its history is K deep", async () => {
  const fixture = await createRunFixture();
  const effects = createEffects();
  const runCursor = createAgentRunCursor();
  const firstSaver = createSaver(fixture, { retainCheckpoints: LANGGRAPH_CHECKPOINT_RETENTION, runCursor });
  const firstGraph = buildApprovalGraph({ checkpointer: firstSaver, effects });
  const config = { configurable: { thread_id: firstSaver.threadId }, durability: "sync" };

  const interrupted = await firstGraph.invoke({ trail: [] }, config);

  assert.deepStrictEqual(interrupted.trail, ["plan"]);
  assert.deepStrictEqual(interrupted.__interrupt__[0].value, { gateId: "gate-1" });
  assert.deepStrictEqual(effects, { afterInterrupt: 0, beforeInterrupt: 1, finish: 0, plan: 1 });

  // Paused: the thread holds the newest checkpoint (with its interrupt
  // write) and its parent (with the finished node's writes), nothing older,
  // and no write of a dropped checkpoint.
  const pausedRecord = await readRecord(fixture);
  assert.equal(pausedRecord.namespaces[0].checkpoints.length, LANGGRAPH_CHECKPOINT_RETENTION);
  const retainedIds = new Set(pausedRecord.namespaces[0].checkpoints.map((entry) => entry.id));
  const newestId = pausedRecord.namespaces[0].checkpoints.at(-1).id;
  assert.ok(pausedRecord.namespaces[0].writes.every((write) => retainedIds.has(write.checkpointId)));
  assert.ok(
    pausedRecord.namespaces[0].writes.some(
      (write) => write.channel === "__interrupt__" && write.checkpointId === newestId
    )
  );

  // Resumed from a new saver over a new service, as a continuation is.
  const restartedService = createAgentRunService({ agentRunStore: fixture.agentRunStore });
  const secondSaver = new RunStoreCheckpointSaver({
    agentRunService: restartedService,
    accessScope: ALICE,
    retainCheckpoints: LANGGRAPH_CHECKPOINT_RETENTION,
    runId: fixture.runId,
  });
  const secondGraph = buildApprovalGraph({ checkpointer: secondSaver, effects });
  const pendingState = await secondGraph.getState({ configurable: { thread_id: secondSaver.threadId } });
  assert.deepStrictEqual(pendingState.next, ["gate"]);

  const completed = await secondGraph.invoke(new Command({ resume: { approved: true } }), {
    configurable: { thread_id: secondSaver.threadId },
    durability: "sync",
  });

  assert.deepStrictEqual(completed, { approval: "approved", trail: ["plan", "gate", "finish"] });
  // Same as without retention: code before interrupt() twice, after it
  // once, the finished node never again.
  assert.deepStrictEqual(effects, { afterInterrupt: 1, beforeInterrupt: 2, finish: 1, plan: 1 });

  const finalState = await secondGraph.getState({ configurable: { thread_id: secondSaver.threadId } });
  assert.deepStrictEqual(finalState.next, []);
  assert.deepStrictEqual(finalState.values, completed);

  const history = await collect(secondGraph.getStateHistory({ configurable: { thread_id: secondSaver.threadId } }));
  const record = await readRecord(fixture);
  assert.equal(history.length, LANGGRAPH_CHECKPOINT_RETENTION);
  assert.equal(record.namespaces[0].checkpoints.length, LANGGRAPH_CHECKPOINT_RETENTION);
  assert.equal(history[0].config.configurable.checkpoint_id, finalState.config.configurable.checkpoint_id);
  assert.ok(history[0].metadata.step > history[1].metadata.step);
  assert.deepStrictEqual(eventTypes(await readRun(fixture)), ["run_created"]);
});

test("a thread pruned to K before it interrupts resumes exactly as an unbounded one", async () => {
  // Three nodes before the gate: six checkpoints (the input, LangGraph's own
  // __start__ superstep, plan, step_1, step_2, step_3) are in the thread at
  // the pause without retention, so with K the oldest ones were dropped
  // before the interrupt was written.
  const STEPS_BEFORE_GATE = 3;
  const runOn = async ({ retainCheckpoints }) => {
    const fixture = await createRunFixture();
    const effects = createEffects();
    const runCursor = createAgentRunCursor();
    const firstSaver = createSaver(fixture, { retainCheckpoints, runCursor });
    const firstGraph = buildLongApprovalGraph({ checkpointer: firstSaver, effects, stepsBeforeGate: STEPS_BEFORE_GATE });
    const config = { configurable: { thread_id: firstSaver.threadId }, durability: "sync" };
    const interrupted = await firstGraph.invoke({ trail: [] }, config);
    const pausedRecord = await readRecord(fixture);

    // Resumed from a new saver over a new service, as a continuation is.
    const restartedService = createAgentRunService({ agentRunStore: fixture.agentRunStore });
    const secondSaver = new RunStoreCheckpointSaver({
      agentRunService: restartedService,
      accessScope: ALICE,
      retainCheckpoints,
      runId: fixture.runId,
    });
    const secondGraph = buildLongApprovalGraph({ checkpointer: secondSaver, effects, stepsBeforeGate: STEPS_BEFORE_GATE });
    const pendingState = await secondGraph.getState({ configurable: { thread_id: secondSaver.threadId } });
    const completed = await secondGraph.invoke(new Command({ resume: { approved: true } }), {
      configurable: { thread_id: secondSaver.threadId },
      durability: "sync",
    });
    const finalState = await secondGraph.getState({ configurable: { thread_id: secondSaver.threadId } });

    return {
      completed,
      effects,
      events: eventTypes(await readRun(fixture)),
      finalNext: finalState.next,
      finalValues: finalState.values,
      interrupted: { interrupt: interrupted.__interrupt__[0].value, trail: interrupted.trail },
      pausedCheckpointIds: pausedRecord.namespaces[0].checkpoints.map((entry) => entry.id),
      pausedWrites: pausedRecord.namespaces[0].writes,
      pendingNext: pendingState.next,
    };
  };

  const unbounded = await runOn({ retainCheckpoints: null });
  const retained = await runOn({ retainCheckpoints: LANGGRAPH_CHECKPOINT_RETENTION });

  // Pruned before the pause: the unbounded thread holds every checkpoint up
  // to the gate's superstep, the retained one only the K newest of those.
  assert.equal(unbounded.pausedCheckpointIds.length, STEPS_BEFORE_GATE + 3);
  assert.equal(retained.pausedCheckpointIds.length, LANGGRAPH_CHECKPOINT_RETENTION);
  // No write of a dropped checkpoint survives; the interrupt is a write of
  // the newest one.
  const retainedIds = new Set(retained.pausedCheckpointIds);
  assert.equal(retainedIds.size, LANGGRAPH_CHECKPOINT_RETENTION);
  assert.ok(retained.pausedWrites.every((write) => retainedIds.has(write.checkpointId)));
  assert.ok(
    retained.pausedWrites.some(
      (write) => write.channel === "__interrupt__" && write.checkpointId === retained.pausedCheckpointIds.at(-1)
    )
  );

  // Everything the graph did and left behind is the same: the pause, what
  // was next, the resume, the effects (the finished nodes never again), the
  // final state, and the event log (no event for any thread write).
  const trail = ["plan", "step_1", "step_2", "step_3"];
  assert.deepStrictEqual(retained.interrupted, { interrupt: { gateId: "gate-1" }, trail });
  assert.deepStrictEqual(retained.pendingNext, ["gate"]);
  assert.deepStrictEqual(retained.completed, { approval: "approved", trail: [...trail, "gate", "finish"] });
  assert.deepStrictEqual(retained.effects, { afterInterrupt: 1, beforeInterrupt: 2, finish: 1, plan: 1 });
  assert.deepStrictEqual(retained.finalNext, []);
  assert.deepStrictEqual(retained.finalValues, retained.completed);
  for (const key of ["completed", "effects", "events", "finalNext", "finalValues", "interrupted", "pendingNext"]) {
    assert.deepStrictEqual(retained[key], unbounded[key], key);
  }
});

// --- No read for a no-op -------------------------------------------------------

test("a thread write that changes nothing costs no read on a cursor-held run, and a write still commits by CAS", async () => {
  const { instrumented, instrumentedService, ...fixture } = await createInstrumentedFixture();
  const runCursor = createAgentRunCursor();
  const saver = createSaver(fixture, { agentRunService: instrumentedService, runCursor });
  const calls = () => instrumented.calls.splice(0);

  // An empty cursor: the tombstone of a thread that has no record reads the
  // run once and writes nothing, as before.
  await saver.deleteThread(saver.threadId);
  assert.deepStrictEqual(calls(), ["get"]);
  assert.equal(Object.hasOwn((await readRun(fixture)).result, LANGGRAPH_CHECKPOINT_RESULT_KEY), false);

  // The cursor now holds the run (the service remembered the read): the
  // same no-op costs nothing at all.
  await saver.deleteThread(saver.threadId);
  assert.deepStrictEqual(calls(), []);

  // A write commits on the cursor's snapshot without a read.
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  assert.deepStrictEqual(calls(), ["update"]);
  // A replayed put is a no-op: no read, no write.
  await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  assert.deepStrictEqual(calls(), []);
  // Dropping a thread that exists is one write ...
  await saver.deleteThread(saver.threadId);
  assert.deepStrictEqual(calls(), ["update"]);
  assert.equal((await readRun(fixture)).result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  // ... and dropping it again nothing.
  await saver.deleteThread(saver.threadId);
  assert.deepStrictEqual(calls(), []);

  // Another worker commits behind the cursor's back. The no-op is still
  // decided on the cursor (only this saver writes the record, and the cursor
  // holds every write it committed); the next write loses the CAS, reads
  // fresh, and keeps the foreign write.
  const raw = await readRun(fixture);
  await fixture.agentRunStore.update({
    accessScope: ALICE,
    expectedRevision: raw.revision,
    patch: { result: { foreignReceipt: { id: "receipt-1" } } },
    runId: fixture.runId,
  });
  await saver.deleteThread(saver.threadId);
  assert.deepStrictEqual(calls(), []);
  const second = await saver.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {});
  assert.deepStrictEqual(calls(), ["update", "get", "update"]);
  assert.equal(instrumented.stats.conflicts, 1);
  const run = await readRun(fixture);
  assert.deepStrictEqual(run.result.foreignReceipt, { id: "receipt-1" });
  assert.equal(run.result[LANGGRAPH_CHECKPOINT_RESULT_KEY].namespaces[0].checkpoints.length, 1);
  assert.equal(runCursor.read({ accessScope: ALICE, runId: fixture.runId }).revision, run.revision);
  assert.equal(second.configurable.checkpoint_id, checkpointId(2));

  // Reads never come from the cursor.
  assert.equal((await saver.getTuple(threadConfig(saver))).checkpoint.id, checkpointId(2));
  assert.deepStrictEqual(calls(), ["get"]);
  assert.deepStrictEqual(eventTypes(run), ["run_created"]);
});

test("mutateLangGraphCheckpointRecord: a no-op on the cursor is final, a rejected decision is decided again fresh", async () => {
  const { instrumented, instrumentedService, ...fixture } = await createInstrumentedFixture();
  const runCursor = createAgentRunCursor();
  const scoped = { accessScope: ALICE, runCursor, runId: fixture.runId };
  const calls = () => instrumented.calls.splice(0);
  const seen = [];

  // Fills the cursor.
  assert.deepStrictEqual(
    await instrumentedService.mutateLangGraphCheckpointRecord({ ...scoped, decide: () => null }),
    { applied: false, value: null }
  );
  assert.deepStrictEqual(calls(), ["get"]);

  // Decided once, on the cursor, nothing read.
  assert.deepStrictEqual(
    await instrumentedService.mutateLangGraphCheckpointRecord({
      ...scoped,
      decide: (record) => {
        seen.push(record);
        return null;
      },
    }),
    { applied: false, value: null }
  );
  assert.deepStrictEqual(calls(), []);
  assert.deepStrictEqual(seen, [null]);

  // A writer that is fenced on the cursor's snapshot (a claim it does not
  // hold) is checked again against the stored run before it is refused.
  await rejectsWithCode(
    instrumentedService.mutateLangGraphCheckpointRecord({
      ...scoped,
      decide: () => null,
      graphResumeClaimId: "not-a-claim",
    }),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  assert.deepStrictEqual(calls(), ["get"]);

  // Without a cursor every no-op reads, as before.
  assert.deepStrictEqual(
    await instrumentedService.mutateLangGraphCheckpointRecord({
      accessScope: ALICE,
      decide: () => null,
      runId: fixture.runId,
    }),
    { applied: false, value: null }
  );
  assert.deepStrictEqual(calls(), ["get"]);
});

// --- Completion drops the record --------------------------------------------------

test("the graph's final checkpoint save drops the LangGraph record in the same CAS, and only for a settled graph", async () => {
  const fixture = await createV1SkillGraphRun();
  const instrumented = createInstrumentedStore(fixture.agentRunStore);
  const instrumentedService = createAgentRunService({ agentRunStore: instrumented.store });
  const scoped = { accessScope: ALICE, runId: fixture.runId };
  const calls = () => instrumented.calls.splice(0);
  const saver = createSaver(fixture);

  await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1), { receipts: {} }), INPUT_METADATA, {});
  await saver.putWrites({ ...threadConfig(saver), configurable: { ...threadConfig(saver).configurable, checkpoint_id: checkpointId(1) } }, [["receipts", { status: "completed" }]], "task-1");
  const written = await readRun(fixture);
  assert.ok(written.result[LANGGRAPH_CHECKPOINT_RESULT_KEY]);

  // Refused before any store call: not a boolean, or a graph still running
  // (or paused for approval), whose thread the continuation resumes.
  const runningUpdate = updateExecutionGraphCheckpoint(fixture.checkpoint, { replans: [] });
  for (const dropLangGraphRecord of ["yes", 1, null]) {
    await assert.rejects(
      instrumentedService.saveExecutionGraphCheckpoint({ ...scoped, checkpoint: runningUpdate, dropLangGraphRecord }),
      TypeError
    );
  }
  await assert.rejects(
    instrumentedService.saveExecutionGraphCheckpoint({ ...scoped, checkpoint: runningUpdate, dropLangGraphRecord: true }),
    TypeError
  );
  await assert.rejects(
    instrumentedService.saveExecutionGraphCheckpoint({
      ...scoped,
      checkpoint: updateExecutionGraphCheckpoint(fixture.checkpoint, { phase: "awaiting_approval" }),
      dropLangGraphRecord: true,
    }),
    TypeError
  );
  assert.deepStrictEqual(calls(), []);
  assert.deepStrictEqual(await readRun(fixture), written);

  // The final save: one CAS with the checkpoint event, the settled
  // checkpoint stored, the record gone, everything else untouched.
  const completed = settle(fixture.checkpoint, "completed");
  const saved = await instrumentedService.saveExecutionGraphCheckpoint({
    ...scoped,
    checkpoint: completed,
    dropLangGraphRecord: true,
  });
  assert.deepStrictEqual(calls(), ["get", "updateWithEvent"]);
  assert.deepStrictEqual(saved, completed);

  const dropped = await readRun(fixture);
  assert.equal(dropped.revision, written.revision + 1);
  assert.equal(dropped.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  assert.deepStrictEqual(dropped.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY], completed);
  assert.deepStrictEqual(eventTypes(dropped), [...eventTypes(written), "skill_graph_checkpointed"]);
  assert.deepStrictEqual(dropped.events.at(-1).payload, {
    graphRevision: 0,
    phase: "completed",
    sequence: completed.sequence,
    version: "v1",
  });
  assert.deepStrictEqual(dropped.steps, written.steps);
  assert.equal(dropped.status, written.status);
  assert.deepStrictEqual(await instrumentedService.getLangGraphCheckpointRecord(scoped), { record: null });
  assert.equal(
    Object.hasOwn((await instrumentedService.getRun(scoped)).result, LANGGRAPH_CHECKPOINT_RESULT_KEY),
    false
  );
  assert.equal(await saver.getTuple(threadConfig(saver)), undefined);
  calls();

  // A replayed final save is the no-op it always was.
  await instrumentedService.saveExecutionGraphCheckpoint({ ...scoped, checkpoint: completed, dropLangGraphRecord: true });
  assert.deepStrictEqual(calls(), ["get"]);
  assert.equal((await readRun(fixture)).revision, dropped.revision);

  // And the settled graph fences the saver: the thread cannot come back.
  await rejectsWithCode(
    saver.put(threadConfig(saver), makeCheckpoint(checkpointId(2)), loopMetadata(0), {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  assert.equal((await readRun(fixture)).result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
});

test("a settled checkpoint saved without the drop keeps the record, and a replay with the drop clears it without a second event", async () => {
  const fixture = await createV1SkillGraphRun({ runId: "lg-wa-run-2" });
  const instrumented = createInstrumentedStore(fixture.agentRunStore);
  const instrumentedService = createAgentRunService({ agentRunStore: instrumented.store });
  const scoped = { accessScope: ALICE, runId: fixture.runId };
  const calls = () => instrumented.calls.splice(0);
  const saver = createSaver(fixture);

  await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  const partial = settle(fixture.checkpoint, "partial");
  await instrumentedService.saveExecutionGraphCheckpoint({ ...scoped, checkpoint: partial });
  const kept = await readRun(fixture);
  assert.deepStrictEqual(calls(), ["get", "updateWithEvent"]);
  assert.ok(kept.result[LANGGRAPH_CHECKPOINT_RESULT_KEY]);

  await instrumentedService.saveExecutionGraphCheckpoint({ ...scoped, checkpoint: partial, dropLangGraphRecord: true });
  const dropped = await readRun(fixture);
  assert.deepStrictEqual(calls(), ["get", "update"]);
  assert.equal(dropped.revision, kept.revision + 1);
  assert.equal(dropped.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  assert.deepStrictEqual(dropped.events, kept.events);
  assert.deepStrictEqual(dropped.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY], partial);

  // Nothing left to drop: no write.
  await instrumentedService.saveExecutionGraphCheckpoint({ ...scoped, checkpoint: partial, dropLangGraphRecord: true });
  assert.deepStrictEqual(calls(), ["get"]);
  assert.equal((await readRun(fixture)).revision, dropped.revision);
});

test("a run that never had a thread gets no tombstone from the drop, and the drop needs the graph's own fences", async () => {
  const fixture = await createV1SkillGraphRun({ runId: "lg-wa-run-3" });
  const scoped = { accessScope: ALICE, runId: fixture.runId };
  const before = await readRun(fixture);

  await saveCheckpoint(fixture, settle(fixture.checkpoint, "completed"), { dropLangGraphRecord: true });
  const after = await readRun(fixture);
  assert.equal(Object.hasOwn(after.result, LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
  assert.equal(after.revision, before.revision + 1);
  assert.deepStrictEqual(eventTypes(after), [...eventTypes(before), "skill_graph_checkpointed"]);

  // A worker whose claim is not the graph's cannot drop the thread either:
  // the drop is part of a save, and the save is refused as before.
  const other = await createV1SkillGraphRun({ runId: "lg-wa-run-4" });
  const otherSaver = createSaver(other);
  await otherSaver.put(threadConfig(otherSaver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  const claimed = await other.agentRunService.claimExecutionGraphResume({
    accessScope: ALICE,
    checkpointDigest: other.checkpoint.digest,
    runId: other.runId,
  });
  assert.equal(claimed.claimed, true);
  // The original worker's final save: the stored claim is not its (none).
  await rejectsWithCode(
    saveCheckpoint(
      other,
      updateExecutionGraphCheckpoint(claimed.checkpoint, { phase: "completed", resumeClaim: null }),
      { dropLangGraphRecord: true }
    ),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  // A save built on a stale checkpoint is a conflict, as before.
  await rejectsWithCode(
    saveCheckpoint(other, settle(other.checkpoint, "completed"), { dropLangGraphRecord: true }),
    "AGENT_GRAPH_CHECKPOINT_CONFLICT",
    409
  );
  assert.ok((await readRun(other)).result[LANGGRAPH_CHECKPOINT_RESULT_KEY]);
  // The claim holder's own final save drops it.
  await saveCheckpoint(other, settle(claimed.checkpoint, "completed"), { dropLangGraphRecord: true });
  assert.equal((await readRun(other)).result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  assert.deepStrictEqual(
    await other.agentRunService.getLangGraphCheckpointRecord({ accessScope: ALICE, runId: other.runId }),
    { record: null }
  );
  assert.equal(scoped.runId, fixture.runId);
});
