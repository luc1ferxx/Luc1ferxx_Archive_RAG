import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import { createExecutionGraph } from "../rag/agent-execution-graph.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { runUnifiedGraphStage } from "../rag/agent-unified-graph-stage.js";
import { CUSTOM_RAG_SKILL_CONTRACT } from "../rag/skills/custom/custom-skill-contract.js";
import { createSkillRegistry } from "../rag/skills/registry.js";
import { SKILL_EFFECTS } from "../rag/skills/skill-contract.js";

// The v3 all-stage graph stage runs /chat and background tasks only under
// AGENT_UNIFIED_GRAPH_ROLLOUT=guarded (agent-unified-graph-run.js). These tests
// pin the boundaries it keeps: it runs only on a durable runtime, only a
// validated v3 proposal, never a claimed continuation without its checkpoint,
// and it never lets a node run past an unacknowledged checkpoint write.

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const docIds = ["doc-a", "doc-b"];
const question = "Compare document A and B, then review the risks.";
const plan = { mode: "skill_chain", summary: "Compare, then review risk." };
const runId = "run-unified-stage";
const sessionId = "session-1";
const userId = "alice";
const request = (field) => ({ field, source: "request" });
const upstream = (nodeId, output) => ({ nodeId, output, source: "node" });

const ragService = {
  getDocument: (docId, scope) =>
    scope === accessScope && docIds.includes(docId) ? { docId } : null,
};

const createSkill = ({ calls, failing = false, id }) => ({
  ...CUSTOM_RAG_SKILL_CONTRACT,
  budgetKey: "customSkillCalls",
  effects: SKILL_EFFECTS.readOnly,
  execute: async ({ docIds: scopedDocIds, priorFindings }) => {
    calls.push({ id, priorFindings: priorFindings ?? null });

    if (failing) {
      throw new Error(`${id} failed`);
    }

    return {
      abstained: false,
      citations: [{ docId: scopedDocIds[0], page: 1 }],
      text: `${id} result`,
    };
  },
  id,
  kind: "custom",
  label: id,
  match: () => true,
  parallelSafe: true,
  requiresAccessScope: true,
  version: "1.0.0",
});

const graphNodes = [
  {
    dependsOn: [],
    failurePolicy: "fail_fast",
    inputBindings: { docIds: request("docIds"), question: request("question") },
    nodeId: "compare",
    skillId: "compare_documents",
  },
  {
    dependsOn: ["compare"],
    failurePolicy: "fail_fast",
    inputBindings: {
      docIds: request("docIds"),
      priorFindings: upstream("compare", "text"),
      question: request("question"),
    },
    nodeId: "risk",
    skillId: "risk_review",
  },
];

const v3Graph = () => createExecutionGraph({ nodes: graphNodes, version: "v3" });

const createHarness = async ({ failingSkillId = null } = {}) => {
  const calls = [];
  const skills = ["compare_documents", "risk_review"].map((id) =>
    createSkill({ calls, failing: id === failingSkillId, id })
  );
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  await agentRunService.createRun({
    accessScope,
    goal: question,
    input: { docIds, sessionId, userId },
    plan: {
      mode: plan.mode,
      selectedSkills: skills.map((skill) => ({ skillId: skill.id, skillVersion: skill.version })),
    },
    runId,
  });
  const recorded = [];
  const loadCheckpoint = async () =>
    (await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }))?.checkpoint ?? null;

  const options = (overrides = {}) => {
    const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
    const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });

    return {
      accessScope,
      agentRunId: runId,
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      docIds,
      executeObservedSkill: tracker.executeObservedSkill,
      loadExecutionGraphCheckpoint: () =>
        agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }),
      plan,
      planned: { graph: v3Graph() },
      question,
      ragService,
      recordExecutionGraph: (event) => recorded.push(event),
      recordSkillResult: tracker.recordSkillResult,
      recordSkippedSkill: tracker.recordSkippedSkill,
      registry: createSkillRegistry(skills),
      saveExecutionGraphCheckpoint: (checkpoint) =>
        agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId }),
      sessionId,
      stepLifecycle: createAgentRunStepLifecycle({ accessScope, agentRunService, runId }),
      userId,
      ...overrides,
    };
  };

  return { calls, loadCheckpoint, options, recorded };
};

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    assert.equal(error.status, 409);
    return true;
  });

test("the unified graph stage refuses to run without a durable runtime", async () => {
  const harness = await createHarness();

  await rejectsWith(
    runUnifiedGraphStage(harness.options({ saveExecutionGraphCheckpoint: undefined })),
    "AGENT_UNIFIED_GRAPH_STAGE_INVALID"
  );
  await rejectsWith(
    runUnifiedGraphStage(harness.options({ stepLifecycle: { startGraphStep: async () => null } })),
    "AGENT_UNIFIED_GRAPH_STAGE_INVALID"
  );
  await rejectsWith(
    runUnifiedGraphStage(harness.options({ budgetState: {} })),
    "AGENT_UNIFIED_GRAPH_STAGE_INVALID"
  );
  assert.deepEqual(harness.calls, []);
});

test("the unified graph stage executes only a v3 proposal", async () => {
  const harness = await createHarness();

  await rejectsWith(
    runUnifiedGraphStage(harness.options({ planned: { graph: createExecutionGraph({ nodes: graphNodes }) } })),
    "AGENT_UNIFIED_GRAPH_REJECTED"
  );
  await rejectsWith(
    runUnifiedGraphStage(harness.options({ planned: null })),
    "AGENT_UNIFIED_GRAPH_REJECTED"
  );
  assert.equal(await harness.loadCheckpoint(), null);
  assert.deepEqual(harness.calls, []);
});

test("a claimed continuation without a stored checkpoint requires recovery", async () => {
  const harness = await createHarness();

  await rejectsWith(
    runUnifiedGraphStage(harness.options({ expectedGraphResumeClaimId: "claim-1" })),
    "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY"
  );
  assert.deepEqual(harness.calls, []);
});

test("no node runs past a checkpoint write the store did not acknowledge", async () => {
  const harness = await createHarness();

  await rejectsWith(
    runUnifiedGraphStage(
      harness.options({
        saveExecutionGraphCheckpoint: async (checkpoint) => ({ ...checkpoint, digest: "not-the-saved-digest" }),
      })
    ),
    "AGENT_UNIFIED_GRAPH_CHECKPOINT_UNCONFIRMED"
  );
  assert.deepEqual(harness.calls, []);
});

test("a validated v3 graph runs in dependency order and seals its checkpoint as completed", async () => {
  const harness = await createHarness();

  const result = await runUnifiedGraphStage(harness.options());

  assert.equal(result.run.status, "completed");
  assert.deepEqual(harness.calls, [
    { id: "compare_documents", priorFindings: null },
    { id: "risk_review", priorFindings: "compare_documents result" },
  ]);
  const checkpoint = await harness.loadCheckpoint();
  assert.equal(checkpoint.phase, "completed");
  assert.deepEqual(checkpoint.nodeRuns.map((nodeRun) => nodeRun.nodeId).sort(), ["compare", "risk"]);
  assert.equal(harness.recorded.length, 1);
  assert.equal(harness.recorded[0].executed, true);
  assert.equal(harness.recorded[0].mode, "guarded");
  assert.deepEqual(harness.recorded[0].graph, { nodeCount: 2, version: "v3" });
});

test("a finished graph cannot be re-entered without a recovery claim", async () => {
  const harness = await createHarness();
  await runUnifiedGraphStage(harness.options());

  await rejectsWith(
    runUnifiedGraphStage(harness.options()),
    "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY"
  );
  assert.equal(harness.calls.length, 2);
});

test("a failed node leaves a partial checkpoint and fails the stage", async () => {
  const harness = await createHarness({ failingSkillId: "risk_review" });

  await rejectsWith(runUnifiedGraphStage(harness.options()), "AGENT_UNIFIED_GRAPH_PARTIAL");

  const checkpoint = await harness.loadCheckpoint();
  assert.equal(checkpoint.phase, "partial");
  assert.deepEqual(harness.calls.map((call) => call.id), ["compare_documents", "risk_review"]);
  assert.equal(harness.recorded.length, 0);
});
