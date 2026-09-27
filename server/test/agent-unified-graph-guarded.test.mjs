import test from "node:test";
import assert from "node:assert/strict";

import { resumeAgentExecutionGraphRun, runAgentRag } from "../rag/agent.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  configureAgentExperienceMemoryStore,
  createInMemoryAgentExperienceStore,
} from "../rag/agent-experience-memory.js";
import { withAgentExperienceMemoryEnabled } from "./agent-experience-memory-test-helpers.mjs";
import { createAgentBudget } from "../rag/agent-budget.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { runUnifiedGraphStage } from "../rag/agent-unified-graph-stage.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  assessUnifiedGraphAdmission,
  hasStandingCapabilityGrant,
} from "../rag/agent-unified-graph-admission.js";
import {
  buildUnifiedGraphFinalizationReceipt,
  hasUnifiedGuardedGraphPath,
  verifyUnifiedGraphFinalizationReceipt,
} from "../rag/agent-unified-graph-run.js";
import { createDefaultCapabilityRegistry } from "../rag/capabilities/index.js";
import {
  createDefaultSkillRegistry,
  createSkillRegistry,
} from "../rag/skills/registry.js";
import { buildAuthorizedUnifiedGraphCatalog } from "../rag/skills/unified-graph-catalog.js";
import {
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE as accessScope,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  WEB_QUESTION,
  checkpointHasNodeRun,
  createCrashingRunService,
  createDocumentLoopProposal,
  createDocumentLoopRagService,
  createProposalAdapter,
  createWebChatService,
  createConditionalWebProposal,
  describeAnswerState,
  nodeBinding,
  requestBinding,
} from "./fixtures/unified-graph-run-fixtures.mjs";

// Guarded v3 execution on the in-memory run store: one path per request,
// whole-graph refusal before execution, the document loop's state, and the
// three recovery blocks (node boundary, unknown in-flight work, finalization
// receipts). The PostgreSQL suite repeats the recovery blocks across a real
// process boundary.

const withEnv = async (overrides, callback) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const ENV = Object.freeze({
  AGENT_PLANNER_ROLLOUT: "deterministic",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

const newService = (store) => createAgentRunService({ agentRunStore: store });

const ask = ({
  agentRunService,
  capabilityApprovals,
  env = {},
  mode,
  proposal = createDocumentLoopProposal,
  question = DOCUMENT_LOOP_QUESTION,
  ragService,
  unifiedGraphAllowedCapabilityIds,
  webChatService = createWebChatService(),
  withPlanner = true,
}) =>
  withEnv({ ...ENV, ...env, AGENT_UNIFIED_GRAPH_ROLLOUT: mode }, () =>
    runAgentRag({
      accessScope,
      agentRunService,
      ...(capabilityApprovals ? { capabilityApprovals } : {}),
      docIds: [UNIFIED_DOC_ID],
      question,
      ragService,
      sessionId: UNIFIED_SESSION_ID,
      ...(unifiedGraphAllowedCapabilityIds ? { unifiedGraphAllowedCapabilityIds } : {}),
      ...(withPlanner
        ? { unifiedGraphPlannerAdapter: createProposalAdapter(proposal) }
        : {}),
      userId: accessScope.userId,
      webChatService,
    })
  );

const loadRun = async (agentRunService, runId) => ({
  checkpoint: (await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }))
    ?.checkpoint ?? null,
  run: await agentRunService.getRun({ accessScope, runId }),
});

const onlyRunId = async (store) => {
  const listed = await store.list({ accessScope });
  const runs = listed?.runs ?? listed ?? [];
  assert.equal(runs.length, 1);
  return runs[0].runId;
};

// Startup recovery executes a v3 graph only while the rollout is `guarded`.
const recover = ({
  agentRunService,
  env = {},
  ragService,
  rollout = "guarded",
  skillRegistry = createDefaultSkillRegistry(),
  webChatService,
}) =>
  withEnv({ ...ENV, ...env, AGENT_UNIFIED_GRAPH_ROLLOUT: rollout }, () =>
    createAgentRunRecoveryService({
      agentRunService,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: (args) =>
        resumeAgentExecutionGraphRun({
          ...args,
          agentRunService,
          ragService,
          skillRegistry,
          webChatService,
        }),
    }).recoverOnStartup({ mode: "auto" })
  );

// The default registry with one built-in bumped, as after a deploy.
const registryWithBumpedDocumentRag = () =>
  createSkillRegistry(
    createDefaultSkillRegistry().list().map((skill) =>
      skill.id === "document_rag" ? { ...skill, version: `${skill.version}-next` } : skill
    )
  );

const eventTypes = (run) => (run?.events ?? []).map((event) => event.type);

test("a guarded document loop reproduces V1's answer, gaps, loop counters, and budget", async () => {
  for (const followUp of ["resolves", "unresolved"]) {
    const guardedRag = createDocumentLoopRagService({ followUp });
    const guardedService = newService(createInMemoryAgentRunStore());
    const guarded = await ask({
      agentRunService: guardedService,
      mode: "guarded",
      ragService: guardedRag,
    });
    const v1 = await ask({
      agentRunService: newService(createInMemoryAgentRunStore()),
      mode: "off",
      ragService: createDocumentLoopRagService({ followUp }),
    });
    const { checkpoint, run } = await loadRun(guardedService, guarded.body.agentRunId);

    assert.deepEqual(describeAnswerState(guarded), describeAnswerState(v1), followUp);
    assert.equal(guarded.body.agentObservability.budget.used.documentRagCalls, 2);
    assert.deepEqual(guardedRag.calls.map((call) => call.phase), ["primary", "follow_up"]);
    assert.equal(hasUnifiedGuardedGraphPath(run), true);
    assert.equal(eventTypes(run).includes("execution_planned"), false);
    assert.equal(run.steps.filter((step) => step.type === "graph_node").length, 4);
    assert.equal(checkpoint.phase, "completed");
    assert.equal(verifyUnifiedGraphFinalizationReceipt(checkpoint.finalization), true);
  }

  const resolved = await ask({
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "guarded",
    ragService: createDocumentLoopRagService({ followUp: "resolves" }),
  });
  assert.equal(resolved.body.agentObservability.executionLoop.stoppedReason, "follow_up_resolved");
  assert.equal(resolved.body.agentWorkingMemory.unresolvedGaps.length, 0);
  assert.ok(resolved.body.agentWorkingMemory.resolvedGaps.length > 0);

  const unresolved = await ask({
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "guarded",
    ragService: createDocumentLoopRagService({ followUp: "unresolved" }),
  });
  assert.equal(unresolved.body.agentMode, "clarification");
  assert.equal(
    unresolved.body.clarification.reason,
    "document_evidence_unresolved_after_follow_up"
  );
  assert.ok(unresolved.body.agentWorkingMemory.unresolvedGaps.length > 0);
});

test("an approval-gated Capability node refuses the whole graph before any node runs", async () => {
  const agentRunService = newService(createInMemoryAgentRunStore());
  const ragService = createDocumentLoopRagService();
  const response = await ask({
    agentRunService,
    mode: "guarded",
    proposal: () => ({
      nodes: [
        {
          dependsOn: [],
          failurePolicy: "fail_fast",
          inputBindings: { docIds: requestBinding("docIds"), question: requestBinding("question") },
          nodeId: "primary",
          skillId: "document_rag",
        },
        {
          dependsOn: ["primary"],
          failurePolicy: "fail_fast",
          inputBindings: { title: requestBinding("question") },
          nodeId: "create_task",
          skillId: "capability:task.create",
        },
      ],
    }),
    ragService,
    unifiedGraphAllowedCapabilityIds: ["task.create"],
  });
  const { checkpoint, run } = await loadRun(agentRunService, response.body.agentRunId);
  const fallbackStep = response.body.agentTrace.find(
    (step) => step.type === "unified_graph_fallback"
  );
  const planned = run.events.filter((event) => event.type === "unified_graph_planned");

  assert.equal(response.status, 200);
  // The Capability is approval-gated, and a Capability node is also outside
  // the shape the legacy finalizer can represent; both refuse it.
  assert.deepEqual(fallbackStep.detail.errorCodes, [
    "approval_gated_capability",
    "graph_not_projectable",
  ]);
  assert.deepEqual(fallbackStep.detail.blockedNodeIds, ["create_task"]);
  assert.equal(fallbackStep.detail.fallback, "v1");
  assert.equal(planned.length, 1);
  assert.equal(planned[0].payload.status, "rejected");
  assert.equal(planned[0].payload.fallback, "v1");
  assert.equal(hasUnifiedGuardedGraphPath(run), false);
  // V1 answered: its outer plan ran and no graph node or checkpoint exists.
  assert.equal(eventTypes(run).includes("execution_planned"), true);
  assert.equal(checkpoint, null);
  assert.equal(run.steps.some((step) => step.type === "graph_node"), false);
  assert.ok(response.body.agentTrace.some((step) => step.type === "document_rag"));
});

test("a Web node without a standing grant is refused whole and V1 keeps its approval pause", async () => {
  const agentRunService = newService(createInMemoryAgentRunStore());
  const webCalls = [];
  const response = await ask({
    agentRunService,
    mode: "guarded",
    proposal: createConditionalWebProposal,
    question: WEB_QUESTION,
    ragService: createDocumentLoopRagService({ primary: "abstain" }),
    webChatService: createWebChatService({ calls: webCalls }),
  });
  const { checkpoint, run } = await loadRun(agentRunService, response.body.agentRunId);
  const fallbackStep = response.body.agentTrace.find(
    (step) => step.type === "unified_graph_fallback"
  );

  assert.deepEqual(fallbackStep.detail.errorCodes, ["approval_required_without_standing_grant"]);
  assert.deepEqual(fallbackStep.detail.blockedNodeIds, ["web"]);
  assert.equal(checkpoint, null);
  assert.equal(webCalls.length, 0);
  assert.equal(response.body.agentMode, "clarification");
  assert.ok(response.body.agentTrace.some((step) => step.type === "capability_approval_gate"));
  assert.equal(run.status, "waiting_for_user");
});

test("guarded without a planner, or with an unprojectable graph, records the refusal and V1 answers", async () => {
  const off = await ask({
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "off",
    ragService: createDocumentLoopRagService(),
  });
  const offTypes = off.body.agentTrace.map((step) => step.type);

  for (const [variant, options, expectedCodes] of [
    ["no planner", { withPlanner: false }, ["invalid_node_shape"]],
    [
      "unprojectable",
      {
        proposal: () => ({
          nodes: ["first", "second"].map((nodeId, index) => ({
            dependsOn: index === 0 ? [] : ["first"],
            failurePolicy: "fail_fast",
            inputBindings: { docIds: requestBinding("docIds"), question: requestBinding("question") },
            nodeId,
            skillId: "document_rag",
          })),
        }),
      },
      ["graph_not_projectable"],
    ],
  ]) {
    const agentRunService = newService(createInMemoryAgentRunStore());
    const response = await ask({
      agentRunService,
      mode: "guarded",
      ragService: createDocumentLoopRagService(),
      ...options,
    });
    const { checkpoint } = await loadRun(agentRunService, response.body.agentRunId);
    const types = response.body.agentTrace.map((step) => step.type);

    assert.deepEqual(
      response.body.agentTrace.find((step) => step.type === "unified_graph_fallback")
        .detail.errorCodes,
      expectedCodes,
      variant
    );
    assert.deepEqual(types.filter((type) => type !== "unified_graph_fallback"), offTypes, variant);
    assert.equal(response.body.agentAnswer, off.body.agentAnswer, variant);
    assert.equal(checkpoint, null, variant);
  }
});

test("admission accepts a Web node only with a standing, input-independent grant", () => {
  const ragService = createDocumentLoopRagService();
  const capabilityRegistry = createDefaultCapabilityRegistry({
    ragService,
    webChatService: createWebChatService(),
  });
  const catalog = buildAuthorizedUnifiedGraphCatalog({
    accessScope,
    capabilityRegistry,
    docIds: [UNIFIED_DOC_ID],
    ragService,
    registry: createDefaultSkillRegistry(),
  });
  const graph = { ...createConditionalWebProposal(), revision: 0, version: "v3" };
  const assess = (capabilityApprovals) =>
    assessUnifiedGraphAdmission({
      accessScope,
      capabilityApprovals,
      capabilityRegistry,
      docIds: [UNIFIED_DOC_ID],
      graph,
      plan: { mode: "document_web" },
      registry: catalog.graphRegistry,
    });

  assert.equal(assess({}).admitted, false);
  assert.equal(assess({ "web.search": { approved: true } }).admitted, true);
  assert.equal(assess({ "*": { approved: true } }).admitted, true);
  // A gate-bound approval covers one exact input; the Web node's input is
  // not known before execution, so it is not a standing grant.
  const bound = {
    "web.search": {
      approvalObjectHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      approved: true,
      source: "agent_run_action",
    },
  };
  assert.equal(assess(bound).admitted, false);
  assert.equal(
    hasStandingCapabilityGrant({
      accessScope,
      approvals: bound,
      capabilityId: "web.search",
      capabilityRegistry,
    }),
    false
  );
  // Recovery admission checks only nodes that are still to run.
  assert.equal(
    assessUnifiedGraphAdmission({
      accessScope,
      capabilityRegistry,
      docIds: [UNIFIED_DOC_ID],
      graph,
      nodeIds: ["risk"],
      plan: { mode: "document_web" },
      registry: catalog.graphRegistry,
    }).admitted,
    true
  );
  // A second, ungated Web node reading the check's follow-up question: a
  // second Web output, an upstream-text query, no evidence gate, no grant.
  assert.deepEqual(
    assessUnifiedGraphAdmission({
      accessScope,
      capabilityRegistry,
      docIds: [UNIFIED_DOC_ID],
      graph: {
        ...graph,
        nodes: [
          ...graph.nodes,
          {
            dependsOn: ["document"],
            failurePolicy: "fail_fast",
            inputBindings: { question: nodeBinding("evidence_check", "followUpQuestion") },
            nodeId: "second_web",
            skillId: "web_search",
          },
        ],
      },
      plan: { mode: "document_web" },
      registry: catalog.graphRegistry,
    }).reasonCodes,
    [
      "approval_required_without_standing_grant",
      "external_input_not_request_question",
      "graph_not_projectable",
      "web_not_gated_on_document_evidence",
    ]
  );
});

const reference = async (followUp = "resolves") =>
  ask({
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "guarded",
    ragService: createDocumentLoopRagService({ followUp }),
  });

const crashRun = async ({ crashAfter, crashBefore, followUp = "resolves", ...options }) => {
  const store = createInMemoryAgentRunStore();
  const { service } = createCrashingRunService(newService(store), { crashAfter, crashBefore });

  await assert.rejects(
    ask({
      agentRunService: service,
      mode: "guarded",
      ragService: createDocumentLoopRagService({ followUp }),
      ...options,
    }),
    (error) => error.code === "SIMULATED_PROCESS_EXIT"
  );

  return { runId: await onlyRunId(store), store };
};

test("a restart at a node boundary reuses the completed follow-up and rebuilds the same gaps", async () => {
  for (const followUp of ["resolves", "unresolved"]) {
    const { runId, store } = await crashRun({
      crashAfter: (method, args) =>
        method === "saveExecutionGraphCheckpoint" &&
        checkpointHasNodeRun(args.checkpoint, "follow_up") &&
        !checkpointHasNodeRun(args.checkpoint, "follow_up_check"),
      followUp,
    });
    const restarted = newService(store);
    const resumedRag = createDocumentLoopRagService({ followUp });
    const outcome = await recover({ agentRunService: restarted, ragService: resumedRag });
    const { checkpoint, run } = await loadRun(restarted, runId);
    const expected = await reference(followUp);

    assert.equal(outcome.autoRecoveredCount, 1, followUp);
    assert.equal(outcome.manualRecoveredCount, 0, followUp);
    // Both document calls happened before the restart and are never re-run.
    assert.equal(resumedRag.calls.length, 0, followUp);
    assert.equal(
      run.status,
      followUp === "resolves" ? "completed" : "waiting_for_user",
      followUp
    );
    assert.deepEqual(
      describeAnswerState(checkpoint.finalization.response),
      describeAnswerState(expected),
      followUp
    );
    assert.equal(
      checkpoint.finalization.response.body.agentObservability.budget.used.documentRagCalls,
      2,
      followUp
    );
    const executed = run.events.filter((event) => event.type === "unified_graph_executed");
    assert.deepEqual(
      executed.at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
      [
        ["primary", "reused"],
        ["primary_check", "reused"],
        ["follow_up", "reused"],
        ["follow_up_check", "completed"],
      ],
      followUp
    );
  }
});

test("an unknown in-flight document call goes to manual recovery without replay", async () => {
  const { runId, store } = await crashRun({
    crashAfter: (method, args) =>
      method === "recordRunStep" &&
      args.status === "running" &&
      args.input?.nodeId === "follow_up",
  });
  const restarted = newService(store);
  const resumedRag = createDocumentLoopRagService();
  let resumeCalls = 0;
  const outcome = await withEnv(ENV, () =>
    createAgentRunRecoveryService({
      agentRunService: restarted,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: async () => { resumeCalls += 1; },
    }).recoverOnStartup({ mode: "auto" })
  );
  const { run } = await loadRun(restarted, runId);

  assert.equal(outcome.manualRecoveredCount, 1);
  assert.equal(resumeCalls, 0);
  assert.equal(resumedRag.calls.length, 0);
  assert.equal(run.result.recovery.reason, "unknown_in_flight_node");
  assert.equal(run.status, "waiting_for_user");
});

test("a completed node whose typed-output digest no longer reconciles is never reused", async () => {
  const { runId, store } = await crashRun({
    crashAfter: (method, args) =>
      method === "saveExecutionGraphCheckpoint" &&
      checkpointHasNodeRun(args.checkpoint, "primary_check"),
  });
  const stored = store.get({ accessScope, runId });
  store.update({
    accessScope,
    expectedRevision: stored.revision,
    patch: {
      steps: stored.steps.map((step) =>
        step.input?.nodeId === "primary"
          ? { ...step, output: { ...step.output, typedOutputDigest: "v1:sha256:tampered" } }
          : step
      ),
    },
    runId,
  });
  const restarted = newService(store);
  const resumedRag = createDocumentLoopRagService();
  const outcome = await recover({ agentRunService: restarted, ragService: resumedRag });
  const { run } = await loadRun(restarted, runId);

  assert.equal(outcome.autoRecoveredCount, 0);
  assert.equal(outcome.manualRecoveredCount, 1);
  assert.equal(resumedRag.calls.length, 0);
  assert.equal(run.result.recovery.reason, "completed_step_without_checkpoint");
});

test("a restart after the finalization receipt completes the run with the stored answer", async () => {
  const { runId, store } = await crashRun({
    crashAfter: (method, args) =>
      method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
  });
  const before = await loadRun(newService(store), runId);
  const restarted = newService(store);
  const resumedRag = createDocumentLoopRagService();
  const outcome = await recover({ agentRunService: restarted, ragService: resumedRag });
  const { checkpoint, run } = await loadRun(restarted, runId);

  assert.equal(before.run.status, "running");
  assert.equal(outcome.autoRecoveredCount, 1);
  assert.equal(resumedRag.calls.length, 0);
  assert.equal(run.status, "completed");
  assert.equal(run.result.answer, before.checkpoint.finalization.response.body.agentAnswer);
  assert.deepEqual(checkpoint.finalization, before.checkpoint.finalization);
  assert.equal(
    run.events.filter((event) => event.type === "unified_graph_finalization_replayed").length,
    1
  );
  assert.equal(run.events.filter((event) => event.type === "unified_graph_executed").length, 1);

  // Completion is terminal: a second startup scan finds nothing to recover
  // and a direct resume with the old claim is fenced by the run store.
  const again = await recover({ agentRunService: restarted, ragService: resumedRag });
  assert.equal(again.autoRecoveredCount + again.manualRecoveredCount, 0);
  await assert.rejects(
    withEnv(ENV, () =>
      resumeAgentExecutionGraphRun({
        accessScope,
        agentRunService: restarted,
        checkpoint,
        ragService: resumedRag,
        run,
        runId,
        skillRegistry: createDefaultSkillRegistry(),
      })
    ),
    (error) => error.status === 409
  );
  assert.equal(resumedRag.calls.length, 0);
});

test("a restart after the graph completed but before its receipt recomputes the same answer", async () => {
  const { runId, store } = await crashRun({
    crashBefore: (method, args) =>
      method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
  });
  const before = await loadRun(newService(store), runId);
  const restarted = newService(store);
  const resumedRag = createDocumentLoopRagService();
  const outcome = await recover({ agentRunService: restarted, ragService: resumedRag });
  const { checkpoint, run } = await loadRun(restarted, runId);
  const expected = await reference();

  assert.equal(before.checkpoint.phase, "completed");
  assert.equal(before.checkpoint.finalization, undefined);
  assert.equal(outcome.autoRecoveredCount, 1);
  assert.equal(resumedRag.calls.length, 0);
  assert.equal(run.status, "completed");
  assert.deepEqual(
    describeAnswerState(checkpoint.finalization.response),
    describeAnswerState(expected)
  );
  assert.equal(
    run.events.filter((event) => event.type === "unified_graph_executed").at(-1).payload.replayed,
    true
  );
});

test("a pending Web node is not resumed without the request's standing grant", async () => {
  const webCalls = [];
  const { runId, store } = await crashRun({
    capabilityApprovals: { "web.search": { approved: true } },
    crashAfter: (method, args) =>
      method === "saveExecutionGraphCheckpoint" &&
      checkpointHasNodeRun(args.checkpoint, "evidence_check"),
    proposal: createConditionalWebProposal,
    question: WEB_QUESTION,
    ragService: createDocumentLoopRagService({ primary: "abstain" }),
    webChatService: createWebChatService({ calls: webCalls }),
  });
  const restarted = newService(store);
  const outcome = await recover({
    agentRunService: restarted,
    ragService: createDocumentLoopRagService({ primary: "abstain" }),
    webChatService: createWebChatService({ calls: webCalls }),
  });
  const { checkpoint, run } = await loadRun(restarted, runId);
  const failed = run.events.filter((event) => event.type === "auto_recovery_failed");

  assert.equal(outcome.autoRecoveredCount, 0);
  assert.equal(outcome.failedCount, 1);
  assert.equal(webCalls.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.status, 409);
  // The worker that owns the claim hands the run to an operator under that
  // claim; it is not left `running` behind a spent claim.
  assert.equal(outcome.manualRecoveredCount, 1);
  assert.equal(run.status, "waiting_for_user");
  assert.equal(run.result.recovery.mode, "manual");
  assert.equal(run.result.recovery.reason, "graph_resume_failed");
  assert.ok(checkpoint.resumeClaim?.claimId);
  assert.equal(
    run.steps.some((step) => step.type === "graph_node" && step.input?.nodeId === "web"),
    false
  );
});

test("a finalization receipt binds the stored response to its answer digest", () => {
  const response = { body: { agentAnswer: "A", agentMode: "document", ragSources: [] }, status: 200 };
  const receipt = buildUnifiedGraphFinalizationReceipt(response);

  assert.equal(verifyUnifiedGraphFinalizationReceipt(receipt), true);
  assert.equal(
    verifyUnifiedGraphFinalizationReceipt({
      ...receipt,
      response: { ...receipt.response, body: { ...receipt.response.body, agentAnswer: "B" } },
    }),
    false
  );
  assert.equal(verifyUnifiedGraphFinalizationReceipt({ ...receipt, version: "v0" }), false);
});

test("a guarded run already finalized as a clarification is not resumed at startup", async () => {
  const store = createInMemoryAgentRunStore();
  const response = await ask({
    agentRunService: newService(store),
    mode: "guarded",
    ragService: createDocumentLoopRagService({ followUp: "unresolved" }),
  });
  const restarted = newService(store);
  const resumedRag = createDocumentLoopRagService({ followUp: "unresolved" });
  let resumeCalls = 0;
  const outcome = await withEnv(ENV, () =>
    createAgentRunRecoveryService({
      agentRunService: restarted,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: async () => { resumeCalls += 1; },
    }).recoverOnStartup({ mode: "auto" })
  );
  const { checkpoint, run } = await loadRun(restarted, response.body.agentRunId);

  assert.equal(response.body.agentMode, "clarification");
  assert.equal(run.status, "waiting_for_user");
  assert.equal(outcome.skippedCount, 1);
  assert.equal(outcome.manualRecoveredCount + outcome.autoRecoveredCount, 0);
  assert.equal(resumeCalls, 0);
  assert.equal(resumedRag.calls.length, 0);
  assert.equal(checkpoint.resumeClaim, undefined);
});

const withoutNodes = (...nodeIds) => () => ({
  nodes: createDocumentLoopProposal().nodes.filter((node) => !nodeIds.includes(node.nodeId)),
});

test("the graph's document loop derives checks it did not plan and honours a missing follow-up", async () => {
  // No follow-up planned although the primary check recommends one: the loop
  // stops at its limit and asks the user, as V1 does at max follow-ups.
  const noFollowUp = await ask({
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "guarded",
    proposal: withoutNodes("follow_up", "follow_up_check"),
    ragService: createDocumentLoopRagService(),
  });
  assert.equal(noFollowUp.body.agentMode, "clarification");
  assert.equal(noFollowUp.body.clarification.reason, "document_follow_up_limit_reached");
  assert.equal(
    noFollowUp.body.agentObservability.executionLoop.stoppedReason,
    "follow_up_limit_reached"
  );
  assert.equal(noFollowUp.body.agentObservability.budget.used.documentRagCalls, 1);

  // A follow-up without its own check node: the deterministic check is
  // derived from the follow-up's persisted evidence, with the same outcome.
  const derivedFollowUpCheck = await ask({
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "guarded",
    proposal: withoutNodes("follow_up_check"),
    ragService: createDocumentLoopRagService(),
  });
  const full = await reference();
  assert.deepEqual(describeAnswerState(derivedFollowUpCheck), describeAnswerState(full));

  // A lone primary document node: its check is derived too, and an
  // unsupported answer with no follow-up planned asks the user.
  const lonePrimary = await ask({
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "guarded",
    proposal: withoutNodes("primary_check", "follow_up", "follow_up_check"),
    ragService: createDocumentLoopRagService(),
  });
  assert.equal(lonePrimary.body.clarification.reason, "document_follow_up_limit_reached");
  assert.ok(
    lonePrimary.body.agentTrace.some(
      (step) => step.type === "self_check" && step.detail?.graphNodeId === "primary"
    )
  );

  // Evidence that already passes needs no loop at all.
  const supported = await ask({
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "guarded",
    proposal: withoutNodes("follow_up", "follow_up_check"),
    ragService: {
      ...createDocumentLoopRagService(),
      chat: async () => ({
        abstained: false,
        citations: [{
          docId: UNIFIED_DOC_ID,
          excerpt: "The vendor requires 30 days written notice before renewal.",
          fileName: "vendor-msa.pdf",
          pageNumber: 2,
        }],
        text: "The vendor requires 30 days written notice before renewal. [Source 1]",
      }),
    },
  });
  assert.equal(supported.body.agentMode, "document");
  assert.equal(supported.body.agentObservability.executionLoop.stoppedReason, "not_needed");
  assert.equal(supported.body.agentObservability.executionLoop.followUpsRun, 0);
});

test("approval continuation stays on V1: an approved pause resumes V1 and a re-entry never plans a graph", async () => {
  const webCalls = [];
  const plannerContexts = [];
  const ragService = createDocumentLoopRagService({ primary: "abstain" });
  const webChatService = createWebChatService({ calls: webCalls });
  const capabilityRegistry = createDefaultCapabilityRegistry({ ragService, webChatService });
  const agentRunService = newService(createInMemoryAgentRunStore());
  const run = (options = {}) =>
    withEnv({ ...ENV, AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded" }, () =>
      runAgentRag({
        accessScope,
        agentRunService,
        capabilityRegistry,
        docIds: [UNIFIED_DOC_ID],
        question: WEB_QUESTION,
        ragService,
        sessionId: UNIFIED_SESSION_ID,
        unifiedGraphPlannerAdapter: createProposalAdapter(createConditionalWebProposal, {
          contexts: plannerContexts,
        }),
        userId: accessScope.userId,
        webChatService,
        ...options,
      })
    );

  // No standing grant: the graph is refused and V1 pauses for approval.
  const paused = await run();
  const gate = paused.body.approvalGates?.[0];
  assert.equal(paused.body.agentMode, "clarification");
  assert.equal(gate?.capabilityId, "web.search");
  assert.equal(webCalls.length, 0);

  const resumed = await withEnv({ ...ENV, AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded" }, () =>
    createAgentRunStepExecutor({ agentRunService, capabilityRegistry }).applyApprovalAction({
      accessScope,
      action: "approve",
      gateId: gate.id,
      payload: { approvalObjectHash: gate.approvalObjectHash },
      runId: paused.body.agentRunId,
    })
  );
  assert.equal(resumed.run.status, "completed");
  assert.equal(webCalls.length, 1);
  assert.equal(plannerContexts.length, 1);
  assert.equal(
    (await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId: paused.body.agentRunId })),
    null
  );

  // Re-entering a paused run (even with a standing grant) keeps it on its V1
  // path: the graph planner is not consulted again.
  const pausedAgain = await run();
  assert.equal(pausedAgain.body.agentMode, "clarification");
  assert.equal(plannerContexts.length, 2);
  // Whatever V1 then does with the re-entry is V1's own behaviour; only the
  // graph invariants are pinned here.
  await run({
    agentRunId: pausedAgain.body.agentRunId,
    capabilityApprovals: { "web.search": { approved: true } },
  }).catch(() => null);
  const reenteredRun = await agentRunService.getRun({
    accessScope,
    runId: pausedAgain.body.agentRunId,
  });

  assert.equal(plannerContexts.length, 2);
  assert.equal(
    reenteredRun.steps.some((step) => step.type === "graph_node"),
    false
  );
  assert.deepEqual(
    reenteredRun.events
      .filter((event) => event.type === "unified_graph_planned")
      .map((event) => event.payload.errorCodes),
    [["approval_required_without_standing_grant"], ["approval_continuation_frozen"]]
  );
  assert.equal(
    await agentRunService.getExecutionGraphCheckpoint({
      accessScope,
      runId: pausedAgain.body.agentRunId,
    }),
    null
  );
});

test("the stage itself refuses an inadmissible or invalid graph before any durable write", async () => {
  const ragService = createDocumentLoopRagService({ primary: "abstain" });
  const webCalls = [];
  const capabilityRegistry = createDefaultCapabilityRegistry({
    ragService,
    webChatService: createWebChatService({ calls: webCalls }),
  });
  const agentRunService = newService(createInMemoryAgentRunStore());
  const runId = "unified-stage-refusal";
  await agentRunService.createRun({
    accessScope,
    goal: WEB_QUESTION,
    input: { docIds: [UNIFIED_DOC_ID], sessionId: UNIFIED_SESSION_ID, userId: accessScope.userId },
    plan: { mode: "document_web" },
    runId,
  });
  const budgetState = createAgentBudget();
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const stage = (graph) =>
    runUnifiedGraphStage({
      accessScope,
      agentRunId: runId,
      baseCapabilityRegistry: capabilityRegistry,
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      docIds: [UNIFIED_DOC_ID],
      executeObservedSkill: tracker.executeObservedSkill,
      loadExecutionGraphCheckpoint: () =>
        agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }),
      plan: { mode: "document_web" },
      planned: { graph: { ...graph, revision: 0, version: "v3" } },
      question: WEB_QUESTION,
      ragService,
      registry: createDefaultSkillRegistry(),
      saveExecutionGraphCheckpoint: (checkpoint) =>
        agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId }),
      sessionId: UNIFIED_SESSION_ID,
      stepLifecycle: createAgentRunStepLifecycle({ accessScope, agentRunService, runId }),
      userId: accessScope.userId,
    });

  await assert.rejects(stage(createConditionalWebProposal()), (error) => {
    assert.equal(error.code, "AGENT_UNIFIED_GRAPH_APPROVAL_UNSUPPORTED");
    assert.equal(error.preExecution, true);
    assert.deepEqual(error.reasonCodes, ["approval_required_without_standing_grant"]);
    return true;
  });
  await assert.rejects(
    stage({ nodes: [{ ...createConditionalWebProposal().nodes[0], skillId: "export_everything" }] }),
    (error) => {
      assert.equal(error.code, "AGENT_UNIFIED_GRAPH_REJECTED");
      assert.equal(error.preExecution, true);
      assert.deepEqual(error.reasonCodes, ["unregistered_capability"]);
      return true;
    }
  );
  assert.equal(await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }), null);
  assert.deepEqual((await agentRunService.getRun({ accessScope, runId })).steps, []);
  assert.equal(ragService.calls.length, 0);
  assert.equal(webCalls.length, 0);
});

// The shipped conditional-Web shape with a standing Web grant, on a request
// whose primary document answer is supported: the evidence check passes, so
// Web is skipped (condition_not_met) and the node after it with it
// (dependency_skipped). Recovery has no grant; it must still finish.
const SUFFICIENT_WEB_VARIANT = Object.freeze({
  capabilityApprovals: { "web.search": { approved: true } },
  proposal: createConditionalWebProposal,
  question: WEB_QUESTION,
});

test("a Web fallback its evidence check skipped never blocks recovery", async () => {
  const webCalls = [];
  const expected = await ask({
    ...SUFFICIENT_WEB_VARIANT,
    agentRunService: newService(createInMemoryAgentRunStore()),
    mode: "guarded",
    ragService: createDocumentLoopRagService({ primary: "supported" }),
    webChatService: createWebChatService({ calls: webCalls }),
  });
  assert.equal(webCalls.length, 0);

  for (const [label, crash] of [
    [
      "completed graph, no receipt yet",
      {
        crashBefore: (method, args) =>
          method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
      },
    ],
    [
      "running graph, passing evidence check settled",
      {
        crashAfter: (method, args) =>
          method === "saveExecutionGraphCheckpoint" &&
          checkpointHasNodeRun(args.checkpoint, "evidence_check"),
      },
    ],
  ]) {
    const { runId, store } = await crashRun({
      ...SUFFICIENT_WEB_VARIANT,
      ...crash,
      ragService: createDocumentLoopRagService({ primary: "supported" }),
      webChatService: createWebChatService({ calls: webCalls }),
    });
    const before = await loadRun(newService(store), runId);
    const restarted = newService(store);
    const resumedRag = createDocumentLoopRagService({ primary: "supported" });
    const outcome = await recover({
      agentRunService: restarted,
      ragService: resumedRag,
      webChatService: createWebChatService({ calls: webCalls }),
    });
    const { checkpoint, run } = await loadRun(restarted, runId);

    assert.equal(
      before.checkpoint.phase,
      label.startsWith("completed") ? "completed" : "running",
      label
    );
    assert.equal(outcome.autoRecoveredCount, 1, label);
    assert.equal(outcome.failedCount + outcome.manualRecoveredCount, 0, label);
    assert.equal(run.status, "completed", label);
    assert.equal(resumedRag.calls.length, 0, label);
    assert.equal(webCalls.length, 0, label);
    assert.deepEqual(
      describeAnswerState(checkpoint.finalization.response),
      describeAnswerState(expected),
      label
    );
    assert.deepEqual(
      run.events.filter((event) => event.type === "unified_graph_executed").at(-1)
        .payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status, nodeRun.reason ?? null]),
      [
        ["document", "reused", null],
        ["evidence_check", "reused", null],
        ["web", "skipped", "condition_not_met"],
        ["risk", "skipped", "dependency_skipped"],
      ],
      label
    );
  }
});

test("rolling the unified graph back to off stops startup recovery from running a v3 graph", async () => {
  const { runId, store } = await crashRun({
    crashAfter: (method, args) =>
      method === "saveExecutionGraphCheckpoint" &&
      checkpointHasNodeRun(args.checkpoint, "primary_check") &&
      !checkpointHasNodeRun(args.checkpoint, "follow_up"),
  });
  const restarted = newService(store);
  const resumedRag = createDocumentLoopRagService();
  let resumeCalls = 0;
  const outcome = await withEnv({ ...ENV, AGENT_UNIFIED_GRAPH_ROLLOUT: "off" }, () =>
    createAgentRunRecoveryService({
      agentRunService: restarted,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: async () => { resumeCalls += 1; },
    }).recoverOnStartup({ mode: "auto" })
  );
  const { checkpoint, run } = await loadRun(restarted, runId);

  assert.equal(outcome.autoRecoveredCount, 0);
  assert.equal(outcome.manualRecoveredCount, 1);
  assert.equal(resumeCalls, 0);
  assert.equal(resumedRag.calls.length, 0);
  assert.equal(run.status, "waiting_for_user");
  assert.equal(run.result.recovery.reason, "unified_graph_rollout_not_guarded");
  assert.equal(checkpoint.resumeClaim, undefined);
  assert.equal(checkpoint.phase, "running");
});

test("a sealed answer is replayed after a Skill version bump; a recomputation is handed to an operator", async () => {
  const sealed = await crashRun({
    crashAfter: (method, args) =>
      method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
  });
  const sealedBefore = await loadRun(newService(sealed.store), sealed.runId);
  const sealedService = newService(sealed.store);
  const sealedRag = createDocumentLoopRagService();
  const sealedOutcome = await recover({
    agentRunService: sealedService,
    ragService: sealedRag,
    skillRegistry: registryWithBumpedDocumentRag(),
  });
  const sealedAfter = await loadRun(sealedService, sealed.runId);

  // A stored receipt needs no live Skill: the run completes with it.
  assert.equal(sealedOutcome.autoRecoveredCount, 1);
  assert.equal(sealedAfter.run.status, "completed");
  assert.equal(
    sealedAfter.run.result.answer,
    sealedBefore.checkpoint.finalization.response.body.agentAnswer
  );
  assert.equal(sealedRag.calls.length, 0);

  const unsealed = await crashRun({
    crashBefore: (method, args) =>
      method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
  });
  const unsealedService = newService(unsealed.store);
  const unsealedRag = createDocumentLoopRagService();
  const unsealedOutcome = await recover({
    agentRunService: unsealedService,
    ragService: unsealedRag,
    skillRegistry: registryWithBumpedDocumentRag(),
  });
  const unsealedAfter = await loadRun(unsealedService, unsealed.runId);

  // Recomputing needs the live catalog, which changed: the claimed resume
  // fails before any node starts and the claim holder marks it manual.
  assert.equal(unsealedOutcome.autoRecoveredCount, 0);
  assert.equal(unsealedOutcome.failedCount, 1);
  assert.equal(unsealedOutcome.manualRecoveredCount, 1);
  assert.equal(unsealedRag.calls.length, 0);
  assert.equal(unsealedAfter.run.status, "waiting_for_user");
  assert.equal(unsealedAfter.run.result.recovery.reason, "graph_resume_failed");
  assert.equal(unsealedAfter.checkpoint.finalization, undefined);
  assert.deepEqual(
    eventTypes(unsealedAfter.run).filter((type) =>
      ["skill_graph_resume_claimed", "auto_recovery_failed", "manual_recovery_required"].includes(type)
    ),
    ["skill_graph_resume_claimed", "auto_recovery_failed", "manual_recovery_required"]
  );

  // Operators now see it; a later scan leaves it alone.
  const again = await recover({ agentRunService: unsealedService, ragService: unsealedRag });
  assert.equal(again.autoRecoveredCount + again.manualRecoveredCount + again.failedCount, 0);
});

test("a recovered completion writes experience memory and matches the uninterrupted response", async () => {
  const MEMORY_ENV = { RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "true", RAG_LONG_MEMORY_ENABLED: "true" };
  const describeRequestObservability = (response) => {
    const observability = response.body.agentObservability;

    return {
      experienceMemory: {
        hitCount: observability.experienceMemory.hitCount,
        status: observability.experienceMemory.status,
        storedCount: observability.experienceMemory.storedCount,
        writeAttempted: observability.experienceMemory.writeAttempted,
        writeStatus: observability.experienceMemory.write.status,
      },
      intentPlanner: observability.intentPlanner,
    };
  };

  await withAgentExperienceMemoryEnabled(async () => {
    const referenceStore = createInMemoryAgentExperienceStore();
    configureAgentExperienceMemoryStore(referenceStore);
    const expected = await ask({
      agentRunService: newService(createInMemoryAgentRunStore()),
      env: MEMORY_ENV,
      mode: "guarded",
      ragService: createDocumentLoopRagService(),
    });
    assert.equal(expected.body.agentObservability.experienceMemory.write.status, "stored");
    assert.equal(referenceStore.snapshot().length, 1);

    for (const [label, crash] of [
      [
        "receipt sealed",
        {
          crashAfter: (method, args) =>
            method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
        },
      ],
      [
        "receipt missing",
        {
          crashBefore: (method, args) =>
            method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
        },
      ],
    ]) {
      const experienceStore = createInMemoryAgentExperienceStore();
      configureAgentExperienceMemoryStore(experienceStore);
      const { runId, store } = await crashRun({ ...crash, env: MEMORY_ENV });
      // The experience write happens before the receipt, in the first process.
      assert.equal(experienceStore.snapshot().length, 1, label);

      const restarted = newService(store);
      const outcome = await recover({
        agentRunService: restarted,
        env: MEMORY_ENV,
        ragService: createDocumentLoopRagService(),
      });
      const { checkpoint, run } = await loadRun(restarted, runId);
      const recovered = checkpoint.finalization.response;

      assert.equal(outcome.autoRecoveredCount, 1, label);
      assert.equal(run.status, "completed", label);
      assert.deepEqual(describeAnswerState(recovered), describeAnswerState(expected), label);
      assert.deepEqual(
        describeRequestObservability(recovered),
        describeRequestObservability(expected),
        label
      );
      assert.equal(recovered.body.agentRunId, runId, label);
      // Recomputed or replayed, the record is one upsert under the same key.
      assert.equal(experienceStore.snapshot().length, 1, label);
      assert.deepEqual(
        experienceStore.snapshot().map((record) => record.memoryId),
        referenceStore.snapshot().map((record) => record.memoryId),
        label
      );
    }
  });
});
