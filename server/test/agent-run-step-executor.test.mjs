import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const createPendingApprovalRun = async (agentRunService) => {
  await agentRunService.createRun({
    accessScope,
    goal: "Search the web for the launch date.",
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [
      {
        id: "approval:web.search:1.0.0",
        capabilityId: "web.search",
        capabilityLabel: "Web Search",
        inputPreview: {
          question: "Search the web for the launch date.",
        },
        status: "pending",
        stepId: "2-capability_approval_gate",
      },
    ],
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
    steps: [
      {
        id: "1-plan",
        type: "plan",
        kind: "plan",
        label: "Plan",
        status: "completed",
        summary: "Planned web search.",
      },
      {
        id: "2-capability_approval_gate",
        type: "capability_approval_gate",
        kind: "approval_gate",
        label: "Capability Approval",
        status: "paused",
        summary: "Web Search requires approval.",
        approvalGateId: "approval:web.search:1.0.0",
        capabilityId: "web.search",
      },
    ],
  });
};

test("agent run step executor resumes an approved capability step", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const executor = createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry: {
      execute: async (capabilityId, payload) => {
        calls.push({
          capabilityId,
          payload,
        });

        return {
          citations: [
            {
              title: "Launch note",
              url: "https://example.test/launch",
            },
          ],
          text: `Approved answer: ${payload.input.question}`,
        };
      },
    },
  });

  await createPendingApprovalRun(agentRunService);

  const result = await executor.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: "approval:web.search:1.0.0",
    runId: "run-approval",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, "web.search");
  assert.equal(calls[0].payload.approval.approved, true);
  assert.equal(
    calls[0].payload.input.question,
    "Search the web for the launch date."
  );
  assert.equal(result.response.agentMode, "web");
  assert.match(result.response.agentAnswer, /Approved answer/);
  assert.equal(result.run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(result.run.approvalGates[0].status, "approved");
  assert.ok(
    result.run.steps.some(
      (step) =>
        step.kind === "capability_call" &&
        step.status === "completed" &&
        step.capabilityId === "web.search"
    )
  );
  assert.deepEqual(
    result.run.events.map((event) => event.type),
    [
      "run_created",
      "run_completed",
      "approval_gate_approved",
      "step_started",
      "step_completed",
      "run_completed",
    ]
  );
});

test("agent run step executor retries an approved capability step", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  let callCount = 0;
  const executor = createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry: {
      execute: async () => {
        callCount += 1;

        return {
          text: `Web answer ${callCount}`,
        };
      },
    },
  });

  await createPendingApprovalRun(agentRunService);
  const approved = await executor.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: "approval:web.search:1.0.0",
    runId: "run-approval",
  });
  const capabilityStep = approved.run.steps.find(
    (step) => step.kind === "capability_call"
  );

  const retried = await executor.retryStep({
    accessScope,
    runId: "run-approval",
    stepId: capabilityStep.id,
  });

  assert.equal(callCount, 2);
  assert.equal(retried.run.status, AGENT_RUN_STATUSES.completed);
  assert.ok(
    retried.run.steps.some(
      (step) =>
        step.retryOfStepId === capabilityStep.id &&
        step.status === "completed" &&
        step.attempt === 2
    )
  );
  assert.ok(
    retried.run.events
      .map((event) => event.type)
      .includes("step_retry_queued")
  );
  assert.match(retried.response.agentAnswer, /Web answer 2/);
});
