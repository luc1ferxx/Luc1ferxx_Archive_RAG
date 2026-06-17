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
import {
  getPlannerRolloutMode,
  getShadowPlannerAdapter,
  runShadowPlanner,
} from "./agent-planner-shadow.js";

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
  shadowPlannerAdapter = getShadowPlannerAdapter(plannerAdapter),
  question,
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
        requestedPlannerId: fallbackPlannerId,
        selectedCandidate: fallbackSelection.selectedCandidate,
        selectedPlannerId: fallbackPlannerId,
        selectionReason: fallbackSelection.selectionReason,
      }),
      selectedCandidate: fallbackSelection.selectedCandidate,
    };
  };
  const attachShadowPlanner = async (result) => {
    const publicResult = {
      plan: result.plan,
      planner: result.planner,
    };
    const shadow = await runShadowPlanner({
      compare: ({ primary, shadow }) =>
        primary?.selectedCandidate?.id !== shadow?.selectedCandidate?.id,
      describe: (shadowResult) => ({
        selectedIntentId: shadowResult.selectedCandidate?.id ?? null,
        selectedMode: shadowResult.selectedCandidate?.plan?.mode ?? null,
        selectionReason: shadowResult.selectionReason ?? null,
      }),
      execute: async (adapter) => {
        const selection = await adapter.selectIntentPlan({
          candidates,
          docIds,
          experienceMemory,
          question,
        });

        return resolveSelectedCandidate({
          candidates,
          selection,
        });
      },
      primary: result,
      shadowPlannerAdapter,
    });

    if (!shadow) {
      return {
        ...publicResult,
        planner: withRolloutMetadata(publicResult.planner),
      };
    }

    return {
      ...publicResult,
      planner: {
        ...withRolloutMetadata(publicResult.planner),
        shadow,
      },
    };
  };

  if (!plannerAdapter || plannerAdapter === fallbackPlannerAdapter) {
    return attachShadowPlanner(await createFallbackResult());
  }

  try {
    const selection = await plannerAdapter.selectIntentPlan({
      candidates,
      docIds,
      experienceMemory,
      question,
    });
    const selected = resolveSelectedCandidate({
      candidates,
      selection,
    });

    return attachShadowPlanner({
      plan: selected.selectedCandidate.plan,
      planner: buildPlannerSelection({
        candidates,
        experienceMemory,
        requestedPlannerId,
        selectedCandidate: selected.selectedCandidate,
        selectedPlannerId: requestedPlannerId,
        selectionReason: selected.selectionReason,
      }),
      selectedCandidate: selected.selectedCandidate,
    });
  } catch (error) {
    const fallbackResult = await createFallbackResult();

    return attachShadowPlanner({
      plan: fallbackResult.plan,
      planner: {
        ...fallbackResult.planner,
        fallback: true,
        fallbackReason: serializePlannerError(error),
        requestedPlannerId,
        selectedPlannerId: fallbackPlannerId,
        status: "fallback",
      },
      selectedCandidate: fallbackResult.selectedCandidate,
    });
  }
};
