import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentRunRecoveryService,
  findAutoRecoverableStep,
} from "../rag/agent-run-recovery.js";
import {
  STEP_REPLAY_SAFETY_REASON_CODES,
} from "../rag/agent-run-step-replay-safety.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createDocumentRagStepExecutor,
} from "../rag/agent-run-step-handlers/index.js";
import {
  AGENT_RUN_STEP_STATUSES,
} from "../rag/agent-run-steps.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { SKILL_EFFECTS } from "../rag/skills/skill-contract.js";
import { createAgentBudget } from "../rag/agent-budget.js";
import {
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createExecutionGraph } from "../rag/agent-execution-graph.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
};

test("agent run recovery marks startup running runs for manual recovery", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-18T00:00:00.000Z",
    }),
  });
  const recordedRecoveryEvents = [];
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    now: () => "2026-06-18T00:01:00.000Z",
    recordRecoveryTrace: async (event) => recordedRecoveryEvents.push(event),
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Recover this run",
    runId: "run-recoverable",
  });
  await agentRunService.createRun({
    accessScope,
    goal: "Completed run",
    runId: "run-completed",
  });
  await agentRunService.completeRun({
    accessScope,
    runId: "run-completed",
  });

  const result = await recoveryService.recoverOnStartup();

  assert.equal(result.mode, "manual");
  assert.equal(result.recoveredCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.runs[0].runId, "run-recoverable");
  assert.equal(result.runs[0].status, AGENT_RUN_STATUSES.waitingForUser);
  assert.deepEqual(
    {
      autoReplayAttemptCount: recordedRecoveryEvents[0].autoReplayAttemptCount,
      eventType: recordedRecoveryEvents[0].eventType,
      manualRecoveryCount: recordedRecoveryEvents[0].manualRecoveryCount,
      recoverableRunCount: recordedRecoveryEvents[0].recoverableRunCount,
      traceType: recordedRecoveryEvents[0].traceType,
    },
    {
      autoReplayAttemptCount: 0,
      eventType: "startup_recovery_completed",
      manualRecoveryCount: 1,
      recoverableRunCount: 1,
      traceType: "agent_run_recovery",
    }
  );

  const recoveredRun = await agentRunService.getRun({
    accessScope,
    runId: "run-recoverable",
  });

  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.deepEqual(recoveredRun.result.recovery, {
    mode: "manual",
    originalStatus: AGENT_RUN_STATUSES.running,
    reason: "server_startup_recovery",
    recoveredAt: "2026-06-18T00:01:00.000Z",
  });
  assert.ok(
    recoveredRun.events.some(
      (event) => event.type === "manual_recovery_required"
    )
  );

  const secondResult = await recoveryService.recoverOnStartup();

  assert.equal(secondResult.recoveredCount, 0);
  assert.equal(secondResult.skippedCount, 1);
});

test("agent run recovery leaves a memory-writing document step for manual recovery", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-18T00:00:00.000Z",
    }),
  });
  const ragCalls = [];
  const agentRunStepExecutor = createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async (docIds, question, options) => {
          ragCalls.push({
            docIds,
            options,
            question,
          });

          return {
            citations: [
              {
                docId: "doc-1",
                title: "Policy",
              },
            ],
            text: "Recovered document answer.",
          };
        },
      },
    }),
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    agentRunStepExecutor,
    now: () => "2026-06-18T00:01:00.000Z",
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Recover document step",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-auto-document",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "run-auto-document",
    patch: {
      steps: [
        {
          id: "document-step",
          input: {
            docIds: ["doc-1"],
            question: "What changed?",
          },
          kind: "tool_call",
          status: AGENT_RUN_STEP_STATUSES.pending,
          type: "document_rag",
        },
      ],
    },
  });

  const result = await recoveryService.recoverOnStartup({
    mode: "auto",
  });
  const recoveredRun = await agentRunService.getRun({
    accessScope,
    runId: "run-auto-document",
  });

  assert.equal(result.mode, "auto");
  assert.equal(result.autoRecoveredCount, 0);
  assert.equal(result.manualRecoveredCount, 1);
  assert.equal(result.recoveredCount, 1);
  assert.equal(ragCalls.length, 0);
  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.equal(recoveredRun.result.recovery.mode, "manual");
  assert.equal(recoveredRun.result.recovery.reason, "non_idempotent");
  assert.equal(
    recoveredRun.steps[0].status,
    AGENT_RUN_STEP_STATUSES.pending
  );
  assert.deepEqual(
    recoveredRun.events.map((event) => event.type),
    [
      "run_created",
      "manual_recovery_required",
    ]
  );
});

test("agent run recovery falls back to manual when auto finds an approval gate", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    agentRunStepExecutor: {
      resumeStep: async () => {
        throw new Error("Approval recovery should stay manual.");
      },
    },
    now: () => "2026-06-18T00:01:00.000Z",
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Approve web search",
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "run-approval",
    patch: {
      approvalGates: [
        {
          capabilityId: "web.search",
          id: "gate-web",
          status: "pending",
        },
      ],
      steps: [
        {
          approvalGateId: "gate-web",
          id: "approval-step",
          kind: "approval_gate",
          status: AGENT_RUN_STEP_STATUSES.paused,
          type: "capability_approval_gate",
        },
      ],
    },
  });

  const result = await recoveryService.recoverOnStartup({
    mode: "auto",
  });
  const recoveredRun = await agentRunService.getRun({
    accessScope,
    runId: "run-approval",
  });

  assert.equal(result.autoRecoveredCount, 0);
  assert.equal(result.manualRecoveredCount, 1);
  assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.deepEqual(recoveredRun.result.recovery, {
    mode: "manual",
    originalStatus: AGENT_RUN_STATUSES.waitingForUser,
    reason: "pending_approval_gate",
    recoveredAt: "2026-06-18T00:01:00.000Z",
    requestedMode: "auto",
  });
  assert.ok(
    recoveredRun.events.some(
      (event) => event.type === "manual_recovery_required"
    )
  );
});

test("agent run recovery can be disabled on startup", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Leave this run untouched",
    runId: "run-off",
  });

  const result = await recoveryService.recoverOnStartup({
    mode: "off",
  });
  const run = await agentRunService.getRun({
    accessScope,
    runId: "run-off",
  });

  assert.equal(result.mode, "off");
  assert.equal(result.recoveredCount, 0);
  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(run.result.recovery, undefined);
});

// ---------------------------------------------------------------------------
// Scenario F -- a graph node is a custom_skill step like any other
// ---------------------------------------------------------------------------

/**
 * Auto recovery re-runs a step without asking anyone. That is the right default
 * for a whitelisted read-only skill and the wrong one for a skill that writes,
 * and now that a graph node is persisted under the same custom_skill step type
 * as a RAG read, only the contract stored with the step tells them apart.
 */
const nodeStep = ({ effects, nodeId, skillId }) => ({
  id: `custom_skill:${nodeId}`,
  input: {
    docIds: ["doc-1"],
    effects,
    nodeId,
    question: "Which obligations changed?",
    skillId,
  },
  status: AGENT_RUN_STEP_STATUSES.running,
  type: "custom_skill",
});

test("auto recovery refuses a graph node that declared a side effect", () => {
  const writeOnly = findAutoRecoverableStep({
    run: {
      steps: [
        nodeStep({
          effects: SKILL_EFFECTS.workspaceWrite,
          nodeId: "publish",
          skillId: "publish_report",
        }),
      ],
    },
  });

  assert.equal(writeOnly.step, null);
  assert.equal(writeOnly.reason, STEP_REPLAY_SAFETY_REASON_CODES.externalWrite);
  assert.equal(writeOnly.safety.canAutoReplay, false);
});

test("auto recovery still replays the read-only nodes of an interrupted graph", () => {
  const mixed = findAutoRecoverableStep({
    run: {
      steps: [
        nodeStep({
          effects: SKILL_EFFECTS.externalWrite,
          nodeId: "publish",
          skillId: "publish_report",
        }),
        nodeStep({
          effects: SKILL_EFFECTS.readOnly,
          nodeId: "risk_a",
          skillId: "risk_review",
        }),
      ],
    },
  });

  // Declaration order does not decide this: the writing node is passed over
  // rather than being allowed to block recovery of the read-only one.
  assert.equal(mixed.step.id, "custom_skill:risk_a");
  assert.equal(mixed.reason, "safe_step_ready");
});

const createGraphRecoveryFixture = async ({
  agentRunStore = createInMemoryAgentRunStore(),
  outerStepIds = ["custom_skills"],
} = {}) => {
  const accessScope = { userId: "alice", workspaceId: "workspace-a" };
  const agentRunService = createAgentRunService({
    agentRunStore,
  });
  const runId = `graph-${outerStepIds.join("-")}`;
  const goal = "Compare these documents.";
  const docIds = ["doc-1", "doc-2"];
  await agentRunService.createRun({
    accessScope,
    goal,
    input: { docIds, sessionId: "session-1", userId: "alice" },
    runId,
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId,
    type: "execution_planned",
    payload: { planner: { stepIds: outerStepIds } },
  });
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({
      nodes: [{
        dependsOn: [],
        failurePolicy: "continue",
        inputBindings: {
          docIds: { source: "request", field: "docIds" },
          question: { source: "request", field: "question" },
        },
        nodeId: "compare",
        skillId: "compare_documents",
      }],
    }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState: createAgentBudget(),
      docIds,
      question: goal,
      selectedSkills: [{ id: "compare_documents", version: "1.0.0" }],
      sessionId: "session-1",
      userId: "alice",
    }),
  });
  await agentRunService.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint,
    runId,
  });

  return { accessScope, agentRunService, checkpoint, runId };
};

test("startup auto recovery never replays a graph node as an isolated step", async () => {
  const fixture = await createGraphRecoveryFixture();
  let stepReplays = 0;
  const recovery = createAgentRunRecoveryService({
    agentRunService: fixture.agentRunService,
    agentRunStepExecutor: {
      resumeStep: async () => { stepReplays += 1; },
    },
    recordRecoveryTrace: async () => {},
  });

  const outcome = await recovery.recoverOnStartup({ mode: "auto" });
  const run = await fixture.agentRunService.getRun({
    accessScope: fixture.accessScope,
    runId: fixture.runId,
  });
  assert.equal(outcome.autoRecoveredCount, 0);
  assert.equal(outcome.manualRecoveredCount, 1);
  assert.equal(stepReplays, 0);
  assert.equal(run.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.equal(run.result.recovery.reason, "graph_resume_executor_unavailable");
  assert.equal(run.result.__skillGraphCheckpoint, undefined);
});

for (const effects of [SKILL_EFFECTS.readOnly, SKILL_EFFECTS.workspaceWrite]) {
  test(`an in-flight ${effects} graph node requires manual startup recovery`, async () => {
    const fixture = await createGraphRecoveryFixture();
    await fixture.agentRunService.recordRunStep({
      accessScope: fixture.accessScope,
      graphResumeClaimId: null,
      input: {
        docIds: ["doc-1", "doc-2"],
        effects,
        nodeId: "compare",
        question: "Compare these documents.",
        skillId: "compare_documents",
        skillVersion: "1.0.0",
      },
      runId: fixture.runId,
      status: "running",
      stepId: "custom_skill:compare",
      type: "custom_skill",
    });
    let graphResumes = 0;
    const recovery = createAgentRunRecoveryService({
      agentRunService: fixture.agentRunService,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: async () => { graphResumes += 1; },
    });

    const outcome = await recovery.recoverOnStartup({ mode: "auto" });
    const run = await fixture.agentRunService.getRun({
      accessScope: fixture.accessScope,
      runId: fixture.runId,
    });
    assert.equal(outcome.autoRecoveredCount, 0);
    assert.equal(outcome.manualRecoveredCount, 1);
    assert.equal(graphResumes, 0);
    assert.equal(run.result.recovery.reason, "unknown_in_flight_node");
    assert.equal(run.status, AGENT_RUN_STATUSES.waitingForUser);
    assert.equal(
      run.events.filter((event) => event.type === "manual_recovery_required").length,
      1
    );
    const stored = await fixture.agentRunService.getExecutionGraphCheckpoint({
      accessScope: fixture.accessScope,
      runId: fixture.runId,
    });
    assert.deepEqual(
      await fixture.agentRunService.claimExecutionGraphResume({
        accessScope: fixture.accessScope,
        checkpointDigest: stored.checkpoint.digest,
        runId: fixture.runId,
      }),
      { checkpoint: null, claimed: false }
    );
    await assert.rejects(
      fixture.agentRunService.saveExecutionGraphCheckpoint({
        accessScope: fixture.accessScope,
        checkpoint: updateExecutionGraphCheckpoint(stored.checkpoint, {}),
        runId: fixture.runId,
      }),
      (error) => error.code === "AGENT_GRAPH_EXECUTION_FENCED"
    );
    await assert.rejects(
      fixture.agentRunService.completeRun({
        accessScope: fixture.accessScope,
        runId: fixture.runId,
      }),
      (error) => error.code === "AGENT_GRAPH_EXECUTION_FENCED"
    );
  });
}

test("graph-only callback cannot run when earlier outer stages were planned", async () => {
  const fixture = await createGraphRecoveryFixture({
    outerStepIds: ["document_rag", "custom_skills"],
  });
  let graphResumes = 0;
  const recovery = createAgentRunRecoveryService({
    agentRunService: fixture.agentRunService,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: async () => { graphResumes += 1; },
  });

  await recovery.recoverOnStartup({ mode: "auto" });
  const run = await fixture.agentRunService.getRun({
    accessScope: fixture.accessScope,
    runId: fixture.runId,
  });
  assert.equal(graphResumes, 0);
  assert.equal(run.result.recovery.reason, "graph_outer_plan_not_resumable");
});

for (const phase of ["completed", "partial"]) {
  test(`startup treats a ${phase} graph checkpoint before run finalization as manual recovery`, async () => {
    const fixture = await createGraphRecoveryFixture();
    const terminalCheckpoint = updateExecutionGraphCheckpoint(fixture.checkpoint, { phase });
    await fixture.agentRunService.saveExecutionGraphCheckpoint({
      accessScope: fixture.accessScope,
      checkpoint: terminalCheckpoint,
      runId: fixture.runId,
    });
    const directClaim = await fixture.agentRunService.claimExecutionGraphResume({
      accessScope: fixture.accessScope,
      checkpointDigest: terminalCheckpoint.digest,
      runId: fixture.runId,
    });
    assert.equal(directClaim.claimed, false);
    let resumes = 0;
    const recovery = createAgentRunRecoveryService({
      agentRunService: fixture.agentRunService,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: async () => { resumes += 1; },
    });

    const outcome = await recovery.recoverOnStartup({ mode: "auto" });
    const run = await fixture.agentRunService.getRun({
      accessScope: fixture.accessScope,
      runId: fixture.runId,
    });
    assert.equal(outcome.autoRecoveredCount, 0);
    assert.equal(outcome.manualRecoveredCount, 1);
    assert.equal(resumes, 0);
    assert.equal(run.result.recovery.reason, "graph_finalization_requires_recovery");
  });
}

test("graph-only startup callback receives the stored graph without replanning", async () => {
  const fixture = await createGraphRecoveryFixture();
  const received = [];
  const recovery = createAgentRunRecoveryService({
    agentRunService: fixture.agentRunService,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: async ({ accessScope, checkpoint, runId }) => {
      received.push({ checkpoint, runId });
      await fixture.agentRunService.completeRun({
        accessScope,
        graphResumeClaimId: checkpoint.resumeClaim.claimId,
        runId,
      });
    },
  });

  const outcome = await recovery.recoverOnStartup({ mode: "auto" });
  assert.equal(outcome.autoRecoveredCount, 1);
  assert.equal(outcome.manualRecoveredCount, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].runId, fixture.runId);
  assert.deepEqual(received[0].checkpoint.graph, fixture.checkpoint.graph);
});

test("an existing graph claim cannot be claimed or executed again", async () => {
  const fixture = await createGraphRecoveryFixture();
  const firstClaim = await fixture.agentRunService.claimExecutionGraphResume({
    accessScope: fixture.accessScope,
    checkpointDigest: fixture.checkpoint.digest,
    runId: fixture.runId,
  });
  assert.equal(firstClaim.claimed, true);

  let graphResumes = 0;
  const recovery = createAgentRunRecoveryService({
    agentRunService: fixture.agentRunService,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: async () => { graphResumes += 1; },
  });
  const outcome = await recovery.recoverOnStartup({ mode: "auto" });
  const run = await fixture.agentRunService.getRun({
    accessScope: fixture.accessScope,
    runId: fixture.runId,
  });

  assert.equal(graphResumes, 0);
  assert.equal(outcome.autoRecoveredCount, 0);
  assert.equal(outcome.manualRecoveredCount, 0);
  assert.equal(outcome.skippedCount, 1);
  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(run.result.recovery, undefined);
  assert.equal(
    run.events.filter((event) => event.type === "skill_graph_resume_claimed").length,
    1
  );
});

test("manual startup recovery cannot overwrite a graph owned by a resumed worker", async () => {
  const fixture = await createGraphRecoveryFixture();
  const claim = await fixture.agentRunService.claimExecutionGraphResume({
    accessScope: fixture.accessScope,
    checkpointDigest: fixture.checkpoint.digest,
    runId: fixture.runId,
  });
  assert.equal(claim.claimed, true);
  const before = await fixture.agentRunService.getRun({
    accessScope: fixture.accessScope,
    runId: fixture.runId,
  });
  const recovery = createAgentRunRecoveryService({
    agentRunService: fixture.agentRunService,
    recordRecoveryTrace: async () => {},
  });

  const outcome = await recovery.recoverOnStartup({ mode: "manual" });
  const after = await fixture.agentRunService.getRun({
    accessScope: fixture.accessScope,
    runId: fixture.runId,
  });

  assert.equal(outcome.manualRecoveredCount, 0);
  assert.equal(outcome.skippedCount, 1);
  assert.equal(after.status, AGENT_RUN_STATUSES.running);
  assert.equal(after.revision, before.revision);
  assert.equal(after.result.recovery, undefined);
  assert.deepEqual(after.events, before.events);
});

test("a graph resume claim racing a manual recovery CAS wins without a manual marker", async () => {
  const baseStore = createInMemoryAgentRunStore();
  const atManualCommit = deferred();
  const releaseManualCommit = deferred();
  const agentRunStore = {
    ...baseStore,
    async updateWithEvent(args) {
      if (args.event?.type === "manual_recovery_required") {
        atManualCommit.resolve();
        await releaseManualCommit.promise;
      }

      return baseStore.updateWithEvent(args);
    },
  };
  const fixture = await createGraphRecoveryFixture({ agentRunStore });
  const recovery = createAgentRunRecoveryService({
    agentRunService: fixture.agentRunService,
    recordRecoveryTrace: async () => {},
  });
  const manualRecovery = recovery.recoverOnStartup({ mode: "manual" });
  await atManualCommit.promise;

  try {
    const claim = await fixture.agentRunService.claimExecutionGraphResume({
      accessScope: fixture.accessScope,
      checkpointDigest: fixture.checkpoint.digest,
      runId: fixture.runId,
    });
    assert.equal(claim.claimed, true);
  } finally {
    releaseManualCommit.resolve();
  }

  const outcome = await manualRecovery;
  const run = await fixture.agentRunService.getRun({
    accessScope: fixture.accessScope,
    runId: fixture.runId,
  });
  assert.equal(outcome.manualRecoveredCount, 0);
  assert.equal(outcome.skippedCount, 1);
  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(run.result.recovery, undefined);
  assert.equal(run.events.some((event) => event.type === "manual_recovery_required"), false);
});

test("a second startup worker does not mark an actively resuming graph manual", async () => {
  const fixture = await createGraphRecoveryFixture();
  let signalStarted;
  let releaseFirst;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const finishFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const recovery = createAgentRunRecoveryService({
    agentRunService: fixture.agentRunService,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: async ({ accessScope, checkpoint, runId }) => {
      signalStarted();
      await finishFirst;
      await fixture.agentRunService.completeRun({
        accessScope,
        graphResumeClaimId: checkpoint.resumeClaim.claimId,
        runId,
      });
    },
  });

  const firstRecovery = recovery.recoverOnStartup({ mode: "auto" });
  await started;
  const secondOutcome = await recovery.recoverOnStartup({ mode: "auto" });
  const whileRunning = await fixture.agentRunService.getRun({
    accessScope: fixture.accessScope,
    runId: fixture.runId,
  });

  assert.equal(secondOutcome.skippedCount, 1);
  assert.equal(secondOutcome.manualRecoveredCount, 0);
  assert.equal(whileRunning.status, AGENT_RUN_STATUSES.running);
  assert.equal(
    whileRunning.events.some((event) => event.type === "manual_recovery_required"),
    false
  );

  releaseFirst();
  const firstOutcome = await firstRecovery;
  const completed = await fixture.agentRunService.getRun({
    accessScope: fixture.accessScope,
    runId: fixture.runId,
  });
  assert.equal(firstOutcome.autoRecoveredCount, 1);
  assert.equal(completed.status, AGENT_RUN_STATUSES.completed);
});

test("an executed guarded graph with a missing checkpoint is manual recovery", async () => {
  const accessScope = { userId: "alice", workspaceId: "workspace-a" };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  await agentRunService.createRun({
    accessScope,
    goal: "Compare documents",
    runId: "graph-missing-checkpoint",
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId: "graph-missing-checkpoint",
    type: "skill_graph_planned",
    payload: { mode: "guarded", executed: true },
  });
  let replayed = false;
  const recovery = createAgentRunRecoveryService({
    agentRunService,
    agentRunStepExecutor: { resumeStep: async () => { replayed = true; } },
    recordRecoveryTrace: async () => {},
  });

  await recovery.recoverOnStartup({ mode: "auto" });
  const run = await agentRunService.getRun({
    accessScope,
    runId: "graph-missing-checkpoint",
  });
  assert.equal(replayed, false);
  assert.equal(run.result.recovery.reason, "graph_checkpoint_missing");
});
