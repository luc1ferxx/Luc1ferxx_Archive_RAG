import { AsyncLocalStorage } from "node:async_hooks";
import { normalizePromptDescriptor } from "./prompt-registry.js";
import {
  getAgentRunMaxCostUsd,
  getAgentRunMaxDurationMs,
  getAgentRunMaxTokens,
} from "./config.js";

// What one agent run has spent on model calls, and its ceilings on tokens,
// estimated cost, and wall-clock time.
//
// The call-count budgets in agent-budget.js bound how many times a tool runs;
// they cannot bound what the run costs, because one document RAG call over a
// long context can use ten times the tokens of another. These can.
//
// Usage is charged from the LLMOps metric of every successful model call, which
// is the one place chat, embedding, and rerank calls all pass through, so a
// call made deep inside ragService is still attributed to the run that caused
// it. The run is found through AsyncLocalStorage rather than a parameter for
// the same reason.
//
// Enforcement happens at step boundaries, through the consumeBudget /
// reserveBudget checks every tool already passes. A step that has started is
// allowed to finish, so a run can overshoot a ceiling by at most the step in
// flight; the next tool is skipped with a budget_limit trace and the run
// degrades through the existing clarification and evidence-limited paths
// instead of failing.

export const RUN_USAGE_DIMENSIONS = Object.freeze({
  costUsd: "cost",
  durationMs: "duration",
  tokens: "tokens",
});

const storage = new AsyncLocalStorage();

const toLimit = (value, fallback) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const roundCost = (value) => Math.round(value * 1_000_000) / 1_000_000;

/**
 * Ceilings for one run. Explicit overrides (the `agentBudget` a caller passes)
 * win over the environment; 0 turns a ceiling off.
 */
export const resolveRunUsageLimits = (overrides = {}) => ({
  maxCostUsd: toLimit(overrides?.maxRunCostUsd, getAgentRunMaxCostUsd()),
  maxDurationMs: Math.floor(
    toLimit(overrides?.maxRunDurationMs, getAgentRunMaxDurationMs())
  ),
  maxTokens: Math.floor(toLimit(overrides?.maxRunTokens, getAgentRunMaxTokens())),
});

// Plain data only: budget state is cloned and compared elsewhere, so the meter
// keeps a start time and every time check takes `now` as an argument.
export const createRunUsage = ({
  limits = resolveRunUsageLimits(),
  startedAt = Date.now(),
} = {}) => ({
  limits: { ...limits },
  startedAt,
  used: {
    costUsd: 0,
    modelCalls: 0,
    tokens: 0,
    // A call whose model has no pricing cannot count toward the cost ceiling.
    // It is counted here so a run that spent only on unpriced models does not
    // read as free.
    unpricedModelCalls: 0,
  },
});

export const runWithRunUsage = (runUsage, action) =>
  storage.run(runUsage, action);

export const getActiveRunUsage = () => storage.getStore() ?? null;

/**
 * Charges one normalized LLMOps metric event. Only a successful call is
 * charged: a rate-limited or failed request is not billed by the provider, and
 * a call the LLMOps policy blocked never reached it.
 */
// Which prompt templates the run's model calls used. Kept beside the meter, not
// inside it: the meter is budget state that is cloned and compared, and this is
// observability only.
const promptLedgers = new WeakMap();

const recordPromptUse = (runUsage, event) => {
  const prompt = normalizePromptDescriptor(event.promptTemplate);

  if (!prompt) {
    return;
  }

  const ledger = promptLedgers.get(runUsage) ?? new Map();
  const key = `${prompt.id}@${prompt.version}#${prompt.fingerprint}`;
  const entry = ledger.get(key) ?? { ...prompt, calls: 0, tokens: 0 };

  entry.calls += 1;
  entry.tokens += Number.isFinite(event.totalTokens) ? event.totalTokens : 0;
  ledger.set(key, entry);
  promptLedgers.set(runUsage, ledger);
};

/** The prompts this run sent, one entry per template, in first-use order. */
export const getRunPromptUsage = (runUsage) =>
  runUsage ? [...(promptLedgers.get(runUsage)?.values() ?? [])].map((entry) => ({ ...entry })) : [];

export const chargeRunUsage = (runUsage, event = {}) => {
  if (!runUsage || event.status !== "ok") {
    return;
  }

  recordPromptUse(runUsage, event);
  runUsage.used.modelCalls += 1;
  runUsage.used.tokens += Number.isFinite(event.totalTokens) ? event.totalTokens : 0;

  if (Number.isFinite(event.estimatedCostUsd)) {
    runUsage.used.costUsd = roundCost(runUsage.used.costUsd + event.estimatedCostUsd);
  } else {
    runUsage.used.unpricedModelCalls += 1;
  }
};

export const chargeActiveRunUsage = (event) =>
  chargeRunUsage(getActiveRunUsage(), event);

const getElapsedMs = (runUsage, now) => Math.max(0, now - runUsage.startedAt);

/**
 * Whether the run may start more work. Time is checked first: a run that is
 * out of time should say so even if it is also out of tokens.
 */
export const checkRunUsage = (runUsage, now = Date.now()) => {
  if (!runUsage) {
    return { ok: true };
  }

  const { limits, used } = runUsage;
  const elapsedMs = getElapsedMs(runUsage, now);

  if (limits.maxDurationMs > 0 && elapsedMs >= limits.maxDurationMs) {
    return {
      dimension: RUN_USAGE_DIMENSIONS.durationMs,
      ok: false,
      reason: `run time budget exhausted (${Math.round(elapsedMs / 1000)}s/${Math.round(
        limits.maxDurationMs / 1000
      )}s).`,
    };
  }

  if (limits.maxTokens > 0 && used.tokens >= limits.maxTokens) {
    return {
      dimension: RUN_USAGE_DIMENSIONS.tokens,
      ok: false,
      reason: `run token budget exhausted (${used.tokens}/${limits.maxTokens} tokens).`,
    };
  }

  if (limits.maxCostUsd > 0 && used.costUsd >= limits.maxCostUsd) {
    return {
      dimension: RUN_USAGE_DIMENSIONS.costUsd,
      ok: false,
      reason: `run cost budget exhausted ($${used.costUsd}/$${limits.maxCostUsd}).`,
    };
  }

  return { ok: true };
};

export const getRunUsageSnapshot = (runUsage, now = Date.now()) => {
  if (!runUsage) {
    return null;
  }

  const check = checkRunUsage(runUsage, now);

  return {
    exhausted: check.ok ? null : check.dimension,
    limits: { ...runUsage.limits },
    used: {
      ...runUsage.used,
      durationMs: getElapsedMs(runUsage, now),
    },
  };
};
