import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import {
  createCustomSkillStepExecutor,
  createDocumentRagStepExecutor,
  createDefaultAgentRunStepHandlerRegistry,
  createResearchQuestionStepExecutor,
} from "../rag/agent-run-step-handlers/index.js";
import { buildAgentRunStepsFromTrace } from "../rag/agent-run-steps.js";
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
        chat: async (docIds, question) => {
          calls.push({
            docIds,
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
        id: "custom-step",
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
    stepId: "custom-step",
  });
  const retryStep = retried.run.steps.find(
    (step) => step.retryOfStepId === "custom-step"
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
