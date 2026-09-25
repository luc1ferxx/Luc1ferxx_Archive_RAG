import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import { createUnifiedAgentExecutionGraphResult } from "../rag/agent-unified-dag-planner.js";
import { createCapabilityRegistry } from "../rag/capabilities/registry.js";
import { createWebSearchCapability } from "../rag/capabilities/web.js";
import { createDefaultSkillRegistry } from "../rag/skills/registry.js";

const accessScope = { userId: "alice", workspaceId: "private-workspace" };
const registry = createDefaultSkillRegistry();
const capabilityRegistry = createCapabilityRegistry([
  createWebSearchCapability({ webChatService: async () => ({ text: "unused" }) }),
]);
const ragService = {
  getDocument: (docId, scope) =>
    scope === accessScope && ["doc-a", "doc-b"].includes(docId)
      ? { docId }
      : null,
};
const requestField = (field) => ({ field, source: "request" });
const validNodes = () => [
  {
    dependsOn: [],
    failurePolicy: "fail_fast",
    inputBindings: {
      docIds: requestField("docIds"),
      question: requestField("question"),
    },
    nodeId: "document",
    skillId: "document_rag",
  },
  {
    dependsOn: ["document"],
    failurePolicy: "fail_fast",
    inputBindings: { question: requestField("question") },
    nodeId: "web",
    skillId: "web_search",
    when: { equals: true, nodeId: "document", output: "abstained" },
  },
];

const plan = (overrides = {}) => createUnifiedAgentExecutionGraphResult({
  accessScope,
  budgetState: createAgentBudget(),
  capabilityRegistry,
  docIds: ["doc-a", "doc-b"],
  plan: { mode: "document" },
  plannerAdapter: {
    id: "injected-unified-planner",
    createExecutionGraph: async () => ({ nodes: validNodes() }),
  },
  question: "Compare the selected documents; use Web only if evidence is insufficient.",
  ragService,
  registry,
  ...overrides,
});

test("unified planner validates a document-to-Web v3 proposal against the authorized catalog", async () => {
  let observedContext;
  const result = await plan({
    plannerAdapter: {
      id: "injected-unified-planner",
      createExecutionGraph: async (context) => {
        observedContext = context;
        return { nodes: validNodes() };
      },
    },
  });

  assert.equal(result.planner.status, "selected", JSON.stringify(result.errors));
  assert.equal(result.graph.version, "v3");
  assert.deepEqual(result.graph.nodes.map((node) => node.nodeId), ["document", "web"]);
  assert.deepEqual(observedContext.authorizedDocIds, ["doc-a", "doc-b"]);
  assert.equal(observedContext.graphVersion, "v3");
  assert.equal(observedContext.budgetRemaining.documentRagCalls, 2);
  assert.equal(observedContext.capabilities.some((entry) => entry.id === "web_search"), true);
  assert.equal(JSON.stringify(observedContext).includes("private-workspace"), false);
  assert.equal(JSON.stringify(observedContext).includes("alice"), false);
  assert.equal(JSON.stringify(observedContext).includes("execute"), false);
});

test("unverifiable document selection fails before calling a unified planner", async () => {
  let calls = 0;
  const result = await plan({
    docIds: ["doc-a", "foreign-doc"],
    plannerAdapter: {
      id: "injected-unified-planner",
      createExecutionGraph: async () => { calls += 1; return { nodes: validNodes() }; },
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.graph, null);
  assert.deepEqual(result.planner.reasonCodes, ["out_of_scope_document"]);
});

test("unified planner rejects forged top-level policy and wrong graph version", async () => {
  const forged = await plan({
    plannerAdapter: {
      id: "forged",
      createExecutionGraph: async () => ({ approval: true, nodes: validNodes() }),
    },
  });
  const wrongVersion = await plan({
    plannerAdapter: {
      id: "old-graph",
      createExecutionGraph: async () => ({ nodes: validNodes(), version: "v1" }),
    },
  });

  assert.equal(forged.graph, null);
  assert.ok(forged.planner.reasonCodes.includes("forged_policy"));
  assert.equal(wrongVersion.graph, null);
  assert.deepEqual(wrongVersion.planner.reasonCodes, ["invalid_graph_version"]);
});

test("unified planner rejects an unauthorized node without executing a fallback", async () => {
  const result = await plan({
    plannerAdapter: {
      id: "invented-capability",
      createExecutionGraph: async () => ({
        nodes: [{
          ...validNodes()[0],
          nodeId: "shell",
          skillId: "shell.exec",
        }],
      }),
    },
  });

  assert.equal(result.graph, null);
  assert.ok(result.planner.reasonCodes.includes("unregistered_capability"));
});

test("unified planner accepts a direct Capability only from the trusted allowlist", async () => {
  const directWebNode = {
    dependsOn: [],
    failurePolicy: "fail_fast",
    inputBindings: { question: requestField("question") },
    nodeId: "direct-web",
    skillId: "capability:web.search",
  };
  const plannerAdapter = {
    id: "direct-capability-proposal",
    createExecutionGraph: async () => ({ nodes: [directWebNode] }),
  };

  const denied = await plan({ plannerAdapter });
  const allowed = await plan({
    allowedCapabilityIds: ["web.search"],
    plannerAdapter,
  });

  assert.equal(denied.graph, null);
  assert.ok(denied.planner.reasonCodes.includes("unregistered_capability"));
  assert.equal(allowed.planner.status, "selected", JSON.stringify(allowed.errors));
  assert.deepEqual(allowed.graph.nodes.map((node) => node.skillId), ["capability:web.search"]);
  assert.equal(allowed.catalog.some((entry) => entry.id === "web_search"), false);
  assert.equal(allowed.catalog.some((entry) => entry.id === "capability:web.search"), true);
});

test("unified planner can combine document, custom comparison/risk, and conditional Web nodes", async () => {
  const nodes = [
    validNodes()[0],
    {
      dependsOn: [],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestField("docIds"),
        question: requestField("question"),
      },
      nodeId: "compare",
      skillId: "compare_documents",
    },
    {
      dependsOn: ["compare"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestField("docIds"),
        priorFindings: { nodeId: "compare", output: "text", source: "node" },
        question: requestField("question"),
      },
      nodeId: "risk",
      skillId: "risk_review",
    },
    validNodes()[1],
  ];
  const result = await plan({
    plannerAdapter: {
      id: "multi-stage-proposal",
      createExecutionGraph: async () => ({ nodes }),
    },
  });

  assert.equal(result.planner.status, "selected", JSON.stringify(result.errors));
  assert.deepEqual(result.graph.nodes.map((node) => node.skillId), [
    "document_rag",
    "compare_documents",
    "risk_review",
    "web_search",
  ]);
});

test("unified planner types document evidence check and a bounded conditional follow-up", async () => {
  const result = await plan({
    plannerAdapter: {
      id: "document-follow-up-proposal",
      createExecutionGraph: async () => ({
        nodes: [
          validNodes()[0],
          {
            dependsOn: ["document"],
            failurePolicy: "fail_fast",
            inputBindings: {
              docIds: requestField("docIds"),
              evidence: { nodeId: "document", output: "evidence", source: "node" },
              question: requestField("question"),
            },
            nodeId: "check",
            skillId: "document_evidence_check",
          },
          {
            dependsOn: ["check"],
            failurePolicy: "fail_fast",
            inputBindings: {
              docIds: requestField("docIds"),
              question: { nodeId: "check", output: "followUpQuestion", source: "node" },
              retrievalPlan: { nodeId: "check", output: "followUpRetrievalPlan", source: "node" },
            },
            nodeId: "follow-up",
            skillId: "document_rag",
            when: { equals: true, nodeId: "check", output: "retryRecommended" },
          },
        ],
      }),
    },
  });

  assert.equal(result.planner.status, "selected", JSON.stringify(result.errors));
  assert.deepEqual(result.graph.nodes.map((node) => node.skillId), [
    "document_rag",
    "document_evidence_check",
    "document_rag",
  ]);
  assert.deepEqual(result.graph.nodes[2].inputBindings.retrievalPlan, {
    nodeId: "check",
    output: "followUpRetrievalPlan",
    source: "node",
  });
});
