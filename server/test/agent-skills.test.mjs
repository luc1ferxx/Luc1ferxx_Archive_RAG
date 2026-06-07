import test from "node:test";
import assert from "node:assert/strict";
import { runAgentRag } from "../rag/agent.js";
import {
  AGENT_SKILL_IDS,
  createBuiltInSkillRegistry,
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

  const corpus = buildFeedbackCorpusFromRecords([feedback]);
  assert.deepEqual(corpus.cases[0].metadata.feedback.skills, feedback.skills);
});
