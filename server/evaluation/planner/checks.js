import {
  buildPlannerResponseSummary as buildCaseResponseSummary,
} from "../chat-response-contract.js";
import {
  buildCheck,
  createAccessScopeMatcher,
  createCaseFinisher,
  runCaseSafely as runEvalCaseSafely,
} from "../agent-eval-harness.js";

export const DEFAULT_ACCESS_SCOPE = {
  userId: "planner-user",
  workspaceId: "planner-workspace",
};

export const CATEGORY_LABELS = {
  execution: "Execution",
  fallback: "Fallback",
  observability: "Observability",
  planner: "Planner",
  validator: "Validator",
};

export const samePlannerScope = createAccessScopeMatcher(DEFAULT_ACCESS_SCOPE);

export const finishPlannerCase = createCaseFinisher({
  buildResponseSummary: buildCaseResponseSummary,
});

export const buildPlannerCheck = buildCheck;

export const runPlannerCaseSafely = (caseDefinition) =>
  runEvalCaseSafely(caseDefinition, {
    errorCategory: "execution",
    finishCase: finishPlannerCase,
  });
