import "./langgraph-spike/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import http, { request as namedHttpRequest } from "node:http";
import https, { request as namedHttpsRequest } from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  Send,
  StateGraph,
} from "@langchain/langgraph";

import { emitAgentEvent, hasAgentEventSink, runWithAgentEventSink } from "../rag/agent-event-stream.js";
import {
  buildExecutionGraphNodeStepId,
  digestExecutionGraphTypedOutput,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { projectUnifiedGraphRun } from "../rag/agent-unified-graph-projection.js";
import { collectUnifiedGraphResults } from "../rag/agent-unified-graph-results.js";
import { buildCapabilityArtifactIdempotencyKey } from "../rag/capabilities/artifacts.js";
import {
  getActiveDatabaseTenant,
  runWithDatabaseTenant,
  toDatabaseTenant,
} from "../rag/postgres-tenant.js";
import {
  createRequestCancellation,
  getRequestDeadline,
  getRequestSignal,
  isRequestCancelledError,
  runWithRequestCancellation,
} from "../rag/request-deadline.js";
import { createRunUsage, getActiveRunUsage, runWithRunUsage } from "../rag/run-usage.js";
import { runExecutionGraphOnLangGraph } from "./langgraph-spike/execution-graph-langgraph-runner.mjs";
import {
  LANGGRAPH_CHECKPOINTED_EVENT,
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  RunStoreCheckpointSaver,
} from "./langgraph-spike/run-store-checkpoint-saver.mjs";
import {
  ACCESS_SCOPE,
  DOCUMENT_ANSWER,
  DOC_ID,
  EFFECT_PUBLIC_GATE,
  EFFECT_SKILL_ID,
  EFFECT_TEXT,
  INSUFFICIENT_ANSWER,
  PRIVATE_TEXTS,
  QUESTION,
  RISK_EXCERPT,
  RISK_PROMPT_PATTERN,
  RISK_TEXT,
  RUN_ID,
  SESSION_ID,
  claimGraphResume,
  createEffectApproval as createVendorEffectApproval,
  createEffectHarness,
  createEffectLedger as createVendorEffectLedger,
  createVendorHarness,
  maskTimingFields,
  runLangGraphStage,
  runNativeStage,
  serializeMemorySaver,
  withVendorCaseEnvironment,
} from "./langgraph-spike/vendor-case.mjs";

// Phase-0 LangGraph spike, not the production path. The runtime semantics the
// migration depends on, proven with agent A's run-store checkpointer (the
// LangGraph thread lives at run.result.__langGraphCheckpoint of the agent run
// it executes) driving agent B's runner on the vendor case's graph:
//
//   (1) every app AsyncLocalStorage the request binds reaches every node, every
//       Send branch and every store call the saver makes, per invocation and
//       per tenant, and a resume sees the stack bound around the resume;
//   (2) an approval interrupt runs the gated effect exactly once, from another
//       process, and never on a client-supplied resume value alone;
//   (3) request cancellation stops the graph at a node boundary and the
//       resume never executes the in-flight node again;
//   (4) the case graph end to end on the run-store saver equals the native
//       stage and the MemorySaver run, and what LangGraph persisted holds ids,
//       statuses and digests only, with no network call made.
//
// A "new process" is a new run service, harness, saver and compiled graph on
// the same agent run store. Every wait is a deferred promise or a barrier.

const stepIdOf = (nodeId) => buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId });
const statusesOf = (outcome) =>
  outcome.run.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]);
const FAR_DEADLINE_MS = 10 * 60 * 1000;

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

// Every arrival waits until `count` have arrived, so the arrivals provably
// overlapped, with no timing assumption.
const createArrivalBarrier = (count) => {
  const everyone = createDeferred();
  let arrived = 0;

  return {
    arrive() {
      arrived += 1;
      if (arrived === count) {
        everyone.resolve();
      }
      return everyone.promise;
    },
    get arrived() {
      return arrived;
    },
  };
};

// One turn of the event loop after every pending microtask: enough for
// promise chains that touch no timer or I/O (the in-memory run store is
// synchronous) to settle. Not a clock.
const flushEventLoop = async (turns = 3) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// --- The app ALS stack -------------------------------------------------------

// The four stores a /chat or approval request binds before the agent runs
// (routes/chat.js runAgentRequestWithCancellation + runWithAgentEventSink,
// agent.js runWithRunUsage, auth.js bindDatabaseTenant), each with an
// identity a test can tell apart from every other request's.
const createAlsStack = ({ accessScope = ACCESS_SCOPE, label }) => {
  const sinkEvents = [];
  const stack = {
    accessScope,
    cancellation: createRequestCancellation({ deadlineAt: Date.now() + FAR_DEADLINE_MS }),
    label,
    sink: (event) => sinkEvents.push(event),
    sinkEvents,
    tenant: toDatabaseTenant(accessScope),
    usage: createRunUsage(),
  };

  stack.run = (callback) =>
    runWithDatabaseTenant(accessScope, () =>
      runWithRunUsage(stack.usage, () =>
        runWithRequestCancellation(stack.cancellation, () =>
          runWithAgentEventSink(stack.sink, callback)
        )
      )
    );

  return stack;
};

let probeSequence = 0;

// What the code at `where` sees. The probe event goes to whichever sink is
// bound there, so sink identity is checked by where the event lands, not only
// by "some sink exists".
const observeAls = (where) => {
  probeSequence += 1;
  const probeId = `probe-${probeSequence}`;
  emitAgentEvent({ probeId, type: "spike_als_probe", where });

  return {
    deadlineAt: getRequestDeadline(),
    hasSink: hasAgentEventSink(),
    probeId,
    signal: getRequestSignal(),
    tenant: getActiveDatabaseTenant(),
    usage: getActiveRunUsage(),
    where,
  };
};

const assertSeesStack = (observation, stack, others = []) => {
  const where = `${observation.where} under ${stack.label}`;

  assert.deepStrictEqual(observation.tenant, stack.tenant, `tenant at ${where}`);
  assert.equal(observation.usage, stack.usage, `run usage at ${where}`);
  assert.equal(observation.signal, stack.cancellation.signal, `request signal at ${where}`);
  assert.equal(observation.deadlineAt, stack.cancellation.store.deadlineAt, `deadline at ${where}`);
  assert.equal(observation.hasSink, true, `event sink at ${where}`);
  assert.ok(
    stack.sinkEvents.some((event) => event.probeId === observation.probeId),
    `the probe at ${where} reached its own sink`
  );
  for (const other of others) {
    assert.equal(
      other.sinkEvents.some((event) => event.probeId === observation.probeId),
      false,
      `the probe at ${where} leaked into ${other.label}'s sink`
    );
  }
};

// --- Run-store worlds ----------------------------------------------------------

// A RunStoreCheckpointSaver that counts what LangGraph asked of it.
class CountingRunStoreSaver extends RunStoreCheckpointSaver {
  calls = { getTuple: 0, put: 0, putWrites: 0 };

  async getTuple(config) {
    this.calls.getTuple += 1;
    return super.getTuple(config);
  }

  async put(...args) {
    this.calls.put += 1;
    return super.put(...args);
  }

  async putWrites(...args) {
    this.calls.putWrites += 1;
    return super.putWrites(...args);
  }
}

const createSaver = (
  agentRunStore,
  { accessScope = ACCESS_SCOPE, claimId = null, onStoreCall = null, runId = RUN_ID } = {}
) => new CountingRunStoreSaver({ accessScope, agentRunStore, claimId, onStoreCall, runId });

// The vendor case's harness on a run store the test holds, so a saver can be
// bound to the same row the run service writes.
const createRunStoreWorld = ({ agentRunStore = createInMemoryAgentRunStore(), ...options } = {}) => {
  const agentRunService = createAgentRunService({ agentRunStore });
  const harness = createVendorHarness({ agentRunService, ...options });
  return { agentRunService, agentRunStore, harness };
};

// Another process on the same run store: new service, harness, budget,
// tracker and mocks.
const resumeWorld = (world, options = {}) =>
  createRunStoreWorld({ agentRunStore: world.agentRunStore, createRun: false, ...options });

const readRun = (agentRunStore) => agentRunStore.get({ accessScope: ACCESS_SCOPE, runId: RUN_ID });
const readLangGraphRecord = (agentRunStore, { accessScope = ACCESS_SCOPE, runId = RUN_ID } = {}) =>
  agentRunStore.get({ accessScope, runId })?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY] ?? null;

// Everything a reader of the record could recover: the record itself plus
// every serde value decoded (bytes values are base64 in the record).
const recordText = (record) => {
  const typedValues = (record?.namespaces ?? []).flatMap((namespace) => [
    ...namespace.checkpoints.flatMap((entry) => [entry.checkpoint, entry.metadata]),
    ...namespace.writes.map((write) => write.value),
  ]);
  const decoded = typedValues.map((typed) =>
    typed.t === "bytes" ? Buffer.from(typed.d, "base64").toString("utf8") : typed.d
  );

  return [JSON.stringify(record), ...decoded].join("\n");
};

const FORBIDDEN_TEXTS = [
  ...PRIVATE_TEXTS,
  DOCUMENT_ANSWER,
  INSUFFICIENT_ANSWER,
  RISK_EXCERPT,
  RISK_TEXT,
  "Upstream findings",
  "risk review",
];

const assertNoPrivateText = (text, extra = []) => {
  for (const forbidden of [...FORBIDDEN_TEXTS, ...extra]) {
    assert.equal(text.includes(forbidden), false, `LangGraph persisted private text: ${forbidden}`);
  }
  assert.equal(RISK_PROMPT_PATTERN.test(text), false, "LangGraph persisted the risk prompt");
};

const stepStartsOf = (run, nodeId) =>
  run.events.filter(
    (event) => event.type === "step_started" && event.payload?.stepId === stepIdOf(nodeId)
  ).length;

// The run's own event log without the saver's one-per-checkpoint events, so
// it compares with a run whose LangGraph thread lived elsewhere.
const withoutLangGraphEvents = (events) =>
  events
    .filter((event) => event.type !== LANGGRAPH_CHECKPOINTED_EVENT)
    .map(({ payload, type }) => ({ payload, type }));

// --- (1) Context propagation -----------------------------------------------------

test("(1) the request's tenant, run usage, deadline signal and event sink reach every node of the case graph, every Skill, every model call and every store call of the saver", async () => {
  // Not vacuous: outside a request nothing is bound.
  const outside = observeAls("outside");
  assert.deepStrictEqual(
    [outside.tenant, outside.usage, outside.signal, outside.deadlineAt, outside.hasSink],
    [null, null, null, null, false]
  );

  for (const documentSufficient of [true, false]) {
    const stack = createAlsStack({ label: `case-${documentSufficient}` });
    const observations = { chat: [], execute: [], node: [], store: [] };
    const world = createRunStoreWorld({
      beforeExecute: ({ skillId }) => {
        observations.execute.push(observeAls(`execute:${skillId}`));
      },
      documentSufficient,
      onChat: ({ kind }) => {
        observations.chat.push(observeAls(`chat:${kind}`));
      },
    });
    const saver = createSaver(world.agentRunStore, {
      onStoreCall: ({ method, operation }) => {
        observations.store.push(observeAls(`store:${operation}:${method}`));
      },
    });

    try {
      const outcome = await withVendorCaseEnvironment(() =>
        stack.run(() =>
          runLangGraphStage({
            checkpointer: saver,
            harness: world.harness,
            onNodeEvent: (event) => {
              observations.node.push(observeAls(`node:${event.nodeId}:${event.phase}`));
            },
            threadId: saver.threadId,
          })
        )
      );

      assert.equal(outcome.error, null, outcome.error?.stack);
      assert.deepStrictEqual(
        observations.node.map((observation) => observation.where),
        documentSufficient
          ? [
              "node:document:start",
              "node:document:settle",
              "node:evidence_check:start",
              "node:evidence_check:settle",
              "node:risk:start",
              "node:risk:settle",
            ]
          : [
              "node:document:start",
              "node:document:settle",
              "node:evidence_check:start",
              "node:evidence_check:settle",
              "node:risk:skip",
            ]
      );
      assert.equal(observations.execute.length, documentSufficient ? 3 : 2);
      assert.equal(observations.chat.length, documentSufficient ? 2 : 1);
      // Every LangGraph checkpoint and pending write went through the run
      // store: reads, the CAS writes and nothing else.
      assert.ok(saver.calls.put > 0 && saver.calls.putWrites > 0);
      assert.deepStrictEqual(
        [...new Set(observations.store.map((observation) => observation.where.split(":")[2]))].sort(),
        ["get", "update", "updateWithEvent"]
      );

      for (const observation of Object.values(observations).flat()) {
        assertSeesStack(observation, stack);
      }
    } finally {
      stack.cancellation.dispose();
    }
  }
});

const FanOutState = Annotation.Root({
  docIds: Annotation({ default: () => [], reducer: (left, right) => left.concat(right) }),
  done: Annotation({ default: () => [], reducer: (left, right) => left.concat(right) }),
});

// One Send per document. State and Send arguments carry document ids only.
const buildDocumentFanOutGraph = ({ barrier, checkpointer, docIds, observe }) =>
  new StateGraph(FanOutState)
    .addNode("plan", () => {
      observe("plan");
      return { docIds };
    })
    .addNode("branch", async ({ docId }) => {
      observe(`branch:${docId}`);
      // Released by whichever branch arrives last, possibly another tenant's:
      // the continuation must still run in this branch's own context.
      await barrier.arrive();
      observe(`branch-after-barrier:${docId}`);
      return { done: [docId] };
    })
    .addNode("join", (state) => {
      observe(`join:${[...state.done].sort().join(",")}`);
      return {};
    })
    .addEdge(START, "plan")
    .addConditionalEdges(
      "plan",
      (state) => state.docIds.map((docId) => new Send("branch", { docId })),
      ["branch"]
    )
    .addEdge("branch", "join")
    .addEdge("join", END)
    .compile({ checkpointer });

test("(1) two tenants' overlapping Send fan-outs on one run store each see only their own stack, in every branch and every saver call", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore });
  const tenants = [
    { accessScope: { userId: "spike-alice", workspaceId: "spike-workspace" }, label: "alice", prefix: "a" },
    { accessScope: { userId: "spike-bob", workspaceId: "spike-workspace" }, label: "bob", prefix: "b" },
  ];
  // Both runs use the same run id: only the tenant tells them apart.
  const runId = "langgraph-spike-fan-out-run";
  const barrier = createArrivalBarrier(6);

  const runs = await Promise.all(
    tenants.map(async (tenant) => {
      await agentRunService.createRun({
        accessScope: tenant.accessScope,
        goal: "fan out",
        input: { docIds: [], sessionId: SESSION_ID, userId: tenant.accessScope.userId },
        plan: { mode: "document_qa" },
        runId,
      });
      const stack = createAlsStack({ accessScope: tenant.accessScope, label: tenant.label });
      const observations = [];
      const saver = createSaver(agentRunStore, {
        accessScope: tenant.accessScope,
        onStoreCall: ({ method, operation }) => observations.push(observeAls(`store:${operation}:${method}`)),
        runId,
      });
      const docIds = [1, 2, 3].map((index) => `${tenant.prefix}-doc-${index}`);
      const app = buildDocumentFanOutGraph({
        barrier,
        checkpointer: saver,
        docIds,
        observe: (where) => observations.push(observeAls(where)),
      });

      return { app, docIds, observations, saver, stack, tenant };
    })
  );

  try {
    const outputs = await Promise.all(
      runs.map(({ app, saver, stack }) =>
        stack.run(() =>
          app.invoke(
            { docIds: [] },
            { configurable: { thread_id: saver.threadId }, durability: "sync" }
          )
        )
      )
    );

    // All six branches, three per tenant, were in flight at once.
    assert.equal(barrier.arrived, 6);
    assert.notEqual(runs[0].saver.threadId, runs[1].saver.threadId);

    for (const [index, { docIds, observations, saver, stack }] of runs.entries()) {
      const other = runs[1 - index];
      const wheres = observations.map((observation) => observation.where);

      assert.deepStrictEqual([...outputs[index].done].sort(), docIds);
      for (const docId of docIds) {
        assert.ok(wheres.includes(`branch:${docId}`));
        assert.ok(wheres.includes(`branch-after-barrier:${docId}`));
      }
      assert.ok(wheres.includes("plan"));
      assert.ok(wheres.includes(`join:${docIds.join(",")}`));
      assert.ok(wheres.some((where) => where.startsWith("store:putWrites:")));
      assert.ok(saver.calls.putWrites >= 4);

      for (const observation of observations) {
        assertSeesStack(observation, stack, [other.stack]);
      }

      // The other tenant's documents never reached this thread's record.
      const record = readLangGraphRecord(agentRunStore, { accessScope: stack.accessScope, runId });
      const text = recordText(record);
      for (const docId of docIds) {
        assert.ok(text.includes(docId));
      }
      for (const docId of other.docIds) {
        assert.equal(text.includes(docId), false, `${stack.label}'s record names ${docId}`);
      }
    }
  } finally {
    for (const { stack } of runs) {
      stack.cancellation.dispose();
    }
  }
});

// --- An approval-gated Capability behind the document node -------------------

const EXPECTED_EFFECT_KEY = buildCapabilityArtifactIdempotencyKey({
  parts: [RUN_ID, "effect", EFFECT_SKILL_ID],
});
// The gate the effect node shows: the double's public payload bound to the
// node and to a digest of its exact bound input (the request's question).
const EFFECT_GATE = Object.freeze({
  ...EFFECT_PUBLIC_GATE,
  inputDigest: digestExecutionGraphTypedOutput({ boundInputs: { question: QUESTION } }),
  nodeId: "effect",
});
// What an approval endpoint stores for that gate.
const decisionOn = (decision, gate = EFFECT_GATE) => ({ decision, gate: { ...gate } });
const CLIENT_RESUME_NOTE = "client-supplied-resume-value";

const createEffectLedger = () => createVendorEffectLedger({ onExecute: () => observeAls("effect:execute") });

// The world for the effect graph on a run store the test holds (vendor-case
// createEffectHarness: the live catalog plus the test Capability and the
// workspace-action intent, with the run created in that intent's mode).
const createEffectWorld = ({
  ledger,
  agentRunStore = createInMemoryAgentRunStore(),
  createRun = true,
  onChat = null,
  beforeExecute = null,
}) => {
  const agentRunService = createAgentRunService({ agentRunStore });
  const harness = createEffectHarness({ agentRunService, beforeExecute, createRun, ledger, onChat });
  return { agentRunService, agentRunStore, harness };
};

const createEffectApproval = (decisions) => createVendorEffectApproval(decisions, { observe: observeAls });

const runEffectStage = (world, { saver, ...options }) =>
  withVendorCaseEnvironment(() =>
    runLangGraphStage({
      checkpointer: saver,
      harness: world.harness,
      threadId: saver.threadId,
      ...options,
    })
  );

const preflightsOf = (log, nodeId) => log.preflights.filter((entry) => entry.nodeId === nodeId).length;
const readsOf = (log, nodeId) => log.reads.filter((entry) => entry.nodeId === nodeId).length;

// The first request: the document node runs, the effect node parks at its
// interrupt with nothing effectful done.
const pauseAtEffect = async ({ decisions, ledger, chatCounter, stack = null }) => {
  const world = createEffectWorld({
    ledger,
    onChat: () => {
      chatCounter.count += 1;
    },
  });
  const saver = createSaver(world.agentRunStore, {
    onStoreCall: stack
      ? ({ method, operation }) => stack.storeObservations.push(observeAls(`store:${operation}:${method}`))
      : null,
  });
  const { approval, log } = createEffectApproval(decisions);
  const nodeEvents = [];
  const invoke = () =>
    runEffectStage(world, {
      approval,
      onNodeEvent: (event) => nodeEvents.push(`${event.nodeId}:${event.phase}`),
      saver,
    });
  const paused = await (stack ? stack.run(invoke) : invoke());

  assert.equal(paused.error, null, paused.error?.stack);
  assert.deepStrictEqual(paused.interrupted, { nodeId: "effect", payload: { ...EFFECT_GATE } });
  assert.equal(paused.run.status, "awaiting_approval");
  assert.deepStrictEqual(statusesOf(paused), [
    ["document", "completed", null],
    ["effect", "awaiting_approval", null],
  ]);
  // interrupt() was the first effectful thing the gated node did: no effect,
  // no step, no budget, and its decision was never read.
  assert.equal(ledger.calls, 0);
  assert.equal(paused.steps.some((step) => step.id === stepIdOf("effect")), false);
  assert.equal(paused.budget.customSkillCalls, 0);
  assert.equal(paused.budget.documentRagCalls, 1);
  assert.equal(readsOf(log, "effect"), 0);
  assert.equal(preflightsOf(log, "effect"), 1);
  assert.equal(chatCounter.count, 1);
  assert.deepStrictEqual(nodeEvents, ["document:start", "document:settle", "effect:start"]);
  assert.equal(paused.checkpoint.phase, "running");

  // The pause is durable in the run row, as ids only.
  const record = readLangGraphRecord(world.agentRunStore);
  const text = recordText(record);
  assert.ok(text.includes("__interrupt__"));
  assert.ok(text.includes(EFFECT_GATE.gateId));
  assertNoPrivateText(text, [EFFECT_TEXT]);

  return { log, paused, saver, world };
};

// The second request, in another process: a new run service, harness,
// saver instance and compiled graph on the same run store. It continues the
// graph under a resume claim, its own unless the test hands one in (the same
// worker retrying), and its saver writes under that claim.
const resumeEffect = async ({ claimId = undefined, decisions, ledger, chatCounter, paused, resumeCommand, stack = null }) => {
  const world = createEffectWorld({
    agentRunStore: paused.world.agentRunStore,
    createRun: false,
    ledger,
    onChat: () => {
      chatCounter.count += 1;
    },
  });
  const graphResumeClaimId = claimId === undefined
    ? await claimGraphResume(world.agentRunService)
    : claimId;
  const saver = createSaver(world.agentRunStore, {
    claimId: graphResumeClaimId,
    onStoreCall: stack
      ? ({ method, operation }) => stack.storeObservations.push(observeAls(`store:${operation}:${method}`))
      : null,
  });
  const { approval, log } = createEffectApproval(decisions);
  const nodeEvents = [];
  const invoke = () =>
    runEffectStage(world, {
      approval,
      graphResumeClaimId,
      onNodeEvent: (event) => nodeEvents.push({ event, observation: observeAls(`node:${event.nodeId}:${event.phase}`) }),
      resumeCommand,
      saver,
    });
  const outcome = await (stack ? stack.run(invoke) : invoke());

  return { claimId: graphResumeClaimId, log, nodeEvents, outcome, saver, world };
};

test("(2) approval: an approved resume from another process runs the gated effect exactly once, keyed per run and node, and nothing upstream again", async () => {
  const decisions = new Map();
  const ledger = createEffectLedger();
  const chatCounter = { count: 0 };
  const paused = await pauseAtEffect({ chatCounter, decisions, ledger });

  // The user's decision lands in the caller's store between the requests,
  // on the gate the paused run showed.
  decisions.set("effect", decisionOn("approved", paused.paused.interrupted.payload));
  const approved = await resumeEffect({
    chatCounter,
    decisions,
    ledger,
    paused,
    // What an approval endpoint would hand in. It asks for the continuation;
    // its value is never persisted and decides nothing.
    resumeCommand: new Command({ resume: { approved: true, clientNote: CLIENT_RESUME_NOTE } }),
  });

  assert.equal(approved.outcome.error, null, approved.outcome.error?.stack);
  assert.equal(approved.outcome.interrupted, null);
  assert.deepStrictEqual(statusesOf(approved.outcome), [
    ["document", "reused", null],
    ["effect", "completed", null],
  ]);
  // Exactly one effect, under the stage's deterministic run+node+Skill key.
  assert.equal(ledger.calls, 1);
  assert.deepStrictEqual([...ledger.byKey], [[EXPECTED_EFFECT_KEY, 1]]);
  assert.equal(
    EXPECTED_EFFECT_KEY,
    `capability-artifact:${RUN_ID}:effect:${EFFECT_SKILL_ID}`
  );
  // Charged once (the resumed process restored the document call from the
  // checkpoint and reserved one Capability call), started once.
  assert.equal(approved.outcome.budget.customSkillCalls, 1);
  assert.equal(approved.outcome.budget.documentRagCalls, 1);
  const run = readRun(approved.world.agentRunStore);
  assert.equal(stepStartsOf(run, "effect"), 1);
  assert.equal(stepStartsOf(run, "document"), 1);
  assert.deepStrictEqual(
    approved.outcome.steps.map(({ attempt, id, status }) => [id, status, attempt]),
    [
      [stepIdOf("document"), "completed", 1],
      [stepIdOf("effect"), "completed", 1],
    ]
  );
  // The document node was not executed again: no model call in the resume.
  assert.equal(chatCounter.count, 1);
  assert.equal(approved.outcome.chatCalls.length, 0);
  assert.equal(approved.outcome.checkpoint.phase, "completed");
  assert.ok(approved.outcome.collected);

  // The native danger the wrapper absorbs: LangGraph re-ran the gated node
  // from its first line, so the code before interrupt() (here the read-only
  // preflight) ran twice across the two requests while the effect ran once.
  assert.equal(preflightsOf(paused.log, "effect") + preflightsOf(approved.log, "effect"), 2);
  assert.equal(readsOf(approved.log, "effect"), 1);
  // Only the parked node's decision was read, with everything a production
  // reader binds it to: the gate shown, the input bound now, the latest
  // acknowledged graph checkpoint, and this worker's claim.
  assert.deepStrictEqual(approved.log.reads.map(({ nodeId }) => nodeId), ["effect"]);
  const [{ request }] = approved.log.reads;
  assert.deepStrictEqual(request.gate, EFFECT_GATE);
  assert.deepStrictEqual(request.boundInputs, { question: QUESTION });
  assert.equal(request.graphResumeClaimId, approved.claimId);
  assert.match(approved.claimId, /^[0-9a-f-]{36}$/);
  // The checkpoint as this worker's claim left it: one revision past the
  // pause.
  assert.equal(request.checkpoint.sequence, paused.paused.checkpoint.sequence + 1);
  assert.equal(typeof request.checkpoint.digest, "string");
  assert.notEqual(request.checkpoint.digest, paused.paused.checkpoint.digest);
  // LangGraph re-ran only the interrupted task; the document node's function
  // was not even entered (its status reads "reused" from the v2 checkpoint).
  assert.deepStrictEqual(
    approved.nodeEvents.map(({ event }) => `${event.nodeId}:${event.phase}:${event.status}`),
    ["effect:start:running", "effect:settle:completed"]
  );

  // LangGraph persisted a resume, but only the runner's marker: the client's
  // value never reached the run row. Nothing private was persisted either.
  const text = recordText(readLangGraphRecord(approved.world.agentRunStore));
  assert.ok(text.includes("__resume__"));
  assert.ok(text.includes("approvalDecisionReady"));
  assert.equal(text.includes(CLIENT_RESUME_NOTE), false);
  assertNoPrivateText(text, [EFFECT_TEXT]);

  // A second resume after completion executes nothing and fails closed:
  // the graph is already claimed and no longer running, whether the next
  // worker presents no claim or the finished worker's own.
  for (const [claimId, resumeCommand] of [
    [undefined, null],
    [approved.claimId, null],
    [approved.claimId, new Command({ resume: { approved: true } })],
  ]) {
    const again = await resumeEffect({ chatCounter, claimId, decisions, ledger, paused, resumeCommand });
    assert.equal(again.outcome.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    assert.equal(again.log.preflights.length, 0);
    assert.equal(again.log.reads.length, 0);
    assert.equal(again.nodeEvents.length, 0);
  }
  assert.equal(ledger.calls, 1);
  assert.equal(chatCounter.count, 1);
  assert.equal(stepStartsOf(readRun(approved.world.agentRunStore), "effect"), 1);
});

test("(2) approval: a client resume value with no stored decision executes nothing and fails closed; a Command that writes state is refused before any write", async () => {
  const decisions = new Map();
  const ledger = createEffectLedger();
  const chatCounter = { count: 0 };
  const paused = await pauseAtEffect({ chatCounter, decisions, ledger });
  const before = readRun(paused.world.agentRunStore);

  // A Command that would write a receipt, or route a task, never reaches
  // LangGraph.
  for (const forged of [
    new Command({ resume: { approved: true }, update: { receipts: { effect: { outputDigest: null, reason: "approval_denied", status: "skipped" } } } }),
    new Command({ goto: "effect", resume: { approved: true } }),
    new Command({ resume: { approved: { nested: true } } }),
  ]) {
    // claimId null: the shape is refused before the claim is even checked,
    // so this attempt takes no claim (a claim is a write).
    const refused = await resumeEffect({ chatCounter, claimId: null, decisions, ledger, paused, resumeCommand: forged });
    assert.equal(refused.outcome.error?.code, "AGENT_LANGGRAPH_RESUME_COMMAND_INVALID");
    assert.equal(refused.log.preflights.length, 0);
  }
  assert.deepStrictEqual(readRun(paused.world.agentRunStore).revision, before.revision);

  // The forged resume: { approved: true } and nothing in the store.
  const forged = await resumeEffect({
    chatCounter,
    decisions,
    ledger,
    paused,
    resumeCommand: new Command({ resume: { approved: true } }),
  });

  assert.equal(forged.outcome.error?.code, "graph_approval_missing");
  assert.equal(ledger.calls, 0);
  assert.equal(forged.outcome.steps.some((step) => step.id === stepIdOf("effect")), false);
  assert.equal(forged.outcome.budget.customSkillCalls, 0);
  assert.equal(forged.outcome.checkpoint.phase, "running");
  assert.equal(chatCounter.count, 1);
  // LangGraph holds the sanitized stop only, never the refusal text.
  const text = recordText(readLangGraphRecord(paused.world.agentRunStore));
  assert.match(text, /Graph node effect stopped \(graph_approval_missing\)/);
  assert.equal(text.includes("resumed without a recorded approval decision"), false);

  // Pinned: a real decision recorded afterwards still continues the same
  // graph, under the same worker's claim (a claimed graph cannot be claimed
  // again), and the effect still runs exactly once.
  decisions.set("effect", decisionOn("approved", paused.paused.interrupted.payload));
  const approved = await resumeEffect({
    chatCounter,
    claimId: forged.claimId,
    decisions,
    ledger,
    paused,
    resumeCommand: null,
  });

  assert.equal(approved.outcome.error, null, approved.outcome.error?.stack);
  assert.deepStrictEqual(statusesOf(approved.outcome), [
    ["document", "reused", null],
    ["effect", "completed", null],
  ]);
  assert.deepStrictEqual([...ledger.byKey], [[EXPECTED_EFFECT_KEY, 1]]);
  assert.equal(stepStartsOf(readRun(paused.world.agentRunStore), "effect"), 1);
  assert.equal(chatCounter.count, 1);
});

test("(2) approval: a denial settles the Capability as approval_denied with zero effects, no step and no budget, and the graph completes", async () => {
  const decisions = new Map();
  const ledger = createEffectLedger();
  const chatCounter = { count: 0 };
  const paused = await pauseAtEffect({ chatCounter, decisions, ledger });

  decisions.set("effect", decisionOn("denied", paused.paused.interrupted.payload));
  const denied = await resumeEffect({
    chatCounter,
    decisions,
    ledger,
    paused,
    resumeCommand: new Command({ resume: { approved: false } }),
  });

  assert.equal(denied.outcome.error, null, denied.outcome.error?.stack);
  assert.deepStrictEqual(statusesOf(denied.outcome), [
    ["document", "reused", null],
    ["effect", "skipped", "approval_denied"],
  ]);
  assert.equal(ledger.calls, 0);
  assert.equal(denied.outcome.steps.some((step) => step.id === stepIdOf("effect")), false);
  assert.equal(denied.outcome.budget.customSkillCalls, 0);
  assert.equal(denied.outcome.checkpoint.phase, "completed");
  assert.ok(denied.outcome.collected);
  assert.equal(chatCounter.count, 1);
  // The denial was read first and settled the node before its live preflight
  // ran again: natively a denied gate is settled before scheduling, with no
  // preflight at all (agent-unified-graph-stage.js:367-368).
  assert.equal(readsOf(denied.log, "effect"), 1);
  assert.equal(preflightsOf(denied.log, "effect"), 0);
  assert.equal(preflightsOf(paused.log, "effect"), 1);
});

test("(1) a resume runs under the stack bound around the resume invoke, never the stack of the request that paused", async () => {
  const decisions = new Map();
  const ledger = createEffectLedger();
  const chatCounter = { count: 0 };
  const pausing = createAlsStack({ label: "pausing-request" });
  const resuming = createAlsStack({ label: "resuming-request" });
  pausing.storeObservations = [];
  resuming.storeObservations = [];

  try {
    const paused = await pauseAtEffect({ chatCounter, decisions, ledger, stack: pausing });

    assert.ok(pausing.storeObservations.length > 0);
    for (const observation of [
      ...paused.log.preflights.map((entry) => entry.observation),
      ...pausing.storeObservations,
    ]) {
      assertSeesStack(observation, pausing, [resuming]);
    }

    decisions.set("effect", decisionOn("approved", paused.paused.interrupted.payload));
    const approved = await resumeEffect({
      chatCounter,
      decisions,
      ledger,
      paused,
      resumeCommand: null,
      stack: resuming,
    });

    assert.equal(approved.outcome.error, null, approved.outcome.error?.stack);
    assert.equal(ledger.calls, 1);

    const resumedObservations = [
      ...approved.log.preflights.map((entry) => entry.observation),
      ...approved.log.reads.map((entry) => entry.observation),
      ...approved.nodeEvents.map((entry) => entry.observation),
      ...ledger.observations,
      ...resuming.storeObservations,
    ];

    assert.deepStrictEqual(
      [...new Set(resumedObservations.map((observation) => observation.where.split(":")[0]))].sort(),
      ["effect", "node", "preflight", "readDecision", "store"]
    );
    for (const observation of resumedObservations) {
      assertSeesStack(observation, resuming, [pausing]);
    }
    assert.ok(resuming.storeObservations.some((observation) => observation.where === "store:put:updateWithEvent"));
  } finally {
    pausing.cancellation.dispose();
    resuming.cancellation.dispose();
  }
});

// --- (3) Cancellation at a node boundary --------------------------------------

// The document node blocks inside its model call until the test lets it go.
const holdDocumentCall = () => {
  const entered = createDeferred();
  const release = createDeferred();

  return {
    entered: entered.promise,
    onChat: async ({ kind }) => {
      if (kind === "document") {
        entered.resolve();
        await release.promise;
      }
    },
    release: () => release.resolve(),
  };
};

// runLangGraphStage's arguments, passed straight to the runner so the test
// can attach to the runner's own promise and see the moment it rejects
// (runLangGraphStage catches into its outcome, a few ticks later). The run
// must already exist (await world.harness.ready first).
const startRunner = (world, options) => {
  const { harness } = world;

  return runExecutionGraphOnLangGraph({
    accessScope: ACCESS_SCOPE,
    addBudgetLimitTrace: harness.addBudgetLimitTrace,
    addTraceStep: harness.addTraceStep,
    agentRunId: RUN_ID,
    agentRunService: harness.agentRunService,
    authorizedDocIds: harness.docIds,
    budgetState: harness.budgetState,
    buildSkillTraceDetail: harness.tracker.buildSkillTraceDetail,
    capabilityRegistry: harness.capabilityRegistry,
    docIds: harness.docIds,
    executeObservedSkill: harness.executeObservedSkill,
    graph: harness.graph,
    plan: harness.plan,
    question: QUESTION,
    ragService: harness.ragService,
    recordSkillResult: harness.tracker.recordSkillResult,
    recordSkippedSkill: harness.recordSkippedSkill,
    registry: harness.catalog.graphRegistry,
    selectedSkills: harness.catalog.skills,
    sessionId: SESSION_ID,
    userId: ACCESS_SCOPE.userId,
    ...options,
  });
};

// The checkpoint a claimed continuation ends with, as if it had never been
// claimed: the claim adds resumeClaim and one checkpoint revision, nothing
// else.
const withoutClaimRevision = (checkpoint, claimId) => {
  assert.equal(checkpoint.resumeClaim?.claimId, claimId);
  const { resumeClaim: _claim, ...rest } = checkpoint;
  return { ...rest, sequence: checkpoint.sequence - 1 };
};

// The run's events without the claim: drops skill_graph_resume_claimed and
// takes its revision back off every graph checkpoint event after it.
const withoutResumeClaim = (events) => {
  const claimAt = events.findIndex((event) => event.type === "skill_graph_resume_claimed");
  assert.ok(claimAt >= 0, "the continuation was claimed");
  return events
    .filter((_, index) => index !== claimAt)
    .map((event, index) =>
      index >= claimAt && event.type === "skill_graph_checkpointed"
        ? { ...event, payload: { ...event.payload, sequence: event.payload.sequence - 1 } }
        : event
    );
};

// A resumed node reads as "reused" where an uninterrupted run reads
// "completed"; native recovery reports the same. Everything else must match.
const asUninterrupted = (value) =>
  JSON.parse(JSON.stringify(value), (key, item) =>
    key === "status" && item === "reused" ? "completed" : item
  );

const runUninterrupted = async () => {
  const world = createRunStoreWorld();
  const saver = createSaver(world.agentRunStore);
  const outcome = await withVendorCaseEnvironment(() =>
    runLangGraphStage({ checkpointer: saver, harness: world.harness, threadId: saver.threadId })
  );

  assert.equal(outcome.error, null, outcome.error?.stack);
  return { outcome, saver, world };
};

for (const { cancellation, code, reason } of [
  { cancellation: "drain", code: "AGENT_DEADLINE_EXCEEDED", reason: "deadline_exceeded" },
  { cancellation: "drain", code: "AGENT_CLIENT_CANCELLED", reason: "client_cancelled" },
  { cancellation: "signal", code: "AGENT_DEADLINE_EXCEEDED", reason: "deadline_exceeded" },
  { cancellation: "signal", code: "AGENT_CLIENT_CANCELLED", reason: "client_cancelled" },
]) {
  // The native stage would fail this run (failRun: deadline -> failed and
  // retryable, client gone -> canceled), and startup recovery never lists a
  // settled run. The runner leaves that to its caller, so the run is still
  // "running" here and the second request continues it: the continuation is
  // what a LangGraph runtime would make possible, and the property under test
  // is that it never executes the in-flight node a second time.
  test(`(3) ${cancellation}, ${reason}: the in-flight document node settles before the driver rejects, nothing after it starts, and the resume never executes it again`, async () => {
    const hold = holdDocumentCall();
    const world = createRunStoreWorld({ onChat: hold.onChat });
    const saver = createSaver(world.agentRunStore);
    const request = createAlsStack({ label: "cancelled-request" });
    const order = [];
    const entered = [];
    await world.harness.ready;

    const rejection = withVendorCaseEnvironment(() =>
      request.run(() =>
        startRunner(world, {
          cancellation,
          checkpointer: saver,
          onNodeEnter: ({ nodeId }) => entered.push(nodeId),
          onNodeEvent: (event) => order.push(`${event.nodeId}:${event.phase}`),
          threadId: saver.threadId,
        }).then(
          () => assert.fail("the cancelled run resolved"),
          (error) => {
            order.push("driver:rejected");
            // Read synchronously in the runner's own rejection handler (the
            // in-memory store is synchronous), so nothing settles in between.
            const run = readRun(world.agentRunStore);
            return { error, stepsAtRejection: run.steps.map(({ id, status }) => [id, status]) };
          }
        )
      )
    );

    await hold.entered;
    request.cancellation.cancel(reason);
    hold.release();
    const { error, stepsAtRejection } = await rejection;
    request.cancellation.dispose();

    assert.ok(isRequestCancelledError(error), error?.stack);
    assert.equal(error.code, code);
    assert.deepStrictEqual(stepsAtRejection, [[stepIdOf("document"), "completed"]]);
    // The started node finished first; evidence_check and risk never started.
    assert.deepStrictEqual(order, ["document:start", "document:settle", "driver:rejected"]);
    // Nor were they scheduled: under drain RunControl stopped LangGraph
    // between supersteps, under signal LangGraph rejected mid-superstep. (The
    // node safe points, a separate stop, are pinned in the mechanics suite.)
    assert.deepStrictEqual(entered, ["document"]);

    const stopped = readRun(world.agentRunStore);
    const v2 = (await world.agentRunService.getExecutionGraphCheckpoint({ accessScope: ACCESS_SCOPE, runId: RUN_ID })).checkpoint;
    assert.equal(v2.phase, "running");
    assert.deepStrictEqual(v2.nodeRuns.map(({ nodeId, status }) => [nodeId, status]), [["document", "completed"]]);
    assert.equal(world.harness.telemetry.chatCalls.length, 1);
    assert.equal(world.harness.budgetState.used.documentRagCalls, 1);

    // What LangGraph kept differs by mode. A drain checkpointed the finished
    // superstep: the document receipt is in the thread and LangGraph will
    // continue from evidence_check. An abort raced the superstep: the
    // document node's writes were discarded and LangGraph will run it again.
    const tuple = await createSaver(world.agentRunStore).getTuple({
      configurable: { checkpoint_ns: "", thread_id: saver.threadId },
    });
    const receipts = tuple.checkpoint.channel_values.receipts;
    if (cancellation === "drain") {
      assert.deepStrictEqual(Object.keys(receipts), ["document"]);
    } else {
      assert.deepStrictEqual(receipts, {});
    }
    assertNoPrivateText(recordText(stopped.result[LANGGRAPH_CHECKPOINT_RESULT_KEY]));

    // The backstop behind the v2 reuse: whatever LangGraph re-runs, the run
    // store refuses a second start of the document node's step
    // (agent-runs.js recordRunStep, `!existingStep`), and refusing writes
    // nothing.
    const documentStep = stopped.steps.find((step) => step.id === stepIdOf("document"));
    await assert.rejects(
      createAgentRunStepLifecycle({
        accessScope: ACCESS_SCOPE,
        agentRunService: world.agentRunService,
        runId: RUN_ID,
      }).startGraphStep({
        expectedResumeClaimId: null,
        id: documentStep.id,
        input: documentStep.input,
        label: documentStep.label,
        type: documentStep.type,
      }),
      (fenceError) => fenceError.code === "AGENT_GRAPH_EXECUTION_FENCED"
    );
    assert.equal(readRun(world.agentRunStore).revision, stopped.revision);

    // A new request whose deadline is far away, in another process. It
    // continues only under its own resume claim: an unclaimed continuation
    // is refused, as a recovery error the stage never hands to V1.
    const resumedWorld = resumeWorld(world);
    const unclaimed = await withVendorCaseEnvironment(() =>
      runLangGraphStage({
        cancellation,
        checkpointer: createSaver(resumedWorld.agentRunStore),
        harness: resumeWorld(world).harness,
        threadId: saver.threadId,
      })
    );
    assert.equal(unclaimed.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    assert.equal(unclaimed.error.preExecution, false);
    assert.equal(readRun(world.agentRunStore).revision, stopped.revision);

    const claimId = await claimGraphResume(resumedWorld.agentRunService);
    assert.ok(claimId);
    const resumedSaver = createSaver(resumedWorld.agentRunStore, { claimId });
    const resumedEvents = [];
    const resuming = createAlsStack({ label: "resuming-request" });
    const resumed = await withVendorCaseEnvironment(() =>
      resuming.run(() =>
        runLangGraphStage({
          cancellation,
          checkpointer: resumedSaver,
          graphResumeClaimId: claimId,
          harness: resumedWorld.harness,
          onNodeEvent: (event) => resumedEvents.push(`${event.nodeId}:${event.phase}:${event.status}`),
          threadId: resumedSaver.threadId,
        })
      )
    );
    resuming.cancellation.dispose();

    assert.equal(resumed.error, null, resumed.error?.stack);
    assert.deepStrictEqual(statusesOf(resumed), [
      ["document", "reused", null],
      ["evidence_check", "completed", null],
      ["risk", "completed", null],
    ]);
    if (cancellation === "drain") {
      // LangGraph itself continued from evidence_check.
      assert.deepStrictEqual(resumedEvents, [
        "evidence_check:start:running",
        "evidence_check:settle:completed",
        "risk:start:running",
        "risk:settle:completed",
      ]);
    } else {
      // LangGraph ran the document node again; the v2 checkpoint answered it
      // and nothing executed.
      assert.deepStrictEqual(resumedEvents, [
        "document:settle:reused",
        "evidence_check:start:running",
        "evidence_check:settle:completed",
        "risk:start:running",
        "risk:settle:completed",
      ]);
    }
    // At most once across both requests: one document model call, one start.
    assert.equal(resumed.chatCalls.length, 1);
    assert.match(resumed.chatCalls[0].question, RISK_PROMPT_PATTERN);
    const finalRun = readRun(world.agentRunStore);
    for (const nodeId of ["document", "evidence_check", "risk"]) {
      assert.equal(stepStartsOf(finalRun, nodeId), 1, `${nodeId} started once`);
    }

    // The interrupted-and-resumed run equals an uninterrupted one, except
    // for what the claim itself wrote: its resumeClaim, its own checkpoint
    // revision and its skill_graph_resume_claimed event.
    const uninterrupted = await runUninterrupted();
    assert.deepStrictEqual(
      asUninterrupted(maskTimingFields(resumed.run)),
      asUninterrupted(maskTimingFields(uninterrupted.outcome.run))
    );
    assert.deepStrictEqual(maskTimingFields(resumed.steps), maskTimingFields(uninterrupted.outcome.steps));
    assert.deepStrictEqual(resumed.budget, uninterrupted.outcome.budget);
    assert.deepStrictEqual(
      [...world.harness.telemetry.chatCalls, ...resumed.chatCalls],
      uninterrupted.outcome.chatCalls
    );
    assert.deepStrictEqual(
      maskTimingFields([...world.harness.trace, ...resumed.trace]),
      maskTimingFields(uninterrupted.outcome.trace)
    );
    assert.deepStrictEqual(
      asUninterrupted(maskTimingFields(withoutClaimRevision(resumed.checkpoint, claimId), ["digest"])),
      asUninterrupted(maskTimingFields(uninterrupted.outcome.checkpoint, ["digest"]))
    );
    assert.deepStrictEqual(
      asUninterrupted(maskTimingFields(resumed.collected)),
      asUninterrupted(maskTimingFields(uninterrupted.outcome.collected))
    );
    assert.deepStrictEqual(
      withoutResumeClaim(withoutLangGraphEvents(finalRun.events)),
      withoutLangGraphEvents(uninterrupted.outcome.events)
    );
  });
}

test("(3) pinned LangGraph behaviour on the run-store saver: an AbortSignal rejects invoke while the node is still running, discards its writes, and the resume runs it again", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore });
  const runId = "langgraph-spike-raw-abort-run";
  await agentRunService.createRun({
    accessScope: ACCESS_SCOPE,
    goal: "raw abort",
    input: { docIds: [DOC_ID], sessionId: SESSION_ID, userId: ACCESS_SCOPE.userId },
    plan: { mode: "document_qa" },
    runId,
  });
  const storeOperations = [];
  const saver = createSaver(agentRunStore, {
    onStoreCall: ({ method, operation }) => storeOperations.push(`${operation}:${method}`),
    runId,
  });
  const fx = { a: 0, bEnd: 0, bStart: 0, c: 0 };
  const bEntered = createDeferred();
  const bRelease = createDeferred();
  const bDone = createDeferred();
  const Trail = Annotation.Root({
    trail: Annotation({ default: () => [], reducer: (left, right) => left.concat(right) }),
  });
  const app = new StateGraph(Trail)
    .addNode("a", () => {
      fx.a += 1;
      return { trail: ["a"] };
    })
    .addNode("b", async () => {
      fx.bStart += 1;
      const first = fx.bStart === 1;
      if (first) {
        bEntered.resolve();
        await bRelease.promise;
      }
      fx.bEnd += 1;
      if (first) {
        bDone.resolve();
      }
      return { trail: ["b"] };
    })
    .addNode("c", () => {
      fx.c += 1;
      return { trail: ["c"] };
    })
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", "c")
    .addEdge("c", END)
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: saver.threadId }, durability: "sync" };
  const request = createRequestCancellation();
  const order = [];

  const rejected = runWithRequestCancellation(request, () =>
    app.invoke({ trail: [] }, { ...config, signal: request.signal })
  ).then(
    () => assert.fail("the aborted invoke resolved"),
    (error) => {
      order.push(`rejected:bEnd=${fx.bEnd}`);
      return error;
    }
  );

  await bEntered.promise;
  request.cancel("client_cancelled");
  const error = await rejected;
  const operationsAtRejection = storeOperations.length;

  // The caller is told at once, while b is still inside its body.
  assert.deepStrictEqual(order, ["rejected:bEnd=0"]);
  assert.ok(isRequestCancelledError(error));
  assert.equal(error.code, "AGENT_CLIENT_CANCELLED");

  bRelease.resolve();
  await bDone.promise;
  await flushEventLoop();

  // b ran to the end in the background, but LangGraph wrote nothing for it.
  assert.deepStrictEqual(fx, { a: 1, bEnd: 1, bStart: 1, c: 0 });
  assert.deepStrictEqual(storeOperations.slice(operationsAtRejection), []);
  const state = await app.getState(config);
  assert.deepStrictEqual(state.next, ["b"]);
  assert.deepStrictEqual(state.values.trail, ["a"]);

  // Resuming runs b a second time: LangGraph alone is at-least-once here.
  const resumed = await app.invoke(null, config);
  assert.deepStrictEqual(resumed.trail, ["a", "b", "c"]);
  assert.deepStrictEqual(fx, { a: 1, bEnd: 2, bStart: 2, c: 1 });
  request.dispose();
});

// --- (4) End to end ----------------------------------------------------------

// Counts every way this process could reach the network. Calls pass through
// unchanged; the assertion is that there are none. syncBuiltinESMExports
// carries the patched properties to ESM named imports of the builtins.
const withNetworkSpy = async (callback) => {
  const calls = [];
  const patches = [
    [globalThis, "fetch"],
    [http, "request"],
    [http, "get"],
    [https, "request"],
    [https, "get"],
    [net, "connect"],
    [net, "createConnection"],
    [net.Socket.prototype, "connect"],
  ];
  const originals = patches.map(([target, key]) => target[key]);

  patches.forEach(([target, key], index) => {
    const original = originals[index];
    target[key] = function spied(...args) {
      calls.push(key);
      return original.apply(this, args);
    };
  });
  syncBuiltinESMExports();

  try {
    return { calls, result: await callback() };
  } finally {
    patches.forEach(([target, key], index) => {
      target[key] = originals[index];
    });
    syncBuiltinESMExports();
  }
};

for (const documentSufficient of [true, false]) {
  const variant = documentSufficient ? "sufficient" : "insufficient";

  test(`(4) ${variant} evidence: the case graph on the run-store saver equals the native stage and the MemorySaver run, persists ids only, and makes no network call`, async (t) => {
    const memorySaver = new MemorySaver();
    const world = createRunStoreWorld({ documentSufficient });
    const storeCalls = [];
    const saver = createSaver(world.agentRunStore, {
      onStoreCall: ({ method, operation }) => storeCalls.push({ method, operation }),
    });

    const { calls: networkCalls, result } = await withNetworkSpy(async () => ({
      // Not vacuous: the spies are what every caller, including an ESM named
      // import of the builtins, would reach.
      installed: [
        globalThis.fetch.name,
        http.request.name,
        namedHttpRequest.name,
        namedHttpsRequest.name,
        net.Socket.prototype.connect.name,
      ],
      memory: await withVendorCaseEnvironment(() =>
        runLangGraphStage({
          checkpointer: memorySaver,
          documentSufficient,
          threadId: "langgraph-spike:runtime-semantics:memory",
        })
      ),
      native: await withVendorCaseEnvironment(() => runNativeStage({ documentSufficient })),
      runStore: await withVendorCaseEnvironment(() =>
        runLangGraphStage({ checkpointer: saver, harness: world.harness, threadId: saver.threadId })
      ),
    }));
    const { installed, memory, native, runStore } = result;
    assert.deepStrictEqual(installed, ["spied", "spied", "spied", "spied", "spied"]);
    assert.notEqual(namedHttpRequest.name, "spied");
    // What the run itself cost, before this test's own reads below.
    const runCalls = { ...saver.calls };
    const runStoreCalls = [...storeCalls];

    assert.deepStrictEqual(networkCalls, []);
    for (const outcome of [memory, native, runStore]) {
      assert.equal(outcome.error, null, outcome.error?.stack);
    }

    // The same receipts as native and as the MemorySaver run.
    for (const other of [native, memory]) {
      assert.deepStrictEqual(maskTimingFields(runStore.run), maskTimingFields(other.run));
      assert.deepStrictEqual(runStore.budget, other.budget);
      assert.deepStrictEqual(runStore.chatCalls, other.chatCalls);
      assert.deepStrictEqual(maskTimingFields(runStore.steps), maskTimingFields(other.steps));
      assert.deepStrictEqual(
        maskTimingFields(runStore.checkpoint, ["digest"]),
        maskTimingFields(other.checkpoint, ["digest"])
      );
      assert.deepStrictEqual(maskTimingFields(runStore.trace), maskTimingFields(other.trace));
      assert.deepStrictEqual(runStore.skippedSkills, other.skippedSkills);
      assert.deepStrictEqual(maskTimingFields(runStore.collected), maskTimingFields(other.collected));
      // The run's own event log, once the saver's checkpoint events are left
      // out, is the native one.
      assert.deepStrictEqual(withoutLangGraphEvents(runStore.events), withoutLangGraphEvents(other.events));
    }
    const registry = runStore.graphRegistry;
    assert.deepStrictEqual(
      maskTimingFields(
        projectUnifiedGraphRun({ graph: runStore.graph, plan: runStore.plan, registry, run: runStore.run })
      ),
      maskTimingFields(
        projectUnifiedGraphRun({ graph: native.graph, plan: native.plan, registry, run: native.run })
      )
    );
    assert.deepStrictEqual(
      maskTimingFields(collectUnifiedGraphResults({ authorizedDocIds: [DOC_ID], graph: runStore.graph, registry, run: runStore.run })),
      maskTimingFields(collectUnifiedGraphResults({ authorizedDocIds: [DOC_ID], graph: native.graph, registry, run: native.run }))
    );

    // The LangGraph threads agree too: same final receipts, same checkpoint
    // history (by step and source; ids are time-based).
    const runStoreConfig = { configurable: { checkpoint_ns: "", thread_id: saver.threadId } };
    const memoryConfig = { configurable: { checkpoint_ns: "", thread_id: "langgraph-spike:runtime-semantics:memory" } };
    const latest = await saver.getTuple(runStoreConfig);
    const memoryLatest = await memorySaver.getTuple(memoryConfig);
    assert.deepStrictEqual(latest.checkpoint.channel_values.receipts, memoryLatest.checkpoint.channel_values.receipts);
    const history = async (checkpointer, config) => {
      const entries = [];
      for await (const tuple of checkpointer.list(config)) {
        entries.push([tuple.metadata.step, tuple.metadata.source, tuple.pendingWrites.map(([, channel]) => channel)]);
      }
      return entries;
    };
    assert.deepStrictEqual(await history(saver, runStoreConfig), await history(memorySaver, memoryConfig));

    // What LangGraph persisted, in the agent run row: ids, statuses, digests.
    const record = readLangGraphRecord(world.agentRunStore);
    const text = recordText(record);
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    const memoryText = serializeMemorySaver(memorySaver);
    assert.match(text, /outputDigest/);
    for (const nodeId of ["document", "evidence_check", "risk"]) {
      assert.ok(text.includes(nodeId));
    }
    assertNoPrivateText(text);
    assertNoPrivateText(memoryText);
    for (const receipt of Object.values(latest.checkpoint.channel_values.receipts)) {
      assert.deepStrictEqual(Object.keys(receipt).sort(), ["outputDigest", "reason", "status"]);
    }

    // One checkpoint per superstep (the input, START, and the three node
    // layers; a skipped risk still returns its receipt), one pending-write
    // batch per task, and one ids-only run event per checkpoint. Every saver
    // write is a read plus one revision CAS on the run row.
    const checkpointEvents = runStore.events.filter((event) => event.type === LANGGRAPH_CHECKPOINTED_EVENT);
    assert.deepStrictEqual(runCalls, { getTuple: 2, put: 5, putWrites: 4 });
    assert.equal(checkpointEvents.length, runCalls.put);
    for (const event of checkpointEvents) {
      assert.deepStrictEqual(
        Object.keys(event.payload).sort(),
        ["checkpointId", "parentCheckpointId", "sequence", "source", "step"]
      );
    }
    const countOf = (method) => runStoreCalls.filter((call) => call.method === method).length;
    assert.deepStrictEqual(
      { get: countOf("get"), update: countOf("update"), updateWithEvent: countOf("updateWithEvent") },
      { get: 11, update: 4, updateWithEvent: 5 }
    );
    assert.ok(recordBytes < 16 * 1024, `record is ${recordBytes} bytes`);

    t.diagnostic(
      `${variant}: __langGraphCheckpoint ${recordBytes} bytes; saver getTuple ${runCalls.getTuple}, put ${runCalls.put}, putWrites ${runCalls.putWrites}; run-store get ${countOf("get")}, update ${countOf("update")}, updateWithEvent ${countOf("updateWithEvent")}; run events ${runStore.events.length} (native ${native.events.length}); MemorySaver serialized ${Buffer.byteLength(memoryText, "utf8")} bytes`
    );
  });
}
