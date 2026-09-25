import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeBudget,
  createAgentBudget,
  getBudgetSnapshot,
  getRemainingBudget,
  reserveBudget,
} from "../rag/agent-budget.js";
import { runAgentRag } from "../rag/agent.js";
import { recordLlmOpsMetric } from "../rag/llmops-metrics.js";
import {
  completeTextWithMetadata,
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";
import {
  chargeRunUsage,
  checkRunUsage,
  createRunUsage,
  getActiveRunUsage,
  getRunUsageSnapshot,
  resolveRunUsageLimits,
  runWithRunUsage,
} from "../rag/run-usage.js";
import {
  buildScopedRagService,
  buildSource,
  createEvalTelemetry,
} from "../evaluation/agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  sameTrajectoryScope as sameScope,
} from "../evaluation/trajectory/checks.js";

const RUN_ENV_KEYS = [
  "AGENT_RUN_MAX_COST_USD",
  "AGENT_RUN_MAX_DURATION_MS",
  "AGENT_RUN_MAX_TOKENS",
];

const withEnv = async (values, action) => {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const noEnv = Object.fromEntries(RUN_ENV_KEYS.map((key) => [key, undefined]));

const okEvent = (fields = {}) => ({
  estimatedCostUsd: null,
  status: "ok",
  totalTokens: 0,
  ...fields,
});

const quietRecorder = { recorder: async () => {} };

test("only successful model calls are charged, and unpriced ones are counted", () => {
  const runUsage = createRunUsage({
    limits: { maxCostUsd: 1, maxDurationMs: 0, maxTokens: 1000 },
  });

  chargeRunUsage(runUsage, okEvent({ estimatedCostUsd: 0.0012, totalTokens: 300 }));
  chargeRunUsage(runUsage, okEvent({ totalTokens: 200 }));
  // A rate-limited, failed, or policy-blocked call is not billed.
  chargeRunUsage(runUsage, okEvent({ status: "error", totalTokens: 900 }));
  chargeRunUsage(runUsage, okEvent({ status: "skipped", totalTokens: 900 }));

  assert.deepEqual(runUsage.used, {
    costUsd: 0.0012,
    modelCalls: 2,
    tokens: 500,
    unpricedModelCalls: 1,
  });
});

test("each ceiling stops the run once reached, and 0 turns it off", () => {
  const startedAt = 1_000;
  const runUsage = createRunUsage({
    limits: { maxCostUsd: 0.01, maxDurationMs: 60_000, maxTokens: 1000 },
    startedAt,
  });

  assert.equal(checkRunUsage(runUsage, startedAt).ok, true);

  chargeRunUsage(runUsage, okEvent({ estimatedCostUsd: 0.01, totalTokens: 10 }));
  assert.equal(checkRunUsage(runUsage, startedAt).dimension, "cost");

  chargeRunUsage(runUsage, okEvent({ totalTokens: 990 }));
  assert.equal(checkRunUsage(runUsage, startedAt).dimension, "tokens");
  assert.match(
    checkRunUsage(runUsage, startedAt).reason,
    /run token budget exhausted \(1000\/1000 tokens\)/
  );

  // Time is reported first: a run out of time should say so.
  assert.equal(checkRunUsage(runUsage, startedAt + 60_000).dimension, "duration");
  // The meter is plain data, so it survives the clones budget state goes through.
  assert.deepEqual(structuredClone(runUsage), runUsage);

  const unlimited = createRunUsage({
    limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 },
    startedAt,
  });
  chargeRunUsage(unlimited, okEvent({ estimatedCostUsd: 50, totalTokens: 10_000_000 }));
  assert.equal(checkRunUsage(unlimited, startedAt + 10_000_000).ok, true);
});

test("run limits come from the caller first, then the environment", async () => {
  await withEnv(noEnv, async () => {
    assert.deepEqual(resolveRunUsageLimits(), {
      maxCostUsd: 0.5,
      maxDurationMs: 300_000,
      maxTokens: 100_000,
    });
  });

  await withEnv(
    {
      AGENT_RUN_MAX_COST_USD: "0",
      AGENT_RUN_MAX_DURATION_MS: "",
      AGENT_RUN_MAX_TOKENS: "20000",
    },
    async () => {
      // 0 disables a ceiling; an empty value keeps the default rather than
      // silently removing it.
      assert.deepEqual(resolveRunUsageLimits(), {
        maxCostUsd: 0,
        maxDurationMs: 300_000,
        maxTokens: 20_000,
      });
      assert.equal(resolveRunUsageLimits({ maxRunTokens: 500 }).maxTokens, 500);
    }
  );
});

test("concurrent runs charge their own meter through the LLMOps recorder", async () => {
  const first = createRunUsage({ limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 } });
  const second = createRunUsage({ limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 } });
  const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

  await Promise.all([
    runWithRunUsage(first, async () => {
      await yieldTurn();
      await recordLlmOpsMetric({ status: "ok", totalTokens: 100 }, quietRecorder);
      await yieldTurn();
      await recordLlmOpsMetric({ status: "ok", totalTokens: 100 }, quietRecorder);
    }),
    runWithRunUsage(second, async () => {
      await recordLlmOpsMetric({ status: "ok", totalTokens: 7 }, quietRecorder);
      await yieldTurn();
      await recordLlmOpsMetric({ status: "error", totalTokens: 7 }, quietRecorder);
    }),
  ]);

  assert.equal(first.used.tokens, 200);
  assert.equal(first.used.modelCalls, 2);
  assert.equal(second.used.tokens, 7);
  assert.equal(second.used.modelCalls, 1);
  // Outside any run nothing is active, so a stray call is charged to no one.
  assert.equal(getActiveRunUsage(), null);
});

test("an exhausted run refuses every tool but can still record trace steps", () => {
  const runUsage = createRunUsage({
    limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 100 },
  });
  const budgetState = createAgentBudget({}, { runUsage });

  assert.equal(consumeBudget(budgetState, "documentRagCalls").ok, true);
  chargeRunUsage(runUsage, okEvent({ totalTokens: 150 }));

  const refused = consumeBudget(budgetState, "documentRagCalls");
  assert.equal(refused.ok, false);
  assert.equal(refused.runLimit, "tokens");
  assert.match(refused.reason, /run token budget exhausted/);
  // The count was not charged for a call that did not happen.
  assert.equal(budgetState.used.documentRagCalls, 1);

  const reservation = reserveBudget(budgetState, "customSkillCalls", 1);
  assert.equal(reservation.ok, false);
  assert.equal(reservation.reserved, 0);
  assert.equal(budgetState.used.customSkillCalls, 0);

  assert.deepEqual(
    Object.entries(getRemainingBudget(budgetState))
      .filter(([key]) => key !== "traceSteps")
      .map(([, remaining]) => remaining),
    [0, 0, 0, 0, 0]
  );
  assert.equal(consumeBudget(budgetState, "traceSteps").ok, true);

  const snapshot = getBudgetSnapshot(budgetState);
  assert.equal(snapshot.run.exhausted, "tokens");
  assert.equal(snapshot.run.used.tokens, 150);
  // The count budget keeps its shape; the run meter is an additive field.
  assert.deepEqual(Object.keys(snapshot).sort(), ["limits", "run", "traceTruncated", "used"]);
});

test("a budget without an active meter still enforces time", () => {
  // No run made a meter active, so the budget builds one from its overrides.
  const budgetState = createAgentBudget({ maxRunDurationMs: 60_000 });

  assert.equal(budgetState.run.limits.maxDurationMs, 60_000);
  assert.equal(consumeBudget(budgetState, "webSearchCalls").ok, true);

  budgetState.run.startedAt -= 60_000;
  assert.equal(consumeBudget(budgetState, "webSearchCalls").runLimit, "duration");
  assert.equal(budgetState.used.webSearchCalls, 1);
  assert.ok(getRunUsageSnapshot(budgetState.run).used.durationMs >= 60_000);
});

test("a run out of tokens skips the next Skill instead of failing", async (t) => {
  t.after(() => resetOpenAIProvider());
  configureOpenAIProvider({
    completeText: async () => "Model answer. [Source 1]",
  });

  const citation = buildSource({
    docId: "contract-1",
    excerpt:
      "Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice. Late notice creates renewal risk.",
    fileName: "services-agreement.pdf",
    pageNumber: 3,
  });
  let chatCalls = 0;
  const ragService = buildScopedRagService({
    chat: async ({ question }) => {
      chatCalls += 1;
      // The real metered path: the same completeTextWithMetadata a document
      // answer goes through, so the charge comes from the LLMOps recorder.
      await completeTextWithMetadata(question);

      return {
        abstained: false,
        citations: [citation],
        memoryApplied: false,
        resolvedQuery: question,
        text: /risk/i.test(question)
          ? "- Risk: Late notice creates renewal risk. [Source 1]"
          : "- Summary: The agreement renews every 12 months. [Source 1]",
      };
    },
    documents: [{ docId: "contract-1", fileName: "services-agreement.pdf" }],
    sameScope,
    telemetry: createEvalTelemetry(),
  });

  const response = await withEnv(
    { ...noEnv, AGENT_SKILL_GRAPH_ROLLOUT: "guarded" },
    () =>
      runAgentRag({
        accessScope: DEFAULT_ACCESS_SCOPE,
        // One token: the first Skill's model call uses it up.
        agentBudget: { maxRunTokens: 1 },
        docIds: ["contract-1"],
        question: "Review this contract for risks and key terms.",
        ragService,
        sessionId: "run-usage-session",
        userId: DEFAULT_ACCESS_SCOPE.userId,
        webChatService: async () => ({ text: "web should not run" }),
      })
  );
  const body = response.body ?? response;
  const budget = body.agentObservability.budget;
  const trace = body.agentTrace ?? body.trace ?? [];

  assert.equal(chatCalls, 1);
  assert.equal(budget.used.customSkillCalls, 1);
  assert.equal(budget.run.exhausted, "tokens");
  assert.equal(budget.run.used.modelCalls, 1);
  assert.ok(budget.run.used.tokens >= 1);
  assert.ok(
    trace.some(
      (step) =>
        step.type === "budget_limit" &&
        /run token budget exhausted/.test(step.detail?.reason ?? step.summary)
    ),
    "the skipped Skill is explained in the trace"
  );
  // The run degraded; it did not error. The first Skill ran and reached the
  // answer, and the dependent one never started.
  assert.equal(response.status, 200);
  assert.deepEqual(
    trace.filter((step) => step.type === "custom_skill").map((step) => step.id),
    ["custom_skill:summarize_contract"]
  );
  assert.match(body.agentAnswer, /\[Source 1\]/);
});
