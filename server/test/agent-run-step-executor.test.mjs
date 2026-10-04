import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentBudget } from "../rag/agent-budget.js";
import {
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createCustomSkillStepExecutor,
  createDocumentRagStepExecutor,
  createDefaultAgentRunStepHandlerRegistry,
  createResearchQuestionStepExecutor,
} from "../rag/agent-run-step-handlers/index.js";
import { buildAgentRunStepsFromTrace } from "../rag/agent-run-steps.js";
import { SKILL_EFFECTS } from "../rag/skills/skill-contract.js";
import {
  CAPABILITY_IDS,
  createDefaultCapabilityRegistry,
} from "../rag/capabilities/index.js";
import { createApprovalExecutionSnapshot } from "../rag/capabilities/approval-execution-snapshot.js";
import {
  createInMemoryWorkspaceArtifactStore,
  createWorkspaceArtifactService,
} from "../rag/workspace-artifacts/index.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const buildApprovalFixture = ({
  capabilityId,
  capabilityLabel,
  capabilityVersion = "1.0.0",
  executionInput,
  gateId,
  inputPreview,
  stepId = "2-capability_approval_gate",
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
    stepId,
  };

  return {
    executionInput: snapshot.privateSnapshot.executionInput,
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

const createPendingApprovalRun = async (agentRunService) => {
  const completeQuestion =
    `Search the web for the launch date. ${"complete approved context ".repeat(14)}`;
  const approval = buildApprovalFixture({
    capabilityId: "web.search",
    capabilityLabel: "Web Search",
    executionInput: {
      question: completeQuestion,
    },
    inputPreview: {
      question: completeQuestion.slice(0, 240),
    },
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Search the web for the launch date.",
    runId: "run-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
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
        approvalGateId: approval.gate.id,
        capabilityId: "web.search",
      },
    ],
  });

  return approval;
};

const createCompletedRunWithSteps = async (agentRunService, {
  goal = "Retry a persisted agent step.",
  input = {},
  runId,
  steps,
} = {}) => {
  await agentRunService.createRun({
    accessScope,
    goal,
    input,
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

const persistGuardedGraphCheckpoint = async (agentRunService, {
  docIds = ["doc-1"],
  goal = "Review the selected contract.",
  phase = "running",
  runId,
} = {}) => {
  const owner = buildExecutionGraphCheckpointOwner({
    accessScope,
    budgetState: createAgentBudget(),
    docIds,
    question: goal,
    selectedSkills: [],
  });
  const graph = {
    version: "v1",
    revision: 0,
    nodes: [{ nodeId: "risk", skillId: "risk_review" }],
  };
  const checkpoint = updateExecutionGraphCheckpoint(
    createExecutionGraphCheckpoint({ graph, owner }),
    { phase }
  );

  await agentRunService.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint,
    runId,
  });
  return checkpoint;
};

const appendGuardedGraphCompletedEvent = (agentRunService, {
  runId,
  status = "completed",
} = {}) => agentRunService.appendRunEvent({
  accessScope,
  runId,
  type: "skill_graph_planned",
  payload: {
    executed: true,
    fallback: null,
    graph: { nodeIds: ["risk"], version: "v1" },
    mode: "guarded",
    status,
  },
});

const createGuardedApprovalRun = async (agentRunService, {
  phase = "running",
  runId = "run-approval",
} = {}) => {
  const goal = "Search the web for the launch date.";
  const approval = buildApprovalFixture({
    capabilityId: "web.search",
    capabilityLabel: "Web Search",
    executionInput: { question: goal },
    inputPreview: { question: goal },
  });

  await agentRunService.createRun({
    accessScope,
    goal,
    runId,
    status: AGENT_RUN_STATUSES.running,
  });
  await persistGuardedGraphCheckpoint(agentRunService, { goal, phase, runId });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
    steps: [{
      id: "2-capability_approval_gate",
      type: "capability_approval_gate",
      kind: "approval_gate",
      label: "Capability Approval",
      status: "paused",
      approvalGateId: approval.gate.id,
      capabilityId: "web.search",
    }],
  });
  return approval;
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
        type: "follow_up_retrieval",
        kind: "tool_call",
      },
    })?.id,
    "follow_up_retrieval"
  );
  assert.equal(
    registry.resolve({
      step: {
        type: "custom_skill",
        kind: "tool_call",
      },
    })?.id,
    "custom_skill"
  );
  assert.equal(
    registry.resolve({
      step: {
        type: "research_question",
        kind: "tool_call",
      },
    })?.id,
    "research_question"
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

test("agent run steps persist trace input, output, and failure reason", () => {
  const steps = buildAgentRunStepsFromTrace({
    now: () => "2026-06-17T00:00:00.000Z",
    trace: [
      {
        id: "custom-step",
        type: "custom_skill",
        label: "Risk Review",
        status: "completed",
        summary: "Risk Review completed.",
        input: {
          docIds: ["doc-1"],
          question: "Review risk.",
          skillId: "risk_review",
        },
        output: {
          citationCount: 1,
          text: "Risk answer.",
        },
        detail: {
          skillId: "risk_review",
          skillVersion: "1.0.0",
        },
      },
      {
        id: "follow-up-step",
        type: "follow_up_retrieval",
        label: "Follow-up Retrieval",
        status: "failed",
        summary: "Focused follow-up failed: timeout.",
        input: {
          docIds: ["doc-1"],
          question: "Find cited support.",
        },
        detail: {
          skillId: "document_rag",
          skillVersion: "1.0.0",
        },
      },
    ],
  });
  const customStep = steps.find((step) => step.id === "custom-step");
  const followUpStep = steps.find((step) => step.id === "follow-up-step");

  assert.equal(customStep.kind, "tool_call");
  assert.equal(customStep.input.skillId, "risk_review");
  assert.equal(customStep.output.citationCount, 1);
  assert.equal(followUpStep.kind, "tool_call");
  assert.equal(followUpStep.input.question, "Find cited support.");
  assert.equal(followUpStep.error.message, "Focused follow-up failed: timeout.");
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

  const approval = await createPendingApprovalRun(agentRunService);

  const result = await executor.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: `  ${approval.gate.id}  `,
    payload: {
      approvalObjectHash: approval.gate.approvalObjectHash,
    },
    runId: "run-approval",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, "web.search");
  assert.equal(calls[0].payload.approval.approved, true);
  assert.deepEqual(calls[0].payload.input, approval.executionInput);
  assert.ok(calls[0].payload.input.question.length > 240);
  assert.equal(result.response.agentMode, "web");
  assert.match(result.response.agentAnswer, /Approved answer/);
  assert.equal(result.run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(result.run.approvalGates[0].status, "approved");
  const capabilityStep = result.run.steps.find(
    (step) =>
      step.kind === "capability_call" &&
      step.status === "completed" &&
      step.capabilityId === "web.search"
  );
  assert.ok(capabilityStep);
  assert.equal(capabilityStep.input, null);
  assert.equal(
    capabilityStep.detail.approvalObjectHash,
    approval.gate.approvalObjectHash
  );
  assert.deepEqual(
    result.run.events.map((event) => event.type),
    [
      "run_created",
      "approval_gate_created",
      "approval_gate_approved",
      "step_started",
      "step_completed",
      "run_completed",
    ]
  );
});

test("agent run step executor resumes a persisted pending document step", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const recordedReplayEvents = [];
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async (docIds, question, options) => {
          calls.push({
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
            text: `Resumed document answer: ${question}`,
          };
        },
      },
    }),
    recordStepReplayTrace: async (event) => recordedReplayEvents.push(event),
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Resume document step",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-document-resume",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.updateRun({
    accessScope,
    runId: "run-document-resume",
    patch: {
      steps: [
        {
          id: "document-step",
          input: {
            docIds: ["doc-1"],
            question: "What is annual leave?",
          },
          kind: "tool_call",
          status: "pending",
          type: "document_rag",
        },
      ],
    },
  });

  const resumed = await executor.resumeStep({
    accessScope,
    runId: "run-document-resume",
    stepId: "document-step",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].docIds, ["doc-1"]);
  assert.equal(calls[0].question, "What is annual leave?");
  assert.equal(calls[0].options.includeRetrievedContexts, true);
  assert.equal(resumed.run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(resumed.response.agentMode, "document");
  assert.match(resumed.response.agentAnswer, /Resumed document answer/);
  assert.equal(recordedReplayEvents.length, 1);
  assert.deepEqual(
    {
      action: recordedReplayEvents[0].action,
      runId: recordedReplayEvents[0].runId,
      status: recordedReplayEvents[0].status,
      stepId: recordedReplayEvents[0].stepId,
      stepType: recordedReplayEvents[0].stepType,
      traceType: recordedReplayEvents[0].traceType,
    },
    {
      action: "resume_step",
      runId: "run-document-resume",
      status: "completed",
      stepId: "document-step",
      stepType: "document_rag",
      traceType: "agent_run_step_replay",
    }
  );
  assert.equal(
    resumed.run.steps.find((step) => step.id === "document-step").status,
    "completed"
  );
  assert.deepEqual(
    resumed.run.events.map((event) => event.type),
    [
      "run_created",
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
  const artifactExecutionContexts = [];
  const executor = createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry: {
      execute: async (_capabilityId, payload) => {
        callCount += 1;
        artifactExecutionContexts.push(payload.services?.artifactExecution);

        return {
          text: `Web answer ${callCount}`,
        };
      },
    },
  });

  const approval = await createPendingApprovalRun(agentRunService);
  const approved = await executor.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: approval.gate.id,
    payload: {
      approvalObjectHash: approval.gate.approvalObjectHash,
    },
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
  const firstRetryStep = retried.run.steps.find(
    (step) => step.retryOfStepId === capabilityStep.id
  );
  const retriedAgain = await executor.retryStep({
    accessScope,
    runId: "run-approval",
    stepId: firstRetryStep.id,
  });

  assert.equal(callCount, 3);
  assert.deepEqual(artifactExecutionContexts, [
    {
      idempotencyKey: `capability-artifact:run-approval:${capabilityStep.id}:web.search`,
      sourceRunId: "run-approval",
    },
    {
      idempotencyKey: `capability-artifact:run-approval:${capabilityStep.id}:web.search`,
      sourceRunId: "run-approval",
    },
    {
      idempotencyKey: `capability-artifact:run-approval:${capabilityStep.id}:web.search`,
      sourceRunId: "run-approval",
    },
  ]);
  assert.equal(retriedAgain.run.status, AGENT_RUN_STATUSES.completed);
  assert.ok(
    retriedAgain.run.steps.some(
      (step) =>
        step.retryOfStepId === capabilityStep.id &&
        step.status === "completed" &&
        step.attempt === 2
    )
  );
  assert.ok(
    retriedAgain.run.steps.some(
      (step) =>
        step.retryOfStepId === firstRetryStep.id &&
        step.status === "completed"
    )
  );
  assert.ok(
    retriedAgain.run.events
      .map((event) => event.type)
      .includes("step_retry_queued")
  );
  assert.match(retriedAgain.response.agentAnswer, /Web answer 3/);
});

test("approved report artifact resume and nested retries create one stored artifact", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  let artifactId = 0;
  const workspaceArtifactService = createWorkspaceArtifactService({
    createArtifactId: () => `artifact-${(artifactId += 1)}`,
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const executor = createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry: createDefaultCapabilityRegistry({
      workspaceArtifactService,
    }),
  });
  const reportInput = {
    citations: [
      {
        docId: "doc-1",
        excerpt: "Complete approved report evidence.",
      },
    ],
    content: "Replay-safe report content.",
    format: "markdown",
    metadata: {
      approvedFromSnapshot: true,
    },
    title: "Replay-safe report",
  };
  const approval = buildApprovalFixture({
    capabilityId: CAPABILITY_IDS.reportExport,
    capabilityLabel: "Report Export",
    executionInput: reportInput,
    inputPreview: {
      format: reportInput.format,
      title: reportInput.title,
    },
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Export a replay-safe report.",
    runId: "run-report-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    runId: "run-report-approval",
    status: AGENT_RUN_STATUSES.waitingForUser,
    steps: [
      {
        id: "2-capability_approval_gate",
        type: "capability_approval_gate",
        kind: "approval_gate",
        label: "Capability Approval",
        status: "paused",
        summary: "Report Export requires approval.",
        approvalGateId: approval.gate.id,
        capabilityId: CAPABILITY_IDS.reportExport,
      },
    ],
  });
  const publicPendingRun = await agentRunService.getRun({
    accessScope,
    runId: "run-report-approval",
  });

  assert.doesNotMatch(
    JSON.stringify(publicPendingRun),
    /Replay-safe report content/
  );
  assert.equal(
    Object.hasOwn(publicPendingRun, "approvalSnapshots"),
    false
  );

  const approved = await executor.applyApprovalAction({
    accessScope,
    action: "approve",
    gateId: approval.gate.id,
    payload: {
      approvalObjectHash: approval.gate.approvalObjectHash,
    },
    runId: "run-report-approval",
  });
  const capabilityStep = approved.run.steps.find(
    (step) => step.kind === "capability_call"
  );
  assert.equal(capabilityStep.input, null);
  assert.equal(approval.gate.inputPreview.content, undefined);
  assert.equal(approval.executionInput.content, reportInput.content);
  const firstRetry = await executor.retryStep({
    accessScope,
    runId: "run-report-approval",
    stepId: capabilityStep.id,
  });
  const firstRetryStep = firstRetry.run.steps.find(
    (step) => step.retryOfStepId === capabilityStep.id
  );

  await executor.retryStep({
    accessScope,
    runId: "run-report-approval",
    stepId: firstRetryStep.id,
  });

  const stored = await workspaceArtifactService.listArtifacts({
    accessScope,
  });

  assert.equal(stored.total, 1);
  assert.equal(stored.artifacts[0].artifactId, "artifact-1");
  assert.equal(stored.artifacts[0].artifactType, "report");
  assert.equal(artifactId, 3);
});

test("denied approval-capable primary steps cannot be retried through an unbound execution path", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  let externalCallCount = 0;
  const executor = createAgentRunStepExecutor({
    agentRunService,
    capabilityRegistry: {
      execute: async () => {
        externalCallCount += 1;
        return {
          text: "This call must never happen.",
        };
      },
    },
  });
  const approval = buildApprovalFixture({
    capabilityId: CAPABILITY_IDS.webSearch,
    capabilityLabel: "Web Search",
    executionInput: {
      question: "Search for denied external context.",
    },
    inputPreview: {
      question: "Search for denied external context.",
    },
    stepId: "approval-gate-step",
  });
  const runId = "run-denied-web-primary-retry";

  await agentRunService.createRun({
    accessScope,
    goal: "Search for denied external context.",
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    approvalGates: [approval.gate],
    approvalSnapshots: [approval.snapshot],
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
    steps: [
      {
        approvalGateId: approval.gate.id,
        capabilityId: CAPABILITY_IDS.webSearch,
        id: "approval-gate-step",
        kind: "approval_gate",
        label: "Capability Approval",
        status: "paused",
        type: "capability_approval_gate",
      },
      {
        detail: {
          approvalGate: {
            id: approval.gate.id,
            capabilityId: CAPABILITY_IDS.webSearch,
          },
          interruptType: "capability_approval_required",
        },
        id: "web_search:primary",
        input: null,
        kind: "tool_call",
        label: "Web Search",
        status: "paused",
        type: "web_search",
      },
    ],
  });
  const denied = await executor.applyApprovalAction({
    accessScope,
    action: "deny",
    gateId: approval.gate.id,
    payload: {
      approvalObjectHash: approval.gate.approvalObjectHash,
    },
    runId,
  });
  const beforeRetry = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.equal(denied.run.approvalGates[0].status, "denied");
  assert.equal(
    denied.run.steps.find((step) => step.id === "web_search:primary").status,
    "skipped"
  );

  await assert.rejects(
    () =>
      executor.retryStep({
        accessScope,
        runId,
        stepId: "web_search:primary",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /hash-bound capability_call/i);
      return true;
    }
  );

  assert.equal(externalCallCount, 0);
  assert.deepEqual(
    await agentRunService.getRun({
      accessScope,
      runId,
    }),
    beforeRetry
  );
});

test("agent run step executor rejects legacy web_search retry without a bound approval snapshot", async () => {
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

  const originalRun = await createCompletedRunWithSteps(agentRunService, {
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

  await assert.rejects(
    () =>
      executor.retryStep({
        accessScope,
        runId: "run-web-retry",
        stepId: "web-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /hash-bound capability_call/i);
      return true;
    }
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await agentRunService.getRun({
      accessScope,
      runId: "run-web-retry",
    }),
    originalRun
  );
});

test("agent run step executor rejects legacy arxiv_import retry without a bound approval snapshot", async () => {
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

  const originalRun = await createCompletedRunWithSteps(agentRunService, {
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

  await assert.rejects(
    () =>
      executor.retryStep({
        accessScope,
        runId: "run-arxiv-retry",
        stepId: "arxiv-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /hash-bound capability_call/i);
      return true;
    }
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await agentRunService.getRun({
      accessScope,
      runId: "run-arxiv-retry",
    }),
    originalRun
  );
});

test("agent run step executor retries document_rag through the wired document handler", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const recordedReplayEvents = [];
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async (docIds, question, options) => {
          calls.push({
            docIds,
            options,
            question,
          });

          return {
            text: `Retried document answer: ${question} [Source 1]`,
            citations: [
              {
                docId: "doc-1",
                pageNumber: 2,
                rank: 1,
              },
            ],
            abstained: false,
            evidenceSummary: {
              supportedClaimCount: 1,
            },
            memoryApplied: false,
            resolvedQuery: question,
          };
        },
      },
    }),
    recordStepReplayTrace: async (event) => recordedReplayEvents.push(event),
  });
  const retrievalPlan = {
    retrievalQueries: [
      {
        id: "primary",
        query: "annual leave",
      },
    ],
    retrievalOptions: {
      topK: 2,
    },
  };

  await createCompletedRunWithSteps(agentRunService, {
    goal: "What is annual leave?",
    input: {
      docIds: ["doc-1"],
      sessionId: "session-1",
      userId: "alice",
    },
    runId: "run-document-retry",
    steps: [
      {
        id: "document-step",
        type: "document_rag",
        kind: "tool_call",
        label: "Document RAG",
        status: "completed",
        detail: {
          skillVersion: "1.0.0",
        },
        input: {
          docIds: ["doc-1"],
          question: "What is annual leave?",
          retrievalPlan,
          sessionId: "session-1",
          userId: "alice",
        },
      },
    ],
  });

  const retried = await executor.retryStep({
    accessScope,
    runId: "run-document-retry",
    stepId: "document-step",
  });
  const retryStep = retried.run.steps.find(
    (step) => step.retryOfStepId === "document-step"
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].docIds, ["doc-1"]);
  assert.equal(calls[0].question, "What is annual leave?");
  assert.deepEqual(calls[0].options.accessScope, accessScope);
  assert.deepEqual(calls[0].options.retrievalPlan, retrievalPlan);
  // The primary call is the user's question: a retry records it as before.
  assert.equal(calls[0].options.memoryWrites, undefined);
  assert.equal(retried.response.agentMode, "document");
  assert.match(retried.response.agentAnswer, /Retried document answer/);
  assert.equal(retried.response.ragSources.length, 1);
  assert.equal(retried.response.ragEvidenceSummary.supportedClaimCount, 1);
  assert.equal(retried.run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(retryStep.status, "completed");
  assert.equal(retryStep.attempt, 2);
  assert.equal(retryStep.input.question, "What is annual leave?");
  assert.equal(retryStep.output.citationCount, 1);
  assert.equal(recordedReplayEvents.length, 1);
  assert.deepEqual(
    {
      action: recordedReplayEvents[0].action,
      retryOfStepId: recordedReplayEvents[0].retryOfStepId,
      runId: recordedReplayEvents[0].runId,
      status: recordedReplayEvents[0].status,
      stepId: recordedReplayEvents[0].stepId,
      stepType: recordedReplayEvents[0].stepType,
      traceType: recordedReplayEvents[0].traceType,
    },
    {
      action: "retry_step",
      retryOfStepId: "document-step",
      runId: "run-document-retry",
      status: "completed",
      stepId: retryStep.id,
      stepType: "document_rag",
      traceType: "agent_run_step_replay",
    }
  );
  assert.deepEqual(
    retried.run.events.map((event) => event.type),
    [
      "run_created",
      "run_completed",
      "step_retry_queued",
      "step_started",
      "step_completed",
      "run_completed",
    ]
  );
});

test("agent run step executor retries follow_up_retrieval through the wired document handler", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async (docIds, question, options) => {
          calls.push({
            docIds,
            options,
            question,
          });

          return {
            text: `Retried follow-up answer: ${question} [Source 1]`,
            citations: [
              {
                docId: "doc-1",
                pageNumber: 3,
                rank: 1,
              },
            ],
            abstained: false,
            resolvedQuery: question,
          };
        },
      },
    }),
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "What cited support is missing?",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-follow-up-retry",
    steps: [
      {
        id: "follow-up-step",
        type: "follow_up_retrieval",
        kind: "tool_call",
        label: "Follow-up Retrieval",
        status: "failed",
        input: {
          docIds: ["doc-1"],
          question: "Find cited support for annual leave.",
          retrievalPlan: {
            phase: "follow_up",
          },
        },
      },
    ],
  });

  const retried = await executor.retryStep({
    accessScope,
    runId: "run-follow-up-retry",
    stepId: "follow-up-step",
  });
  const retryStep = retried.run.steps.find(
    (step) => step.retryOfStepId === "follow-up-step"
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].docIds, ["doc-1"]);
  assert.equal(calls[0].question, "Find cited support for annual leave.");
  assert.deepEqual(calls[0].options.retrievalPlan, {
    phase: "follow_up",
  });
  // A follow-up question is agent text: the retry writes no memory.
  assert.equal(calls[0].options.memoryWrites, false);
  assert.equal(retried.response.agentMode, "document");
  assert.match(retried.response.agentAnswer, /Retried follow-up answer/);
  assert.equal(retryStep.type, "follow_up_retrieval");
  assert.equal(retryStep.status, "completed");
  assert.equal(retryStep.output.citationCount, 1);
});

test("agent run step executor retries custom_skill through the wired custom handler", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const customSkill = {
    id: "risk_review",
    version: "1.0.0",
    label: "Risk Review",
    kind: "custom",
    budgetKey: "customSkillCalls",
    requiresAccessScope: true,
    match: () => false,
    execute: async (context) => {
      calls.push(context);

      return {
        text: `Retried custom answer: ${context.question}`,
        citations: [
          {
            docId: "doc-1",
            pageNumber: 4,
          },
        ],
        abstained: false,
      };
    },
  };
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeCustomSkillStep: createCustomSkillStepExecutor({
      ragService: {},
      skillRegistry: {
        get: (skillId) => (skillId === customSkill.id ? customSkill : null),
      },
    }),
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "Review risk.",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-custom-retry",
    steps: [
      {
        id: "custom_skill:risk_review",
        type: "custom_skill",
        kind: "tool_call",
        label: "Risk Review",
        status: "failed",
        input: {
          docIds: ["doc-1"],
          question: "Review risk.",
          skillId: "risk_review",
          skillVersion: "1.0.0",
        },
      },
    ],
  });

  const retried = await executor.retryStep({
    accessScope,
    runId: "run-custom-retry",
    stepId: "custom_skill:risk_review",
  });
  const retryStep = retried.run.steps.find(
    (step) => step.retryOfStepId === "custom_skill:risk_review"
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].accessScope, accessScope);
  assert.deepEqual(calls[0].docIds, ["doc-1"]);
  assert.equal(calls[0].question, "Review risk.");
  assert.equal(retried.response.agentMode, "risk_review");
  assert.match(retried.response.agentAnswer, /Retried custom answer/);
  assert.equal(retryStep.status, "completed");
  assert.equal(retryStep.output.citationCount, 1);
});

test("legacy V1 custom_skill prefix still resumes without a graph checkpoint", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const skill = {
    id: "risk_review",
    version: "1.0.0",
    label: "Risk Review",
    kind: "custom",
    budgetKey: "customSkillCalls",
    requiresAccessScope: true,
    match: () => false,
    execute: async (context) => {
      calls.push(context);
      return {
        text: "Legacy V1 replay result.",
        citations: [{ docId: "doc-1", pageNumber: 1 }],
        abstained: false,
      };
    },
  };
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeCustomSkillStep: createCustomSkillStepExecutor({
      ragService: {},
      skillRegistry: { get: (skillId) => skillId === skill.id ? skill : null },
    }),
  });
  const runId = "legacy-v1-custom-resume";

  await agentRunService.createRun({
    accessScope,
    goal: "Review risk.",
    input: { docIds: ["doc-1"] },
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
  });
  await agentRunService.completeRun({
    accessScope,
    runId,
    status: AGENT_RUN_STATUSES.waitingForUser,
    steps: [{
      id: "custom_skill:risk_review",
      type: "custom_skill",
      kind: "tool_call",
      label: "Risk Review",
      status: "paused",
      input: {
        docIds: ["doc-1"],
        question: "Review risk.",
        skillId: "risk_review",
        skillVersion: "1.0.0",
      },
    }],
  });

  const resumed = await executor.resumeStep({
    accessScope,
    runId,
    stepId: "custom_skill:risk_review",
  });

  assert.equal(calls.length, 1);
  assert.equal(resumed.run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(resumed.response.agentAnswer, "Legacy V1 replay result.");
});

/**
 * The persisted contract is what the step said about itself when it ran, and a
 * deploy can land between the interruption and the replay. The registry holds
 * what the skill is now, so this is the authoritative check: re-executing a
 * skill that writes needs the approval machinery a blind step replay does not
 * have, whatever the stored record claims.
 */
test("agent run step executor refuses to replay a skill that now declares a side effect", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const writingSkill = {
    id: "publish_report",
    version: "2.0.0",
    label: "Publish Report",
    kind: "custom",
    budgetKey: "customSkillCalls",
    requiresAccessScope: true,
    effects: SKILL_EFFECTS.workspaceWrite,
    match: () => false,
    execute: async (context) => {
      calls.push(context);

      return { abstained: false, citations: [], text: "published" };
    },
  };
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeCustomSkillStep: createCustomSkillStepExecutor({
      ragService: {},
      skillRegistry: {
        get: (skillId) => (skillId === writingSkill.id ? writingSkill : null),
      },
    }),
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "Publish the review.",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-custom-write-retry",
    steps: [
      {
        id: "custom-step",
        type: "custom_skill",
        kind: "tool_call",
        label: "Publish Report",
        status: "failed",
        input: {
          docIds: ["doc-1"],
          // The record still carries the read-only contract this skill had when
          // the step ran. It is stale, and it must not be what decides.
          effects: SKILL_EFFECTS.readOnly,
          question: "Publish the review.",
          replaySafe: true,
          skillId: "publish_report",
          skillVersion: "1.0.0",
        },
      },
    ],
  });

  await assert.rejects(
    () =>
      executor.retryStep({
        accessScope,
        runId: "run-custom-write-retry",
        stepId: "custom-step",
      }),
    (error) => {
      assert.match(error.message, /side effect/i);
      assert.equal(error.status, 409);

      return true;
    }
  );

  assert.deepEqual(calls, []);
});

test("agent run step executor retries research_question through the wired research handler", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeResearchQuestionStep: createResearchQuestionStepExecutor({
      ragService: {
        chat: async (docIds, question, options) => {
          calls.push({
            docIds,
            options,
            question,
          });

          return {
            text: `Retried research answer: ${question} [Source 1]`,
            citations: [
              {
                docId: "doc-1",
                rank: 1,
              },
            ],
            abstained: false,
            resolvedQuery: question,
          };
        },
      },
    }),
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "Create a research brief.",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-research-retry",
    steps: [
      {
        id: "research-step",
        type: "research_question",
        kind: "tool_call",
        label: "Research Question",
        status: "failed",
        input: {
          docIds: ["doc-1"],
          question: "What facts matter?",
          researchQuestionId: "rq-1",
        },
      },
    ],
  });

  const retried = await executor.retryStep({
    accessScope,
    runId: "run-research-retry",
    stepId: "research-step",
  });
  const retryStep = retried.run.steps.find(
    (step) => step.retryOfStepId === "research-step"
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].docIds, ["doc-1"]);
  assert.equal(calls[0].question, "What facts matter?");
  assert.deepEqual(calls[0].options.accessScope, accessScope);
  assert.equal(calls[0].options.includeRetrievedContexts, true);
  // A research question is text the brief composed: no memory writes.
  assert.equal(calls[0].options.memoryWrites, false);
  assert.equal(retried.response.agentMode, "research_brief");
  assert.equal(retried.response.researchBrief.findings[0].id, "rq-1");
  assert.match(retried.response.agentAnswer, /Retried research answer/);
  assert.equal(retryStep.status, "completed");
  assert.equal(retryStep.output.citationCount, 1);
});

test("agent run step executor persists failed custom_skill retry state", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const customSkill = {
    id: "risk_review",
    version: "1.0.0",
    label: "Risk Review",
    kind: "custom",
    budgetKey: "customSkillCalls",
    requiresAccessScope: true,
    match: () => false,
    execute: async () => {
      throw new Error("custom retry failed");
    },
  };
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeCustomSkillStep: createCustomSkillStepExecutor({
      ragService: {},
      skillRegistry: {
        get: (skillId) => (skillId === customSkill.id ? customSkill : null),
      },
    }),
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "Review risk.",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-custom-retry-fails",
    steps: [
      {
        id: "custom-step",
        type: "custom_skill",
        kind: "tool_call",
        label: "Risk Review",
        status: "failed",
        input: {
          docIds: ["doc-1"],
          question: "Review risk.",
          skillId: "risk_review",
        },
      },
    ],
  });

  await assert.rejects(
    () =>
      executor.retryStep({
        accessScope,
        runId: "run-custom-retry-fails",
        stepId: "custom-step",
      }),
    /custom retry failed/
  );

  const failedRun = await agentRunService.getRun({
    accessScope,
    runId: "run-custom-retry-fails",
  });
  const failedRetryStep = failedRun.steps.find(
    (step) => step.retryOfStepId === "custom-step"
  );

  assert.equal(failedRun.status, AGENT_RUN_STATUSES.failed);
  assert.equal(failedRetryStep.status, "failed");
  assert.equal(failedRetryStep.error.message, "custom retry failed");
});

test("agent run step executor validates document_rag retry input before queueing", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: createDocumentRagStepExecutor({
      ragService: {
        chat: async () => {
          throw new Error("Invalid document retry should not run.");
        },
      },
    }),
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "What did the document say?",
    runId: "run-document-retry-missing-input",
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
        runId: "run-document-retry-missing-input",
        stepId: "document-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /requires at least one document id/i);
      return true;
    }
  );

  const runAfterRejectedRetry = await agentRunService.getRun({
    accessScope,
    runId: "run-document-retry-missing-input",
  });

  assert.equal(
    runAfterRejectedRetry.steps.some(
      (step) => step.retryOfStepId === "document-step"
    ),
    false
  );
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

test("active guarded graph rejects standalone non-graph resume before mutation", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeDocumentRagStep: async () => { calls.push("executed"); },
  });
  const runId = "guarded-non-graph-resume";
  const goal = "Review the selected contract.";

  await agentRunService.createRun({
    accessScope,
    goal,
    input: { docIds: ["doc-1"] },
    runId,
    status: AGENT_RUN_STATUSES.running,
  });
  await agentRunService.updateRun({
    accessScope,
    runId,
    patch: { steps: [{
      id: "document-step",
      type: "document_rag",
      kind: "tool_call",
      label: "Document RAG",
      status: "failed",
      input: { docIds: ["doc-1"], question: goal },
    }] },
  });
  await persistGuardedGraphCheckpoint(agentRunService, { goal, runId });
  const before = await agentRunService.getRun({ accessScope, runId });

  await assert.rejects(
    () => executor.resumeStep({ accessScope, runId, stepId: "document-step" }),
    (error) => {
      assert.equal(error.code, "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY");
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await agentRunService.getRun({ accessScope, runId }), before);
});

test("active guarded graph rejects standalone non-graph retry before queuing", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const executor = createAgentRunStepExecutor({ agentRunService });
  const runId = "guarded-non-graph-retry";
  const goal = "Review the selected contract.";

  await agentRunService.createRun({
    accessScope,
    goal,
    input: { docIds: ["doc-1"] },
    runId,
    status: AGENT_RUN_STATUSES.running,
  });
  await agentRunService.updateRun({
    accessScope,
    runId,
    patch: { steps: [{
      id: "document-step",
      type: "document_rag",
      kind: "tool_call",
      label: "Document RAG",
      status: "failed",
      input: { docIds: ["doc-1"], question: goal },
    }] },
  });
  await persistGuardedGraphCheckpoint(agentRunService, { goal, runId });
  const before = await agentRunService.getRun({ accessScope, runId });

  await assert.rejects(
    () => executor.retryStep({ accessScope, runId, stepId: "document-step" }),
    (error) => {
      assert.equal(error.code, "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY");
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.deepEqual(await agentRunService.getRun({ accessScope, runId }), before);
});

test("active guarded graph rejects approval and denial before changing the gate", async () => {
  for (const action of ["approve", "deny"]) {
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const calls = [];
    const executor = createAgentRunStepExecutor({
      agentRunService,
      capabilityRegistry: { execute: async () => { calls.push("executed"); } },
    });
    const approval = await createGuardedApprovalRun(agentRunService);
    const before = await agentRunService.getRun({
      accessScope,
      runId: "run-approval",
    });

    await assert.rejects(
      () => executor.applyApprovalAction({
        accessScope,
        action,
        gateId: approval.gate.id,
        payload: { approvalObjectHash: approval.gate.approvalObjectHash },
        runId: "run-approval",
      }),
      (error) => {
        assert.equal(error.code, "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY");
        assert.equal(error.status, 409);
        return true;
      }
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(await agentRunService.getRun({ accessScope, runId: "run-approval" }), before);
  }
});

test("terminal guarded graph still rejects pre-graph approval gate", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const executor = createAgentRunStepExecutor({ agentRunService });
  const approval = await createGuardedApprovalRun(agentRunService, { phase: "completed" });
  await appendGuardedGraphCompletedEvent(agentRunService, { runId: "run-approval" });
  const before = await agentRunService.getRun({ accessScope, runId: "run-approval" });

  await assert.rejects(
    () => executor.applyApprovalAction({
      accessScope,
      action: "deny",
      gateId: approval.gate.id,
      payload: { approvalObjectHash: approval.gate.approvalObjectHash },
      runId: "run-approval",
    }),
    (error) => {
      assert.equal(error.code, "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY");
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.deepEqual(await agentRunService.getRun({ accessScope, runId: "run-approval" }), before);
});

test("terminal guarded graph allows approval gate provably created after graph completion", async () => {
  for (const action of ["approve", "deny"]) {
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const calls = [];
    const executor = createAgentRunStepExecutor({
      agentRunService,
      capabilityRegistry: {
        execute: async (capabilityId, payload) => {
          calls.push({ capabilityId, payload });
          return { citations: [], text: "Approved post-graph search." };
        },
      },
    });
    const runId = `post-graph-${action}`;
    const goal = "Search the web for the launch date.";
    const approval = buildApprovalFixture({
      capabilityId: "web.search",
      capabilityLabel: "Web Search",
      executionInput: { question: goal },
      inputPreview: { question: goal },
    });

    await agentRunService.createRun({ accessScope, goal, runId, status: AGENT_RUN_STATUSES.running });
    await persistGuardedGraphCheckpoint(agentRunService, { goal, phase: "completed", runId });
    await appendGuardedGraphCompletedEvent(agentRunService, { runId });
    await agentRunService.completeRun({
      accessScope,
      approvalGates: [approval.gate],
      approvalSnapshots: [approval.snapshot],
      runId,
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps: [{
        id: "2-capability_approval_gate",
        type: "capability_approval_gate",
        kind: "approval_gate",
        label: "Capability Approval",
        status: "paused",
        approvalGateId: approval.gate.id,
        capabilityId: "web.search",
      }],
    });

    const result = await executor.applyApprovalAction({
      accessScope,
      action,
      gateId: approval.gate.id,
      payload: { approvalObjectHash: approval.gate.approvalObjectHash },
      runId,
    });
    assert.equal(result.run.status, AGENT_RUN_STATUSES.completed);
    assert.equal(result.run.approvalGates[0].status, action === "approve" ? "approved" : "denied");
    assert.equal(calls.length, action === "approve" ? 1 : 0);
  }
});

// A graph-shaped step must fail closed even if its checkpoint is unavailable:
// replaying only its stored upstream text would bypass graph ownership and
// allow an isolated node to complete the entire run.
test("agent run step executor rejects standalone retry of a graph-shaped node without a checkpoint", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const customSkill = {
    id: "risk_review",
    version: "1.0.0",
    label: "Risk Review",
    kind: "custom",
    budgetKey: "customSkillCalls",
    requiresAccessScope: true,
    match: () => false,
    execute: async (context) => {
      calls.push(context);

      return {
        text: "Risk reviewed against the upstream summary.",
        citations: [{ docId: "doc-1", pageNumber: 4 }],
        abstained: false,
      };
    },
  };
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeCustomSkillStep: createCustomSkillStepExecutor({
      ragService: {},
      skillRegistry: {
        get: (skillId) => (skillId === customSkill.id ? customSkill : null),
      },
    }),
  });

  await createCompletedRunWithSteps(agentRunService, {
    goal: "Review this contract for risks and key terms.",
    input: {
      docIds: ["doc-1"],
    },
    runId: "run-graph-node-retry",
    steps: [
      {
        id: "custom_skill:risk_review",
        type: "custom_skill",
        kind: "tool_call",
        label: "Risk Review",
        status: "failed",
        input: {
          docIds: ["doc-1"],
          nodeId: "risk_review",
          priorFindings: "Summary: the agreement renews every 12 months.",
          question: "Review this contract for risks and key terms.",
          skillId: "risk_review",
          skillVersion: "1.0.0",
        },
      },
    ],
  });

  const before = await agentRunService.getRun({
    accessScope,
    runId: "run-graph-node-retry",
  });

  await assert.rejects(
    () => executor.retryStep({
      accessScope,
      runId: "run-graph-node-retry",
      stepId: "custom_skill:risk_review",
    }),
    (error) => {
      assert.equal(error.code, "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY");
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await agentRunService.getRun({ accessScope, runId: "run-graph-node-retry" }), before);
});

test("guarded graph nodes reject generic retry and resume before any step mutation", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const calls = [];
  const executor = createAgentRunStepExecutor({
    agentRunService,
    executeCustomSkillStep: async () => { calls.push("executed"); },
  });
  const goal = "Review the selected contract.";
  const docIds = ["doc-1"];
  const graphStep = {
    id: "custom_skill:risk",
    type: "custom_skill",
    kind: "tool_call",
    label: "Risk Review",
    status: "failed",
    input: {
      docIds,
      nodeId: "risk",
      question: goal,
      skillId: "risk_review",
      skillVersion: "1.0.0",
    },
  };
  const graph = {
    version: "v1",
    revision: 0,
    nodes: [{ nodeId: "risk", skillId: "risk_review" }],
  };
  const checkpointOwner = buildExecutionGraphCheckpointOwner({
    accessScope,
    budgetState: createAgentBudget(),
    docIds,
    question: goal,
    selectedSkills: [],
  });

  for (const [runId, runStatus, stepStatus, includeNodeMarker] of [
    ["guarded-graph-retry", AGENT_RUN_STATUSES.completed, "failed", true],
    ["guarded-graph-resume", AGENT_RUN_STATUSES.waitingForUser, "paused", true],
    ["guarded-graph-older-step", AGENT_RUN_STATUSES.completed, "failed", false],
  ]) {
    await agentRunService.createRun({
      accessScope,
      goal,
      input: { docIds },
      runId,
    });
    const checkpoint = updateExecutionGraphCheckpoint(
      createExecutionGraphCheckpoint({ graph, owner: checkpointOwner }),
      { phase: runStatus === AGENT_RUN_STATUSES.completed ? "partial" : "running" }
    );
    await agentRunService.saveExecutionGraphCheckpoint({
      accessScope,
      checkpoint,
      runId,
    });
    await agentRunService.completeRun({
      accessScope,
      runId,
      status: runStatus,
      steps: [{
        ...graphStep,
        status: stepStatus,
        input: includeNodeMarker
          ? graphStep.input
          : { ...graphStep.input, nodeId: undefined },
      }],
    });
    const beforeRun = await agentRunService.getRun({ accessScope, runId });
    const beforeCheckpoint = await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId });
    const action = runStatus === AGENT_RUN_STATUSES.completed ? "retryStep" : "resumeStep";

    await assert.rejects(
      () => executor[action]({ accessScope, runId, stepId: graphStep.id }),
      (error) => {
        assert.equal(error.code, "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY");
        assert.equal(error.status, 409);
        return true;
      }
    );
    assert.deepEqual(await agentRunService.getRun({ accessScope, runId }), beforeRun);
    assert.deepEqual(
      await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }),
      beforeCheckpoint
    );

    if (runId === "guarded-graph-retry") {
      await assert.rejects(
        () => agentRunService.retryStep({ accessScope, runId, stepId: graphStep.id }),
        (error) => {
          assert.equal(error.code, "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY");
          return true;
        }
      );
      assert.deepEqual(await agentRunService.getRun({ accessScope, runId }), beforeRun);
    }
  }

  assert.deepEqual(calls, []);
});
