import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import { resumeAgentExecutionGraphRun, runAgentRag } from "../rag/agent.js";
import { runCustomSkillStage } from "../rag/agent-custom-skill-stage.js";
import {
  buildExecutionGraphNodeStepId,
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  digestExecutionGraphTypedOutput,
  reconcileExecutionGraphCheckpoint,
  snapshotExecutionGraphNodeRun,
  updateExecutionGraphCheckpoint,
  verifyExecutionGraphCheckpoint,
} from "../rag/agent-execution-graph-checkpoint.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { createExecutionGraph } from "../rag/agent-execution-graph.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { AGENT_INTENT_IDS } from "../rag/agent-intent-rules.js";
import { CUSTOM_RAG_SKILL_CONTRACT } from "../rag/skills/custom/custom-skill-contract.js";
import { createSkillRegistry } from "../rag/skills/registry.js";
import { SKILL_EFFECTS } from "../rag/skills/skill-contract.js";
import {
  configureAgentExperienceMemoryStore,
  createInMemoryAgentExperienceStore,
} from "../rag/agent-experience-memory.js";
import { withAgentExperienceMemoryEnabled } from "./agent-experience-memory-test-helpers.mjs";

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const question = "Compare document A and B.";
const docIds = ["doc-a", "doc-b"];
const sessionId = "session-1";
const userId = "alice";
const runId = "checkpoint-run";
const plan = { mode: SKILL_CHAIN_MODE };
const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
};

const requestBinding = (field) => ({ source: "request", field });
const nodeBinding = (nodeId, output) => ({ source: "node", nodeId, output });
const graphNodes = [
  {
    dependsOn: [],
    failurePolicy: "continue",
    inputBindings: {
      docIds: requestBinding("docIds"),
      question: requestBinding("question"),
    },
    nodeId: "compare",
    skillId: "compare_documents",
  },
  {
    dependsOn: ["compare"],
    failurePolicy: "continue",
    inputBindings: {
      docIds: requestBinding("docIds"),
      question: requestBinding("question"),
      priorFindings: nodeBinding("compare", "text"),
    },
    nodeId: "risk",
    skillId: "risk_review",
  },
];

test("typed output receipt digest is stable across object key order", () => {
  const first = {
    abstained: false,
    citations: [{ docId: "doc-a", page: 1 }],
    text: "A differs from B.",
  };
  const reordered = {
    text: "A differs from B.",
    citations: [{ page: 1, docId: "doc-a" }],
    abstained: false,
  };

  assert.equal(
    digestExecutionGraphTypedOutput(first),
    digestExecutionGraphTypedOutput(reordered)
  );
  assert.notEqual(
    digestExecutionGraphTypedOutput(first),
    digestExecutionGraphTypedOutput({
      ...first,
      citations: [{ docId: "doc-b", page: 1 }],
    })
  );
});

const createV3DocumentCheckpoint = () => {
  const budgetState = createAgentBudget();
  const nodeId = "document:risk/a";
  const graph = createExecutionGraph({
    nodes: [{ nodeId, skillId: "document_rag", dependsOn: [] }],
    version: "v3",
  });
  const owner = buildExecutionGraphCheckpointOwner({
    accessScope,
    budgetState,
    docIds,
    plan,
    question,
    selectedSkills: [{ id: "document_rag", version: "1.0.0" }],
    sessionId,
    userId,
  });
  const checkpoint = createExecutionGraphCheckpoint({ graph, owner, version: "v2" });
  const stepId = buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId });
  const graphOutput = {
    abstained: false,
    citations: [{ docId: "doc-a", page: 1 }],
    text: "A has a new liability clause.",
  };
  const result = {
    ...graphOutput,
    graphOutput,
    ok: true,
    skillId: "document_rag",
    skillVersion: "1.0.0",
  };
  const nodeRun = snapshotExecutionGraphNodeRun({
    nodeId,
    result,
    skillId: "document_rag",
    skillVersion: "1.0.0",
    status: "completed",
    stepId,
  });
  const step = {
    id: stepId,
    input: { nodeId, skillId: "document_rag", skillVersion: "1.0.0" },
    output: {
      text: result.text,
      typedOutputDigest: digestExecutionGraphTypedOutput(graphOutput),
    },
    status: "completed",
    type: "graph_node",
  };

  return {
    budgetState,
    checkpoint,
    completedCheckpoint: updateExecutionGraphCheckpoint(checkpoint, { nodeRuns: [nodeRun] }),
    nodeId,
    nodeRun,
    owner,
    step,
    stepId,
  };
};

test("v3 graph nodes use a versioned namespace without changing legacy step IDs", () => {
  const first = buildExecutionGraphNodeStepId({
    checkpointVersion: "v2",
    nodeId: "document:risk/a",
  });
  const second = buildExecutionGraphNodeStepId({
    checkpointVersion: "v2",
    nodeId: "document:risk%2Fa",
  });

  assert.match(first, /^agent_graph_node:[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert.equal(
    buildExecutionGraphNodeStepId({ checkpointVersion: "v1", nodeId: "compare" }),
    "custom_skill:compare"
  );
});

test("the existing conditional custom-Skill graph v2 retains a v1 checkpoint and step namespace", () => {
  const budgetState = createAgentBudget();
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes, version: "v2" }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState,
      docIds,
      plan,
      question,
      selectedSkills: [{ id: "compare_documents", version: "1.0.0" }],
      sessionId,
      userId,
    }),
  });

  assert.equal(checkpoint.version, "v1");
  assert.equal(checkpoint.graph.version, "v2");
  assert.equal(
    buildExecutionGraphNodeStepId({ checkpointVersion: checkpoint.version, nodeId: "compare" }),
    "custom_skill:compare"
  );
  assert.equal(verifyExecutionGraphCheckpoint({
    accessScope,
    budgetState,
    checkpoint,
    docIds,
    plan,
    question,
    selectedSkills: [{ id: "compare_documents", version: "1.0.0" }],
    sessionId,
    userId,
  }).ok, true);
});

test("v2 checkpoint preserves its own version and reconciles a completed non-custom graph node", () => {
  const fixture = createV3DocumentCheckpoint();
  const verified = verifyExecutionGraphCheckpoint({
    accessScope,
    budgetState: fixture.budgetState,
    checkpoint: fixture.completedCheckpoint,
    docIds,
    plan,
    question,
    selectedSkills: [{ id: "document_rag", version: "1.0.0" }],
    sessionId,
    userId,
  });
  const reconciled = reconcileExecutionGraphCheckpoint({
    checkpoint: fixture.completedCheckpoint,
    steps: [fixture.step],
  });

  assert.equal(fixture.checkpoint.version, "v2");
  assert.equal(fixture.completedCheckpoint.version, "v2");
  assert.equal(verified.ok, true);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.attemptedStepCount, 1);
  assert.deepEqual(reconciled.completedNodeRuns, [fixture.nodeRun]);
});

test("checkpoint v2 cannot be confused with the older conditional custom-Skill graph v2", () => {
  const fixture = createV3DocumentCheckpoint();
  const wrongGraph = updateExecutionGraphCheckpoint(fixture.checkpoint, {
    graph: { ...fixture.checkpoint.graph, version: "v2" },
  });

  assert.deepEqual(
    reconcileExecutionGraphCheckpoint({ checkpoint: wrongGraph, steps: [] }),
    { ok: false, reason: "invalid_checkpoint_shape" }
  );
  assert.deepEqual(
    verifyExecutionGraphCheckpoint({
      accessScope,
      budgetState: fixture.budgetState,
      checkpoint: wrongGraph,
      docIds,
      plan,
      question,
      selectedSkills: [{ id: "document_rag", version: "1.0.0" }],
      sessionId,
      userId,
    }),
    { ok: false, reason: "invalid_checkpoint_shape" }
  );
});

test("v2 checkpoint rejects unknown, active, and missing heterogeneous node receipts", () => {
  const fixture = createV3DocumentCheckpoint();
  const mismatchCases = [
    {
      checkpoint: fixture.completedCheckpoint,
      reason: "checkpoint_step_mismatch",
      steps: [{ ...fixture.step, id: "agent_graph_node:unknown" }],
    },
    {
      checkpoint: fixture.completedCheckpoint,
      reason: "checkpoint_step_mismatch",
      steps: [{ ...fixture.step, type: "custom_skill" }],
    },
    {
      checkpoint: fixture.completedCheckpoint,
      reason: "checkpoint_step_mismatch",
      steps: [{ id: "document_rag:primary", status: "completed", type: "document_rag" }],
    },
    {
      checkpoint: fixture.completedCheckpoint,
      reason: "unknown_in_flight_node",
      steps: [{ id: "document_rag:primary", status: "running", type: "document_rag" }],
    },
    {
      checkpoint: fixture.completedCheckpoint,
      reason: "duplicate_graph_step_receipt",
      steps: [fixture.step, { ...fixture.step }],
    },
    {
      checkpoint: fixture.completedCheckpoint,
      reason: "unknown_in_flight_node",
      steps: [{ ...fixture.step, status: "running" }],
    },
    {
      checkpoint: fixture.checkpoint,
      reason: "checkpoint_step_mismatch",
      steps: [fixture.step],
    },
    {
      checkpoint: fixture.completedCheckpoint,
      reason: "checkpoint_missing_completed_step",
      steps: [],
    },
    {
      checkpoint: updateExecutionGraphCheckpoint(fixture.checkpoint, {
        nodeRuns: [snapshotExecutionGraphNodeRun({
          ...fixture.nodeRun,
          status: "failed",
        })],
      }),
      reason: "checkpoint_missing_node_step",
      steps: [],
    },
  ];

  for (const { checkpoint, reason, steps } of mismatchCases) {
    assert.deepEqual(
      reconcileExecutionGraphCheckpoint({ checkpoint, steps }),
      { ok: false, reason }
    );
  }
});

test("a v2 graph with an unsupported stored outer plan still requires manual recovery", async () => {
  const { checkpoint } = createV3DocumentCheckpoint();
  const service = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const unsupportedRunId = "v3-unsupported-outer-plan";
  let resumeCalls = 0;
  await service.createRun({
    accessScope,
    goal: question,
    input: { docIds, sessionId, userId },
    plan: { mode: plan.mode },
    runId: unsupportedRunId,
  });
  await service.appendRunEvent({
    accessScope,
    runId: unsupportedRunId,
    type: "execution_planned",
    payload: { planner: { stepIds: ["document_rag", "unrelated_outer_step"] } },
  });
  await service.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint,
    runId: unsupportedRunId,
  });
  const recovery = createAgentRunRecoveryService({
    agentRunService: service,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: async () => { resumeCalls += 1; },
  });

  const outcome = await recovery.recoverOnStartup({ mode: "auto" });
  const run = await service.getRun({ accessScope, runId: unsupportedRunId });
  assert.equal(outcome.autoRecoveredCount, 0);
  assert.equal(outcome.manualRecoveredCount, 1);
  assert.equal(resumeCalls, 0);
  assert.equal(run.status, "waiting_for_user");
});

test("a v3 graph cannot enter the legacy custom-Skill startup continuation", async () => {
  const { checkpoint } = createV3DocumentCheckpoint();
  const service = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const v3RunId = "v3-legacy-shaped-outer-plan";
  let resumeCalls = 0;
  await service.createRun({
    accessScope,
    goal: question,
    input: { docIds, sessionId, userId },
    plan,
    runId: v3RunId,
  });
  await service.appendRunEvent({
    accessScope,
    runId: v3RunId,
    type: "execution_planned",
    payload: { planner: { stepIds: ["custom_skills"] } },
  });
  await service.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint,
    runId: v3RunId,
  });
  const recovery = createAgentRunRecoveryService({
    agentRunService: service,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: async () => { resumeCalls += 1; },
  });

  const outcome = await recovery.recoverOnStartup({ mode: "auto" });
  const run = await service.getRun({ accessScope, runId: v3RunId });
  assert.equal(outcome.autoRecoveredCount, 0);
  assert.equal(outcome.manualRecoveredCount, 1);
  assert.equal(resumeCalls, 0);
  assert.equal(run.status, "waiting_for_user");
  assert.equal(
    run.events.findLast((event) => event.type === "manual_recovery_required")
      ?.payload?.reason,
    "graph_checkpoint_version_not_resumable"
  );
});

test("v3 graph node lifecycle is fenced by its v2 checkpoint and cannot be claimed while active", async () => {
  const fixture = createV3DocumentCheckpoint();
  const service = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const v3RunId = "v3-fenced-node";
  await service.createRun({
    accessScope,
    goal: question,
    input: { docIds, sessionId, userId },
    plan,
    runId: v3RunId,
  });

  await assert.rejects(
    service.recordRunStep({
      accessScope,
      eventType: "step_started",
      input: fixture.step.input,
      label: "Document RAG",
      runId: v3RunId,
      status: "running",
      stepId: fixture.stepId,
      type: "graph_node",
    }),
    { code: "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY", status: 409 }
  );

  await service.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint: fixture.checkpoint,
    runId: v3RunId,
  });
  const lifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService: service,
    runId: v3RunId,
  });
  await lifecycle.startGraphStep({
    expectedResumeClaimId: null,
    id: fixture.stepId,
    input: fixture.step.input,
    label: "Document RAG",
    type: "graph_node",
  });

  const loaded = await service.getExecutionGraphCheckpoint({ accessScope, runId: v3RunId });
  assert.equal(loaded.steps[0].type, "graph_node");
  assert.equal(loaded.steps[0].id, fixture.stepId);
  assert.equal(loaded.steps[0].status, "running");
  assert.equal((await service.claimExecutionGraphResume({
    accessScope,
    checkpointDigest: fixture.checkpoint.digest,
    runId: v3RunId,
  })).claimed, false);

  await assert.rejects(
    service.recordRunStep({
      accessScope,
      eventType: "step_completed",
      output: fixture.step.output,
      runId: v3RunId,
      status: "completed",
      stepId: fixture.stepId,
    }),
    { code: "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY", status: 409 }
  );
  await lifecycle.completeGraphStep({
    expectedResumeClaimId: null,
    id: fixture.stepId,
    output: fixture.step.output,
  });
  assert.equal(
    (await service.getRun({ accessScope, runId: v3RunId })).steps[0].status,
    "completed"
  );
});

const createSkill = ({ calls, effects = SKILL_EFFECTS.readOnly, id }) => ({
  ...CUSTOM_RAG_SKILL_CONTRACT,
  budgetKey: "customSkillCalls",
  effects,
  execute: async ({ docIds: scopedDocIds, priorFindings }) => {
    calls.push({ id, priorFindings });
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
  parallelSafe: effects === SKILL_EFFECTS.readOnly,
  requiresAccessScope: true,
  version: "1.0.0",
});

const createHarness = async ({ effects = SKILL_EFFECTS.readOnly } = {}) => {
  const calls = [];
  const skills = [
    createSkill({ calls, effects, id: "compare_documents" }),
    createSkill({ calls, id: "risk_review" }),
  ];
  const registry = createSkillRegistry(skills);
  const store = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore: store });
  await agentRunService.createRun({
    accessScope,
    goal: question,
    input: { docIds, sessionId, userId },
    plan: {
      mode: plan.mode,
      selectedSkills: skills.map((skill) => ({
        skillId: skill.id,
        skillVersion: skill.version,
      })),
    },
    runId,
  });

  const runStage = ({
    accessScope: nextScope = accessScope,
    docIds: nextDocIds = docIds,
    expectedGraphResumeClaimId = null,
    load = () => agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }),
    save = (checkpoint) => agentRunService.saveExecutionGraphCheckpoint({
      accessScope,
      checkpoint,
      runId,
    }),
    stepLifecycle = createAgentRunStepLifecycle({
      accessScope,
      agentRunService,
      runId,
    }),
  } = {}) => {
    const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
    const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });

    return runCustomSkillStage({
      accessScope: nextScope,
      authorizedCustomSkills: skills,
      authorizedDocIds: nextDocIds,
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      customSkills: skills,
      docIds: nextDocIds,
      executeObservedSkill: tracker.executeObservedSkill,
      expectedGraphResumeClaimId,
      loadExecutionGraphCheckpoint: load,
      mode: "guarded",
      plan,
      plannerAdapter: {
        createExecutionGraph: () => ({ nodes: graphNodes }),
        id: "checkpoint_test_planner",
      },
      question,
      ragService: {},
      recordSkillResult: tracker.recordSkillResult,
      recordSkippedSkill: tracker.recordSkippedSkill,
      registry,
      saveExecutionGraphCheckpoint: save,
      sessionId,
      stepLifecycle,
      userId,
    });
  };

  return { agentRunService, calls, registry, runStage, skills, store };
};

const withGuardedGraph = async (run) => {
  const previous = process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  process.env.AGENT_SKILL_GRAPH_ROLLOUT = "guarded";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = previous;
    }
  }
};

const runFullGraph = (harness, {
  requestDocIds = docIds,
  requestIntentId = AGENT_INTENT_IDS.compareRiskChain,
  requestQuestion = question,
  requestSessionId = sessionId,
} = {}) => runAgentRag({
  accessScope,
  agentRunId: runId,
  agentRunService: harness.agentRunService,
  dagPlannerAdapter: {
    createExecutionGraph: () => ({ nodes: graphNodes }),
    id: "checkpoint_full_run_test_planner",
  },
  docIds: requestDocIds,
  executionPlannerAdapter: {
    createExecutionPlan: () => [
      { id: "custom_skills", condition: "selected_custom_skills" },
    ],
    id: "checkpoint_graph_only_outer_planner",
  },
  intentPlannerAdapter: {
    id: "checkpoint_compare_risk_intent",
    selectIntentPlan: async () => ({
      selectedIntentId: requestIntentId,
    }),
  },
  question: requestQuestion,
  ragService: { getDocument: (docId) => ({ docId }) },
  sessionId: requestSessionId,
  skillRegistry: harness.registry,
  userId,
});

const resumeFullGraph = async (harness, checkpoint) => {
  const run = await harness.agentRunService.getRun({ accessScope, runId });
  return resumeAgentExecutionGraphRun({
    accessScope,
    agentRunService: harness.agentRunService,
    checkpoint,
    ragService: { getDocument: (docId) => ({ docId }) },
    run,
    runId,
    skillRegistry: harness.registry,
  });
};

test("guarded graph resumes the same run without replaying a completed write", async () => {
  const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
  let interrupted = false;

  await assert.rejects(
    harness.runStage({
      save: async (checkpoint) => {
        await harness.agentRunService.saveExecutionGraphCheckpoint({
          accessScope,
          checkpoint,
          runId,
        });
        if (!interrupted && checkpoint.nodeRuns.length === 1) {
          interrupted = true;
          throw new Error("process stopped after the durable write checkpoint");
        }
      },
    }),
    /process stopped/
  );

  assert.deepEqual(harness.calls.map((call) => call.id), ["compare_documents"]);
  const first = await harness.agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runId,
  });
  assert.deepEqual(first.checkpoint.nodeRuns.map((run) => run.nodeId), ["compare"]);
  assert.deepEqual(first.steps.map((step) => step.status), ["completed"]);

  const results = await harness.runStage();
  assert.deepEqual(harness.calls.map((call) => call.id), [
    "compare_documents",
    "risk_review",
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].text, "compare_documents result");
  assert.equal(results[1].text, "risk_review result");
  assert.equal(harness.calls[1].priorFindings, "compare_documents result");

  // Re-entry after the stage finished is also a read of the checkpoint, not
  // another write or a second budget claim.
  await harness.runStage();
  assert.equal(harness.calls.length, 2);
});

test("completed graph step receipt binds the whole typed output before reuse", async () => {
  const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
  await harness.runStage();
  const stored = await harness.agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runId,
  });
  const compareRun = stored.checkpoint.nodeRuns.find((run) => run.nodeId === "compare");
  const compareStep = stored.steps.find((step) => step.id === "custom_skill:compare");

  assert.equal(
    compareStep.output.typedOutputDigest,
    digestExecutionGraphTypedOutput(compareRun.result.graphOutput)
  );
  assert.match(compareStep.output.typedOutputDigest, /^v1:sha256:[0-9a-f]{64}$/);

  const changedNodeRuns = structuredClone(stored.checkpoint.nodeRuns);
  changedNodeRuns[0].result.graphOutput.citations[0].docId = "doc-b";
  const changedCheckpoint = updateExecutionGraphCheckpoint(stored.checkpoint, {
    nodeRuns: changedNodeRuns,
  });
  const missingDigestSteps = structuredClone(stored.steps);
  delete missingDigestSteps[0].output.typedOutputDigest;
  const changedDigestSteps = structuredClone(stored.steps);
  changedDigestSteps[0].output.typedOutputDigest = "v1:sha256:0000000000000000000000000000000000000000000000000000000000000000";

  for (const loaded of [
    { checkpoint: changedCheckpoint, steps: stored.steps },
    { checkpoint: stored.checkpoint, steps: missingDigestSteps },
    { checkpoint: stored.checkpoint, steps: changedDigestSteps },
  ]) {
    await assert.rejects(
      harness.runStage({ load: async () => loaded }),
      { code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" }
    );
  }

  // A failed receipt check must not repeat either already-completed effect.
  assert.deepEqual(harness.calls.map((call) => call.id), [
    "compare_documents",
    "risk_review",
  ]);
});

test("process restart resumes only the stored graph and never repeats a completed effect", async () => {
  const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
  await harness.agentRunService.appendRunEvent({
    accessScope,
    runId,
    type: "execution_planned",
    payload: { planner: { stepIds: ["custom_skills"] } },
  });
  let crashed = false;
  await assert.rejects(
    harness.runStage({
      save: async (checkpoint) => {
        await harness.agentRunService.saveExecutionGraphCheckpoint({
          accessScope,
          checkpoint,
          runId,
        });
        if (!crashed && checkpoint.nodeRuns.length === 1) {
          crashed = true;
          throw new Error("simulated process exit");
        }
      },
    }),
    /simulated process exit/
  );

  // Re-create the services over the same persisted store, as a new process
  // would do with the PostgreSQL run rows. No transient tracker or graph
  // scheduler state survives this boundary.
  const restartedRunService = createAgentRunService({
    agentRunStore: harness.store,
  });
  const recovery = createAgentRunRecoveryService({
    agentRunService: restartedRunService,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: (args) => resumeAgentExecutionGraphRun({
      ...args,
      agentRunService: restartedRunService,
      ragService: {
        getDocument: (docId) => ({ docId }),
      },
      skillRegistry: harness.registry,
    }),
  });

  const outcome = await recovery.recoverOnStartup({ mode: "auto" });
  const resumed = await restartedRunService.getRun({ accessScope, runId });
  const checkpoint = await restartedRunService.getExecutionGraphCheckpoint({
    accessScope,
    runId,
  });

  assert.equal(outcome.autoRecoveredCount, 1);
  assert.equal(outcome.manualRecoveredCount, 0);
  assert.equal(resumed.status, "completed");
  assert.equal(checkpoint.checkpoint.phase, "completed");
  assert.ok(checkpoint.checkpoint.resumeClaim?.claimId);
  assert.deepEqual(harness.calls.map((call) => call.id), [
    "compare_documents",
    "risk_review",
  ]);
  assert.equal(
    resumed.events.filter((event) => event.type === "skill_graph_resume_claimed").length,
    1
  );
  assert.equal(
    resumed.events.filter((event) => event.type === "auto_recovery_completed").length,
    1
  );
});

test("checkpoint owner rejects changed scope, documents, and Skill version", async () => {
  const harness = await createHarness();
  await harness.runStage();
  const { checkpoint } = await harness.agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runId,
  });
  const originalBudget = createAgentBudget({ maxCustomSkillCalls: 3 });
  const verify = (overrides = {}) => verifyExecutionGraphCheckpoint({
    accessScope,
    budgetState: originalBudget,
    checkpoint,
    docIds,
    plan,
    question,
    retrievalPlan: null,
    selectedSkills: harness.skills,
    sessionId,
    userId,
    ...overrides,
  });

  assert.equal(verify().ok, true);
  assert.equal(verify({ accessScope: { userId: "bob", workspaceId: "workspace-a" } }).ok, false);
  assert.equal(verify({ docIds: ["doc-a"] }).ok, false);
  assert.equal(verify({ selectedSkills: [{ ...harness.skills[0], version: "2.0.0" }, harness.skills[1]] }).ok, false);
  await assert.rejects(
    harness.runStage({ docIds: ["doc-a"] }),
    { code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" }
  );
  await assert.rejects(
    harness.runStage({
      accessScope: { userId: "bob", workspaceId: "workspace-a" },
    }),
    { code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" }
  );
  assert.equal(harness.calls.length, 2);
});

test("changed or forged graph checkpoint fails closed before any Skill executes", async () => {
  const harness = await createHarness();
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState,
      docIds,
      plan,
      question,
      retrievalPlan: null,
      selectedSkills: harness.skills,
      sessionId,
      userId,
    }),
  });
  await harness.agentRunService.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint,
    runId,
  });

  const forged = structuredClone(checkpoint);
  forged.graph.nodes[0].scope = { docIds: ["doc-other"] };
  await assert.rejects(
    harness.runStage({ load: async () => ({ checkpoint: forged, steps: [] }) }),
    { code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" }
  );
  const resealedButIllegal = updateExecutionGraphCheckpoint(checkpoint, {
    graph: forged.graph,
  });
  await assert.rejects(
    harness.runStage({ load: async () => ({ checkpoint: resealedButIllegal, steps: [] }) }),
    { code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" }
  );
  assert.equal(harness.calls.length, 0);
});

test("an in-flight write is never replayed during graph resume", async () => {
  const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState,
      docIds,
      plan,
      question,
      retrievalPlan: null,
      selectedSkills: harness.skills,
      sessionId,
      userId,
    }),
  });
  await harness.agentRunService.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint,
    runId,
  });
  await harness.agentRunService.recordRunStep({
    accessScope,
    graphResumeClaimId: null,
    input: {
      docIds,
      effects: SKILL_EFFECTS.workspaceWrite,
      nodeId: "compare",
      question,
      skillId: "compare_documents",
      skillVersion: "1.0.0",
    },
    runId,
    status: "running",
    stepId: "custom_skill:compare",
    type: "custom_skill",
  });

  await assert.rejects(harness.runStage(), {
    code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY",
  });
  assert.equal(harness.calls.length, 0);
});

test("a completed write with a missing node checkpoint is not replayed", async () => {
  const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState,
      docIds,
      plan,
      question,
      retrievalPlan: null,
      selectedSkills: harness.skills,
      sessionId,
      userId,
    }),
  });
  await harness.agentRunService.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint,
    runId,
  });
  await harness.agentRunService.recordRunStep({
    accessScope,
    graphResumeClaimId: null,
    input: {
      docIds,
      effects: SKILL_EFFECTS.workspaceWrite,
      nodeId: "compare",
      question,
      skillId: "compare_documents",
      skillVersion: "1.0.0",
    },
    runId,
    status: "running",
    stepId: "custom_skill:compare",
    type: "custom_skill",
  });
  await harness.agentRunService.recordRunStep({
    accessScope,
    graphResumeClaimId: null,
    output: { text: "compare_documents result" },
    runId,
    status: "completed",
    stepId: "custom_skill:compare",
  });

  await assert.rejects(harness.runStage(), {
    code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY",
  });
  assert.equal(harness.calls.length, 0);
});

test("only one startup worker can claim a graph checkpoint", async () => {
  const harness = await createHarness();
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState,
      docIds,
      plan,
      question,
      retrievalPlan: null,
      selectedSkills: harness.skills,
      sessionId,
      userId,
    }),
  });
  await harness.agentRunService.saveExecutionGraphCheckpoint({
    accessScope,
    checkpoint,
    runId,
  });

  const claims = await Promise.all([
    harness.agentRunService.claimExecutionGraphResume({
      accessScope,
      checkpointDigest: checkpoint.digest,
      runId,
    }),
    harness.agentRunService.claimExecutionGraphResume({
      accessScope,
      checkpointDigest: checkpoint.digest,
      runId,
    }),
  ]);
  assert.deepEqual(claims.map((claim) => claim.claimed).sort(), [false, true]);
  const run = await harness.agentRunService.getRun({ accessScope, runId });
  assert.equal(
    run.events.filter((event) => event.type === "skill_graph_resume_claimed").length,
    1
  );
});

test("an active standalone step atomically prevents initial graph ownership", async () => {
  const harness = await createHarness();
  await harness.agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    input: { docIds, question },
    label: "Document retrieval",
    runId,
    status: "running",
    stepId: "document_rag:primary",
    type: "document_rag",
  });
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
      docIds,
      plan,
      question,
      retrievalPlan: null,
      selectedSkills: harness.skills,
      sessionId,
      userId,
    }),
  });

  await assert.rejects(
    harness.agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId }),
    { code: "AGENT_GRAPH_EXECUTION_FENCED", status: 409 }
  );
  assert.equal(
    await harness.agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }),
    null
  );
});

test("the run service rejects a standalone retry against a guarded checkpoint", async () => {
  const harness = await createHarness();
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
      docIds,
      plan,
      question,
      retrievalPlan: null,
      selectedSkills: harness.skills,
      sessionId,
      userId,
    }),
  });
  await harness.agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });
  await harness.agentRunService.completeRun({
    accessScope,
    runId,
    status: "failed",
    steps: [{
      id: "document_rag:primary",
      kind: "tool_call",
      label: "Document retrieval",
      status: "failed",
      type: "document_rag",
    }],
  });
  const before = await harness.agentRunService.getRun({ accessScope, runId });

  await assert.rejects(
    harness.agentRunService.retryStep({
      accessScope,
      runId,
      stepId: "document_rag:primary",
    }),
    { code: "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY", status: 409 }
  );
  assert.deepEqual(await harness.agentRunService.getRun({ accessScope, runId }), before);
});

test("the run service rejects a standalone step start during an active graph", async () => {
  const harness = await createHarness();
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
      docIds,
      plan,
      question,
      retrievalPlan: null,
      selectedSkills: harness.skills,
      sessionId,
      userId,
    }),
  });
  await harness.agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });

  await assert.rejects(
    harness.agentRunService.recordRunStep({
      accessScope,
      eventType: "step_started",
      label: "Document retrieval",
      runId,
      status: "running",
      stepId: "document_rag:primary",
      type: "document_rag",
    }),
    { code: "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY", status: 409 }
  );
  assert.deepEqual((await harness.agentRunService.getRun({ accessScope, runId })).steps, []);
});

test("a partial graph cannot restart its missing node through generic step creation", async () => {
  const harness = await createHarness();
  const checkpoint = updateExecutionGraphCheckpoint(
    createExecutionGraphCheckpoint({
      graph: createExecutionGraph({ nodes: graphNodes }),
      owner: buildExecutionGraphCheckpointOwner({
        accessScope,
        budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
        docIds,
        plan,
        question,
        retrievalPlan: null,
        selectedSkills: harness.skills,
        sessionId,
        userId,
      }),
    }),
    { phase: "partial" }
  );
  await harness.agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });

  await assert.rejects(
    harness.agentRunService.recordRunStep({
      accessScope,
      eventType: "step_started",
      input: { docIds, nodeId: "compare", question, skillId: "compare_documents" },
      label: "Compare",
      runId,
      status: "running",
      stepId: "custom_skill:compare",
      type: "custom_skill",
    }),
    { code: "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY", status: 409 }
  );
  assert.deepEqual((await harness.agentRunService.getRun({ accessScope, runId })).steps, []);
});

test("graph node settlement must carry the current recovery claim", async () => {
  const harness = await createHarness();
  const checkpoint = createExecutionGraphCheckpoint({
    graph: createExecutionGraph({ nodes: graphNodes }),
    owner: buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
      docIds,
      plan,
      question,
      retrievalPlan: null,
      selectedSkills: harness.skills,
      sessionId,
      userId,
    }),
  });
  await harness.agentRunService.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });
  const claim = await harness.agentRunService.claimExecutionGraphResume({
    accessScope,
    checkpointDigest: checkpoint.digest,
    runId,
  });
  assert.equal(claim.claimed, true);
  const claimId = claim.checkpoint.resumeClaim.claimId;
  const lifecycle = createAgentRunStepLifecycle({ accessScope, agentRunService: harness.agentRunService, runId });
  await lifecycle.startGraphStep({
    expectedResumeClaimId: claimId,
    id: "custom_skill:compare",
    input: { docIds, nodeId: "compare", question, skillId: "compare_documents" },
    label: "Compare",
    type: "custom_skill",
  });

  await assert.rejects(
    lifecycle.completeGraphStep({ expectedResumeClaimId: null, id: "custom_skill:compare" }),
    { code: "AGENT_GRAPH_EXECUTION_FENCED", status: 409 }
  );
  await lifecycle.completeGraphStep({
    expectedResumeClaimId: claimId,
    id: "custom_skill:compare",
    output: { citationCount: 1 },
  });
  const stored = await harness.agentRunService.getRun({ accessScope, runId });
  assert.equal(stored.steps[0].status, "completed");
});

test("an active original graph step atomically prevents a startup claim", async () => {
  const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
  const entered = deferred();
  const release = deferred();
  const originalExecute = harness.skills[0].execute;
  harness.skills[0].execute = async (context) => {
    entered.resolve();
    await release.promise;
    return originalExecute(context);
  };

  const originalRun = harness.runStage();
  await entered.promise;
  const loaded = await harness.agentRunService.getExecutionGraphCheckpoint({ accessScope, runId });
  assert.deepEqual(loaded.steps.map((step) => step.status), ["running"]);

  const claim = await harness.agentRunService.claimExecutionGraphResume({
    accessScope,
    checkpointDigest: loaded.checkpoint.digest,
    runId,
  });
  assert.equal(claim.claimed, false);
  await assert.rejects(
    harness.agentRunService.failRun({
      accessScope,
      error: new Error("competing request failed"),
      runId,
    }),
    { code: "AGENT_RUN_ACTIVE_STEP_CONFLICT", status: 409 }
  );
  assert.equal(
    (await harness.agentRunService.getRun({ accessScope, runId })).status,
    "running",
    "a second request cannot fail the run while a graph Skill is in flight"
  );

  release.resolve();
  await originalRun;
  assert.deepEqual(harness.calls.map((call) => call.id), [
    "compare_documents",
    "risk_review",
  ]);
});

test("a startup claim fences an original worker before its next Skill call", async () => {
  const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
  const checkpointSaved = deferred();
  const releaseOriginal = deferred();
  const originalRun = harness.runStage({
    save: async (checkpoint) => {
      await harness.agentRunService.saveExecutionGraphCheckpoint({
        accessScope,
        checkpoint,
        runId,
      });
      if (checkpoint.nodeRuns.length === 0) {
        checkpointSaved.resolve();
        await releaseOriginal.promise;
      }
    },
  });

  await checkpointSaved.promise;
  const loaded = await harness.agentRunService.getExecutionGraphCheckpoint({ accessScope, runId });
  const claim = await harness.agentRunService.claimExecutionGraphResume({
    accessScope,
    checkpointDigest: loaded.checkpoint.digest,
    runId,
  });
  assert.equal(claim.claimed, true);

  releaseOriginal.resolve();
  await assert.rejects(originalRun, { code: "AGENT_GRAPH_EXECUTION_FENCED" });
  assert.deepEqual(harness.calls, []);
  assert.deepEqual((await harness.agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runId,
  })).steps, []);
  await assert.rejects(harness.runStage(), {
    code: "AGENT_GRAPH_EXECUTION_FENCED",
  });

  const resumed = await harness.runStage({
    expectedGraphResumeClaimId: claim.checkpoint.resumeClaim.claimId,
  });
  assert.equal(resumed.length, 2);
  assert.deepEqual(harness.calls.map((call) => call.id), [
    "compare_documents",
    "risk_review",
  ]);
});

test("full agent request loses a claim-before-step race without failing the recovery worker", async () => {
  await withGuardedGraph(async () => {
    const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
    const checkpointSaved = deferred();
    const releaseOriginal = deferred();
    const originalSave = harness.agentRunService.saveExecutionGraphCheckpoint.bind(
      harness.agentRunService
    );
    harness.agentRunService.saveExecutionGraphCheckpoint = async (args) => {
      const saved = await originalSave(args);
      if (args.checkpoint.phase === "running" && args.checkpoint.nodeRuns.length === 0) {
        checkpointSaved.resolve();
        await releaseOriginal.promise;
      }
      return saved;
    };

    const original = runFullGraph(harness);
    await checkpointSaved.promise;
    const loaded = await harness.agentRunService.getExecutionGraphCheckpoint({
      accessScope,
      runId,
    });
    const claim = await harness.agentRunService.claimExecutionGraphResume({
      accessScope,
      checkpointDigest: loaded.checkpoint.digest,
      runId,
    });
    assert.equal(claim.claimed, true);
    await assert.rejects(
      harness.agentRunService.completeRun({ accessScope, runId }),
      { code: "AGENT_GRAPH_EXECUTION_FENCED", status: 409 }
    );
    await assert.rejects(
      harness.agentRunService.failRun({ accessScope, error: new Error("stale"), runId }),
      { code: "AGENT_GRAPH_EXECUTION_FENCED", status: 409 }
    );

    releaseOriginal.resolve();
    await assert.rejects(original, {
      code: "AGENT_GRAPH_EXECUTION_FENCED",
      status: 409,
    });
    const pending = await harness.agentRunService.getRun({ accessScope, runId });
    assert.equal(pending.status, "running");
    assert.equal(pending.events.some((event) => event.type === "run_failed"), false);
    assert.equal(pending.events.some((event) => event.type === "skill_graph_planned"), false);
    assert.deepEqual(harness.calls, []);
    assert.equal(
      (await harness.agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }))
        .checkpoint.digest,
      claim.checkpoint.digest
    );

    const resumed = await resumeFullGraph(harness, claim.checkpoint);
    assert.equal(resumed.status, 200);
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "completed");
    assert.deepEqual(harness.calls.map((call) => call.id), [
      "compare_documents",
      "risk_review",
    ]);
  });
});

test("ordinary re-entry cannot join a live or claimed graph run", async () => {
  await withGuardedGraph(async () => {
    const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
    const checkpointSaved = deferred();
    const releaseOriginal = deferred();
    const originalSave = harness.agentRunService.saveExecutionGraphCheckpoint.bind(
      harness.agentRunService
    );
    harness.agentRunService.saveExecutionGraphCheckpoint = async (args) => {
      const saved = await originalSave(args);
      if (args.checkpoint.phase === "running" && args.checkpoint.nodeRuns.length === 0) {
        checkpointSaved.resolve();
        await releaseOriginal.promise;
      }
      return saved;
    };

    const original = runFullGraph(harness);
    await checkpointSaved.promise;
    const currentSnapshot = await harness.agentRunService.getRun({ accessScope, runId });
    await assert.rejects(
      harness.agentRunService.updateRun({
        accessScope,
        graphReentryGuard: true,
        patch: {
          input: currentSnapshot.input,
          plan: currentSnapshot.plan,
          status: "running",
        },
        runId,
      }),
      { code: "AGENT_GRAPH_EXECUTION_FENCED", status: 409 }
    );
    assert.deepEqual(
      await harness.agentRunService.getRun({ accessScope, runId }),
      currentSnapshot,
      "even a matching ordinary request cannot join a possibly live graph worker"
    );
    await assert.rejects(runFullGraph(harness), {
      code: "AGENT_GRAPH_EXECUTION_FENCED",
      status: 409,
    });
    assert.deepEqual(
      await harness.agentRunService.getRun({ accessScope, runId }),
      currentSnapshot,
      "a matching full request cannot enter the same live graph"
    );
    const beforeMismatch = await harness.agentRunService.getRun({ accessScope, runId });
    await assert.rejects(
      runFullGraph(harness, {
        requestDocIds: ["doc-b", "doc-a"],
        requestIntentId: AGENT_INTENT_IDS.compareDocuments,
        requestQuestion: "Changed request",
        requestSessionId: "changed-session",
      }),
      { code: "AGENT_GRAPH_EXECUTION_FENCED", status: 409 }
    );
    assert.deepEqual(
      await harness.agentRunService.getRun({ accessScope, runId }),
      beforeMismatch,
      "a changed request cannot overwrite the checkpoint owner's input, plan, or events"
    );

    const loaded = await harness.agentRunService.getExecutionGraphCheckpoint({
      accessScope,
      runId,
    });
    const claim = await harness.agentRunService.claimExecutionGraphResume({
      accessScope,
      checkpointDigest: loaded.checkpoint.digest,
      runId,
    });
    assert.equal(claim.claimed, true);
    const afterClaim = await harness.agentRunService.getRun({ accessScope, runId });
    await assert.rejects(runFullGraph(harness), {
      code: "AGENT_GRAPH_EXECUTION_FENCED",
      status: 409,
    });
    assert.deepEqual(
      await harness.agentRunService.getRun({ accessScope, runId }),
      afterClaim,
      "the claimed run cannot gain a run_resumed event or a changed plan/input"
    );
    assert.equal(
      (await harness.agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }))
        .checkpoint.digest,
      claim.checkpoint.digest
    );

    releaseOriginal.resolve();
    await assert.rejects(original, { code: "AGENT_GRAPH_EXECUTION_FENCED" });
    const resumed = await resumeFullGraph(harness, claim.checkpoint);
    assert.equal(resumed.status, 200);
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "completed");
    assert.deepEqual(harness.calls.map((call) => call.id), [
      "compare_documents",
      "risk_review",
    ]);
  });
});

test("identical checkpoint creation admits only one graph worker", async () => {
  await withGuardedGraph(async () => {
    const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
    const firstAtCheckpoint = deferred();
    const secondAtCheckpoint = deferred();
    const releaseWinner = deferred();
    const originalSave = harness.agentRunService.saveExecutionGraphCheckpoint.bind(
      harness.agentRunService
    );
    let initialArrivals = 0;
    harness.agentRunService.saveExecutionGraphCheckpoint = async (args) => {
      if (args.checkpoint.phase !== "running" || args.checkpoint.nodeRuns.length !== 0) {
        return originalSave(args);
      }

      const arrival = ++initialArrivals;
      if (arrival === 1) firstAtCheckpoint.resolve();
      if (arrival === 2) secondAtCheckpoint.resolve();
      await secondAtCheckpoint.promise;

      if (arrival === 1) {
        const saved = await originalSave(args);
        await releaseWinner.promise;
        return saved;
      }

      return originalSave(args);
    };

    const delayedWorker = runFullGraph(harness);
    await firstAtCheckpoint.promise;
    const executingWorker = runFullGraph(harness);

    try {
      const response = await executingWorker;
      assert.equal(response.status, 200);
      const stored = await harness.agentRunService.getRun({ accessScope, runId });
      assert.equal(stored.status, "completed");
    } finally {
      releaseWinner.resolve();
    }

    await assert.rejects(delayedWorker, {
      code: "AGENT_GRAPH_EXECUTION_FENCED",
      status: 409,
    });
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "completed");
    assert.deepEqual(harness.calls.map((call) => call.id), [
      "compare_documents",
      "risk_review",
    ]);
  });
});

test("claim racing final checkpoint save fences the old request and reuses settled Skills", async () => {
  await withGuardedGraph(() => withAgentExperienceMemoryEnabled(async () => {
    const experienceStore = createInMemoryAgentExperienceStore();
    configureAgentExperienceMemoryStore(experienceStore);
    const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
    const completedSaveEntered = deferred();
    const releaseSave = deferred();
    const originalSave = harness.agentRunService.saveExecutionGraphCheckpoint.bind(
      harness.agentRunService
    );
    harness.agentRunService.saveExecutionGraphCheckpoint = async (args) => {
      if (args.checkpoint.phase === "completed") {
        completedSaveEntered.resolve();
        await releaseSave.promise;
      }
      return originalSave(args);
    };

    const original = runFullGraph(harness);
    await completedSaveEntered.promise;
    const loaded = await harness.agentRunService.getExecutionGraphCheckpoint({
      accessScope,
      runId,
    });
    assert.equal(loaded.checkpoint.phase, "running");
    assert.deepEqual(loaded.steps.map((step) => step.status), ["completed", "completed"]);
    const claim = await harness.agentRunService.claimExecutionGraphResume({
      accessScope,
      checkpointDigest: loaded.checkpoint.digest,
      runId,
    });
    assert.equal(claim.claimed, true);

    releaseSave.resolve();
    await assert.rejects(original, { code: "AGENT_GRAPH_EXECUTION_FENCED" });
    const pending = await harness.agentRunService.getRun({ accessScope, runId });
    assert.equal(pending.status, "running");
    assert.equal(pending.events.some((event) => event.type === "run_failed"), false);
    assert.deepEqual(harness.calls.map((call) => call.id), [
      "compare_documents",
      "risk_review",
    ]);
    assert.equal(experienceStore.snapshot().length, 0);
    assert.equal(
      (await harness.agentRunService.getExecutionGraphCheckpoint({ accessScope, runId }))
        .checkpoint.digest,
      claim.checkpoint.digest
    );
    const resumed = await resumeFullGraph(harness, claim.checkpoint);
    assert.equal(resumed.status, 200);
    assert.equal((await harness.agentRunService.getRun({ accessScope, runId })).status, "completed");
    assert.equal(harness.calls.length, 2, "a completed write must not be replayed");
  }));
});

test("terminal graph checkpoint refuses a competing claim without changing experience behavior", async () => {
  await withGuardedGraph(() => withAgentExperienceMemoryEnabled(async () => {
    const experienceStore = createInMemoryAgentExperienceStore();
    configureAgentExperienceMemoryStore(experienceStore);
    const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
    const finalizationEntered = deferred();
    const releaseFinalization = deferred();
    const originalComplete = harness.agentRunService.completeRun.bind(
      harness.agentRunService
    );
    harness.agentRunService.completeRun = async (args) => {
      finalizationEntered.resolve();
      await releaseFinalization.promise;
      return originalComplete(args);
    };

    const original = runFullGraph(harness);
    await finalizationEntered.promise;
    const loaded = await harness.agentRunService.getExecutionGraphCheckpoint({
      accessScope,
      runId,
    });
    assert.equal(loaded.checkpoint.phase, "completed");
    const claim = await harness.agentRunService.claimExecutionGraphResume({
      accessScope,
      checkpointDigest: loaded.checkpoint.digest,
      runId,
    });
    assert.equal(claim.claimed, false);

    releaseFinalization.resolve();
    const response = await original;
    const finished = await harness.agentRunService.getRun({ accessScope, runId });
    assert.equal(finished.status, "completed");
    assert.equal(experienceStore.snapshot().length, 0);
    assert.deepEqual(harness.calls.map((call) => call.id), [
      "compare_documents",
      "risk_review",
    ]);
    assert.equal(response.body.agentObservability.experienceMemory.write.status, "skipped");
    assert.equal(response.body.agentObservability.experienceMemory.write.skippedReason, "no_records");
    assert.equal(finished.result.agentObservability, undefined);
  }));
});

test("a missing durable node-start receipt fails closed before a Skill call", async () => {
  const harness = await createHarness({ effects: SKILL_EFFECTS.workspaceWrite });
  await assert.rejects(
    harness.runStage({
      stepLifecycle: { startGraphStep: async () => null },
    }),
    { code: "AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE" }
  );
  assert.deepEqual(harness.calls, []);
});

test("private graph checkpoint is absent from all public run projections", async () => {
  const harness = await createHarness();
  await harness.runStage();
  const raw = await harness.store.get({ accessScope, runId });
  const publicRun = await harness.agentRunService.getRun({ accessScope, runId });
  const listed = await harness.agentRunService.listRuns({ accessScope });
  const recoverable = await harness.agentRunService.listRecoverableRuns({
    includeAccessScope: true,
  });

  assert.ok(raw.result.__skillGraphCheckpoint);
  assert.equal(publicRun.result.__skillGraphCheckpoint, undefined);
  assert.equal(listed.runs[0].result.__skillGraphCheckpoint, undefined);
  assert.equal(recoverable.runs[0].result.__skillGraphCheckpoint, undefined);
  assert.ok((await harness.agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runId,
  })).checkpoint);
  await assert.rejects(
    harness.agentRunService.updateRun({
      accessScope,
      runId,
      patch: { result: { __skillGraphCheckpoint: { forged: true } } },
    }),
    { code: "AGENT_GRAPH_CHECKPOINT_PRIVATE_FIELD" }
  );
});
