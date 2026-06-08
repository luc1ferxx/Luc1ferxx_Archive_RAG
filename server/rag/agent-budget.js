export const DEFAULT_AGENT_BUDGET = {
  maxTraceSteps: 16,
  maxDocumentRagCalls: 2,
  maxCustomSkillCalls: 2,
  maxWebSearchCalls: 1,
  maxResearchQuestions: 3,
};

const limitKeyByBudgetKey = {
  customSkillCalls: "maxCustomSkillCalls",
  documentRagCalls: "maxDocumentRagCalls",
  researchQuestions: "maxResearchQuestions",
  traceSteps: "maxTraceSteps",
  webSearchCalls: "maxWebSearchCalls",
};

const labelByBudgetKey = {
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

export const createAgentBudget = (overrides = {}) => {
  const limits = Object.fromEntries(
    Object.entries(DEFAULT_AGENT_BUDGET).map(([key, fallback]) => [
      key,
      normalizeLimit(overrides[key], fallback),
    ])
  );

  return {
    limits,
    used: {
      documentRagCalls: 0,
      customSkillCalls: 0,
      researchQuestions: 0,
      traceSteps: 0,
      webSearchCalls: 0,
    },
    traceTruncated: false,
  };
};

export const consumeBudget = (budgetState, key) => {
  const limitKey = limitKeyByBudgetKey[key];
  const label = labelByBudgetKey[key] ?? key;

  if (!limitKey) {
    throw new Error(`Unknown agent budget key: ${key}`);
  }

  const limit = budgetState.limits[limitKey];
  const used = budgetState.used[key] ?? 0;

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

export const getBudgetSnapshot = (budgetState) => ({
  limits: {
    ...budgetState.limits,
  },
  used: {
    ...budgetState.used,
  },
  traceTruncated: budgetState.traceTruncated,
});

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
