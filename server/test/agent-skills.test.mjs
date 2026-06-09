import test from "node:test";
import assert from "node:assert/strict";
import { runAgentRag } from "../rag/agent.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
  createBuiltInSkillRegistry,
  createDefaultSkillRegistry,
  validateSkillContract,
} from "../rag/skills/registry.js";
import { buildFeedbackRecord } from "../feedback.js";
import { buildFeedbackCorpusFromRecords } from "../evaluation/feedback-corpus.js";

test("built-in skill registry selects document and web skills with stable metadata", () => {
  const registry = createBuiltInSkillRegistry();
  const selectedSkills = registry.select({
    plan: {
      wantsDocumentRag: true,
      wantsWeb: true,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
    },
    docIds: ["doc-1"],
  });

  assert.deepEqual(
    selectedSkills.map((skill) => skill.id),
    [AGENT_SKILL_IDS.documentRag, AGENT_SKILL_IDS.webSearch]
  );
  assert.deepEqual(
    selectedSkills.map((skill) => skill.version),
    ["1.0.0", "1.0.0"]
  );
});

test("default skill registry whitelists custom skills separately from built-ins", () => {
  const builtInRegistry = createBuiltInSkillRegistry();
  const defaultRegistry = createDefaultSkillRegistry();

  assert.equal(
    builtInRegistry.get(CUSTOM_SKILL_IDS.extractTimeline),
    null
  );
  assert.equal(
    defaultRegistry.get(CUSTOM_SKILL_IDS.extractTimeline).version,
    "1.0.0"
  );
  assert.deepEqual(
    defaultRegistry.select({
      plan: {
        wantsTimeline: true,
        wantsDocumentRag: false,
        wantsWeb: false,
        wantsResearch: false,
        wantsInventory: false,
        wantsDiscovery: false,
      },
      docIds: ["doc-1"],
    }).map((skill) => skill.id),
    [CUSTOM_SKILL_IDS.extractTimeline]
  );
});

test("skill contract validation rejects incomplete custom skills", () => {
  assert.throws(
    () =>
      validateSkillContract({
        id: "custom_incomplete",
        version: "1.0.0",
        label: "Incomplete",
      }),
    /missing budgetKey/
  );
});

test("agent rag executes selected skills with access scope and reports skill metadata", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let receivedAccessScope = null;
  const ragService = {
    chat: async (_docIds, _question, options) => {
      receivedAccessScope = options.accessScope;

      return {
        text: "Remote work requires manager approval. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval.",
          },
        ],
        abstained: false,
        resolvedQuery: "What does remote work require?",
        memoryApplied: false,
      };
    },
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "What does remote work require?",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedAccessScope, accessScope);
  assert.deepEqual(response.body.agentSkills, [
    {
      skillId: AGENT_SKILL_IDS.documentRag,
      skillVersion: "1.0.0",
      label: "Document RAG",
      status: "completed",
    },
  ]);

  const documentStep = response.body.agentTrace.find(
    (step) => step.type === "document_rag"
  );
  assert.equal(documentStep.detail.skillId, AGENT_SKILL_IDS.documentRag);
  assert.equal(documentStep.detail.skillVersion, "1.0.0");
  assert.ok(documentStep.detail.durationMs >= 0);

  const documentObservation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === AGENT_SKILL_IDS.documentRag
  );
  assert.equal(response.body.agentObservability.planMode, "document");
  assert.equal(response.body.agentObservability.selectedSkills[0].skillId, AGENT_SKILL_IDS.documentRag);
  assert.equal(documentObservation.selected, true);
  assert.equal(documentObservation.status, "completed");
  assert.equal(documentObservation.attempts, 1);
  assert.equal(documentObservation.retryCount, 0);
  assert.equal(documentObservation.citationCount, 1);
  assert.equal(documentObservation.abstained, false);
  assert.equal(documentObservation.budgetKey, "documentRagCalls");
  assert.equal(documentObservation.budgetUsed, 1);
  assert.equal(documentObservation.budgetLimit, 2);
  assert.equal(response.body.agentObservability.runs[0].phase, "primary");
  assert.equal(response.body.agentObservability.runs[0].citationCount, 1);
});

test("agent rag sends planned retrieval queries and dynamic topK to document rag", async () => {
  const question = "What does remote work approval require?";
  let receivedOptions = null;
  const ragService = {
    chat: async (_docIds, _question, options) => {
      receivedOptions = options;

      return {
        text: "Remote work requires manager approval. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval.",
          },
        ],
        abstained: false,
        resolvedQuery: question,
        memoryApplied: false,
      };
    },
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question,
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(receivedOptions.retrievalPlan.intent, "fact");
  assert.equal(receivedOptions.retrievalPlan.retrievalOptions.topK, 4);
  assert.equal(receivedOptions.retrievalPlan.retrievalOptions.topKPerDoc, 2);
  assert.equal(receivedOptions.retrievalPlan.retrievalQueries[0].query, question);
  assert.notEqual(receivedOptions.retrievalPlan.retrievalQueries[1].query, question);
  assert.match(
    receivedOptions.retrievalPlan.retrievalQueries[1].query,
    /exact cited evidence/i
  );

  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    [
      "plan",
      "query_planner",
      "document_rag",
      "self_check",
      "synthesis",
      "answer_finalizer",
    ]
  );
  const plannerStep = response.body.agentTrace.find(
    (step) => step.type === "query_planner"
  );
  assert.equal(plannerStep.detail.intent, "fact");
  assert.equal(plannerStep.detail.retrievalQueries.length, 2);
  assert.equal(plannerStep.detail.retrievalOptions.topK, 4);

  const documentStep = response.body.agentTrace.find(
    (step) => step.type === "document_rag"
  );
  assert.equal(documentStep.detail.retrievalPlan.intent, "fact");
});

test("agent rag executes whitelisted custom timeline skill with access scope", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let listAccessScope = null;
  let chatAccessScope = null;
  let timelineRetrievalPlan = null;
  let receivedQuestion = null;
  let receivedDocIds = null;
  const ragService = {
    chat: async (docIds, question, options) => {
      receivedDocIds = docIds;
      receivedQuestion = question;
      chatAccessScope = options.accessScope;
      timelineRetrievalPlan = options.retrievalPlan;

      return {
        text: "- 2024-01-10: Contract signed. [Source 1]\n- 2024-02-01: Renewal window opened. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "contract.pdf",
            pageNumber: 2,
            excerpt: "Contract signed on 2024-01-10. Renewal window opened on 2024-02-01.",
          },
        ],
        abstained: false,
        resolvedQuery: question,
        memoryApplied: false,
      };
    },
    listDocuments: (scope) => {
      listAccessScope = scope;

      return [
        {
          docId: "doc-1",
          fileName: "contract.pdf",
        },
        {
          docId: "other-workspace-doc",
          fileName: "other.pdf",
        },
      ];
    },
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Extract a timeline of the contract events.",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, CUSTOM_SKILL_IDS.extractTimeline);
  assert.match(response.body.agentAnswer, /Contract signed/);
  assert.equal(response.body.ragAnswer, response.body.agentAnswer);
  assert.equal(response.body.ragSources.length, 1);
  assert.deepEqual(receivedDocIds, ["doc-1"]);
  assert.deepEqual(listAccessScope, accessScope);
  assert.deepEqual(chatAccessScope, accessScope);
  assert.match(receivedQuestion, /chronological timeline/i);
  assert.equal(timelineRetrievalPlan.intent, "timeline");
  assert.equal(timelineRetrievalPlan.retrievalOptions.topK, 9);
  assert.equal(timelineRetrievalPlan.retrievalQueries.length, 3);
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "query_planner", "custom_skill", "synthesis", "answer_finalizer"]
  );
  assert.equal(
    response.body.agentTrace.find((step) => step.type === "answer_finalizer")
      .detail.claimSupport.unsupportedClaimCount,
    0
  );
  assert.deepEqual(response.body.agentSkills, [
    {
      skillId: CUSTOM_SKILL_IDS.extractTimeline,
      skillVersion: "1.0.0",
      label: "Extract Timeline",
      status: "completed",
    },
  ]);

  const timelineObservation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === CUSTOM_SKILL_IDS.extractTimeline
  );
  assert.equal(timelineObservation.selected, true);
  assert.equal(timelineObservation.status, "completed");
  assert.equal(timelineObservation.attempts, 1);
  assert.equal(timelineObservation.budgetKey, "customSkillCalls");
  assert.equal(timelineObservation.budgetUsed, 1);
  assert.equal(timelineObservation.budgetLimit, 2);
  assert.equal(timelineObservation.citationCount, 1);
  assert.equal(response.body.agentObservability.runs[0].phase, "primary");
  assert.equal(response.body.agentObservability.runs[0].skillId, CUSTOM_SKILL_IDS.extractTimeline);
});

test("feedback records and feedback eval cases retain skill metadata", () => {
  const feedback = buildFeedbackRecord({
    payload: {
      question: "What does remote work require?",
      feedbackType: "citation_error",
      answer: {
        agentAnswer: "Remote work is allowed.",
        agentMode: "document",
        agentSkills: [
          {
            skillId: AGENT_SKILL_IDS.documentRag,
            skillVersion: "1.0.0",
            label: "Document RAG",
            status: "completed",
          },
        ],
        agentObservability: {
          agentMode: "document",
          planMode: "document",
          selectedSkills: [
            {
              skillId: AGENT_SKILL_IDS.documentRag,
              skillVersion: "1.0.0",
              label: "Document RAG",
              status: "completed",
            },
          ],
          skills: [
            {
              skillId: AGENT_SKILL_IDS.documentRag,
              skillVersion: "1.0.0",
              label: "Document RAG",
              budgetKey: "documentRagCalls",
              selected: true,
              status: "completed",
              attempts: 1,
              skippedCount: 0,
              retryCount: 0,
              totalDurationMs: 12.34,
              citationCount: 1,
              lastCitationCount: 1,
              abstained: false,
              errorCount: 0,
              budgetUsed: 1,
              budgetLimit: 2,
              budgetRemaining: 1,
              budgetDelta: {
                documentRagCalls: 1,
              },
            },
          ],
          runs: [
            {
              skillId: AGENT_SKILL_IDS.documentRag,
              skillVersion: "1.0.0",
              label: "Document RAG",
              phase: "primary",
              status: "completed",
              durationMs: 12.34,
              citationCount: 1,
              abstained: false,
              budgetDelta: {},
            },
          ],
          budget: {
            limits: {
              maxDocumentRagCalls: 2,
            },
            used: {
              documentRagCalls: 1,
            },
            traceTruncated: false,
          },
        },
        ragSources: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval.",
          },
        ],
      },
      docIds: ["doc-1"],
    },
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.deepEqual(feedback.skills, [
    {
      skillId: AGENT_SKILL_IDS.documentRag,
      skillVersion: "1.0.0",
      label: "Document RAG",
      status: "completed",
    },
  ]);
  assert.equal(feedback.agentObservability.feedbackType, "citation_error");
  assert.equal(feedback.agentObservability.skills[0].skillId, AGENT_SKILL_IDS.documentRag);
  assert.equal(feedback.agentObservability.skills[0].citationCount, 1);
  assert.equal(feedback.agentObservability.skills[0].budgetDelta.documentRagCalls, 1);

  const corpus = buildFeedbackCorpusFromRecords([feedback]);
  assert.deepEqual(corpus.cases[0].metadata.feedback.skills, feedback.skills);
  assert.equal(
    corpus.cases[0].metadata.feedback.agentObservability.feedbackType,
    "citation_error"
  );
  assert.equal(
    corpus.cases[0].metadata.feedback.agentObservability.skills[0].skillId,
    AGENT_SKILL_IDS.documentRag
  );
});
