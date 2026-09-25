import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import { resumeAgentExecutionGraphRun } from "../rag/agent.js";
import { runCustomSkillStage } from "../rag/agent-custom-skill-stage.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { CUSTOM_RAG_SKILL_CONTRACT } from "../rag/skills/custom/custom-skill-contract.js";
import { createSkillRegistry } from "../rag/skills/registry.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
} from "../rag/skills/skill-contract.js";

const accessScope = Object.freeze({
  userId: "recovery-eval-user",
  workspaceId: "recovery-eval-workspace",
});
const runId = "recovery-eval-graph-resume";
const question = "Compare document A and B for risk.";
const docIds = Object.freeze(["doc-a", "doc-b"]);
const sessionId = "recovery-eval-graph-session";
const requestBinding = (field) => ({ source: "request", field });

const graphNodes = Object.freeze([
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
      priorFindings: { source: "node", nodeId: "compare", output: "text" },
      question: requestBinding("question"),
    },
    nodeId: "risk",
    skillId: "risk_review",
  },
]);

const countEvents = (events, type) =>
  events.filter((event) => event.type === type).length;

// This is a production-continuation-path probe, not a report fixture. It
// writes a partial checkpoint, re-instantiates the services over the same
// in-memory store, then invokes the application's startup recovery API. It
// does not prove OS process restart or PostgreSQL durability. Assertions fail
// the eval before any observation event can be emitted.
export const buildProductionGraphStartupResumeEvents = async () => {
  const calls = [];
  const createSkill = ({ id, effects = SKILL_EFFECTS.readOnly }) => ({
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
    idempotency: effects === SKILL_EFFECTS.readOnly
      ? SKILL_IDEMPOTENCY.readOnlyRag
      : SKILL_IDEMPOTENCY.nondeterministic,
    kind: "custom",
    label: id,
    match: () => true,
    parallelSafe: effects === SKILL_EFFECTS.readOnly,
    replaySafe: effects === SKILL_EFFECTS.readOnly,
    requiresAccessScope: true,
    retryable: effects === SKILL_EFFECTS.readOnly,
    version: "1.0.0",
  });
  const skills = [
    createSkill({ id: "compare_documents", effects: SKILL_EFFECTS.workspaceWrite }),
    createSkill({ id: "risk_review" }),
  ];
  const registry = createSkillRegistry(skills);
  const store = createInMemoryAgentRunStore();
  const firstService = createAgentRunService({ agentRunStore: store });
  const plan = { mode: SKILL_CHAIN_MODE };

  await firstService.createRun({
    accessScope,
    goal: question,
    input: { docIds, sessionId, userId: accessScope.userId },
    plan: {
      mode: plan.mode,
      selectedSkills: skills.map((skill) => ({
        skillId: skill.id,
        skillVersion: skill.version,
      })),
    },
    runId,
  });
  await firstService.appendRunEvent({
    accessScope,
    runId,
    type: "execution_planned",
    payload: { planner: { stepIds: ["custom_skills"] } },
  });

  const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  let interrupted = false;

  await assert.rejects(
    runCustomSkillStage({
      accessScope,
      authorizedCustomSkills: skills,
      authorizedDocIds: docIds,
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      customSkills: skills,
      docIds,
      executeObservedSkill: tracker.executeObservedSkill,
      loadExecutionGraphCheckpoint: () =>
        firstService.getExecutionGraphCheckpoint({ accessScope, runId }),
      mode: "guarded",
      plan,
      plannerAdapter: {
        createExecutionGraph: () => ({ nodes: graphNodes }),
        id: "recovery_eval_graph_planner",
      },
      question,
      ragService: {},
      recordSkillResult: tracker.recordSkillResult,
      recordSkippedSkill: tracker.recordSkippedSkill,
      registry,
      saveExecutionGraphCheckpoint: async (checkpoint) => {
        await firstService.saveExecutionGraphCheckpoint({
          accessScope,
          checkpoint,
          runId,
        });
        if (!interrupted && checkpoint.nodeRuns.length === 1) {
          interrupted = true;
          throw new Error("simulated process exit after graph checkpoint");
        }
      },
      sessionId,
      stepLifecycle: createAgentRunStepLifecycle({
        accessScope,
        agentRunService: firstService,
        runId,
      }),
      userId: accessScope.userId,
    }),
    /simulated process exit after graph checkpoint/
  );

  const before = await firstService.getExecutionGraphCheckpoint({
    accessScope,
    runId,
  });
  assert.deepEqual(before.checkpoint.nodeRuns.map((node) => node.nodeId), ["compare"]);
  assert.deepEqual(calls.map((call) => call.id), ["compare_documents"]);
  assert.deepEqual(before.steps.map((step) => step.status), ["completed"]);

  // Reinstantiation is the process boundary: only the persisted store remains.
  const restartedService = createAgentRunService({ agentRunStore: store });
  const recoveryTraces = [];
  const recovery = createAgentRunRecoveryService({
    agentRunService: restartedService,
    recordRecoveryTrace: async (event) => recoveryTraces.push(event),
    resumeExecutionGraph: (args) =>
      resumeAgentExecutionGraphRun({
        ...args,
        agentRunService: restartedService,
        ragService: {
          getDocument: (docId, scope) =>
            docIds.includes(docId) &&
            scope?.userId === accessScope.userId &&
            scope?.workspaceId === accessScope.workspaceId
              ? { docId }
              : null,
        },
        skillRegistry: registry,
      }),
  });

  const firstRecovery = await recovery.recoverOnStartup({ mode: "auto" });
  const completed = await restartedService.getRun({ accessScope, runId });
  const checkpoint = await restartedService.getExecutionGraphCheckpoint({
    accessScope,
    runId,
  });
  const secondRecovery = await recovery.recoverOnStartup({ mode: "auto" });
  const afterSecond = await restartedService.getRun({ accessScope, runId });
  const compareCallCount = calls.filter((call) => call.id === "compare_documents").length;
  const riskCallCount = calls.filter((call) => call.id === "risk_review").length;
  const claimCount = countEvents(afterSecond.events, "skill_graph_resume_claimed");
  const completedCount = afterSecond.events.filter(
    (event) =>
      event.type === "auto_recovery_completed" &&
      event.payload?.type === "execution_graph"
  ).length;
  const failedCount = countEvents(afterSecond.events, "auto_recovery_failed");
  const manualCount = countEvents(afterSecond.events, "manual_recovery_required");
  const partialFallbackCount = afterSecond.events.filter(
    (event) =>
      event.type === "skill_graph_planned" &&
      Boolean(event.payload?.fallback) &&
      (event.payload?.nodeRuns?.length ?? 0) > 0
  ).length;
  const completedGraphEvent = afterSecond.events.find(
    (event) => event.type === "skill_graph_planned"
  );

  assert.equal(firstRecovery.autoRecoveredCount, 1);
  assert.equal(firstRecovery.failedCount, 0);
  assert.equal(firstRecovery.manualRecoveredCount, 0);
  assert.equal(secondRecovery.autoRecoveredCount, 0);
  assert.equal(secondRecovery.failedCount, 0);
  assert.equal(secondRecovery.manualRecoveredCount, 0);
  assert.equal(completed.status, "completed");
  assert.equal(afterSecond.status, "completed");
  assert.equal(completed.runId, runId);
  assert.equal(checkpoint.checkpoint.phase, "completed");
  assert.ok(checkpoint.checkpoint.resumeClaim?.claimId);
  assert.equal(compareCallCount, 1);
  assert.equal(riskCallCount, 1);
  assert.equal(calls[1].priorFindings, "compare_documents result");
  assert.equal(claimCount, 1);
  assert.equal(completedCount, 1);
  assert.equal(failedCount, 0);
  assert.equal(manualCount, 0);
  assert.equal(partialFallbackCount, 0);
  assert.equal(completedGraphEvent?.payload?.mode, "guarded");
  assert.equal(completedGraphEvent?.payload?.executed, true);
  assert.equal(completedGraphEvent?.payload?.fallback, null);
  assert.deepEqual(
    completedGraphEvent?.payload?.nodeRuns.map((node) => [node.nodeId, node.status]),
    [["compare", "reused"], ["risk", "completed"]]
  );

  return [
    ...recoveryTraces,
    ...afterSecond.events.map((event) => ({ ...event, runId })),
    {
      traceType: "agent_graph_resume_eval",
      eventType: "graph_startup_resume_observed",
      runId,
      sameRunCompleted: completed.runId === runId && afterSecond.runId === runId,
      completedNodeNotRerun: compareCallCount === 1,
      pendingNodeExecutedOnce: riskCallCount === 1,
      secondClaimCount: claimCount - 1,
      partialFallbackCount,
    },
  ];
};
