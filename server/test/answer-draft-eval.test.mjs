import test from "node:test";
import assert from "node:assert/strict";
import {
  createDagPlannerAdapter,
  createExecutionPlannerAdapter,
  createIntentPlannerAdapter,
  createReplanAdapter,
} from "../app-services.js";
import { DAG_PLANNER_IDS } from "../rag/agent-dag-planner-adapter.js";
import { withEnvironmentOverrides } from "../evaluation/agent-eval-harness.js";
import { createDraftEvalPlanners } from "../evaluation/run-answer-draft-eval.mjs";

// eval:answer-drafts plans as /chat does. Until 2026-11-20 it passed
// runAgentRag no planners, so every case planned with the rules whatever
// AGENT_PLANNER_ROLLOUT said, and its timings had no LLM planning in them.

test("eval:answer-drafts runs with the four planners /chat builds and records AGENT_PLANNER_ROLLOUT", async () => {
  // As createAppServices builds them for buildChatResponse.
  const appPlanners = () => {
    const dagPlannerAdapter = createDagPlannerAdapter();

    return {
      dagPlannerAdapter,
      executionPlannerAdapter: createExecutionPlannerAdapter(),
      intentPlannerAdapter: createIntentPlannerAdapter(),
      replanAdapter: createReplanAdapter(dagPlannerAdapter),
    };
  };
  const ids = (planners) => [
    planners.intentPlannerAdapter.id,
    planners.executionPlannerAdapter.id,
    planners.dagPlannerAdapter.id,
  ];

  // Unset: the model plans, as /chat's default.
  await withEnvironmentOverrides({ AGENT_PLANNER_ROLLOUT: undefined }, async () => {
    const { plannerRollout, planners } = await createDraftEvalPlanners();

    assert.equal(plannerRollout, "llm");
    assert.deepEqual(planners, appPlanners());
    assert.deepEqual(ids(planners), ["llm", "llm", DAG_PLANNER_IDS.llm]);
  });

  // deterministic: the rules, as every run before this change, and no replanner.
  await withEnvironmentOverrides({ AGENT_PLANNER_ROLLOUT: "deterministic" }, async () => {
    const { plannerRollout, planners } = await createDraftEvalPlanners();

    assert.equal(plannerRollout, "deterministic");
    assert.deepEqual(planners, appPlanners());
    assert.deepEqual(ids(planners), ["deterministic", "deterministic", DAG_PLANNER_IDS.deterministic]);
    assert.equal(planners.replanAdapter, null);
  });

  // A removed value refuses before the ingest, as it does /chat's start, and
  // so does a removed agent dial: the eval no longer pins it to guarded.
  await withEnvironmentOverrides({ AGENT_PLANNER_ROLLOUT: "shadow" }, () =>
    assert.rejects(createDraftEvalPlanners(), { code: "AGENT_PLANNER_ROLLOUT_REMOVED" })
  );
  await withEnvironmentOverrides({ AGENT_SKILL_GRAPH_ROLLOUT: "off" }, () =>
    assert.rejects(createDraftEvalPlanners(), { code: "AGENT_SKILL_GRAPH_ROLLOUT_REMOVED" })
  );
});
