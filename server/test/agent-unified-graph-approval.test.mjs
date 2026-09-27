import test from "node:test";
import assert from "node:assert/strict";

import {
  continueAgentExecutionGraphApproval,
  resumeAgentExecutionGraphRun,
  runAgentRag,
} from "../rag/agent.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import {
  buildAgentRunRecoveryState,
  createAgentRunRecoveryActionService,
} from "../rag/agent-run-recovery-actions.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  AGENT_TASK_ACTIONS,
  AGENT_TASK_RUNNER_ID,
  AGENT_TASK_TYPE,
  createAgentTaskRunner,
} from "../rag/agent-tasks.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { assessUnifiedGraphAdmission } from "../rag/agent-unified-graph-admission.js";
import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import { buildAuthorizedUnifiedGraphCatalog } from "../rag/skills/unified-graph-catalog.js";
import { createDefaultSkillRegistry } from "../rag/skills/registry.js";
import {
  TASK_STATUSES,
  createInMemoryTaskStore,
  createTaskService,
} from "../rag/tasks.js";
import {
  APPROVAL_TASK_QUESTION,
  UNIFIED_ACCESS_SCOPE as accessScope,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  createApprovalGatedTaskProposal,
  createCrashingRunService,
  createDocumentLoopRagService,
  createProposalAdapter,
  createTaskBeforeIndependentCheckProposal,
  createTaskCapabilityRegistry,
  requestBinding,
} from "./fixtures/unified-graph-run-fixtures.mjs";

// Approval continuation inside a guarded v3 graph, on the in-memory run store.
// The approval-gated Capability node parks at a clean boundary, the gate (the
// approval object hash over the exact resolved input, bound to run, graph
// digest, revision, and node) is persisted with its private snapshot through
// the same approval tables and policy V1 uses, and the approval endpoint's
// decision continues the SAME graph from its checkpoint. The PostgreSQL suite
// repeats pause, approve, crash, and deny across real process boundaries.

const ENV = Object.freeze({
  AGENT_PLANNER_ROLLOUT: "deterministic",
  // The live operator allowlist; approval continuation and startup recovery
  // read it again (the request under test injects the same list).
  AGENT_UNIFIED_GRAPH_CAPABILITIES: "task.create",
  AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

const withEnv = async (overrides, callback) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  Object.assign(process.env, overrides);

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const newService = () => createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });

const setup = async ({
  agentRunService = newService(),
  primary = "supported",
  proposal = createApprovalGatedTaskProposal,
} = {}) => {
  const ragService = createDocumentLoopRagService({ primary });
  const { registry, writes } = await createTaskCapabilityRegistry({ ragService });

  return { agentRunService, proposal, ragService, registry, writes };
};

const ask = ({ agentRunService, proposal, ragService, registry }) =>
  withEnv(ENV, () =>
    runAgentRag({
      accessScope,
      agentRunService,
      capabilityRegistry: registry,
      docIds: [UNIFIED_DOC_ID],
      question: APPROVAL_TASK_QUESTION,
      ragService,
      sessionId: UNIFIED_SESSION_ID,
      unifiedGraphAllowedCapabilityIds: ["task.create"],
      unifiedGraphPlannerAdapter: createProposalAdapter(proposal),
      userId: accessScope.userId,
    })
  );

// The existing approval endpoint handler, wired as app-services wires it.
// `env` models an operator changing the configuration between the pause and
// the decision.
const decide = ({ action, agentRunService, env = {}, gate, hash, ragService, registry, runId }) =>
  withEnv({ ...ENV, ...env }, () =>
    createAgentRunStepExecutor({
      agentRunService,
      capabilityRegistry: registry,
      continueExecutionGraphApproval: (args) =>
        continueAgentExecutionGraphApproval({
          ...args,
          agentRunService,
          capabilityRegistry: registry,
          ragService,
        }),
    }).applyApprovalAction({
      accessScope,
      action,
      gateId: gate.id,
      payload: { approvalObjectHash: hash ?? gate.approvalObjectHash },
      runId,
    })
  );

const load = async (agentRunService, runId) => ({
  checkpoint: (await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }))
    ?.checkpoint ?? null,
  run: await agentRunService.getRun({ accessScope, runId }),
});

const eventTypes = (run) => (run?.events ?? []).map((event) => event.type);

const lastExecuted = (run) =>
  (run?.events ?? []).filter((event) => event.type === "unified_graph_executed").at(-1)
    ?.payload ?? null;

const recover = ({ agentRunService, env = {}, ragService, registry }) =>
  withEnv({ ...ENV, ...env }, () =>
    createAgentRunRecoveryService({
      agentRunService,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: (args) =>
        resumeAgentExecutionGraphRun({
          ...args,
          agentRunService,
          capabilityRegistry: registry,
          ragService,
          skillRegistry: createDefaultSkillRegistry(),
        }),
    }).recoverOnStartup({ mode: "auto" })
  );

test("an approval-gated Capability parks the graph at its gate and approval runs it once in the same graph", async () => {
  const context = await setup();
  const paused = await ask(context);
  const runId = paused.body.agentRunId;
  const gate = paused.body.approvalGates?.[0];
  const before = await load(context.agentRunService, runId);

  // Paused like V1: the approval clarification, the run waiting for the user.
  assert.equal(paused.status, 200);
  assert.equal(paused.body.agentMode, "clarification");
  assert.equal(paused.body.clarification.reason, "capability_approval_required");
  assert.equal(before.run.status, "waiting_for_user");
  assert.equal(before.checkpoint.phase, "awaiting_approval");
  // The gate is graph-bound and shows the exact input the node would run with:
  // the verified document answer is the task description.
  assert.equal(gate.type, "graph_capability_approval");
  assert.equal(gate.nodeId, "task");
  assert.equal(gate.capabilityId, "task.create");
  assert.equal(gate.runId, runId);
  assert.equal(gate.graphDigest, before.checkpoint.approvalBoundary.graphDigest);
  assert.equal(
    gate.inputPreview.description,
    "The vendor requires 30 days written notice before renewal. [Source 1]"
  );
  assert.equal(gate.inputPreview.title, APPROVAL_TASK_QUESTION);
  // The nodes before the gate ran; the Capability did not.
  assert.deepEqual(
    before.checkpoint.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    [["document", "completed"], ["evidence_check", "completed"]]
  );
  assert.equal(context.writes.length, 0);
  assert.equal(context.ragService.calls.length, 1);
  assert.equal(eventTypes(before.run).includes("execution_planned"), false);
  assert.equal(eventTypes(before.run).at(-1), "graph_approval_gate_created");

  // A startup scan leaves the parked graph alone: nothing crashed.
  const scan = await recover(context);
  assert.equal(scan.skippedCount, 1);
  assert.equal(scan.manualRecoveredCount, 0);

  // The wrong approval object is refused and changes nothing.
  await assert.rejects(
    decide({ ...context, action: "approve", gate, hash: `sha256:${"0".repeat(64)}`, runId }),
    (error) => error.code === "approval_object_hash_mismatch" && error.status === 409
  );
  assert.deepEqual((await load(context.agentRunService, runId)).checkpoint, before.checkpoint);

  const approved = await decide({ ...context, action: "approve", gate, runId });
  const after = await load(context.agentRunService, runId);

  assert.equal(approved.status, 200);
  assert.equal(approved.run.status, "completed");
  assert.equal(approved.response.agentMode, "workspace_action");
  assert.match(approved.response.agentAnswer, /^Task recorded as task /);
  // Exactly once, with the approved input, under the node's idempotency key.
  assert.equal(context.writes.length, 1);
  assert.deepEqual(context.writes[0].input, {
    description: gate.inputPreview.description,
    title: gate.inputPreview.title,
  });
  assert.match(context.writes[0].taskId, /^capability-artifact:/);
  // The same graph, continued: completed nodes reused, nothing re-planned.
  assert.equal(after.checkpoint.graph.nodes.length, 3);
  assert.deepEqual(
    lastExecuted(after.run).nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    [["document", "reused"], ["evidence_check", "reused"], ["task", "completed"]]
  );
  assert.equal(context.ragService.calls.length, 1);
  assert.equal(after.checkpoint.phase, "completed");
  assert.equal(
    after.checkpoint.finalization.response.body.agentAnswer,
    approved.response.agentAnswer
  );
  assert.equal(
    eventTypes(after.run).filter((type) => type === "unified_graph_planned").length,
    1
  );
  assert.equal(after.run.approvalGates[0].status, "approved");

  // A decided gate cannot be decided again.
  await assert.rejects(
    decide({ ...context, action: "approve", gate, runId }),
    (error) => error.status === 409
  );
  assert.equal(context.writes.length, 1);
});

test("a rejected approval finalizes the same graph without the Capability", async () => {
  const context = await setup();
  const paused = await ask(context);
  const runId = paused.body.agentRunId;
  const gate = paused.body.approvalGates[0];
  const denied = await decide({ ...context, action: "deny", gate, runId });
  const after = await load(context.agentRunService, runId);

  assert.equal(denied.run.status, "completed");
  assert.equal(denied.response.agentMode, "workspace_action");
  assert.equal(denied.response.agentAnswer, "Create Task was not run: the approval was denied.");
  assert.equal(context.writes.length, 0);
  assert.equal(context.ragService.calls.length, 1);
  assert.deepEqual(
    lastExecuted(after.run).nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status, nodeRun.reason]),
    [
      ["document", "reused", null],
      ["evidence_check", "reused", null],
      ["task", "skipped", "approval_denied"],
    ]
  );
  assert.equal(after.run.approvalGates[0].status, "denied");
  assert.equal(after.checkpoint.phase, "completed");
  assert.ok(after.checkpoint.finalization);
  // The denied node has no lifecycle step: it never started.
  assert.equal(after.run.steps.some((step) => step.input?.nodeId === "task"), false);
});

test("nodes that do not depend on the gated Capability complete before the pause", async () => {
  const context = await setup({ proposal: createTaskBeforeIndependentCheckProposal });
  const paused = await ask(context);
  const runId = paused.body.agentRunId;
  const before = await load(context.agentRunService, runId);

  // The task is declared before the check, yet the check (independent of
  // the task) ran while the task waited, and the gate is bound to the
  // checkpoint that includes it.
  assert.equal(before.checkpoint.phase, "awaiting_approval");
  assert.deepEqual(
    before.checkpoint.nodeRuns.map((nodeRun) => nodeRun.nodeId).sort(),
    ["document", "evidence_check"]
  );
  assert.equal(
    paused.body.approvalGates[0].graphDigest,
    before.checkpoint.approvalBoundary.graphDigest
  );

  const approved = await decide({
    ...context,
    action: "approve",
    gate: paused.body.approvalGates[0],
    runId,
  });
  assert.equal(approved.run.status, "completed");
  assert.equal(context.writes.length, 1);
  assert.deepEqual(
    lastExecuted((await load(context.agentRunService, runId)).run).nodeRuns
      .map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    [["document", "reused"], ["task", "completed"], ["evidence_check", "reused"]]
  );
});

test("a stale approval (changed Capability version or tampered gate) is refused without deciding", async () => {
  const context = await setup();
  const paused = await ask(context);
  const runId = paused.body.agentRunId;
  const gate = paused.body.approvalGates[0];
  const { registry: bumped, writes: bumpedWrites } = await createTaskCapabilityRegistry({
    ragService: context.ragService,
    version: "1.0.1",
  });

  await assert.rejects(
    decide({ ...context, action: "approve", gate, registry: bumped, runId }),
    (error) => error.code === "graph_approval_stale" && error.status === 409
  );
  assert.equal(bumpedWrites.length, 0);

  // A gate whose shown input no longer matches its private snapshot is
  // refused by the run store's binding check, in the decision's own CAS.
  const store = context.agentRunService;
  const stored = await store.getRun({ accessScope, runId });
  assert.equal(stored.status, "waiting_for_user");
  const tamperedStore = createInMemoryAgentRunStore();
  const tampered = createAgentRunService({ agentRunStore: tamperedStore });
  const other = await setup({ agentRunService: tampered });
  const otherPaused = await ask(other);
  const raw = await tamperedStore.get({ accessScope, runId: otherPaused.body.agentRunId });
  await tamperedStore.update({
    accessScope,
    expectedRevision: raw.revision,
    patch: {
      approvalGates: raw.approvalGates.map((candidate) => ({
        ...candidate,
        inputPreview: { ...candidate.inputPreview, description: "Pay the vendor now." },
      })),
    },
    runId: otherPaused.body.agentRunId,
  });
  await assert.rejects(
    decide({
      ...other,
      action: "approve",
      gate: otherPaused.body.approvalGates[0],
      runId: otherPaused.body.agentRunId,
    }),
    (error) => error.status === 409
  );
  assert.equal(other.writes.length, 0);
  assert.equal(
    (await tampered.getRun({ accessScope, runId: otherPaused.body.agentRunId })).status,
    "waiting_for_user"
  );
});

test("after approval, a crash before the Capability starts is resumed once; a crash after its write is manual", async () => {
  // Before the node's step exists: startup recovery claims the reopened graph
  // and runs the approved Capability exactly once.
  const early = await setup();
  const earlyPaused = await ask(early);
  const earlyRunId = earlyPaused.body.agentRunId;
  const { service: crashingEarly } = createCrashingRunService(early.agentRunService, {
    crashBefore: (method, args) =>
      method === "recordRunStep" && args.input?.nodeId === "task",
  });
  await assert.rejects(
    decide({
      ...early,
      action: "approve",
      agentRunService: crashingEarly,
      gate: earlyPaused.body.approvalGates[0],
      runId: earlyRunId,
    }),
    (error) => error.code === "SIMULATED_PROCESS_EXIT"
  );
  assert.equal(early.writes.length, 0);
  const earlyOutcome = await recover(early);
  const earlyAfter = await load(early.agentRunService, earlyRunId);
  assert.equal(earlyOutcome.autoRecoveredCount, 1);
  assert.equal(earlyAfter.run.status, "completed");
  assert.equal(early.writes.length, 1);
  assert.equal(early.ragService.calls.length, 1);

  // After the write, before its receipt: the step is running and the outcome
  // unknown, so startup reconciliation hands the run to an operator.
  const late = await setup();
  const latePaused = await ask(late);
  const lateRunId = latePaused.body.agentRunId;
  const { service: crashingLate, state } = createCrashingRunService(late.agentRunService);
  const { registry: crashAfterWrite, writes: lateWrites } = await createTaskCapabilityRegistry({
    onWrite: async () => { state.crashed = true; },
    ragService: late.ragService,
  });
  await assert.rejects(
    decide({
      ...late,
      action: "approve",
      agentRunService: crashingLate,
      gate: latePaused.body.approvalGates[0],
      registry: crashAfterWrite,
      runId: lateRunId,
    }),
    (error) => error.code === "SIMULATED_PROCESS_EXIT"
  );
  assert.equal(lateWrites.length, 1);
  const lateOutcome = await recover({ ...late, registry: crashAfterWrite });
  const lateAfter = await load(late.agentRunService, lateRunId);
  assert.equal(lateOutcome.manualRecoveredCount, 1);
  assert.equal(lateAfter.run.result.recovery.mode, "manual");
  assert.equal(lateAfter.run.result.recovery.reason, "unknown_in_flight_node");
  assert.equal(lateWrites.length, 1);
});

test("a background task's approval re-entry continues the paused graph instead of re-planning", async () => {
  const context = await setup();
  const plannerContexts = [];
  const paused = await withEnv(ENV, () =>
    runAgentRag({
      accessScope,
      agentRunService: context.agentRunService,
      capabilityRegistry: context.registry,
      docIds: [UNIFIED_DOC_ID],
      question: APPROVAL_TASK_QUESTION,
      ragService: context.ragService,
      sessionId: UNIFIED_SESSION_ID,
      unifiedGraphAllowedCapabilityIds: ["task.create"],
      unifiedGraphPlannerAdapter: createProposalAdapter(createApprovalGatedTaskProposal, {
        contexts: plannerContexts,
      }),
      userId: accessScope.userId,
    })
  );
  const gate = paused.body.approvalGates[0];
  const reenter = (capabilityApprovals) =>
    withEnv(ENV, () =>
      runAgentRag({
        accessScope,
        agentRunId: paused.body.agentRunId,
        agentRunService: context.agentRunService,
        capabilityApprovals,
        capabilityRegistry: context.registry,
        docIds: [UNIFIED_DOC_ID],
        question: APPROVAL_TASK_QUESTION,
        ragService: context.ragService,
        sessionId: UNIFIED_SESSION_ID,
        unifiedGraphAllowedCapabilityIds: ["task.create"],
        unifiedGraphPlannerAdapter: createProposalAdapter(createApprovalGatedTaskProposal, {
          contexts: plannerContexts,
        }),
        userId: accessScope.userId,
      })
    );

  // A standing grant is not an approval of this gate.
  await assert.rejects(
    reenter({ "task.create": { approved: true } }),
    (error) => error.code === "graph_approval_not_pending"
  );
  const resumed = await reenter({
    "task.create": {
      approvalObjectHash: gate.approvalObjectHash,
      approved: true,
      decision: "approved",
      gateId: gate.id,
    },
  });

  assert.equal(resumed.body.agentRunId, paused.body.agentRunId);
  assert.equal(resumed.body.agentRunStatus, "completed");
  assert.equal(context.writes.length, 1);
  assert.equal(plannerContexts.length, 1);
});

test("admission accepts one approval-gated Capability per graph, only as the intent's own action", async () => {
  const ragService = createDocumentLoopRagService();
  const { registry: capabilityRegistry } = await createTaskCapabilityRegistry({ ragService });
  const catalog = buildAuthorizedUnifiedGraphCatalog({
    accessScope,
    allowedCapabilityIds: ["task.create"],
    capabilityRegistry,
    docIds: [UNIFIED_DOC_ID],
    ragService,
    registry: createDefaultSkillRegistry(),
  });
  const taskNode = (nodeId) => ({
    dependsOn: [],
    failurePolicy: "fail_fast",
    inputBindings: { title: requestBinding("question") },
    nodeId,
    skillId: "capability:task.create",
  });
  const assess = (nodes, plan = { actionCapabilityId: "task.create", mode: "workspace_action" }) =>
    assessUnifiedGraphAdmission({
      accessScope,
      capabilityRegistry,
      docIds: [UNIFIED_DOC_ID],
      graph: { nodes, revision: 0, version: "v3" },
      plan,
      registry: catalog.graphRegistry,
    });

  assert.equal(assess([taskNode("task")]).admitted, true);
  assert.deepEqual(assess([taskNode("task"), taskNode("task_again")]).reasonCodes, [
    "graph_not_projectable",
    "multiple_approval_gated_capabilities",
  ]);
  // Outside a matching workspace-action intent the finalizer has no place
  // for the action's answer.
  assert.deepEqual(assess([taskNode("task")], { mode: "document" }).reasonCodes, [
    "graph_not_projectable",
  ]);
});

test("a Capability input its policy refuses fails that node through its lifecycle, never runs it", async () => {
  // The task description is bound to the check's followUpQuestion, which is
  // empty when the check passes: task.create's policy refuses an empty
  // description, so the node fails (fail_fast) and the graph ends partial.
  const context = await setup({
    proposal: () => {
      const proposal = createApprovalGatedTaskProposal();
      const task = proposal.nodes.find((node) => node.nodeId === "task");
      task.inputBindings.description = {
        nodeId: "evidence_check",
        output: "followUpQuestion",
        source: "node",
      };
      return proposal;
    },
  });

  await assert.rejects(ask(context), (error) => error.code === "AGENT_UNIFIED_GRAPH_PARTIAL");
  const runs = await context.agentRunService.listRuns({ accessScope });
  const runId = (runs.runs ?? runs)[0].runId;
  const { checkpoint, run } = await load(context.agentRunService, runId);
  const taskStep = run.steps.find((step) => step.input?.nodeId === "task");

  assert.equal(context.writes.length, 0);
  assert.equal(run.status, "failed");
  assert.equal(checkpoint.phase, "partial");
  assert.equal(taskStep.status, "failed");
  assert.match(taskStep.error.message, /description must be a non-empty string/);
  assert.equal(run.approvalGates.length, 0);
});

// Crash the approval's continuation right before the gated node's step is
// recorded: the gate is approved, the node has not started.
const approveThenCrashBeforeTask = async (context, paused) => {
  const { service } = createCrashingRunService(context.agentRunService, {
    crashBefore: (method, args) =>
      method === "recordRunStep" && args.input?.nodeId === "task",
  });

  await assert.rejects(
    decide({
      ...context,
      action: "approve",
      agentRunService: service,
      gate: paused.body.approvalGates[0],
      runId: paused.body.agentRunId,
    }),
    (error) => error.code === "SIMULATED_PROCESS_EXIT"
  );
};

test("a Capability the operator removed from the live allowlist after the pause is never run", async () => {
  const revoked = { AGENT_UNIFIED_GRAPH_CAPABILITIES: "" };

  // The approval decision reads the live allowlist, refuses before deciding
  // anything, and hands the run to an operator.
  const context = await setup();
  const paused = await ask(context);
  const runId = paused.body.agentRunId;
  const gate = paused.body.approvalGates[0];

  await assert.rejects(
    decide({ ...context, action: "approve", env: revoked, gate, runId }),
    (error) =>
      error.code === "graph_approval_capability_not_allowed" && error.status === 409
  );
  const after = await load(context.agentRunService, runId);
  assert.equal(context.writes.length, 0);
  assert.equal(after.run.status, "waiting_for_user");
  assert.equal(after.run.approvalGates[0].status, "pending");
  assert.equal(after.checkpoint.phase, "awaiting_approval");
  assert.equal(after.run.result.recovery.mode, "manual");
  assert.equal(after.run.result.recovery.reason, "unified_graph_capability_not_allowed");
  assert.equal(buildAgentRunRecoveryState({ run: after.run }).required, true);
  // Restoring the allowlist does not reopen it behind the operator's back.
  await assert.rejects(
    decide({ ...context, action: "approve", gate, runId }),
    (error) => error.status === 409
  );
  assert.equal(context.writes.length, 0);

  // Startup recovery of an approved node that has not started honours the
  // revocation as well: the claimed resume refuses the node and the run goes
  // to an operator instead of writing.
  const early = await setup();
  const earlyPaused = await ask(early);
  await approveThenCrashBeforeTask(early, earlyPaused);
  const outcome = await recover({ ...early, env: revoked });
  const earlyAfter = await load(early.agentRunService, earlyPaused.body.agentRunId);
  assert.equal(outcome.autoRecoveredCount, 0);
  assert.equal(outcome.manualRecoveredCount, 1);
  assert.equal(early.writes.length, 0);
  assert.equal(earlyAfter.run.result.recovery.mode, "manual");
  assert.equal(earlyAfter.run.steps.some((step) => step.input?.nodeId === "task"), false);
});

test("rolling the rollout back after the pause hands the parked graph to an operator", async () => {
  // Startup under `off`: the parked run is not skipped as a clean pause; it
  // is marked manual and listed for the operator, with a cancel action.
  const context = await setup();
  const paused = await ask(context);
  const runId = paused.body.agentRunId;
  const scan = await recover({ ...context, env: { AGENT_UNIFIED_GRAPH_ROLLOUT: "off" } });
  const after = await load(context.agentRunService, runId);

  assert.equal(scan.skippedCount, 0);
  assert.equal(scan.manualRecoveredCount, 1);
  assert.equal(after.run.status, "waiting_for_user");
  assert.equal(after.run.result.recovery.mode, "manual");
  assert.equal(after.run.result.recovery.reason, "unified_graph_rollout_not_guarded");
  const recoveryState = buildAgentRunRecoveryState({ run: after.run });
  assert.equal(recoveryState.required, true);
  assert.ok(recoveryState.actions.some((action) => action.type === "cancel"));
  assert.equal(context.writes.length, 0);
  // The operator can resolve it.
  const canceled = await createAgentRunRecoveryActionService({
    agentRunService: context.agentRunService,
    recordRecoveryTrace: async () => {},
  }).applyRecoveryAction({ accessScope, action: "cancel", runId });
  assert.equal(canceled.run.status, "canceled");

  // A decision under `shadow` is refused and leaves the same operator trail,
  // for a denial as for an approval.
  for (const action of ["approve", "deny"]) {
    const other = await setup();
    const otherPaused = await ask(other);
    const otherRunId = otherPaused.body.agentRunId;

    await assert.rejects(
      decide({
        ...other,
        action,
        env: { AGENT_UNIFIED_GRAPH_ROLLOUT: "shadow" },
        gate: otherPaused.body.approvalGates[0],
        runId: otherRunId,
      }),
      (error) => error.code === "unified_graph_rollout_not_guarded" && error.status === 409
    );
    const otherAfter = await load(other.agentRunService, otherRunId);
    assert.equal(otherAfter.run.status, "waiting_for_user", action);
    assert.equal(otherAfter.run.approvalGates[0].status, "pending", action);
    assert.equal(otherAfter.run.result.recovery.reason, "unified_graph_rollout_not_guarded", action);
    assert.equal(buildAgentRunRecoveryState({ run: otherAfter.run }).required, true, action);
    assert.equal(other.writes.length, 0, action);
  }
});

test("a background task parked at a graph gate survives 'continue' and can deny the gate", async () => {
  const context = await setup();
  const taskId = "agent_goal:unified-graph-gate";
  const plannerContexts = [];
  const taskService = createTaskService({ taskStore: createInMemoryTaskStore() });
  const runner = createAgentTaskRunner({
    // The gate is the subject here; the goal requests no deliverable.
    goalDeliverableService: {
      execute: async () => {
        throw new Error("no goal deliverable is requested");
      },
      prepare: async () => ({ specs: [], status: "not_requested" }),
    },
    runAgentTask: (request) =>
      withEnv(ENV, () =>
        runAgentRag({
          ...request,
          agentRunService: context.agentRunService,
          capabilityRegistry: context.registry,
          ragService: context.ragService,
          unifiedGraphAllowedCapabilityIds: ["task.create"],
          unifiedGraphPlannerAdapter: createProposalAdapter(createApprovalGatedTaskProposal, {
            contexts: plannerContexts,
          }),
        })
      ),
  });
  const orchestrator = createJobOrchestrator({
    runners: { [runner.id]: runner },
    taskService,
  });
  const readTask = () => taskService.getInternalTask({ accessScope, taskId });
  const runQueued = () => orchestrator.runTask({ accessScope, taskId });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: taskId,
      input: {
        docIds: [UNIFIED_DOC_ID],
        maxIterations: 3,
        question: APPROVAL_TASK_QUESTION,
        sessionId: UNIFIED_SESSION_ID,
        userId: accessScope.userId,
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: [UNIFIED_DOC_ID],
        iterations: [],
        maxIterations: 3,
        question: APPROVAL_TASK_QUESTION,
        sessionId: UNIFIED_SESSION_ID,
        userId: accessScope.userId,
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });
  await runQueued();
  let task = await readTask();
  const runId = task.payload.agentRunId;
  const [gate] = task.payload.pending.approvalGates;

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.requiredUserAction, "approve_capability");
  assert.equal(gate.type, "graph_capability_approval");

  // 'continue' carries no decision for the gate: the paused graph re-states
  // its approval, the task keeps waiting with the same gate, nothing ran.
  await orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.continue,
    payload: { answer: "Use the renewal clause." },
    runImmediately: false,
    taskId,
  });
  await runQueued();
  task = await readTask();
  let stored = await load(context.agentRunService, runId);

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.requiredUserAction, "approve_capability");
  assert.equal(task.payload.agentRunId, runId);
  assert.deepEqual(
    task.payload.pending.approvalGates.map((candidate) => [
      candidate.id,
      candidate.approvalObjectHash,
    ]),
    [[gate.id, gate.approvalObjectHash]]
  );
  assert.equal(stored.run.status, "waiting_for_user");
  assert.equal(stored.run.approvalGates[0].status, "pending");
  assert.equal(stored.checkpoint.phase, "awaiting_approval");
  assert.equal(plannerContexts.length, 1);
  assert.equal(context.ragService.calls.length, 1);
  assert.equal(context.writes.length, 0);

  // A task-level deny decides the same gate: the graph is finalized without
  // the Capability and the task completes with that answer.
  await orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.deny,
    payload: { approvalObjectHash: gate.approvalObjectHash, gateId: gate.id },
    runImmediately: false,
    taskId,
  });
  await runQueued();
  task = await readTask();
  stored = await load(context.agentRunService, runId);

  assert.equal(task.status, TASK_STATUSES.completed);
  assert.equal(task.result.answer, "Create Task was not run: the approval was denied.");
  assert.equal(stored.run.status, "completed");
  assert.equal(stored.run.approvalGates[0].status, "denied");
  assert.equal(plannerContexts.length, 1);
  assert.equal(context.writes.length, 0);
});

test("a task deny needs the pending graph gate's exact binding", async () => {
  const graphGate = {
    approvalObjectHash: `sha256:${"b".repeat(64)}`,
    capabilityId: "task.create",
    id: "graph-gate-1",
    status: "pending",
    type: "graph_capability_approval",
  };
  const runner = createAgentTaskRunner();
  const task = (gate) => ({
    payload: {
      agentRunId: "run-1",
      pending: { agentRunId: "run-1", approvalGates: [gate] },
      question: APPROVAL_TASK_QUESTION,
    },
    status: TASK_STATUSES.waitingForUser,
  });
  const deny = (gate, payload) =>
    runner.resume({ action: AGENT_TASK_ACTIONS.deny, payload, task: task(gate) });

  const queued = await deny(graphGate, {
    approvalObjectHash: graphGate.approvalObjectHash,
    gateId: graphGate.id,
  });
  assert.equal(queued.status, TASK_STATUSES.queued);
  assert.equal(queued.payload.resumeAgentRunId, true);
  assert.deepEqual(queued.payload.capabilityApprovals, {
    "task.create": {
      approvalObjectHash: graphGate.approvalObjectHash,
      approved: false,
      decision: "denied",
      gateId: graphGate.id,
      source: "task_action",
    },
  });
  await assert.rejects(
    deny(graphGate, { approvalObjectHash: `sha256:${"c".repeat(64)}`, gateId: graphGate.id }),
    (error) => error.status === 409
  );
  // A V1 gate has no task-level deny: its run decides it.
  await assert.rejects(
    deny({ ...graphGate, type: "capability_approval" }, {
      approvalObjectHash: graphGate.approvalObjectHash,
      gateId: graphGate.id,
    }),
    (error) => error.status === 409
  );
});
