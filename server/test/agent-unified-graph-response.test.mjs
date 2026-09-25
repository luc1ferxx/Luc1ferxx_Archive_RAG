import test from "node:test";
import assert from "node:assert/strict";

import { buildUnifiedGraphChatResponse } from "../rag/agent-unified-graph-response.js";
import { AGENT_SKILL_IDS } from "../rag/skills/registry.js";

const entry = ({
  nodeId,
  skillId,
  category = "answer",
  text = "",
  value = {},
  output = { text },
  stepId = `agent_graph_node:${nodeId}`,
}) => ({
  nodeId,
  skillId,
  category,
  status: "completed",
  stepId,
  output,
  result: { ok: true, text, value },
});

const collectedFor = (...entries) => ({
  graphVersion: "v3",
  entries,
  byNodeId: new Map(entries.map((item) => [item.nodeId, item])),
  groups: {},
});

const responseFor = ({ answer, collected, overrides = {} }) =>
  buildUnifiedGraphChatResponse({
    answer,
    collected,
    question: "What changed?",
    trace: [{ type: "skill_graph_planned", summary: "Graph executed" }],
    agentSkills: [{ skillId: AGENT_SKILL_IDS.documentRag }],
    agentObservability: { agentMode: answer.agentMode, budget: { used: 2 } },
    workingMemory: { goal: "What changed?", checkedQueries: ["What changed?"] },
    ...overrides,
  });

test("v3 chat response keeps selected document identity and finalized citations", () => {
  const rejected = entry({
    nodeId: "doc-primary",
    skillId: AGENT_SKILL_IDS.documentRag,
    text: "Unverified claim.",
    value: { resolvedQuery: "First query" },
  });
  const selected = entry({
    nodeId: "doc-followup",
    skillId: AGENT_SKILL_IDS.documentRag,
    text: "Notice is required.",
    value: {
      resolvedQuery: "Find notice term",
      memoryApplied: true,
      evidenceSummary: { admittedCount: 1 },
      gapPlan: { remaining: [] },
    },
  });
  const citation = {
    rank: 1,
    docId: "doc-a",
    fileName: "contract.pdf",
    pageNumber: 7,
    chunkIndex: 3,
    excerpt: "The contract requires 30 days notice.",
  };
  const answer = {
    status: "answered",
    agentMode: "document",
    text: "The contract requires 30 days notice. [Source 1]",
    citations: [citation],
    selectedDocumentNodeId: "doc-followup",
    sourceNodeIds: ["doc-followup"],
    capabilityReceipts: [],
    clarification: null,
  };

  const response = responseFor({
    answer,
    collected: collectedFor(rejected, selected),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "document");
  assert.equal(response.body.agentAnswer, answer.text);
  assert.equal(response.body.ragAnswer, answer.text);
  assert.deepEqual(response.body.ragSources, [citation]);
  assert.equal(response.body.ragResolvedQuestion, "Find notice term");
  assert.equal(response.body.ragMemoryApplied, true);
  assert.deepEqual(response.body.ragEvidenceSummary, { admittedCount: 1 });
  assert.deepEqual(response.body.ragGapPlan, { remaining: [] });
  assert.equal(response.body.ragAbstained, false);
  assert.deepEqual(response.body.agentTrace, [
    { type: "skill_graph_planned", summary: "Graph executed" },
  ]);
  assert.deepEqual(response.body.agentWorkingMemory.checkedQueries, ["What changed?"]);
  assert.deepEqual(response.body.agentObservability.budget, { used: 2 });
  assert.deepEqual(response.body.errors, { rag: null, mcp: null });
});

test("v3 clarification keeps a completed action receipt in the public answer", () => {
  const action = entry({
    nodeId: "task",
    skillId: "capability:task.create",
    category: "capability",
    text: "Task created successfully.",
    output: { text: "Task created successfully." },
  });
  const answer = {
    status: "clarification",
    agentMode: "clarification",
    text: "Task created successfully.\n\nWhich section should I check?",
    citations: [],
    selectedDocumentNodeId: null,
    sourceNodeIds: ["task"],
    capabilityReceipts: [{
      nodeId: "task",
      skillId: "capability:task.create",
      stepId: action.stepId,
      text: "Task created successfully.",
    }],
    clarification: {
      reason: "document_evidence_insufficient",
      summary: "Evidence is insufficient.",
      question: "Which section should I check?",
      detail: { approvalGates: [{ id: "gate-1" }] },
    },
  };
  const response = responseFor({ answer, collected: collectedFor(action) });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentAnswer, answer.text);
  assert.equal(response.body.ragAnswer, answer.text);
  assert.deepEqual(response.body.ragSources, []);
  assert.equal(response.body.ragAbstained, true);
  assert.equal(response.body.ragAbstainReason, "Evidence is insufficient.");
  assert.equal(response.body.clarification.needed, true);
  assert.equal(response.body.clarification.question, "Which section should I check?");
  assert.deepEqual(response.body.approvalGates, [{ id: "gate-1" }]);
});

test("v3 web answer projects final text and URL identity into chat fields", () => {
  const web = entry({
    nodeId: "web",
    skillId: "capability:web.search",
    category: "capability",
    text: "Raw web claim.",
  });
  const answer = {
    status: "answered",
    agentMode: "web",
    text: "The notice sets a 30 day deadline. [Source 1]",
    citations: [{
      rank: 1,
      url: "https://example.test/notice",
      excerpt: "The notice sets a 30 day deadline.",
    }],
    selectedDocumentNodeId: null,
    sourceNodeIds: ["web"],
    capabilityReceipts: [],
    clarification: null,
  };
  const response = responseFor({ answer, collected: collectedFor(web) });

  assert.equal(response.status, 200);
  assert.equal(response.body.mcpAnswer, answer.text);
  assert.equal(response.body.ragSources[0].url, "https://example.test/notice");
  assert.equal(response.body.ragResolvedQuestion, "What changed?");
  assert.equal(response.body.ragMemoryApplied, false);
});

test("v3 response rejects missing context and inconsistent source identities", () => {
  const direct = entry({
    nodeId: "inventory",
    skillId: AGENT_SKILL_IDS.inventory,
    category: "direct",
    text: "One document is available.",
  });
  const answer = {
    status: "answered",
    agentMode: "direct",
    text: "One document is available.",
    citations: [],
    selectedDocumentNodeId: null,
    sourceNodeIds: ["inventory"],
    capabilityReceipts: [],
    clarification: null,
  };
  const collected = collectedFor(direct);
  const invalid = (nextAnswer, overrides) => assert.throws(
    () => responseFor({ answer: nextAnswer, collected, overrides }),
    (error) => error.code === "AGENT_UNIFIED_GRAPH_RESPONSE_INVALID" &&
      error.status === 409
  );

  invalid(answer, { workingMemory: undefined });
  invalid({ ...answer, sourceNodeIds: ["missing"] });
  invalid({ ...answer, selectedDocumentNodeId: "inventory" });
  invalid({ ...answer, citations: [{ rank: 1, docId: "invented" }] });
  invalid(answer, { agentObservability: { agentMode: "document" } });
  assert.equal(responseFor({ answer, collected }).body.agentMode, "direct");
});
