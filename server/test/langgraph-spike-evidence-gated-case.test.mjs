import "./langgraph-spike/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";

import { MemorySaver } from "@langchain/langgraph";

import {
  buildExecutionGraphNodeStepId,
  digestExecutionGraphTypedOutput,
} from "../rag/agent-execution-graph-checkpoint.js";
import { projectUnifiedGraphRun } from "../rag/agent-unified-graph-projection.js";
import { collectUnifiedGraphResults } from "../rag/agent-unified-graph-results.js";
import {
  getActiveDatabaseTenant,
  runWithDatabaseTenant,
  toDatabaseTenant,
} from "../rag/postgres-tenant.js";
import {
  ACCESS_SCOPE,
  DOCUMENT_ANSWER,
  DOCUMENT_EXCERPT,
  DOC_ID,
  PRIVATE_TEXTS,
  QUESTION,
  RISK_PROMPT_PATTERN,
  UPSTREAM_PATTERN,
  maskTimingFields,
  runLangGraphStage,
  runNativeStage,
  serializeMemorySaver,
  withVendorCaseEnvironment,
} from "./langgraph-spike/vendor-case.mjs";

// Phase-0 LangGraph spike, not the production path: the trajectory case
// unified_graph_evidence_gated_skill_hand_off, stage level, run once on the
// native runtime (runUnifiedGraphStage -> runExecutionGraph) and once on
// runExecutionGraphOnLangGraph with a MemorySaver, each on its own fresh
// in-memory run store, and compared receipt by receipt. Only wall-clock
// fields are masked (durationMs, step timestamps, and the checkpoint digest,
// which seals durationMs).

const TENANT = toDatabaseTenant(ACCESS_SCOPE);
const NODE_IDS = ["document", "evidence_check", "risk"];
const stepIdOf = (nodeId) => buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId });
const threadIdFor = (label) => `langgraph-spike:evidence-gated:${label}`;

const assertTenantEverywhere = (observations) => {
  assert.ok(observations.length > 0);
  for (const observation of observations) {
    assert.deepStrictEqual(observation.tenant, TENANT);
  }
};

const runBoth = async ({ documentSufficient, label }) => {
  const nodeEvents = [];
  const checkpointer = new MemorySaver();
  const threadId = threadIdFor(label);
  const native = await withVendorCaseEnvironment(() =>
    runWithDatabaseTenant(ACCESS_SCOPE, () => runNativeStage({ documentSufficient }))
  );
  const langGraph = await withVendorCaseEnvironment(() =>
    runWithDatabaseTenant(ACCESS_SCOPE, () =>
      runLangGraphStage({
        checkpointer,
        documentSufficient,
        // Called inside each node: what the node itself sees.
        onNodeEvent: (event) => nodeEvents.push({ ...event, tenant: getActiveDatabaseTenant() }),
        threadId,
      })
    )
  );

  assert.equal(native.error, null, native.error?.stack);
  assert.equal(langGraph.error, null, langGraph.error?.stack);

  return { checkpointer, langGraph, native, nodeEvents, threadId };
};

const nodeRunOf = (outcome, nodeId) =>
  outcome.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === nodeId);
const stepOf = (outcome, nodeId) =>
  outcome.steps.find((step) => step.id === stepIdOf(nodeId)) ?? null;
const checkpointRunOf = (outcome, nodeId) =>
  outcome.checkpoint.nodeRuns.find((nodeRun) => nodeRun.nodeId === nodeId) ?? null;

const assertSameReceipts = ({ langGraph, native }) => {
  // The whole runExecutionGraph-shaped result, declaration order included.
  assert.deepStrictEqual(maskTimingFields(langGraph.run), maskTimingFields(native.run));
  assert.deepStrictEqual(
    langGraph.run.nodeRuns.map(({ nodeId, reason, status }) => ({ nodeId, reason, status })),
    native.run.nodeRuns.map(({ nodeId, reason, status }) => ({ nodeId, reason, status }))
  );

  for (const nodeRun of native.run.nodeRuns.filter((item) => item.status === "completed")) {
    const mirrored = nodeRunOf(langGraph, nodeRun.nodeId);
    assert.deepStrictEqual(maskTimingFields(mirrored.result), maskTimingFields(nodeRun.result));
    assert.deepStrictEqual(mirrored.result.graphOutput, nodeRun.result.graphOutput);
  }

  assert.deepStrictEqual(langGraph.budget, native.budget);
  assert.deepStrictEqual(langGraph.chatCalls, native.chatCalls);
  assert.deepStrictEqual(maskTimingFields(langGraph.steps), maskTimingFields(native.steps));
  assert.deepStrictEqual(
    maskTimingFields(langGraph.checkpoint, ["digest"]),
    maskTimingFields(native.checkpoint, ["digest"])
  );
  assert.deepStrictEqual(maskTimingFields(langGraph.trace), maskTimingFields(native.trace));
  assert.deepStrictEqual(langGraph.skippedSkills, native.skippedSkills);
  assert.deepStrictEqual(langGraph.budgetLimitTraces, native.budgetLimitTraces);
  // The stage's graph observability event (recordExecutionGraph, a run event
  // in production): one each, same payload.
  assert.equal(native.graphRecords.length, 1);
  assert.deepStrictEqual(maskTimingFields(langGraph.graphRecords), maskTimingFields(native.graphRecords));
  // The run store saw the same sequence of durable writes.
  assert.deepStrictEqual(
    langGraph.events.map(({ payload, type }) => ({ payload, type })),
    native.events.map(({ payload, type }) => ({ payload, type }))
  );
};

const assertSameProjection = ({ langGraph, native }) => {
  // Each runtime's own collection (the stage's, and the runner's gate before
  // its completed write) ...
  assert.deepStrictEqual(maskTimingFields(langGraph.collected), maskTimingFields(native.collected));

  // ... and both runs projected through one live registry, so Skill objects
  // compare by identity.
  const registry = langGraph.graphRegistry;
  const collect = (outcome) =>
    collectUnifiedGraphResults({
      authorizedDocIds: [DOC_ID],
      graph: outcome.graph,
      registry,
      run: outcome.run,
    });
  const project = (outcome) =>
    projectUnifiedGraphRun({ graph: outcome.graph, plan: outcome.plan, registry, run: outcome.run });

  assert.deepStrictEqual(maskTimingFields(collect(langGraph)), maskTimingFields(collect(native)));
  assert.deepStrictEqual(maskTimingFields(project(langGraph)), maskTimingFields(project(native)));
};

const assertStepReceipts = (outcome) => {
  const graphSteps = outcome.steps.filter((step) => step.type === "graph_node");

  assert.equal(graphSteps.length, outcome.steps.length);
  for (const step of graphSteps) {
    const nodeRun = checkpointRunOf(outcome, step.input.nodeId);

    assert.equal(step.id, stepIdOf(step.input.nodeId));
    assert.equal(step.status, "completed");
    assert.equal(nodeRun.status, "completed");
    // The step receipt and the checkpoint bind the same typed output.
    assert.equal(
      step.output.typedOutputDigest,
      digestExecutionGraphTypedOutput(nodeRun.result.graphOutput)
    );
  }
};

const assertLangGraphHoldsIdsOnly = async ({ checkpointer, threadId }) => {
  const serialized = serializeMemorySaver(checkpointer);

  // Sanity: the saver did persist this thread's receipts.
  assert.match(serialized, /outputDigest/);
  for (const nodeId of NODE_IDS) {
    assert.ok(serialized.includes(nodeId), `the thread names node ${nodeId}`);
  }
  for (const text of PRIVATE_TEXTS) {
    assert.equal(serialized.includes(text), false, `LangGraph persisted private text: ${text}`);
  }

  const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
  const receipts = tuple.checkpoint.channel_values.receipts;

  for (const receipt of Object.values(receipts)) {
    assert.deepStrictEqual(Object.keys(receipt).sort(), ["outputDigest", "reason", "status"]);
  }

  return receipts;
};

test("sufficient evidence: the LangGraph run equals the native stage, and risk reads the verified document answer", async () => {
  const outcome = await runBoth({ documentSufficient: true, label: "sufficient" });
  const { langGraph, native, nodeEvents } = outcome;

  assertSameReceipts(outcome);
  assertSameProjection(outcome);
  assertStepReceipts(native);
  assertStepReceipts(langGraph);

  assert.deepStrictEqual(
    langGraph.run.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
    [
      ["document", "completed", null],
      ["evidence_check", "completed", null],
      ["risk", "completed", null],
    ]
  );
  assert.equal(langGraph.run.status, "completed");
  assert.equal(nodeRunOf(langGraph, "evidence_check").result.graphOutput.passed, true);
  assert.equal(langGraph.budget.documentRagCalls, 1);
  assert.equal(langGraph.budget.customSkillCalls, 1);
  assert.equal(langGraph.budget.webSearchCalls, 0);
  assert.equal(langGraph.webCalls.length, 0);

  // Two model-facing calls: the document answer, then the risk prompt that
  // carries that answer as its upstream section.
  assert.equal(langGraph.chatCalls.length, 2);
  assert.equal(langGraph.chatCalls[0].question, QUESTION);
  assert.match(langGraph.chatCalls[1].question, RISK_PROMPT_PATTERN);
  assert.match(langGraph.chatCalls[1].question, UPSTREAM_PATTERN);
  assert.ok(langGraph.chatCalls[1].question.includes(DOCUMENT_EXCERPT));

  for (const outcomeOf of [native, langGraph]) {
    const documentStep = stepOf(outcomeOf, "document");
    const checkStep = stepOf(outcomeOf, "evidence_check");
    const riskStep = stepOf(outcomeOf, "risk");

    assert.equal(riskStep.input.priorFindings, DOCUMENT_ANSWER);
    assert.equal(riskStep.input.priorFindings, documentStep.output.text);
    // risk started only after evidence_check settled, by the run store's own
    // order of durable writes (timestamps cannot tell: two writes in one
    // millisecond compare equal): evidence_check's step completed and its
    // checkpoint write (sequence 2: create 0, document 1) landed before
    // risk's step started.
    const eventAt = (predicate) => outcomeOf.events.findIndex(predicate);
    const checkCompleted = eventAt(
      (event) => event.type === "step_completed" && event.payload.stepId === checkStep.id
    );
    const checkSettled = eventAt(
      (event) => event.type === "skill_graph_checkpointed" && event.payload.sequence === 2
    );
    const riskStarted = eventAt(
      (event) => event.type === "step_started" && event.payload.stepId === riskStep.id
    );
    assert.ok(checkCompleted >= 0 && checkSettled > checkCompleted && riskStarted > checkSettled);
    assert.deepStrictEqual(nodeRunOf(outcomeOf, "risk").dependsOn, ["document", "evidence_check"]);
    assert.equal(outcomeOf.checkpoint.version, "v2");
    assert.equal(outcomeOf.checkpoint.graph.version, "v3");
    assert.equal(outcomeOf.checkpoint.phase, "completed");
    // create, three node settles, the completed phase.
    assert.equal(outcomeOf.checkpoint.sequence, 4);
  }

  // And in the LangGraph run's own node events.
  const eventIndex = (nodeId, phase) =>
    nodeEvents.findIndex((event) => event.nodeId === nodeId && event.phase === phase);
  assert.ok(eventIndex("evidence_check", "settle") < eventIndex("risk", "start"));

  // The database tenant reached every node, every executed Skill, and every
  // model-facing call.
  assert.deepStrictEqual(
    nodeEvents.map(({ nodeId, phase, status }) => [nodeId, phase, status]),
    [
      ["document", "start", "running"],
      ["document", "settle", "completed"],
      ["evidence_check", "start", "running"],
      ["evidence_check", "settle", "completed"],
      ["risk", "start", "running"],
      ["risk", "settle", "completed"],
    ]
  );
  assertTenantEverywhere(nodeEvents);
  assert.deepStrictEqual(
    langGraph.tenantObservations.map((observation) => observation.skillId),
    ["document_rag", "document_evidence_check", "risk_review"]
  );
  assertTenantEverywhere(langGraph.tenantObservations);
  assert.deepStrictEqual(langGraph.chatTenants.map((call) => call.kind), ["document", "risk"]);
  assertTenantEverywhere(langGraph.chatTenants);

  // LangGraph holds receipts only, bound to the run store's typed outputs.
  const receipts = await assertLangGraphHoldsIdsOnly(outcome);
  for (const nodeId of NODE_IDS) {
    assert.equal(receipts[nodeId].status, "completed");
    assert.equal(receipts[nodeId].outputDigest, stepOf(langGraph, nodeId).output.typedOutputDigest);
  }
});

test("insufficient evidence: risk is skipped as condition_not_met with no step and no Skill budget, exactly as natively", async () => {
  const outcome = await runBoth({ documentSufficient: false, label: "insufficient" });
  const { langGraph, native, nodeEvents } = outcome;

  assertSameReceipts(outcome);
  assertSameProjection(outcome);
  assertStepReceipts(native);
  assertStepReceipts(langGraph);

  assert.deepStrictEqual(
    langGraph.run.nodeRuns.map(({ nodeId, reason, status }) => [nodeId, status, reason]),
    [
      ["document", "completed", null],
      ["evidence_check", "completed", null],
      ["risk", "skipped", "condition_not_met"],
    ]
  );
  assert.equal(langGraph.run.status, "completed");
  assert.equal(nodeRunOf(langGraph, "risk").result, null);
  assert.equal(nodeRunOf(langGraph, "evidence_check").result.graphOutput.passed, false);
  assert.equal(nodeRunOf(langGraph, "evidence_check").result.graphOutput.retryRecommended, true);
  assert.equal(stepOf(langGraph, "risk"), null);
  assert.equal(langGraph.steps.length, 2);
  assert.equal(langGraph.budget.documentRagCalls, 1);
  assert.equal(langGraph.budget.customSkillCalls, 0);
  assert.equal(langGraph.chatCalls.length, 1);
  assert.equal(
    langGraph.chatCalls.filter((call) => RISK_PROMPT_PATTERN.test(call.question)).length,
    0
  );
  assert.deepStrictEqual(langGraph.skippedSkills, [{ skillId: "risk_review", status: "skipped" }]);

  for (const outcomeOf of [native, langGraph]) {
    assert.equal(outcomeOf.checkpoint.phase, "completed");
    // create, two node settles, the completed phase (a skip writes nothing).
    assert.equal(outcomeOf.checkpoint.sequence, 3);
    assert.deepStrictEqual(checkpointRunOf(outcomeOf, "risk"), {
      nodeId: "risk",
      skillId: "risk_review",
      skillVersion: nodeRunOf(outcomeOf, "risk").skillVersion,
      status: "skipped",
      stepId: stepIdOf("risk"),
    });
  }

  // The skip is decided after evidence_check settled, in risk's own node.
  assert.deepStrictEqual(
    nodeEvents.map(({ nodeId, phase, status }) => [nodeId, phase, status]),
    [
      ["document", "start", "running"],
      ["document", "settle", "completed"],
      ["evidence_check", "start", "running"],
      ["evidence_check", "settle", "completed"],
      ["risk", "skip", "skipped"],
    ]
  );
  assertTenantEverywhere(nodeEvents);
  assert.deepStrictEqual(
    langGraph.tenantObservations.map((observation) => observation.skillId),
    ["document_rag", "document_evidence_check"]
  );
  assertTenantEverywhere(langGraph.tenantObservations);
  assertTenantEverywhere(langGraph.chatTenants);

  const receipts = await assertLangGraphHoldsIdsOnly(outcome);
  assert.deepStrictEqual(receipts.risk, {
    outputDigest: null,
    reason: "condition_not_met",
    status: "skipped",
  });
});

test("the tenant observation is not vacuous: without runWithDatabaseTenant the nodes see none", async () => {
  const nodeEvents = [];
  const outcome = await withVendorCaseEnvironment(() =>
    runLangGraphStage({
      checkpointer: new MemorySaver(),
      documentSufficient: true,
      onNodeEvent: (event) => nodeEvents.push({ ...event, tenant: getActiveDatabaseTenant() }),
      threadId: threadIdFor("unbound-tenant"),
    })
  );

  assert.equal(outcome.error, null, outcome.error?.stack);
  assert.equal(nodeEvents.length, 6);
  assert.ok(nodeEvents.every((event) => event.tenant === null));
  assert.ok(outcome.tenantObservations.every((observation) => observation.tenant === null));
});

// Two illegal graphs, each refused whole by both runtimes before anything
// durable or model-facing happens.
const ILLEGAL_PROPOSALS = [
  {
    expectedCode: "cycle_detected",
    label: "a dependency cycle",
    proposal: () => ({
      nodes: [
        {
          dependsOn: ["risk"],
          failurePolicy: "fail_fast",
          inputBindings: {
            docIds: { field: "docIds", source: "request" },
            question: { field: "question", source: "request" },
          },
          nodeId: "document",
          skillId: "document_rag",
        },
        {
          dependsOn: ["document"],
          failurePolicy: "fail_fast",
          inputBindings: {
            docIds: { field: "docIds", source: "request" },
            priorFindings: { nodeId: "document", output: "text", source: "node" },
            question: { field: "question", source: "request" },
          },
          nodeId: "risk",
          skillId: "risk_review",
        },
      ],
    }),
  },
  {
    expectedCode: "out_of_scope_document",
    label: "an out-of-scope document scope",
    proposal: () => ({
      nodes: [
        {
          dependsOn: [],
          failurePolicy: "fail_fast",
          inputBindings: {
            docIds: { field: "docIds", source: "request" },
            question: { field: "question", source: "request" },
          },
          nodeId: "document",
          scope: { docIds: ["another-tenants-doc"] },
          skillId: "document_rag",
        },
      ],
    }),
  },
];

for (const { expectedCode, label, proposal } of ILLEGAL_PROPOSALS) {
  test(`${label} is rejected whole with zero model calls, zero steps and no thread`, async () => {
    const checkpointer = new MemorySaver();
    const nodeEvents = [];
    const native = await withVendorCaseEnvironment(() =>
      runNativeStage({ proposal: proposal() })
    );
    const langGraph = await withVendorCaseEnvironment(() =>
      runLangGraphStage({
        checkpointer,
        onNodeEvent: (event) => nodeEvents.push(event),
        proposal: proposal(),
        threadId: threadIdFor(expectedCode),
      })
    );

    for (const outcome of [native, langGraph]) {
      assert.equal(outcome.error?.code, "AGENT_UNIFIED_GRAPH_REJECTED");
      assert.equal(outcome.error.preExecution, true);
      assert.ok(outcome.error.reasonCodes.includes(expectedCode));
      assert.equal(outcome.chatCalls.length, 0);
      assert.deepStrictEqual(outcome.steps, []);
      assert.equal(outcome.checkpoint, null);
      assert.deepStrictEqual(outcome.budget, native.budget);
      assert.equal(outcome.tenantObservations.length, 0);
    }
    assert.deepStrictEqual(langGraph.error.reasonCodes, native.error.reasonCodes);
    assert.equal(langGraph.budget.documentRagCalls, 0);
    assert.equal(langGraph.budget.customSkillCalls, 0);
    assert.deepStrictEqual(nodeEvents, []);
    assert.deepStrictEqual(Object.keys(checkpointer.storage), []);
    assert.deepStrictEqual(Object.keys(checkpointer.writes), []);
    // The run exists and is untouched: only its creation event.
    assert.deepStrictEqual(langGraph.events.map((event) => event.type), ["run_created"]);
  });
}
