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
import {
  createPlannerFallbackCase,
  createPrivacySanitizationCase,
} from "./planner-privacy.js";
import {
  createApprovalResumeCase,
  createCustomSkillRetryCase,
  createWebApprovalDenyCase,
} from "./run-control.js";

export const createDefaultTrajectoryCases = () => [
  createSkillChainCase(),
  createFollowUpCase(),
  createClarificationCase(),
  createAccessScopeCase(),
  createBudgetCase(),
  createApprovalResumeCase(),
  createCustomSkillRetryCase(),
  createMemoryNotEvidenceCase(),
  createWebApprovalDenyCase(),
  createMultiDocConflictCase(),
  createPlannerFallbackCase(),
  createPrivacySanitizationCase(),
];
