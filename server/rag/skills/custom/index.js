import {
  createExtractTimelineSkill,
  EXTRACT_TIMELINE_SKILL_ID,
} from "./extract-timeline.js";
import {
  createRiskReviewSkill,
  RISK_REVIEW_SKILL_ID,
} from "./risk-review.js";

export const CUSTOM_SKILL_IDS = {
  extractTimeline: EXTRACT_TIMELINE_SKILL_ID,
  riskReview: RISK_REVIEW_SKILL_ID,
};

export const createCustomSkills = () => [
  createExtractTimelineSkill(),
  createRiskReviewSkill(),
];
