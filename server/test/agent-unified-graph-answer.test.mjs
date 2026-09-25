import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_GRAPH_CHECKPOINT_VERSIONS,
  buildExecutionGraphNodeStepId,
} from "../rag/agent-execution-graph-checkpoint.js";
import { deriveUnifiedGraphAnswer } from "../rag/agent-unified-graph-answer.js";
import { collectUnifiedGraphResults } from "../rag/agent-unified-graph-results.js";
import {
  createCapabilityGraphAdapter,
  createCapabilityRegistry,
  createInMemoryActionTaskService,
  createTaskCreateCapability,
  createWebSearchCapability,
} from "../rag/capabilities/index.js";
import { AGENT_SKILL_IDS, createDefaultSkillRegistry } from "../rag/skills/registry.js";
import { getSkillContract } from "../rag/skills/skill-contract.js";

const baseRegistry = createDefaultSkillRegistry();
const capabilityRegistry = createCapabilityRegistry([
  createTaskCreateCapability({ actionTaskService: createInMemoryActionTaskService() }),
  createWebSearchCapability({ webChatService: async () => ({ text: "Web result" }) }),
]);
const adapters = ["task.create", "web.search"].map((capabilityId) =>
  createCapabilityGraphAdapter({ capabilityId, capabilityRegistry })
);
assert.ok(adapters.every(Boolean));
const registry = {
  get: (id) => adapters.find((adapter) => adapter.id === id) ?? baseRegistry.get(id),
  list: () => [...baseRegistry.list(), ...adapters],
};
const request = (field) => ({ source: "request", field });
const upstream = (nodeId, output) => ({ source: "node", nodeId, output });
const node = (nodeId, skillId, overrides = {}) => ({
  nodeId,
  skillId,
  dependsOn: [],
  inputBindings: {
    docIds: request("docIds"),
    question: request("question"),
  },
  failurePolicy: "fail_fast",
  rationale: `Run ${nodeId}`,
  ...overrides,
});
const checkNode = (nodeId, sourceId) => node(
  nodeId,
  AGENT_SKILL_IDS.documentEvidenceCheck,
  {
    dependsOn: [sourceId],
    inputBindings: {
      docIds: request("docIds"),
      question: request("question"),
      evidence: upstream(sourceId, "evidence"),
    },
  }
);
const citation = (rank, statement) => ({
  docId: "doc-a",
  fileName: "contract.pdf",
  pageNumber: rank,
  rank,
  excerpt: statement,
});
const documentOutput = (statement, { extraCitation = false } = {}) => {
  const citations = [citation(1, statement)];
  const retrievedContexts = [{
    docId: "doc-a",
    fileName: "contract.pdf",
    pageNumber: 1,
    rank: 1,
    text: statement,
  }];
  if (extraCitation) {
    citations.push(citation(2, "The contract has a separate audit clause."));
    retrievedContexts.push({
      docId: "doc-a",
      fileName: "contract.pdf",
      pageNumber: 2,
      rank: 2,
      text: "The contract has a separate audit clause.",
    });
  }
  const text = `${statement} [Source 1]`;
  return {
    text,
    citations,
    abstained: false,
    evidence: {
      text,
      citations,
      abstained: false,
      retrievedContexts,
      comparisonAnalysisSummary: null,
    },
  };
};
const resultFor = (skillId, output) => {
  const skill = registry.get(skillId);
  return {
    ok: true,
    skillId,
    skillVersion: skill.version,
    label: skill.label,
    text: output.text,
    citations: output.citations,
    abstained: output.abstained,
    value: skillId === AGENT_SKILL_IDS.documentRag
      ? {
          text: output.evidence.text,
          citations: output.citations,
          abstained: output.abstained,
          retrievedContexts: output.evidence.retrievedContexts,
        }
      : { ...output },
    graphOutput: output,
    traceDetail: null,
  };
};
const checkOutput = (document, { passed = true, retryRecommended = false } = {}) => ({
  text: document.text,
  citations: document.citations,
  abstained: document.abstained || !passed,
  check: {
    passed,
    retryRecommended,
    reasons: passed ? [] : ["Insufficient support"],
    gaps: passed ? [] : [{ type: "evidence", severity: "blocking", message: "Insufficient support" }],
  },
  passed,
  retryRecommended,
  followUpQuestion: retryRecommended ? "Find supporting passage" : "",
});
const receiptFor = (graphNode, result) => {
  const skill = registry.get(graphNode.skillId);
  const contract = getSkillContract(skill);
  return {
    nodeId: graphNode.nodeId,
    skillId: skill.id,
    skillVersion: skill.version,
    stepId: buildExecutionGraphNodeStepId({
      checkpointVersion: EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2,
      nodeId: graphNode.nodeId,
    }),
    dependsOn: [...(graphNode.dependsOn ?? [])],
    effects: contract.effects,
    idempotency: contract.idempotency,
    parallelSafe: contract.parallelSafe,
    status: "completed",
    reason: null,
    citationCount: result.citations.length,
    result,
  };
};
const collectedFor = (nodes, results) => collectUnifiedGraphResults({
  graph: { version: "v3", revision: 0, nodes },
  run: {
    graphVersion: "v3",
    ok: true,
    status: "completed",
    errors: [],
    nodeRuns: nodes.map((item, index) => receiptFor(item, results[index])),
    results,
  },
  registry,
  authorizedDocIds: ["doc-a"],
});

test("selects the supported follow-up document and excludes control text", () => {
  const unsupported = documentOutput("An unverified payment claim is made.");
  const supported = documentOutput("The contract requires 30 days notice.");
  const nodes = [
    node("doc-primary", AGENT_SKILL_IDS.documentRag),
    checkNode("check-primary", "doc-primary"),
    node("doc-followup", AGENT_SKILL_IDS.documentRag, {
      dependsOn: ["check-primary"],
      inputBindings: {
        docIds: request("docIds"),
        question: upstream("check-primary", "followUpQuestion"),
      },
      when: { nodeId: "check-primary", output: "retryRecommended", equals: true },
    }),
    checkNode("check-followup", "doc-followup"),
  ];
  const results = [
    resultFor(AGENT_SKILL_IDS.documentRag, unsupported),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck,
      checkOutput(unsupported, { passed: false, retryRecommended: true })),
    resultFor(AGENT_SKILL_IDS.documentRag, supported),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck, checkOutput(supported)),
  ];
  const answer = deriveUnifiedGraphAnswer({ collected: collectedFor(nodes, results) });

  assert.equal(answer.status, "answered");
  assert.equal(answer.agentMode, "document");
  assert.equal(answer.selectedDocumentNodeId, "doc-followup");
  assert.deepEqual(answer.sourceNodeIds, ["doc-followup"]);
  assert.match(answer.text, /30 days notice/);
  assert.doesNotMatch(answer.text, /payment claim/);
  assert.deepEqual(answer.citations.map((source) => source.rank), [1]);
  assert.equal(answer.citations.some((source) => "evidenceText" in source), false);
});

test("among passing repeated document checks, picks stronger cited support", () => {
  const first = documentOutput("The contract requires 30 days notice.");
  const second = documentOutput("The contract requires 30 days notice.", {
    extraCitation: true,
  });
  const nodes = [
    node("doc-1", AGENT_SKILL_IDS.documentRag), checkNode("check-1", "doc-1"),
    node("doc-2", AGENT_SKILL_IDS.documentRag), checkNode("check-2", "doc-2"),
  ];
  const answer = deriveUnifiedGraphAnswer({ collected: collectedFor(nodes, [
    resultFor(AGENT_SKILL_IDS.documentRag, first),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck, checkOutput(first)),
    resultFor(AGENT_SKILL_IDS.documentRag, second),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck, checkOutput(second)),
  ]) });

  assert.equal(answer.selectedDocumentNodeId, "doc-2");
  assert.equal(answer.status, "answered");
});

test("keeps a persisted task receipt when document evidence needs clarification", () => {
  const document = documentOutput("An unverified payment claim is made.");
  const nodes = [
    node("doc", AGENT_SKILL_IDS.documentRag),
    checkNode("check", "doc"),
    node("task", "capability:task.create", {
      inputBindings: { title: request("question") },
    }),
  ];
  const answer = deriveUnifiedGraphAnswer({ collected: collectedFor(nodes, [
    resultFor(AGENT_SKILL_IDS.documentRag, document),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck,
      checkOutput(document, { passed: false, retryRecommended: true })),
    resultFor("capability:task.create", {
      text: "Task created successfully.", citations: [], abstained: false,
      task: { id: "task-1" },
    }),
  ]) });

  assert.equal(answer.status, "clarification");
  assert.equal(answer.selectedDocumentNodeId, null);
  assert.deepEqual(answer.citations, []);
  assert.deepEqual(answer.sourceNodeIds, ["task"]);
  assert.match(answer.text, /Task created successfully/);
  assert.match(answer.text, /Which specific section/);
  assert.doesNotMatch(answer.text, /payment claim/);
  assert.equal(answer.capabilityReceipts[0].nodeId, "task");
  assert.match(answer.capabilityReceipts[0].stepId, /^agent_graph_node:/);
});

test("treats the allowlisted Web Capability as grounded evidence", () => {
  const webStatement = "The public notice page states a 30 day deadline.";
  const nodes = [node("web", "capability:web.search", {
    inputBindings: { question: request("question") },
  })];
  const answer = deriveUnifiedGraphAnswer({ collected: collectedFor(nodes, [
    resultFor("capability:web.search", {
      text: `${webStatement} [Source 1]`,
      citations: [{ url: "https://example.test/notice", rank: 1, excerpt: webStatement }],
      abstained: false,
    }),
  ]) });

  assert.equal(answer.status, "answered");
  assert.equal(answer.agentMode, "web");
  assert.deepEqual(answer.sourceNodeIds, ["web"]);
  assert.deepEqual(answer.capabilityReceipts, []);
  assert.equal(answer.citations.length, 1);
  assert.match(answer.text, /30 day deadline/);
});

test("separates direct metadata from grounded answer and rejects uncited claims", () => {
  const inventory = node("inventory", AGENT_SKILL_IDS.inventory, {
    inputBindings: {},
  });
  const risk = node("risk", "risk_review");
  const answer = deriveUnifiedGraphAnswer({ collected: collectedFor(
    [inventory, risk],
    [
      resultFor(AGENT_SKILL_IDS.inventory, {
        text: "One document is available.", citations: [], abstained: false,
        documentCount: 1, hasDocuments: true,
      }),
      resultFor("risk_review", {
        text: "Unsupported liability claim.", citations: [], abstained: false,
      }),
    ]
  ) });

  assert.equal(answer.status, "clarification");
  assert.equal(answer.agentMode, "clarification");
  assert.match(answer.text, /^One document is available\./);
  assert.match(answer.text, /Which source or detail/);
  assert.doesNotMatch(answer.text, /liability claim/);
  assert.deepEqual(answer.sourceNodeIds, ["inventory"]);
  assert.deepEqual(answer.citations, []);
});

test("requires node-indexed collected v3 results", () => {
  assert.throws(() => deriveUnifiedGraphAnswer({ collected: { entries: [] } }),
    (error) => error.code === "AGENT_UNIFIED_GRAPH_ANSWER_INVALID" &&
      error.status === 409);
});
