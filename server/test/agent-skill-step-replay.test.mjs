import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRunRecoveryActionService,
} from "../rag/agent-run-recovery-actions.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createCustomSkillStepExecutor,
  createDocumentRagStepExecutor,
} from "../rag/agent-run-step-handlers/index.js";
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
import { createSkillRegistry } from "../rag/skills/registry.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
} from "../rag/skills/skill-contract.js";

// What happens to one `custom_skill` step when something tries to run it on
// its own, outside its execution graph: at startup, from the recovery panel,
// and from the step retry route. Every expectation below is a literal, on
// purpose. This file was first written against the code as it stood after
// ADR 0001 phase 8 (the V1 sequential chain deleted, its step handlers kept),
// so the change that removes those handlers shows, line by line, what it
// changed.
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

const createHarness = () => {
  const skillCalls = [];
  const documentCalls = [];
  const recoveryTraces = [];
  const replayTraces = [];
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({ now }),
  });
  const skill = {
    budgetKey: "customSkillCalls",
    effects: SKILL_EFFECTS.readOnly,
    execute: async ({ question }) => {
      skillCalls.push(question);

      return {
        abstained: false,
        citations: [{ docId: "doc-1", title: "Policy" }],
        text: "Replayed skill answer.",
      };
    },
    id: SKILL_ID,
    idempotency: SKILL_IDEMPOTENCY.readOnlyRag,
    kind: "custom",
    label: "Replay probe",
    match: () => false,
    replaySafe: true,
    requiresAccessScope: true,
    retryable: true,
    version: "1.0.0",
  };
  const agentRunStepExecutor = createAgentRunStepExecutor({
    agentRunService,
    executeCustomSkillStep: createCustomSkillStepExecutor({
      ragService: {},
      skillRegistry: createSkillRegistry([skill]),
    }),
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
    agentRunStepExecutor,
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
    skillCalls,
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
    autoReplaySafe: true,
    idempotency: "read_only_rag",
    optionalInput: ["retrievalPlan", "sessionId", "skillVersion", "userId"],
    replayActions: ["resume_from_step", "retry_failed_step"],
    replayApprovalPolicy: "none",
    replayRequiresApproval: false,
    requiredInput: ["docIds", "question", "skillId"],
    retryable: true,
    stepType: "custom_skill",
    summary:
      "Whitelisted custom skills replay through the registered custom skill runner with persisted scope and retrieval input.",
  });
  // The step types startup may replay on their own.
  assert.deepEqual(
    listStepReplaySafetyPolicies()
      .filter((policy) => policy.autoReplaySafe)
      .map((policy) => policy.stepType),
    ["custom_skill"]
  );
  // The step types an operator may retry by hand after they failed.
  assert.deepEqual(
    listStepReplaySafetyPolicies()
      .filter((policy) => policy.replayActions.includes("retry_failed_step"))
      .map((policy) => policy.stepType),
    [
      "arxiv_import",
      "capability_call",
      "custom_skill",
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
    { autoRecoveredCount: 1, failedCount: 0, manualRecoveredCount: 0 }
  );
  // The Skill ran on its own, outside any graph, and its answer became the
  // run's answer.
  assert.deepEqual(harness.skillCalls, ["What changed?"]);
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].status, "completed");
  assert.equal(run.result.answer, "Replayed skill answer.");
  assert.deepEqual(eventTypes(run), [
    "run_created",
    "auto_recovery_started",
    "step_started",
    "step_completed",
    "run_completed",
    "auto_recovery_completed",
  ]);
  assert.deepEqual(
    harness.replayTraces.map((trace) => [trace.action, trace.stepType, trace.status]),
    [["resume_step", "custom_skill", "completed"]]
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
        autoReplayAttemptCount: 1,
        autoReplaySuccessCount: 1,
        manualRecoveryCount: 0,
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

  // Startup tries to replay the node on its own, the replay guard refuses, and
  // nothing hands the run to an operator: it stays `running`, is not listed
  // for recovery, and the same failed attempt repeats at every startup.
  assert.deepEqual(harness.skillCalls, []);
  assert.deepEqual(
    [first, second].map((result) => ({
      autoRecoveredCount: result.autoRecoveredCount,
      failedCount: result.failedCount,
      manualRecoveredCount: result.manualRecoveredCount,
    })),
    [
      { autoRecoveredCount: 0, failedCount: 1, manualRecoveredCount: 0 },
      { autoRecoveredCount: 0, failedCount: 1, manualRecoveredCount: 0 },
    ]
  );
  assert.equal(afterFirst.status, "running");
  assert.equal(afterSecond.status, "running");
  assert.deepEqual(eventTypes(afterSecond), [
    "run_created",
    "auto_recovery_started",
    "auto_recovery_failed",
    "auto_recovery_started",
    "auto_recovery_failed",
  ]);
  assert.equal(
    await listedActions({
      actionService: harness.actionService,
      runId: "run-node-interrupted",
    }),
    null
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
    ["resume_from_step", "cancel"]
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
      reasonCodes: [],
      runLevelKeys: ["canAutoReplay", "reasonCodes", "steps"],
      stepKeys: [
        "autoReplaySafe",
        "canAutoReplay",
        "configuredAutoReplaySafe",
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

  const resumed = await harness.actionService.applyRecoveryAction({
    accessScope,
    action: "resume_from_step",
    runId: "run-chain-manual",
  });

  // "Resume step" ran the Skill on its own and completed the run with it.
  assert.deepEqual(harness.skillCalls, ["What changed?"]);
  assert.equal(resumed.run.status, "completed");
  assert.equal(resumed.response.agentAnswer, "Replayed skill answer.");
  assert.deepEqual(
    harness.replayTraces.map((trace) => [trace.action, trace.stepType, trace.status]),
    [["resume_step", "custom_skill", "completed"]]
  );
  assert.deepEqual(
    harness.recoveryTraces.map((trace) => [trace.eventType, trace.action, trace.status]),
    [["manual_recovery_action", "resume_from_step", "completed"]]
  );
});

test("recovery panel: a failed chain-shaped custom_skill step", async () => {
  const harness = createHarness();

  await createFailedRun({
    agentRunService: harness.agentRunService,
    runId: "run-chain-failed",
    steps: [skillStep({ id: "chain-step", status: AGENT_RUN_STEP_STATUSES.failed })],
  });

  assert.deepEqual(
    await listedActions({ actionService: harness.actionService, runId: "run-chain-failed" }),
    ["retry_failed_step"]
  );

  const retried = await harness.actionService.applyRecoveryAction({
    accessScope,
    action: "retry_failed_step",
    runId: "run-chain-failed",
  });
  const run = await harness.getRun("run-chain-failed");

  // "Retry failed step" ran the Skill on its own, as a new step.
  assert.deepEqual(harness.skillCalls, ["What changed?"]);
  assert.equal(retried.run.status, "completed");
  assert.deepEqual(
    run.steps.map((step) => [step.id, step.status]),
    [
      ["chain-step", "failed"],
      ["chain-step:retry:2", "completed"],
    ]
  );
  assert.deepEqual(
    harness.replayTraces.map((trace) => [trace.action, trace.stepType, trace.status]),
    [["retry_step", "custom_skill", "completed"]]
  );
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

  assert.equal(outcome, null);
  assert.deepEqual(harness.skillCalls, ["What changed?"]);
  assert.equal(run.status, "completed");
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

  // The panel offers a retry for the failed node ...
  assert.deepEqual(
    await listedActions({ actionService: harness.actionService, runId: "run-node-failed" }),
    ["retry_failed_step"]
  );

  // ... and taking it is always refused.
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

  assert.deepEqual(fromPanel, refused);
  assert.deepEqual(fromRoute, refused);
  assert.deepEqual(harness.skillCalls, []);
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
  assert.deepEqual(harness.skillCalls, []);
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
      message: "Agent run has no safe step to resume.",
      status: 409,
    },
    retry_failed_step: {
      code: null,
      message: "Agent run has no failed step to retry.",
      status: 409,
    },
  });
});
