import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { buildStepReplaySafetyAssessment } from "../rag/agent-run-step-replay-safety.js";
import { AGENT_RUN_STEP_STATUSES } from "../rag/agent-run-steps.js";
import { createApprovalExecutionSnapshot } from "../rag/capabilities/approval-execution-snapshot.js";

const buildApprovalFixture = ({
  accessScope,
  capabilityId = "web.search",
  capabilityLabel = "Web Search",
  capabilityVersion = "1.0.0",
  executionInput = {
    question: "Search the web.",
  },
  gateId,
  inputPreview = executionInput,
  stepId,
} = {}) => {
  const snapshot = createApprovalExecutionSnapshot({
    accessScope,
    capabilityId,
    capabilityVersion,
    executionInput,
    inputPreview,
  });
  const resolvedGateId =
    gateId ||
    `approval:${capabilityId}:${capabilityVersion}:${snapshot.approvalObjectHash.slice(
      "sha256:".length
    )}`;
  const gate = {
    approvalObjectHash: snapshot.approvalObjectHash,
    capabilityId,
    capabilityLabel,
    capabilityVersion,
    id: resolvedGateId,
    inputPreview,
    snapshotVersion: snapshot.snapshotVersion,
    status: "pending",
    ...(stepId ? { stepId } : {}),
  };

  return {
    gate,
    snapshot: {
      approvalObjectHash: snapshot.approvalObjectHash,
      capabilityId,
      capabilityVersion,
      executionInput: snapshot.privateSnapshot.executionInput,
      gateId: resolvedGateId,
      snapshotVersion: snapshot.snapshotVersion,
    },
  };
};

test("agent run service records scoped runs, events, and completion snapshots", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-14T00:00:00.000Z",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "What changed in the policy?",
    input: {
      docIds: ["doc-1"],
    },
    plan: {
      mode: "document",
    },
    runId: "run-1",
  });
  await agentRunService.appendRunEvent({
    accessScope,
    runId: "run-1",
    type: "tool_observation",
    payload: {
      skillId: "document_rag",
    },
  });
  await agentRunService.completeRun({
    accessScope,
    decisions: [
      {
        type: "agent_mode",
        value: "document",
      },
    ],
    observations: [
      {
        skillId: "document_rag",
        status: "completed",
      },
    ],
    result: {
      answer: "The policy changed.",
      status: 200,
    },
    runId: "run-1",
    steps: [
      {
        type: "plan",
        status: "completed",
      },
    ],
  });

  const run = await agentRunService.getRun({
    accessScope,
    runId: "run-1",
  });

  assert.equal(run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(run.goal, "What changed in the policy?");
  assert.deepEqual(run.input.docIds, ["doc-1"]);
  assert.equal(run.result.answer, "The policy changed.");
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "tool_observation", "run_completed"]
  );
  assert.equal(run.accessScope, undefined);
  assert.equal(run.scopeKey, undefined);

  assert.equal(
    (
      await agentRunService.listRuns({
        accessScope,
      })
    ).runs.length,
    1
  );
  assert.deepEqual(
    await agentRunService.listRuns({
      accessScope: {
        userId: "bob",
        workspaceId: "workspace-a",
      },
    }),
    {
      runs: [],
    }
  );
});

test("agent run creation is insert-only for a scoped run id", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "Original goal",
    runId: "run-duplicate",
  });
  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Original step",
    runId: "run-duplicate",
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "step-original",
  });

  await assert.rejects(
    () =>
      agentRunService.createRun({
        accessScope,
        goal: "Replacement goal",
        runId: "run-duplicate",
      }),
    (error) => {
      assert.equal(error.code, "AGENT_RUN_ALREADY_EXISTS");
      assert.equal(error.status, 409);
      return true;
    }
  );

  const storedRun = await agentRunService.getRun({
    accessScope,
    runId: "run-duplicate",
  });

  assert.equal(storedRun.goal, "Original goal");
  assert.deepEqual(storedRun.steps.map((step) => step.id), ["step-original"]);
});

test("in-memory updateWithEvent rolls back the snapshot when event persistence fails", async () => {
  const store = createInMemoryAgentRunStore({
    now: () => "2026-06-14T00:00:00.000Z",
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  store.create({
    accessScope,
    run: {
      goal: "Keep the snapshot and event in one commit.",
      runId: "run-atomic-update",
    },
  });
  const originalAppendEvent = store.appendEvent;
  store.appendEvent = () => {
    throw new Error("Simulated event persistence failure.");
  };

  await assert.rejects(
    () =>
      store.updateWithEvent({
        accessScope,
        event: {
          type: "run_completed",
        },
        expectedRevision: 0,
        patch: {
          status: AGENT_RUN_STATUSES.completed,
        },
        runId: "run-atomic-update",
      }),
    /Simulated event persistence failure/
  );

  store.appendEvent = originalAppendEvent;
  const run = store.get({
    accessScope,
    runId: "run-atomic-update",
  });

  assert.equal(run.revision, 0);
  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.deepEqual(run.events, []);
});

test("agent run completion merges stale incoming steps without deleting newer persisted steps", async () => {
  const agentRunService = createAgentRunService();
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-stale-completion-steps";

  await agentRunService.createRun({
    accessScope,
    goal: "Preserve every persisted step.",
    runId,
  });
  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Step A",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "step-a",
    type: "document_rag",
  });
  await agentRunService.recordRunStep({
    accessScope,
    output: {
      text: "A",
    },
    runId,
    status: AGENT_RUN_STEP_STATUSES.completed,
    stepId: "step-a",
  });

  const staleRun = await agentRunService.getRun({
    accessScope,
    runId,
  });

  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Step B",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "step-b",
    type: "web_search",
  });
  await agentRunService.recordRunStep({
    accessScope,
    output: {
      text: "B",
    },
    runId,
    status: AGENT_RUN_STEP_STATUSES.completed,
    stepId: "step-b",
  });

  const completedRun = await agentRunService.completeRun({
    accessScope,
    runId,
    status: AGENT_RUN_STATUSES.completed,
    steps: staleRun.steps.map((step) =>
      step.id === "step-a"
        ? {
            ...step,
            summary: "Updated by completion.",
          }
        : step
    ),
  });

  assert.deepEqual(
    completedRun.steps.map((step) => step.id),
    ["step-a", "step-b"]
  );
  assert.equal(
    completedRun.steps.find((step) => step.id === "step-a").summary,
    "Updated by completion."
  );
  assert.equal(
    completedRun.steps.find((step) => step.id === "step-b").output.text,
    "B"
  );
});

test("agent run completion preserves snapshot order while appending persisted-only terminal steps", async () => {
  const agentRunService = createAgentRunService();
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-ordered-completion-steps";

  await agentRunService.createRun({
    accessScope,
    goal: "Preserve logical trace order.",
    runId,
  });
  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Web search",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "web-search-primary",
    type: "web_search",
  });
  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Concurrent observation",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "concurrent-observation",
    type: "tool_observation",
  });
  await agentRunService.updateRunStep({
    accessScope,
    runId,
    status: AGENT_RUN_STEP_STATUSES.completed,
    stepId: "concurrent-observation",
  });

  const completedRun = await agentRunService.completeRun({
    accessScope,
    runId,
    status: AGENT_RUN_STATUSES.completed,
    steps: [
      {
        id: "plan",
        label: "Plan",
        status: AGENT_RUN_STEP_STATUSES.completed,
        type: "plan",
      },
      {
        id: "approval-gate",
        label: "Approval gate",
        status: AGENT_RUN_STEP_STATUSES.completed,
        type: "capability_approval_gate",
      },
      {
        id: "web-search-primary",
        label: "Web search",
        status: AGENT_RUN_STEP_STATUSES.completed,
        summary: "Completed after approval.",
        type: "web_search",
      },
    ],
  });

  assert.deepEqual(
    completedRun.steps.map((step) => step.id),
    [
      "plan",
      "approval-gate",
      "web-search-primary",
      "concurrent-observation",
    ]
  );
  assert.equal(
    completedRun.steps.find((step) => step.id === "web-search-primary")
      .summary,
    "Completed after approval."
  );
});

test("agent run completion cannot regress terminal step lifecycle from a stale snapshot", async () => {
  const agentRunService = createAgentRunService();
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-stale-terminal-step";

  await agentRunService.createRun({
    accessScope,
    goal: "Keep the newest persisted step lifecycle.",
    runId,
  });
  await agentRunService.recordRunStep({
    accessScope,
    detail: {
      approvalObjectHash: "fresh-approval-hash",
    },
    eventType: "step_started",
    input: {
      docIds: ["doc-1"],
      question: "fresh input",
    },
    label: "Fresh step",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "step-fresh",
    type: "web_search",
  });
  await agentRunService.updateRunStep({
    accessScope,
    patch: {
      approvalGateId: "gate-fresh",
      capabilityId: "web.search",
      capabilityVersion: "1.0.0",
    },
    runId,
    stepId: "step-fresh",
  });
  const runWithCompletedStep = await agentRunService.recordRunStep({
    accessScope,
    output: {
      text: "fresh output",
    },
    runId,
    status: AGENT_RUN_STEP_STATUSES.completed,
    stepId: "step-fresh",
  });
  const persistedStep = runWithCompletedStep.steps.find(
    (step) => step.id === "step-fresh"
  );

  const completedRun = await agentRunService.completeRun({
    accessScope,
    runId,
    status: AGENT_RUN_STATUSES.completed,
    steps: [
      {
        ...persistedStep,
        approvalGateId: "gate-stale",
        capabilityId: "document.read",
        capabilityVersion: "9.9.9",
        completedAt: "",
        detail: {
          approvalObjectHash: "stale-approval-hash",
          skillId: "web_search",
          traceStatus: "completed",
        },
        error: {
          message: "stale error",
        },
        input: {
          query: "stale input",
        },
        output: {
          text: "stale output",
        },
        status: AGENT_RUN_STEP_STATUSES.running,
        type: "document_rag",
      },
    ],
  });
  const completedStep = completedRun.steps.find(
    (step) => step.id === "step-fresh"
  );

  assert.equal(completedStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.deepEqual(completedStep.output, {
    text: "fresh output",
  });
  assert.deepEqual(completedStep.input, {
    docIds: ["doc-1"],
    question: "fresh input",
  });
  assert.equal(completedStep.error, null);
  assert.equal(completedStep.completedAt, persistedStep.completedAt);
  assert.equal(completedStep.type, "web_search");
  assert.equal(completedStep.approvalGateId, "gate-fresh");
  assert.equal(completedStep.capabilityId, "web.search");
  assert.equal(completedStep.capabilityVersion, "1.0.0");
  assert.deepEqual(completedStep.detail, {
    approvalObjectHash: "fresh-approval-hash",
    skillId: "web_search",
    traceStatus: "completed",
  });

  const replaySafety = buildStepReplaySafetyAssessment({
    step: completedStep,
  });

  assert.equal(replaySafety.canAutoReplay, false);
  assert.equal(replaySafety.replayRequiresApproval, true);
});

test("agent run completion is idempotent after the first terminal commit", async () => {
  const baseStore = createInMemoryAgentRunStore();
  let lateUpdateStarted;
  let releaseLateUpdate;
  const lateUpdateStart = new Promise((resolve) => {
    lateUpdateStarted = resolve;
  });
  const lateUpdateRelease = new Promise((resolve) => {
    releaseLateUpdate = resolve;
  });
  const agentRunStore = {
    ...baseStore,
    async update(options = {}) {
      if (options.patch?.result?.answer === "late conflicting answer") {
        lateUpdateStarted();
        await lateUpdateRelease;
      }

      return baseStore.update(options);
    },
  };
  const agentRunService = createAgentRunService({ agentRunStore });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-idempotent-terminal-completion";

  await agentRunService.createRun({
    accessScope,
    goal: "Keep the first terminal result.",
    runId,
  });

  const lateCompletion = agentRunService.completeRun({
    accessScope,
    result: {
      answer: "late conflicting answer",
    },
    runId,
    status: AGENT_RUN_STATUSES.completed,
  });
  await lateUpdateStart;

  const firstCompletion = await agentRunService.completeRun({
    accessScope,
    result: {
      answer: "first answer",
    },
    runId,
    status: AGENT_RUN_STATUSES.completed,
  });
  releaseLateUpdate();

  const duplicateCompletion = await lateCompletion;

  assert.deepEqual(duplicateCompletion.result, firstCompletion.result);
  assert.equal(
    duplicateCompletion.events.filter(
      (event) => event.type === "run_completed"
    ).length,
    1
  );
});

test("generic run updates cannot mutate or revive terminal runs", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-terminal-update-fence";

  await agentRunService.createRun({
    accessScope,
    goal: "Keep the terminal snapshot immutable.",
    runId,
  });
  await agentRunService.completeRun({
    accessScope,
    result: {
      answer: "first answer",
    },
    runId,
  });

  const terminalSnapshot = structuredClone(
    await agentRunStore.get({
      accessScope,
      runId,
    })
  );
  const rejectedUpdates = [
    {
      result: {
        answer: "late answer",
      },
      steps: [
        {
          id: "late-step",
          status: AGENT_RUN_STEP_STATUSES.running,
          type: "web_search",
        },
      ],
    },
    {
      result: {
        answer: "same-status overwrite",
      },
      status: AGENT_RUN_STATUSES.completed,
    },
  ];

  for (const patch of rejectedUpdates) {
    await assert.rejects(
      () =>
        agentRunService.updateRun({
          accessScope,
          patch,
          runId,
        }),
      (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /terminal agent run cannot be updated/i);
        return true;
      }
    );
  }

  await assert.rejects(
    () =>
      agentRunService.updateRun({
        accessScope,
        allowRetryTransition: true,
        patch: {
          status: AGENT_RUN_STATUSES.running,
        },
        runId,
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run status transition: completed -> running/
      );
      return true;
    }
  );

  assert.deepEqual(
    await agentRunStore.get({
      accessScope,
      runId,
    }),
    terminalSnapshot
  );
});

test("agent run completion rejects a concurrent active step before sealing the run", async () => {
  const baseStore = createInMemoryAgentRunStore();
  let completeUpdateStarted;
  let releaseCompleteUpdate;
  let shouldDelayCompletion = true;
  const completionUpdateStarted = new Promise((resolve) => {
    completeUpdateStarted = resolve;
  });
  const completionUpdateReleased = new Promise((resolve) => {
    releaseCompleteUpdate = resolve;
  });
  const agentRunStore = {
    ...baseStore,
    async update(options = {}) {
      if (
        shouldDelayCompletion &&
        options.patch?.status === AGENT_RUN_STATUSES.completed
      ) {
        shouldDelayCompletion = false;
        completeUpdateStarted();
        await completionUpdateReleased;
      }

      return baseStore.update(options);
    },
  };
  const agentRunService = createAgentRunService({
    agentRunStore,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-complete-step-race";

  await agentRunService.createRun({
    accessScope,
    goal: "Complete after the last concurrent step write.",
    runId,
  });
  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Primary step",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "step-primary",
    type: "document_rag",
  });

  const completing = agentRunService.completeRun({
    accessScope,
    result: {
      answer: "Done.",
    },
    runId,
    steps: [
      {
        id: "plan",
        label: "Plan",
        status: AGENT_RUN_STEP_STATUSES.completed,
        type: "plan",
      },
      {
        id: "step-primary",
        label: "Primary step",
        status: AGENT_RUN_STEP_STATUSES.completed,
        type: "document_rag",
      },
    ],
  });

  await completionUpdateStarted;

  const recording = agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Concurrent step",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "step-concurrent",
    type: "document_rag",
  });

  await recording;
  releaseCompleteUpdate();

  await assert.rejects(
    () => completing,
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /concurrent active step/i);
      assert.match(error.message, /step-concurrent/);
      return true;
    }
  );

  const runningRun = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.equal(runningRun.status, AGENT_RUN_STATUSES.running);
  assert.deepEqual(
    runningRun.steps.map((step) => step.id),
    ["step-primary", "step-concurrent"]
  );
  assert.ok(
    runningRun.steps.every(
      (step) => step.status === AGENT_RUN_STEP_STATUSES.running
    )
  );

  await agentRunService.updateRunStep({
    accessScope,
    runId,
    status: AGENT_RUN_STEP_STATUSES.completed,
    stepId: "step-primary",
  });
  const runWithCompletedSteps = await agentRunService.updateRunStep({
    accessScope,
    runId,
    status: AGENT_RUN_STEP_STATUSES.completed,
    stepId: "step-concurrent",
  });
  const completedRun = await agentRunService.completeRun({
    accessScope,
    result: {
      answer: "Done after concurrent work finished.",
    },
    runId,
    steps: runWithCompletedSteps.steps,
  });

  assert.equal(completedRun.status, AGENT_RUN_STATUSES.completed);
  assert.ok(
    completedRun.steps.every((step) =>
      [
        AGENT_RUN_STEP_STATUSES.completed,
        AGENT_RUN_STEP_STATUSES.failed,
        AGENT_RUN_STEP_STATUSES.skipped,
      ].includes(step.status)
    )
  );

  await assert.rejects(
    () =>
      agentRunService.recordRunStep({
        accessScope,
        eventType: "step_started",
        runId,
        status: AGENT_RUN_STEP_STATUSES.running,
        stepId: "step-after-completion",
        type: "web_search",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Agent run steps cannot be changed while run is completed/
      );
      return true;
    }
  );
});

test("agent run completion snapshots cannot bypass persisted step transitions", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-completion-step-transition-fence";

  await agentRunService.createRun({
    accessScope,
    goal: "Reject stale or impossible completion snapshots.",
    runId,
  });
  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "step-primary",
    type: "document_rag",
  });

  for (const invalidStatus of [
    AGENT_RUN_STEP_STATUSES.pending,
    AGENT_RUN_STEP_STATUSES.skipped,
  ]) {
    await assert.rejects(
      () =>
        agentRunService.completeRun({
          accessScope,
          runId,
          status:
            invalidStatus === AGENT_RUN_STEP_STATUSES.pending
              ? AGENT_RUN_STATUSES.waitingForUser
              : AGENT_RUN_STATUSES.completed,
          steps: [
            {
              id: "step-primary",
              status: invalidStatus,
              type: "document_rag",
            },
          ],
        }),
      (error) => {
        assert.equal(error.status, 409);
        assert.match(
          error.message,
          new RegExp(`running -> ${invalidStatus}`)
        );
        return true;
      }
    );
  }

  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(run.steps[0].status, AGENT_RUN_STEP_STATUSES.running);
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "step_started"]
  );
});

test("ordinary clarification waits record a waiting event instead of completion", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-clarification-event-truth";

  await agentRunService.createRun({
    accessScope,
    goal: "Wait for a clarification without claiming completion.",
    runId,
  });
  const run = await agentRunService.completeRun({
    accessScope,
    result: {
      clarification: {
        question: "Which workspace should I use?",
      },
    },
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });

  assert.equal(run.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "run_waiting_for_user"]
  );
  assert.equal(
    run.events.some((event) => event.type === "run_completed"),
    false
  );
});

test("agent run completion preserves newer same-step fields after a CAS retry", async () => {
  const baseStore = createInMemoryAgentRunStore();
  let completeUpdateStarted;
  let releaseCompleteUpdate;
  let shouldDelayCompletion = true;
  const completionUpdateStarted = new Promise((resolve) => {
    completeUpdateStarted = resolve;
  });
  const completionUpdateReleased = new Promise((resolve) => {
    releaseCompleteUpdate = resolve;
  });
  const agentRunStore = {
    ...baseStore,
    async update(options = {}) {
      if (
        shouldDelayCompletion &&
        options.patch?.status === AGENT_RUN_STATUSES.completed
      ) {
        shouldDelayCompletion = false;
        completeUpdateStarted();
        await completionUpdateReleased;
      }

      return baseStore.update(options);
    },
  };
  const agentRunService = createAgentRunService({ agentRunStore });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-complete-same-step-race";
  const stepId = "step-primary";

  await agentRunService.createRun({
    accessScope,
    goal: "Preserve the newest durable step snapshot.",
    runId,
  });
  await agentRunService.recordRunStep({
    accessScope,
    detail: {
      shared: "initial",
    },
    eventType: "step_started",
    input: {
      version: "initial",
    },
    label: "Initial step",
    runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId,
    type: "web_search",
  });

  const completing = agentRunService.completeRun({
    accessScope,
    result: {
      answer: "Done.",
    },
    runId,
    steps: [
      {
        approvalGateId: "gate-stale",
        capabilityId: "document.read",
        capabilityVersion: "0.0.1",
        completedAt: "2026-07-31T00:00:03.000Z",
        detail: {
          completionOnly: true,
          shared: "stale",
        },
        id: stepId,
        input: {
          version: "stale",
        },
        label: "Stale completion step",
        output: {
          version: "stale",
        },
        status: AGENT_RUN_STEP_STATUSES.completed,
        summary: "stale summary",
        type: "document_rag",
        updatedAt: "2026-07-31T00:00:01.000Z",
      },
    ],
  });

  await completionUpdateStarted;
  await agentRunService.recordRunStep({
    accessScope,
    detail: {
      concurrentOnly: true,
      shared: "fresh",
    },
    eventType: "step_updated",
    input: {
      version: "fresh",
    },
    label: "Fresh step",
    output: {
      version: "fresh",
    },
    runId,
    stepId,
    type: "web_search",
  });
  const freshRun = await agentRunService.updateRunStep({
    accessScope,
    patch: {
      approvalGateId: "gate-fresh",
      capabilityId: "web.search",
      capabilityVersion: "1.0.0",
      summary: "fresh summary",
    },
    runId,
    stepId,
  });
  const freshStep = freshRun.steps.find((step) => step.id === stepId);

  releaseCompleteUpdate();

  const completedRun = await completing;
  const completedStep = completedRun.steps.find((step) => step.id === stepId);

  assert.equal(completedStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(completedStep.type, "web_search");
  assert.equal(completedStep.label, "Fresh step");
  assert.equal(completedStep.summary, "fresh summary");
  assert.equal(completedStep.approvalGateId, "gate-fresh");
  assert.equal(completedStep.capabilityId, "web.search");
  assert.equal(completedStep.capabilityVersion, "1.0.0");
  assert.deepEqual(completedStep.input, {
    version: "fresh",
  });
  assert.deepEqual(completedStep.output, {
    version: "fresh",
  });
  assert.deepEqual(completedStep.detail, {
    completionOnly: true,
    concurrentOnly: true,
    shared: "fresh",
  });
  assert.equal(completedStep.completedAt, "2026-07-31T00:00:03.000Z");
  assert.equal(completedStep.updatedAt, freshStep.updatedAt);
});

test("agent run service preserves ten distinct steps recorded concurrently", async () => {
  const agentRunService = createAgentRunService();
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-ten-concurrent-steps";
  const stepIds = Array.from({ length: 10 }, (_, index) => `step-${index + 1}`);

  await agentRunService.createRun({
    accessScope,
    goal: "Record a wider concurrent step fan-out.",
    runId,
  });

  await Promise.all(
    stepIds.map((stepId) =>
      agentRunService.recordRunStep({
        accessScope,
        eventType: "step_started",
        label: stepId,
        runId,
        status: AGENT_RUN_STEP_STATUSES.running,
        stepId,
        type: "document_rag",
      })
    )
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.deepEqual(
    run.steps.map((step) => step.id).sort(),
    [...stepIds].sort()
  );
  assert.deepEqual(
    run.events
      .filter((event) => event.type === "step_started")
      .map((event) => event.payload.stepId)
      .sort(),
    [...stepIds].sort()
  );
});

test("agent run service exposes recoverable running runs", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  await agentRunService.createRun({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    goal: "Pending run",
    runId: "run-running",
  });

  const recoverableRuns = await agentRunService.listRecoverableRuns();

  assert.equal(recoverableRuns.runs.length, 1);
  assert.equal(recoverableRuns.runs[0].runId, "run-running");
});

test("agent run service records approval gate actions", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-14T00:00:00.000Z",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const approval = buildApprovalFixture({
    accessScope,
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Search the web.",
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });

  const approvedRun = await agentRunService.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: approval.gate.id,
    payload: {
      approvalObjectHash: approval.gate.approvalObjectHash,
    },
    runId: "run-approval",
  });

  assert.equal(approvedRun.status, AGENT_RUN_STATUSES.running);
  assert.equal(approvedRun.approvalGates[0].status, "approved");
  assert.equal(approvedRun.steps[0].kind, "capability_call");
  assert.equal(approvedRun.steps[0].status, "pending");
  assert.equal(approvedRun.steps[0].capabilityId, "web.search");
  assert.equal(approvedRun.steps[0].input, null);
  assert.equal(
    approvedRun.steps[0].detail.approvalObjectHash,
    approval.gate.approvalObjectHash
  );
  assert.deepEqual(
    approvedRun.events.map((event) => event.type),
    [
      "run_created",
      "approval_gate_created",
      "approval_gate_approved",
    ]
  );
});

test("agent run service rejects legacy approval gates without a private snapshot without changing state", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const approval = buildApprovalFixture({
    accessScope,
  });
  const runId = "run-legacy-approval";

  await agentRunService.createRun({
    accessScope,
    goal: "Do not execute a lossy legacy approval.",
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  const beforeApproval = await agentRunService.getRun({
    accessScope,
    runId,
  });

  await assert.rejects(
    () =>
      agentRunService.applyApprovalAction({
        accessScope,
        action: "approve",
        gateId: approval.gate.id,
        payload: {
          approvalObjectHash: approval.gate.approvalObjectHash,
        },
        runId,
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "approval_snapshot_missing");
      return true;
    }
  );

  const afterApproval = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.deepEqual(afterApproval, beforeApproval);
  assert.equal(afterApproval.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.equal(afterApproval.approvalGates[0].status, "pending");
  assert.deepEqual(
    afterApproval.events.map((event) => event.type),
    ["run_created", "approval_gate_created"]
  );
});

test("agent run service rejects conflicting approval gate ids before mutating the run", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const approval = buildApprovalFixture({
    accessScope,
  });
  const runId = "run-conflicting-approval-gate-ids";

  await agentRunService.createRun({
    accessScope,
    goal: "Bind the decision to one approval gate.",
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  const beforeApproval = await agentRunService.getRun({
    accessScope,
    runId,
  });

  await assert.rejects(
    () =>
      agentRunService.applyApprovalAction({
        accessScope,
        action: "approve",
        gateId: approval.gate.id,
        payload: {
          approvalObjectHash: approval.gate.approvalObjectHash,
          gateId: "approval:another-capability:1.0.0",
        },
        runId,
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /conflicting gate ids/i);
      return true;
    }
  );

  assert.deepEqual(
    await agentRunService.getRun({
      accessScope,
      runId,
    }),
    beforeApproval
  );
});

test("agent run public projections cannot mutate a persisted approval binding", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const approval = buildApprovalFixture({
    accessScope,
  });
  const runId = "run-public-approval-clone";

  await agentRunService.createRun({
    accessScope,
    goal: "Keep the approval object immutable.",
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });

  const publicRun = await agentRunService.getRun({
    accessScope,
    runId,
  });
  publicRun.approvalGates[0].approvalObjectHash = `sha256:${"0".repeat(64)}`;
  publicRun.approvalGates[0].inputPreview.question = "tampered";
  const [listedRun] = (
    await agentRunService.listRuns({
      accessScope,
    })
  ).runs;
  listedRun.approvalGates[0].status = "approved";

  const persistedRun = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.equal(
    persistedRun.approvalGates[0].approvalObjectHash,
    approval.gate.approvalObjectHash
  );
  assert.equal(
    persistedRun.approvalGates[0].inputPreview.question,
    approval.gate.inputPreview.question
  );
  assert.equal(persistedRun.approvalGates[0].status, "pending");
});

test("in-memory approval snapshots are immutable even when a replacement reuses the stored hash", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({
    agentRunStore,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const approval = buildApprovalFixture({
    accessScope,
    executionInput: {
      metadata: {
        audience: "internal",
      },
      question: "Search the complete approved query.",
    },
    inputPreview: {
      question: "Search the complete approved query.",
    },
  });
  const runId = "run-immutable-private-approval-snapshot";

  await agentRunService.createRun({
    accessScope,
    goal: "Do not replace an immutable private approval snapshot.",
    runId,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    result: {
      phase: "original",
    },
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  const originalRun = await agentRunService.getRun({
    accessScope,
    runId,
  });
  const originalSnapshot = await agentRunStore.getApprovalSnapshot({
    accessScope,
    gateId: approval.gate.id,
    runId,
  });

  await assert.rejects(
    () =>
      agentRunService.completeRun({
        accessScope,
        approvalGates: [approval.gate],
        approvalSnapshots: [
          {
            ...approval.snapshot,
            executionInput: {
              metadata: {
                audience: "attacker-controlled",
              },
              question: "Execute a different operation.",
            },
          },
        ],
        result: {
          phase: "replacement",
        },
        runId,
        status: AGENT_RUN_STATUSES.waitingForUser,
      }),
    (error) => {
      assert.equal(error.code, "AGENT_RUN_APPROVAL_SNAPSHOT_CONFLICT");
      assert.equal(error.status, 409);
      return true;
    }
  );

  assert.deepEqual(
    await agentRunService.getRun({
      accessScope,
      runId,
    }),
    originalRun
  );
  assert.deepEqual(
    await agentRunStore.getApprovalSnapshot({
      accessScope,
      gateId: approval.gate.id,
      runId,
    }),
    originalSnapshot
  );
});

test("in-memory approval snapshot validation fails atomically before malformed private state can persist", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-malformed-private-approval-snapshot";

  await agentRunStore.createWithEvent({
    accessScope,
    event: {
      type: "run_created",
    },
    run: {
      goal: "Reject malformed private approval state.",
      runId,
      status: AGENT_RUN_STATUSES.running,
    },
  });
  const originalRun = await agentRunStore.get({
    accessScope,
    runId,
  });

  await assert.rejects(
    () =>
      agentRunStore.updateWithEvent({
        accessScope,
        approvalSnapshots: [
          {
            approvalObjectHash: "sha256:unbound",
            gateId: "approval:malformed",
          },
        ],
        event: {
          type: "approval_gate_created",
        },
        expectedRevision: originalRun.revision,
        patch: {
          status: AGENT_RUN_STATUSES.waitingForUser,
        },
        runId,
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(
        error.message,
        /requires gateId, capabilityId, capabilityVersion/
      );
      return true;
    }
  );

  assert.deepEqual(
    await agentRunStore.get({
      accessScope,
      runId,
    }),
    originalRun
  );
  assert.equal(
    await agentRunStore.getApprovalSnapshot({
      accessScope,
      gateId: "approval:malformed",
      runId,
    }),
    null
  );
});

test("agent run service admits exactly one concurrent approval decision", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const approval = buildApprovalFixture({
    accessScope,
  });
  const runId = "run-concurrent-approval-decision";

  await agentRunService.createRun({
    accessScope,
    goal: "Resolve one approval decision.",
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });

  const decisions = await Promise.allSettled([
    agentRunService.applyApprovalAction({
      accessScope,
      action: "approve",
      gateId: approval.gate.id,
      payload: {
        approvalObjectHash: approval.gate.approvalObjectHash,
      },
      runId,
    }),
    agentRunService.applyApprovalAction({
      accessScope,
      action: "deny",
      gateId: approval.gate.id,
      payload: {
        approvalObjectHash: approval.gate.approvalObjectHash,
      },
      runId,
    }),
  ]);
  const fulfilled = decisions.filter((decision) => decision.status === "fulfilled");
  const rejected = decisions.filter((decision) => decision.status === "rejected");
  const finalRun = await agentRunService.getRun({
    accessScope,
    runId,
  });
  const gate = finalRun.approvalGates[0];
  const capabilityStep = finalRun.steps.find(
    (step) => step.kind === "capability_call"
  );
  const decisionEvents = finalRun.events.filter((event) =>
    ["approval_gate_approved", "approval_gate_denied"].includes(event.type)
  );

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(decisionEvents.length, 1);
  assert.equal(
    decisionEvents[0].type,
    gate.status === "approved"
      ? "approval_gate_approved"
      : "approval_gate_denied"
  );
  assert.equal(
    capabilityStep.status,
    gate.status === "approved"
      ? AGENT_RUN_STEP_STATUSES.pending
      : AGENT_RUN_STEP_STATUSES.skipped
  );
  assert.equal(Boolean(finalRun.result.approvalDenied), gate.status === "denied");
  assert.equal(
    capabilityStep.status === AGENT_RUN_STEP_STATUSES.pending &&
      finalRun.result.approvalDenied === true,
    false
  );
});

test("agent run service resolves paused primary tool step when approval is approved", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-14T00:00:00.000Z",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const approval = buildApprovalFixture({
    accessScope,
    executionInput: {
      question: "Search the web.",
    },
    inputPreview: {
      question: "Search the web.",
    },
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Search the web.",
    runId: "run-approved-primary",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    runId: "run-approved-primary",
    status: AGENT_RUN_STATUSES.waitingForUser,
    steps: [
      {
        detail: {
          approvalGate: {
            id: approval.gate.id,
            capabilityId: "web.search",
          },
          interruptType: "capability_approval_required",
        },
        id: "web_search:primary",
        input: {
          question: "Search the web.",
        },
        label: "Web Search",
        status: AGENT_RUN_STEP_STATUSES.paused,
        type: "web_search",
      },
    ],
  });

  const approvedRun = await agentRunService.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: approval.gate.id,
    payload: {
      approvalObjectHash: approval.gate.approvalObjectHash,
    },
    runId: "run-approved-primary",
  });
  const primaryStep = approvedRun.steps.find(
    (step) => step.id === "web_search:primary"
  );
  const capabilityStep = approvedRun.steps.find(
    (step) => step.id === `capability:web.search:${approval.gate.id}`
  );

  assert.equal(approvedRun.status, AGENT_RUN_STATUSES.running);
  assert.equal(approvedRun.approvalGates[0].status, "approved");
  assert.equal(primaryStep.status, AGENT_RUN_STEP_STATUSES.skipped);
  assert.equal(primaryStep.detail.approvalDelegated, true);
  assert.equal(primaryStep.detail.delegatedStepId, capabilityStep.id);
  assert.equal(capabilityStep.status, AGENT_RUN_STEP_STATUSES.pending);
  assert.equal(capabilityStep.input, null);
});

test("agent run service skips paused primary tool step when approval is denied", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-14T00:00:00.000Z",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const approval = buildApprovalFixture({
    accessScope,
    executionInput: {
      question: "Search the web.",
    },
    inputPreview: {
      question: "Search the web.",
    },
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Search the web.",
    runId: "run-denial",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    runId: "run-denial",
    status: AGENT_RUN_STATUSES.waitingForUser,
    steps: [
      {
        detail: {
          approvalGate: {
            id: approval.gate.id,
            capabilityId: "web.search",
          },
          interruptType: "capability_approval_required",
        },
        id: "web_search:primary",
        input: {
          question: "Search the web.",
        },
        label: "Web Search",
        status: AGENT_RUN_STEP_STATUSES.paused,
        type: "web_search",
      },
    ],
  });

  const deniedRun = await agentRunService.applyApprovalAction({
    accessScope,
    action: "deny",
    gateId: approval.gate.id,
    payload: {
      approvalObjectHash: approval.gate.approvalObjectHash,
      reason: "No external calls.",
    },
    runId: "run-denial",
  });
  const primaryStep = deniedRun.steps.find(
    (step) => step.id === "web_search:primary"
  );
  const capabilityStep = deniedRun.steps.find(
    (step) => step.id === `capability:web.search:${approval.gate.id}`
  );

  assert.equal(deniedRun.status, AGENT_RUN_STATUSES.completed);
  assert.equal(deniedRun.approvalGates[0].status, "denied");
  assert.equal(primaryStep.status, AGENT_RUN_STEP_STATUSES.skipped);
  assert.equal(primaryStep.detail.approvalDenied, true);
  assert.equal(capabilityStep.status, AGENT_RUN_STEP_STATUSES.skipped);
  assert.deepEqual(
    deniedRun.events.map((event) => event.type),
    [
      "run_created",
      "approval_gate_created",
      "approval_gate_denied",
    ]
  );
});

test("agent run service queues a retry for a single persisted step", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-14T00:00:00.000Z",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "Retry failed capability.",
    runId: "run-retry",
  });
  await agentRunService.completeRun({
    accessScope,
    runId: "run-retry",
    status: AGENT_RUN_STATUSES.failed,
    steps: [
      {
        id: "capability:web.search:approval:web.search:1.0.0",
        type: "capability_call",
        kind: "capability_call",
        label: "Web Search",
        status: "failed",
      },
    ],
  });

  const retriedRun = await agentRunService.retryStep({
    accessScope,
    runId: "run-retry",
    stepId: "capability:web.search:approval:web.search:1.0.0",
  });

  assert.equal(retriedRun.status, AGENT_RUN_STATUSES.running);
  assert.equal(retriedRun.steps.length, 2);
  assert.equal(retriedRun.steps[1].status, "pending");
  assert.equal(
    retriedRun.steps[1].retryOfStepId,
    "capability:web.search:approval:web.search:1.0.0"
  );
  assert.deepEqual(
    retriedRun.events.map((event) => event.type),
    ["run_created", "run_failed", "step_retry_queued"]
  );
});

test("agent run service admits only one concurrent retry command", async () => {
  const agentRunService = createAgentRunService();
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const runId = "run-concurrent-retry";
  const stepId = "document-step";

  await agentRunService.createRun({
    accessScope,
    goal: "Retry one failed step once.",
    runId,
  });
  await agentRunService.completeRun({
    accessScope,
    runId,
    status: AGENT_RUN_STATUSES.failed,
    steps: [
      {
        id: stepId,
        label: "Document step",
        status: AGENT_RUN_STEP_STATUSES.failed,
        type: "document_rag",
      },
    ],
  });

  const results = await Promise.allSettled([
    agentRunService.retryStep({
      accessScope,
      runId,
      stepId,
    }),
    agentRunService.retryStep({
      accessScope,
      runId,
      stepId,
    }),
  ]);
  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1
  );
  assert.equal(
    run.steps.filter((step) => step.retryOfStepId === stepId).length,
    1
  );
  assert.equal(
    run.events.filter((event) => event.type === "step_retry_queued").length,
    1
  );
});

test("agent run service cancels waiting runs as a terminal state", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "Manual recovery run",
    runId: "run-cancel",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });

  const canceledRun = await agentRunService.cancelRun({
    accessScope,
    reason: "operator_cancel",
    runId: "run-cancel",
  });

  assert.equal(canceledRun.status, AGENT_RUN_STATUSES.canceled);
  assert.equal(canceledRun.result.canceled, true);
  assert.equal(canceledRun.result.cancelReason, "operator_cancel");
  assert.deepEqual(
    canceledRun.events.map((event) => event.type),
    ["run_created", "run_canceled"]
  );

  await assert.rejects(
    () =>
      agentRunService.updateRun({
        accessScope,
        runId: "run-cancel",
        patch: {
          status: AGENT_RUN_STATUSES.running,
        },
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run status transition: canceled -> running/
      );
      return true;
    }
  );
});

test("agent run service rejects invalid run status transitions", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await assert.rejects(
    () =>
      agentRunService.createRun({
        accessScope,
        goal: "Already done",
        runId: "invalid-initial-run",
        status: AGENT_RUN_STATUSES.completed,
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /Invalid initial agent run status: completed/);
      return true;
    }
  );

  await agentRunService.createRun({
    accessScope,
    goal: "Terminal run",
    runId: "terminal-run",
  });
  await agentRunService.completeRun({
    accessScope,
    runId: "terminal-run",
  });

  await assert.rejects(
    () =>
      agentRunService.completeRun({
        accessScope,
        runId: "terminal-run",
        status: AGENT_RUN_STATUSES.waitingForUser,
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run status transition: completed -> waiting_for_user/
      );
      return true;
    }
  );

  await assert.rejects(
    () =>
      agentRunService.updateRun({
        accessScope,
        runId: "terminal-run",
        patch: {
          status: AGENT_RUN_STATUSES.running,
        },
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run status transition: completed -> running/
      );
      return true;
    }
  );

  await assert.rejects(
    () =>
      agentRunService.failRun({
        accessScope,
        error: new Error("Late failure"),
        runId: "terminal-run",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run status transition: completed -> failed/
      );
      return true;
    }
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId: "terminal-run",
  });

  assert.equal(run.status, AGENT_RUN_STATUSES.completed);
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "run_completed"]
  );
});

test("agent run service retries steps only from terminal runs", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "Running run",
    runId: "running-run",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "running-run",
    patch: {
      steps: [
        {
          id: "document-step",
          type: "document_rag",
          kind: "tool_call",
          label: "Document RAG",
          status: "completed",
        },
      ],
    },
  });

  await assert.rejects(
    () =>
      agentRunService.retryStep({
        accessScope,
        runId: "running-run",
        stepId: "document-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /only be retried from completed or failed runs/);
      return true;
    }
  );
});

test("agent run service rejects invalid step status transitions", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.createRun({
    accessScope,
    goal: "Step transition run",
    runId: "step-transition-run",
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "step-transition-run",
    patch: {
      steps: [
        {
          id: "document-step",
          type: "document_rag",
          kind: "tool_call",
          label: "Document RAG",
          status: "completed",
        },
      ],
    },
  });

  await assert.rejects(
    () =>
      agentRunService.updateRunStep({
        accessScope,
        runId: "step-transition-run",
        status: "running",
        stepId: "document-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run step status transition: completed -> running/
      );
      return true;
    }
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId: "step-transition-run",
  });

  assert.equal(run.steps[0].status, "completed");
  assert.deepEqual(run.events.map((event) => event.type), ["run_created"]);
});

test("in-memory agent run store list() applies default limit of 200 and supports explicit limit/offset", async () => {
  let tick = 0;
  const store = createInMemoryAgentRunStore({
    now: () => `2026-06-14T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  for (let i = 0; i < 5; i++) {
    store.create({
      accessScope,
      run: {
        runId: `run-${i}`,
        goal: `Goal ${i}`,
      },
    });
  }

  const defaultResult = store.list({ accessScope });
  assert.equal(defaultResult.length, 5, "should return all 5 runs within default limit");

  const limitedResult = store.list({ accessScope, limit: 2 });
  assert.equal(limitedResult.length, 2, "explicit limit of 2 should return 2 runs");

  const offsetResult = store.list({ accessScope, limit: 2, offset: 3 });
  assert.equal(offsetResult.length, 2, "limit 2 offset 3 should return 2 runs");

  const beyondResult = store.list({ accessScope, limit: 2, offset: 10 });
  assert.equal(beyondResult.length, 0, "offset beyond total should return empty");

  const invalidLimitResult = store.list({ accessScope, limit: -5 });
  assert.equal(invalidLimitResult.length, 5, "invalid limit should fall back to default 200");

  const overLimitResult = store.list({ accessScope, limit: 5000 });
  assert.equal(overLimitResult.length, 5, "limit above 1000 should clamp to 1000");

  const nonNumericResult = store.list({ accessScope, limit: "bad", offset: "bad" });
  assert.equal(nonNumericResult.length, 5, "non-numeric limit/offset should fall back to defaults");
});

test("in-memory agent run store list() via service plumbs limit/offset through", async () => {
  let tick = 0;
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => `2026-06-14T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  for (let i = 0; i < 5; i++) {
    await agentRunService.createRun({
      accessScope,
      goal: `Goal ${i}`,
      runId: `run-${i}`,
    });
  }

  const allRuns = await agentRunService.listRuns({ accessScope });
  assert.equal(allRuns.runs.length, 5);

  const limited = await agentRunService.listRuns({ accessScope, limit: 3 });
  assert.equal(limited.runs.length, 3);

  const withOffset = await agentRunService.listRuns({ accessScope, limit: 2, offset: 3 });
  assert.equal(withOffset.runs.length, 2);
});

test("in-memory agent run store list() returns the complete set for limit \"all\"", async () => {
  let tick = 0;
  const store = createInMemoryAgentRunStore({
    now: () => `2026-06-14T00:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}.000Z`,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  for (let i = 0; i < 250; i++) {
    store.create({
      accessScope,
      run: {
        runId: `run-${i}`,
        goal: `Goal ${i}`,
      },
    });
  }

  assert.equal(store.list({ accessScope }).length, 200, "default list should cap at 200");
  assert.equal(
    store.list({ accessScope, limit: "all" }).length,
    250,
    "limit \"all\" should bypass the cap"
  );

  const completeViaService = await createAgentRunService({ agentRunStore: store })
    .listRuns({ accessScope, limit: "all" });
  assert.equal(completeViaService.runs.length, 250);
});
