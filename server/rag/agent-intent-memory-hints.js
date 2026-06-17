import {
  AGENT_INTENT_IDS,
  buildIntentPlanCandidate,
  detectPlanSignals,
} from "./agent-intent-rules.js";
import { normalizeIntentText } from "./agent-intent-validator.js";

const ALLOWED_EXPERIENCE_INTENT_IDS = new Set(Object.values(AGENT_INTENT_IDS));

export const normalizeExperienceHints = (experienceMemory = {}) =>
  Array.isArray(experienceMemory.planningHints)
    ? experienceMemory.planningHints
        .map((hint) => ({
          confidence: Number.isFinite(Number(hint.confidence))
            ? Number(hint.confidence)
            : 0,
          intentId: normalizeIntentText(hint.intentId),
          mode: normalizeIntentText(hint.mode),
          score: Number.isFinite(Number(hint.score)) ? Number(hint.score) : 0,
          skillChain: Array.isArray(hint.skillChain) ? hint.skillChain : [],
          suggestedActions: Array.isArray(hint.suggestedActions)
            ? hint.suggestedActions.map(normalizeIntentText).filter(Boolean)
            : [],
          text: normalizeIntentText(hint.text),
          type: normalizeIntentText(hint.type),
        }))
        .filter(
          (hint) =>
            hint.intentId &&
            ALLOWED_EXPERIENCE_INTENT_IDS.has(hint.intentId) &&
            hint.confidence >= 0.45
        )
    : [];

const getCandidateExperienceScore = ({ candidate, hints = [] } = {}) =>
  hints
    .filter((hint) => hint.intentId === candidate.id)
    .reduce((score, hint) => score + hint.score + hint.confidence, 0);

export const applyExperienceHintsToCandidates = ({
  candidates = [],
  docIds = [],
  experienceMemory = {},
  question,
} = {}) => {
  const hints = normalizeExperienceHints(experienceMemory);

  if (hints.length === 0) {
    return candidates;
  }

  const signals = detectPlanSignals({
    docIds,
    question,
  });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  for (const hint of hints) {
    if (byId.has(hint.intentId)) {
      continue;
    }

    byId.set(
      hint.intentId,
      buildIntentPlanCandidate({
        intentId: hint.intentId,
        reason: "Agent experience memory suggested this whitelisted intent.",
        signals,
      })
    );
  }

  return [...byId.values()]
    .map((candidate, index) => ({
      ...candidate,
      experienceScore: getCandidateExperienceScore({
        candidate,
        hints,
      }),
      originalIndex: index,
    }))
    .sort(
      (left, right) =>
        right.experienceScore - left.experienceScore ||
        left.originalIndex - right.originalIndex
    )
    .map(({ experienceScore, originalIndex, ...candidate }) =>
      experienceScore > 0
        ? {
            ...candidate,
            experienceScore,
            reason: `${candidate.reason} Experience hint score: ${Number(
              experienceScore.toFixed(4)
            )}.`,
          }
        : candidate
    );
};
