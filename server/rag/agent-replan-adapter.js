import { parsePlannerJson } from "./agent-dag-planner-adapter.js";
import { buildReplannerPrompt } from "./agent-replanner.js";
import { completeTextWithMetadata } from "./openai.js";
import { MODEL_CAPABILITIES, MODEL_ROUTE_IDS } from "./model-providers/index.js";

// The model half of a replan.
//
// It is deliberately tiny: build the prompt from the redacted replan context,
// ask for JSON, parse it. Everything that decides whether the answer is
// allowed to take effect -- the trigger, the replan bound, the fingerprint
// check, scope, whitelist, budget, and the validator -- lives in
// agent-replanner.js and runs after this returns.
//
// Replanning is execution planning, so it uses the execution planner route
// rather than a route of its own. A separate route would be a second place to
// misconfigure which model is allowed to shape a plan.

export const REPLAN_ADAPTER_IDS = Object.freeze({
  llm: "llm_replan",
});

export const replanAdapter = {
  createPatch: async (replanContext = {}) => {
    const completion = await completeTextWithMetadata(
      buildReplannerPrompt(replanContext),
      {
        capability: MODEL_CAPABILITIES.executionPlanner,
        routeId: MODEL_ROUTE_IDS.executionPlannerDefault,
      }
    );

    return parsePlannerJson(completion.text);
  },
  id: REPLAN_ADAPTER_IDS.llm,
};
