import {
  buildChatResponseSummary as buildCaseResponseSummary,
} from "../chat-response-contract.js";
import {
  buildCheck,
  createAccessScopeMatcher,
  createCaseFinisher,
  runCaseSafely as runEvalCaseSafely,
} from "../agent-eval-harness.js";

export const DEFAULT_ACCESS_SCOPE = {
  userId: "trajectory-user",
  workspaceId: "trajectory-workspace",
};

export const CATEGORY_LABELS = {
  access_scope: "Access scope",
  approval: "Approval",
  budget: "Budget",
  clarification: "Clarification",
  conflict: "Conflict",
  follow_up: "Follow-up",
  memory: "Memory",
  planner: "Planner",
  privacy: "Privacy",
  retry: "Retry",
  skill_selection: "Skill selection",
};

export const sameTrajectoryScope = createAccessScopeMatcher(
  DEFAULT_ACCESS_SCOPE
);

export const finishTrajectoryCase = createCaseFinisher({
  buildResponseSummary: buildCaseResponseSummary,
});

export const buildTrajectoryCheck = buildCheck;

export const runTrajectoryCaseSafely = (caseDefinition) =>
  runEvalCaseSafely(caseDefinition, {
    errorCategory: "trajectory",
    finishCase: finishTrajectoryCase,
  });
