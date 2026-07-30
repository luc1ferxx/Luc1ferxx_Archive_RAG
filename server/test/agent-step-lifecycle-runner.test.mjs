import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import { runLifecycleStep } from "../rag/agent-step-lifecycle-runner.js";
import {
  AGENT_INTERRUPT_TYPES,
  AgentRunInterruptError,
} from "../rag/agent-interrupts.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

test("approval-capable lifecycle steps never persist private execution input before an interrupt", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const runId = "run-private-lifecycle-input";
  const sentinel = "PRIVATE-EXECUTION-INPUT-MUST-NEVER-BE-PUBLIC";

  await agentRunService.createRun({
    accessScope,
    goal: "Keep pre-approval execution input private.",
    runId,
  });

  const lifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService,
    runId,
  });
  const simulatedPauseFailure = new Error(
    "Simulated crash before pause persistence."
  );

  await assert.rejects(
    () =>
      runLifecycleStep({
        execute: async () => {
          throw new AgentRunInterruptError({
            detail: {
              approvalGate: {
                id: "approval:web.search:1.0.0:hash",
              },
            },
            type: AGENT_INTERRUPT_TYPES.capabilityApprovalRequired,
          });
        },
        id: "web_search:primary",
        input: {
          question: sentinel,
        },
        label: "Web Search",
        persistedInput: null,
        stepLifecycle: {
          ...lifecycle,
          pauseStep: async () => {
            throw simulatedPauseFailure;
          },
        },
        type: "web_search",
      }),
    simulatedPauseFailure
  );

  const persistedRun = await agentRunService.getRun({
    accessScope,
    runId,
  });
  const persistedStep = persistedRun.steps.find(
    (step) => step.id === "web_search:primary"
  );

  assert.equal(persistedStep.input, null);
  assert.equal(JSON.stringify(persistedRun).includes(sentinel), false);
  assert.deepEqual(
    persistedRun.events.map((event) => event.type),
    ["run_created", "step_started"]
  );
});
