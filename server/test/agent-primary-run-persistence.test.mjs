import assert from "node:assert/strict";
import test from "node:test";

import { runAgentRag } from "../rag/agent.js";
import { createAgentBudget } from "../rag/agent-budget.js";
import { runDocumentRagLoop } from "../rag/agent-document-loop.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { AGENT_RUN_STEP_STATUSES } from "../rag/agent-run-steps.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const question = "What does remote work require?";

const createRunService = () =>
  createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-22T00:00:00.000Z",
    }),
  });

const getRunForResponse = async ({ agentRunService, response }) =>
  agentRunService.getRun({
    accessScope,
    runId: response.body.agentRunId,
  });

const createRagService = (responses) => {
  let responseIndex = 0;

  return {
    chat: async () => {
      const response = responses[responseIndex++];

      if (response instanceof Error) {
        throw response;
      }

      return response;
    },
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy.pdf",
      },
    ],
  };
};

const runPrimaryDocumentRag = ({ agentBudget, agentRunService, responses }) =>
  runAgentRag({
    accessScope,
    agentBudget,
    agentRunService,
    docIds: ["doc-1"],
    question,
    ragService: createRagService(responses),
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search should not run.");
    },
  });

const getEventTypes = (run) => run.events.map((event) => event.type);

const assertEventOrder = ({ after, before, events }) => {
  assert.ok(events.indexOf(before) < events.indexOf(after));
};

test("primary document RAG persists a completed run step with replayable input and output", async () => {
  const agentRunService = createRunService();
  const answerText = "Remote work requires manager approval. [Source 1]";
  const response = await runPrimaryDocumentRag({
    agentRunService,
    responses: [
      {
        abstained: false,
        citations: [
          {
            docId: "doc-1",
            excerpt: "Remote work requires manager approval.",
            fileName: "policy.pdf",
            pageNumber: 2,
          },
        ],
        memoryApplied: false,
        resolvedQuery: question,
        text: answerText,
      },
    ],
  });

  const run = await getRunForResponse({ agentRunService, response });
  const documentStep = run.steps.find(
    (step) => step.id === "document_rag:primary"
  );
  const eventTypes = run.events.map((event) => event.type);

  assert.equal(response.status, 200);
  assert.equal(run.status, AGENT_RUN_STATUSES.completed);
  assert.equal(documentStep.type, "document_rag");
  assert.equal(documentStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.deepEqual(documentStep.input.docIds, ["doc-1"]);
  assert.equal(documentStep.input.question, question);
  assert.equal(documentStep.output.citationCount, 1);
  assert.match(documentStep.output.text, /Remote work requires manager approval/);
  assert.notEqual(eventTypes.indexOf("step_started"), -1);
  assert.notEqual(eventTypes.indexOf("step_completed"), -1);
  assert.ok(
    eventTypes.indexOf("step_started") < eventTypes.indexOf("step_completed")
  );
});

test("follow-up retrieval persists a deterministic completed run step", async () => {
  const agentRunService = createRunService();
  const response = await runPrimaryDocumentRag({
    agentRunService,
    responses: [
      {
        abstained: false,
        citations: [
          {
            docId: "doc-1",
            excerpt:
              "Remote work requires manager approval before the first remote day.",
            fileName: "policy.pdf",
            pageNumber: 2,
          },
        ],
        memoryApplied: false,
        resolvedQuery: question,
        text:
          "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
      },
      {
        abstained: false,
        citations: [
          {
            docId: "doc-1",
            excerpt:
              "Remote work requires manager approval before the first remote day.",
            fileName: "policy.pdf",
            pageNumber: 2,
          },
        ],
        memoryApplied: false,
        resolvedQuery: question,
        text:
          "Remote work requires manager approval before the first remote day. [Source 1]",
      },
    ],
  });

  const run = await getRunForResponse({ agentRunService, response });
  const followUpStep = run.steps.find(
    (step) => step.id === "follow_up_retrieval:1"
  );

  assert.equal(response.status, 200);
  assert.equal(followUpStep.type, "follow_up_retrieval");
  assert.equal(followUpStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.deepEqual(followUpStep.input.docIds, ["doc-1"]);
  assert.match(followUpStep.input.question, /claim lacks citation support/i);
  assert.equal(followUpStep.output.citationCount, 1);
  assert.match(followUpStep.output.text, /before the first remote day/i);
});

test("primary document RAG persists failed Result steps with serialized error", async () => {
  const agentRunService = createRunService();
  const response = await runPrimaryDocumentRag({
    agentBudget: {
      maxWebSearchCalls: 0,
    },
    agentRunService,
    responses: [new Error("Vector store unavailable.")],
  });

  const run = await getRunForResponse({ agentRunService, response });
  const documentStep = run.steps.find(
    (step) => step.id === "document_rag:primary"
  );
  const eventTypes = getEventTypes(run);

  assert.equal(response.status, 502);
  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.equal(documentStep.type, "document_rag");
  assert.equal(documentStep.status, AGENT_RUN_STEP_STATUSES.failed);
  assert.deepEqual(documentStep.input.docIds, ["doc-1"]);
  assert.equal(documentStep.input.question, question);
  assert.equal(documentStep.error.message, "Vector store unavailable.");
  assert.equal(documentStep.error.name, "Error");
  assertEventOrder({
    after: "step_failed",
    before: "step_started",
    events: eventTypes,
  });
});

test("document loop fails persisted step before rethrowing execution errors", async () => {
  const agentRunService = createRunService();
  const runId = "run-thrown-document-rag";

  await agentRunService.createRun({
    accessScope,
    goal: question,
    runId,
  });

  const stepLifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService,
    runId,
  });
  const executionError = new Error("Observed execution crashed.");

  await assert.rejects(
    runDocumentRagLoop({
      accessScope,
      budgetState: createAgentBudget(),
      docIds: ["doc-1"],
      documentRagSkill: {
        budgetKey: "documentRagCalls",
        id: "document_rag",
        label: "Document RAG",
        version: "1.0.0",
      },
      executeObservedSkill: async () => {
        throw executionError;
      },
      executionLoop: {
        followUpsRun: 0,
        maxFollowUps: 1,
        stoppedReason: null,
      },
      plan: {
        mode: "document",
      },
      question,
      ragService: {},
      retrievalPlan: {
        retrievalQueries: [
          {
            id: "primary",
            query: question,
          },
        ],
      },
      sessionId: "session-1",
      stepLifecycle,
      userId: "alice",
    }),
    /Observed execution crashed/
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });
  const documentStep = run.steps.find(
    (step) => step.id === "document_rag:primary"
  );

  assert.equal(documentStep.status, AGENT_RUN_STEP_STATUSES.failed);
  assert.equal(documentStep.error.message, "Observed execution crashed.");
  assert.deepEqual(getEventTypes(run), [
    "run_created",
    "step_started",
    "step_failed",
  ]);
});
