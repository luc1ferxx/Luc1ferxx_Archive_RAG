import { applyExperienceHintsToCandidates } from "./agent-intent-memory-hints.js";
import {
  deterministicIntentPlannerAdapter,
  llmIntentPlannerAdapter,
} from "./agent-intent-llm-adapter.js";
import {
  buildIntentPlanCandidates,
} from "./agent-intent-rules.js";
import {
  buildPlannerSelection,
  normalizePlannerId,
  resolveSelectedCandidate,
  serializePlannerError,
} from "./agent-intent-validator.js";
import { getPlannerRolloutMode } from "./agent-planner-rollout.js";

export {
  applyExperienceHintsToCandidates,
  normalizeExperienceHints,
} from "./agent-intent-memory-hints.js";
export {
  buildIntentPlannerPrompt,
  deterministicIntentPlannerAdapter,
  llmIntentPlannerAdapter,
  parseIntentPlannerJson,
} from "./agent-intent-llm-adapter.js";
export {
  AGENT_INTENT_IDS,
  buildIntentPlanCandidate,
  buildIntentPlanCandidates,
  buildPlan,
  detectPlanSignals,
} from "./agent-intent-rules.js";
export {
  buildPlannerSelection,
  compactPlanCandidate,
  normalizeIntentSelection,
  normalizeIntentText,
  normalizePlannerId,
  resolveSelectedCandidate,
  serializePlannerError,
} from "./agent-intent-validator.js";

export const createAgentIntentPlanResult = async ({
  candidates: providedCandidates,
  docIds = [],
  experienceMemory = {},
  fallbackPlannerAdapter = deterministicIntentPlannerAdapter,
  plannerAdapter = fallbackPlannerAdapter,
  question,
  taskMemory = null,
} = {}) => {
  const candidates = applyExperienceHintsToCandidates({
    candidates: providedCandidates ?? buildIntentPlanCandidates({
      docIds,
      question,
    }),
    docIds,
    experienceMemory,
    question,
  });
  const fallbackPlannerId = normalizePlannerId(fallbackPlannerAdapter);
  const requestedPlannerId = normalizePlannerId(plannerAdapter);
  const rolloutMode = getPlannerRolloutMode(plannerAdapter);
  const withRolloutMetadata = (planner = {}) =>
    rolloutMode
      ? {
          ...planner,
          rolloutMode,
        }
      : planner;
  const createFallbackResult = async () => {
    const selection = await fallbackPlannerAdapter.selectIntentPlan({
      candidates,
      docIds,
      question,
      taskMemory,
    });
    const fallbackSelection = resolveSelectedCandidate({
      candidates,
      selection,
    });

    return {
      plan: fallbackSelection.selectedCandidate.plan,
      planner: buildPlannerSelection({
        candidates,
        experienceMemory,
        modelRoute: fallbackSelection.modelRoute,
        promptTemplate: fallbackSelection.promptTemplate,
        requestedPlannerId: fallbackPlannerId,
        selectedCandidate: fallbackSelection.selectedCandidate,
        selectedPlannerId: fallbackPlannerId,
        selectionReason: fallbackSelection.selectionReason,
      }),
    };
  };
  const attachRolloutMode = ({ plan, planner }) => ({
    plan,
    planner: withRolloutMetadata(planner),
  });

  if (!plannerAdapter || plannerAdapter === fallbackPlannerAdapter) {
    return attachRolloutMode(await createFallbackResult());
  }

  try {
    const selection = await plannerAdapter.selectIntentPlan({
      candidates,
      docIds,
      experienceMemory,
      question,
      taskMemory,
    });
    const selected = resolveSelectedCandidate({
      candidates,
      selection,
    });

    return attachRolloutMode({
      plan: selected.selectedCandidate.plan,
      planner: buildPlannerSelection({
        candidates,
        experienceMemory,
        modelRoute: selected.modelRoute,
        promptTemplate: selected.promptTemplate,
        requestedPlannerId,
        selectedCandidate: selected.selectedCandidate,
        selectedPlannerId: requestedPlannerId,
        selectionReason: selected.selectionReason,
      }),
    });
  } catch (error) {
    const fallbackResult = await createFallbackResult();

    return attachRolloutMode({
      plan: fallbackResult.plan,
      planner: {
        ...fallbackResult.planner,
        fallback: true,
        fallbackReason: serializePlannerError(error),
        requestedPlannerId,
        selectedPlannerId: fallbackPlannerId,
        status: "fallback",
      },
    });
  }
};
