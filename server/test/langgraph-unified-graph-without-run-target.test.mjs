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
// Only node builtins: safe to load before register() below.
import { assertMatchesGraphGolden } from "./langgraph-support/graph-goldens.mjs";

// The v3 stage (rag/agent-unified-graph-stage.js) with a step lifecycle
// without a run target runs LangGraph without a checkpointer, and a
// finalization replay runs no scheduler at all (replayExecutionGraphRun)
// (docs/adr/0001-langgraph-runtime.md, phase 5).
//
// Every production caller hands the stage a lifecycle with a run target, so
// the first case is reached here by redirecting the stage's own lookup of
// that target (langgraph-support/stage-run-target-switch.mjs): the lifecycle
// still records every step on the run, as before. The stage's import of the
// runner goes to a counter of its replays (langgraph-support/stage-replay-
// counter.mjs), and its import of the LangGraph executor to the recording
// tap of the parity suite (langgraph-runtime-parity/langgraph-executor-
// tap.mjs), which shows whether an invocation was bound to the run. The
// redirects apply to the stage's imports only, and the suite runs in its own
// process (test/run.test.mjs), so every other module keeps the real ones;
// that is also why every rag module is imported dynamically, after
// register().
//
// Each scenario's whole outcome, after masking (ids, timestamps, durations,
// the checkpoint seal and the hashes derived from it) -- the /chat response,
// the run (events, steps, status, result) and the v2 graph checkpoint -- must
// equal the golden frozen from the native scheduler's run of the same
// scenario before phase 6 deleted it
// (test/fixtures/graph-goldens/langgraph-unified-graph-without-run-target/).

const ragUrl = new URL("../rag/", import.meta.url).href;
const stageUrl = new URL("agent-unified-graph-stage.js", ragUrl).href;

globalThis.__archiveRagStageProbe = {
  hideRunTarget: false,
  replays: 0,
  targetLookups: 0,
};
const probe = globalThis.__archiveRagStageProbe;
const executorTapUrl = new URL("./langgraph-runtime-parity/langgraph-executor-tap.mjs", import.meta.url).href;

register("./langgraph-runtime-parity/redirect-hooks.mjs", import.meta.url, {
  data: {
    redirects: [
      {
        capture: new URL("./langgraph-support/stage-run-target-switch.mjs", import.meta.url).href,
        fromPrefix: stageUrl,
        target: new URL("agent-run-step-lifecycle.js", ragUrl).href,
      },
      {
        capture: new URL("./langgraph-support/stage-replay-counter.mjs", import.meta.url).href,
        fromPrefix: stageUrl,
        target: new URL("agent-execution-graph-runner.js", ragUrl).href,
      },
      {
        capture: executorTapUrl,
        fromPrefix: stageUrl,
        target: new URL("langgraph/run-execution-graph.js", ragUrl).href,
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
  { takeLangGraphInvocations },
] = await Promise.all([
  import("@langchain/core/singletons"),
  import("../rag/agent.js"),
  import("../rag/agent-run-recovery.js"),
  import("../rag/agent-run-step-executor.js"),
  import("../rag/agent-runs.js"),
  import("../rag/langgraph/checkpointer.js"),
  import("../rag/skills/registry.js"),
  import(executorTapUrl),
]);

const GOLDEN_SUITE = "langgraph-unified-graph-without-run-target";

// The outcome against the golden the native scheduler's run froze
// (UPDATE_GRAPH_GOLDENS=1 rewrites it from this run; see the helper's rules).
const assertMatchesNativeGolden = (caseName, outcome) =>
  assertMatchesGraphGolden(GOLDEN_SUITE, caseName, outcome);

// As test/langgraph-unified-graph.test.mjs: the guarded v3 graph with the
// outer plan on the native loop, and the answer-rate flags off.
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

const inEnv = (work) => withEnv(ENV, work);

// What the stage was handed, what it replayed, and what it handed the
// LangGraph executor, while `work` ran.
const observeStage = async ({ hideRunTarget }, work) => {
  const before = { replays: probe.replays, targetLookups: probe.targetLookups };

  probe.hideRunTarget = hideRunTarget;
  takeLangGraphInvocations();

  try {
    const value = await work();

    return {
      invocations: takeLangGraphInvocations(),
      replays: probe.replays - before.replays,
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

const ask = async ({
  proposal = createApprovalGatedTaskProposal,
  question = APPROVAL_TASK_QUESTION,
  ragOptions = {},
  store = newStore(),
  agentRunService = newService(store),
  withCapability = true,
} = {}) => {
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
    inEnv(() =>
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
const decide = ({ action, context, service = newService(context.store) }) =>
  inEnv(() =>
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

const recover = ({ context, service = newService(context.store) }) =>
  inEnv(() =>
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

// Without a run target each Skill call and write runs in a thread of its own
// invocation, never the run's. (The native scheduler ran them in none.)
const assertThreads = (context, label) => {
  assert.ok(context.threads.length > 0, label);

  for (const threadId of context.threads) {
    assert.equal(typeof threadId, "string", label);
    assert.notEqual(threadId, runThreadId(context), label);
  }
};

// The stage asked for the run its thread would live on, handed the LangGraph
// executor `executorCalls` graphs (as many as it once handed the native
// scheduler), bound to the run only when the target was visible, and
// replayed `replays` settled graphs without any scheduler.
const assertStageEntries = (observed, { boundToRun, executorCalls, replays = 0 }, label) => {
  assert.ok(
    observed.targetLookups > 0,
    `${label}: the stage looked up its run target ${observed.targetLookups} times`
  );
  assert.deepEqual(
    observed.invocations.map((invocation) => invocation.boundToRun),
    Array.from({ length: executorCalls }, () => boundToRun),
    `${label}: LangGraph executor calls`
  );
  assert.equal(observed.replays, replays, `${label}: replays`);
};

// ---------------------------------------------------------------------------
// A lifecycle without a run target
// ---------------------------------------------------------------------------

test("without a run target, the evidence-gated document loop runs on LangGraph without a thread, exactly as natively", async () => {
  for (const followUp of ["resolves", "unresolved"]) {
    const label = followUp;
    const observed = await observeStage({ hideRunTarget: true }, () =>
      ask({
        proposal: createDocumentLoopProposal,
        question: DOCUMENT_LOOP_QUESTION,
        ragOptions: { followUp, primary: "unsupported" },
        withCapability: false,
      })
    );
    const context = observed.value;

    assert.equal(context.error, null, `${label}: ${context.error?.message}`);
    assert.deepEqual(context.ragService.calls.map((call) => call.phase), ["primary", "follow_up"], label);
    assertThreads(context, label);
    assertStageEntries(observed, { boundToRun: false, executorCalls: 1 }, label);
    assert.equal(await rawRecord(context.store, context.runId), null, label);
    const outcome = await describeOutcome(context);

    assertMatchesNativeGolden(`document-loop-${followUp}`, outcome);
    assert.equal(outcome.checkpoint.phase, "completed", label);
  }
});

test("without a run target, an approval-gated Capability pauses through the stage's own pause, and the approval continues as a fresh invocation, exactly as natively", async () => {
  const asked = await observeStage({ hideRunTarget: true }, () => ask());
  const context = asked.value;

  assert.equal(context.error, null, context.error?.message);
  assert.equal(context.response.body.clarification.reason, "capability_approval_required");
  assert.equal(context.writes.length, 0);
  assertStageEntries(asked, { boundToRun: false, executorCalls: 1 }, "pause");
  // No checkpointer, so no thread holds the pause: the gate and the paused
  // checkpoint are the stage's pauseForApproval CAS, as natively.
  assert.equal(await rawRecord(context.store, context.runId), null);
  const paused = await describeOutcome(context);

  const service = newService(context.store);
  const decided = await observeStage({ hideRunTarget: true }, () =>
    decide({ action: "approve", context, service })
  );

  assert.equal(decided.value.run.status, "completed");
  assert.equal(context.writes.length, 1);
  assert.equal(context.ragService.calls.length, 1);
  assertStageEntries(decided, { boundToRun: false, executorCalls: 1 }, "approve");
  assertThreads(context, "approve");
  assert.equal(await rawRecord(context.store, context.runId), null);
  const outcome = {
    approved: await describeOutcome(context, { agentRunService: service, response: null }),
    decision: mask({ response: decided.value.response, status: decided.value.status }),
    paused,
  };

  assertMatchesNativeGolden("approval-approve", outcome);
  assert.equal(outcome.paused.checkpoint.phase, "awaiting_approval");
  assert.deepEqual(
    outcome.approved.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map(({ nodeId, status }) => [nodeId, status]),
    [["document", "reused"], ["evidence_check", "reused"], ["task", "completed"]]
  );
});

test("without a run target, a denied gate settles the parked node as approval_denied, exactly as natively", async () => {
  const { value: context } = await observeStage({ hideRunTarget: true }, () => ask());
  const service = newService(context.store);
  const decided = await observeStage({ hideRunTarget: true }, () =>
    decide({ action: "deny", context, service })
  );

  assert.equal(decided.value.run.status, "completed");
  assert.equal(context.writes.length, 0);
  // Nothing is left to run once the denied node is settled: the executor
  // returns before a LangGraph invocation (natively the loop ran no pass).
  assertStageEntries(decided, { boundToRun: false, executorCalls: 1 }, "deny");
  const outcome = {
    decision: mask({ response: decided.value.response, status: decided.value.status }),
    denied: await describeOutcome(context, { agentRunService: service, response: null }),
  };

  assertMatchesNativeGolden("approval-deny", outcome);
  assert.deepEqual(
    outcome.denied.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
    [["document", "reused", null], ["evidence_check", "reused", null], ["task", "skipped", "approval_denied"]]
  );
});

// ---------------------------------------------------------------------------
// Finalization replay, with and without a run target
// ---------------------------------------------------------------------------

test("a finalization replay reaches no scheduler, with or without a run target", async () => {
  for (const hideRunTarget of [false, true]) {
    const label = hideRunTarget ? "no run target" : "run target";
    const store = newStore();
    const { service: crashing } = createCrashingRunService(newService(store), {
      crashBefore: (method, args) =>
        method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
    });
    const asked = await observeStage({ hideRunTarget }, () =>
      ask({
        agentRunService: crashing,
        proposal: createDocumentLoopProposal,
        question: DOCUMENT_LOOP_QUESTION,
        store,
        withCapability: false,
      })
    );
    const context = asked.value;

    assert.equal(context.error?.code, "SIMULATED_PROCESS_EXIT", label);
    assertStageEntries(asked, { boundToRun: !hideRunTarget, executorCalls: 1 }, `ask/${label}`);
    const calls = context.ragService.calls.length;
    const service = newService(store);
    const recovered = await observeStage({ hideRunTarget }, () =>
      recover({ context, service })
    );

    assert.equal(recovered.value.autoRecoveredCount, 1, `${label}: ${JSON.stringify(recovered.value)}`);
    assertStageEntries(
      recovered,
      { boundToRun: !hideRunTarget, executorCalls: 0, replays: 1 },
      `replay/${label}`
    );
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
    assertMatchesNativeGolden(
      `finalization-replay-${hideRunTarget ? "no-run-target" : "run-target"}`,
      await describeOutcome({ ...context, error: null }, { agentRunService: service, response: null })
    );
  }
});
