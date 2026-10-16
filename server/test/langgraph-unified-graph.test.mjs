// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-spike/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";

import { uuid6 } from "@langchain/langgraph-checkpoint";

import { continueAgentExecutionGraphApproval, resumeAgentExecutionGraphRun, runAgentRag } from "../rag/agent.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
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
  REQUEST_CANCELLATION_REASONS,
  createRequestCancellation,
  isRequestCancelledError,
  runWithRequestCancellation,
} from "../rag/request-deadline.js";
import { createDefaultSkillRegistry } from "../rag/skills/registry.js";
import { createUnifiedGraphEvidenceGatedSkillCase } from "../evaluation/trajectory/cases/unified-graph.js";
import { createUnifiedGraphApprovalGatedActionCase } from "../evaluation/trajectory/cases/unified-graph-approval.js";
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
  createTaskBeforeIndependentCheckProposal,
  createTaskCapabilityRegistry,
  createTaskWithIndependentLaterWorkProposal,
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
    withCapability = true,
  } = {}
) => {
  const agentRunService = newService(store);
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
  assert.equal(await withEnv({ AGENT_RUNTIME: undefined }, () => getAgentRuntime()), "native");
  assert.equal(await withEnv({ AGENT_RUNTIME: "langgraph" }, () => getAgentRuntime()), "langgraph");
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
  // not know it exists, and recovery runs the approved node once.
  const native = await askOn("langgraph");
  await approveThenCrashBeforeTask(native);
  await forgeThreadReceipts(native, (receipts) => ({
    ...receipts,
    "node:document": { ...receipts["node:document"], outputDigest: `v1:sha256:${"0".repeat(64)}` },
  }));
  const nativeOutcome = await recoverOn("native", { context: native });
  assert.equal(nativeOutcome.autoRecoveredCount, 1);
  assert.equal(native.writes.length, 1);

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
