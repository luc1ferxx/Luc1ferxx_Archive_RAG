import {
  checkRunUsage,
  createRunUsage,
  getRunUsageSnapshot,
  resolveRunUsageLimits,
} from "./run-usage.js";

export const DEFAULT_AGENT_BUDGET = {
  maxTraceSteps: 16,
  maxArxivPaperFetches: 1,
  maxDocumentRagCalls: 2,
  maxCustomSkillCalls: 2,
  maxWebSearchCalls: 1,
  maxResearchQuestions: 3,
};

const limitKeyByBudgetKey = {
  arxivPaperFetches: "maxArxivPaperFetches",
  customSkillCalls: "maxCustomSkillCalls",
  documentRagCalls: "maxDocumentRagCalls",
  researchQuestions: "maxResearchQuestions",
  traceSteps: "maxTraceSteps",
  webSearchCalls: "maxWebSearchCalls",
};

const labelByBudgetKey = {
  arxivPaperFetches: "arXiv import",
  customSkillCalls: "custom skill",
  documentRagCalls: "document RAG",
  researchQuestions: "research question",
  traceSteps: "trace step",
  webSearchCalls: "web search",
};

const normalizeLimit = (value, fallback) => {
  const parsed = Number.parseInt(value ?? fallback, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Call-count limits plus the run's usage meter. `runUsage` is the meter the
 * caller made active for this run (see run-usage.js); without one the budget
 * gets its own, which enforces time but is charged by nothing.
 */
export const createAgentBudget = (overrides = {}, { runUsage = null } = {}) => {
  const limits = Object.fromEntries(
    Object.entries(DEFAULT_AGENT_BUDGET).map(([key, fallback]) => [
      key,
      normalizeLimit(overrides[key], fallback),
    ])
  );

  return {
    limits,
    used: {
      arxivPaperFetches: 0,
      documentRagCalls: 0,
      customSkillCalls: 0,
      researchQuestions: 0,
      traceSteps: 0,
      webSearchCalls: 0,
    },
    traceTruncated: false,
    run: runUsage ?? createRunUsage({ limits: resolveRunUsageLimits(overrides) }),
  };
};

// Trace steps are bookkeeping, not work: a run that is out of tokens must still
// be able to record why it stopped.
const checkRunLimits = (budgetState, key) =>
  key === "traceSteps" ? { ok: true } : checkRunUsage(budgetState?.run);

export const consumeBudget = (budgetState, key) => {
  const limitKey = limitKeyByBudgetKey[key];
  const label = labelByBudgetKey[key] ?? key;

  if (!limitKey) {
    throw new Error(`Unknown agent budget key: ${key}`);
  }

  const limit = budgetState.limits[limitKey];
  const used = budgetState.used[key] ?? 0;
  const runLimit = checkRunLimits(budgetState, key);

  if (!runLimit.ok) {
    return {
      ok: false,
      key,
      label,
      limit,
      used,
      reason: runLimit.reason,
      runLimit: runLimit.dimension,
    };
  }

  if (used >= limit) {
    return {
      ok: false,
      key,
      label,
      limit,
      used,
      reason: `${label} budget exhausted (${used}/${limit}).`,
    };
  }

  budgetState.used[key] = used + 1;

  return {
    ok: true,
    key,
    label,
    limit,
    used: budgetState.used[key],
    remaining: Math.max(0, limit - budgetState.used[key]),
  };
};

/**
 * Reserves `count` units of a budget key in a single synchronous
 * read-modify-write, so a concurrent scheduler can claim a whole wave of nodes
 * before any of them starts awaiting.
 *
 * All-or-nothing: a reservation that does not fit consumes nothing, so a
 * partial claim can never strand budget that no node will ever use.
 */
export const reserveBudget = (budgetState, key, count = 1) => {
  const limitKey = limitKeyByBudgetKey[key];
  const label = labelByBudgetKey[key] ?? key;

  if (!limitKey) {
    throw new Error(`Unknown agent budget key: ${key}`);
  }

  const limit = budgetState.limits[limitKey];
  const used = budgetState.used[key] ?? 0;
  const requested = Math.max(0, Math.trunc(count));
  const runLimit = requested > 0
    ? checkRunLimits(budgetState, key)
    : { ok: true };

  if (!runLimit.ok) {
    return {
      key,
      label,
      limit,
      ok: false,
      reason: runLimit.reason,
      remaining: 0,
      requested,
      reserved: 0,
      runLimit: runLimit.dimension,
      used,
    };
  }

  if (used + requested > limit) {
    return {
      key,
      label,
      limit,
      ok: false,
      reason: `${label} budget exhausted (${used}/${limit}, needed ${requested}).`,
      remaining: Math.max(0, limit - used),
      requested,
      reserved: 0,
      used,
    };
  }

  budgetState.used[key] = used + requested;

  return {
    key,
    label,
    limit,
    ok: true,
    remaining: Math.max(0, limit - budgetState.used[key]),
    requested,
    reserved: requested,
    used: budgetState.used[key],
  };
};

/**
 * Returns unused units from a prior reserveBudget call. Only ever called for
 * work that was reserved and then not launched; it cannot push usage below
 * zero, so a double release cannot mint budget.
 */
export const releaseBudget = (budgetState, key, count = 1) => {
  const limitKey = limitKeyByBudgetKey[key];

  if (!limitKey) {
    throw new Error(`Unknown agent budget key: ${key}`);
  }

  const used = budgetState.used[key] ?? 0;
  budgetState.used[key] = Math.max(0, used - Math.max(0, Math.trunc(count)));

  return budgetState.used[key];
};

export const getBudgetSnapshot = (budgetState) => ({
  limits: {
    ...budgetState.limits,
  },
  used: {
    ...budgetState.used,
  },
  traceTruncated: budgetState.traceTruncated,
  ...(budgetState.run ? { run: getRunUsageSnapshot(budgetState.run) } : {}),
});

/**
 * Remaining calls per budget key, in the flat shape the graph validator reads.
 *
 * This lives here because the budget key to limit key mapping does, and a
 * caller that reconstructed it would silently stop matching the moment a new
 * budget key is added -- reporting a generous `undefined` instead of a limit.
 */
export const getRemainingBudget = (budgetState) =>
  Object.fromEntries(
    Object.entries(limitKeyByBudgetKey).map(([budgetKey, limitKey]) => [
      budgetKey,
      // A run out of tokens, cost, or time has no calls left to plan with,
      // whatever the counts say.
      checkRunLimits(budgetState, budgetKey).ok
        ? Math.max(
            0,
            (budgetState?.limits?.[limitKey] ?? 0) - (budgetState?.used?.[budgetKey] ?? 0)
          )
        : 0,
    ])
  );

export const appendTraceStep = ({ budgetState, step, trace }) => {
  const consumed = consumeBudget(budgetState, "traceSteps");

  if (!consumed.ok) {
    budgetState.traceTruncated = true;
    return false;
  }

  trace.push(step);
  return true;
};

export const buildBudgetLimitStep = ({ index, reason, tool }) => ({
  id: `${index}-budget_limit`,
  type: "budget_limit",
  label: "Budget Limit",
  status: "skipped",
  summary: `Skipped ${tool}: ${reason}`,
  detail: {
    reason,
    tool,
  },
});
