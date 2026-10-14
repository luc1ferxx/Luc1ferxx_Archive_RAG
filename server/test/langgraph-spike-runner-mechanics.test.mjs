import "./langgraph-spike/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";

import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { createEvidenceGatedSkillProposal } from "../evaluation/trajectory/cases/unified-graph.js";
import {
  EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY,
  buildExecutionGraphNodeStepId,
  digestExecutionGraphTypedOutput,
  sealExecutionGraphCheckpoint,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  createRequestCancellation,
  isRequestCancelledError,
  runWithRequestCancellation,
} from "../rag/request-deadline.js";
import { createConcurrencyGate } from "./langgraph-spike/execution-graph-langgraph-runner.mjs";
import {
  ACCESS_SCOPE,
  EFFECT_PUBLIC_GATE,
  EFFECT_SKILL_ID,
  PRIVATE_TEXTS,
  QUESTION,
  RISK_PROMPT_PATTERN,
  RUN_ID,
  claimGraphResume,
  createEffectApproval,
  createEffectHarness,
  createEffectLedger,
  createEffectProposal,
  createParallelProposal,
  createVendorHarness,
  maskTimingFields,
  runLangGraphStage,
  runNativeStage,
  serializeMemorySaver,
  withVendorCaseEnvironment,
} from "./langgraph-spike/vendor-case.mjs";

// Phase-0 LangGraph spike, not the production path: the runner's own
// guarantees on the vendor case's graph (document -> evidence_check ->
// risk_review) and on an approval-gated Capability behind the document node.
// A drain stops at a node boundary, an abort never executes a node twice, a
// continuation needs its resume claim and passes the recovery assessor,
// unknown in-flight work is never replayed, an approval interrupt is the first
// effect of its node and only a decision bound to the gate it showed counts,
// and the concurrency gate keeps the native cap and the native safe point. A
// "new process" here is a fresh harness (budget, tracker, mocks) on the same
// run store and the same MemorySaver. Every wait is a deferred promise.

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const stepIdOf = (nodeId) => buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId });
const statusesOf = (outcome) =>
  outcome.run.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]);
const receiptsIn = async (checkpointer, threadId) =>
  (await checkpointer.getTuple({ configurable: { thread_id: threadId } }))?.checkpoint
    .channel_values.receipts ?? null;
const stepsOf = (outcome) => outcome.steps.map(({ id, status }) => [id, status]);

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

const resumeIn = (previous, options = {}) =>
  createVendorHarness({ agentRunService: previous.harness.agentRunService, createRun: false, ...options });

// --- Cancellation at a node boundary -----------------------------------------

for (const { cancellation, code, reason } of [
  { cancellation: "drain", code: "AGENT_DEADLINE_EXCEEDED", reason: "deadline_exceeded" },
  { cancellation: "signal", code: "AGENT_CLIENT_CANCELLED", reason: "client_cancelled" },
]) {
  test(`${cancellation}: a request cancelled inside a node stops the graph, the started step settles, and only a claimed resume continues it without running the node again`, async () => {
    const checkpointer = new MemorySaver();
    const threadId = `langgraph-spike:mechanics:${cancellation}`;
    const hold = holdDocumentCall();
    const request = createRequestCancellation();
    const firstEvents = [];
    const entered = [];
    const pending = withVendorCaseEnvironment(() =>
      runWithRequestCancellation(request, () =>
        runLangGraphStage({
          cancellation,
          checkpointer,
          onChat: hold.onChat,
          onNodeEnter: ({ nodeId }) => entered.push(nodeId),
          onNodeEvent: (event) => firstEvents.push(event),
          threadId,
        })
      )
    );

    await hold.entered;
    request.cancel(reason);
    hold.release();
    const stopped = await pending;

    assert.ok(isRequestCancelledError(stopped.error), stopped.error?.stack);
    assert.equal(stopped.error.code, code);
    // The node in flight finished: its step and its checkpoint entry exist.
    // Nothing after it started.
    assert.deepStrictEqual(stepsOf(stopped), [[stepIdOf("document"), "completed"]]);
    assert.equal(stopped.checkpoint.phase, "running");
    assert.deepStrictEqual(
      stopped.checkpoint.nodeRuns.map(({ nodeId, status }) => [nodeId, status]),
      [["document", "completed"]]
    );
    assert.deepStrictEqual(
      firstEvents.map(({ nodeId, phase }) => [nodeId, phase]),
      [["document", "start"], ["document", "settle"]]
    );
    // Under drain, RunControl stopped LangGraph before the next superstep:
    // evidence_check's node function was never even entered (its node-entry
    // safe point is a separate stop, pinned without RunControl below). Under
    // signal, LangGraph rejected the invoke while document still ran.
    assert.deepStrictEqual(entered, ["document"]);
    assert.equal(stopped.chatCalls.length, 1);
    assert.equal(stopped.budget.documentRagCalls, 1);

    // What LangGraph kept differs by mode: a drain checkpoints the finished
    // node's receipt; an abort discards the in-flight node's writes, so
    // LangGraph will run that node again.
    const receipts = await receiptsIn(checkpointer, threadId);
    if (cancellation === "drain") {
      assert.deepStrictEqual(Object.keys(receipts), ["document"]);
    } else {
      assert.deepStrictEqual(receipts, {});
    }

    // An unclaimed continuation is refused, as recovery work the stage never
    // hands back to V1, and runs nothing.
    const unclaimed = await withVendorCaseEnvironment(() =>
      runLangGraphStage({ cancellation, checkpointer, harness: resumeIn(stopped), threadId })
    );
    assert.equal(unclaimed.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
    assert.equal(unclaimed.error.preExecution, false);
    assert.equal(unclaimed.tenantObservations.length, 0);

    const resumedWorld = resumeIn(stopped);
    const claimId = await claimGraphResume(resumedWorld.agentRunService);
    assert.ok(claimId);
    const resumedEvents = [];
    const resumed = await withVendorCaseEnvironment(() =>
      runLangGraphStage({
        cancellation,
        checkpointer,
        graphResumeClaimId: claimId,
        harness: resumedWorld,
        onNodeEvent: (event) => resumedEvents.push(event),
        threadId,
      })
    );

    assert.equal(resumed.error, null, resumed.error?.stack);
    assert.deepStrictEqual(statusesOf(resumed), [
      ["document", "reused", null],
      ["evidence_check", "completed", null],
      ["risk", "completed", null],
    ]);
    // The resume made only the risk call: the document answer was executed
    // once across both processes, and its step was started once.
    assert.equal(resumed.chatCalls.length, 1);
    assert.match(resumed.chatCalls[0].question, RISK_PROMPT_PATTERN);
    assert.deepStrictEqual(
      resumed.steps.map(({ attempt, id, status }) => [id, status, attempt]),
      [
        [stepIdOf("document"), "completed", 1],
        [stepIdOf("evidence_check"), "completed", 1],
        [stepIdOf("risk"), "completed", 1],
      ]
    );
    assert.deepStrictEqual(
      resumed.tenantObservations.map((observation) => observation.skillId),
      ["document_evidence_check", "risk_review"]
    );
    // The fresh process's budget was charged the document call from the
    // checkpoint, not again.
    assert.equal(resumed.budget.documentRagCalls, 1);
    assert.equal(resumed.budget.customSkillCalls, 1);
    assert.equal(resumed.checkpoint.phase, "completed");
    assert.equal(resumed.checkpoint.resumeClaim.claimId, claimId);
    assert.ok(resumed.collected);

    if (cancellation === "drain") {
      assert.deepStrictEqual(
        resumedEvents.map(({ nodeId, phase }) => [nodeId, phase]),
        [["evidence_check", "start"], ["evidence_check", "settle"], ["risk", "start"], ["risk", "settle"]]
      );
    } else {
      // LangGraph did run the document node again; the run store answered.
      assert.deepStrictEqual(resumedEvents[0], {
        nodeId: "document",
        phase: "settle",
        status: "reused",
      });
      assert.equal(resumedEvents.some((event) => event.nodeId === "document" && event.phase === "start"), false);
    }
  });
}

test("drain without RunControl: the next node is entered and stops at a node safe point, starting nothing, and the claimed resume runs it", async () => {
  const checkpointer = new MemorySaver();
  const threadId = "langgraph-spike:mechanics:drain-entry-only";
  const hold = holdDocumentCall();
  const request = createRequestCancellation();
  const events = [];
  const entered = [];
  const pending = withVendorCaseEnvironment(() =>
    runWithRequestCancellation(request, () =>
      runLangGraphStage({
        cancellation: "drain",
        checkpointer,
        drainThroughRunControl: false,
        onChat: hold.onChat,
        onNodeEnter: ({ nodeId }) => entered.push(nodeId),
        onNodeEvent: (event) => events.push(`${event.nodeId}:${event.phase}`),
        threadId,
      })
    )
  );

  await hold.entered;
  request.cancel("deadline_exceeded");
  hold.release();
  const stopped = await pending;

  assert.ok(isRequestCancelledError(stopped.error), stopped.error?.stack);
  assert.equal(stopped.error.code, "AGENT_DEADLINE_EXCEEDED");
  // LangGraph did schedule evidence_check this time; the safe point at its
  // entry stopped it before anything: no start, no step, no budget, no call.
  assert.deepStrictEqual(entered, ["document", "evidence_check"]);
  assert.deepStrictEqual(events, ["document:start", "document:settle"]);
  assert.deepStrictEqual(stepsOf(stopped), [[stepIdOf("document"), "completed"]]);
  assert.equal(stopped.budget.customSkillCalls, 0);
  assert.equal(stopped.tenantObservations.length, 1);
  // A drain, not a node error: document's receipt was checkpointed and
  // evidence_check left no receipt, so LangGraph runs it on resume.
  assert.deepStrictEqual(Object.keys(await receiptsIn(checkpointer, threadId)), ["document"]);
  assert.equal(serializeMemorySaver(checkpointer).includes("__error__"), false);

  const resumedWorld = resumeIn(stopped);
  const claimId = await claimGraphResume(resumedWorld.agentRunService);
  const resumed = await withVendorCaseEnvironment(() =>
    runLangGraphStage({ checkpointer, graphResumeClaimId: claimId, harness: resumedWorld, threadId })
  );

  assert.equal(resumed.error, null, resumed.error?.stack);
  assert.deepStrictEqual(statusesOf(resumed), [
    ["document", "reused", null],
    ["evidence_check", "completed", null],
    ["risk", "completed", null],
  ]);
  assert.equal(resumed.chatCalls.length, 1);
});

test("drain without RunControl: the node-entry safe point stops a node before its skip decision, so a cancelled request never settles more of the graph", async () => {
  // Insufficient evidence: risk would be skipped on its condition. The
  // request is cancelled while evidence_check is executed but unsettled, so
  // risk is scheduled in the next superstep and entered after the cancel.
  const checkpointer = new MemorySaver();
  const threadId = "langgraph-spike:mechanics:drain-entry-skip";
  const entered = createDeferred();
  const release = createDeferred();
  const request = createRequestCancellation();
  const events = [];
  const nodesEntered = [];
  const pending = withVendorCaseEnvironment(() =>
    runWithRequestCancellation(request, () =>
      runLangGraphStage({
        afterExecute: async ({ skillId }) => {
          if (skillId === "document_evidence_check") {
            entered.resolve();
            await release.promise;
          }
        },
        cancellation: "drain",
        checkpointer,
        documentSufficient: false,
        drainThroughRunControl: false,
        onNodeEnter: ({ nodeId }) => nodesEntered.push(nodeId),
        onNodeEvent: (event) => events.push(`${event.nodeId}:${event.phase}`),
        threadId,
      })
    )
  );

  await entered.promise;
  request.cancel("deadline_exceeded");
  release.resolve();
  const stopped = await pending;

  assert.equal(stopped.error?.code, "AGENT_DEADLINE_EXCEEDED", stopped.error?.stack);
  assert.deepStrictEqual(nodesEntered, ["document", "evidence_check", "risk"]);
  // risk stopped at its entry, before the condition was even read: no skip
  // event, no skipped-skill record, no receipt.
  assert.deepStrictEqual(events, [
    "document:start",
    "document:settle",
    "evidence_check:start",
    "evidence_check:settle",
  ]);
  assert.deepStrictEqual(stopped.skippedSkills, []);
  assert.deepStrictEqual(Object.keys(await receiptsIn(checkpointer, threadId)).sort(), ["document", "evidence_check"]);
  assert.equal(stopped.checkpoint.phase, "running");

  // Pinned divergence: the native scheduler checks cancellation only when it
  // launches a node, so it still records risk's condition_not_met skip and
  // completes the graph here. The spike stops one step earlier; with
  // RunControl (the default) LangGraph never even schedules risk.
  const nativeEntered = createDeferred();
  const nativeRelease = createDeferred();
  const nativeRequest = createRequestCancellation();
  const nativePending = withVendorCaseEnvironment(() =>
    runWithRequestCancellation(nativeRequest, () =>
      runNativeStage({
        afterExecute: async ({ skillId }) => {
          if (skillId === "document_evidence_check") {
            nativeEntered.resolve();
            await nativeRelease.promise;
          }
        },
        documentSufficient: false,
      })
    )
  );
  await nativeEntered.promise;
  nativeRequest.cancel("deadline_exceeded");
  nativeRelease.resolve();
  const native = await nativePending;
  assert.equal(native.error, null, native.error?.stack);
  assert.deepStrictEqual(statusesOf(native), [
    ["document", "completed", null],
    ["evidence_check", "completed", null],
    ["risk", "skipped", "condition_not_met"],
  ]);
  assert.equal(native.checkpoint.phase, "completed");
});

// Two nodes in one superstep: the first has executed (it is past every
// cancellation check of its own, executeAgentSkill's included) but has not
// settled, and the second waits at the runner's gate when the request is
// cancelled.
const holdFirstGraphSkill = () => {
  const entered = createDeferred();
  const release = createDeferred();
  let first = null;

  return {
    afterExecute: async ({ skillId }) => {
      if (skillId === "document_rag" || first !== null) {
        return;
      }
      first = skillId;
      entered.resolve();
      await release.promise;
    },
    entered: entered.promise,
    get first() {
      return first;
    },
    release: () => release.resolve(),
  };
};

for (const cancellation of ["drain", "signal"]) {
  test(`${cancellation}: a node queued at the concurrency gate when the request is cancelled launches nothing, exactly as natively`, async () => {
    const runHeld = async (kind) => {
      const hold = holdFirstGraphSkill();
      const request = createRequestCancellation();
      const entered = [];
      const events = [];
      const pending = withVendorCaseEnvironment(() =>
        runWithRequestCancellation(request, () =>
          kind === "native"
            ? runNativeStage({
                afterExecute: hold.afterExecute,
                maxConcurrency: 1,
                proposal: createParallelProposal(),
              })
            : runLangGraphStage({
                afterExecute: hold.afterExecute,
                cancellation,
                checkpointer: new MemorySaver(),
                maxConcurrency: 1,
                onNodeEnter: ({ nodeId }) => entered.push(nodeId),
                onNodeEvent: (event) => events.push(`${event.nodeId}:${event.phase}`),
                proposal: createParallelProposal(),
                threadId: `langgraph-spike:mechanics:gate-cancel:${cancellation}`,
              })
        )
      );

      await hold.entered;
      request.cancel("deadline_exceeded");
      hold.release();
      return { entered, events, first: hold.first, outcome: await pending };
    };

    const native = await runHeld("native");
    const langGraph = await runHeld("langgraph");

    for (const { outcome } of [native, langGraph]) {
      assert.ok(isRequestCancelledError(outcome.error), outcome.error?.stack);
      assert.equal(outcome.error.code, "AGENT_DEADLINE_EXCEEDED");
    }
    assert.equal(native.first, "document_evidence_check");
    assert.equal(langGraph.first, "document_evidence_check");
    // risk was in the same superstep and entered its node function, but it
    // waited for the slot and was admitted only after the cancellation:
    // no start, no budget, no step, the same as the native scheduler.
    assert.deepStrictEqual(langGraph.entered, ["document", "evidence_check", "risk"]);
    assert.deepStrictEqual(langGraph.events, [
      "document:start",
      "document:settle",
      "evidence_check:start",
      "evidence_check:settle",
    ]);
    assert.deepStrictEqual(langGraph.outcome.budget, native.outcome.budget);
    assert.equal(langGraph.outcome.budget.customSkillCalls, 0);
    const byId = (steps) => [...steps].sort((left, right) => left.id.localeCompare(right.id));
    assert.deepStrictEqual(stepsOf({ steps: byId(langGraph.outcome.steps) }), stepsOf({ steps: byId(native.outcome.steps) }));
    assert.equal(langGraph.outcome.steps.some((step) => step.id === stepIdOf("risk")), false);
    assert.deepStrictEqual(
      langGraph.outcome.checkpoint.nodeRuns.map(({ nodeId, status }) => [nodeId, status]),
      native.outcome.checkpoint.nodeRuns.map(({ nodeId, status }) => [nodeId, status])
    );
    assert.deepStrictEqual(
      langGraph.outcome.tenantObservations.map(({ skillId }) => skillId),
      ["document_rag", "document_evidence_check"]
    );
  });

  test(`${cancellation}: an exclusive approval-gated Capability queued behind a running sibling is not preflighted, parked or charged once the request is cancelled`, async () => {
    const ledger = createEffectLedger();
    const decisions = new Map();
    const gate = { gateId: "spike-gate-zeffect", nodeId: "zeffect" };
    const { approval, log } = createEffectApproval(decisions, {
      preflightFor: (nodeId) =>
        nodeId === "zeffect" ? { needsApproval: true, publicPayload: { ...gate } } : null,
    });
    // document -> { evidence_check, zeffect }: one superstep, zeffect not
    // parallel-safe and declared after evidence_check, so it waits for the
    // whole gate while evidence_check executes.
    const [documentNode, evidenceCheckNode] = createEvidenceGatedSkillProposal().nodes;
    const proposal = {
      nodes: [
        documentNode,
        evidenceCheckNode,
        { ...createEffectProposal().nodes[1], nodeId: "zeffect" },
      ],
    };
    const hold = holdFirstGraphSkill();
    const request = createRequestCancellation();
    const events = [];
    const pending = withVendorCaseEnvironment(() =>
      runWithRequestCancellation(request, () =>
        runLangGraphStage({
          approval,
          cancellation,
          checkpointer: new MemorySaver(),
          harness: createEffectHarness({ afterExecute: hold.afterExecute, ledger, proposal }),
          onNodeEvent: (event) => events.push(`${event.nodeId}:${event.phase}`),
          threadId: `langgraph-spike:mechanics:gate-cancel-effect:${cancellation}`,
        })
      )
    );

    await hold.entered;
    request.cancel("deadline_exceeded");
    hold.release();
    const outcome = await pending;

    // The deadline is the answer, never an approval pause.
    assert.ok(isRequestCancelledError(outcome.error), outcome.error?.stack);
    assert.equal(outcome.error.code, "AGENT_DEADLINE_EXCEEDED");
    assert.equal(outcome.interrupted, null);
    assert.equal(hold.first, "document_evidence_check");
    // The preflight ran for the nodes that launched before the cancellation
    // and never for zeffect.
    assert.deepStrictEqual(log.preflights.map(({ nodeId }) => nodeId), ["document", "evidence_check"]);
    assert.deepStrictEqual(log.reads, []);
    assert.equal(events.includes("zeffect:start"), false);
    assert.equal(ledger.calls, 0);
    assert.equal(outcome.budget.customSkillCalls, 0);
    assert.equal(outcome.steps.some((step) => step.id === stepIdOf("zeffect")), false);
    assert.equal(outcome.checkpoint.phase, "running");
  });
}

// --- Continuations: claim, recovery assessor, refusal flags --------------------

test("unknown in-flight work is never replayed: a second worker can neither continue unclaimed, nor claim, nor pass the recovery assessor with a planted claim", async () => {
  const checkpointer = new MemorySaver();
  const threadId = "langgraph-spike:mechanics:in-flight";
  const hold = holdDocumentCall();
  const agentRunStore = createInMemoryAgentRunStore();
  const firstWorld = createVendorHarness({
    agentRunService: createAgentRunService({ agentRunStore }),
    onChat: hold.onChat,
  });
  const pending = withVendorCaseEnvironment(() =>
    runLangGraphStage({ checkpointer, harness: firstWorld, threadId })
  );

  await hold.entered;
  // The first worker is inside the document node; as far as the run store
  // can tell it may have crashed there. A second worker tries to continue
  // the same run on the same thread.
  const intruders = [];
  const intrude = async (graphResumeClaimId) => {
    const outcome = await withVendorCaseEnvironment(() =>
      runLangGraphStage({
        checkpointer,
        graphResumeClaimId,
        harness: resumeIn({ harness: firstWorld }),
        threadId,
      })
    );
    intruders.push(outcome);
    return outcome;
  };

  // (a) Without a claim.
  const unclaimed = await intrude(null);
  assert.equal(unclaimed.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
  assert.match(unclaimed.error.message, /claimed, running v3 recovery boundary/);
  // (b) The run store refuses the claim while a graph step is running.
  assert.equal(await claimGraphResume(firstWorld.agentRunService), null);
  // (c) A claim planted past that refusal (a direct store write, which no
  // run-service path produces): the exported recovery assessor still sees
  // the running step and refuses.
  const raw = agentRunStore.get({ accessScope: ACCESS_SCOPE, runId: RUN_ID });
  const original = raw.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY];
  const write = (checkpoint) => {
    const current = agentRunStore.get({ accessScope: ACCESS_SCOPE, runId: RUN_ID });
    agentRunStore.update({
      accessScope: ACCESS_SCOPE,
      expectedRevision: current.revision,
      patch: { result: { [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: checkpoint } },
      runId: RUN_ID,
    });
  };
  write(updateExecutionGraphCheckpoint(original, {
    resumeClaim: { claimId: "planted-claim", claimedAt: new Date(0).toISOString() },
  }));
  const planted = await intrude("planted-claim");
  assert.equal(planted.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
  assert.match(planted.error.message, /unknown_in_flight_node/);
  // Restore the first worker's graph so it can finish.
  write(original);

  for (const intruder of intruders) {
    assert.equal(intruder.error.preExecution, false);
    assert.equal(intruder.chatCalls.length, 0);
    assert.equal(intruder.tenantObservations.length, 0);
  }

  hold.release();
  const first = await pending;

  assert.equal(first.error, null, first.error?.stack);
  assert.deepStrictEqual(
    first.steps.map(({ attempt, id, status }) => [id, status, attempt]),
    [
      [stepIdOf("document"), "completed", 1],
      [stepIdOf("evidence_check"), "completed", 1],
      [stepIdOf("risk"), "completed", 1],
    ]
  );
  assert.equal(first.chatCalls.length, 2);
});

// The case's graph with every node id prefixed by "n:": the native validator
// accepts it, LangGraph cannot use ":" in a node name.
const renameProposal = (proposal) => {
  const rename = (id) => `n:${id}`;
  return {
    ...proposal,
    nodes: proposal.nodes.map((node) => ({
      ...node,
      dependsOn: (node.dependsOn ?? []).map(rename),
      inputBindings: Object.fromEntries(
        Object.entries(node.inputBindings ?? {}).map(([field, binding]) => [
          field,
          binding.source === "node" ? { ...binding, nodeId: rename(binding.nodeId) } : binding,
        ])
      ),
      nodeId: rename(node.nodeId),
      ...(node.when ? { when: { ...node.when, nodeId: rename(node.when.nodeId) } } : {}),
    })),
  };
};

test("a refusal of a continuation is never a pre-execution refusal: completed nodes stay with the operator, not V1", async () => {
  // A graph the native stage sealed and stopped after its first node.
  const proposal = renameProposal(createEvidenceGatedSkillProposal());
  const hold = holdDocumentCall();
  const request = createRequestCancellation();
  const pending = withVendorCaseEnvironment(() =>
    runWithRequestCancellation(request, () => runNativeStage({ onChat: hold.onChat, proposal }))
  );
  await hold.entered;
  request.cancel("deadline_exceeded");
  hold.release();
  const native = await pending;
  assert.equal(native.error?.code, "AGENT_DEADLINE_EXCEEDED");
  assert.deepStrictEqual(
    native.checkpoint.nodeRuns.map(({ nodeId, status }) => [nodeId, status]),
    [["n:document", "completed"]]
  );

  const continueOnLangGraph = async (options = {}) =>
    withVendorCaseEnvironment(() =>
      runLangGraphStage({
        checkpointer: new MemorySaver(),
        harness: resumeIn(native, { proposal }),
        threadId: "langgraph-spike:mechanics:stored-refusal",
        ...options,
      })
    );

  const claimId = await claimGraphResume(native.harness.agentRunService);
  assert.ok(claimId);
  const refusals = [
    // The same refusal a fresh request would raise as AGENT_..._UNSUPPORTED
    // with preExecution true (see the next test).
    [await continueOnLangGraph({ graphResumeClaimId: claimId }), ["node_name_unsupported"]],
    // Scope and version refusals, which run before anything else.
    [await continueOnLangGraph({ authorizedDocIds: [], graphResumeClaimId: claimId }), ["out_of_scope_document"]],
    [
      await continueOnLangGraph({
        graph: { ...resumeIn(native, { proposal }).graph, version: "v2" },
        graphResumeClaimId: claimId,
      }),
      ["invalid_graph_version"],
    ],
    // No claim at all.
    [await continueOnLangGraph(), undefined],
  ];

  for (const [outcome, reasonCodes] of refusals) {
    assert.equal(outcome.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY", outcome.error?.stack);
    assert.equal(outcome.error.preExecution, false);
    assert.deepStrictEqual(outcome.error.reasonCodes, reasonCodes);
    assert.equal(outcome.chatCalls.length, 0);
    assert.equal(outcome.tenantObservations.length, 0);
  }

  // On a fresh run the same node names are a pre-execution refusal.
  const fresh = await withVendorCaseEnvironment(() =>
    runLangGraphStage({
      checkpointer: new MemorySaver(),
      proposal,
      threadId: "langgraph-spike:mechanics:fresh-refusal",
    })
  );
  assert.equal(fresh.error?.code, "AGENT_LANGGRAPH_NODE_NAME_UNSUPPORTED");
  assert.equal(fresh.error.preExecution, true);
  assert.equal(fresh.checkpoint, null);
});

test("a claimed continuation passes the exported recovery assessor: drifted step input or a changed live Skill contract is refused before anything runs", async () => {
  const stopAfterDocument = async () => {
    const agentRunStore = createInMemoryAgentRunStore();
    const hold = holdDocumentCall();
    const request = createRequestCancellation();
    const checkpointer = new MemorySaver();
    const threadId = "langgraph-spike:mechanics:assessor";
    const harness = createVendorHarness({
      agentRunService: createAgentRunService({ agentRunStore }),
      onChat: hold.onChat,
    });
    const pending = withVendorCaseEnvironment(() =>
      runWithRequestCancellation(request, () =>
        runLangGraphStage({ checkpointer, harness, threadId })
      )
    );
    await hold.entered;
    request.cancel("deadline_exceeded");
    hold.release();
    const stopped = await pending;
    assert.equal(stopped.error?.code, "AGENT_DEADLINE_EXCEEDED");
    return { agentRunStore, checkpointer, stopped, threadId };
  };

  // (a) The document step's persisted input no longer matches what its
  // reused output and the request bind.
  const drifted = await stopAfterDocument();
  const raw = drifted.agentRunStore.get({ accessScope: ACCESS_SCOPE, runId: RUN_ID });
  drifted.agentRunStore.update({
    accessScope: ACCESS_SCOPE,
    expectedRevision: raw.revision,
    patch: {
      steps: raw.steps.map((step) =>
        step.id === stepIdOf("document")
          ? { ...step, input: { ...step.input, question: "A different question." } }
          : step
      ),
    },
    runId: RUN_ID,
  });
  const driftedWorld = resumeIn(drifted.stopped);
  const driftedClaim = await claimGraphResume(driftedWorld.agentRunService);
  assert.ok(driftedClaim);
  const driftedOutcome = await withVendorCaseEnvironment(() =>
    runLangGraphStage({
      checkpointer: drifted.checkpointer,
      graphResumeClaimId: driftedClaim,
      harness: driftedWorld,
      threadId: drifted.threadId,
    })
  );
  assert.equal(driftedOutcome.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
  assert.match(driftedOutcome.error.message, /persisted_input_binding_mismatch/);
  assert.equal(driftedOutcome.tenantObservations.length, 0);

  // (b) The live registry now serves another version of a pending Skill.
  const changed = await stopAfterDocument();
  const changedWorld = resumeIn(changed.stopped);
  const live = changedWorld.graphRegistry;
  const bumped = { ...live.get("risk_review"), version: "99.0.0" };
  const changedClaim = await claimGraphResume(changedWorld.agentRunService);
  assert.ok(changedClaim);
  const changedOutcome = await withVendorCaseEnvironment(() =>
    runLangGraphStage({
      checkpointer: changed.checkpointer,
      graphResumeClaimId: changedClaim,
      harness: {
        ...changedWorld,
        graphRegistry: {
          get: (skillId) => (skillId === "risk_review" ? bumped : live.get(skillId)),
          list: () => live.list().map((skill) => (skill.id === "risk_review" ? bumped : skill)),
        },
      },
      threadId: changed.threadId,
    })
  );
  assert.equal(changedOutcome.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
  assert.match(changedOutcome.error.message, /authorized_registry_contract_mismatch/);
  assert.equal(changedOutcome.tenantObservations.length, 0);
});

// --- Skip receipts from an earlier invocation -----------------------------------

// A run whose LangGraph thread finished but whose final graph checkpoint write
// was lost (a crash right after invoke): the v2 checkpoint is still running.
const finishWithoutFinalWrite = async ({ documentSufficient }) => {
  const agentRunStore = createInMemoryAgentRunStore();
  const service = createAgentRunService({ agentRunStore });
  const lost = new Error("simulated crash before the final graph checkpoint write");
  const harness = createVendorHarness({
    agentRunService: {
      ...service,
      saveExecutionGraphCheckpoint: (args) =>
        args.checkpoint.phase === "completed"
          ? Promise.reject(lost)
          : service.saveExecutionGraphCheckpoint(args),
    },
    documentSufficient,
  });
  const checkpointer = new MemorySaver();
  const threadId = `langgraph-spike:mechanics:lost-final-write:${documentSufficient}`;
  const first = await withVendorCaseEnvironment(() =>
    runLangGraphStage({ checkpointer, harness, threadId })
  );
  assert.equal(first.error, lost);
  assert.equal(first.checkpoint.phase, "running");
  assert.deepStrictEqual((await checkpointer.getTuple({ configurable: { thread_id: threadId } })).checkpoint.channel_values.receipts.risk.status, documentSufficient ? "completed" : "skipped");

  return { agentRunStore, checkpointer, documentSufficient, first, service, threadId };
};

const continueFinished = async ({ checkpointer, documentSufficient, service, threadId }) => {
  const harness = createVendorHarness({ agentRunService: service, createRun: false, documentSufficient });
  const claimId = await claimGraphResume(service);
  assert.ok(claimId);
  return withVendorCaseEnvironment(() =>
    runLangGraphStage({
      checkpointer,
      graphResumeClaimId: claimId,
      harness,
      threadId,
    })
  );
};

test("a skip receipt of an earlier invocation is re-derived from the graph checkpoint: a backed one completes the run, a planted one is refused", async () => {
  // Backed: evidence_check failed, so risk's condition_not_met follows from
  // the reused output. The continuation runs nothing and completes.
  const backed = await finishWithoutFinalWrite({ documentSufficient: false });
  const completed = await continueFinished(backed);
  assert.equal(completed.error, null, completed.error?.stack);
  assert.deepStrictEqual(statusesOf(completed), [
    ["document", "reused", null],
    ["evidence_check", "reused", null],
    ["risk", "skipped", "condition_not_met"],
  ]);
  assert.equal(completed.tenantObservations.length, 0);
  assert.equal(completed.checkpoint.phase, "completed");

  // Planted: the evidence passed and risk never ran (its step and node run
  // are taken out of the run, as if it had not started), but the thread now
  // says risk was skipped on its condition, or denied. Either would finish
  // the run without risk.
  for (const reason of ["condition_not_met", "approval_denied", "dependency_skipped"]) {
    const world = await finishWithoutFinalWrite({ documentSufficient: true });
    const raw = world.agentRunStore.get({ accessScope: ACCESS_SCOPE, runId: RUN_ID });
    const graphCheckpoint = raw.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY];
    world.agentRunStore.update({
      accessScope: ACCESS_SCOPE,
      expectedRevision: raw.revision,
      patch: {
        result: {
          [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: sealExecutionGraphCheckpoint({
            ...graphCheckpoint,
            nodeRuns: graphCheckpoint.nodeRuns.filter((nodeRun) => nodeRun.nodeId !== "risk"),
            sequence: graphCheckpoint.sequence - 1,
          }),
        },
        steps: raw.steps.filter((step) => step.id !== stepIdOf("risk")),
      },
      runId: RUN_ID,
    });
    // Another writer of the thread rewrites its last checkpoint in place.
    const config = { configurable: { checkpoint_ns: "", thread_id: world.threadId } };
    const tuple = await world.checkpointer.getTuple(config);
    const plantedCheckpoint = structuredClone(tuple.checkpoint);
    plantedCheckpoint.channel_values.receipts.risk = { outputDigest: null, reason, status: "skipped" };
    await world.checkpointer.put(tuple.parentConfig, plantedCheckpoint, tuple.metadata, {});
    assert.equal((await world.checkpointer.getTuple(config)).checkpoint.channel_values.receipts.risk.reason, reason);

    const refused = await continueFinished(world);
    assert.equal(refused.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY", `${reason}: ${refused.error?.stack}`);
    assert.match(refused.error.message, /skip receipt the graph checkpoint does not back/);
    assert.equal(refused.tenantObservations.length, 0);
    assert.equal(refused.checkpoint.phase, "running");
  }
});

// --- Approval: an approval-gated Capability behind the document node ---------

const createEffectWorld = ({ ledger, ...options } = {}) =>
  createEffectHarness({ ledger, ...options });

const resumeEffectIn = (paused, ledger) =>
  createEffectHarness({ agentRunService: paused.harness.agentRunService, createRun: false, ledger });

const EFFECT_GATE = Object.freeze({
  ...EFFECT_PUBLIC_GATE,
  inputDigest: digestExecutionGraphTypedOutput({ boundInputs: { question: QUESTION } }),
  nodeId: "effect",
});
const decisionOn = (decision, gate = EFFECT_GATE) => ({ decision, gate: { ...gate } });

const pauseAtEffect = async ({ checkpointer, decisions, ledger, threadId }) => {
  const double = createEffectApproval(decisions);
  const paused = await withVendorCaseEnvironment(() =>
    runLangGraphStage({
      approval: double.approval,
      checkpointer,
      harness: createEffectWorld({ ledger }),
      threadId,
    })
  );

  assert.equal(paused.error, null, paused.error?.stack);
  assert.deepStrictEqual(paused.interrupted, { nodeId: "effect", payload: { ...EFFECT_GATE } });
  assert.equal(paused.run.status, "awaiting_approval");
  assert.deepStrictEqual(statusesOf(paused), [
    ["document", "completed", null],
    ["effect", "awaiting_approval", null],
  ]);
  // interrupt() came before every effect of the gated node: no step, no
  // budget, no execution, and no decision was read at all.
  assert.equal(paused.steps.some((step) => step.id === stepIdOf("effect")), false);
  assert.equal(paused.budget.customSkillCalls, 0);
  assert.equal(ledger.calls, 0);
  assert.deepStrictEqual(double.log.reads, []);
  assert.equal(paused.checkpoint.phase, "running");
  // Sequence 0 is the created checkpoint; the document settle is 1.
  assert.equal(paused.checkpoint.sequence, 1);

  const serialized = serializeMemorySaver(checkpointer);
  assert.ok(serialized.includes("spike-gate-effect"));
  for (const text of PRIVATE_TEXTS) {
    assert.equal(serialized.includes(text), false, `LangGraph persisted private text: ${text}`);
  }

  return paused;
};

const resumeEffect = async ({ approval, checkpointer, claim = true, ledger, paused, threadId, ...options }) => {
  const harness = resumeEffectIn(paused, ledger);
  const graphResumeClaimId = claim ? await claimGraphResume(harness.agentRunService) : null;
  return withVendorCaseEnvironment(() =>
    runLangGraphStage({
      approval,
      checkpointer,
      graphResumeClaimId,
      harness,
      threadId,
      ...options,
    })
  );
};

test("approval: an approved decision bound to the gate shown runs the gated Capability exactly once on a claimed resume", async () => {
  const checkpointer = new MemorySaver();
  const threadId = "langgraph-spike:mechanics:approved";
  const decisions = new Map();
  const ledger = createEffectLedger();
  const paused = await pauseAtEffect({ checkpointer, decisions, ledger, threadId });

  decisions.set("effect", decisionOn("approved", paused.interrupted.payload));
  const double = createEffectApproval(decisions);
  const resumed = await resumeEffect({
    approval: double.approval,
    checkpointer,
    ledger,
    // The operator's live allowlist still holds the Capability.
    liveAllowedCapabilityIds: ["spike.effect"],
    paused,
    threadId,
  });

  assert.equal(resumed.error, null, resumed.error?.stack);
  assert.equal(resumed.interrupted, null);
  assert.deepStrictEqual(statusesOf(resumed), [
    ["document", "reused", null],
    ["effect", "completed", null],
  ]);
  // LangGraph re-ran only the interrupted node, from its first line; its
  // decision was the only one read.
  assert.deepStrictEqual(double.log.preflights.map(({ nodeId }) => nodeId), ["effect"]);
  assert.deepStrictEqual(double.log.reads.map(({ nodeId }) => nodeId), ["effect"]);
  assert.equal(ledger.calls, 1);
  assert.equal(resumed.budget.customSkillCalls, 1);
  assert.equal(resumed.steps.filter((step) => step.id === stepIdOf("effect")).length, 1);
  assert.equal(resumed.checkpoint.phase, "completed");
});

test("approval: a decision not bound to the gate shown, or a resume with none, is refused and runs nothing", async () => {
  const otherInput = digestExecutionGraphTypedOutput({ boundInputs: { question: "Another question?" } });

  for (const [label, recorded, code] of [
    ["no decision", undefined, "graph_approval_missing"],
    ["a bare string", "approved", "graph_approval_invalid_decision"],
    ["another gate id", decisionOn("approved", { ...EFFECT_GATE, gateId: "another-gate" }), "graph_approval_invalid_decision"],
    ["another input", decisionOn("approved", { ...EFFECT_GATE, inputDigest: otherInput }), "graph_approval_invalid_decision"],
    ["another node", decisionOn("approved", { ...EFFECT_GATE, nodeId: "document" }), "graph_approval_invalid_decision"],
  ]) {
    const checkpointer = new MemorySaver();
    const threadId = `langgraph-spike:mechanics:unbound:${label}`;
    const decisions = new Map();
    const ledger = createEffectLedger();
    const paused = await pauseAtEffect({ checkpointer, decisions, ledger, threadId });
    if (recorded !== undefined) {
      decisions.set("effect", recorded);
    }
    const double = createEffectApproval(decisions);
    const resumed = await resumeEffect({ approval: double.approval, checkpointer, ledger, paused, threadId });

    assert.equal(resumed.error?.code, code, `${label}: ${resumed.error?.stack}`);
    assert.equal(ledger.calls, 0, label);
    assert.equal(resumed.steps.some((step) => step.id === stepIdOf("effect")), false, label);
    assert.equal(resumed.budget.customSkillCalls, 0, label);
    assert.equal(resumed.checkpoint.phase, "running", label);
    assert.deepStrictEqual(double.log.reads.map(({ nodeId }) => nodeId), ["effect"], label);
    // LangGraph persisted only the sanitized stop, never the refusal text.
    const serialized = serializeMemorySaver(checkpointer);
    assert.match(serialized, new RegExp(`Graph node effect stopped \\(${code}\\)`), label);
    assert.equal(serialized.includes("must approve or deny the gate"), false, label);
  }
});

test("approval: a parked Capability is never run unapproved, whether the resume lacks the approval hooks, the live preflight stops asking, or the operator revoked it", async () => {
  const checkpointer = new MemorySaver();
  const threadId = "langgraph-spike:mechanics:unapproved";
  const decisions = new Map();
  const ledger = createEffectLedger();
  const paused = await pauseAtEffect({ checkpointer, decisions, ledger, threadId });

  // The same worker retries under its one claim.
  const claimId = await claimGraphResume(paused.harness.agentRunService);
  const retry = (options) =>
    resumeEffect({ checkpointer, claim: false, graphResumeClaimId: claimId, ledger, paused, threadId, ...options });

  // No hooks: a graph with a Capability node never starts without its
  // preflight.
  const withoutHooks = await retry({});
  assert.equal(withoutHooks.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
  assert.deepStrictEqual(withoutHooks.error.reasonCodes, ["capability_without_graph_preflight"]);
  assert.equal(withoutHooks.error.preExecution, false);

  // The live preflight no longer asks (a policy change after the pause) and
  // the decision is approved: the gate the user saw no longer describes
  // this run.
  decisions.set("effect", decisionOn("approved", paused.interrupted.payload));
  const noLongerAsks = await retry({
    approval: { preflight: () => null, readDecision: ({ nodeId }) => decisions.get(nodeId) ?? null },
  });
  assert.equal(noLongerAsks.error?.code, "graph_approval_not_required");

  // The operator's live allowlist no longer holds the Capability.
  const revoked = await retry({
    approval: createEffectApproval(decisions).approval,
    liveAllowedCapabilityIds: [],
  });
  assert.equal(revoked.error?.code, "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY");
  assert.match(revoked.error.message, /no longer on the operator allowlist \(capability:spike\.effect\)/);

  for (const outcome of [withoutHooks, noLongerAsks, revoked]) {
    assert.equal(outcome.steps.some((step) => step.id === stepIdOf("effect")), false);
    assert.equal(outcome.budget.customSkillCalls, 0);
  }
  assert.equal(ledger.calls, 0);
});

test("approval: a denial settles the Capability as approval_denied with no step and no budget, before and whatever its live preflight says", async () => {
  for (const preflightAsks of [true, false]) {
    const checkpointer = new MemorySaver();
    const threadId = `langgraph-spike:mechanics:denied:${preflightAsks}`;
    const decisions = new Map();
    const ledger = createEffectLedger();
    const paused = await pauseAtEffect({ checkpointer, decisions, ledger, threadId });

    decisions.set("effect", decisionOn("denied", paused.interrupted.payload));
    const double = createEffectApproval(decisions, {
      preflightFor: (nodeId) =>
        preflightAsks && nodeId === "effect"
          ? { needsApproval: true, publicPayload: { ...EFFECT_PUBLIC_GATE } }
          : null,
    });
    const resumed = await resumeEffect({ approval: double.approval, checkpointer, ledger, paused, threadId });

    assert.equal(resumed.error, null, resumed.error?.stack);
    assert.deepStrictEqual(statusesOf(resumed), [
      ["document", "reused", null],
      ["effect", "skipped", "approval_denied"],
    ]);
    // Settled on the decision alone: the live preflight never ran.
    assert.deepStrictEqual(double.log.preflights, []);
    assert.equal(ledger.calls, 0);
    assert.equal(resumed.steps.some((step) => step.id === stepIdOf("effect")), false);
    assert.equal(resumed.budget.customSkillCalls, 0);
    assert.equal(resumed.checkpoint.phase, "completed");
    assert.ok(resumed.collected);
    assert.deepStrictEqual((await receiptsIn(checkpointer, threadId)).effect, {
      outputDigest: null,
      reason: "approval_denied",
      status: "skipped",
    });
  }
});

test("approval: a Capability preflight that rejects its bound input fails the node with a failed step and no budget, under its failure policy", async () => {
  const ledger = createEffectLedger();
  const blocked = Object.assign(new Error("The policy blocks this input."), {
    code: "graph_approval_policy_blocked",
  });
  const double = createEffectApproval(new Map(), {
    preflightFor: (nodeId) => (nodeId === "effect" ? { rejectedInput: blocked } : null),
  });
  const checkpointer = new MemorySaver();
  const outcome = await withVendorCaseEnvironment(() =>
    runLangGraphStage({
      approval: double.approval,
      checkpointer,
      harness: createEffectWorld({ ledger }),
      threadId: "langgraph-spike:mechanics:rejected-input",
    })
  );

  // fail_fast effect failed: the run is partial, as natively.
  assert.equal(outcome.error?.code, "AGENT_UNIFIED_GRAPH_PARTIAL");
  assert.deepStrictEqual(
    outcome.error.run.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
    [
      ["document", "completed", null],
      ["effect", "failed", null],
    ]
  );
  assert.equal(ledger.calls, 0);
  assert.equal(outcome.budget.customSkillCalls, 0);
  // agent-execution-graph-runner.js:616-640: the step is started and failed
  // with the rejection; the failure is observed as a skipped-skill record,
  // never as an executed or budgeted call.
  const effectStep = outcome.steps.find((step) => step.id === stepIdOf("effect"));
  assert.equal(effectStep.status, "failed");
  assert.equal(effectStep.error.message, "The policy blocks this input.");
  assert.deepStrictEqual(outcome.skippedSkills, [{ skillId: EFFECT_SKILL_ID, status: "failed" }]);
  assert.equal(outcome.checkpoint.phase, "partial");
  assert.deepStrictEqual((await receiptsIn(checkpointer, "langgraph-spike:mechanics:rejected-input")).effect, {
    outputDigest: null,
    reason: null,
    status: "failed",
  });
});

test("pinned divergence: a parked Capability abandoned after a sibling failed is settled aborted_after_failure, and its dependant is skipped where the native scheduler leaves it pending", async () => {
  // document -> { effect (parked for approval), risk (fails, fail_fast) };
  // zcheck_after depends on effect. A graph that already failed a node never
  // asks the user to approve more work (agent-execution-graph-runner.js
  // 968-976), so the parked effect is settled aborted_after_failure.
  const ledger = createEffectLedger();
  const double = createEffectApproval(new Map());
  const [documentNode, effectNode] = createEffectProposal().nodes;
  const [, evidenceCheckNode, { when: _gate, ...riskNode }] = createEvidenceGatedSkillProposal().nodes;
  const proposal = {
    nodes: [
      documentNode,
      effectNode,
      { ...riskNode, dependsOn: ["document"] },
      { ...evidenceCheckNode, dependsOn: ["document", "effect"], nodeId: "zcheck_after" },
    ],
  };
  const checkpointer = new MemorySaver();
  const threadId = "langgraph-spike:mechanics:abandoned";
  const outcome = await withVendorCaseEnvironment(() =>
    runLangGraphStage({
      approval: double.approval,
      checkpointer,
      harness: createEffectHarness({
        ledger,
        onChat: async ({ kind }) => {
          if (kind === "risk") {
            throw Object.assign(new Error("The risk model refused the request."), { status: 400 });
          }
        },
        proposal,
      }),
      threadId,
    })
  );

  assert.equal(outcome.error?.code, "AGENT_UNIFIED_GRAPH_PARTIAL", outcome.error?.stack);
  assert.equal(outcome.interrupted, null);
  assert.equal(ledger.calls, 0);
  assert.equal(outcome.budget.customSkillCalls, 1);
  assert.deepStrictEqual(
    outcome.error.run.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
    [
      ["document", "completed", null],
      ["effect", "skipped", "aborted_after_failure"],
      ["risk", "failed", null],
      // Native: ["zcheck_after", "pending", null]. The native loop has exited
      // when it settles the parked node, so its dependant was never eligible
      // (agent-execution-graph-runner.js:878-880, 963-976); here LangGraph
      // schedules it once the parked node returns its skip receipt. Both runs
      // are partial; only the persisted node runs differ.
      ["zcheck_after", "skipped", "dependency_skipped"],
    ]
  );
  assert.equal(outcome.checkpoint.phase, "partial");
  assert.deepStrictEqual(
    outcome.checkpoint.nodeRuns.map(({ nodeId, status }) => [nodeId, status]),
    [
      ["document", "completed"],
      ["effect", "skipped"],
      ["risk", "failed"],
      ["zcheck_after", "skipped"],
    ]
  );
  // The parked node was preflighted once, never asked for a decision, and
  // never executed; every node holds a receipt in the thread.
  assert.deepStrictEqual(double.log.preflights.map(({ nodeId }) => nodeId), ["document", "effect", "risk"]);
  assert.deepStrictEqual(double.log.reads, []);
  assert.deepStrictEqual(Object.keys(await receiptsIn(checkpointer, threadId)).sort(), [
    "document",
    "effect",
    "risk",
    "zcheck_after",
  ]);
});

test("only a Capability's preflight may park or reject a node: the same answer for a custom Skill is refused before its budget or step", async () => {
  for (const answer of [
    { needsApproval: true, publicPayload: { gateId: "spike-gate-risk", nodeId: "risk" } },
    { rejectedInput: new Error("not a Capability") },
  ]) {
    const checkpointer = new MemorySaver();
    const threadId = `langgraph-spike:mechanics:custom-skill-grant:${Object.keys(answer)[0]}`;
    const preflights = [];
    const outcome = await withVendorCaseEnvironment(() =>
      runLangGraphStage({
        approval: {
          preflight: ({ node }) => {
            preflights.push(node.nodeId);
            return node.nodeId === "risk" ? answer : null;
          },
          readDecision: () => assert.fail("no decision may be read"),
        },
        checkpointer,
        threadId,
      })
    );

    assert.equal(outcome.error?.code, "graph_preflight_grant_refused");
    assert.equal(outcome.interrupted, null);
    assert.deepStrictEqual(preflights, ["document", "evidence_check", "risk"]);
    assert.equal(outcome.steps.some((step) => step.id === stepIdOf("risk")), false);
    assert.equal(outcome.budget.customSkillCalls, 0);
    assert.equal(outcome.chatCalls.some((call) => RISK_PROMPT_PATTERN.test(call.question)), false);
    const serialized = serializeMemorySaver(checkpointer);
    assert.match(serialized, /Graph node risk stopped \(graph_preflight_grant_refused\)/);
    assert.equal(serialized.includes("__interrupt__"), false);
  }
});

test("a graph with a Capability node is refused before any write when the approval preflight is missing", async () => {
  const ledger = createEffectLedger();
  const checkpointer = new MemorySaver();
  const outcome = await withVendorCaseEnvironment(() =>
    runLangGraphStage({
      checkpointer,
      harness: createEffectWorld({ ledger }),
      threadId: "langgraph-spike:mechanics:no-preflight",
    })
  );

  assert.equal(outcome.error?.code, "AGENT_UNIFIED_GRAPH_APPROVAL_UNAVAILABLE");
  assert.equal(outcome.error.preExecution, true);
  assert.deepStrictEqual(outcome.error.reasonCodes, ["capability_without_graph_preflight"]);
  assert.equal(outcome.checkpoint, null);
  assert.deepStrictEqual(outcome.steps, []);
  assert.equal(outcome.chatCalls.length, 0);
  assert.equal(ledger.calls, 0);
  assert.deepStrictEqual(outcome.events.map((event) => event.type), ["run_created"]);
  assert.deepStrictEqual(Object.keys(checkpointer.storage), []);
});

// --- Concurrency ------------------------------------------------------------------

test("the concurrency gate keeps the native cap, runs a non-parallelSafe node alone, and blocks head-of-line", async () => {
  const gate = createConcurrencyGate(2);
  const order = [];
  const take = (name, exclusive) =>
    gate.acquire({ exclusive }).then((release) => {
      order.push(name);
      return release;
    });

  const releaseA = await take("a", false);
  const releaseB = await take("b", false);
  // The cap is full: c waits; x (exclusive) queues behind c; d behind x.
  const c = take("c", false);
  const x = take("x", true);
  const d = take("d", false);
  await Promise.resolve();
  assert.deepStrictEqual(order, ["a", "b"]);
  assert.equal(gate.waiting, 3);

  releaseA();
  const releaseC = await c;
  assert.deepStrictEqual(order, ["a", "b", "c"]);
  // x needs an empty gate; d, though it would fit, waits behind x.
  assert.equal(gate.active, 2);
  assert.equal(gate.waiting, 2);

  releaseB();
  releaseC();
  const releaseX = await x;
  assert.deepStrictEqual(order, ["a", "b", "c", "x"]);
  assert.equal(gate.active, 1);
  assert.equal(gate.waiting, 1);

  releaseX();
  const releaseD = await d;
  assert.deepStrictEqual(order, ["a", "b", "c", "x", "d"]);
  releaseD();
  assert.equal(gate.active, 0);
  assert.equal(gate.maxActive, 2);
});

test("parallel nodes: the gate overlaps parallelSafe nodes under the default cap and serializes them at maxConcurrency 1, and both match the native runner", async () => {
  const runParallel = async ({ maxConcurrency, overlapBarrier }) => {
    const nodeEvents = [];
    const riskStarted = createDeferred();
    const outcome = await withVendorCaseEnvironment(() =>
      runLangGraphStage({
        // evidence_check may not finish executing until risk has started:
        // only true overlap gets past this.
        beforeExecute: overlapBarrier
          ? async ({ skillId }) => {
              if (skillId === "document_evidence_check") {
                await riskStarted.promise;
              }
            }
          : null,
        checkpointer: new MemorySaver(),
        maxConcurrency,
        onNodeEvent: (event) => {
          nodeEvents.push(event);
          if (event.nodeId === "risk" && event.phase === "start") {
            riskStarted.resolve();
          }
        },
        proposal: createParallelProposal(),
        threadId: `langgraph-spike:mechanics:parallel:${maxConcurrency ?? "default"}`,
      })
    );
    const native = await withVendorCaseEnvironment(() =>
      runNativeStage({ maxConcurrency, proposal: createParallelProposal() })
    );

    assert.equal(outcome.error, null, outcome.error?.stack);
    assert.equal(native.error, null, native.error?.stack);
    assert.deepStrictEqual(statusesOf(outcome), [
      ["document", "completed", null],
      ["evidence_check", "completed", null],
      ["risk", "completed", null],
    ]);
    // Same receipts as the native scheduler (step order inside the shared
    // superstep may interleave differently, so steps compare by id).
    assert.deepStrictEqual(maskTimingFields(outcome.run), maskTimingFields(native.run));
    const byId = (steps) => maskTimingFields([...steps].sort((left, right) => left.id.localeCompare(right.id)));
    assert.deepStrictEqual(byId(outcome.steps), byId(native.steps));
    assert.deepStrictEqual(outcome.budget, native.budget);
    assert.deepStrictEqual(maskTimingFields(outcome.graphRecords), maskTimingFields(native.graphRecords));

    return nodeEvents.map(({ nodeId, phase }) => `${nodeId}:${phase}`);
  };

  const overlapped = await runParallel({ maxConcurrency: undefined, overlapBarrier: true });
  // document (not parallelSafe) ran alone; then both checks were in flight.
  assert.deepStrictEqual(overlapped.slice(0, 2), ["document:start", "document:settle"]);
  assert.ok(overlapped.indexOf("risk:start") < overlapped.indexOf("evidence_check:settle"));

  const serialized = await runParallel({ maxConcurrency: 1, overlapBarrier: false });
  // Every node ran (LangGraph's own maxConcurrency 1 would have lost risk; see
  // the next test), one at a time, in declaration order.
  assert.deepStrictEqual(serialized, [
    "document:start",
    "document:settle",
    "evidence_check:start",
    "evidence_check:settle",
    "risk:start",
    "risk:settle",
  ]);
});

const createWideGraph = ({ calls, failFirst = null }) => {
  const node = (name) => async () => {
    calls[name] = (calls[name] ?? 0) + 1;
    // A real await, so every task is genuinely in flight at once.
    await new Promise((resolve) => setImmediate(resolve));
    if (name === failFirst && calls[name] === 1) {
      throw new Error("first attempt fails");
    }
    return { receipts: { [name]: "ok" } };
  };
  const State = Annotation.Root({
    receipts: Annotation({ default: () => ({}), reducer: (left, right) => ({ ...left, ...right }) }),
  });

  return new StateGraph(State)
    .addNode("a", node("a"))
    .addNode("b", node("b"))
    .addNode("c", node("c"))
    .addNode("d", node("d"))
    .addNode("join", node("join"))
    .addEdge(START, "a")
    .addEdge(START, "b")
    .addEdge(START, "c")
    .addEdge(START, "d")
    .addEdge(["a", "b", "c", "d"], "join")
    .addEdge("join", END)
    .compile({ checkpointer: new MemorySaver() });
};

test("pinned LangGraph 1.5.0 defect: maxConcurrency 1 below a superstep's width ends the step after one task and invoke resolves as if finished", async () => {
  const calls = {};
  const app = createWideGraph({ calls });
  const config = {
    configurable: { thread_id: "langgraph-spike:mechanics:width-1" },
    durability: "sync",
    maxConcurrency: 1,
  };

  const output = await app.invoke({ receipts: {} }, config);

  // b, c, d and join never ran, no error was raised, and even a's receipt is
  // missing from the result.
  assert.deepStrictEqual(calls, { a: 1 });
  assert.deepStrictEqual(output.receipts, {});
  assert.deepStrictEqual((await app.getState(config)).next, ["b", "c", "d"]);
});

test("pinned LangGraph 1.5.0 defect: with maxConcurrency below the width, a failing task gets its unstarted siblings committed as __no_writes__, and a resume never runs them", async () => {
  const run = async (maxConcurrency) => {
    const calls = {};
    const app = createWideGraph({ calls, failFirst: "a" });
    const config = {
      configurable: { thread_id: `langgraph-spike:mechanics:width-fail-${maxConcurrency ?? "none"}` },
      durability: "sync",
      ...(maxConcurrency ? { maxConcurrency } : {}),
    };

    await assert.rejects(app.invoke({ receipts: {} }, config), /first attempt fails/);
    const firstCalls = { ...calls };
    const resumed = await app.invoke(null, config);
    return { calls, firstCalls, resumed, next: (await app.getState(config)).next };
  };

  const throttled = await run(2);
  assert.deepStrictEqual(throttled.firstCalls, { a: 1, b: 1 });
  // c and d never ran in either invoke; join never fired; nothing is "next".
  assert.deepStrictEqual(throttled.calls, { a: 2, b: 2 });
  assert.deepStrictEqual(Object.keys(throttled.resumed.receipts).sort(), ["a", "b"]);
  assert.deepStrictEqual(throttled.next, []);

  // Unthrottled, every sibling had started, so each got an error write and
  // the resume ran the whole superstep and the join. This is what the runner
  // relies on (it passes maxConcurrency = node count and caps in its gate).
  const unthrottled = await run(undefined);
  assert.deepStrictEqual(unthrottled.firstCalls, { a: 1, b: 1, c: 1, d: 1 });
  assert.deepStrictEqual(unthrottled.calls, { a: 2, b: 2, c: 2, d: 2, join: 1 });
  assert.equal(unthrottled.resumed.receipts.join, "ok");
});
