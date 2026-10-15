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
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import {
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  createAgentRunCursor,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  DEFAULT_LANGGRAPH_MAX_RECORD_BYTES,
  LANGGRAPH_CHECKPOINT_FORMAT,
  LANGGRAPH_CHECKPOINT_RESULT_KEY as REEXPORTED_RESULT_KEY,
  RunStoreCheckpointSaver,
  deriveLangGraphThreadId,
} from "../rag/langgraph/checkpointer.js";
import { LANGSMITH_TRACING_ENABLED_CODE } from "../rag/langgraph/langsmith-guard.js";
import {
  getActiveDatabaseTenant,
  runAsDatabaseSystem,
  runWithDatabaseTenant,
  toDatabaseTenant,
} from "../rag/postgres-tenant.js";
import {
  EXPECTED_CONTRACT_PENDING_WRITES,
  INPUT_METADATA,
  applyContractScript,
  buildApprovalGraph,
  buildChainGraph,
  buildFanOutGraph,
  checkpointId,
  collect,
  createEffects,
  deferred,
  ids,
  loopMetadata,
  makeCheckpoint,
  readContract,
} from "./langgraph-checkpointer-contract.mjs";

// The production checkpointer (rag/langgraph/checkpointer.js) over the
// in-memory agent run store. Ported from the phase-0 spike suite
// (langgraph-spike-checkpointer.test.mjs), with the production differences:
// every write goes through the run service's fenced CAS, no event is
// recorded, and the graph checkpoint's resume claim is the only claim.

const ALICE = Object.freeze({ userId: "alice", workspaceId: "workspace-a" });
const BOB = Object.freeze({ userId: "bob", workspaceId: "workspace-a" });
const QUESTION = "What is the notice period?";
const DOC_IDS = ["doc-1"];
const SESSION_ID = "session-1";
const PLAN = { mode: "document_qa" };
// DEFAULT_AGENT_RUN_MUTATION_RETRIES in agent-runs.js (not exported): the
// retry budget of every graph write, which the LangGraph record shares.
const SERVICE_CAS_RETRIES = 32;

const rejectsWithCode = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) {
      assert.equal(error.status, status);
    }
    return true;
  });

const createRunFixture = async ({
  accessScope = ALICE,
  agentRunStore = createInMemoryAgentRunStore(),
  plan = PLAN,
  runId = "lg-run-1",
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

// Wraps a store so a test can (a) hold a read right after it returned,
// before the CAS it feeds, (b) run a foreign write before every write, and
// (c) observe what each committed write carried. The foreign writer always
// uses the inner store directly.
const createInstrumentedStore = (inner) => {
  const store = {};
  const stats = { conflicts: 0, writes: 0 };
  const calls = [];
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
    calls.push({ method, tenant: getActiveDatabaseTenant() });
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
    // Runs after the write committed and before its caller learns it did.
    await afterWrite?.({ args, method });
    return result;
  };

  store.get = async (args) => {
    calls.push({ method: "get", tenant: getActiveDatabaseTenant() });
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
    calls,
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

// A run whose service sits on an instrumented store.
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

// Records which LangGraph service method the saver called, in which tenant
// context.
const createRecordingService = (agentRunService, calls) => ({
  ...agentRunService,
  getLangGraphCheckpointRecord: (args) => {
    calls.push({ method: "getLangGraphCheckpointRecord", tenant: getActiveDatabaseTenant() });
    return agentRunService.getLangGraphCheckpointRecord(args);
  },
  mutateLangGraphCheckpointRecord: (args) => {
    calls.push({ method: "mutateLangGraphCheckpointRecord", tenant: getActiveDatabaseTenant() });
    return agentRunService.mutateLangGraphCheckpointRecord(args);
  },
});

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

const eventTypes = (run) => run.events.map((event) => event.type);

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

// --- Graph checkpoint fixtures ----------------------------------------------

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

// A heterogeneous v3 graph's v2 checkpoint, as agent-unified-graph-stage.js
// persists it.
const createV2GraphRun = async (options = {}) => {
  const fixture = await createRunFixture(options);
  const graph = createExecutionGraph({
    nodes: [{ nodeId: "document:primary", skillId: "document_rag", dependsOn: [] }],
    version: "v3",
  });
  const checkpoint = createExecutionGraphCheckpoint({ graph, owner: buildOwner(fixture), version: "v2" });
  await fixture.agentRunService.saveExecutionGraphCheckpoint({
    accessScope: fixture.accessScope,
    checkpoint,
    runId: fixture.runId,
  });

  return { ...fixture, checkpoint };
};

const requestBinding = (field) => ({ source: "request", field });

// The custom-Skill typed DAG's v1 checkpoint, as agent-custom-skill-stage.js
// persists it before the graph's first node: the graph this phase runs on
// LangGraph.
const persistV1SkillGraphCheckpoint = async (fixture) => {
  const graph = createExecutionGraph({
    nodes: [
      {
        dependsOn: [],
        failurePolicy: "continue",
        inputBindings: { docIds: requestBinding("docIds"), question: requestBinding("question") },
        nodeId: "compare",
        skillId: "compare_documents",
      },
      {
        dependsOn: ["compare"],
        failurePolicy: "continue",
        inputBindings: {
          docIds: requestBinding("docIds"),
          priorFindings: { source: "node", nodeId: "compare", output: "text" },
          question: requestBinding("question"),
        },
        nodeId: "risk",
        skillId: "risk_review",
      },
    ],
  });
  const checkpoint = createExecutionGraphCheckpoint({ graph, owner: buildOwner(fixture), version: "v1" });
  await fixture.agentRunService.saveExecutionGraphCheckpoint({
    accessScope: fixture.accessScope,
    checkpoint,
    runId: fixture.runId,
  });

  return checkpoint;
};

const createV1SkillGraphRun = async (options = {}) => {
  const fixture = await createRunFixture({ plan: { mode: "skill_chain" }, ...options });
  const checkpoint = await persistV1SkillGraphCheckpoint(fixture);

  return { ...fixture, checkpoint };
};

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

// --- Thread identity and construction ----------------------------------------

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
  // The \0 separators keep (user "a", workspace "bc") apart from ("ab", "c").
  assert.notEqual(
    deriveLangGraphThreadId({ userId: "a", workspaceId: "bc" }, "r"),
    deriveLangGraphThreadId({ userId: "ab", workspaceId: "c" }, "r")
  );
  assert.throws(() => deriveLangGraphThreadId(ALICE, "  "), { code: "LANGGRAPH_RUN_ID_REQUIRED" });

  const saver = new RunStoreCheckpointSaver({
    agentRunService: createAgentRunService(),
    accessScope: ALICE,
    graphResumeClaimId: "  claim-1 ",
    runId: "lg-run-1",
  });
  assert.equal(saver.threadId, threadId);
  assert.equal(saver.runId, "lg-run-1");
  assert.equal(saver.graphResumeClaimId, "claim-1");
  assert.equal(REEXPORTED_RESULT_KEY, LANGGRAPH_CHECKPOINT_RESULT_KEY);
  assert.equal(LANGGRAPH_CHECKPOINT_RESULT_KEY, "__langGraphCheckpoint");
});

test("the saver refuses to exist while LangSmith tracing is on, or without the run service's LangGraph methods", () => {
  const agentRunService = createAgentRunService();
  const previous = process.env.LANGSMITH_TRACING;

  process.env.LANGSMITH_TRACING = "true";
  try {
    assert.throws(
      () => new RunStoreCheckpointSaver({ agentRunService, accessScope: ALICE, runId: "lg-run-1" }),
      { code: LANGSMITH_TRACING_ENABLED_CODE }
    );
  } finally {
    if (previous === undefined) {
      delete process.env.LANGSMITH_TRACING;
    } else {
      process.env.LANGSMITH_TRACING = previous;
    }
  }

  // The saver writes only through the service; a bare store is not enough.
  assert.throws(
    () => new RunStoreCheckpointSaver({
      agentRunService: createInMemoryAgentRunStore(),
      accessScope: ALICE,
      runId: "lg-run-1",
    }),
    TypeError
  );
  for (const maxRecordBytes of [0, -1, 1.5, "4096"]) {
    assert.throws(
      () => new RunStoreCheckpointSaver({ agentRunService, accessScope: ALICE, maxRecordBytes, runId: "lg-run-1" }),
      TypeError
    );
  }
  assert.equal(DEFAULT_LANGGRAPH_MAX_RECORD_BYTES, 256 * 1024);
});

// --- Contract round trips ----------------------------------------------------

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
  assert.deepStrictEqual(firstTuple.metadata, INPUT_METADATA);
  // JsonPlusSerializer encodings survive the text round trip.
  assert.ok(firstTuple.checkpoint.channel_values.lookup instanceof Map);
  assert.equal(firstTuple.checkpoint.channel_values.lookup.get("doc-1"), 1);
  assert.ok(Object.hasOwn(firstTuple.checkpoint.channel_values, "missing"));

  assert.deepStrictEqual(actual.addressed.pendingWrites, EXPECTED_CONTRACT_PENDING_WRITES);

  assert.deepStrictEqual(ids(actual.listAll), [3, 2, 1, 4].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listRoot), [3, 2, 1].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listLimit), [3, 2].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listBefore), [2, 1].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listFilter), [3, 2, 4].map(checkpointId));
  assert.deepStrictEqual(ids(actual.listById), [checkpointId(1)]);
  assert.deepStrictEqual(ids(actual.listChild), [checkpointId(4)]);

  const record = await readRecord(fixture);
  assert.deepStrictEqual(Object.keys(record).sort(), ["format", "namespaces", "owner", "sequence", "threadId"]);
  assert.equal(record.format, LANGGRAPH_CHECKPOINT_FORMAT);
  assert.equal(record.threadId, saver.threadId);
  assert.deepStrictEqual(record.owner, { userId: "alice", workspaceId: "workspace-a", runId: "lg-run-1" });
  assertPlainJsonRecord(record);

  // Every write was a CAS without an event: the run's log is unchanged.
  assert.deepStrictEqual(eventTypes(await readRun(fixture)), ["run_created"]);
});

test("a replayed put is a no-op, a conflicting one is refused, and missing reads are undefined", async () => {
  const fixture = await createRunFixture();
  const saver = createSaver(fixture);

  assert.equal(await saver.getTuple(threadConfig(saver)), undefined);
  assert.deepStrictEqual(await collect(saver.list(threadConfig(saver))), []);

  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  const before = await readRun(fixture);

  assert.deepStrictEqual(
    await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {}),
    first
  );
  const after = await readRun(fixture);
  assert.equal(after.revision, before.revision);
  assert.equal(after.events.length, before.events.length);

  await rejectsWithCode(
    saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1), { trail: ["other"] }), INPUT_METADATA, {}),
    "LANGGRAPH_CHECKPOINT_CONFLICT",
    409
  );
  await rejectsWithCode(
    saver.putWrites(threadConfig(saver), [["trail", "x"]], "task-1"),
    "LANGGRAPH_CHECKPOINT_ID_REQUIRED",
    400
  );
  await rejectsWithCode(
    saver.put(threadConfig(saver), { ...makeCheckpoint(checkpointId(2)), id: "" }, INPUT_METADATA, {}),
    "LANGGRAPH_CHECKPOINT_INVALID_ARGUMENT",
    400
  );

  // A bytes value is stored as base64 text and comes back as bytes.
  await saver.putWrites(first, [["blob", new Uint8Array([1, 2, 3])]], "task-bytes", "~p");
  const tuple = await saver.getTuple(first);
  assert.deepStrictEqual(tuple.pendingWrites, [["task-bytes", "blob", new Uint8Array([1, 2, 3])]]);
  const record = await readRecord(fixture);
  assert.deepStrictEqual(record.namespaces[0].writes[0].value, { t: "bytes", d: "AQID" });
  // Replaying the same write is a no-op too.
  const beforeReplay = await readRun(fixture);
  await saver.putWrites(first, [["blob", new Uint8Array([1, 2, 3])]], "task-bytes", "~p");
  assert.equal((await readRun(fixture)).revision, beforeReplay.revision);

  // One sequence step per committed put and putWrites, and no event at all.
  assert.equal(record.sequence, 2);
  assert.deepStrictEqual(eventTypes(await readRun(fixture)), ["run_created"]);
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
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
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
  assert.deepStrictEqual(
    await fixture.agentRunService.getLangGraphCheckpointRecord({ accessScope: ALICE, runId: fixture.runId }),
    { record: null }
  );

  // Deleting again is a no-op; a later put starts a fresh record.
  await saver.deleteThread(saver.threadId);
  assert.equal((await readRun(fixture)).revision, after.revision);
  await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(2)), INPUT_METADATA, {});
  assert.equal((await readRecord(fixture)).sequence, 1);
});

// --- A real StateGraph -------------------------------------------------------

test("a StateGraph interrupts, persists in the run row, and resumes from a new saver over a new service", async () => {
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
  // The service kept the request's CAS base current.
  assert.equal(runCursor.read({ accessScope: ALICE, runId: fixture.runId }).revision, paused.revision);

  await fixture.agentRunService.updateRun({
    accessScope: ALICE,
    runId: fixture.runId,
    patch: { status: "waiting_for_user" },
  });

  // Simulated restart: nothing survives but the run store.
  const restartedService = createAgentRunService({ agentRunStore: fixture.agentRunStore });
  const secondSaver = new RunStoreCheckpointSaver({
    agentRunService: restartedService,
    accessScope: ALICE,
    runId: fixture.runId,
  });
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

  // The whole run wrote only the events the service's own methods record.
  assert.deepStrictEqual(eventTypes(finished), ["run_created"]);
  assert.deepStrictEqual(finished.result.answerReceipt, { digest: "sha256:receipt" });
  assert.deepStrictEqual(finished.steps, paused.steps);
  assert.equal(finished.status, "waiting_for_user");
  assert.equal(Object.hasOwn(finished.result, EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY), false);
  assertPlainJsonRecord(record);
});

test("the saver and every store call it causes see the invoking request's database tenant", async () => {
  const { instrumented, instrumentedService, ...fixture } = await createInstrumentedFixture();
  const serviceCalls = [];
  const tenantsSeen = [];
  const effects = createEffects();
  const service = createRecordingService(instrumentedService, serviceCalls);
  const saverFor = () => new RunStoreCheckpointSaver({ agentRunService: service, accessScope: ALICE, runId: fixture.runId });
  const firstSaver = saverFor();
  const config = { configurable: { thread_id: firstSaver.threadId }, durability: "sync" };

  await runWithDatabaseTenant(ALICE, () =>
    buildApprovalGraph({ checkpointer: firstSaver, effects, tenantsSeen }).invoke({ trail: [] }, config)
  );
  const resumed = await runWithDatabaseTenant(ALICE, () =>
    buildApprovalGraph({ checkpointer: saverFor(), effects, tenantsSeen }).invoke(
      new Command({ resume: { approved: false } }),
      config
    )
  );

  assert.equal(resumed.approval, "denied");
  assert.deepStrictEqual(
    [...new Set(serviceCalls.map((call) => call.method))].sort(),
    ["getLangGraphCheckpointRecord", "mutateLangGraphCheckpointRecord"]
  );
  // The store under the service saw only reads and event-less CASes.
  assert.deepStrictEqual([...new Set(instrumented.calls.map((call) => call.method))].sort(), ["get", "update"]);
  for (const call of [...serviceCalls, ...instrumented.calls, ...tenantsSeen.map((tenant) => ({ tenant }))]) {
    assert.deepStrictEqual(call.tenant, toDatabaseTenant(ALICE));
  }

  // Outside any tenant (system context) is allowed; another tenant is not,
  // and is refused before the service is called.
  await runAsDatabaseSystem(() => saverFor().getTuple(threadConfig(firstSaver)));
  serviceCalls.length = 0;
  await rejectsWithCode(
    runWithDatabaseTenant(BOB, () =>
      buildApprovalGraph({ checkpointer: saverFor(), effects }).invoke({ trail: [] }, config)
    ),
    "LANGGRAPH_TENANT_MISMATCH",
    409
  );
  await rejectsWithCode(
    runWithDatabaseTenant(BOB, async () => collect(saverFor().list({ configurable: {} }))),
    "LANGGRAPH_TENANT_MISMATCH",
    409
  );
  assert.deepStrictEqual(serviceCalls, []);
});

test("concurrent Send branches hand the saver overlapping putWrites and all of them persist", async () => {
  const fixture = await createRunFixture();
  const serviceCalls = [];
  const saver = new OverlapObservingSaver({
    agentRunService: createRecordingService(fixture.agentRunService, serviceCalls),
    accessScope: ALICE,
    runId: fixture.runId,
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

  for (const tenant of [...observed.branchTenants, ...serviceCalls.map((call) => call.tenant)]) {
    assert.deepStrictEqual(tenant, toDatabaseTenant(ALICE));
  }
  assertPlainJsonRecord(record);
});

test("a foreign writer that bumps the revision mid-write forces the service's CAS retry and both writes survive", async () => {
  const { instrumented, instrumentedService, ...fixture } = await createInstrumentedFixture();
  const saver = createSaver(fixture, { agentRunService: instrumentedService });

  const foreignWrite = async (patchResult) => {
    const raw = await fixture.agentRunStore.get({ accessScope: ALICE, runId: fixture.runId });
    await fixture.agentRunStore.update({
      accessScope: ALICE,
      expectedRevision: raw.revision,
      patch: { result: patchResult },
      runId: fixture.runId,
    });
  };

  const putControl = instrumented.pauseNextGet();
  const pendingPut = saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
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

test("a write gives up after the service's retry budget against a writer that always wins", async () => {
  const { instrumented, instrumentedService, ...fixture } = await createInstrumentedFixture();
  const saver = createSaver(fixture, { agentRunService: instrumentedService });
  let foreignWrites = 0;
  instrumented.setBeforeWrite(async () => {
    const raw = await fixture.agentRunStore.get({ accessScope: ALICE, runId: fixture.runId });
    await fixture.agentRunStore.update({
      accessScope: ALICE,
      expectedRevision: raw.revision,
      patch: { result: { foreignCounter: foreignWrites } },
      runId: fixture.runId,
    });
    foreignWrites += 1;
  });

  await rejectsWithCode(
    saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {}),
    "AGENT_RUN_REVISION_CONFLICT",
    409
  );
  assert.equal(instrumented.stats.writes, SERVICE_CAS_RETRIES + 1);
  assert.equal(instrumented.stats.conflicts, SERVICE_CAS_RETRIES + 1);
  assert.equal(Object.hasOwn((await readRun(fixture)).result, LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
});

// --- Isolation and fencing ---------------------------------------------------

test("another tenant's saver cannot read or write the run, and a foreign thread id is refused", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const fixture = await createRunFixture({ agentRunStore });
  const alice = createSaver(fixture);
  const first = await alice.put(threadConfig(alice), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  const before = await readRun(fixture);

  // Bob addresses the same runId with his own scope: there is no such run.
  const bob = new RunStoreCheckpointSaver({
    agentRunService: createAgentRunService({ agentRunStore }),
    accessScope: BOB,
    runId: fixture.runId,
  });
  await rejectsWithCode(bob.getTuple(threadConfig(bob)), "LANGGRAPH_RUN_NOT_FOUND", 404);
  await rejectsWithCode(collect(bob.list({ configurable: {} })), "LANGGRAPH_RUN_NOT_FOUND", 404);
  await rejectsWithCode(
    bob.put(threadConfig(bob), makeCheckpoint(checkpointId(2)), INPUT_METADATA, {}),
    "LANGGRAPH_RUN_NOT_FOUND",
    404
  );
  await rejectsWithCode(bob.deleteThread(bob.threadId), "LANGGRAPH_RUN_NOT_FOUND", 404);
  // Bob presenting Alice's thread id is refused before any store access.
  await rejectsWithCode(bob.getTuple(threadConfig(alice)), "LANGGRAPH_THREAD_SCOPE_MISMATCH", 409);
  await rejectsWithCode(bob.putWrites(first, [["trail", "x"]], "task-1"), "LANGGRAPH_THREAD_SCOPE_MISMATCH", 409);

  // Alice's saver refuses every foreign or missing thread id.
  for (const call of [
    () => alice.getTuple(threadConfig(bob)),
    () => alice.getTuple({ configurable: {} }),
    () => collect(alice.list(threadConfig(bob))),
    () => alice.put(threadConfig(bob), makeCheckpoint(checkpointId(3)), INPUT_METADATA, {}),
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
  await siblingSaver.put(threadConfig(siblingSaver), makeCheckpoint(checkpointId(9)), INPUT_METADATA, {});
  const listed = await collect(alice.list({ configurable: {} }));
  assert.deepStrictEqual(ids(listed), [checkpointId(1)]);
  assert.ok(listed.every((tuple) => tuple.config.configurable.thread_id === alice.threadId));
});

test("a record copied onto another run, or one this module did not write, is refused", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const source = await createRunFixture({ agentRunStore });
  const target = await createRunFixture({ agentRunStore, runId: "lg-run-2" });
  const sourceSaver = createSaver(source);
  await sourceSaver.put(threadConfig(sourceSaver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  const copied = structuredClone(await readRecord(source));
  // A raw store write: the service refuses the key on every generic patch.
  await patchRun(target, { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: copied } });
  const targetSaver = createSaver(target);

  await rejectsWithCode(targetSaver.getTuple(threadConfig(targetSaver)), "LANGGRAPH_CHECKPOINT_OWNER_MISMATCH", 409);
  await rejectsWithCode(
    targetSaver.put(threadConfig(targetSaver), makeCheckpoint(checkpointId(2)), INPUT_METADATA, {}),
    "LANGGRAPH_CHECKPOINT_OWNER_MISMATCH",
    409
  );

  await patchRun(target, { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: { ...copied, format: "other/v1" } } });
  await rejectsWithCode(targetSaver.getTuple(threadConfig(targetSaver)), "LANGGRAPH_CHECKPOINT_INVALID_RECORD", 409);
  await rejectsWithCode(targetSaver.deleteThread(targetSaver.threadId), "LANGGRAPH_CHECKPOINT_INVALID_RECORD", 409);
});

test("with a v2 graph checkpoint the saver is fenced by the graph's resume claim", async () => {
  const fixture = await createV2GraphRun();
  const original = createSaver(fixture);

  // Unclaimed: the original request's worker (claim null) owns the graph.
  const first = await original.put(threadConfig(original), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});

  const claim = await fixture.agentRunService.claimExecutionGraphResume({
    accessScope: ALICE,
    checkpointDigest: fixture.checkpoint.digest,
    runId: fixture.runId,
  });
  assert.equal(claim.claimed, true);
  const claimId = claim.checkpoint.resumeClaim.claimId;

  await rejectsWithCode(
    original.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  await rejectsWithCode(original.putWrites(first, [["trail", "x"]], "task-1"), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  await rejectsWithCode(original.deleteThread(original.threadId), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  await rejectsWithCode(
    createSaver(fixture, { graphResumeClaimId: "another-claim" }).put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  // Reads stay open to the stale worker; only writes are fenced.
  assert.equal((await original.getTuple(threadConfig(original))).checkpoint.id, checkpointId(1));

  const recovery = createSaver(fixture, { graphResumeClaimId: claimId });
  await recovery.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {});
  assert.equal((await recovery.getTuple(threadConfig(recovery))).checkpoint.id, checkpointId(2));

  // The graph checkpoint itself was not touched by the saver, not even by
  // deleteThread, which only tombstones the saver's own key.
  const beforeDelete = await readRun(fixture);
  assert.deepStrictEqual(beforeDelete.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY], claim.checkpoint);
  await recovery.deleteThread(recovery.threadId);
  const run = await readRun(fixture);
  assert.equal(run.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  assert.deepStrictEqual(run.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY], claim.checkpoint);
  assert.deepStrictEqual(run.steps, beforeDelete.steps);
  assert.deepStrictEqual(run.events, beforeDelete.events);

  // A graph checkpoint whose digest no longer reseals fences every writer.
  await patchRun(fixture, {
    result: {
      [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: {
        ...run.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY],
        phase: "completed",
      },
    },
  });
  await rejectsWithCode(
    recovery.put(threadConfig(recovery), makeCheckpoint(checkpointId(3)), INPUT_METADATA, {}),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
});

test("with a v1 custom-Skill graph checkpoint claimed through claimExecutionGraphResume, the claim fences the saver like the graph's node steps", async () => {
  const fixture = await createV1SkillGraphRun();
  const original = createSaver(fixture);
  const first = await original.put(threadConfig(original), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});

  const claim = await fixture.agentRunService.claimExecutionGraphResume({
    accessScope: ALICE,
    checkpointDigest: fixture.checkpoint.digest,
    runId: fixture.runId,
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.checkpoint.version, "v1");
  const claimId = claim.checkpoint.resumeClaim.claimId;
  // A second claimant skips: the graph is already owned.
  assert.deepStrictEqual(
    await fixture.agentRunService.claimExecutionGraphResume({
      accessScope: ALICE,
      checkpointDigest: claim.checkpoint.digest,
      runId: fixture.runId,
    }),
    { checkpoint: null, claimed: false }
  );

  // The stale worker loses both its LangGraph writes and its node starts
  // to the same persisted claim.
  const staleSteps = createAgentRunStepLifecycle({
    accessScope: ALICE,
    agentRunService: fixture.agentRunService,
    runId: fixture.runId,
  });
  const nodeStep = {
    id: "custom_skill:compare",
    input: { nodeId: "compare", skillId: "compare_documents" },
    label: "compare_documents",
    type: "custom_skill",
  };
  await rejectsWithCode(
    staleSteps.startGraphStep({ ...nodeStep, expectedResumeClaimId: null }),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
  for (const attempt of [
    () => original.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {}),
    () => original.putWrites(first, [["trail", "x"]], "task-1"),
    () => original.deleteThread(original.threadId),
  ]) {
    await rejectsWithCode(attempt(), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  }

  // The claimant writes both.
  const recovery = createSaver(fixture, { graphResumeClaimId: claimId });
  await recovery.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {});
  await staleSteps.startGraphStep({ ...nodeStep, expectedResumeClaimId: claimId });
  const run = await readRun(fixture);
  assert.deepStrictEqual(run.steps.map((step) => [step.id, step.status]), [["custom_skill:compare", "running"]]);
  assert.equal((await recovery.getTuple(threadConfig(recovery))).checkpoint.id, checkpointId(2));
  assert.deepStrictEqual(run.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY], claim.checkpoint);

  // A settled graph has no LangGraph writer, the claimant included.
  await patchRun(fixture, {
    result: {
      [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: updateExecutionGraphCheckpoint(claim.checkpoint, {
        phase: "completed",
      }),
    },
  });
  await rejectsWithCode(
    recovery.putWrites(threadConfig(recovery, { checkpoint_id: checkpointId(2) }), [["trail", "y"]], "task-2"),
    "AGENT_GRAPH_EXECUTION_FENCED",
    409
  );
});

test("without a graph checkpoint an unclaimed saver writes while the run is open, and a claim-bound one is fenced", async () => {
  const fixture = await createRunFixture();
  const unclaimed = createSaver(fixture);
  const first = await unclaimed.put(threadConfig(unclaimed), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});

  // A claim with no graph to have claimed is not an owner.
  const claimBound = createSaver(fixture, { graphResumeClaimId: "claim-without-graph" });
  const before = await readRun(fixture);
  for (const attempt of [
    () => claimBound.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {}),
    () => claimBound.putWrites(first, [["trail", "x"]], "task-1"),
    () => claimBound.deleteThread(claimBound.threadId),
  ]) {
    await rejectsWithCode(attempt(), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  }
  assert.equal((await readRun(fixture)).revision, before.revision);

  // Waiting for the user is still open (an approval continuation resumes
  // there).
  await fixture.agentRunService.updateRun({
    accessScope: ALICE,
    runId: fixture.runId,
    patch: { status: "waiting_for_user" },
  });
  await unclaimed.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {});
  assert.equal((await unclaimed.getTuple(threadConfig(unclaimed))).checkpoint.id, checkpointId(2));
});

// Pins actual behaviour, not a goal: the fence is checked when the stale
// worker next persists, so a node LangGraph starts after another worker took
// the claim still runs once. Node starts need their own fence (the step
// lifecycle's startGraphStep with the graph claim), which this saver does not
// provide.
test("pins: the saver fences what a stale worker persists, not which node it starts", async () => {
  const { instrumented, instrumentedService, ...fixture } = await createInstrumentedFixture({
    plan: { mode: "skill_chain" },
  });
  const graphCheckpoint = await persistV1SkillGraphCheckpoint(fixture);
  const stale = createSaver(fixture, { agentRunService: instrumentedService });
  const effects = { finish: 0, plan: 0, work: 0 };
  const config = { configurable: { thread_id: stale.threadId }, durability: "sync" };
  let checkpointCount = 0;
  let recoveryClaim = null;

  instrumented.setAfterWrite(async ({ args }) => {
    const record = args.patch?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY];
    const count = record?.namespaces?.[0]?.checkpoints?.length ?? 0;
    const isPut = count > checkpointCount;
    checkpointCount = Math.max(checkpointCount, count);

    // The checkpoint holding plan's result has just committed. A recovery
    // worker claims the graph before the stale worker's LangGraph loop learns
    // the put succeeded and starts the next node.
    if (isPut && effects.plan === 1 && recoveryClaim === null) {
      recoveryClaim = await fixture.agentRunService.claimExecutionGraphResume({
        accessScope: ALICE,
        checkpointDigest: graphCheckpoint.digest,
        runId: fixture.runId,
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
  const recovery = createSaver(fixture, {
    graphResumeClaimId: recoveryClaim.checkpoint.resumeClaim.claimId,
  });
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
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  const marked = await manual.agentRunService.markManualRecovery({
    accessScope: ALICE,
    recovery: { reason: "checkpointer_test" },
    runId: manual.runId,
  });
  assert.equal(marked.marked, true);

  for (const attempt of [
    () => saver.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {}),
    () => saver.putWrites(first, [["trail", "x"]], "task-1"),
    () => saver.deleteThread(saver.threadId),
  ]) {
    await rejectsWithCode(attempt(), "AGENT_GRAPH_EXECUTION_FENCED", 409);
  }

  for (const [status, settle] of [
    ["canceled", (fixture) => fixture.agentRunService.cancelRun({ accessScope: ALICE, reason: "checkpointer_test", runId: fixture.runId })],
    ["completed", (fixture) => fixture.agentRunService.completeRun({ accessScope: ALICE, runId: fixture.runId })],
    ["failed", (fixture) => fixture.agentRunService.failRun({ accessScope: ALICE, error: new Error("x"), runId: fixture.runId })],
  ]) {
    const settled = await createRunFixture({ runId: `lg-run-${status}` });
    const settledSaver = createSaver(settled);
    await settle(settled);
    const beforeSettled = await readRun(settled);
    assert.equal(beforeSettled.status, status);
    await rejectsWithCode(
      settledSaver.put(threadConfig(settledSaver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {}),
      "AGENT_GRAPH_EXECUTION_FENCED",
      409
    );
    assert.equal((await readRun(settled)).revision, beforeSettled.revision);
  }

  const capped = await createRunFixture({ runId: "lg-run-capped" });
  const small = createSaver(capped, { maxRecordBytes: 4096 });
  await small.put(threadConfig(small), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  const before = await readRun(capped);
  await rejectsWithCode(
    small.put(
      threadConfig(small, { checkpoint_id: checkpointId(1) }),
      makeCheckpoint(checkpointId(2), { padding: "x".repeat(8192) }),
      loopMetadata(0),
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

test("with a v2 graph checkpoint the saver writes only while the run and its graph are running", async () => {
  const fixture = await createV2GraphRun();
  const saver = createSaver(fixture);
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  const running = (await readRun(fixture)).result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY];
  const attempts = () => [
    () => saver.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {}),
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
  await saver.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {});
  assert.equal((await saver.getTuple(threadConfig(saver))).checkpoint.id, checkpointId(2));
});

test("saver writes commit in call order, whatever each one's serialization costs", async () => {
  const { instrumented, instrumentedService, ...fixture } = await createInstrumentedFixture();
  const saver = createSaver(fixture, { agentRunService: instrumentedService });
  const committed = [];
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  instrumented.setAfterWrite(({ args }) => {
    const namespace = args.patch.result[LANGGRAPH_CHECKPOINT_RESULT_KEY].namespaces[0];
    committed.push({ checkpoints: namespace.checkpoints.length, writes: namespace.writes.length });
  });

  // Three values to serialize against one checkpoint, called first, then a
  // put called before the writes were awaited: LangGraph's loop issues a
  // fork's __resume__ write and its put in this order without awaiting.
  const writes = saver.putWrites(first, [["a", 1], ["b", 2], ["c", 3]], "task-1", "~p");
  const put = saver.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {});
  await Promise.all([writes, put]);

  assert.deepStrictEqual(committed, [
    { checkpoints: 1, writes: 3 },
    { checkpoints: 2, writes: 3 },
  ]);
  const tuple = await saver.getTuple(threadConfig(saver, { checkpoint_id: checkpointId(1) }));
  assert.deepStrictEqual(tuple.pendingWrites, [
    ["task-1", "a", 1],
    ["task-1", "b", 2],
    ["task-1", "c", 3],
  ]);
});

test("given the request's run cursor, saver writes start from its snapshot and a foreign writer still forces a fresh read", async () => {
  const { instrumented, instrumentedService, ...fixture } = await createInstrumentedFixture();
  const runCursor = createAgentRunCursor();
  const saver = createSaver(fixture, { agentRunService: instrumentedService, runCursor });
  const methods = () => instrumented.calls.splice(0).map((call) => call.method);

  // An empty cursor: the first write reads the run.
  const first = await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {});
  assert.deepStrictEqual(methods(), ["get", "update"]);

  // The cursor now holds the snapshot that write returned: no read.
  const second = await saver.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {});
  await saver.putWrites(second, [["trail", "x"]], "task-1");
  assert.deepStrictEqual(methods(), ["update", "update"]);

  // Another worker commits behind the cursor's back: the cursor's revision
  // loses the CAS, and the retry reads the run fresh and keeps both writes.
  const raw = await fixture.agentRunStore.get({ accessScope: ALICE, runId: fixture.runId });
  await fixture.agentRunStore.update({
    accessScope: ALICE,
    expectedRevision: raw.revision,
    patch: { result: { foreignReceipt: { id: "receipt-1" } } },
    runId: fixture.runId,
  });
  await saver.put(second, makeCheckpoint(checkpointId(3)), loopMetadata(1), {});
  assert.deepStrictEqual(methods(), ["update", "get", "update"]);
  assert.equal(instrumented.stats.conflicts, 1);

  const run = await readRun(fixture);
  assert.deepStrictEqual(run.result.foreignReceipt, { id: "receipt-1" });
  assert.equal(runCursor.read({ accessScope: ALICE, runId: fixture.runId }).revision, run.revision);
  assert.equal((await saver.getTuple(threadConfig(saver))).checkpoint.id, checkpointId(3));
  // Reads never come from the cursor.
  assert.deepStrictEqual(methods(), ["get"]);
});

// --- The run service's LangGraph record --------------------------------------

test("the LangGraph record never reaches a public projection, and no generic patch can write it", async () => {
  const fixture = await createV1SkillGraphRun();
  const runCursor = createAgentRunCursor();
  const saver = createSaver(fixture, { runCursor });
  await saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1), { trail: ["plan"] }), INPUT_METADATA, {});
  const raw = await readRun(fixture);
  assert.ok(raw.result[LANGGRAPH_CHECKPOINT_RESULT_KEY]);

  const service = fixture.agentRunService;
  const publicRun = await service.getRun({ accessScope: ALICE, runId: fixture.runId });
  const listed = await service.listRuns({ accessScope: ALICE });
  const recoverable = await service.listRecoverableRuns({ includeAccessScope: true });
  const graph = await service.getExecutionGraphCheckpoint({ accessScope: ALICE, runId: fixture.runId });
  const updated = await service.updateRun({
    accessScope: ALICE,
    patch: { result: { note: "kept" } },
    runId: fixture.runId,
  });

  for (const projected of [
    publicRun,
    listed.runs[0],
    recoverable.runs[0],
    runCursor.peek({ accessScope: ALICE, runId: fixture.runId }),
    updated,
  ]) {
    assert.equal(Object.hasOwn(projected.result, LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
    assert.equal(JSON.stringify(projected).includes("archive-rag.langgraph-saver"), false);
  }
  assert.equal(listed.runs.length, 1);
  assert.equal(Object.hasOwn(graph, LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
  assert.equal(JSON.stringify(graph).includes("archive-rag.langgraph-saver"), false);
  // The generic patch kept the record (the result merge is shallow).
  assert.deepStrictEqual(
    (await readRun(fixture)).result[LANGGRAPH_CHECKPOINT_RESULT_KEY],
    raw.result[LANGGRAPH_CHECKPOINT_RESULT_KEY]
  );

  // Forging, replacing or dropping it through any generic patch is refused,
  // with or without the graph re-entry guard (which reads the graph
  // checkpoint), and through completeRun's result.
  const before = await readRun(fixture);
  for (const value of [{ forged: true }, null]) {
    await rejectsWithCode(
      service.updateRun({
        accessScope: ALICE,
        patch: { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: value } },
        runId: fixture.runId,
      }),
      "AGENT_GRAPH_CHECKPOINT_PRIVATE_FIELD",
      409
    );
  }
  const plain = await createRunFixture({ agentRunStore: fixture.agentRunStore, runId: "lg-run-plain" });
  await rejectsWithCode(
    service.updateRun({
      accessScope: ALICE,
      graphReentryGuard: true,
      patch: { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: { forged: true } } },
      runId: plain.runId,
    }),
    "AGENT_GRAPH_CHECKPOINT_PRIVATE_FIELD",
    409
  );
  await rejectsWithCode(
    service.completeRun({
      accessScope: ALICE,
      result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: { forged: true } },
      runId: plain.runId,
    }),
    "AGENT_GRAPH_CHECKPOINT_PRIVATE_FIELD",
    409
  );
  const after = await readRun(fixture);
  assert.deepStrictEqual(after.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], before.result[LANGGRAPH_CHECKPOINT_RESULT_KEY]);
  assert.equal(after.revision, before.revision);
  assert.equal(Object.hasOwn((await readRun(plain)).result, LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
});

test("mutateLangGraphCheckpointRecord commits one event-less CAS of that key only, and reads fail closed", async () => {
  const fixture = await createRunFixture();
  const service = fixture.agentRunService;
  const scoped = { accessScope: ALICE, runId: fixture.runId };

  assert.deepStrictEqual(await service.getLangGraphCheckpointRecord(scoped), { record: null });
  assert.equal(await service.getLangGraphCheckpointRecord({ accessScope: BOB, runId: fixture.runId }), null);
  assert.equal(await service.getLangGraphCheckpointRecord({ accessScope: ALICE, runId: "missing" }), null);
  await assert.rejects(service.mutateLangGraphCheckpointRecord(scoped), TypeError);

  // Another tenant's (or a missing) run: null, and decide never runs.
  let decided = 0;
  const countingDecide = () => {
    decided += 1;
    return { record: { n: 1 } };
  };
  assert.equal(
    await service.mutateLangGraphCheckpointRecord({ accessScope: BOB, decide: countingDecide, runId: fixture.runId }),
    null
  );
  assert.equal(decided, 0);

  // A no-op leaves the run untouched.
  const before = await readRun(fixture);
  assert.deepStrictEqual(
    await service.mutateLangGraphCheckpointRecord({ ...scoped, decide: () => null }),
    { applied: false, value: null }
  );
  assert.equal((await readRun(fixture)).revision, before.revision);

  // A write: decide sees the stored record, the value passes through, the
  // stored record is a copy of what decide returned, and no event is written.
  const next = { n: 1, nested: { list: [1, 2] } };
  const seen = [];
  assert.deepStrictEqual(
    await service.mutateLangGraphCheckpointRecord({
      ...scoped,
      decide: (record) => {
        seen.push(record);
        return { record: next, value: "written" };
      },
    }),
    { applied: true, value: "written" }
  );
  assert.deepStrictEqual(seen, [null]);
  next.nested.list.push(3);
  const written = await readRun(fixture);
  assert.deepStrictEqual(written.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], { n: 1, nested: { list: [1, 2] } });
  assert.equal(written.revision, before.revision + 1);
  assert.deepStrictEqual(written.events, before.events);
  assert.deepStrictEqual(written.result.recovery, before.result.recovery);

  // decide gets a private copy each time; changing it changes nothing stored.
  await service.mutateLangGraphCheckpointRecord({
    ...scoped,
    decide: (record) => {
      record.n = 99;
      return null;
    },
  });
  assert.deepStrictEqual((await service.getLangGraphCheckpointRecord(scoped)).record, { n: 1, nested: { list: [1, 2] } });

  // Only an object or the null tombstone is a record.
  for (const decision of [{}, { record: [] }, { record: "x" }, { record: 1 }]) {
    await assert.rejects(
      service.mutateLangGraphCheckpointRecord({ ...scoped, decide: () => decision }),
      TypeError
    );
  }
  assert.deepStrictEqual(
    await service.mutateLangGraphCheckpointRecord({ ...scoped, decide: () => ({ record: null }) }),
    { applied: true, value: null }
  );
  const tombstoned = await readRun(fixture);
  assert.equal(tombstoned.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  assert.deepStrictEqual(await service.getLangGraphCheckpointRecord(scoped), { record: null });
  assert.deepStrictEqual(tombstoned.events, before.events);
});
