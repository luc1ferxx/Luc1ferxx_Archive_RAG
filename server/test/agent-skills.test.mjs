import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgentRag } from "../rag/agent.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  CAPABILITY_IDS,
  createCapabilityRegistry,
} from "../rag/capabilities/index.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
  createBuiltInSkillRegistry,
  createDefaultSkillRegistry,
  validateSkillContract,
} from "../rag/skills/registry.js";
import { buildFeedbackRecord } from "../feedback.js";
import { buildFeedbackCorpusFromRecords } from "../evaluation/feedback-corpus.js";
import {
  configureRagDataDirectory,
  getRagDataDirectory,
} from "../rag/storage.js";

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

test("built-in skill registry selects arxiv import for topic fetches", () => {
  const registry = createBuiltInSkillRegistry();
  const selectedSkills = registry.select({
    plan: {
      wantsArxivImport: true,
      wantsDocumentRag: false,
      wantsWeb: false,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
    },
    docIds: [],
  });

  assert.deepEqual(
    selectedSkills.map((skill) => skill.id),
    [AGENT_SKILL_IDS.arxivImport]
  );
  assert.equal(selectedSkills[0].budgetKey, "arxivPaperFetches");
  assert.equal(selectedSkills[0].requiresAccessScope, true);
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
  assert.equal(
    defaultRegistry.get(CUSTOM_SKILL_IDS.riskReview).version,
    "1.0.0"
  );
  assert.equal(
    defaultRegistry.get(CUSTOM_SKILL_IDS.summarizeContract).version,
    "1.0.0"
  );
  assert.equal(
    defaultRegistry.get(CUSTOM_SKILL_IDS.compareDocuments).version,
    "1.0.0"
  );
  assert.deepEqual(
    defaultRegistry.select({
      plan: {
        wantsTimeline: true,
        wantsRiskReview: false,
        wantsContractSummary: false,
        wantsCompareDocuments: false,
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
  assert.deepEqual(
    defaultRegistry.select({
      plan: {
        wantsTimeline: false,
        wantsRiskReview: true,
        wantsContractSummary: false,
        wantsCompareDocuments: false,
        wantsDocumentRag: false,
        wantsWeb: false,
        wantsResearch: false,
        wantsInventory: false,
        wantsDiscovery: false,
      },
      docIds: ["doc-1"],
    }).map((skill) => skill.id),
    [CUSTOM_SKILL_IDS.riskReview]
  );
  assert.deepEqual(
    defaultRegistry.select({
      plan: {
        wantsTimeline: false,
        wantsRiskReview: false,
        wantsContractSummary: true,
        wantsCompareDocuments: false,
        wantsDocumentRag: false,
        wantsWeb: false,
        wantsResearch: false,
        wantsInventory: false,
        wantsDiscovery: false,
      },
      docIds: ["doc-1"],
    }).map((skill) => skill.id),
    [CUSTOM_SKILL_IDS.summarizeContract]
  );
  assert.deepEqual(
    defaultRegistry.select({
      plan: {
        wantsTimeline: false,
        wantsRiskReview: false,
        wantsContractSummary: false,
        wantsCompareDocuments: true,
        wantsDocumentRag: false,
        wantsWeb: false,
        wantsResearch: false,
        wantsInventory: false,
        wantsDiscovery: false,
      },
      docIds: ["doc-1", "doc-2"],
    }).map((skill) => skill.id),
    [CUSTOM_SKILL_IDS.compareDocuments]
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
  assert.equal(
    response.body.agentObservability.executionPlanner.selectedPlannerId,
    "deterministic"
  );
  assert.equal(response.body.agentObservability.executionPlanner.status, "selected");
  assert.equal(response.body.agentObservability.executionPlanner.fallback, false);
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

test("agent rag pauses arxiv import behind a capability approval gate", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const imports = [];
  const response = await runAgentRag({
    accessScope,
    arxivImportService: {
      importTopic: async () => {
        imports.push("called");

        return {};
      },
    },
    docIds: [],
    question: "帮我从 arXiv 抓取 2 篇关于 retrieval augmented generation 的论文",
    ragService: {
      listDocuments: () => [],
    },
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => ({
      text: "web should not run",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(imports.length, 0);
  assert.equal(response.body.agentMode, "clarification");
  assert.equal(response.body.clarification.reason, "capability_approval_required");
  assert.equal(
    response.body.approvalGates[0].capabilityId,
    CAPABILITY_IDS.arxivImportTopic
  );
  assert.deepEqual(response.body.approvalGates[0].inputPreview, {
    maxResults: 2,
    topic: "retrieval augmented generation",
  });
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "capability_approval_gate"]
  );
});

test("agent rag imports arxiv papers after approved capability boundary", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const imports = [];
  const response = await runAgentRag({
    accessScope,
    arxivImportService: {
      importTopic: async ({ accessScope: receivedScope, maxResults, topic }) => {
        imports.push({
          accessScope: receivedScope,
          maxResults,
          topic,
        });

        return {
          topic,
          requestedMaxResults: maxResults,
          foundCount: 1,
          importedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          importedPapers: [
            {
              arxivId: "2401.00001v1",
              title: "Retrieval Augmented Generation for Archives",
              absUrl: "https://arxiv.org/abs/2401.00001v1",
              pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
              docId: "doc-arxiv",
              fileName: "arxiv-2401.00001.pdf",
              status: "imported",
            },
          ],
          skippedPapers: [],
          failedPapers: [],
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
    question: "帮我从 arXiv 抓取 2 篇关于 retrieval augmented generation 的论文",
    ragService: {
      listDocuments: () => [],
    },
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => ({
      text: "web should not run",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "arxiv_import");
  assert.match(response.body.agentAnswer, /已从 arXiv 搜索主题/);
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].accessScope, accessScope);
  assert.equal(imports[0].maxResults, 2);
  assert.equal(imports[0].topic, "retrieval augmented generation");
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "arxiv_import", "synthesis"]
  );

  const observation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === AGENT_SKILL_IDS.arxivImport
  );

  assert.equal(observation.status, "completed");
  assert.equal(observation.budgetKey, "arxivPaperFetches");
  assert.equal(observation.budgetUsed, 1);
  assert.equal(observation.budgetLimit, 1);
});

test("agent rag pauses on capability approval gates without executing the capability", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-14T00:00:00.000Z",
    }),
  });
  let webExecuted = false;
  const capabilityRegistry = createCapabilityRegistry([
    {
      id: CAPABILITY_IDS.webSearch,
      version: "1.0.0",
      label: "Web Search",
      inputSchema: {
        type: "object",
        required: ["question"],
        properties: {
          question: {
            type: "string",
          },
        },
      },
      accessScope: {
        required: false,
      },
      approvalPolicy: {
        mode: "user_confirmation",
        writesWorkspace: false,
        userConfirmationRequired: true,
      },
      privacyPolicy: {
        externalCall: true,
        sanitizedInputFields: ["question"],
        storesResult: false,
      },
      execute: async () => {
        webExecuted = true;

        return {
          text: "web should not execute",
        };
      },
    },
  ]);
  const response = await runAgentRag({
    accessScope,
    agentRunService,
    capabilityRegistry,
    docIds: [],
    question: "Search the web for the current launch date",
    ragService: {
      listDocuments: () => [],
    },
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      webExecuted = true;

      return {
        text: "web should not execute",
      };
    },
  });

  assert.equal(response.status, 200);
  assert.equal(webExecuted, false);
  assert.equal(response.body.agentMode, "clarification");
  assert.equal(response.body.clarification.needed, true);
  assert.equal(response.body.clarification.reason, "capability_approval_required");
  assert.equal(response.body.approvalGates.length, 1);
  assert.equal(response.body.approvalGates[0].capabilityId, CAPABILITY_IDS.webSearch);
  assert.deepEqual(response.body.approvalGates[0].inputPreview, {
    question: "Search the web for the current launch date",
  });
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "capability_approval_gate"]
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId: response.body.agentRunId,
  });

  assert.equal(run.status, AGENT_RUN_STATUSES.waitingForUser);
  assert.equal(run.approvalGates.length, 1);
  assert.deepEqual(
    run.events.map((event) => event.type),
    [
      "run_created",
      "run_prepared",
      "execution_planned",
      "approval_gate_created",
      "run_completed",
    ]
  );
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

test("agent rag writes per-skill observability events when enabled", async () => {
  const originalDataDirectory = getRagDataDirectory();
  const originalObservabilityEnabled = process.env.RAG_OBSERVABILITY_ENABLED;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-observability-"));

  process.env.RAG_OBSERVABILITY_ENABLED = "true";
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));

  try {
    const ragService = {
      chat: async () => ({
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
      }),
      listDocuments: () => [
        {
          docId: "doc-1",
          fileName: "policy.pdf",
        },
      ],
    };

    await runAgentRag({
      ragService,
      webChatService: async () => ({
        text: "web should not run",
      }),
      question: "What does remote work require?",
      docIds: ["doc-1"],
      sessionId: "session-1",
      userId: "alice",
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
    });

    const eventsPath = path.join(tempRoot, "rag-observability", "events.jsonl");
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(events.length, 1);
    assert.equal(events[0].traceType, "agent");
    assert.equal(events[0].agentObservability.skills[0].skillId, AGENT_SKILL_IDS.documentRag);
    assert.equal(events[0].agentRetrievalPlan.intent, "fact");
    assert.ok(
      events[0].agentTraceSummary.some((step) => step.type === "query_planner")
    );
  } finally {
    if (originalObservabilityEnabled === undefined) {
      delete process.env.RAG_OBSERVABILITY_ENABLED;
    } else {
      process.env.RAG_OBSERVABILITY_ENABLED = originalObservabilityEnabled;
    }

    configureRagDataDirectory(originalDataDirectory);
    await rm(tempRoot, {
      recursive: true,
      force: true,
    });
  }
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

test("agent rag executes whitelisted custom risk review skill with access scope", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let listAccessScope = null;
  let chatAccessScope = null;
  let riskRetrievalPlan = null;
  let receivedQuestion = null;
  let receivedDocIds = null;
  const ragService = {
    chat: async (docIds, question, options) => {
      receivedDocIds = docIds;
      receivedQuestion = question;
      chatAccessScope = options.accessScope;
      riskRetrievalPlan = options.retrievalPlan;

      return {
        text: [
          "Risk Review",
          "- Risk: Refund approval is required before issuing payment. [Source 1]",
          "- Gap: Regional exceptions are not specified. [Source 1]",
        ].join("\n"),
        citations: [
          {
            docId: "doc-1",
            fileName: "refund-policy.pdf",
            pageNumber: 4,
            excerpt: "Refund approval is required before issuing payment. Regional exceptions are not specified.",
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
          fileName: "refund-policy.pdf",
        },
      ];
    },
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Review the selected policy for risks, gaps, and exceptions.",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, CUSTOM_SKILL_IDS.riskReview);
  assert.match(response.body.agentAnswer, /Risk Review/);
  assert.equal(response.body.ragAnswer, response.body.agentAnswer);
  assert.equal(response.body.ragSources.length, 1);
  assert.deepEqual(receivedDocIds, ["doc-1"]);
  assert.deepEqual(listAccessScope, accessScope);
  assert.deepEqual(chatAccessScope, accessScope);
  assert.match(receivedQuestion, /risk review/i);
  assert.match(receivedQuestion, /gaps/i);
  assert.equal(riskRetrievalPlan.intent, "analysis");
  assert.equal(riskRetrievalPlan.retrievalOptions.topK, 10);
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "query_planner", "custom_skill", "synthesis", "answer_finalizer"]
  );
  assert.deepEqual(response.body.agentSkills, [
    {
      skillId: CUSTOM_SKILL_IDS.riskReview,
      skillVersion: "1.0.0",
      label: "Risk Review",
      status: "completed",
    },
  ]);

  const riskObservation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === CUSTOM_SKILL_IDS.riskReview
  );
  assert.equal(riskObservation.selected, true);
  assert.equal(riskObservation.status, "completed");
  assert.equal(riskObservation.attempts, 1);
  assert.equal(riskObservation.budgetKey, "customSkillCalls");
  assert.equal(riskObservation.budgetUsed, 1);
  assert.equal(riskObservation.budgetLimit, 2);
  assert.equal(riskObservation.citationCount, 1);

  const customStep = response.body.agentTrace.find(
    (step) => step.type === "custom_skill"
  );
  assert.equal(customStep.detail.skillId, CUSTOM_SKILL_IDS.riskReview);
  assert.equal(customStep.detail.riskQuestion, receivedQuestion);
});

test("agent rag executes whitelisted custom contract summary skill with access scope", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let listAccessScope = null;
  let chatAccessScope = null;
  let summaryRetrievalPlan = null;
  let receivedQuestion = null;
  let receivedDocIds = null;
  const ragService = {
    chat: async (docIds, question, options) => {
      receivedDocIds = docIds;
      receivedQuestion = question;
      chatAccessScope = options.accessScope;
      summaryRetrievalPlan = options.retrievalPlan;

      return {
        text: [
          "Contract Summary",
          "- Parties: Acme Corp and Beta LLC are parties to the services agreement. [Source 1]",
          "- Key Terms: The agreement renews every 12 months unless either party gives 30 days notice. [Source 1]",
          "- Obligations: Beta LLC must provide monthly support reports. [Source 1]",
        ].join("\n"),
        citations: [
          {
            docId: "doc-1",
            fileName: "services-agreement.pdf",
            pageNumber: 1,
            excerpt: "Acme Corp and Beta LLC are parties to the services agreement. The agreement renews every 12 months unless either party gives 30 days notice. Beta LLC must provide monthly support reports.",
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
          fileName: "services-agreement.pdf",
        },
      ];
    },
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Summarize this contract with key terms and obligations.",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, CUSTOM_SKILL_IDS.summarizeContract);
  assert.match(response.body.agentAnswer, /Contract Summary/);
  assert.equal(response.body.ragAnswer, response.body.agentAnswer);
  assert.equal(response.body.ragSources.length, 1);
  assert.deepEqual(receivedDocIds, ["doc-1"]);
  assert.deepEqual(listAccessScope, accessScope);
  assert.deepEqual(chatAccessScope, accessScope);
  assert.match(receivedQuestion, /contract summary/i);
  assert.match(receivedQuestion, /key terms/i);
  assert.equal(summaryRetrievalPlan.intent, "analysis");
  assert.equal(summaryRetrievalPlan.retrievalOptions.topK, 10);
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "query_planner", "custom_skill", "synthesis", "answer_finalizer"]
  );
  assert.deepEqual(response.body.agentSkills, [
    {
      skillId: CUSTOM_SKILL_IDS.summarizeContract,
      skillVersion: "1.0.0",
      label: "Summarize Contract",
      status: "completed",
    },
  ]);

  const summaryObservation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === CUSTOM_SKILL_IDS.summarizeContract
  );
  assert.equal(summaryObservation.selected, true);
  assert.equal(summaryObservation.status, "completed");
  assert.equal(summaryObservation.attempts, 1);
  assert.equal(summaryObservation.budgetKey, "customSkillCalls");
  assert.equal(summaryObservation.budgetUsed, 1);
  assert.equal(summaryObservation.budgetLimit, 2);
  assert.equal(summaryObservation.citationCount, 1);

  const customStep = response.body.agentTrace.find(
    (step) => step.type === "custom_skill"
  );
  assert.equal(customStep.detail.skillId, CUSTOM_SKILL_IDS.summarizeContract);
  assert.equal(customStep.detail.summaryQuestion, receivedQuestion);
});

test("agent rag chains contract summary into risk review", async () => {
  const receivedQuestions = [];
  const ragService = {
    chat: async (_docIds, question) => {
      receivedQuestions.push(question);

      if (/risk review/i.test(question)) {
        return {
          text: "Risk Review\n- Risk: Early termination requires 60 days notice. [Source 1]",
          citations: [
            {
              docId: "doc-1",
              fileName: "contract.pdf",
              pageNumber: 2,
              excerpt: "Risk: Early termination requires 60 days notice.",
            },
          ],
          abstained: false,
          resolvedQuery: question,
          memoryApplied: false,
        };
      }

      return {
        text: "Contract Summary\n- Acme contract renews every 12 months. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "contract.pdf",
            pageNumber: 1,
            excerpt: "Acme contract renews every 12 months.",
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
        fileName: "contract.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Review this contract for risks and key terms.",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "skill_chain");
  assert.deepEqual(
    response.body.agentObservability.skillChain.map((skill) => skill.skillId),
    [CUSTOM_SKILL_IDS.summarizeContract, CUSTOM_SKILL_IDS.riskReview]
  );
  assert.match(receivedQuestions[0], /contract summary/i);
  assert.match(receivedQuestions[1], /risk review/i);
  assert.match(receivedQuestions[1], /Previous skill outputs/i);
  assert.match(receivedQuestions[1], /Acme contract renews/i);
  assert.match(response.body.agentAnswer, /Acme contract renews/i);
  assert.match(response.body.agentAnswer, /Early termination requires 60 days/i);
  assert.equal(response.body.ragSources.length, 2);
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    [
      "plan",
      "query_planner",
      "skill_chain",
      "custom_skill",
      "custom_skill",
      "synthesis",
      "answer_finalizer",
    ]
  );
  assert.deepEqual(
    response.body.agentSkills.map((skill) => skill.skillId),
    [CUSTOM_SKILL_IDS.summarizeContract, CUSTOM_SKILL_IDS.riskReview]
  );
});

test("agent rag chains document comparison into risk review", async () => {
  const receivedQuestions = [];
  const ragService = {
    chat: async (_docIds, question) => {
      receivedQuestions.push(question);

      if (/risk review/i.test(question)) {
        return {
          text: "Risk Review\n- Risk: Remote-day limits differ between the policies. [Source 1] [Source 2]",
          citations: [
            {
              docId: "doc-1",
              fileName: "policy-a.pdf",
              pageNumber: 1,
              excerpt: "Risk: Remote-day limits differ between the policies. Policy A allows 2 remote days.",
            },
            {
              docId: "doc-2",
              fileName: "policy-b.pdf",
              pageNumber: 1,
              excerpt: "Risk: Remote-day limits differ between the policies. Policy B allows 3 remote days.",
            },
          ],
          abstained: false,
          resolvedQuery: question,
          memoryApplied: false,
        };
      }

      return {
        text: "Document Comparison\n- Policy A allows 2 remote days and Policy B allows 3 remote days. [Source 1] [Source 2]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy-a.pdf",
            pageNumber: 1,
            excerpt: "Policy A allows 2 remote days.",
          },
          {
            docId: "doc-2",
            fileName: "policy-b.pdf",
            pageNumber: 1,
            excerpt: "Policy B allows 3 remote days.",
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
        fileName: "policy-a.pdf",
      },
      {
        docId: "doc-2",
        fileName: "policy-b.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Compare these contracts for risk differences.",
    docIds: ["doc-1", "doc-2"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "skill_chain");
  assert.deepEqual(
    response.body.agentObservability.skillChain.map((skill) => skill.skillId),
    [CUSTOM_SKILL_IDS.compareDocuments, CUSTOM_SKILL_IDS.riskReview]
  );
  assert.match(receivedQuestions[0], /document comparison/i);
  assert.match(receivedQuestions[1], /risk review/i);
  assert.match(receivedQuestions[1], /Previous skill outputs/i);
  assert.match(receivedQuestions[1], /Policy A allows 2 remote days/i);
  assert.match(response.body.agentAnswer, /Remote-day limits differ/i);
});

test("agent rag chains timeline extraction into document comparison for project changes", async () => {
  const receivedQuestions = [];
  const ragService = {
    chat: async (_docIds, question) => {
      receivedQuestions.push(question);

      if (/chronological timeline/i.test(question)) {
        return {
          text: "- 2024-01-01: Project Alpha started. [Source 1]\n- 2024-02-01: Project Alpha scope changed. [Source 2]",
          citations: [
            {
              docId: "doc-1",
              fileName: "jan.pdf",
              pageNumber: 1,
              excerpt: "Project Alpha started on 2024-01-01.",
            },
            {
              docId: "doc-2",
              fileName: "feb.pdf",
              pageNumber: 1,
              excerpt: "Project Alpha scope changed on 2024-02-01.",
            },
          ],
          abstained: false,
          resolvedQuery: question,
          memoryApplied: false,
        };
      }

      return {
        text: "Document Comparison\n- Difference: Project Alpha changed scope after the January start. [Source 1] [Source 2]",
        citations: [
          {
            docId: "doc-1",
            fileName: "jan.pdf",
            pageNumber: 1,
            excerpt: "Project Alpha started on 2024-01-01.",
          },
          {
            docId: "doc-2",
            fileName: "feb.pdf",
            pageNumber: 1,
            excerpt: "Difference: Project Alpha changed scope after the January start on 2024-02-01.",
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
        fileName: "jan.pdf",
      },
      {
        docId: "doc-2",
        fileName: "feb.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Organize project changes across these documents.",
    docIds: ["doc-1", "doc-2"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "skill_chain");
  assert.deepEqual(
    response.body.agentObservability.skillChain.map((skill) => skill.skillId),
    [CUSTOM_SKILL_IDS.extractTimeline, CUSTOM_SKILL_IDS.compareDocuments]
  );
  assert.match(receivedQuestions[0], /chronological timeline/i);
  assert.match(receivedQuestions[1], /document comparison/i);
  assert.match(receivedQuestions[1], /Previous skill outputs/i);
  assert.match(receivedQuestions[1], /Project Alpha started/i);
  assert.match(response.body.agentAnswer, /Project Alpha changed scope/i);
});

test("agent rag asks for clarification when comparison has fewer than two documents", async () => {
  const ragService = {
    chat: async () => {
      throw new Error("Comparison skill should not run without two documents.");
    },
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy-2024.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Compare this policy with the other policy.",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "clarification");
  assert.equal(
    response.body.clarification.reason,
    "comparison_requires_multiple_documents"
  );
  assert.match(response.body.agentAnswer, /Which two or more documents/i);
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "clarification_gate"]
  );
  assert.deepEqual(response.body.agentSkills, []);
  assert.equal(
    response.body.agentObservability.selectedSkills[0].skillId,
    CUSTOM_SKILL_IDS.compareDocuments
  );
  assert.equal(
    response.body.agentObservability.skills.find(
      (skill) => skill.skillId === CUSTOM_SKILL_IDS.compareDocuments
    ).status,
    "not_run"
  );
});

test("agent rag asks for clarification when too many documents are selected", async () => {
  const docIds = Array.from({ length: 13 }, (_value, index) => `doc-${index + 1}`);
  const ragService = {
    chat: async () => {
      throw new Error("Document RAG should not run before narrowing many documents.");
    },
    listDocuments: () =>
      docIds.map((docId) => ({
        docId,
        fileName: `${docId}.pdf`,
      })),
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Analyze these documents for policy obligations.",
    docIds,
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "clarification");
  assert.equal(response.body.clarification.reason, "too_many_documents");
  assert.match(response.body.agentAnswer, /13 documents/i);
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "clarification_gate"]
  );
});

test("agent rag executes whitelisted custom compare documents skill with access scope", async () => {
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let listAccessScope = null;
  let chatAccessScope = null;
  let compareRetrievalPlan = null;
  let receivedQuestion = null;
  let receivedDocIds = null;
  const ragService = {
    chat: async (docIds, question, options) => {
      receivedDocIds = docIds;
      receivedQuestion = question;
      chatAccessScope = options.accessScope;
      compareRetrievalPlan = options.retrievalPlan;

      return {
        text: [
          "Document Comparison",
          "Common Ground",
          "- Both policies require manager approval for remote work. [Source 1] [Source 2]",
          "Differences",
          "- Policy 2024 allows 2 remote days per week, while Policy 2025 allows 3 remote days per week. [Source 1] [Source 2]",
          "Conflicts",
          "- No direct conflict is specified in the selected documents. [Source 1] [Source 2]",
        ].join("\n"),
        citations: [
          {
            docId: "doc-1",
            fileName: "policy-2024.pdf",
            pageNumber: 1,
            excerpt: "Policy 2024 requires manager approval for remote work and allows 2 remote days per week. No direct conflict is specified.",
          },
          {
            docId: "doc-2",
            fileName: "policy-2025.pdf",
            pageNumber: 1,
            excerpt: "Policy 2025 requires manager approval for remote work and allows 3 remote days per week. No direct conflict is specified.",
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
          fileName: "policy-2024.pdf",
        },
        {
          docId: "doc-2",
          fileName: "policy-2025.pdf",
        },
      ];
    },
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => ({
      text: "web should not run",
    }),
    question: "Compare the selected policies for common ground, differences, conflicts, and missing terms.",
    docIds: ["doc-1", "doc-2"],
    sessionId: "session-1",
    userId: "alice",
    accessScope,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, CUSTOM_SKILL_IDS.compareDocuments);
  assert.match(response.body.agentAnswer, /Document Comparison/);
  assert.match(response.body.agentAnswer, /Common Ground/);
  assert.match(response.body.agentAnswer, /Differences/);
  assert.equal(response.body.ragAnswer, response.body.agentAnswer);
  assert.equal(response.body.ragSources.length, 2);
  assert.deepEqual(receivedDocIds, ["doc-1", "doc-2"]);
  assert.deepEqual(listAccessScope, accessScope);
  assert.deepEqual(chatAccessScope, accessScope);
  assert.match(receivedQuestion, /document comparison/i);
  assert.match(receivedQuestion, /missing terms/i);
  assert.equal(compareRetrievalPlan.intent, "comparison");
  assert.equal(compareRetrievalPlan.retrievalOptions.topK, 8);
  assert.deepEqual(
    response.body.agentTrace.map((step) => step.type),
    ["plan", "query_planner", "custom_skill", "synthesis", "answer_finalizer"]
  );
  assert.deepEqual(response.body.agentSkills, [
    {
      skillId: CUSTOM_SKILL_IDS.compareDocuments,
      skillVersion: "1.0.0",
      label: "Compare Documents",
      status: "completed",
    },
  ]);

  const compareObservation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === CUSTOM_SKILL_IDS.compareDocuments
  );
  assert.equal(compareObservation.selected, true);
  assert.equal(compareObservation.status, "completed");
  assert.equal(compareObservation.attempts, 1);
  assert.equal(compareObservation.budgetKey, "customSkillCalls");
  assert.equal(compareObservation.budgetUsed, 1);
  assert.equal(compareObservation.budgetLimit, 2);
  assert.equal(compareObservation.citationCount, 2);

  const customStep = response.body.agentTrace.find(
    (step) => step.type === "custom_skill"
  );
  assert.equal(customStep.detail.skillId, CUSTOM_SKILL_IDS.compareDocuments);
  assert.equal(customStep.detail.compareQuestion, receivedQuestion);
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
          skillChain: [],
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
          workingMemory: {
            version: "1.0",
            goal: "What does remote work require?",
            docIds: ["doc-1"],
            checkedQueries: [
              {
                skillId: AGENT_SKILL_IDS.documentRag,
                skillVersion: "1.0.0",
                phase: "primary",
                queryId: "primary",
                label: "Original request",
                query: "What does remote work require?",
                primary: true,
              },
            ],
            supportedClaims: [
              {
                skillId: AGENT_SKILL_IDS.documentRag,
                skillVersion: "1.0.0",
                phase: "primary",
                text: "Remote work requires manager approval",
                tokenOverlap: 0.8,
                anchors: [],
                missingAnchors: [],
              },
            ],
            unsupportedClaims: [],
            unresolvedGaps: [],
            resolvedGaps: [],
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
  assert.deepEqual(feedback.agentObservability.skillChain, []);
  assert.equal(feedback.agentObservability.skills[0].citationCount, 1);
  assert.equal(feedback.agentObservability.skills[0].budgetDelta.documentRagCalls, 1);
  assert.equal(
    feedback.agentObservability.workingMemory.checkedQueries[0].query,
    "What does remote work require?"
  );

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
  assert.deepEqual(
    corpus.cases[0].metadata.feedback.agentObservability.skillChain,
    []
  );
  assert.equal(
    corpus.cases[0].metadata.feedback.agentObservability.workingMemory
      .supportedClaims[0].text,
    "Remote work requires manager approval"
  );
});
