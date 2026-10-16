// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { isDeepStrictEqual } from "node:util";

import { uuid6 } from "@langchain/langgraph-checkpoint";

import { emitAgentEvent, hasAgentEventSink, runWithAgentEventSink } from "../rag/agent-event-stream.js";

import { createAgentBudget } from "../rag/agent-budget.js";
import { continueAgentExecutionGraphApproval, resumeAgentExecutionGraphRun, runAgentRag } from "../rag/agent.js";
import { createExecutionGraph } from "../rag/agent-execution-graph.js";
import {
  buildExecutionGraphNodeStepId,
  snapshotExecutionGraphNodeRun,
} from "../rag/agent-execution-graph-checkpoint.js";
import {
  replayExecutionGraphRun,
  runExecutionGraph,
} from "../rag/agent-execution-graph-runner.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { deterministicUnifiedGraphPlannerAdapter } from "../rag/agent-unified-dag-planner-adapter.js";
import { UNIFIED_GRAPH_RUNTIMES } from "../rag/agent-unified-graph-stage.js";
import { getAgentRuntime } from "../rag/config.js";
import {
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  LANGGRAPH_SAVER_ERROR_CODES,
  RunStoreCheckpointSaver,
} from "../rag/langgraph/checkpointer.js";
import { hasExecutionGraphWorkBeforePause } from "../rag/langgraph/compile-execution-graph.js";
import {
  RUNTIME_RESUME_MARKER,
  UNIFIED_GRAPH_INTERRUPT_KIND,
  buildApprovalInterruptPayload,
  isApprovalInterruptPayload,
} from "../rag/langgraph/unified-graph-approval.js";
import {
  LANGGRAPH_RECOVERY_REASONS,
  verifyLangGraphThreadForRecovery,
} from "../rag/langgraph/unified-graph-recovery.js";
import {
  LANGGRAPH_THREAD_RECONCILIATION_REASONS,
  findPendingApprovalInterrupt,
  readLangGraphThread,
  reconcileLangGraphThreadReceipts,
} from "../rag/langgraph/unified-graph-thread.js";
import {
  getActiveDatabaseTenant,
  runWithDatabaseTenant,
  toDatabaseTenant,
} from "../rag/postgres-tenant.js";
import {
  REQUEST_CANCELLATION_REASONS,
  createRequestCancellation,
  getRequestDeadline,
  getRequestSignal,
  isRequestCancelledError,
  runWithRequestCancellation,
} from "../rag/request-deadline.js";
import { getActiveRunUsage } from "../rag/run-usage.js";
import { CUSTOM_RAG_SKILL_CONTRACT } from "../rag/skills/custom/custom-skill-contract.js";
import { createDefaultSkillRegistry, createSkillRegistry } from "../rag/skills/registry.js";
import { createUnifiedGraphEvidenceGatedSkillCase } from "../evaluation/trajectory/cases/unified-graph.js";
import { createUnifiedGraphApprovalGatedActionCase } from "../evaluation/trajectory/cases/unified-graph-approval.js";
import {
  APPROVAL_TASK_QUESTION,
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE as accessScope,
  UNIFIED_DOC_ID,
  UNIFIED_FILE_NAME,
  UNIFIED_SESSION_ID,
  WEB_QUESTION,
  createApprovalGatedTaskProposal,
  createCrashingRunService,
  createDocumentLoopProposal,
  createDocumentLoopRagService,
  createProposalAdapter,
  createTaskBeforeIndependentCheckProposal,
  createTaskCapabilityRegistry,
  createTaskWithIndependentLaterWorkProposal,
  createWebChatService,
} from "./fixtures/unified-graph-run-fixtures.mjs";

// The guarded v3 unified graph on LangGraph (AGENT_RUNTIME=langgraph,
// docs/adr/0001-langgraph-runtime.md phase 3), against the native scheduler on
// the same scenarios and the same in-memory run store.
//
// Parity tests run a scenario once per runtime, each on a fresh store, and
// deepStrictEqual everything the request leaves behind: the /chat response
// (status and body, agentObservability included), the run (events, steps,
// status, result; the private LangGraph record is never in a run projection)
// and the v2 graph checkpoint. Masked, and only these: random ids (UUIDs,
// also inside composite ids), ISO timestamps, durationMs/latencyMs, and the
// checkpoint seal with everything derived from it (the gate's graphDigest, its
// approval object hash and id, which hash the seal), since the seal covers
// durations. Typed-output digests are content hashes and stay.
//
// The approval tests then look at what only LangGraph has: the run's thread,
// read through the production saver, which must hold the pause as a pending
// interrupt of public ids, be resumed (not restarted) by the decision, carry
// the runtime's own resume marker and nothing a client sent, and never any
// text. Startup recovery reads that thread before claiming the graph and
// refuses one that contradicts the checkpoint.

const RUNTIMES = Object.freeze([UNIFIED_GRAPH_RUNTIMES.native, UNIFIED_GRAPH_RUNTIMES.langgraph]);

const ENV = Object.freeze({
  // The production setting: AGENT_RUNTIME alone moves the v3 graph, and the
  // outer plan of a V1 fallback stays on the native loop.
  AGENT_OUTER_PLAN_RUNTIME: undefined,
  AGENT_PLANNER_ROLLOUT: "deterministic",
  AGENT_UNIFIED_GRAPH_CAPABILITIES: "task.create",
  AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
  // The answer-rate flags change trace and response projections when on
  // (test/trajectory-eval.test.mjs pins them off for the same reason).
  AGENT_FOLLOW_UP_ORIGINAL_QUESTION: undefined,
  AGENT_SINGLE_DOCUMENT_ROUTING: undefined,
  RAG_CLAIM_HEADING_CONTEXT: undefined,
  RAG_CLAIM_INFLECTION: undefined,
  RAG_CLAIM_JUDGE_TEMPERATURE: undefined,
  RAG_CLAIM_SOURCE_INHERITANCE: undefined,
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

const onRuntime = (runtime, work, env = {}) =>
  withEnv({ ...ENV, ...env, AGENT_RUNTIME: runtime }, work);

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
// The approval object hash and the gate id hash the checkpoint seal (through
// the gate's binding); a typed-output digest ("v1:sha256:...") does not.
const APPROVAL_HASH_PATTERN = /(?<!v1:)sha256:[0-9a-f]{64}/g;
const GATE_ID_PATTERN = /graph-approval:[0-9a-f]{64}/g;
const SEAL_PATTERN = /^[0-9a-f]{64}$/;
const SEAL_KEYS = new Set(["digest", "graphDigest"]);
// durationMs, latencyMs, totalDurationMs, ...: every wall-clock measurement.
const WALL_CLOCK_KEY_PATTERN = /(?:duration|latency|elapsed)Ms$/i;

// `typedDigests` also masks typed-output and answer digests: the task node's
// output names the run id (its idempotency key), so its digest and the
// answer's differ between any two runs and say nothing about the runtime.
const mask = (value, key = "", options = {}) => {
  if (typeof value === "string") {
    if (SEAL_KEYS.has(key) && SEAL_PATTERN.test(value)) {
      return "<seal>";
    }

    if (
      options.typedDigests &&
      (key === "typedOutputDigest" || key === "outputDigest" || key === "answerDigest")
    ) {
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
    return value.map((item) => mask(item, "", options));
  }

  if (value instanceof Error) {
    return mask(
      { code: value.code, message: value.message, name: value.name, reason: value.reason, status: value.status },
      "",
      options
    );
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, mask(item, name, options)])
    );
  }

  return value;
};

const maskRunBound = (value) => mask(value, "", { typedDigests: true });

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

// The run's thread as the production saver reads it, and its raw record.
const readThread = (agentRunService, runId) =>
  readLangGraphThread(new RunStoreCheckpointSaver({ accessScope, agentRunService, runId }));

const rawRecord = async (store, runId) =>
  (await store.get({ accessScope, runId }))?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY] ?? null;

const receiptStatuses = (thread) =>
  Object.fromEntries([...thread.receipts].map(([nodeId, receipt]) => [nodeId, receipt.status]));

const settle = (promise) =>
  promise.then(
    (value) => ({ error: null, value }),
    (error) => ({ error, value: null })
  );

/** A fresh store, run service and document-loop request on one runtime. */
const askOn = async (
  runtime,
  {
    onWrite = async () => {},
    primary = "supported",
    proposal = createApprovalGatedTaskProposal,
    question = APPROVAL_TASK_QUESTION,
    ragOptions = {},
    store = newStore(),
    // A service over `store` (e.g. one that crashes at a chosen write).
    agentRunService = newService(store),
    withCapability = true,
  } = {}
) => {
  const ragService = createDocumentLoopRagService({ primary, ...ragOptions });
  const { registry, writes } = withCapability
    ? await createTaskCapabilityRegistry({ onWrite, ragService })
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
  const runId = response?.body?.agentRunId ?? outcome.error?.agentRunId ?? null;

  return {
    agentRunService,
    error: outcome.error,
    gate: response?.body?.approvalGates?.[0] ?? null,
    ragService,
    registry,
    response,
    runId,
    runtime,
    store,
    writes,
  };
};

// The approval endpoint's handler, wired as app-services wires it, on a NEW
// run service over the same store (another process deciding the gate).
const decideOn = (
  runtime,
  { action, context, env = {}, hash, registry = context.registry, service = newService(context.store) }
) =>
  onRuntime(
    runtime,
    () =>
      createAgentRunStepExecutor({
        agentRunService: service,
        capabilityRegistry: registry,
        continueExecutionGraphApproval: (args) =>
          continueAgentExecutionGraphApproval({
            ...args,
            agentRunService: service,
            capabilityRegistry: registry,
            ragService: context.ragService,
          }),
      }).applyApprovalAction({
        accessScope,
        action,
        gateId: context.gate.id,
        payload: { approvalObjectHash: hash ?? context.gate.approvalObjectHash },
        runId: context.runId,
      }),
    env
  );

const recoverOn = (runtime, { context, env = {}, registry = context.registry, service = newService(context.store) }) =>
  onRuntime(
    runtime,
    () =>
      createAgentRunRecoveryService({
        agentRunService: service,
        recordRecoveryTrace: async () => {},
        resumeExecutionGraph: (args) =>
          resumeAgentExecutionGraphRun({
            ...args,
            agentRunService: service,
            capabilityRegistry: registry,
            ragService: context.ragService,
            skillRegistry: createDefaultSkillRegistry(),
          }),
      }).recoverOnStartup({ mode: "auto" }),
    env
  );

const describeOutcome = async (context, maskValue = mask) => ({
  checkpoint: maskValue((await load(context.agentRunService, context.runId)).checkpoint),
  error: context.error ? maskValue(context.error) : null,
  response: maskValue(context.response),
  run: maskValue((await load(context.agentRunService, context.runId)).run),
});

// What the thread holds at the moment the gated Capability writes, which is
// inside the resumed (or restarted) node, before it returns its receipt: the
// only moment a finished run's thread can still be observed, since the save
// that settles the graph drops it.
const createThreadProbe = () => {
  const probe = { context: null, seen: [] };

  probe.onWrite = async () => {
    const { context } = probe;
    const thread = context ? await readThread(context.agentRunService, context.runId) : null;

    probe.seen.push(
      thread
        ? {
            interrupts: thread.interrupts.map((pending) => pending.value),
            receipts: receiptStatuses(thread),
            record: await rawRecord(context.store, context.runId),
            resumeWrites: thread.resumeWrites,
          }
        : null
    );
  };

  return probe;
};

// Rewrites the receipts of the thread's latest checkpoint behind the saver's
// back (the raw store, below every fence), as a corrupted row would read.
const forgeStoredThread = async (context, patchReceipts) => {
  const raw = await context.store.get({ accessScope, runId: context.runId });
  const record = structuredClone(raw.result[LANGGRAPH_CHECKPOINT_RESULT_KEY]);
  const namespace = record.namespaces.find((candidate) => candidate.ns === "");
  const latest = namespace.checkpoints.reduce(
    (newest, entry) => (newest === null || entry.id > newest.id ? entry : newest),
    null
  );
  const checkpoint = JSON.parse(latest.checkpoint.d);

  checkpoint.channel_values.receipts = patchReceipts({ ...(checkpoint.channel_values.receipts ?? {}) });
  latest.checkpoint.d = JSON.stringify(checkpoint);
  await context.store.update({
    accessScope,
    expectedRevision: raw.revision,
    patch: { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: record } },
    runId: context.runId,
  });
};

const assertNoText = (record, texts) => {
  const serialized = JSON.stringify(record);

  for (const text of texts) {
    assert.equal(serialized.includes(text), false, `the thread record must not hold ${JSON.stringify(text)}`);
  }
};

// Text the thread must never hold: the question, the document answer, the
// gate's object hash (a client-facing id the thread has no use for).
const privateTexts = (context) => [
  context.gate?.approvalObjectHash ?? "sha256:never",
  APPROVAL_TASK_QUESTION,
  "30 days written notice",
];

// ---------------------------------------------------------------------------
// Parity: the evidence-gated document loop and the trajectory cases
// ---------------------------------------------------------------------------

test("AGENT_RUNTIME selects the scheduler and the stage names both", async () => {
  assert.deepEqual(UNIFIED_GRAPH_RUNTIMES, { langgraph: "langgraph", native: "native" });
  // Unset is LangGraph since phase 4 (docs/adr/0001-langgraph-runtime.md);
  // `native` is the rollback, and an unknown value falls back to it.
  assert.equal(await withEnv({ AGENT_RUNTIME: undefined }, () => getAgentRuntime()), "langgraph");
  assert.equal(await withEnv({ AGENT_RUNTIME: "langgraph" }, () => getAgentRuntime()), "langgraph");
  assert.equal(await withEnv({ AGENT_RUNTIME: "native" }, () => getAgentRuntime()), "native");
  assert.equal(await withEnv({ AGENT_RUNTIME: "pregel" }, () => getAgentRuntime()), "native");
});

test("parity: the evidence-gated document loop (follow-up resolves / unresolved) is identical on both runtimes", async () => {
  for (const followUp of ["resolves", "unresolved"]) {
    const outcomes = {};

    for (const runtime of RUNTIMES) {
      // The thread as the document calls see it from inside their nodes (the
      // only time a finished run's thread can be seen: the settling save
      // drops it). The run id is the store's only run's.
      const seen = [];
      const store = newStore();
      const probeService = newService(store);
      const context = await askOn(runtime, {
        primary: "unsupported",
        proposal: createDocumentLoopProposal,
        question: DOCUMENT_LOOP_QUESTION,
        ragOptions: {
          followUp,
          onChat: async ({ phase }) => {
            const listed = await store.list({ accessScope });
            const [{ runId }] = listed?.runs ?? listed;
            const thread = await readThread(probeService, runId);

            seen.push({
              phase,
              receipts: thread ? receiptStatuses(thread) : null,
              record: await rawRecord(store, runId),
            });
          },
        },
        store,
        withCapability: false,
      });

      assert.equal(context.error, null, `${runtime}/${followUp}: ${context.error?.message}`);
      outcomes[runtime] = await describeOutcome(context);
      assert.deepEqual(
        context.ragService.calls.map((call) => call.phase),
        ["primary", "follow_up"],
        `${runtime}/${followUp}`
      );
      // A finished run carries no thread on either runtime.
      assert.equal(await rawRecord(context.store, context.runId), null, runtime);
      assert.deepEqual(seen.map((entry) => entry.phase), ["primary", "follow_up"]);

      if (runtime === UNIFIED_GRAPH_RUNTIMES.langgraph) {
        // The graph ran on LangGraph: the thread existed while the nodes ran,
        // held the settled nodes' receipts when the follow-up ran, and no
        // text of the request or the answers at any time.
        assert.deepEqual(seen[0].receipts, {});
        assert.deepEqual(seen[1].receipts, { primary: "completed", primary_check: "completed" });
        for (const entry of seen) {
          assert.notEqual(entry.record, null, entry.phase);
          assertNoText(entry.record, [DOCUMENT_LOOP_QUESTION, "60 days notice", "30 days written notice"]);
        }
      } else {
        assert.deepEqual(seen.map((entry) => entry.record), [null, null], "native writes no thread");
      }
    }

    assert.deepEqual(
      outcomes[UNIFIED_GRAPH_RUNTIMES.langgraph],
      outcomes[UNIFIED_GRAPH_RUNTIMES.native],
      followUp
    );
    // The unresolved variant ends as a clarification (the run waits for the
    // user); the resolved one completes.
    assert.equal(outcomes.native.run.status, followUp === "resolves" ? "completed" : "waiting_for_user");
    assert.equal(outcomes.native.checkpoint.phase, "completed");
    assert.ok(outcomes.native.checkpoint.finalization);
  }
});

test("parity: the deterministic document_web graph, declared out of layer order, runs on LangGraph in layer order, as natively", async () => {
  // The production graph that used to be handed to the native scheduler:
  // createDeterministicUnifiedExecutionGraph declares [document,
  // evidence_check, follow_up, follow_up_check, web], so web (third layer) is
  // declared after follow_up_check (fourth), and document_rag and web nodes
  // run alone. With a declaration-order queue, native ran follow_up_check
  // before web on every run, which LangGraph's supersteps could not; since
  // phase 5 both queue in layer order, so web runs before follow_up_check on
  // both and the graph is scheduled by LangGraph. Measured against the
  // declaration-order queue, only the order of agentTrace, agentRunSteps and
  // agentObservability.runs changed natively; the answer, sources and
  // statuses did not.
  const outcomes = {};

  for (const runtime of RUNTIMES) {
    const store = newStore();
    const agentRunService = newService(store);
    const ragService = createDocumentLoopRagService({ followUp: "unresolved", primary: "unsupported" });
    const webCalls = [];
    const fetchWeb = createWebChatService({ calls: webCalls });
    let receiptsAtWeb;
    const response = await onRuntime(runtime, () =>
      runAgentRag({
        accessScope,
        agentRunService,
        capabilityApprovals: { "web.search": { approved: true } },
        docIds: [UNIFIED_DOC_ID],
        question: WEB_QUESTION,
        ragService,
        sessionId: UNIFIED_SESSION_ID,
        unifiedGraphPlannerAdapter: deterministicUnifiedGraphPlannerAdapter,
        userId: accessScope.userId,
        webChatService: async (question) => {
          const listed = await store.list({ accessScope });
          const [{ runId }] = listed?.runs ?? listed;
          const thread = await readThread(agentRunService, runId);

          receiptsAtWeb = thread ? receiptStatuses(thread) : null;
          return fetchWeb(question);
        },
      })
    );
    const context = { agentRunService, error: null, response, runId: response.body.agentRunId };
    const { checkpoint, run } = await load(agentRunService, context.runId);

    assert.equal(response.status, 200, runtime);
    assert.equal(response.body.agentMode, "document_web", runtime);
    assert.equal(run.status, "completed", runtime);
    assert.deepEqual(ragService.calls.map((call) => call.phase), ["primary", "follow_up"], runtime);
    assert.equal(webCalls.length, 1, runtime);
    assert.deepEqual(
      checkpoint.graph.nodes.map((node) => node.nodeId),
      ["document", "evidence_check", "follow_up", "follow_up_check", "web"],
      runtime
    );
    // Layer order: web (third layer) before follow_up_check (fourth).
    assert.deepEqual(
      run.steps
        .filter((step) => step.type === "graph_node")
        .map((step) => `${step.input?.nodeId}:${step.status}`),
      [
        "document:completed",
        "evidence_check:completed",
        "follow_up:completed",
        "web:completed",
        "follow_up_check:completed",
      ],
      runtime
    );
    // LangGraph scheduled it: its thread held the first two layers' receipts
    // when web ran (follow_up's lands at the end of their shared superstep).
    assert.deepEqual(
      receiptsAtWeb,
      runtime === UNIFIED_GRAPH_RUNTIMES.langgraph
        ? { document: "completed", evidence_check: "completed" }
        : null,
      runtime
    );
    assert.equal(await rawRecord(store, context.runId), null, runtime);
    outcomes[runtime] = await describeOutcome(context);
  }

  assert.deepEqual(
    outcomes[UNIFIED_GRAPH_RUNTIMES.langgraph],
    outcomes[UNIFIED_GRAPH_RUNTIMES.native]
  );
});

test("parity: the two unified_graph trajectory cases report the same checks and projection on both runtimes", async () => {
  for (const [label, createCase] of [
    ["unified_graph_evidence_gated_skill_hand_off", createUnifiedGraphEvidenceGatedSkillCase],
    ["unified_graph_approval_gated_action", createUnifiedGraphApprovalGatedActionCase],
  ]) {
    const results = {};

    for (const runtime of RUNTIMES) {
      const result = await onRuntime(runtime, () => createCase().run());

      assert.equal(result.id, label);
      assert.ok(result.checks.length > 0, `${label}/${runtime}`);
      assert.deepEqual(
        result.checks.filter((check) => !check.passed).map((check) => check.id),
        [],
        `${label}/${runtime}`
      );
      results[runtime] = mask(result);
    }

    assert.deepEqual(results.langgraph, results.native, label);
  }
});

// ---------------------------------------------------------------------------
// Approval: pause, approve, deny, refusals
// ---------------------------------------------------------------------------

test("parity: an approval-gated Capability parks the graph identically; on LangGraph the pause is the thread's pending interrupt and nothing ran", async () => {
  for (const [label, proposal] of [
    ["gated task", createApprovalGatedTaskProposal],
    ["task declared before an independent check", createTaskBeforeIndependentCheckProposal],
  ]) {
    const paused = {};

    for (const runtime of RUNTIMES) {
      const context = await askOn(runtime, { proposal });

      assert.equal(context.error, null, `${label}/${runtime}: ${context.error?.message}`);
      assert.equal(context.response.body.clarification.reason, "capability_approval_required", runtime);
      assert.equal(context.writes.length, 0, runtime);
      paused[runtime] = { context, outcome: await describeOutcome(context) };
    }

    assert.deepEqual(paused.langgraph.outcome, paused.native.outcome, label);
    assert.equal(paused.native.outcome.run.status, "waiting_for_user");
    assert.equal(paused.native.outcome.checkpoint.phase, "awaiting_approval");
    // The independent check settled before the pause on both runtimes (it
    // shares the gated node's superstep), so the gate binds to it.
    assert.deepEqual(
      paused.native.outcome.checkpoint.nodeRuns.map((nodeRun) => nodeRun.nodeId).sort(),
      ["document", "evidence_check"]
    );

    const { context } = paused.langgraph;
    const thread = await readThread(context.agentRunService, context.runId);

    assert.deepEqual(receiptStatuses(thread), { document: "completed", evidence_check: "completed" });
    assert.equal(thread.interrupts.length, 1);
    assert.deepEqual(thread.interrupts[0].value, buildApprovalInterruptPayload({ nodeId: "task" }));
    assert.deepEqual(thread.interrupts[0].value, { gateId: null, kind: UNIFIED_GRAPH_INTERRUPT_KIND, nodeId: "task" });
    assert.ok(findPendingApprovalInterrupt({ interrupts: thread.interrupts, nodeId: "task" }));
    assert.equal(findPendingApprovalInterrupt({ interrupts: thread.interrupts, nodeId: "document" }), null);
    assert.deepEqual(thread.resumeWrites, []);
    assertNoText(await rawRecord(context.store, context.runId), privateTexts(context));
    // The parked node spent nothing: no step, no budget attempt, no receipt.
    const { run } = await load(context.agentRunService, context.runId);
    assert.equal(run.steps.some((step) => step.input?.nodeId === "task"), false);
    assert.equal(run.events.at(-1).type, "graph_approval_gate_created");
  }
});

test("parity: approving on a new run service continues the SAME LangGraph thread, runs the Capability once, and answers like native", async () => {
  const approved = {};

  for (const runtime of RUNTIMES) {
    const probe = createThreadProbe();
    const context = await askOn(runtime, { onWrite: probe.onWrite });
    probe.context = context;
    const service = newService(context.store);
    const result = await decideOn(runtime, { action: "approve", context, service });

    assert.equal(result.run.status, "completed", runtime);
    assert.equal(context.writes.length, 1, runtime);
    assert.deepEqual(context.writes[0].input, {
      description: context.gate.inputPreview.description,
      title: context.gate.inputPreview.title,
    });
    assert.equal(context.writes[0].taskId, `capability-artifact:${context.runId}:task:capability:task.create`);
    assert.equal(context.ragService.calls.length, 1, runtime);
    // A finished run carries no thread, on either runtime.
    assert.equal(await rawRecord(context.store, context.runId), null, runtime);
    approved[runtime] = {
      context,
      decision: maskRunBound({ response: result.response, status: result.status }),
      outcome: await describeOutcome({ ...context, agentRunService: service, response: null }, maskRunBound),
      probe,
    };
  }

  assert.deepEqual(approved.langgraph.decision, approved.native.decision);
  assert.deepEqual(approved.langgraph.outcome, approved.native.outcome);
  assert.equal(approved.native.outcome.checkpoint.phase, "completed");
  assert.ok(approved.native.outcome.checkpoint.finalization);
  assert.deepEqual(
    approved.native.outcome.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    [["document", "reused"], ["evidence_check", "reused"], ["task", "completed"]]
  );

  // Seen from inside the Capability's write: natively there is no thread.
  // On LangGraph the thread was resumed, not restarted: the receipts the
  // first invocation wrote before the pause are still "completed" (a fresh
  // invocation re-enters those nodes as "reused"), the pause is still the
  // pending interrupt (the node has not returned yet), the resume value is
  // the runtime's marker and nothing else, and no text is in the record.
  assert.deepEqual(approved.native.probe.seen, [null]);
  const [seen] = approved.langgraph.probe.seen;
  assert.deepEqual(seen.receipts, { document: "completed", evidence_check: "completed" });
  assert.deepEqual(seen.interrupts, [buildApprovalInterruptPayload({ nodeId: "task" })]);
  assert.deepEqual(seen.resumeWrites, [[RUNTIME_RESUME_MARKER]]);
  assertNoText(seen.record, privateTexts(approved.langgraph.context));

  // A decided gate cannot be decided again, on either runtime.
  const { context } = approved.langgraph;
  await assert.rejects(decideOn("langgraph", { action: "approve", context }), (error) => error.status === 409);
  assert.equal(context.writes.length, 1);
});

test("parity: a denied gate settles the parked node as approval_denied without entering it", async () => {
  const denied = {};

  for (const runtime of RUNTIMES) {
    const context = await askOn(runtime);
    const service = newService(context.store);
    const result = await decideOn(runtime, { action: "deny", context, service });

    assert.equal(result.run.status, "completed", runtime);
    assert.equal(result.response.agentAnswer, "Create Task was not run: the approval was denied.");
    assert.equal(context.writes.length, 0, runtime);
    // Nothing was left to run, so no scheduler ran: the denied node was
    // settled before scheduling, and the thread is dropped with the run.
    assert.equal(await rawRecord(context.store, context.runId), null, runtime);
    denied[runtime] = {
      context,
      decision: mask({ response: result.response, status: result.status }),
      outcome: await describeOutcome({ ...context, agentRunService: service, response: null }),
    };
  }

  assert.deepEqual(denied.langgraph.decision, denied.native.decision);
  assert.deepEqual(denied.langgraph.outcome, denied.native.outcome);
  assert.deepEqual(
    denied.native.outcome.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status, nodeRun.reason]),
    [["document", "reused", null], ["evidence_check", "reused", null], ["task", "skipped", "approval_denied"]]
  );
  assert.equal(
    denied.langgraph.outcome.run.steps.some((step) => step.input?.nodeId === "task"),
    false
  );
});

test("a wrong approval object, a stale Capability version and a non-guarded rollout refuse before the thread is touched", async () => {
  const context = await askOn("langgraph");
  const recordBefore = await rawRecord(context.store, context.runId);
  const { registry: bumped, writes: bumpedWrites } = await createTaskCapabilityRegistry({
    ragService: context.ragService,
    version: "1.0.1",
  });

  for (const [label, attempt, code] of [
    ["forged object", () => decideOn("langgraph", { action: "approve", context, hash: `sha256:${"0".repeat(64)}` }), "approval_object_hash_mismatch"],
    ["stale version", () => decideOn("langgraph", { action: "approve", context, registry: bumped }), "graph_approval_stale"],
    ["rollout off", () => decideOn("langgraph", { action: "approve", context, env: { AGENT_UNIFIED_GRAPH_ROLLOUT: "off" } }), "unified_graph_rollout_not_guarded"],
  ]) {
    await assert.rejects(attempt(), (error) => {
      assert.equal(error.code, code, label);
      assert.equal(error.status, 409, label);
      return true;
    });
    assert.equal(context.writes.length + bumpedWrites.length, 0, label);
    assert.deepEqual(await rawRecord(context.store, context.runId), recordBefore, label);
  }

  const thread = await readThread(context.agentRunService, context.runId);
  assert.equal(thread.interrupts.length, 1);
  assert.deepEqual(thread.resumeWrites, []);
  // The rollback handed the run to an operator (as natively); the wrong
  // object and the stale version did not.
  const { run } = await load(context.agentRunService, context.runId);
  assert.equal(run.status, "waiting_for_user");
  assert.equal(run.result.recovery.reason, "unified_graph_rollout_not_guarded");
});

test("parity: an approved gate whose live policy no longer asks for approval is refused, and the parked Capability never runs", async () => {
  // Ported from the phase-0 spike, which pinned it only against its own
  // reimplementation. When the approved node starts, the gate is derived
  // again from the live Capability (verifyCapabilityGraphApproval): a policy
  // that stopped asking for approval after the pause (same id and version,
  // so the stale-version check does not fire) must not turn the approval
  // into a licence to run. The node refuses before its step, budget or call,
  // and the run goes to an operator, identically on both runtimes.
  const refused = {};

  for (const runtime of RUNTIMES) {
    const context = await askOn(runtime);
    const { registry: drifted, writes: driftedWrites } = await createTaskCapabilityRegistry({
      approvalPolicy: { mode: "direct", writesWorkspace: true },
      ragService: context.ragService,
    });
    const before = await load(context.agentRunService, context.runId);

    assert.equal(before.checkpoint.phase, "awaiting_approval", runtime);
    await assert.rejects(decideOn(runtime, { action: "approve", context, registry: drifted }), (error) => {
      assert.equal(error.code, "graph_approval_not_required", runtime);
      assert.equal(error.status, 409, runtime);
      return true;
    });

    const after = await load(context.agentRunService, context.runId);

    // Neither Capability (the one that parked, the drifted one) wrote.
    assert.equal(context.writes.length + driftedWrites.length, 0, runtime);
    // The gated node opened no step and settled nowhere; the owner's budget
    // and the settled nodes are exactly those of the pause. Only the phase
    // (the continuation reopened the graph), its sequence and seal moved.
    assert.equal(after.run.steps.some((step) => step.input?.nodeId === "task"), false, runtime);
    assert.deepEqual(after.checkpoint.nodeRuns, before.checkpoint.nodeRuns, runtime);
    assert.deepEqual(after.checkpoint.owner, before.checkpoint.owner, runtime);
    assert.deepEqual(
      Object.keys({ ...before.checkpoint, ...after.checkpoint })
        .filter((key) => !isDeepStrictEqual(before.checkpoint[key], after.checkpoint[key]))
        .sort(),
      ["digest", "phase", "sequence"],
      runtime
    );
    assert.equal(after.checkpoint.phase, "running", runtime);
    assert.equal(after.run.status, "waiting_for_user", runtime);
    assert.equal(after.run.result.recovery.mode, "manual", runtime);
    assert.equal(after.run.result.recovery.reason, "graph_approval_continuation_failed", runtime);
    assert.deepEqual(after.run.events.slice(-2).map((event) => event.type), [
      "graph_approval_approved",
      "manual_recovery_required",
    ]);

    // Restoring the policy does not reopen it: the gate is spent and the run
    // belongs to an operator.
    await assert.rejects(decideOn(runtime, { action: "approve", context }), (error) => error.status === 409);
    assert.equal(context.writes.length + driftedWrites.length, 0, runtime);

    refused[runtime] = { context, outcome: await describeOutcome({ ...context, response: null }) };
  }

  assert.deepEqual(refused.langgraph.outcome, refused.native.outcome);

  // On LangGraph the decision resumed the thread (the runtime's marker is its
  // resume write) and the node refused inside it, so the pause is still the
  // thread's pending interrupt and no receipt was added for the task.
  const thread = await readThread(refused.langgraph.context.agentRunService, refused.langgraph.context.runId);
  assert.deepEqual(thread.interrupts.map((pending) => pending.value), [buildApprovalInterruptPayload({ nodeId: "task" })]);
  assert.deepEqual(receiptStatuses(thread), { document: "completed", evidence_check: "completed" });
  assert.deepEqual(thread.resumeWrites, [[RUNTIME_RESUME_MARKER]]);
  assert.equal(await rawRecord(refused.native.context.store, refused.native.context.runId), null);
});

test("a runtime switch between the pause and the decision continues the graph either way", async () => {
  // Paused natively (no thread), decided on LangGraph: a fresh invocation
  // seeded from the checkpoint, so the settled nodes are entered as reused
  // and nothing is resumed.
  const probe = createThreadProbe();
  const nativePause = await askOn("native", { onWrite: probe.onWrite });
  probe.context = nativePause;
  assert.equal(await rawRecord(nativePause.store, nativePause.runId), null);
  const onLangGraph = await decideOn("langgraph", { action: "approve", context: nativePause });
  assert.equal(onLangGraph.run.status, "completed");
  assert.equal(nativePause.writes.length, 1);
  const [seen] = probe.seen;
  assert.deepEqual(seen.receipts, { document: "reused", evidence_check: "reused" });
  assert.deepEqual(seen.interrupts, []);
  assert.deepEqual(seen.resumeWrites, []);
  assert.equal(await rawRecord(nativePause.store, nativePause.runId), null);

  // Paused on LangGraph, decided natively: native ignores the thread and
  // continues from the checkpoint, and its settling save drops the stale
  // thread like any other.
  const langGraphPause = await askOn("langgraph");
  assert.equal((await readThread(langGraphPause.agentRunService, langGraphPause.runId)).interrupts.length, 1);
  const onNative = await decideOn("native", { action: "approve", context: langGraphPause });
  assert.equal(onNative.run.status, "completed");
  assert.equal(langGraphPause.writes.length, 1);
  assert.equal(await rawRecord(langGraphPause.store, langGraphPause.runId), null);
});

// ---------------------------------------------------------------------------
// Recovery: crash after the write, crash before the step, thread checks
// ---------------------------------------------------------------------------

// Approve on a run service that stops right before the gated node's step is
// recorded: the gate is approved, the node never started.
const approveThenCrashBeforeTask = async (context) => {
  const { service } = createCrashingRunService(newService(context.store), {
    crashBefore: (method, args) =>
      method === "recordRunStep" && args.input?.nodeId === "task",
  });

  await assert.rejects(
    decideOn("langgraph", { action: "approve", context, service }),
    (error) => error.code === "SIMULATED_PROCESS_EXIT"
  );
  assert.equal(context.writes.length, 0);
};

test("a crash after the approved Capability's write is manual on recovery; a crash before its step is resumed once", async () => {
  // After the write, before its receipt: the step is running, the outcome
  // unknown, and the thread (which never saw the node return) proves nothing.
  const late = await askOn("langgraph");
  const { service: crashingLate, state } = createCrashingRunService(newService(late.store));
  const { registry: crashAfterWrite, writes: lateWrites } = await createTaskCapabilityRegistry({
    onWrite: async () => { state.crashed = true; },
    ragService: late.ragService,
  });

  await assert.rejects(
    decideOn("langgraph", { action: "approve", context: late, registry: crashAfterWrite, service: crashingLate }),
    (error) => error.code === "SIMULATED_PROCESS_EXIT"
  );
  assert.equal(lateWrites.length, 1);
  const lateOutcome = await recoverOn("langgraph", { context: late, registry: crashAfterWrite });
  const lateAfter = await load(late.agentRunService, late.runId);
  assert.equal(lateOutcome.manualRecoveredCount, 1);
  assert.equal(lateOutcome.autoRecoveredCount, 0);
  assert.equal(lateAfter.run.result.recovery.mode, "manual");
  assert.equal(lateAfter.run.result.recovery.reason, "unknown_in_flight_node");
  assert.equal(lateWrites.length, 1);

  // Before the step: the thread's receipts agree with the checkpoint, the
  // graph is claimed, and the approved node runs exactly once on a fresh
  // invocation seeded from the checkpoint (the stale thread is dropped under
  // the claim).
  const probe = createThreadProbe();
  const early = await askOn("langgraph", { onWrite: probe.onWrite });
  probe.context = early;
  await approveThenCrashBeforeTask(early);
  const verified = await verifyLangGraphThreadForRecovery({
    accessScope,
    agentRunService: early.agentRunService,
    checkpoint: (await load(early.agentRunService, early.runId)).checkpoint,
    runId: early.runId,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.thread.behind, false);
  const earlyOutcome = await recoverOn("langgraph", { context: early });
  const earlyAfter = await load(early.agentRunService, early.runId);
  assert.equal(earlyOutcome.autoRecoveredCount, 1, JSON.stringify(earlyOutcome));
  assert.equal(earlyOutcome.manualRecoveredCount, 0);
  assert.equal(earlyAfter.run.status, "completed");
  assert.equal(early.writes.length, 1);
  assert.equal(early.ragService.calls.length, 1);
  // The fresh invocation, seen from inside the write: the settled nodes
  // entered as reused, no pause and no resume on the new thread; the thread
  // is gone once the run completed.
  assert.deepEqual(probe.seen, [{ ...probe.seen[0], interrupts: [], receipts: { document: "reused", evidence_check: "reused" }, resumeWrites: [] }]);
  assert.equal(await rawRecord(early.store, early.runId), null);
});

// A thread whose latest checkpoint carries the given receipts, written
// through the production saver (the run is running and unclaimed, so the
// write passes the fence exactly as a stale worker's would).
const forgeThreadReceipts = async (context, patchReceipts) => {
  const saver = new RunStoreCheckpointSaver({ accessScope, agentRunService: context.agentRunService, runId: context.runId });
  const config = { configurable: { thread_id: saver.threadId } };
  const tuple = await saver.getTuple(config);
  const receipts = { ...(tuple.checkpoint.channel_values.receipts ?? {}) };

  await saver.put(
    { configurable: { ...config.configurable, checkpoint_ns: "", checkpoint_id: tuple.checkpoint.id } },
    {
      ...tuple.checkpoint,
      channel_values: { ...tuple.checkpoint.channel_values, receipts: patchReceipts(receipts) },
      id: uuid6(99),
    },
    { parents: {}, source: "loop", step: 99 },
    {}
  );
};

test("startup recovery reads the thread before claiming and refuses one that contradicts the checkpoint", async () => {
  for (const [label, patchReceipts, detail] of [
    [
      "a completed receipt with another digest",
      (receipts) => ({
        ...receipts,
        "node:document": { ...receipts["node:document"], outputDigest: `v1:sha256:${"0".repeat(64)}` },
      }),
      LANGGRAPH_THREAD_RECONCILIATION_REASONS.receiptDigestMismatch,
    ],
    [
      "a completed receipt the checkpoint does not hold",
      (receipts) => ({
        ...receipts,
        "node:task": { outputDigest: receipts["node:document"].outputDigest, reason: null, status: "completed" },
      }),
      LANGGRAPH_THREAD_RECONCILIATION_REASONS.receiptWithoutCheckpoint,
    ],
    [
      "a receipt for a node the graph does not have",
      (receipts) => ({ ...receipts, "node:intruder": { outputDigest: null, reason: null, status: "skipped" } }),
      LANGGRAPH_THREAD_RECONCILIATION_REASONS.foreignReceipt,
    ],
  ]) {
    const context = await askOn("langgraph");
    await approveThenCrashBeforeTask(context);
    await forgeThreadReceipts(context, patchReceipts);

    const verified = await verifyLangGraphThreadForRecovery({
      accessScope,
      agentRunService: context.agentRunService,
      checkpoint: (await load(context.agentRunService, context.runId)).checkpoint,
      runId: context.runId,
    });
    assert.equal(verified.ok, false, label);
    assert.equal(verified.reason, LANGGRAPH_RECOVERY_REASONS.threadMismatch, label);
    assert.equal(verified.detail, detail, label);

    const outcome = await recoverOn("langgraph", { context });
    const after = await load(context.agentRunService, context.runId);
    assert.equal(outcome.manualRecoveredCount, 1, label);
    assert.equal(outcome.autoRecoveredCount, 0, label);
    assert.equal(after.run.result.recovery.mode, "manual", label);
    assert.equal(after.run.result.recovery.reason, LANGGRAPH_RECOVERY_REASONS.threadMismatch, label);
    // Never claimed, nothing ran.
    assert.equal(after.checkpoint.resumeClaim, null, label);
    assert.equal(context.writes.length, 0, label);
    assert.equal(after.run.steps.some((step) => step.input?.nodeId === "task"), false, label);
  }

  // Natively the same forged thread is never read: the native runtime does
  // not know it exists, and recovery runs the approved node once. This is
  // what an AGENT_RUNTIME=native rollback does with a run LangGraph left
  // unfinished: it resumes from the graph checkpoint, and the save that
  // settles the graph drops the stale thread (the null tombstone).
  const native = await askOn("langgraph");
  await approveThenCrashBeforeTask(native);
  await forgeThreadReceipts(native, (receipts) => ({
    ...receipts,
    "node:document": { ...receipts["node:document"], outputDigest: `v1:sha256:${"0".repeat(64)}` },
  }));
  assert.notEqual(await rawRecord(native.store, native.runId), null);
  const nativeOutcome = await recoverOn("native", { context: native });
  assert.equal(nativeOutcome.autoRecoveredCount, 1);
  assert.equal(native.writes.length, 1);
  assert.equal((await load(native.agentRunService, native.runId)).run.status, "completed");
  assert.equal(await rawRecord(native.store, native.runId), null);
  assert.equal(
    Object.hasOwn((await native.store.get({ accessScope, runId: native.runId })).result, LANGGRAPH_CHECKPOINT_RESULT_KEY),
    true
  );

  // A thread behind its checkpoint, or none at all, is no contradiction: the
  // fresh invocation resumes from the checkpoint.
  const behind = await askOn("langgraph");
  await approveThenCrashBeforeTask(behind);
  await forgeThreadReceipts(behind, () => ({}));
  const behindVerified = await verifyLangGraphThreadForRecovery({
    accessScope,
    agentRunService: behind.agentRunService,
    checkpoint: (await load(behind.agentRunService, behind.runId)).checkpoint,
    runId: behind.runId,
  });
  assert.deepEqual([behindVerified.ok, behindVerified.thread.behind], [true, true]);
  assert.equal((await recoverOn("langgraph", { context: behind })).autoRecoveredCount, 1);
  assert.equal(behind.writes.length, 1);

  const missing = await askOn("langgraph");
  await approveThenCrashBeforeTask(missing);
  const saver = new RunStoreCheckpointSaver({ accessScope, agentRunService: missing.agentRunService, runId: missing.runId });
  await saver.deleteThread(saver.threadId);
  assert.equal(await readThread(missing.agentRunService, missing.runId), null);
  assert.equal((await recoverOn("langgraph", { context: missing })).autoRecoveredCount, 1);
  assert.equal(missing.writes.length, 1);
});

test("a thread that contradicts the checkpoint refuses the approval continuation on that thread", async () => {
  // The thread holds the document answer under another digest than the
  // checkpoint: neither can be trusted to continue, and the run goes to an
  // operator without running the Capability.
  const context = await askOn("langgraph");
  await forgeStoredThread(context, (receipts) => ({
    ...receipts,
    "node:document": { ...receipts["node:document"], outputDigest: `v1:sha256:${"1".repeat(64)}` },
  }));

  await assert.rejects(
    decideOn("langgraph", { action: "approve", context }),
    (error) => error.code === "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" && error.status === 409
  );
  const after = await load(context.agentRunService, context.runId);
  assert.equal(context.writes.length, 0);
  assert.equal(after.run.approvalGates[0].status, "approved");
  assert.equal(after.run.result.recovery.mode, "manual");
  assert.equal(after.run.result.recovery.reason, "graph_approval_continuation_failed");
  assert.equal(after.run.steps.some((step) => step.input?.nodeId === "task"), false);
});

// ---------------------------------------------------------------------------
// The thread contract itself
// ---------------------------------------------------------------------------

test("the interrupt payload and the resume marker are ids only, and foreign payloads are never a pause", () => {
  assert.deepEqual(buildApprovalInterruptPayload({ nodeId: "task" }), {
    gateId: null,
    kind: UNIFIED_GRAPH_INTERRUPT_KIND,
    nodeId: "task",
  });
  assert.throws(() => buildApprovalInterruptPayload({ nodeId: " task" }), TypeError);
  assert.throws(() => buildApprovalInterruptPayload({ nodeId: "" }), TypeError);
  assert.equal(isApprovalInterruptPayload(buildApprovalInterruptPayload({ nodeId: "task" })), true);
  assert.equal(isApprovalInterruptPayload({ gateId: "g", kind: UNIFIED_GRAPH_INTERRUPT_KIND, nodeId: "task" }), true);
  for (const foreign of [
    null,
    "task",
    { nodeId: "task" },
    { gateId: null, kind: "other", nodeId: "task" },
    { gateId: null, kind: UNIFIED_GRAPH_INTERRUPT_KIND, nodeId: "" },
    { gateId: "", kind: UNIFIED_GRAPH_INTERRUPT_KIND, nodeId: "task" },
    { gateId: null, kind: UNIFIED_GRAPH_INTERRUPT_KIND, nodeId: "task", snapshot: {} },
  ]) {
    assert.equal(isApprovalInterruptPayload(foreign), false, JSON.stringify(foreign));
  }
  assert.deepEqual(RUNTIME_RESUME_MARKER, { kind: UNIFIED_GRAPH_INTERRUPT_KIND, resume: "runtime" });
  assert.ok(Object.isFrozen(RUNTIME_RESUME_MARKER));

  const pending = { id: "8f3b023cc0fde9a7b17fc36a6381c5fa", taskId: "t", value: buildApprovalInterruptPayload({ nodeId: "task" }) };
  assert.equal(findPendingApprovalInterrupt({ interrupts: [pending], nodeId: "task" }), pending);
  assert.equal(findPendingApprovalInterrupt({ interrupts: [pending, pending], nodeId: "task" }), null);
  assert.equal(findPendingApprovalInterrupt({ interrupts: [{ ...pending, value: { nodeId: "task" } }], nodeId: "task" }), null);
  assert.equal(findPendingApprovalInterrupt({ interrupts: [{ ...pending, id: "" }], nodeId: "task" }), null);
  assert.equal(findPendingApprovalInterrupt({ interrupts: [], nodeId: "task" }), null);
});

test("thread receipts reconcile against the checkpoint's completed digests, and only derived receipts come back", () => {
  const digest = `v1:sha256:${"a".repeat(64)}`;
  const reconcile = (receipts) =>
    reconcileLangGraphThreadReceipts({
      completedDigests: new Map([["document", digest]]),
      nodeIds: new Set(["document", "check", "task"]),
      receipts: new Map(Object.entries(receipts)),
    });
  const completed = { outputDigest: digest, reason: null, status: "completed" };

  assert.deepEqual(reconcile({ document: completed, check: { outputDigest: null, reason: "condition_not_met", status: "skipped" } }), {
    behind: false,
    derived: new Map([["check", { outputDigest: null, reason: "condition_not_met", status: "skipped" }]]),
    ok: true,
    reason: null,
  });
  assert.deepEqual(reconcile({}), { behind: true, derived: new Map(), ok: true, reason: null });
  assert.equal(reconcile({ document: { ...completed, status: "reused" } }).ok, true);
  assert.equal(reconcile({ document: { ...completed, outputDigest: "v1:sha256:other" } }).reason, "completed_receipt_digest_mismatch");
  assert.equal(reconcile({ document: { ...completed, reason: "x" } }).reason, "completed_receipt_digest_mismatch");
  assert.equal(reconcile({ check: completed }).reason, "completed_receipt_without_checkpoint");
  assert.equal(reconcile({ document: { outputDigest: null, reason: null, status: "skipped" } }).reason, "completed_receipt_digest_mismatch");
  assert.equal(reconcile({ check: { outputDigest: null, reason: null, status: "failed" } }).reason, "failed_receipt");
  assert.equal(reconcile({ other: completed }).reason, "receipt_for_unknown_node");
  assert.equal(reconcile({ check: { status: "skipped" } }).reason, "invalid_receipt");
  assert.equal(reconcile({ check: { outputDigest: null, reason: null, status: "exploded" } }).reason, "invalid_receipt");
});

// ---------------------------------------------------------------------------
// Cancellation: the drain inside the unified graph
// ---------------------------------------------------------------------------

test("parity: a request cancelled inside the unified graph stops at the next node boundary with the native codes", async () => {
  for (const [reason, status, code] of [
    [REQUEST_CANCELLATION_REASONS.deadlineExceeded, "failed", "AGENT_DEADLINE_EXCEEDED"],
    [REQUEST_CANCELLATION_REASONS.clientCancelled, "canceled", "AGENT_CLIENT_CANCELLED"],
  ]) {
    const outcomes = {};

    for (const runtime of RUNTIMES) {
      const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });
      const store = newStore();
      const agentRunService = newService(store);
      // The request is cancelled while the primary document call is in
      // flight; the mock call completes regardless (as a Capability write
      // would), so the run stops at the next safe point: the evidence check.
      const ragService = createDocumentLoopRagService({
        onChat: async ({ phase }) => {
          if (phase === "primary") {
            cancellation.cancel(reason);
          }
        },
        primary: "supported",
      });
      const outcome = await settle(
        runWithRequestCancellation(cancellation, () =>
          onRuntime(runtime, () =>
            runAgentRag({
              accessScope,
              agentRunService,
              docIds: [UNIFIED_DOC_ID],
              question: DOCUMENT_LOOP_QUESTION,
              ragService,
              sessionId: UNIFIED_SESSION_ID,
              unifiedGraphPlannerAdapter: createProposalAdapter(createDocumentLoopProposal),
              userId: accessScope.userId,
            })
          )
        )
      );
      cancellation.dispose();

      assert.ok(isRequestCancelledError(outcome.error), `${runtime}/${reason}: ${outcome.error?.message}`);
      assert.equal(outcome.error.reason, reason, runtime);
      assert.equal(outcome.error.code, code, runtime);
      const runId = outcome.error.agentRunId;
      const { checkpoint, run } = await load(agentRunService, runId);

      assert.equal(run.status, status, runtime);
      assert.deepEqual(
        { code: run.error.code, reason: run.error.reason, retryable: run.error.retryable },
        { code, reason, retryable: reason === REQUEST_CANCELLATION_REASONS.deadlineExceeded },
        runtime
      );
      // The primary node settled (its step, trace and checkpoint written);
      // nothing after it started.
      assert.deepEqual(
        run.steps.map((step) => [step.input?.nodeId, step.status]),
        [["primary", "completed"]],
        runtime
      );
      assert.deepEqual(checkpoint.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]), [["primary", "completed"]]);
      assert.equal(checkpoint.phase, "running");
      assert.equal(ragService.calls.length, 1, runtime);
      assert.equal(run.events.some((event) => event.type === "manual_recovery_required"), false);
      // A terminal run carries no thread: failRun dropped it in the CAS that
      // failed (or cancelled) the run.
      assert.equal(await rawRecord(store, runId), null, `${runtime}/${reason}`);
      outcomes[runtime] = { checkpoint: mask(checkpoint), error: mask(outcome.error), run: mask(run) };
    }

    assert.deepEqual(outcomes.langgraph, outcomes.native, reason);
  }
});

// The task depends on the document answer only and is declared after the
// evidence check, so both are ready in the same pass (one superstep); the
// task is not parallel-safe, so it waits until the check has settled.
const createTaskQueuedBehindCheckProposal = () => {
  const [documentNode, checkNode, taskNode] = createApprovalGatedTaskProposal().nodes;
  const { when, ...unconditionalTask } = taskNode;

  return { nodes: [documentNode, checkNode, { ...unconditionalTask, dependsOn: ["document"] }] };
};

// Counts the Capability preflights of task.create: the registry reads the
// graph-approval preflight makes (resolveCapability), told apart from the
// catalog's and admission's reads by the preflight's frame on the stack.
const countTaskPreflights = (registry) => {
  const counter = { count: 0 };

  counter.registry = new Proxy(registry, {
    get(target, property) {
      const value = target[property];

      if (property === "get") {
        return (capabilityId, ...rest) => {
          if (capabilityId === "task.create" && /preflightCapabilityGraphApproval/.test(new Error().stack)) {
            counter.count += 1;
          }
          return value.call(target, capabilityId, ...rest);
        };
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return counter;
};

test("parity: an exclusive approval-gated Capability queued behind a running sibling is never preflighted, parked or charged once the request is cancelled", async () => {
  // Ported from the phase-0 spike. The cancellation arrives while the check
  // is in flight and the task waits for it (natively in the queue, on
  // LangGraph at the concurrency gate). The request's error is the answer,
  // never an approval pause: the task passes the launch safe point first
  // (agent-execution-graph-node.js runs throwIfRequestCancelled before
  // preflightNode), so it is not preflighted, parked, stepped or charged.
  const run = async (runtime, { cancelReason = null } = {}) => {
    const store = newStore();
    const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });
    let checkStepId = null;
    const { service: agentRunService } = createCrashingRunService(newService(store), {
      // Never crashes: only observes the check's step completing, while its
      // node is still in flight (its checkpoint not yet saved).
      crashAfter: (method, args) => {
        if (method === "recordRunStep" && args.status === "running" && args.input?.nodeId === "evidence_check") {
          checkStepId = args.stepId;
        }
        if (cancelReason && method === "recordRunStep" && args.status === "completed" && args.stepId === checkStepId) {
          cancellation.cancel(cancelReason);
        }
        return false;
      },
    });
    const ragService = createDocumentLoopRagService({ primary: "supported" });
    const { registry, writes } = await createTaskCapabilityRegistry({ ragService });
    const preflights = countTaskPreflights(registry);
    const outcome = await settle(
      runWithRequestCancellation(cancellation, () =>
        onRuntime(runtime, () =>
          runAgentRag({
            accessScope,
            agentRunService,
            capabilityRegistry: preflights.registry,
            docIds: [UNIFIED_DOC_ID],
            question: APPROVAL_TASK_QUESTION,
            ragService,
            sessionId: UNIFIED_SESSION_ID,
            unifiedGraphAllowedCapabilityIds: ["task.create"],
            unifiedGraphPlannerAdapter: createProposalAdapter(createTaskQueuedBehindCheckProposal),
            userId: accessScope.userId,
          })
        )
      )
    );
    cancellation.dispose();
    const runId = outcome.value?.body?.agentRunId ?? outcome.error?.agentRunId ?? null;

    return { ...(await load(newService(store), runId)), outcome, preflights: preflights.count, runId, store, writes };
  };

  for (const [reason, status, code] of [
    [REQUEST_CANCELLATION_REASONS.deadlineExceeded, "failed", "AGENT_DEADLINE_EXCEEDED"],
    [REQUEST_CANCELLATION_REASONS.clientCancelled, "canceled", "AGENT_CLIENT_CANCELLED"],
  ]) {
    const outcomes = {};

    for (const runtime of RUNTIMES) {
      // Not vacuous: uncancelled, the same graph preflights the task (in the
      // node, then again to bind the gate; the counter sees both registry
      // reads of each) and parks it.
      const control = await run(runtime);
      assert.equal(control.outcome.error, null, `${runtime}: ${control.outcome.error?.message}`);
      assert.equal(control.outcome.value.body.clarification.reason, "capability_approval_required", runtime);
      assert.equal(control.preflights, 4, runtime);
      assert.equal(control.checkpoint.phase, "awaiting_approval", runtime);

      const cancelled = await run(runtime, { cancelReason: reason });
      const where = `${runtime}/${reason}`;

      assert.ok(isRequestCancelledError(cancelled.outcome.error), `${where}: ${cancelled.outcome.error?.message}`);
      assert.equal(cancelled.outcome.error.code, code, where);
      assert.equal(cancelled.run.status, status, where);
      // The task was never preflighted, so never parked: no gate, no gate
      // event, and the run is not waiting for anyone.
      assert.equal(cancelled.preflights, 0, where);
      assert.deepEqual(cancelled.run.approvalGates ?? [], [], where);
      assert.equal(cancelled.run.events.some((event) => event.type === "graph_approval_gate_created"), false, where);
      // Nor started or charged: no step, no node run (budget is reserved in
      // the node's lifecycle), no write. The check settled first.
      assert.deepEqual(
        cancelled.run.steps.map((step) => [step.input?.nodeId, step.status]),
        [["document", "completed"], ["evidence_check", "completed"]],
        where
      );
      assert.deepEqual(
        cancelled.checkpoint.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
        [["document", "completed"], ["evidence_check", "completed"]],
        where
      );
      assert.equal(cancelled.checkpoint.phase, "running", where);
      assert.equal(cancelled.writes.length, 0, where);
      assert.equal(await rawRecord(cancelled.store, cancelled.runId), null, where);
      outcomes[runtime] = {
        checkpoint: mask(cancelled.checkpoint),
        error: mask(cancelled.outcome.error),
        run: mask(cancelled.run),
      };
    }

    assert.deepEqual(outcomes.langgraph, outcomes.native, reason);
  }
});

test("parity: a dependency outage inside the primary node fails the run with the native code on both runtimes, and the thread is dropped", async () => {
  const outcomes = {};

  for (const runtime of RUNTIMES) {
    const store = newStore();
    const agentRunService = newService(store);
    const ragService = createDocumentLoopRagService({
      onChat: async ({ phase }) => {
        if (phase === "primary") {
          const error = new Error("gateway down");
          error.code = "MODEL_GATEWAY_UNAVAILABLE";
          error.status = 503;
          error.retryAfterSeconds = 7;
          throw error;
        }
      },
      primary: "supported",
    });
    const outcome = await settle(
      onRuntime(runtime, () =>
        runAgentRag({
          accessScope,
          agentRunService,
          docIds: [UNIFIED_DOC_ID],
          question: DOCUMENT_LOOP_QUESTION,
          ragService,
          sessionId: UNIFIED_SESSION_ID,
          unifiedGraphPlannerAdapter: createProposalAdapter(createDocumentLoopProposal),
          userId: accessScope.userId,
        })
      )
    );

    assert.equal(outcome.error?.code, "AGENT_DEPENDENCY_UNAVAILABLE", `${runtime}: ${outcome.error?.message}`);
    assert.equal(outcome.error.status, 503, runtime);
    const runId = outcome.error.agentRunId;
    const { checkpoint, run } = await load(agentRunService, runId);

    assert.equal(run.status, "failed", runtime);
    assert.equal(run.error.code, "AGENT_DEPENDENCY_UNAVAILABLE", runtime);
    assert.deepEqual(checkpoint.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]), [["primary", "failed"]]);
    assert.equal(checkpoint.phase, "running");
    assert.equal(await rawRecord(store, runId), null, runtime);
    outcomes[runtime] = { checkpoint: mask(checkpoint), error: mask(outcome.error), run: mask(run) };
  }

  assert.deepEqual(outcomes.langgraph, outcomes.native);
});

// ---------------------------------------------------------------------------
// Approval: independent work in later layers (the native pause point)
// ---------------------------------------------------------------------------

test("hasExecutionGraphWorkBeforePause: a pending node of a later layer that does not depend on the parked node", () => {
  const state = (nodeId, dependsOn, status = "pending") => ({ node: { dependsOn, nodeId }, status });
  const layered = {
    layers: [["document"], ["task", "evidence_check"], ["follow_up"], ["follow_up_check"]],
  };
  const states = [
    state("document", [], "completed"),
    state("task", ["document"]),
    state("evidence_check", ["document"]),
    state("follow_up", ["evidence_check"]),
    state("follow_up_check", ["follow_up"]),
  ];

  // follow_up and follow_up_check are later layers independent of task.
  assert.equal(hasExecutionGraphWorkBeforePause({ compiled: layered, nodeId: "task", states }), true);
  // The same layer (evidence_check) alone is not: it is in the superstep.
  assert.equal(
    hasExecutionGraphWorkBeforePause({
      compiled: { layers: [["document"], ["task", "evidence_check"]] },
      nodeId: "task",
      states: states.slice(0, 3),
    }),
    false
  );
  // A later layer that depends on the parked node waits natively too.
  assert.equal(
    hasExecutionGraphWorkBeforePause({
      compiled: { layers: [["document"], ["task"], ["after_task"]] },
      nodeId: "task",
      states: [state("document", [], "completed"), state("task", ["document"]), state("after_task", ["task"])],
    }),
    false
  );
  // Through any node: a dependant of a dependant is a dependant.
  assert.equal(
    hasExecutionGraphWorkBeforePause({
      compiled: { layers: [["task"], ["mid"], ["leaf"]] },
      nodeId: "task",
      states: [state("task", []), state("mid", ["task"]), state("leaf", ["mid"])],
    }),
    false
  );
  // Settled nodes (reused, skipped) of later layers are not work.
  assert.equal(
    hasExecutionGraphWorkBeforePause({
      compiled: layered,
      nodeId: "task",
      states: [
        ...states.slice(0, 3),
        state("follow_up", ["evidence_check"], "reused"),
        state("follow_up_check", ["follow_up"], "skipped"),
      ],
    }),
    false
  );
  // Dependencies are matched by the validator's trimmed id.
  assert.equal(
    hasExecutionGraphWorkBeforePause({
      compiled: { layers: [["task"], ["leaf"]] },
      nodeId: "task",
      states: [state("task", []), state("leaf", [" task "])],
    }),
    false
  );
  assert.throws(
    () => hasExecutionGraphWorkBeforePause({ compiled: layered, nodeId: "intruder", states }),
    TypeError
  );
});

test("parity: a gated task with independent work in later layers pauses after that work on both runtimes; LangGraph persists that pause natively and drops its thread", async () => {
  const paused = {};

  for (const runtime of RUNTIMES) {
    const context = await askOn(runtime, {
      primary: "unsupported",
      proposal: createTaskWithIndependentLaterWorkProposal,
      ragOptions: { followUp: "resolves" },
    });

    assert.equal(context.error, null, `${runtime}: ${context.error?.message}`);
    assert.equal(context.response.body.clarification.reason, "capability_approval_required", runtime);
    assert.equal(context.writes.length, 0, runtime);
    // The follow-up retrieval ran before the pause, as it does natively.
    assert.deepEqual(context.ragService.calls.map((call) => call.phase), ["primary", "follow_up"], runtime);
    paused[runtime] = { context, outcome: await describeOutcome(context) };
  }

  assert.deepEqual(paused.langgraph.outcome, paused.native.outcome);
  assert.equal(paused.native.outcome.run.status, "waiting_for_user");
  assert.equal(paused.native.outcome.checkpoint.phase, "awaiting_approval");
  assert.deepEqual(
    paused.native.outcome.checkpoint.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    [["document", "completed"], ["evidence_check", "completed"], ["follow_up", "completed"], ["follow_up_check", "completed"]]
  );
  assert.equal(paused.native.outcome.response.body.agentObservability.budget.used.documentRagCalls, 2);
  // On LangGraph the parked node returned its receipt instead of
  // interrupting (later layers still had work), the executor dropped the
  // thread, and the pause was persisted natively: no thread to resume.
  assert.equal(await rawRecord(paused.langgraph.context.store, paused.langgraph.context.runId), null);
  assert.equal(await readThread(paused.langgraph.context.agentRunService, paused.langgraph.context.runId), null);
  assert.equal(paused.langgraph.outcome.run.events.at(-1).type, "graph_approval_gate_created");

  // Approve: a fresh invocation seeded from the checkpoint on LangGraph (the
  // settled nodes entered as reused, no pause and no resume on the new
  // thread), the same run as native.
  const approved = {};

  for (const runtime of RUNTIMES) {
    const probe = createThreadProbe();
    const context = await askOn(runtime, {
      onWrite: probe.onWrite,
      primary: "unsupported",
      proposal: createTaskWithIndependentLaterWorkProposal,
      ragOptions: { followUp: "resolves" },
    });
    probe.context = context;
    const service = newService(context.store);
    const result = await decideOn(runtime, { action: "approve", context, service });

    assert.equal(result.run.status, "completed", runtime);
    assert.equal(context.writes.length, 1, runtime);
    assert.equal(context.ragService.calls.length, 2, runtime);
    assert.equal(await rawRecord(context.store, context.runId), null, runtime);
    approved[runtime] = {
      decision: maskRunBound({ response: result.response, status: result.status }),
      outcome: await describeOutcome({ ...context, agentRunService: service, response: null }, maskRunBound),
      probe,
    };
  }

  assert.deepEqual(approved.langgraph.decision, approved.native.decision);
  assert.deepEqual(approved.langgraph.outcome, approved.native.outcome);
  assert.deepEqual(
    approved.native.outcome.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    // Declaration order: the task was declared right after the document.
    [
      ["document", "reused"],
      ["task", "completed"],
      ["evidence_check", "reused"],
      ["follow_up", "reused"],
      ["follow_up_check", "reused"],
    ]
  );
  assert.deepEqual(approved.native.probe.seen, [null]);
  // Seen from inside the write, on the new thread: the document node of the
  // superstep before the task's came back as reused (a resumed thread would
  // still hold it as completed), the task's own superstep is not committed
  // yet, and there is no pause and no resume.
  const [seen] = approved.langgraph.probe.seen;
  assert.equal(seen.receipts.document, "reused");
  assert.equal(Object.hasOwn(seen.receipts, "task"), false);
  assert.ok(Object.values(seen.receipts).every((status) => status === "reused"));
  assert.deepEqual(seen.interrupts, []);
  assert.deepEqual(seen.resumeWrites, []);

  // Deny: the parked node settles as approval_denied, identically.
  const denied = {};

  for (const runtime of RUNTIMES) {
    const context = await askOn(runtime, {
      primary: "unsupported",
      proposal: createTaskWithIndependentLaterWorkProposal,
      ragOptions: { followUp: "resolves" },
    });
    const service = newService(context.store);
    const result = await decideOn(runtime, { action: "deny", context, service });

    assert.equal(result.run.status, "completed", runtime);
    assert.equal(context.writes.length, 0, runtime);
    assert.equal(await rawRecord(context.store, context.runId), null, runtime);
    denied[runtime] = {
      decision: mask({ response: result.response, status: result.status }),
      outcome: await describeOutcome({ ...context, agentRunService: service, response: null }),
    };
  }

  assert.deepEqual(denied.langgraph.decision, denied.native.decision);
  assert.deepEqual(denied.langgraph.outcome, denied.native.outcome);
  assert.deepEqual(
    denied.native.outcome.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status, nodeRun.reason]),
    [
      ["document", "reused", null],
      ["task", "skipped", "approval_denied"],
      ["evidence_check", "reused", null],
      ["follow_up", "reused", null],
      ["follow_up_check", "reused", null],
    ]
  );
});

// ---------------------------------------------------------------------------
// Recovery: what the thread read may and may not turn into a manual mark
// ---------------------------------------------------------------------------

test("startup recovery marks a run manual only for a record the saver refuses; a transient read fault propagates and leaves the run resumable", async () => {
  // A malformed record (another writer touched the private key): unreadable,
  // the run goes to an operator with that reason, nothing is claimed.
  const malformed = await askOn("langgraph");
  await approveThenCrashBeforeTask(malformed);
  const raw = await malformed.store.get({ accessScope, runId: malformed.runId });
  await malformed.store.update({
    accessScope,
    expectedRevision: raw.revision,
    patch: { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: { format: "not-a-saver-record" } } },
    runId: malformed.runId,
  });
  const unreadable = await verifyLangGraphThreadForRecovery({
    accessScope,
    agentRunService: malformed.agentRunService,
    checkpoint: (await load(malformed.agentRunService, malformed.runId)).checkpoint,
    runId: malformed.runId,
  });
  assert.deepEqual(unreadable, {
    detail: LANGGRAPH_SAVER_ERROR_CODES.invalidRecord,
    ok: false,
    reason: LANGGRAPH_RECOVERY_REASONS.threadUnreadable,
  });
  const malformedOutcome = await recoverOn("langgraph", { context: malformed });
  const malformedAfter = await load(malformed.agentRunService, malformed.runId);
  assert.equal(malformedOutcome.manualRecoveredCount, 1);
  assert.equal(malformedOutcome.autoRecoveredCount, 0);
  assert.equal(malformedAfter.run.result.recovery.reason, LANGGRAPH_RECOVERY_REASONS.threadUnreadable);
  assert.equal(malformedAfter.checkpoint.resumeClaim, null);
  assert.equal(malformed.writes.length, 0);

  // A store fault while reading the thread (an outage, a pool timeout): the
  // read throws like every other pre-claim read of the scan, the run is not
  // marked manual, and the next startup recovers it.
  const faulty = await askOn("langgraph");
  await approveThenCrashBeforeTask(faulty);
  let faults = 0;
  const faultingService = new Proxy(newService(faulty.store), {
    get(target, property) {
      if (property === "getLangGraphCheckpointRecord") {
        return async () => {
          faults += 1;
          const error = new Error("connection reset");
          error.code = "ECONNRESET";
          throw error;
        };
      }

      return typeof target[property] === "function" ? target[property].bind(target) : target[property];
    },
  });

  await assert.rejects(
    verifyLangGraphThreadForRecovery({
      accessScope,
      agentRunService: faultingService,
      checkpoint: (await load(faulty.agentRunService, faulty.runId)).checkpoint,
      runId: faulty.runId,
    }),
    (error) => error.code === "ECONNRESET"
  );
  await assert.rejects(
    recoverOn("langgraph", { context: faulty, service: faultingService }),
    (error) => error.code === "ECONNRESET"
  );
  assert.equal(faults, 2);
  const faultyAfter = await load(faulty.agentRunService, faulty.runId);
  assert.equal(faultyAfter.run.result?.recovery?.mode ?? null, null);
  assert.equal(faultyAfter.run.events.some((event) => event.type === "manual_recovery_required"), false);
  assert.equal(faultyAfter.checkpoint.resumeClaim, null);
  // The store is back: the same run is recovered once, as it would be at
  // the next startup.
  assert.equal((await recoverOn("langgraph", { context: faulty })).autoRecoveredCount, 1);
  assert.equal(faulty.writes.length, 1);
});

test("a failed receipt agrees with a checkpoint that holds the node as failed, and contradicts one that does not", () => {
  const failed = { outputDigest: null, reason: null, status: "failed" };
  const reconcile = (receipts, failedNodeIds) =>
    reconcileLangGraphThreadReceipts({
      completedDigests: new Map(),
      ...(failedNodeIds ? { failedNodeIds } : {}),
      nodeIds: new Set(["document", "check"]),
      receipts: new Map(Object.entries(receipts)),
    });

  assert.deepEqual(reconcile({ check: failed }, new Set(["check"])), {
    behind: false,
    derived: new Map(),
    ok: true,
    reason: null,
  });
  assert.equal(reconcile({ check: failed }).reason, LANGGRAPH_THREAD_RECONCILIATION_REASONS.failedReceipt);
  assert.equal(reconcile({ check: failed }, new Set(["document"])).reason, LANGGRAPH_THREAD_RECONCILIATION_REASONS.failedReceipt);
  // A failed receipt carries no reason and no digest.
  assert.equal(
    reconcile({ check: { ...failed, reason: "x" } }, new Set(["check"])).reason,
    LANGGRAPH_THREAD_RECONCILIATION_REASONS.failedReceipt
  );
});

test("parity: a gated task whose graph then fails a later node is abandoned, never approved or run, identically on both runtimes", async () => {
  // Ported from the phase-0 spike, whose own runner settled this case
  // differently from native (a pinned divergence). Production schedules the
  // parked node's end with the native tail (finishExecutionGraphRun): a graph
  // that already failed a node never asks the user to approve more work, so
  // the parked task is skipped, no gate is persisted, and the run fails as
  // partial, with the same run, steps, events and checkpoint on both
  // runtimes. On LangGraph the parked node returned its receipt (later layers
  // still had work), and the settling save left no thread.
  const failingFollowUp = async ({ phase }) => {
    if (phase === "follow_up") {
      throw Object.assign(new Error("The follow-up model refused the request."), { status: 400 });
    }
  };
  const outcomes = {};

  for (const runtime of RUNTIMES) {
    const context = await askOn(runtime, {
      primary: "unsupported",
      proposal: createTaskWithIndependentLaterWorkProposal,
      ragOptions: { onChat: failingFollowUp },
    });
    // The 409 carries no run id: the run is the store's only one.
    const [{ runId }] = (await context.agentRunService.listRuns({ accessScope })).runs ??
      (await context.agentRunService.listRuns({ accessScope }));
    const located = { ...context, runId };

    assert.equal(context.error?.code, "AGENT_UNIFIED_GRAPH_PARTIAL", runtime);
    assert.equal(context.writes.length, 0, runtime);
    assert.deepEqual(context.ragService.calls.map((call) => call.phase), ["primary", "follow_up"], runtime);
    outcomes[runtime] = {
      outcome: await describeOutcome(located),
      raw: await rawRecord(context.store, runId),
    };
  }

  assert.deepEqual(outcomes.langgraph.outcome, outcomes.native.outcome);

  const { checkpoint, run } = outcomes.native.outcome;

  assert.equal(run.status, "failed");
  assert.equal(checkpoint.phase, "partial");
  assert.deepEqual(
    checkpoint.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    [
      ["document", "completed"],
      ["task", "skipped"],
      ["evidence_check", "completed"],
      ["follow_up", "failed"],
      ["follow_up_check", "skipped"],
    ]
  );
  assert.deepEqual(run.approvalGates ?? [], []);
  // The document's node step exists; the task's never opened.
  const stepIdOf = (nodeId) => buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId });
  assert.equal(run.steps.some((step) => step.id === stepIdOf("document")), true);
  assert.equal(run.steps.some((step) => step.id === stepIdOf("task")), false);
  assert.equal(outcomes.native.raw, null);
  assert.equal(outcomes.langgraph.raw, null);
});

// ---------------------------------------------------------------------------
// The request's async context on LangGraph (ported from the phase-0 spike)
// ---------------------------------------------------------------------------

// What the code at `where` sees of the stores a request binds before the
// agent runs (auth.js bindDatabaseTenant, routes/chat.js
// runAgentRequestWithCancellation and its event sink; agent.js binds the run
// usage itself). The probe event goes to whichever sink is bound there, so
// sink identity is checked by where the event lands.
let alsProbeSequence = 0;
const observeAls = (where) => {
  alsProbeSequence += 1;
  const probeId = `als-probe-${alsProbeSequence}`;
  emitAgentEvent({ probeId, type: "als_probe", where });

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

const createRequestStack = ({ label, scope }) => {
  const sinkEvents = [];
  const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 10 * 60 * 1000 });
  const sink = (event) => sinkEvents.push(event);
  const observations = [];

  return {
    cancellation,
    label,
    observations,
    observe: (where) => observations.push(observeAls(where)),
    run: (callback) =>
      runWithDatabaseTenant(scope, () =>
        runWithRequestCancellation(cancellation, () => runWithAgentEventSink(sink, callback))
      ),
    scope,
    sinkEvents,
  };
};

// `detachedDeadline`: a Capability that writes the workspace runs outside the
// request's deadline once started (request-deadline.js, "What is
// cancelled"), so it sees no deadline and no signal, by design.
const assertSeesOwnStack = (observation, stack, others, { detachedDeadline = false } = {}) => {
  const where = `${observation.where} under ${stack.label}`;

  assert.deepStrictEqual(observation.tenant, toDatabaseTenant(stack.scope), `tenant at ${where}`);
  assert.equal(observation.signal, detachedDeadline ? null : stack.cancellation.signal, `signal at ${where}`);
  assert.equal(
    observation.deadlineAt,
    detachedDeadline ? null : stack.cancellation.store.deadlineAt,
    `deadline at ${where}`
  );
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

// Every call the run service makes to the store, observed where it is made
// (the saver's thread writes included), with the arguments it names: the
// call's own access scope is what attributes it to a request, so the ambient
// context seen there is checked against it, never chosen by it.
const createObservedStore = (store, observe) => {
  const observed = {};

  for (const [name, value] of Object.entries(store)) {
    observed[name] = typeof value === "function"
      ? (...args) => {
          observe(`store:${name}`, args[0]);
          return value.apply(store, args);
        }
      : value;
  }

  return observed;
};

// Counts every way this process could reach the network; the assertion is
// that there are none. syncBuiltinESMExports carries the patched properties
// to ESM named imports of the builtins.
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

// Resolves once `count` callers arrived, so their work provably overlapped.
const createArrivalBarrier = (count) => {
  let arrived = 0;
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });

  return {
    arrive() {
      arrived += 1;
      if (arrived === count) {
        open();
      }
      return opened;
    },
    get arrived() {
      return arrived;
    },
  };
};

test("on LangGraph each request's tenant, deadline, event sink and run usage reach every node, Skill call, Capability write and thread write, two tenants' overlapping graphs never share them, and an approval continues under its own request", async () => {
  // Not vacuous: outside a request nothing is bound.
  const outside = observeAls("outside");
  assert.deepStrictEqual(
    [outside.tenant, outside.usage, outside.signal, outside.deadlineAt, outside.hasSink],
    [null, null, null, null, false]
  );

  const store = newStore();
  const tenants = [
    { label: "alice", scope: accessScope },
    { label: "bob", scope: { userId: "unified-bob", workspaceId: accessScope.workspaceId } },
  ];
  const chatBarrier = createArrivalBarrier(tenants.length);
  const writeBarrier = createArrivalBarrier(tenants.length);
  // The stack of the request a store call belongs to: each call is
  // attributed by the access scope it names (the run service passes the
  // request's scope explicitly), not by the ambient tenant. The ambient
  // context there -- tenant, deadline, signal, sink -- is then checked
  // against that request's own stack (assertSeesOwnStack below), so a
  // context swapped between the two overlapping requests at a saver write
  // fails the test instead of being attributed to the other request.
  const stacksByTenant = new Map();
  const unattributedStoreCalls = [];
  const storeTenantMismatches = [];
  // Every LangGraph thread record a write hands the store, by the tenant the
  // write names, copied at write time (the settling save drops the record).
  const threadRecordsByTenant = new Map();
  const observeStore = (where, args) => {
    const callScope = args?.accessScope ?? null;
    const slot = stacksByTenant.get(callScope?.userId);

    if (!slot) {
      // A store call that names no tenant, or an unknown one: it would be a leak.
      unattributedStoreCalls.push(where);
      return;
    }

    if (!isDeepStrictEqual(getActiveDatabaseTenant(), toDatabaseTenant(callScope))) {
      storeTenantMismatches.push({ ambient: getActiveDatabaseTenant(), named: callScope.userId, where });
    }
    slot.current.observe(where);

    const record = args?.patch?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY];

    if (record !== null && record !== undefined) {
      threadRecordsByTenant.get(callScope.userId).push(structuredClone(record));
    }
  };
  const agentRunStore = createObservedStore(store, observeStore);
  const sameScope = (scope, expected) =>
    scope?.userId === expected.userId && scope?.workspaceId === expected.workspaceId;

  const contexts = await Promise.all(
    tenants.map(async ({ label, scope }) => {
      const pause = createRequestStack({ label: `${label}:pause`, scope });
      const approve = createRequestStack({ label: `${label}:approve`, scope });
      const slot = { current: pause };
      stacksByTenant.set(scope.userId, slot);
      threadRecordsByTenant.set(scope.userId, []);
      const base = createDocumentLoopRagService({
        onChat: async ({ phase }) => {
          slot.current.observe(`chat:${phase}`);
          // Both tenants' document nodes are in flight at once.
          await chatBarrier.arrive();
          slot.current.observe(`chat-after-barrier:${phase}`);
        },
        primary: "supported",
      });
      const ragService = {
        ...base,
        getDocument: (docId, requested) =>
          sameScope(requested, scope) && docId === UNIFIED_DOC_ID
            ? { docId, fileName: UNIFIED_FILE_NAME }
            : null,
        listDocuments: (requested) =>
          sameScope(requested, scope) ? [{ docId: UNIFIED_DOC_ID, fileName: UNIFIED_FILE_NAME }] : [],
      };
      const { registry, writes } = await createTaskCapabilityRegistry({
        onWrite: async () => {
          slot.current.observe("capability:write");
          await writeBarrier.arrive();
        },
        ragService,
      });

      return { approve, base, label, pause, ragService, registry, scope, slot, writes };
    })
  );

  const { calls, result } = await withNetworkSpy(() =>
    onRuntime("langgraph", async () => {
      // Both requests park at the task's gate, their graphs overlapping.
      const paused = await Promise.all(
        contexts.map((context) =>
          context.pause.run(() =>
            runAgentRag({
              accessScope: context.scope,
              agentRunService: newService(agentRunStore),
              capabilityRegistry: context.registry,
              docIds: [UNIFIED_DOC_ID],
              question: APPROVAL_TASK_QUESTION,
              ragService: context.ragService,
              sessionId: UNIFIED_SESSION_ID,
              unifiedGraphAllowedCapabilityIds: ["task.create"],
              unifiedGraphPlannerAdapter: createProposalAdapter(createApprovalGatedTaskProposal),
              userId: context.scope.userId,
            })
          )
        )
      );

      for (const context of contexts) {
        context.slot.current = context.approve;
      }

      // Both approvals, each a new request on a new run service, continue
      // their own graph at the same time.
      const approved = await Promise.all(
        contexts.map((context, index) => {
          const service = newService(agentRunStore);
          const gate = paused[index].body.approvalGates[0];

          return context.approve.run(() =>
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
              accessScope: context.scope,
              action: "approve",
              gateId: gate.id,
              payload: { approvalObjectHash: gate.approvalObjectHash },
              runId: paused[index].body.agentRunId,
            })
          );
        })
      );

      return { approved, paused };
    })
  );

  // Not one network call: LangGraph and LangChain neither trace nor phone
  // home on their own.
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(unattributedStoreCalls, []);
  // At every store call the ambient database tenant is the tenant the call
  // names (the thread writes included).
  assert.deepStrictEqual(storeTenantMismatches, []);
  assert.equal(chatBarrier.arrived, tenants.length);
  assert.equal(writeBarrier.arrived, tenants.length);

  for (const [index, context] of contexts.entries()) {
    const others = contexts
      .filter((_, otherIndex) => otherIndex !== index)
      .flatMap((other) => [other.pause, other.approve]);
    const { approved, paused } = result;

    assert.equal(paused[index].body.clarification.reason, "capability_approval_required", context.label);
    assert.equal(approved[index].run.status, "completed", context.label);
    assert.equal(context.writes.length, 1, context.label);

    const pauseWheres = context.pause.observations.map((observation) => observation.where);
    const approveWheres = context.approve.observations.map((observation) => observation.where);

    // The document node ran in the first request, the Capability in the
    // second, and both requests wrote the run, the thread included.
    assert.deepEqual(
      pauseWheres.filter((where) => where.startsWith("chat")),
      ["chat:primary", "chat-after-barrier:primary"],
      context.label
    );
    assert.equal(approveWheres.some((where) => where.startsWith("chat")), false, context.label);
    assert.deepEqual(approveWheres.filter((where) => where.startsWith("capability")), ["capability:write"]);
    assert.ok(pauseWheres.includes("store:update"), `${context.label}: the thread writes`);
    assert.ok(approveWheres.some((where) => where.startsWith("store:")), context.label);

    // One run usage per request, the same in every node and write of it.
    for (const stack of [context.pause, context.approve]) {
      const usages = new Set(
        stack.observations
          .filter((observation) => !observation.where.startsWith("store:"))
          .map((observation) => observation.usage)
      );
      assert.equal(usages.size, 1, stack.label);
      assert.notEqual([...usages][0], null, stack.label);
    }
    assert.notEqual(
      context.pause.observations.find((observation) => observation.where === "chat:primary").usage,
      context.approve.observations.find((observation) => observation.where === "capability:write").usage
    );

    for (const observation of context.pause.observations) {
      assertSeesOwnStack(observation, context.pause, [...others, context.approve]);
    }
    for (const observation of context.approve.observations) {
      assertSeesOwnStack(observation, context.approve, [...others, context.pause], {
        detachedDeadline: observation.where === "capability:write",
      });
    }
  }

  // Each tenant's thread records belong to its own run and hold nothing of
  // the other tenant's: not its user id, not its run id.
  for (const [index, context] of contexts.entries()) {
    const runId = result.paused[index].body.agentRunId;
    const records = threadRecordsByTenant.get(context.scope.userId);
    const [other] = contexts.filter((_, otherIndex) => otherIndex !== index);
    const otherRunId = result.paused[contexts.indexOf(other)].body.agentRunId;

    assert.ok(records.length > 0, `${context.label} wrote its thread`);
    for (const record of records) {
      assert.deepStrictEqual(record.owner, { runId, userId: context.scope.userId, workspaceId: context.scope.workspaceId });
      assertNoText(record, [other.scope.userId, otherRunId]);
    }
  }

  // The tenants' usages are their own.
  assert.notEqual(
    contexts[0].pause.observations.find((observation) => observation.where === "chat:primary").usage,
    contexts[1].pause.observations.find((observation) => observation.where === "chat:primary").usage
  );

  for (const context of contexts) {
    context.pause.cancellation.dispose();
    context.approve.cancellation.dispose();
  }
});

// ---------------------------------------------------------------------------
// Finalization replay: no scheduler on either runtime
// ---------------------------------------------------------------------------

// The stage rebuilds a settled graph's receipts with replayExecutionGraphRun
// (agent-execution-graph-runner.js) on both runtimes; it used to run the
// native scheduler for it, also on LangGraph. Every settled shape of one
// five-node v3 graph, in each of the 120 declaration orders, with a `when`
// that holds or not and with or without a denied node: the replay returns
// the native scheduler's result and records the same skips, and touches no
// other hook. A graph with a node still to run is refused before any hook.
test("replayExecutionGraphRun settles every settled graph exactly as the native scheduler does, and launches nothing", async () => {
  const permutations = (items) =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
            item,
            ...rest,
          ])
        );
  const replayDocIds = ["doc-a"];
  const skills = ["a", "b", "c", "d", "e"].map((nodeId) => ({
    ...CUSTOM_RAG_SKILL_CONTRACT,
    budgetKey: "customSkillCalls",
    execute: async ({ docIds }) => ({
      abstained: false,
      citations: [{ docId: docIds[0], page: 1 }],
      text: `${nodeId} answered.`,
    }),
    id: `replay_${nodeId}`,
    kind: "custom",
    label: `replay_${nodeId}`,
    match: () => true,
    requiresAccessScope: true,
    version: "1.0.0",
  }));
  const registry = createSkillRegistry(skills);
  const request = (field) => ({ field, source: "request" });
  // c runs only while a did not abstain (`equals`), d only after c, e after
  // a and b (b may be denied).
  const createNodes = (equals) => ({
    a: { dependsOn: [] },
    b: { dependsOn: [] },
    c: { dependsOn: ["a"], when: { equals, nodeId: "a", output: "abstained" } },
    d: { dependsOn: ["c"] },
    e: { dependsOn: ["a", "b"] },
  });
  const createGraph = (declared, equals) => {
    const nodes = createNodes(equals);

    return createExecutionGraph({
      nodes: declared.map((nodeId) => ({
        ...nodes[nodeId],
        failurePolicy: "fail_fast",
        inputBindings: { docIds: request("docIds"), question: request("question") },
        nodeId,
        skillId: `replay_${nodeId}`,
      })),
      version: "v3",
    });
  };
  const replayGuard = ({ nodeId } = {}) => {
    const error = new Error(`replay would launch ${nodeId}`);
    error.code = "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY";
    return error;
  };
  const baseOptions = (graph) => ({
    accessScope,
    authorizedDocIds: replayDocIds,
    authorizedSkillIds: skills.map((skill) => skill.id),
    docIds: replayDocIds,
    graph,
    graphResumeClaimId: "claim-1",
    question: "What do the documents say?",
    registry,
    sessionId: "session-1",
    userId: accessScope.userId,
  });
  // Every hook a scheduler may call, logged in call order.
  const createHooks = () => {
    const log = [];
    const record = (name) => (...args) => {
      log.push([name, ...args]);
    };
    const refuse = (name) => async (...args) => {
      log.push([name, ...args]);
      throw replayGuard({ nodeId: args[0]?.node?.nodeId ?? null });
    };
    const lifecycleMethod = (name) => async (step) => {
      log.push([name, step]);
      return { stepId: step.id };
    };

    return {
      hooks: {
        addBudgetLimitTrace: record("addBudgetLimitTrace"),
        addTraceStep: record("addTraceStep"),
        budgetState: createAgentBudget({ maxCustomSkillCalls: 8 }),
        executeObservedSkill: refuse("executeObservedSkill"),
        onNodeSettled: async (...args) => {
          log.push(["onNodeSettled", ...args]);
        },
        pauseForApproval: refuse("pauseForApproval"),
        preflightNode: refuse("preflightNode"),
        recordSkillResult: record("recordSkillResult"),
        recordSkippedSkill: record("recordSkippedSkill"),
        stepLifecycle: Object.fromEntries(
          ["completeGraphStep", "failGraphStep", "pauseGraphStep", "startGraphStep"].map(
            (name) => [name, lifecycleMethod(name)]
          )
        ),
      },
      log,
    };
  };
  // Everything but the run meter's wall-clock start.
  const budgetUsage = ({ limits, run, used }) => ({ limits, runUsed: run?.used, used });
  let settledShapes = 0;
  let refusals = 0;

  for (const declared of permutations(["a", "b", "c", "d", "e"])) {
    for (const equals of [false, true]) {
      for (const deniedNodeIds of [[], ["b"]]) {
        const label = `${declared.join(",")}/when=${equals}/denied=${deniedNodeIds.join(",") || "-"}`;
        const graph = createGraph(declared, equals);
        const budgetState = createAgentBudget({ maxCustomSkillCalls: 8 });
        const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
        // The graph as it first ran: its completed receipts are what a
        // completed checkpoint stores.
        const original = await runExecutionGraph({
          ...baseOptions(graph),
          budgetState,
          deniedNodeIds,
          executeObservedSkill: tracker.executeObservedSkill,
          graphResumeClaimId: undefined,
          stepLifecycle: createAgentRunStepLifecycle(),
        });
        assert.equal(original.status, "completed", label);
        const completedNodeRuns = original.nodeRuns
          .filter((nodeRun) => nodeRun.status === "completed")
          .map(snapshotExecutionGraphNodeRun);

        // As the stage replays it, before and after.
        const native = createHooks();
        const nativeResult = await runExecutionGraph({
          ...baseOptions(graph),
          ...native.hooks,
          completedNodeRuns,
          deniedNodeIds,
        });
        const replay = createHooks();
        const { executeObservedSkill, onNodeSettled, pauseForApproval, preflightNode, ...replayHooks } =
          replay.hooks;
        const replayResult = replayExecutionGraphRun({
          ...baseOptions(graph),
          ...replayHooks,
          completedNodeRuns,
          deniedNodeIds,
          refuseLaunch: replayGuard,
        });

        assert.deepEqual(replayResult, nativeResult, label);
        assert.deepEqual(replay.log, native.log, label);
        assert.deepEqual(budgetUsage(replay.hooks.budgetState), budgetUsage(native.hooks.budgetState), label);
        assert.ok(
          native.log.every(([name]) => name === "recordSkippedSkill"),
          `${label}: only skips are recorded`
        );
        assert.deepEqual(
          replayResult.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
          declared.map((nodeId) => {
            if (deniedNodeIds.includes(nodeId)) {
              return [nodeId, "skipped", "approval_denied"];
            }
            if (nodeId === "e" && deniedNodeIds.length > 0) {
              return [nodeId, "skipped", "dependency_skipped"];
            }
            if (equals && nodeId === "c") {
              return [nodeId, "skipped", "condition_not_met"];
            }
            if (equals && nodeId === "d") {
              return [nodeId, "skipped", "dependency_skipped"];
            }
            return [nodeId, "reused", null];
          }),
          label
        );
        settledShapes += 1;

        // A "completed" checkpoint without the receipt of a node that must
        // run: both refuse it; the replay before any hook.
        const missing = equals ? "a" : "d";
        const incomplete = completedNodeRuns.filter((nodeRun) => nodeRun.nodeId !== missing);
        const refusedNatively = createHooks();
        const refusedReplay = createHooks();

        await assert.rejects(
          runExecutionGraph({
            ...baseOptions(graph),
            ...refusedNatively.hooks,
            completedNodeRuns: incomplete,
            deniedNodeIds,
          }),
          (error) => error.code === "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY",
          label
        );
        assert.throws(
          () =>
            replayExecutionGraphRun({
              ...baseOptions(graph),
              ...refusedReplay.hooks,
              completedNodeRuns: incomplete,
              deniedNodeIds,
              refuseLaunch: replayGuard,
            }),
          (error) =>
            error.code === "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" &&
            error.message === `replay would launch ${missing}`,
          label
        );
        assert.ok(
          refusedReplay.log.every(([name]) => name === "recordSkippedSkill"),
          `${label}: the refused replay reached no hook but skips`
        );
        assert.deepEqual(
          budgetUsage(refusedReplay.hooks.budgetState),
          budgetUsage(createAgentBudget({ maxCustomSkillCalls: 8 })),
          label
        );
        refusals += 1;
      }
    }
  }

  assert.equal(settledShapes, 480);
  assert.equal(refusals, 480);
});

const findOnlyRunId = async (store) => {
  const listed = await store.list({ accessScope });
  const [{ runId }] = listed?.runs ?? listed;

  return runId;
};

const crashBeforeFinalizationReceipt = (store) =>
  createCrashingRunService(newService(store), {
    crashBefore: (method, args) =>
      method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
  });

// What a node that ran again would change. The finalization binds each step
// to its trace step (traceStepId, detail.traceStatus) and is not a re-run.
const graphNodeSteps = (run) =>
  run.steps
    .filter((step) => step.type === "graph_node")
    .map(({ attempt, completedAt, error, id, input, output, startedAt, status }) => ({
      attempt,
      completedAt,
      error,
      id,
      input,
      output,
      startedAt,
      status,
    }));

test("parity: a graph that completed before its finalization receipt is replayed without a scheduler on both runtimes: skips re-derived, nothing re-run, no thread", async () => {
  const documentLoop = {
    proposal: createDocumentLoopProposal,
    question: DOCUMENT_LOOP_QUESTION,
    withCapability: false,
  };
  const scenarios = [
    // The check passed: follow_up is condition_not_met and follow_up_check
    // dependency_skipped, both re-derived by the replay.
    ["follow-up not needed", { ...documentLoop, primary: "supported" }, null, [
      ["primary", "reused", null],
      ["primary_check", "reused", null],
      ["follow_up", "skipped", "condition_not_met"],
      ["follow_up_check", "skipped", "dependency_skipped"],
    ]],
    ["follow-up resolved", { ...documentLoop, primary: "unsupported" }, null, [
      ["primary", "reused", null],
      ["primary_check", "reused", null],
      ["follow_up", "reused", null],
      ["follow_up_check", "reused", null],
    ]],
    ["approved gate", {}, "approve", [
      ["document", "reused", null],
      ["evidence_check", "reused", null],
      ["task", "reused", null],
    ]],
    ["denied gate", {}, "deny", [
      ["document", "reused", null],
      ["evidence_check", "reused", null],
      ["task", "skipped", "approval_denied"],
    ]],
  ];

  for (const [label, options, action, replayedNodeRuns] of scenarios) {
    const outcomes = {};

    for (const runtime of RUNTIMES) {
      const store = newStore();
      let context;

      if (action) {
        context = await askOn(runtime, { ...options, store });
        assert.equal(context.error, null, `${label}/${runtime}: ${context.error?.message}`);
        const decided = await settle(
          decideOn(runtime, { action, context, service: crashBeforeFinalizationReceipt(store).service })
        );
        assert.equal(decided.error?.code, "SIMULATED_PROCESS_EXIT", `${label}/${runtime}`);
      } else {
        context = await askOn(runtime, {
          ...options,
          agentRunService: crashBeforeFinalizationReceipt(store).service,
          store,
        });
        assert.equal(context.error?.code, "SIMULATED_PROCESS_EXIT", `${label}/${runtime}`);
        context = { ...context, runId: await findOnlyRunId(store) };
      }

      const before = await load(newService(store), context.runId);
      const ragCalls = context.ragService.calls.length;
      const writes = context.writes.length;

      assert.equal(before.run.status, "running", `${label}/${runtime}`);
      assert.equal(before.checkpoint.phase, "completed", `${label}/${runtime}`);
      assert.equal(before.checkpoint.finalization, undefined, `${label}/${runtime}`);

      const service = newService(store);
      const recovered = await recoverOn(runtime, { context, service });
      const after = await load(service, context.runId);

      assert.equal(recovered.autoRecoveredCount, 1, `${label}/${runtime}: ${JSON.stringify(recovered)}`);
      assert.equal(recovered.manualRecoveredCount, 0, `${label}/${runtime}`);
      assert.ok(after.checkpoint.finalization, `${label}/${runtime}`);
      // Nothing ran again: no document call, no Capability write, and the
      // graph's node steps are the ones the crashed process wrote.
      assert.equal(context.ragService.calls.length, ragCalls, `${label}/${runtime}`);
      assert.equal(context.writes.length, writes, `${label}/${runtime}`);
      assert.deepEqual(graphNodeSteps(after.run), graphNodeSteps(before.run), `${label}/${runtime}`);
      assert.equal(await rawRecord(store, context.runId), null, `${label}/${runtime}`);
      const executed = after.run.events.filter((event) => event.type === "unified_graph_executed");
      assert.equal(executed.at(-1).payload.replayed, true, `${label}/${runtime}`);
      assert.deepEqual(
        executed.at(-1).payload.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
        replayedNodeRuns,
        `${label}/${runtime}`
      );
      outcomes[runtime] = await describeOutcome(
        { ...context, agentRunService: service, error: null, response: null },
        maskRunBound
      );
    }

    assert.deepEqual(outcomes.langgraph, outcomes.native, label);
  }
});
