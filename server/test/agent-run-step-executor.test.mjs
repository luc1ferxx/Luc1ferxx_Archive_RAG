import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createDefaultAgentRunStepHandlerRegistry,
} from "../rag/agent-run-step-handlers.js";
import { CAPABILITY_IDS } from "../rag/capabilities/index.js";

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

const createCompletedRunWithSteps = async (agentRunService, {
  goal = "Retry a persisted agent step.",
  runId,
  steps,
} = {}) => {
  await agentRunService.createRun({
    accessScope,
    goal,
    runId,
    status: AGENT_RUN_STATUSES.running,
  });
  return agentRunService.completeRun({
    accessScope,
    runId,
    status: AGENT_RUN_STATUSES.completed,
    steps,
  });
};

test("agent run step handler registry resolves known step handlers", () => {
  const registry = createDefaultAgentRunStepHandlerRegistry();

  assert.equal(
    registry.resolve({
      step: {
        type: "capability_call",
        kind: "capability_call",
      },
    })?.id,
    "capability_call"
  );
  assert.equal(
    registry.resolve({
      step: {
        type: "web_search",
        kind: "tool_call",
      },
    })?.id,
    "web_search"
  );
  assert.equal(
    registry.resolve({
      step: {
        type: "arxiv_import",
        kind: "tool_call",
      },
    })?.id,
    "arxiv_import"
  );
  assert.equal(
    registry.resolve({
      step: {
        type: "document_rag",
        kind: "tool_call",
      },
    })?.id,
    "document_rag"
  );
  assert.equal(
    registry.resolve({
      step: {
        type: "inventory",
        kind: "tool_call",
      },
    }),
    null
  );
});

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

test("agent run step executor retries web_search through the capability handler", async () => {
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
          text: `Web retry: ${payload.input.question}`,
        };
      },
    },
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "Find launch news.",
    runId: "run-web-retry",
    steps: [
      {
        id: "web-step",
        type: "web_search",
        kind: "tool_call",
        label: "Web Search",
        status: "completed",
        input: {
          question: "Find launch news.",
        },
      },
    ],
  });

  const retried = await executor.retryStep({
    accessScope,
    runId: "run-web-retry",
    stepId: "web-step",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, CAPABILITY_IDS.webSearch);
  assert.equal(calls[0].payload.input.question, "Find launch news.");
  assert.equal(calls[0].payload.approval.source, "agent_run_step_retry");
  assert.equal(retried.response.agentMode, "web");
  assert.match(retried.response.agentAnswer, /Web retry/);
  assert.ok(
    retried.run.steps.some(
      (step) =>
        step.retryOfStepId === "web-step" &&
        step.status === "completed" &&
        step.type === "web_search"
    )
  );
});

test("agent run step executor retries arxiv_import through the capability handler", async () => {
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
          text: `Imported topic: ${payload.input.topic}`,
          value: {
            importedCount: 1,
          },
        };
      },
    },
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "Import papers about retrieval augmented generation.",
    runId: "run-arxiv-retry",
    steps: [
      {
        id: "arxiv-step",
        type: "arxiv_import",
        kind: "tool_call",
        label: "arXiv Import",
        status: "completed",
        input: {
          maxResults: 3,
          topic: "retrieval augmented generation",
        },
      },
    ],
  });

  const retried = await executor.retryStep({
    accessScope,
    runId: "run-arxiv-retry",
    stepId: "arxiv-step",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, CAPABILITY_IDS.arxivImportTopic);
  assert.equal(calls[0].payload.input.topic, "retrieval augmented generation");
  assert.equal(calls[0].payload.input.maxResults, 3);
  assert.equal(calls[0].payload.approval.source, "agent_run_step_retry");
  assert.equal(retried.response.agentMode, "arxiv_import");
  assert.match(retried.response.agentAnswer, /Imported topic/);
});

test("agent run step executor returns stable 409 for document_rag until wired", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const executor = createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry: {
      execute: async () => {
        throw new Error("Document RAG retry should not call capability registry.");
      },
    },
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "What did the document say?",
    runId: "run-document-retry",
    steps: [
      {
        id: "document-step",
        type: "document_rag",
        kind: "tool_call",
        label: "Document RAG",
        status: "completed",
      },
    ],
  });

  await assert.rejects(
    () =>
      executor.retryStep({
        accessScope,
        runId: "run-document-retry",
        stepId: "document-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /document_rag retry is not wired yet/i);
      return true;
    }
  );
  const runAfterRejectedRetry = await agentRunService.getRun({
    accessScope,
    runId: "run-document-retry",
  });

  assert.equal(
    runAfterRejectedRetry.steps.some(
      (step) => step.retryOfStepId === "document-step"
    ),
    false
  );
});

test("agent run step executor returns stable 409 for unsupported step types", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const executor = createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry: {
      execute: async () => {
        throw new Error("Unsupported retry should not call capability registry.");
      },
    },
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "List indexed documents.",
    runId: "run-unsupported-retry",
    steps: [
      {
        id: "inventory-step",
        type: "inventory",
        kind: "tool_call",
        label: "Inventory",
        status: "completed",
      },
    ],
  });

  await assert.rejects(
    () =>
      executor.retryStep({
        accessScope,
        runId: "run-unsupported-retry",
        stepId: "inventory-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /Unsupported agent run step type: inventory/);
      return true;
    }
  );
});
