import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_GRAPH_CHECKPOINT_VERSIONS,
  buildExecutionGraphNodeStepId,
} from "../rag/agent-execution-graph-checkpoint.js";
import { collectUnifiedGraphResults } from "../rag/agent-unified-graph-results.js";
import {
  createCapabilityGraphAdapter,
  createCapabilityRegistry,
  createInMemoryActionTaskService,
  createTaskCreateCapability,
} from "../rag/capabilities/index.js";
import { AGENT_SKILL_IDS, createDefaultSkillRegistry } from "../rag/skills/registry.js";
import { getSkillContract } from "../rag/skills/skill-contract.js";

const baseRegistry = createDefaultSkillRegistry();
const capabilityRegistry = createCapabilityRegistry([
  createTaskCreateCapability({ actionTaskService: createInMemoryActionTaskService() }),
]);
const taskAdapter = createCapabilityGraphAdapter({
  capabilityId: "task.create",
  capabilityRegistry,
});
assert.ok(taskAdapter);

const registry = {
  get: (id) => id === taskAdapter.id ? taskAdapter : baseRegistry.get(id),
  list: () => [...baseRegistry.list(), taskAdapter],
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

const documentOutput = (text) => {
  const citations = [{ docId: "doc-a", chunkId: `${text}-chunk`, rank: 1 }];
  const evidence = {
    text,
    citations,
    abstained: false,
    retrievedContexts: [{ docId: "doc-a", text: `${text} evidence` }],
    comparisonAnalysisSummary: null,
  };
  return { text, citations, abstained: false, evidence };
};

const resultFor = (skillId, output) => {
  const skill = registry.get(skillId);
  const value = skillId === AGENT_SKILL_IDS.documentRag
    ? {
        text: output.text,
        citations: output.citations,
        abstained: output.abstained,
        retrievedContexts: output.evidence.retrievedContexts,
      }
    : { ...output };
  return {
    ok: true,
    skillId,
    skillVersion: skill.version,
    label: skill.label,
    text: output.text,
    citations: output.citations,
    abstained: output.abstained,
    value,
    graphOutput: output,
    traceDetail: null,
  };
};

const checkOutput = (sourceOutput, { passed = true, retryRecommended = false } = {}) => ({
  text: sourceOutput.text,
  citations: sourceOutput.citations,
  abstained: sourceOutput.abstained || !passed,
  check: { passed, retryRecommended, reasons: [] },
  passed,
  retryRecommended,
  followUpQuestion: retryRecommended ? "Find missing evidence" : "",
});

const receiptFor = (graphNode, result, overrides = {}) => {
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
    ...overrides,
  };
};

const graphRun = (nodes, results) => ({
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

const assertInvalid = (input) =>
  assert.throws(() => collectUnifiedGraphResults(input), (error) =>
    error.code === "AGENT_UNIFIED_GRAPH_RESULTS_INVALID" && error.status === 409
  );

test("collects repeated document, Web, and custom nodes without collapsing their identities", () => {
  const firstDocument = documentOutput("Document one");
  const secondDocument = documentOutput("Document two");
  const nodes = [
    node("doc-1", AGENT_SKILL_IDS.documentRag),
    node("check-1", AGENT_SKILL_IDS.documentEvidenceCheck, {
      dependsOn: ["doc-1"],
      inputBindings: {
        docIds: request("docIds"),
        question: request("question"),
        evidence: upstream("doc-1", "evidence"),
      },
    }),
    node("doc-2", AGENT_SKILL_IDS.documentRag),
    node("check-2", AGENT_SKILL_IDS.documentEvidenceCheck, {
      dependsOn: ["doc-2"],
      inputBindings: {
        docIds: request("docIds"),
        question: request("question"),
        evidence: upstream("doc-2", "evidence"),
      },
    }),
    node("web-1", AGENT_SKILL_IDS.webSearch, {
      inputBindings: { question: request("question") },
    }),
    node("web-2", AGENT_SKILL_IDS.webSearch, {
      inputBindings: { question: request("question") },
    }),
    node("risk-1", "risk_review"),
    node("risk-2", "risk_review"),
    node("inventory", AGENT_SKILL_IDS.inventory, { inputBindings: {} }),
    node("task", taskAdapter.id, {
      inputBindings: { title: request("question") },
    }),
  ];
  const results = [
    resultFor(AGENT_SKILL_IDS.documentRag, firstDocument),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck, checkOutput(firstDocument)),
    resultFor(AGENT_SKILL_IDS.documentRag, secondDocument),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck, checkOutput(secondDocument)),
    resultFor(AGENT_SKILL_IDS.webSearch, { text: "Web one", citations: [], abstained: false }),
    resultFor(AGENT_SKILL_IDS.webSearch, { text: "Web two", citations: [], abstained: false }),
    resultFor("risk_review", { text: "Risk one", citations: [], abstained: false }),
    resultFor("risk_review", { text: "Risk two", citations: [], abstained: false }),
    resultFor(AGENT_SKILL_IDS.inventory, {
      text: "One document", citations: [], abstained: false,
      documentCount: 1, hasDocuments: true,
    }),
    resultFor(taskAdapter.id, {
      text: "Task created", citations: [], abstained: false, task: { id: "task-1" },
    }),
  ];
  const collected = collectUnifiedGraphResults(graphRun(nodes, results));

  assert.deepEqual(collected.groups.answer.map((entry) => entry.nodeId), [
    "doc-1", "doc-2", "web-1", "web-2", "risk-1", "risk-2",
  ]);
  assert.deepEqual(collected.groups.control.map((entry) => entry.sourceDocumentNodeId), [
    "doc-1", "doc-2",
  ]);
  assert.deepEqual(collected.groups.direct.map((entry) => entry.nodeId), ["inventory"]);
  assert.deepEqual(collected.groups.capability.map((entry) => entry.nodeId), ["task"]);
  assert.equal(collected.byNodeId.get("doc-2").output.text, "Document two");
});

test("accepts a genuinely false branch but never invents a skipped Web result", () => {
  const doc = documentOutput("Document answer");
  const nodes = [
    node("doc", AGENT_SKILL_IDS.documentRag),
    node("check", AGENT_SKILL_IDS.documentEvidenceCheck, {
      dependsOn: ["doc"],
      inputBindings: {
        docIds: request("docIds"), question: request("question"),
        evidence: upstream("doc", "evidence"),
      },
    }),
    node("web", AGENT_SKILL_IDS.webSearch, {
      dependsOn: ["check"],
      inputBindings: { question: request("question") },
      when: { nodeId: "check", output: "retryRecommended", equals: true },
    }),
  ];
  const input = graphRun(nodes, [
    resultFor(AGENT_SKILL_IDS.documentRag, doc),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck, checkOutput(doc)),
    resultFor(AGENT_SKILL_IDS.webSearch, { text: "Should not appear", citations: [], abstained: false }),
  ]);
  input.run.nodeRuns[2] = receiptFor(nodes[2], input.run.results[2], {
    status: "skipped", reason: "condition_not_met", result: null, citationCount: 0,
  });
  input.run.results = input.run.results.slice(0, 2);

  const collected = collectUnifiedGraphResults(input);
  assert.deepEqual(collected.groups.skipped.map((entry) => entry.nodeId), ["web"]);
  assert.equal(collected.byNodeId.get("web").output, null);
  assert.equal(collected.groups.answer.length, 1);

  assertInvalid({ ...input, run: {
    ...input.run,
    nodeRuns: input.run.nodeRuns.map((receipt, index) => index === 2
      ? { ...receipt, result: resultFor(AGENT_SKILL_IDS.webSearch, {
          text: "Forged", citations: [], abstained: false,
        }) }
      : receipt),
  } });
  assertInvalid({ ...input, run: { ...input.run, results: [
    ...input.run.results,
    resultFor(AGENT_SKILL_IDS.webSearch, { text: "Ghost", citations: [], abstained: false }),
  ] } });
  assertInvalid({ ...input, run: { ...input.run, nodeRuns: input.run.nodeRuns.map(
    (receipt, index) => index === 2 ? { ...receipt, reason: "dependency_skipped" } : receipt
  ) } });
});

test("accepts normalized answer text while preserving matching raw document evidence", () => {
  const graphNode = node("doc", AGENT_SKILL_IDS.documentRag);
  const output = documentOutput("Document answer");
  output.evidence.text = "  Document answer  ";
  const result = resultFor(AGENT_SKILL_IDS.documentRag, output);
  result.value.text = output.evidence.text;
  result.value.evidence = { untrustedExtra: "not the graph projection" };
  const collected = collectUnifiedGraphResults(graphRun([graphNode], [result]));

  assert.equal(collected.byNodeId.get("doc").output.text, "Document answer");
  assert.equal(collected.byNodeId.get("doc").output.evidence.text, "  Document answer  ");
});

test("accepts a root node whose optional dependsOn field is absent", () => {
  const graphNode = node("risk", "risk_review");
  delete graphNode.dependsOn;
  const collected = collectUnifiedGraphResults(graphRun([graphNode], [
    resultFor("risk_review", { text: "Risk", citations: [], abstained: false }),
  ]));

  assert.deepEqual(collected.byNodeId.get("risk").dependsOn, []);
});

test("rejects mismatched checks, stale receipts, typed output, and unsupported Skills", () => {
  const doc = documentOutput("Document answer");
  const nodes = [
    node("doc", AGENT_SKILL_IDS.documentRag),
    node("check", AGENT_SKILL_IDS.documentEvidenceCheck, {
      dependsOn: ["doc"],
      inputBindings: {
        docIds: request("docIds"), question: request("question"),
        evidence: upstream("doc", "evidence"),
      },
    }),
  ];
  const input = graphRun(nodes, [
    resultFor(AGENT_SKILL_IDS.documentRag, doc),
    resultFor(AGENT_SKILL_IDS.documentEvidenceCheck, checkOutput(doc)),
  ]);
  assertInvalid({ ...input, graph: { ...input.graph, nodes: [nodes[0], {
    ...nodes[1], inputBindings: { ...nodes[1].inputBindings,
      evidence: upstream("doc", "text") },
  }] } });
  assertInvalid({ ...input, run: { ...input.run, nodeRuns: input.run.nodeRuns.map(
    (receipt, index) => index === 1
      ? { ...receipt, result: { ...receipt.result, graphOutput: {
          ...receipt.result.graphOutput, text: "Conflicting check",
        } } }
      : receipt
  ) } });
  assertInvalid({ ...input, run: { ...input.run, nodeRuns: input.run.nodeRuns.map(
    (receipt, index) => index === 0 ? { ...receipt, stepId: "custom_skill:doc" } : receipt
  ) } });
  assertInvalid({ ...input, run: { ...input.run, nodeRuns: input.run.nodeRuns.map(
    (receipt, index) => index === 0
      ? { ...receipt, result: { ...receipt.result, graphOutput: {
          ...receipt.result.graphOutput,
          evidence: { ...receipt.result.graphOutput.evidence, retrievedContexts: [] },
        } } }
      : receipt
  ) } });

  const unsupported = node("brief", AGENT_SKILL_IDS.researchBrief);
  const unsupportedResult = resultFor(AGENT_SKILL_IDS.researchBrief, {
    text: "Brief", citations: [], abstained: false,
  });
  assertInvalid(graphRun([unsupported], [unsupportedResult]));
});
