import { normalizeText } from "../lib/normalize-text.js";

export const withPlannerRollout = (plannerAdapter, rolloutMode) =>
  plannerAdapter
    ? {
        ...plannerAdapter,
        rolloutMode: normalizeText(rolloutMode),
      }
    : plannerAdapter;

export const getPlannerRolloutMode = (plannerAdapter) =>
  normalizeText(plannerAdapter?.rolloutMode);
