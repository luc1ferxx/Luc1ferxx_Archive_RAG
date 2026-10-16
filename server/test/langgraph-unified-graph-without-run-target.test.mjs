// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import {
  APPROVAL_TASK_QUESTION,
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE as accessScope,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  createApprovalGatedTaskProposal,
  createCrashingRunService,
  createDocumentLoopProposal,
  createDocumentLoopRagService,
  createProposalAdapter,
  createTaskCapabilityRegistry,
} from "./fixtures/unified-graph-run-fixtures.mjs";

// The v3 stage (rag/agent-unified-graph-stage.js) on AGENT_RUNTIME=langgraph
// never calls the native scheduler (docs/adr/0001-langgraph-runtime.md,
// phase 5): a step lifecycle without a run target runs LangGraph without a
// checkpointer, and a finalization replay runs no scheduler at all
// (replayExecutionGraphRun), on either runtime.
//
// Every production caller hands the stage a lifecycle with a run target, so
// the first case is reached here by redirecting the stage's own lookup of
// that target (langgraph-support/stage-run-target-switch.mjs): the lifecycle
// still records every step on the run, as before. The stage's import of the
// runner goes to a tripwire (langgraph-support/stage-native-scheduler-
// tripwire.mjs) that counts both entries per runtime and makes the native
// scheduler throw on LangGraph. The redirects apply to the stage's imports
// only, and the suite runs in its own process (test/run.test.mjs), so every
// other module keeps the real ones; that is also why every rag module is
// imported dynamically, after register().
//
// Each scenario runs on both runtimes, on fresh stores, and the request's
// whole outcome must be equal after masking (ids, timestamps, durations, the
// checkpoint seal and the hashes derived from it): the /chat response, the
// run (events, steps, status, result) and the v2 graph checkpoint.

const ragUrl = new URL("../rag/", import.meta.url).href;
const stageUrl = new URL("agent-unified-graph-stage.js", ragUrl).href;

globalThis.__archiveRagStageProbe = {
  hideRunTarget: false,
  nativeScheduler: { langgraph: 0, native: 0 },
  replays: { langgraph: 0, native: 0 },
  targetLookups: 0,
};
const probe = globalThis.__archiveRagStageProbe;

register("./langgraph-runtime-parity/redirect-hooks.mjs", import.meta.url, {
  data: {
    redirects: [
      {
        capture: new URL("./langgraph-support/stage-run-target-switch.mjs", import.meta.url).href,
        fromPrefix: stageUrl,
        target: new URL("agent-run-step-lifecycle.js", ragUrl).href,
      },
      {
        capture: new URL("./langgraph-support/stage-native-scheduler-tripwire.mjs", import.meta.url).href,
        fromPrefix: stageUrl,
        target: new URL("agent-execution-graph-runner.js", ragUrl).href,
      },
    ],
  },
});

const [
  { AsyncLocalStorageProviderSingleton },
  { continueAgentExecutionGraphApproval, resumeAgentExecutionGraphRun, runAgentRag },
  { createAgentRunRecoveryService },
  { createAgentRunStepExecutor },
  { createAgentRunService, createInMemoryAgentRunStore },
  { LANGGRAPH_CHECKPOINT_RESULT_KEY, RunStoreCheckpointSaver },
  { createDefaultSkillRegistry },
] = await Promise.all([
  import("@langchain/core/singletons"),
  import("../rag/agent.js"),
  import("../rag/agent-run-recovery.js"),
  import("../rag/agent-run-step-executor.js"),
  import("../rag/agent-runs.js"),
  import("../rag/langgraph/checkpointer.js"),
  import("../rag/skills/registry.js"),
]);

const RUNTIMES = Object.freeze(["native", "langgraph"]);

// As test/langgraph-unified-graph.test.mjs: AGENT_RUNTIME alone moves the v3
// graph, and the answer-rate flags stay off.
const ENV = Object.freeze({
  AGENT_FOLLOW_UP_ORIGINAL_QUESTION: undefined,
  AGENT_OUTER_PLAN_RUNTIME: undefined,
  AGENT_PLANNER_ROLLOUT: "deterministic",
  AGENT_SINGLE_DOCUMENT_ROUTING: undefined,
  AGENT_UNIFIED_GRAPH_CAPABILITIES: "task.create",
  AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_CLAIM_HEADING_CONTEXT: undefined,
  RAG_CLAIM_INFLECTION: undefined,
  RAG_CLAIM_JUDGE_TEMPERATURE: undefined,
  RAG_CLAIM_SOURCE_INHERITANCE: undefined,
  RAG_LONG_MEMORY_ENABLED: "false",
  RAG_QA_GATE_INFLECTION: undefined,
});

const withEnv = async (overrides, work) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]])
  );
  const apply = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };

  apply(overrides);

  try {
    return await work();
  } finally {
    apply(previous);
  }
};

const onRuntime = (runtime, work) => withEnv({ ...ENV, AGENT_RUNTIME: runtime }, work);

// What the stage was handed, and what reached the runner, while `work` ran.
const observeStage = async ({ hideRunTarget }, work) => {
  const before = structuredClone({ ...probe, hideRunTarget: undefined });

  probe.hideRunTarget = hideRunTarget;

  try {
    const value = await work();
    const delta = (field) =>
      Object.fromEntries(
        Object.entries(probe[field]).map(([runtime, count]) => [runtime, count - before[field][runtime]])
      );

    return {
      nativeScheduler: delta("nativeScheduler"),
      replays: delta("replays"),
      targetLookups: probe.targetLookups - before.targetLookups,
      value,
    };
  } finally {
    probe.hideRunTarget = false;
  }
};

// ---------------------------------------------------------------------------
// Masking (as test/langgraph-unified-graph.test.mjs)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const APPROVAL_HASH_PATTERN = /(?<!v1:)sha256:[0-9a-f]{64}/g;
const GATE_ID_PATTERN = /graph-approval:[0-9a-f]{64}/g;
const SEAL_PATTERN = /^[0-9a-f]{64}$/;
const SEAL_KEYS = new Set(["digest", "graphDigest"]);
const WALL_CLOCK_KEY_PATTERN = /(?:duration|latency|elapsed)Ms$/i;
// The task node's output names the run id (its idempotency key), so its
// digest and the answer's differ between any two runs.
const RUN_BOUND_DIGEST_KEYS = new Set(["answerDigest", "outputDigest", "typedOutputDigest"]);

const mask = (value, key = "") => {
  if (typeof value === "string") {
    if (SEAL_KEYS.has(key) && SEAL_PATTERN.test(value)) {
      return "<seal>";
    }

    if (RUN_BOUND_DIGEST_KEYS.has(key)) {
      return "<typed-digest>";
    }

    return value
      .replace(UUID_PATTERN, "<id>")
      .replace(ISO_TIMESTAMP_PATTERN, "<time>")
      .replace(APPROVAL_HASH_PATTERN, "sha256:<approval-hash>")
      .replace(GATE_ID_PATTERN, "graph-approval:<approval-hash>");
  }

  if (typeof value === "number" && WALL_CLOCK_KEY_PATTERN.test(key)) {
    return "<elapsed>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => mask(item));
  }

  if (value instanceof Error) {
    return mask({ code: value.code, message: value.message, name: value.name, status: value.status });
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mask(item, name)]));
  }

  return value;
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const newStore = () => createInMemoryAgentRunStore();
const newService = (store) => createAgentRunService({ agentRunStore: store });

const load = async (agentRunService, runId) => ({
  checkpoint: (await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }))
    ?.checkpoint ?? null,
  run: await agentRunService.getRun({ accessScope, runId }),
});

const rawRecord = async (store, runId) =>
  (await store.get({ accessScope, runId }))?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY] ?? null;

const findOnlyRunId = async (store) => {
  const listed = await store.list({ accessScope });
  const [{ runId }] = listed?.runs ?? listed;

  return runId;
};

const settle = (promise) =>
  promise.then(
    (value) => ({ error: null, value }),
    (error) => ({ error, value: null })
  );

// The LangGraph thread a Skill call or a Capability write runs in, if any: a
// LangGraph node runs under the invocation's config.
const currentThreadId = () =>
  AsyncLocalStorageProviderSingleton.getRunnableConfig()?.configurable?.thread_id ?? null;

const askOn = async (
  runtime,
  {
    proposal = createApprovalGatedTaskProposal,
    question = APPROVAL_TASK_QUESTION,
    ragOptions = {},
    store = newStore(),
    agentRunService = newService(store),
    withCapability = true,
  } = {}
) => {
  const threads = [];
  const ragService = createDocumentLoopRagService({
    primary: "supported",
    ...ragOptions,
    onChat: async () => {
      threads.push(currentThreadId());
    },
  });
  const { registry, writes } = withCapability
    ? await createTaskCapabilityRegistry({
        onWrite: async () => {
          threads.push(currentThreadId());
        },
        ragService,
      })
    : { registry: undefined, writes: [] };
  const outcome = await settle(
    onRuntime(runtime, () =>
      runAgentRag({
        accessScope,
        agentRunService,
        ...(registry ? { capabilityRegistry: registry } : {}),
        docIds: [UNIFIED_DOC_ID],
        question,
        ragService,
        sessionId: UNIFIED_SESSION_ID,
        unifiedGraphAllowedCapabilityIds: ["task.create"],
        unifiedGraphPlannerAdapter: createProposalAdapter(proposal),
        userId: accessScope.userId,
      })
    )
  );
  const response = outcome.value;

  return {
    agentRunService,
    error: outcome.error,
    gate: response?.body?.approvalGates?.[0] ?? null,
    ragService,
    registry,
    response,
    runId: response?.body?.agentRunId ?? (await findOnlyRunId(store)),
    store,
    threads,
    writes,
  };
};

// The approval endpoint's handler, wired as app-services wires it, on a NEW
// run service over the same store.
const decideOn = (runtime, { action, context, service = newService(context.store) }) =>
  onRuntime(runtime, () =>
    createAgentRunStepExecutor({
      agentRunService: service,
      capabilityRegistry: context.registry,
      continueExecutionGraphApproval: (args) =>
        continueAgentExecutionGraphApproval({
          ...args,
          agentRunService: service,
          capabilityRegistry: context.registry,
          ragService: context.ragService,
        }),
    }).applyApprovalAction({
      accessScope,
      action,
      gateId: context.gate.id,
      payload: { approvalObjectHash: context.gate.approvalObjectHash },
      runId: context.runId,
    })
  );

const recoverOn = (runtime, { context, service = newService(context.store) }) =>
  onRuntime(runtime, () =>
    createAgentRunRecoveryService({
      agentRunService: service,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: (args) =>
        resumeAgentExecutionGraphRun({
          ...args,
          agentRunService: service,
          capabilityRegistry: context.registry,
          ragService: context.ragService,
          skillRegistry: createDefaultSkillRegistry(),
        }),
    }).recoverOnStartup({ mode: "auto" })
  );

const describeOutcome = async (context, { agentRunService = context.agentRunService, response = context.response } = {}) => {
  const { checkpoint, run } = await load(agentRunService, context.runId);

  return mask({ checkpoint, error: context.error, response, run });
};

// The run's own thread id, which only a checkpointed invocation uses.
const runThreadId = (context) =>
  new RunStoreCheckpointSaver({
    accessScope,
    agentRunService: context.agentRunService,
    runId: context.runId,
  }).threadId;

// Natively no Skill call or write runs in a thread. On LangGraph without a run
// target each one runs in a thread of its own invocation, never the run's.
const assertThreads = (runtime, context, label) => {
  assert.ok(context.threads.length > 0, label);

  if (runtime === "native") {
    assert.deepEqual(context.threads, context.threads.map(() => null), label);
    return;
  }

  for (const threadId of context.threads) {
    assert.equal(typeof threadId, "string", label);
    assert.notEqual(threadId, runThreadId(context), label);
  }
};

const assertStageEntries = (runtime, observed, { native, replays = 0 }, label) => {
  // Only the LangGraph branch asks for the run its thread would live on.
  assert.equal(
    observed.targetLookups > 0,
    runtime === "langgraph",
    `${label}: the stage looked up its run target ${observed.targetLookups} times`
  );
  assert.deepEqual(
    observed.nativeScheduler,
    { langgraph: 0, native: runtime === "native" ? native : 0 },
    `${label}: native scheduler calls`
  );
  assert.deepEqual(
    observed.replays,
    { langgraph: runtime === "langgraph" ? replays : 0, native: runtime === "native" ? replays : 0 },
    `${label}: replays`
  );
};

// ---------------------------------------------------------------------------
// A lifecycle without a run target
// ---------------------------------------------------------------------------

test("without a run target, the evidence-gated document loop runs on LangGraph without a thread, exactly as natively", async () => {
  for (const followUp of ["resolves", "unresolved"]) {
    const outcomes = {};

    for (const runtime of RUNTIMES) {
      const label = `${followUp}/${runtime}`;
      const observed = await observeStage({ hideRunTarget: true }, () =>
        askOn(runtime, {
          proposal: createDocumentLoopProposal,
          question: DOCUMENT_LOOP_QUESTION,
          ragOptions: { followUp, primary: "unsupported" },
          withCapability: false,
        })
      );
      const context = observed.value;

      assert.equal(context.error, null, `${label}: ${context.error?.message}`);
      assert.deepEqual(context.ragService.calls.map((call) => call.phase), ["primary", "follow_up"], label);
      assertThreads(runtime, context, label);
      assertStageEntries(runtime, observed, { native: 1 }, label);
      assert.equal(await rawRecord(context.store, context.runId), null, label);
      outcomes[runtime] = await describeOutcome(context);
    }

    assert.deepEqual(outcomes.langgraph, outcomes.native, followUp);
    assert.equal(outcomes.native.checkpoint.phase, "completed");
  }
});

test("without a run target, an approval-gated Capability pauses through the stage's own pause, and the approval continues as a fresh invocation, exactly as natively", async () => {
  const outcomes = {};

  for (const runtime of RUNTIMES) {
    const asked = await observeStage({ hideRunTarget: true }, () => askOn(runtime));
    const context = asked.value;

    assert.equal(context.error, null, `${runtime}: ${context.error?.message}`);
    assert.equal(context.response.body.clarification.reason, "capability_approval_required", runtime);
    assert.equal(context.writes.length, 0, runtime);
    assertStageEntries(runtime, asked, { native: 1 }, `pause/${runtime}`);
    // No checkpointer, so no thread holds the pause: the gate and the paused
    // checkpoint are the stage's pauseForApproval CAS, as natively.
    assert.equal(await rawRecord(context.store, context.runId), null, runtime);
    const paused = await describeOutcome(context);

    const service = newService(context.store);
    const decided = await observeStage({ hideRunTarget: true }, () =>
      decideOn(runtime, { action: "approve", context, service })
    );

    assert.equal(decided.value.run.status, "completed", runtime);
    assert.equal(context.writes.length, 1, runtime);
    assert.equal(context.ragService.calls.length, 1, runtime);
    assertStageEntries(runtime, decided, { native: 1 }, `approve/${runtime}`);
    assertThreads(runtime, context, `approve/${runtime}`);
    assert.equal(await rawRecord(context.store, context.runId), null, runtime);
    outcomes[runtime] = {
      approved: await describeOutcome(context, { agentRunService: service, response: null }),
      decision: mask({ response: decided.value.response, status: decided.value.status }),
      paused,
    };
  }

  assert.deepEqual(outcomes.langgraph, outcomes.native);
  assert.equal(outcomes.native.paused.checkpoint.phase, "awaiting_approval");
  assert.deepEqual(
    outcomes.native.approved.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map(({ nodeId, status }) => [nodeId, status]),
    [["document", "reused"], ["evidence_check", "reused"], ["task", "completed"]]
  );
});

test("without a run target, a denied gate settles the parked node as approval_denied, exactly as natively", async () => {
  const outcomes = {};

  for (const runtime of RUNTIMES) {
    const { value: context } = await observeStage({ hideRunTarget: true }, () => askOn(runtime));
    const service = newService(context.store);
    const decided = await observeStage({ hideRunTarget: true }, () =>
      decideOn(runtime, { action: "deny", context, service })
    );

    assert.equal(decided.value.run.status, "completed", runtime);
    assert.equal(context.writes.length, 0, runtime);
    // Nothing is left to run once the denied node is settled: LangGraph
    // returns before an invocation, natively the loop runs no pass.
    assertStageEntries(runtime, decided, { native: 1 }, `deny/${runtime}`);
    outcomes[runtime] = {
      decision: mask({ response: decided.value.response, status: decided.value.status }),
      denied: await describeOutcome(context, { agentRunService: service, response: null }),
    };
  }

  assert.deepEqual(outcomes.langgraph, outcomes.native);
  assert.deepEqual(
    outcomes.native.denied.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
    [["document", "reused", null], ["evidence_check", "reused", null], ["task", "skipped", "approval_denied"]]
  );
});

// ---------------------------------------------------------------------------
// Finalization replay, with and without a run target
// ---------------------------------------------------------------------------

test("a finalization replay reaches no scheduler on either runtime, with or without a run target", async () => {
  for (const hideRunTarget of [false, true]) {
    const outcomes = {};

    for (const runtime of RUNTIMES) {
      const label = `${hideRunTarget ? "no run target" : "run target"}/${runtime}`;
      const store = newStore();
      const { service: crashing } = createCrashingRunService(newService(store), {
        crashBefore: (method, args) =>
          method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
      });
      const asked = await observeStage({ hideRunTarget }, () =>
        askOn(runtime, {
          agentRunService: crashing,
          proposal: createDocumentLoopProposal,
          question: DOCUMENT_LOOP_QUESTION,
          store,
          withCapability: false,
        })
      );
      const context = asked.value;

      assert.equal(context.error?.code, "SIMULATED_PROCESS_EXIT", label);
      assertStageEntries(runtime, asked, { native: 1 }, `ask/${label}`);
      const calls = context.ragService.calls.length;
      const service = newService(store);
      const recovered = await observeStage({ hideRunTarget }, () =>
        recoverOn(runtime, { context, service })
      );

      assert.equal(recovered.value.autoRecoveredCount, 1, `${label}: ${JSON.stringify(recovered.value)}`);
      assertStageEntries(runtime, recovered, { native: 0, replays: 1 }, `replay/${label}`);
      assert.equal(context.ragService.calls.length, calls, label);
      assert.equal(await rawRecord(store, context.runId), null, label);
      const { checkpoint, run } = await load(service, context.runId);
      assert.ok(checkpoint.finalization, label);
      assert.deepEqual(
        run.events
          .filter((event) => event.type === "unified_graph_executed")
          .at(-1).payload.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
        [
          ["primary", "reused", null],
          ["primary_check", "reused", null],
          ["follow_up", "skipped", "condition_not_met"],
          ["follow_up_check", "skipped", "dependency_skipped"],
        ],
        label
      );
      outcomes[runtime] = await describeOutcome({ ...context, error: null }, { agentRunService: service, response: null });
    }

    assert.deepEqual(outcomes.langgraph, outcomes.native, hideRunTarget ? "no run target" : "run target");
  }
});
