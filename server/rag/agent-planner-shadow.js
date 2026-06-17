const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const serializePlannerError = (error) =>
  normalizeText(error instanceof Error ? error.message : error).slice(0, 500);

const getPlannerId = (plannerAdapter) =>
  normalizeText(plannerAdapter?.id) || "unknown";

const defaultCompare = () => null;

export const withPlannerRollout = (plannerAdapter, rolloutMode) =>
  plannerAdapter
    ? {
        ...plannerAdapter,
        rolloutMode: normalizeText(rolloutMode),
      }
    : plannerAdapter;

export const getPlannerRolloutMode = (plannerAdapter) =>
  normalizeText(plannerAdapter?.rolloutMode);

export const withShadowPlanner = (primaryPlannerAdapter, shadowPlannerAdapter) =>
  primaryPlannerAdapter && shadowPlannerAdapter
    ? {
        ...primaryPlannerAdapter,
        shadowPlannerAdapter,
      }
    : primaryPlannerAdapter;

export const getShadowPlannerAdapter = (plannerAdapter) =>
  plannerAdapter?.shadowPlannerAdapter ?? null;

export const sameStringList = (left = [], right = []) => {
  const leftItems = toArray(left).map(normalizeText);
  const rightItems = toArray(right).map(normalizeText);

  return (
    leftItems.length === rightItems.length &&
    leftItems.every((item, index) => item === rightItems[index])
  );
};

export const runShadowPlanner = async ({
  compare = defaultCompare,
  describe,
  execute,
  primary,
  shadowPlannerAdapter,
} = {}) => {
  if (!shadowPlannerAdapter || typeof execute !== "function") {
    return null;
  }

  const startedAt = Date.now();
  const plannerId = getPlannerId(shadowPlannerAdapter);

  try {
    const shadowResult = await execute(shadowPlannerAdapter);
    const shadowDescription =
      typeof describe === "function" ? describe(shadowResult) : {};

    return {
      ...shadowDescription,
      diverged: compare({
        primary,
        shadow: shadowResult,
      }),
      error: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      requestedPlannerId: plannerId,
      status: "selected",
    };
  } catch (error) {
    return {
      diverged: null,
      error: serializePlannerError(error),
      latencyMs: Math.max(0, Date.now() - startedAt),
      requestedPlannerId: plannerId,
      status: "error",
    };
  }
};
