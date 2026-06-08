import {
  createExtractTimelineSkill,
  EXTRACT_TIMELINE_SKILL_ID,
} from "./extract-timeline.js";

export const CUSTOM_SKILL_IDS = {
  extractTimeline: EXTRACT_TIMELINE_SKILL_ID,
};

export const createCustomSkills = () => [
  createExtractTimelineSkill(),
];
