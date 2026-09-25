import assert from "node:assert/strict";

const EXPECTED_SKILL_IDS = Object.freeze([
  "risk_review",
  "summarize_contract",
]);

/**
 * Reconcile the persisted graph event with completed run steps, not a `/chat`
 * projection alone, to prove the runtime smoke executed the custom-skill DAG.
 * This helper performs no network I/O; the caller supplies the run service.
 */
export const loadGuardedGraphSignal = async ({ agentRunService, chat, userId }) => {
  assert.ok(chat?.agentRunId, "Runtime smoke chat must include an agent run id.");

  const run = await agentRunService.getRun({
    accessScope: { userId, workspaceId: "" },
    runId: chat.agentRunId,
  });
  const graph = (run?.events ?? []).filter(
    (event) => event.type === "skill_graph_planned"
  ).at(-1)?.payload ?? null;
  const nodeRuns = Array.isArray(graph?.nodeRuns) ? graph.nodeRuns : [];
  const persistedSkillSteps = (Array.isArray(run?.steps) ? run.steps : [])
    .filter((step) => step?.type === "custom_skill");
  const skillIds = nodeRuns.map((nodeRun) => nodeRun?.skillId).sort();
  const plannedNodeIds = Array.isArray(graph?.graph?.nodeIds)
    ? [...graph.graph.nodeIds].sort()
    : [];
  const executedNodeIds = nodeRuns.map((nodeRun) => nodeRun?.nodeId).sort();

  assert.ok(graph, "Runtime smoke must persist a skill_graph_planned event.");
  assert.equal(graph.mode, "guarded", "Runtime smoke must exercise guarded DAG.");
  assert.equal(graph.executed, true, "Runtime smoke DAG must execute.");
  assert.equal(graph.fallback, null, "Runtime smoke DAG must not fall back.");
  assert.equal(graph.status, "completed", "Runtime smoke DAG must complete.");
  assert.equal(
    graph.planner?.selectedPlannerId,
    "llm_dag",
    "Runtime smoke DAG must use the real LLM planner."
  );
  assert.deepEqual(
    skillIds,
    EXPECTED_SKILL_IDS,
    "Runtime smoke must execute exactly the authorized custom skills."
  );
  assert.deepEqual(
    executedNodeIds,
    plannedNodeIds,
    "Runtime smoke DAG node runs must match its persisted plan."
  );
  assert.equal(
    nodeRuns.every((nodeRun) => ["completed", "reused"].includes(nodeRun.status)),
    true,
    "Runtime smoke DAG nodes must all complete or reuse a completed step."
  );
  assert.deepEqual(
    persistedSkillSteps.map((step) => ({
      id: step.id,
      nodeId: step.input?.nodeId,
      skillId: step.input?.skillId,
      status: step.status,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    nodeRuns.map((nodeRun) => ({
      id: `custom_skill:${nodeRun.nodeId}`,
      nodeId: nodeRun.nodeId,
      skillId: nodeRun.skillId,
      status: "completed",
    })).sort((left, right) => left.id.localeCompare(right.id)),
    "Runtime smoke DAG node runs must match completed persisted custom skill steps."
  );

  return {
    executed: graph.executed,
    fallback: graph.fallback,
    mode: graph.mode,
    selectedPlannerId: graph.planner.selectedPlannerId,
    skillIds,
  };
};
