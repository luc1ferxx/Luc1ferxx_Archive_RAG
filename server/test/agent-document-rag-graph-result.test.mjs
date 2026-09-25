import assert from "node:assert/strict";
import test from "node:test";

import { createAgentBudget } from "../rag/agent-budget.js";
import { createExecutionGraph } from "../rag/agent-execution-graph.js";
import { runExecutionGraph } from "../rag/agent-execution-graph-runner.js";
import { createBuiltInSkills } from "../rag/skills/built-ins.js";
import { hasConsistentDocumentRagGraphResult } from "../rag/skills/document-rag-graph-result.js";
import { executeAgentSkill } from "../rag/skills/registry.js";

const request = (field) => ({ field, source: "request" });
const nodeOutput = (nodeId, output) => ({ nodeId, output, source: "node" });

const graph = createExecutionGraph({
  version: "v3",
  nodes: [
    {
      nodeId: "primary",
      skillId: "document_rag",
      dependsOn: [],
      failurePolicy: "fail_fast",
      rationale: "Read selected documents.",
      inputBindings: { docIds: request("docIds"), question: request("question") },
    },
    {
      nodeId: "check",
      skillId: "document_evidence_check",
      dependsOn: ["primary"],
      failurePolicy: "fail_fast",
      rationale: "Check document support.",
      inputBindings: {
        docIds: request("docIds"),
        question: request("question"),
        evidence: nodeOutput("primary", "evidence"),
      },
    },
  ],
});

const createRegistry = (documentRag) => {
  const skills = createBuiltInSkills().map((skill) =>
    skill.id === "document_rag" ? documentRag : skill
  );
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return { get: (id) => byId.get(id) ?? null };
};

const run = ({ completedNodeRuns = [], documentRag, executeObservedSkill } = {}) =>
  runExecutionGraph({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
    authorizedDocIds: ["doc-a"],
    authorizedSkillIds: ["document_rag", "document_evidence_check"],
    budgetState: createAgentBudget(),
    completedNodeRuns,
    docIds: ["doc-a"],
    executeObservedSkill: executeObservedSkill ?? ((skill, context, options) =>
      executeAgentSkill(skill, context, options)),
    graph,
    question: "What does the document say?",
    registry: createRegistry(documentRag),
    stepLifecycle: {
      completeStep: async () => ({}),
      failStep: async () => ({}),
      startStep: async () => ({}),
    },
  });

const corruptResult = (documentRag) => ({
  ok: true,
  skillId: documentRag.id,
  skillVersion: documentRag.version,
  text: "Document answer",
  citations: [],
  abstained: false,
  value: { text: "Document answer", citations: [], abstained: false },
  graphOutput: {
    text: "Document answer",
    citations: [],
    abstained: false,
    evidence: {
      text: "Different document answer",
      citations: [],
      abstained: false,
      retrievedContexts: [],
      comparisonAnalysisSummary: null,
    },
  },
});

test("document graph result requires identical raw and typed evidence", () => {
  const documentRag = createBuiltInSkills().find((skill) => skill.id === "document_rag");
  assert.equal(hasConsistentDocumentRagGraphResult(corruptResult(documentRag)), false);
  assert.equal(hasConsistentDocumentRagGraphResult({
    ...corruptResult(documentRag),
    graphOutput: {
      ...corruptResult(documentRag).graphOutput,
      evidence: { ...corruptResult(documentRag).graphOutput.evidence, text: "Document answer" },
    },
  }), true);
});

test("v3 rejects conflicting document evidence before launching a dependent node", async () => {
  const documentRag = createBuiltInSkills().find((skill) => skill.id === "document_rag");
  const forgedSkill = {
    ...documentRag,
    execute: async () => ({
      ...corruptResult(documentRag).graphOutput,
      value: corruptResult(documentRag).value,
    }),
  };
  const outcome = await run({ documentRag: forgedSkill });

  assert.equal(outcome.status, "partial");
  assert.equal(outcome.nodeRuns[0].status, "failed");
  assert.equal(outcome.nodeRuns[1].status, "skipped");
  assert.equal(outcome.nodeRuns[1].reason, "dependency_failed");
});

test("v3 cannot reuse a checkpoint whose document evidence disagrees with its raw value", async () => {
  const documentRag = createBuiltInSkills().find((skill) => skill.id === "document_rag");
  let attempts = 0;
  const completedNodeRuns = [{
    nodeId: "primary",
    skillId: documentRag.id,
    skillVersion: documentRag.version,
    status: "completed",
    result: corruptResult(documentRag),
  }];

  await assert.rejects(
    run({
      completedNodeRuns,
      documentRag,
      executeObservedSkill: async () => { attempts += 1; },
    }),
    (error) => error.code === "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY"
  );
  assert.equal(attempts, 0);
});
