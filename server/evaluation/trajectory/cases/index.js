import {
  createAccessScopeCase,
  createBudgetCase,
  createClarificationCase,
  createFollowUpCase,
  createSkillChainCase,
} from "./core-flow.js";
import {
  createMemoryNotEvidenceCase,
  createMultiDocConflictCase,
} from "./evidence-memory.js";
import { createGoalLifecycleCase } from "./goal-lifecycle.js";
import {
  createPlannerFallbackCase,
  createPrivacySanitizationCase,
} from "./planner-privacy.js";
import {
  createApprovalResumeCase,
  createWebApprovalDenyCase,
} from "./run-control.js";
import {
  createSkillGraphBoundedReplanCase,
  createSkillGraphGuardedExecutionCase,
  createSkillGraphIllegalPlanCase,
} from "./skill-graph.js";

export const createDefaultTrajectoryCases = () => [
  createSkillChainCase(),
  createFollowUpCase(),
  createClarificationCase(),
  createAccessScopeCase(),
  createBudgetCase(),
  createApprovalResumeCase(),
  createMemoryNotEvidenceCase(),
  createWebApprovalDenyCase(),
  createMultiDocConflictCase(),
  createPlannerFallbackCase(),
  createPrivacySanitizationCase(),
  createGoalLifecycleCase(),
  createSkillGraphGuardedExecutionCase(),
  createSkillGraphIllegalPlanCase(),
  createSkillGraphBoundedReplanCase(),
];
