import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRunRecoveryActionService,
} from "../rag/agent-run-recovery-actions.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import { createDocumentRagStepExecutor } from "../rag/agent-run-step-handlers/index.js";
import {
  getStepReplaySafetyPolicy,
  listStepReplaySafetyPolicies,
} from "../rag/agent-run-step-replay-safety.js";
import { AGENT_RUN_STEP_STATUSES } from "../rag/agent-run-steps.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";

// What happens to one `custom_skill` step when something tries to run it on
// its own, outside its execution graph: at startup, from the recovery panel,
// and from the step retry route. Every expectation below is a literal, on
// purpose. This file was first written against the code as it stood after
// ADR 0001 phase 8 (the V1 sequential chain deleted, its step handlers kept);
// the commit after it (phase 9) removed those handlers, and its diff of this
// file shows, line by line, what that changed.
//
// The rule since phase 9: a custom Skill runs only as a node of its execution
// graph. Nothing runs, resumes or retries a `custom_skill` step on its own.
//
// Two step shapes matter:
//   - a "chain-shaped" step: no `nodeId` in its input and no graph checkpoint
//     on its run. Only the deleted chain wrote these; they exist in runs
//     stored before phase 8.
//   - a graph node's step: `nodeId` in its input. Every custom Skill step a
//     run writes today has this shape.

const accessScope = Object.freeze({
  userId: "replay-user",
  workspaceId: "replay-workspace",
});
const now = () => "2026-11-13T00:00:00.000Z";
const SKILL_ID = "replay_read_only_probe";

// The step executor no longer takes a Skill registry or a custom Skill
// executor, so there is no Skill for these tests to count calls of. That a
// step did not run is asserted from what the run store holds: its status, its
// steps and its events.
const createHarness = () => {
  const documentCalls = [];
  const recoveryTraces = [];
  const replayTraces = [];
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({ now }),
  });
  const agentRunStepExecutor = createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async (docIds, question) => {
          documentCalls.push(question);

          return {
            citations: [{ docId: "doc-1", title: "Policy" }],
            text: "Retried document answer.",
          };
        },
      },
    }),
    now,
    recordStepReplayTrace: async (event) => replayTraces.push(event),
  });
  const recoveryService = createAgentRunRecoveryService({
    agentRunService,
    now,
    recordRecoveryTrace: async (event) => recoveryTraces.push(event),
  });
  const actionService = createAgentRunRecoveryActionService({
    agentRunService,
    agentRunStepExecutor,
    now,
    recordRecoveryTrace: async (event) => recoveryTraces.push(event),
  });

  return {
    actionService,
    agentRunService,
    agentRunStepExecutor,
    documentCalls,
    getRun: (runId) => agentRunService.getRun({ accessScope, runId }),
    recoveryService,
    recoveryTraces,
    replayTraces,
  };
};

const skillStep = ({ id, nodeId = null, status }) => ({
  id,
  input: {
    docIds: ["doc-1"],
    ...(nodeId ? { nodeId } : {}),
    question: "What changed?",
    skillId: SKILL_ID,
  },
  kind: "tool_call",
  label: "Replay probe",
  status,
  type: "custom_skill",
});

const createInterruptedRun = async ({ agentRunService, runId, steps }) => {
  await agentRunService.createRun({
    accessScope,
    goal: "Interrupted run",
    input: { docIds: ["doc-1"] },
    runId,
  });
  await agentRunService.updateRun({ accessScope, patch: { steps }, runId });
};

const createManualRecoveryRun = async ({ agentRunService, runId, steps }) => {
  await agentRunService.createRun({
    accessScope,
    goal: "Run waiting for an operator",
    input: { docIds: ["doc-1"] },
    runId,
  });
  await agentRunService.updateRun({
    accessScope,
    patch: {
      result: { recovery: { mode: "manual", reason: "server_startup_recovery" } },
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps,
    },
    runId,
  });
  await agentRunService.appendRunEvent({
    accessScope,
    payload: { reason: "server_startup_recovery" },
    runId,
    type: "manual_recovery_required",
  });
};

const createFailedRun = async ({ agentRunService, runId, steps }) => {
  await agentRunService.createRun({
    accessScope,
    goal: "Failed run",
    input: { docIds: ["doc-1"] },
    runId,
  });
  await agentRunService.completeRun({
    accessScope,
    runId,
    status: AGENT_RUN_STATUSES.failed,
    steps,
  });
};

const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error.code ?? null, message: error.message, status: error.status ?? null };
  }

  return null;
};

const eventTypes = (run) => run.events.map((event) => event.type);

const listedActions = async ({ actionService, runId }) => {
  const { runs } = await actionService.listRecoveryRuns({ accessScope });
  const run = runs.find((candidate) => candidate.runId === runId);

  return run ? run.recovery.actions.map((action) => action.type) : null;
};

test("the replay matrix: what it says about a custom_skill step", () => {
  assert.deepEqual(getStepReplaySafetyPolicy("custom_skill"), {
    idempotency: "graph_owned",
    optionalInput: [],
    replayActions: [],
    replayApprovalPolicy: "none",
    replayRequiresApproval: false,
    requiredInput: [],
    retryable: false,
    stepType: "custom_skill",
    summary:
      "A custom Skill runs only as a node of its execution graph. Its step is never replayed on its own: an interrupted graph is continued by whole-graph recovery, and a failed node is not retried.",
  });
  // The step types startup may replay on their own: none. The column is gone
  // from the matrix.
  assert.deepEqual(
    listStepReplaySafetyPolicies()
      .filter((policy) => policy.autoReplaySafe)
      .map((policy) => policy.stepType),
    []
  );
  assert.deepEqual(
    listStepReplaySafetyPolicies().filter((policy) => "autoReplaySafe" in policy),
    []
  );
  // The step types an operator may retry by hand after they failed.
  assert.deepEqual(
    listStepReplaySafetyPolicies()
      .filter((policy) => policy.replayActions.includes("retry_failed_step"))
      .map((policy) => policy.stepType),
    [
      "arxiv_import",
      "capability_call",
      "document_rag",
      "follow_up_retrieval",
      "research_question",
      "web_search",
    ]
  );
});

test("startup, auto mode: an interrupted chain-shaped custom_skill step", async () => {
  const harness = createHarness();

  await createInterruptedRun({
    agentRunService: harness.agentRunService,
    runId: "run-chain-interrupted",
    steps: [skillStep({ id: "chain-step", status: AGENT_RUN_STEP_STATUSES.running })],
  });

  const result = await harness.recoveryService.recoverOnStartup({ mode: "auto" });
  const run = await harness.getRun("run-chain-interrupted");

  assert.deepEqual(
    {
      autoRecoveredCount: result.autoRecoveredCount,
      failedCount: result.failedCount,
      manualRecoveredCount: result.manualRecoveredCount,
    },
    { autoRecoveredCount: 0, failedCount: 0, manualRecoveredCount: 1 }
  );
  // The step is not run. The run waits for an operator, who can cancel it.
  assert.equal(run.status, "waiting_for_user");
  assert.equal(run.steps[0].status, "running");
  assert.deepEqual(run.result.recovery, {
    mode: "manual",
    originalStatus: "running",
    reason: "graph_node_step",
    recoveredAt: "2026-11-13T00:00:00.000Z",
    requestedMode: "auto",
  });
  assert.deepEqual(eventTypes(run), ["run_created", "manual_recovery_required"]);
  assert.deepEqual(harness.replayTraces, []);
  assert.deepEqual(
    await listedActions({
      actionService: harness.actionService,
      runId: "run-chain-interrupted",
    }),
    ["cancel"]
  );
  assert.deepEqual(
    harness.recoveryTraces.map((trace) => ({
      autoReplayAttemptCount: trace.autoReplayAttemptCount,
      autoReplaySuccessCount: trace.autoReplaySuccessCount,
      manualRecoveryCount: trace.manualRecoveryCount,
      recoverableRunCount: trace.recoverableRunCount,
    })),
    [
      {
        autoReplayAttemptCount: 0,
        autoReplaySuccessCount: 0,
        manualRecoveryCount: 1,
        recoverableRunCount: 1,
      },
    ]
  );
});

test("startup, auto mode: an interrupted graph-node step whose run has no checkpoint", async () => {
  const harness = createHarness();

  await createInterruptedRun({
    agentRunService: harness.agentRunService,
    runId: "run-node-interrupted",
    steps: [
      skillStep({
        id: "custom_skill:probe",
        nodeId: "probe",
        status: AGENT_RUN_STEP_STATUSES.running,
      }),
    ],
  });

  const first = await harness.recoveryService.recoverOnStartup({ mode: "auto" });
  const afterFirst = await harness.getRun("run-node-interrupted");
  const second = await harness.recoveryService.recoverOnStartup({ mode: "auto" });
  const afterSecond = await harness.getRun("run-node-interrupted");

  // Before phase 9 startup tried to replay the node on its own, the replay
  // guard refused, and nothing handed the run to an operator: it stayed
  // `running`, unlisted, and the same failed attempt repeated at every
  // startup. Now the first startup hands it to an operator and the second
  // leaves it alone.
  assert.deepEqual(
    [first, second].map((result) => ({
      autoRecoveredCount: result.autoRecoveredCount,
      failedCount: result.failedCount,
      manualRecoveredCount: result.manualRecoveredCount,
      skippedCount: result.skippedCount,
    })),
    [
      { autoRecoveredCount: 0, failedCount: 0, manualRecoveredCount: 1, skippedCount: 0 },
      { autoRecoveredCount: 0, failedCount: 0, manualRecoveredCount: 0, skippedCount: 1 },
    ]
  );
  assert.equal(afterFirst.status, "waiting_for_user");
  assert.equal(afterFirst.result.recovery.reason, "graph_node_step");
  assert.equal(afterSecond.status, "waiting_for_user");
  assert.deepEqual(eventTypes(afterSecond), ["run_created", "manual_recovery_required"]);
  assert.deepEqual(
    await listedActions({
      actionService: harness.actionService,
      runId: "run-node-interrupted",
    }),
    ["cancel"]
  );
});

test("startup, auto mode: an interrupted web search still goes to an operator", async () => {
  const harness = createHarness();

  await createInterruptedRun({
    agentRunService: harness.agentRunService,
    runId: "run-web-interrupted",
    steps: [
      {
        id: "web_search:primary",
        input: { question: "Search the web." },
        status: AGENT_RUN_STEP_STATUSES.running,
        type: "web_search",
      },
    ],
  });

  const result = await harness.recoveryService.recoverOnStartup({ mode: "auto" });
  const run = await harness.getRun("run-web-interrupted");

  assert.deepEqual(
    {
      autoRecoveredCount: result.autoRecoveredCount,
      failedCount: result.failedCount,
      manualRecoveredCount: result.manualRecoveredCount,
    },
    { autoRecoveredCount: 0, failedCount: 0, manualRecoveredCount: 1 }
  );
  assert.equal(run.status, "waiting_for_user");
  assert.equal(run.result.recovery.reason, "requires_approval");
  assert.deepEqual(
    await listedActions({ actionService: harness.actionService, runId: "run-web-interrupted" }),
    ["cancel"]
  );
});

test("recovery panel: a run waiting for an operator with a chain-shaped custom_skill step", async () => {
  const harness = createHarness();

  await createManualRecoveryRun({
    agentRunService: harness.agentRunService,
    runId: "run-chain-manual",
    steps: [skillStep({ id: "chain-step", status: AGENT_RUN_STEP_STATUSES.paused })],
  });

  const { runs } = await harness.actionService.listRecoveryRuns({ accessScope });
  const listed = runs.find((run) => run.runId === "run-chain-manual");

  assert.deepEqual(
    listed.recovery.actions.map((action) => action.type),
    ["cancel"]
  );
  assert.deepEqual(
    {
      reason: listed.recovery.reason,
      reasonCodes: listed.recovery.replaySafety.reasonCodes,
      runLevelKeys: Object.keys(listed.recovery.replaySafety).sort(),
      stepKeys: Object.keys(listed.recovery.replaySafety.steps[0]).sort(),
    },
    {
      reason: "server_startup_recovery",
      reasonCodes: ["graph_node_step"],
      runLevelKeys: ["reasonCodes", "steps"],
      stepKeys: [
        "idempotency",
        "kind",
        "label",
        "missingInput",
        "policy",
        "reasonCodes",
        "reasons",
        "replayApprovalPolicy",
        "replayRequiresApproval",
        "status",
        "stepId",
        "stepType",
        "summary",
      ],
    }
  );

  const resumed = await rejection(
    harness.actionService.applyRecoveryAction({
      accessScope,
      action: "resume_from_step",
      runId: "run-chain-manual",
    })
  );
  const run = await harness.getRun("run-chain-manual");

  // There is no "Resume step" any more: the name is not an action.
  assert.deepEqual(resumed, {
    code: null,
    message: "Unsupported agent run recovery action: resume_from_step",
    status: 400,
  });
  assert.equal(run.status, "waiting_for_user");
  assert.equal(run.steps[0].status, "paused");
  assert.deepEqual(harness.replayTraces, []);
  assert.deepEqual(harness.recoveryTraces, []);
});

test("recovery panel: a failed chain-shaped custom_skill step", async () => {
  const harness = createHarness();

  await createFailedRun({
    agentRunService: harness.agentRunService,
    runId: "run-chain-failed",
    steps: [skillStep({ id: "chain-step", status: AGENT_RUN_STEP_STATUSES.failed })],
  });

  // Nothing is offered, so the run is not listed for recovery at all.
  assert.equal(
    await listedActions({ actionService: harness.actionService, runId: "run-chain-failed" }),
    null
  );

  const retried = await rejection(
    harness.actionService.applyRecoveryAction({
      accessScope,
      action: "retry_failed_step",
      runId: "run-chain-failed",
    })
  );
  const run = await harness.getRun("run-chain-failed");

  assert.deepEqual(retried, {
    code: null,
    message: "Agent run has no failed step to retry.",
    status: 409,
  });
  assert.equal(run.status, "failed");
  assert.deepEqual(
    run.steps.map((step) => [step.id, step.status]),
    [["chain-step", "failed"]]
  );
  assert.deepEqual(harness.replayTraces, []);
});

test("step retry route: a failed chain-shaped custom_skill step", async () => {
  const harness = createHarness();

  await createFailedRun({
    agentRunService: harness.agentRunService,
    runId: "run-chain-failed-direct",
    steps: [skillStep({ id: "chain-step", status: AGENT_RUN_STEP_STATUSES.failed })],
  });

  // POST /agent-runs/:runId/steps/:stepId/actions/retry calls this directly.
  const outcome = await rejection(
    harness.agentRunStepExecutor.retryStep({
      accessScope,
      runId: "run-chain-failed-direct",
      stepId: "chain-step",
    })
  );
  const run = await harness.getRun("run-chain-failed-direct");

  // Refused by the replay guard, like the step of a graph node.
  assert.deepEqual(outcome, {
    code: "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY",
    message:
      "Guarded ExecutionGraph runs cannot be replayed as standalone steps; use whole-graph recovery.",
    status: 409,
  });
  assert.equal(run.status, "failed");
  assert.deepEqual(run.steps.map((step) => step.id), ["chain-step"]);
  assert.deepEqual(harness.replayTraces, []);
});

test("recovery panel and step retry route: a failed graph-node step", async () => {
  const harness = createHarness();

  await createFailedRun({
    agentRunService: harness.agentRunService,
    runId: "run-node-failed",
    steps: [
      skillStep({
        id: "custom_skill:probe",
        nodeId: "probe",
        status: AGENT_RUN_STEP_STATUSES.failed,
      }),
    ],
  });

  // The panel no longer offers a retry for the failed node (it was always
  // refused); the run is not listed for recovery.
  assert.equal(
    await listedActions({ actionService: harness.actionService, runId: "run-node-failed" }),
    null
  );

  const fromPanel = await rejection(
    harness.actionService.applyRecoveryAction({
      accessScope,
      action: "retry_failed_step",
      runId: "run-node-failed",
    })
  );
  const fromRoute = await rejection(
    harness.agentRunStepExecutor.retryStep({
      accessScope,
      runId: "run-node-failed",
      stepId: "custom_skill:probe",
    })
  );
  const run = await harness.getRun("run-node-failed");
  const refused = {
    code: "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY",
    message:
      "Guarded ExecutionGraph runs cannot be replayed as standalone steps; use whole-graph recovery.",
    status: 409,
  };

  assert.deepEqual(fromPanel, {
    code: null,
    message: "Agent run has no failed step to retry.",
    status: 409,
  });
  assert.deepEqual(fromRoute, refused);
  assert.equal(run.status, "failed");
  assert.deepEqual(run.steps.map((step) => step.id), ["custom_skill:probe"]);
});

test("recovery panel: a failed document step is still retried by hand", async () => {
  const harness = createHarness();

  await createFailedRun({
    agentRunService: harness.agentRunService,
    runId: "run-document-failed",
    steps: [
      {
        error: { message: "Document step failed." },
        id: "document-step",
        input: { docIds: ["doc-1"], question: "What changed?" },
        status: AGENT_RUN_STEP_STATUSES.failed,
        type: "document_rag",
      },
    ],
  });

  assert.deepEqual(
    await listedActions({
      actionService: harness.actionService,
      runId: "run-document-failed",
    }),
    ["retry_failed_step"]
  );

  const retried = await harness.actionService.applyRecoveryAction({
    accessScope,
    action: "retry_failed_step",
    runId: "run-document-failed",
  });

  assert.deepEqual(harness.documentCalls, ["What changed?"]);
  assert.equal(retried.run.status, "completed");
  assert.equal(retried.response.agentAnswer, "Retried document answer.");
  assert.deepEqual(
    harness.replayTraces.map((trace) => [trace.action, trace.stepType, trace.status]),
    [["retry_step", "document_rag", "completed"]]
  );
});

test("recovery actions: the action names the service accepts", async () => {
  const harness = createHarness();

  await createManualRecoveryRun({
    agentRunService: harness.agentRunService,
    runId: "run-actions",
    steps: [
      {
        id: "web_search:primary",
        input: { question: "Search the web." },
        status: AGENT_RUN_STEP_STATUSES.paused,
        type: "web_search",
      },
    ],
  });

  const outcomes = {};

  for (const action of ["resume_from_step", "retry_failed_step", "replay_everything"]) {
    outcomes[action] = await rejection(
      harness.actionService.applyRecoveryAction({ accessScope, action, runId: "run-actions" })
    );
  }

  assert.deepEqual(outcomes, {
    replay_everything: {
      code: null,
      message: "Unsupported agent run recovery action: replay_everything",
      status: 400,
    },
    resume_from_step: {
      code: null,
      message: "Unsupported agent run recovery action: resume_from_step",
      status: 400,
    },
    retry_failed_step: {
      code: null,
      message: "Agent run has no failed step to retry.",
      status: 409,
    },
  });
});
