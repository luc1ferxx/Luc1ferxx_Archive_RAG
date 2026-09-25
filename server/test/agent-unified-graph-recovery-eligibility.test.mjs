import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import {
  buildExecutionGraphCheckpointOwner,
  buildExecutionGraphNodeStepId,
  createExecutionGraphCheckpoint,
  digestExecutionGraphTypedOutput,
  snapshotExecutionGraphNodeRun,
  updateExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createExecutionGraph } from "../rag/agent-execution-graph.js";
import { assessUnifiedGraphRecoveryEligibility } from "../rag/agent-unified-graph-recovery-eligibility.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
  SKILL_VALUE_TYPES,
} from "../rag/skills/skill-contract.js";

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const docIds = ["doc-a", "doc-b"];
const question = "Compare the documents and check the Web.";
const plan = { mode: "document", summary: "Compare then verify." };
const retrievalPlan = { queries: ["contract delta"] };
const sessionId = "session-a";
const userId = "alice";
const request = (field) => ({ source: "request", field });
const upstream = (nodeId, output) => ({ source: "node", nodeId, output });

const documentSkill = {
  id: "document_rag",
  version: "1.0.0",
  label: "Document RAG",
  kind: "built_in",
  budgetKey: "documentRagCalls",
  requiresAccessScope: true,
  effects: SKILL_EFFECTS.workspaceWrite,
  idempotency: SKILL_IDEMPOTENCY.adapterDefined,
  parallelSafe: false,
  replaySafe: false,
  retryable: false,
  inputSchema: {
    docIds: { required: true, scoped: true, type: SKILL_VALUE_TYPES.stringArray },
    question: { required: true, type: SKILL_VALUE_TYPES.string },
  },
  outputSchema: {
    text: { required: true, type: SKILL_VALUE_TYPES.string },
    citations: { required: true, type: SKILL_VALUE_TYPES.citationArray },
    abstained: { required: true, type: SKILL_VALUE_TYPES.boolean },
  },
};
const webSkill = {
  id: "web_search",
  version: "1.0.0",
  label: "Web Search",
  kind: "built_in",
  budgetKey: "webSearchCalls",
  requiresAccessScope: true,
  effects: SKILL_EFFECTS.externalRead,
  idempotency: SKILL_IDEMPOTENCY.nondeterministic,
  parallelSafe: false,
  replaySafe: false,
  retryable: false,
  inputSchema: {
    question: { required: true, type: SKILL_VALUE_TYPES.string },
    priorFindings: { required: true, type: SKILL_VALUE_TYPES.string },
  },
  outputSchema: documentSkill.outputSchema,
};

const makeFixture = () => {
  const authorizedSkills = [documentSkill, webSkill];
  const skills = new Map(authorizedSkills.map((skill) => [skill.id, skill]));
  const registry = { get: (id) => skills.get(id) ?? null };
  const budgetState = createAgentBudget();
  const graph = createExecutionGraph({
    version: "v3",
    nodes: [
      {
        nodeId: "document",
        skillId: documentSkill.id,
        dependsOn: [],
        failurePolicy: "continue",
        inputBindings: { docIds: request("docIds"), question: request("question") },
      },
      {
        nodeId: "web",
        skillId: webSkill.id,
        dependsOn: ["document"],
        failurePolicy: "continue",
        inputBindings: {
          question: request("question"),
          priorFindings: upstream("document", "text"),
        },
      },
    ],
  });
  const owner = buildExecutionGraphCheckpointOwner({
    accessScope,
    budgetState,
    docIds,
    plan,
    question,
    retrievalPlan,
    selectedSkills: authorizedSkills,
    sessionId,
    userId,
  });
  const checkpoint = createExecutionGraphCheckpoint({ graph, owner, version: "v2" });
  const stepId = buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId: "document" });
  const graphOutput = {
    text: "A adds a liability clause.",
    citations: [{ docId: "doc-a", page: 2 }],
    abstained: false,
  };
  const result = {
    ...graphOutput,
    graphOutput,
    ok: true,
    skillId: documentSkill.id,
    skillVersion: documentSkill.version,
  };
  const completedRun = snapshotExecutionGraphNodeRun({
    nodeId: "document",
    skillId: documentSkill.id,
    skillVersion: documentSkill.version,
    status: "completed",
    stepId,
    result,
  });
  const step = {
    id: stepId,
    type: "graph_node",
    status: "completed",
    attempt: 1,
    input: {
      boundInputs: { docIds, question },
      docIds,
      nodeId: "document",
      graphVersion: "v3",
      question,
      retrievalPlan,
      sessionId,
      skillId: documentSkill.id,
      skillVersion: documentSkill.version,
      userId,
      effects: documentSkill.effects,
      idempotency: documentSkill.idempotency,
      replaySafe: documentSkill.replaySafe,
    },
    output: {
      text: graphOutput.text,
      typedOutputDigest: digestExecutionGraphTypedOutput(graphOutput),
    },
  };
  const run = {
    status: "running",
    goal: question,
    input: { docIds, sessionId, userId },
    plan,
    steps: [step],
    approvalGates: [],
  };
  const args = {
    accessScope,
    authorizedDocIds: docIds,
    authorizedSkills,
    budgetState,
    checkpoint: updateExecutionGraphCheckpoint(checkpoint, { nodeRuns: [completedRun] }),
    docIds,
    plan,
    question,
    registry,
    retrievalPlan,
    run,
    sessionId,
    userId,
  };

  return { args, completedRun, graphOutput, skills, step };
};

test("v3 preflight identifies a completed-receipt boundary without mutating inputs", () => {
  const { args } = makeFixture();
  const before = structuredClone({ checkpoint: args.checkpoint, run: args.run, budget: args.budgetState });
  const outcome = assessUnifiedGraphRecoveryEligibility(args);

  assert.equal(outcome.decision, "auto_eligible");
  assert.equal(outcome.eligible, true);
  assert.deepEqual(outcome.completedNodeIds, ["document"]);
  assert.equal(outcome.usedBudgetAtResume.documentRagCalls, 1);
  assert.deepEqual(
    { checkpoint: args.checkpoint, run: args.run, budget: args.budgetState },
    before
  );
});

test("v3 preflight refuses active receipts, gates, claims, and unmatched owners", () => {
  const cases = [
    (args) => { args.run.steps[0].status = "paused"; },
    (args) => { args.run.steps[0].status = "running"; },
    (args) => { args.run.approvalGates.push({ id: "gate", status: "pending" }); },
    (args) => {
      args.checkpoint = updateExecutionGraphCheckpoint(args.checkpoint, {
        resumeClaim: { claimId: "other-worker" },
      });
    },
    (args) => { args.accessScope = { userId: "bob", workspaceId: "workspace-a" }; },
    (args) => { args.run.input.docIds = ["doc-other"]; },
    (args) => {
      args.checkpoint = updateExecutionGraphCheckpoint(args.checkpoint, {
        nodeRuns: [{ ...args.checkpoint.nodeRuns[0], status: "running" }],
      });
    },
  ];

  for (const change of cases) {
    const { args } = makeFixture();
    change(args);
    assert.equal(assessUnifiedGraphRecoveryEligibility(args).decision, "manual");
  }
});

test("v3 preflight checks typed output, current registry, persisted binding, and document scope", () => {
  const cases = [
    ({ args }) => {
      args.checkpoint = updateExecutionGraphCheckpoint(args.checkpoint, {
        nodeRuns: [{
          ...args.checkpoint.nodeRuns[0],
          result: {
            ...args.checkpoint.nodeRuns[0].result,
            graphOutput: { text: "missing required evidence fields" },
          },
        }],
      });
      args.run.steps[0].output.typedOutputDigest = digestExecutionGraphTypedOutput(
        args.checkpoint.nodeRuns[0].result.graphOutput
      );
    },
    ({ args, skills }) => {
      skills.set("document_rag", { ...documentSkill, version: "2.0.0" });
    },
    ({ skills }) => {
      skills.set("web_search", { ...webSkill, version: "2.0.0" });
    },
    ({ args }) => { args.run.steps[0].input.boundInputs.question = "changed"; },
    ({ args }) => { args.run.steps[0].input.docIds = ["doc-other"]; },
    ({ args }) => { args.authorizedDocIds = ["doc-b"]; },
    ({ args }) => {
      args.run.steps[0].output.typedOutputDigest = "v1:sha256:forged";
    },
    ({ args }) => {
      args.checkpoint = updateExecutionGraphCheckpoint(args.checkpoint, {
        graph: createExecutionGraph({
          version: "v3",
          nodes: args.checkpoint.graph.nodes.filter((node) => node.nodeId !== "document"),
        }),
      });
    },
  ];

  for (const change of cases) {
    const fixture = makeFixture();
    change(fixture);
    assert.equal(assessUnifiedGraphRecoveryEligibility(fixture.args).decision, "manual");
  }
});

test("v3 preflight never restores a budget above its trusted limit", () => {
  const { args } = makeFixture();
  args.budgetState = createAgentBudget({ maxDocumentRagCalls: 0 });
  assert.equal(assessUnifiedGraphRecoveryEligibility(args).decision, "manual");

  const second = makeFixture();
  second.args.checkpoint = updateExecutionGraphCheckpoint(second.args.checkpoint, {
    owner: {
      ...second.args.checkpoint.owner,
      budget: {
        ...second.args.checkpoint.owner.budget,
        usedAtEntry: {
          ...second.args.checkpoint.owner.budget.usedAtEntry,
          documentRagCalls: 2,
        },
      },
    },
  });
  assert.equal(assessUnifiedGraphRecoveryEligibility(second.args).decision, "manual");
});
