import assert from "node:assert/strict";
import test from "node:test";

import { runAgentRag } from "../rag/agent.js";
import { createAgentBudget } from "../rag/agent-budget.js";
import { runDocumentRagLoop } from "../rag/agent-document-loop.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import { buildStepReplaySafetyAssessment } from "../rag/agent-run-step-replay-safety.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { AGENT_RUN_STEP_STATUSES } from "../rag/agent-run-steps.js";
import { CAPABILITY_IDS } from "../rag/capabilities/index.js";

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

const getStep = (run, stepId) => run.steps.find((step) => step.id === stepId);

const countSteps = (run, stepId) =>
  run.steps.filter((step) => step.id === stepId).length;

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

test("primary custom skill persists durable input, output, and stable id", async () => {
  const agentRunService = createRunService();
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    docIds: ["doc-1"],
    question: "Run a risk review for the remote work policy.",
    ragService: createRagService([
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
        text: "Risk: approval requirements are explicit. [Source 1]",
      },
    ]),
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search should not run.");
    },
  });

  const run = await getRunForResponse({ agentRunService, response });
  const customStep = getStep(run, "custom_skill:risk_review");

  assert.equal(response.status, 200);
  assert.equal(customStep.type, "custom_skill");
  assert.equal(customStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(customStep.input.skillId, "risk_review");
  assert.deepEqual(customStep.input.docIds, ["doc-1"]);
  assert.equal(customStep.input.question, "Run a risk review for the remote work policy.");
  assert.equal(customStep.output.citationCount, 1);
  assert.equal(countSteps(run, "custom_skill:risk_review"), 1);

  const safety = buildStepReplaySafetyAssessment({
    step: customStep,
  });
  assert.equal(safety.canAutoReplay, true);
});

test("custom skill failed Result persists structured error message", async () => {
  const agentRunService = createRunService();
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    docIds: ["doc-1"],
    question: "Run a risk review for the remote work policy.",
    ragService: createRagService([new Error("Custom review unavailable.")]),
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search should not run.");
    },
  });

  const run = await getRunForResponse({ agentRunService, response });
  const customStep = getStep(run, "custom_skill:risk_review");

  assert.equal(response.status, 200);
  assert.equal(customStep.type, "custom_skill");
  assert.equal(customStep.status, AGENT_RUN_STEP_STATUSES.failed);
  assert.equal(customStep.error.message, "Custom review unavailable.");
  assert.notEqual(customStep.error.message, "[object Object]");
});

test("research brief persists lifecycle-backed research question steps", async () => {
  const agentRunService = createRunService();
  const researchQuestion =
    "Create a research brief about remote work policy.";
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    docIds: ["doc-1"],
    question: researchQuestion,
    ragService: createRagService([
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
        resolvedQuery: "remote work facts",
        text: "Remote work requires manager approval. [Source 1]",
      },
      new Error("Research lookup unavailable."),
      {
        abstained: false,
        citations: [
          {
            docId: "doc-1",
            excerpt: "Policy gaps are reviewed quarterly.",
            fileName: "policy.pdf",
            pageNumber: 4,
          },
        ],
        resolvedQuery: "remote work gaps",
        text: "Policy gaps are reviewed quarterly. [Source 1]",
      },
    ]),
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search should not run.");
    },
  });

  const run = await getRunForResponse({ agentRunService, response });
  const completedStep = getStep(run, "research_question:rq-1");
  const failedStep = getStep(run, "research_question:rq-2");
  const eventTypes = getEventTypes(run);

  assert.equal(response.status, 200);
  assert.equal(completedStep.type, "research_question");
  assert.equal(completedStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.deepEqual(completedStep.input.docIds, ["doc-1"]);
  assert.equal(completedStep.input.researchQuestionId, "rq-1");
  assert.equal(completedStep.input.sessionId, "session-1");
  assert.equal(completedStep.input.skillId, "research_brief");
  assert.equal(completedStep.input.userId, "alice");
  assert.equal(completedStep.output.citationCount, 1);
  assert.equal(completedStep.output.researchQuestionId, "rq-1");
  assert.equal(completedStep.output.resolvedQuery, "remote work facts");
  assert.equal(failedStep.type, "research_question");
  assert.equal(failedStep.status, AGENT_RUN_STEP_STATUSES.failed);
  assert.equal(failedStep.input.researchQuestionId, "rq-2");
  assert.equal(failedStep.error.message, "Research lookup unavailable.");
  assert.equal(countSteps(run, "research_question:rq-1"), 1);
  assert.equal(countSteps(run, "research_question:rq-2"), 1);
  assert.ok(eventTypes.indexOf("step_started") < eventTypes.indexOf("step_completed"));
  assert.ok(eventTypes.indexOf("step_completed") < eventTypes.indexOf("run_completed"));
  assert.ok(eventTypes.indexOf("step_failed") < eventTypes.indexOf("run_completed"));
});

test("approved web search persists a non-auto-replay-safe tool step", async () => {
  const agentRunService = createRunService();
  const webQuestion = "Search the web for the current launch date.";
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    capabilityApprovals: {
      [CAPABILITY_IDS.webSearch]: {
        approved: true,
        decision: "approved",
        source: "test_approval",
      },
    },
    docIds: [],
    question: webQuestion,
    ragService: {
      listDocuments: () => [],
    },
    sessionId: "session-1",
    userId: "alice",
    webChatService: async (askedQuestion) => {
      assert.equal(askedQuestion, webQuestion);

      return {
        citations: [
          {
            title: "Launch note",
            url: "https://example.test/launch",
          },
        ],
        text: "The launch date is current as of today.",
      };
    },
  });

  const run = await getRunForResponse({ agentRunService, response });
  const webStep = getStep(run, "web_search:primary");
  const safety = buildStepReplaySafetyAssessment({
    step: webStep,
  });

  assert.equal(response.status, 200);
  assert.equal(webStep.type, "web_search");
  assert.equal(webStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(webStep.input.question, webQuestion);
  assert.equal(webStep.output.citationCount, 1);
  assert.equal(countSteps(run, "web_search:primary"), 1);
  assert.equal(safety.canAutoReplay, false);
  assert.ok(safety.reasonCodes.includes("requires_approval"));
});

test("web search failed Result persists structured error message", async () => {
  const agentRunService = createRunService();
  const webQuestion = "Search the web for the current launch date.";
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    capabilityApprovals: {
      [CAPABILITY_IDS.webSearch]: {
        approved: true,
        decision: "approved",
        source: "test_approval",
      },
    },
    docIds: [],
    question: webQuestion,
    ragService: {
      listDocuments: () => [],
    },
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Search provider unavailable.");
    },
  });

  const run = await getRunForResponse({ agentRunService, response });
  const webStep = getStep(run, "web_search:primary");

  assert.equal(response.status, 502);
  assert.equal(webStep.type, "web_search");
  assert.equal(webStep.status, AGENT_RUN_STEP_STATUSES.failed);
  assert.equal(webStep.error.message, "Search provider unavailable.");
  assert.notEqual(webStep.error.message, "[object Object]");
});

test("inventory persists workspace scope and stable step id", async () => {
  const agentRunService = createRunService();
  const inventoryQuestion = "What documents are in my workspace?";
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    docIds: [],
    question: inventoryQuestion,
    ragService: createRagService([]),
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search should not run.");
    },
  });

  const run = await getRunForResponse({ agentRunService, response });
  const inventoryStep = getStep(run, "inventory:primary");

  assert.equal(response.status, 200);
  assert.equal(inventoryStep.type, "inventory");
  assert.equal(inventoryStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.deepEqual(inventoryStep.input, {
    scope: "workspace",
  });
  assert.equal(inventoryStep.output.documentCount, 1);
  assert.equal(countSteps(run, "inventory:primary"), 1);
});

test("document discovery persists question, docIds, and stable step id", async () => {
  const agentRunService = createRunService();
  const discoveryQuestion = "Which document covers remote work policy?";
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    capabilityApprovals: {
      [CAPABILITY_IDS.documentDiscovery]: {
        approved: true,
        decision: "approved",
        source: "test_approval",
      },
    },
    docIds: [],
    question: discoveryQuestion,
    ragService: {
      listDocuments: () => [
        {
          docId: "doc-1",
          fileName: "policy.pdf",
          profile: {
            entities: [],
            summary: "Remote work policy and approval requirements.",
            tags: ["remote work", "policy"],
          },
        },
      ],
    },
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search should not run.");
    },
  });

  const run = await getRunForResponse({ agentRunService, response });
  const discoveryStep = getStep(run, "document_discovery:primary");

  assert.equal(response.status, 200);
  assert.equal(discoveryStep.type, "document_discovery");
  assert.equal(discoveryStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.deepEqual(discoveryStep.input.docIds, []);
  assert.equal(discoveryStep.input.question, discoveryQuestion);
  assert.equal(discoveryStep.output.matchCount, 1);
  assert.equal(countSteps(run, "document_discovery:primary"), 1);
});

test("approved arxiv import persists sanitized topic and stable step id", async () => {
  const agentRunService = createRunService();
  const imports = [];
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    arxivImportService: {
      importTopic: async ({ accessScope: scopedAccess, maxResults, topic }) => {
        imports.push({
          accessScope: scopedAccess,
          maxResults,
          topic,
        });

        return {
          failedCount: 0,
          failedPapers: [],
          foundCount: 1,
          importedCount: 1,
          importedPapers: [
            {
              absUrl: "https://arxiv.org/abs/2401.00001v1",
              arxivId: "2401.00001v1",
              docId: "doc-arxiv",
              fileName: "arxiv-2401.00001.pdf",
              status: "imported",
              title: "Retrieval Augmented Generation for Archives",
            },
          ],
          requestedMaxResults: maxResults,
          skippedCount: 0,
          skippedPapers: [],
          topic,
        };
      },
    },
    capabilityApprovals: {
      [CAPABILITY_IDS.arxivImportTopic]: {
        approved: true,
        decision: "approved",
        source: "test_approval",
      },
    },
    docIds: [],
    question: "Import arXiv papers about retrieval augmented generation",
    ragService: {
      listDocuments: () => [],
    },
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search should not run.");
    },
  });

  const run = await getRunForResponse({ agentRunService, response });
  const arxivStep = getStep(run, "arxiv_import:primary");
  const safety = buildStepReplaySafetyAssessment({
    step: arxivStep,
  });

  assert.equal(response.status, 200);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].topic, "retrieval augmented generation");
  assert.equal(arxivStep.type, "arxiv_import");
  assert.equal(arxivStep.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(arxivStep.input.topic, "retrieval augmented generation");
  assert.equal(arxivStep.input.maxResults, imports[0].maxResults);
  assert.equal(arxivStep.output.importedCount, 1);
  assert.equal(countSteps(run, "arxiv_import:primary"), 1);
  assert.equal(safety.canAutoReplay, false);
  assert.ok(safety.reasonCodes.includes("external_write"));
});
