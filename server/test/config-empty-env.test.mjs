// An empty line in .env (`VAR=`) or a whitespace-only value must behave as if
// the variable were unset. Number("") is 0, so a numeric getter that parsed
// the text directly silently replaced its default with 0, which for many
// settings means "off" or "no limit" (the shipped .env.example leaves the
// LLMOps per-event budgets empty, and an empty budget used to mark every model
// call as over budget).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as config from "../rag/config.js";
import {
  LlmOpsBudgetExceededError,
  LLMOPS_OPERATIONS,
  runWithLlmOpsMetric,
} from "../rag/llmops-metrics.js";

const configSource = readFileSync(
  fileURLToPath(new URL("../rag/config.js", import.meta.url)),
  "utf8"
);

// Every variable name config.js reads: `process.env.NAME`, `process.env["NAME"]`,
// `env.NAME` (getters that take an environment), names passed as string
// literals to a reader (readRunLimit("AGENT_RUN_MAX_TOKENS", ...)), and the
// per-stage ingest settings built from a template.
const collectEnvNames = () => {
  const names = new Set();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g,
    /\benv(?:ironment)?\.([A-Z][A-Z0-9_]*)/g,
    /["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/g,
  ];

  for (const pattern of patterns) {
    for (const match of configSource.matchAll(pattern)) {
      names.add(match[1]);
    }
  }

  for (const stage of config.RAG_INGEST_STAGES) {
    for (const suffix of ["MAX_ATTEMPTS", "RETRY_BASE_MS", "RETRY_MAX_MS"]) {
      names.add(`RAG_INGEST_${stage.toUpperCase()}_${suffix}`);
    }
  }

  return [...names].sort();
};

const ENV_NAMES = collectEnvNames();

const GETTER_PREFIX = /^(get|is|should|describe|has|uses?)[A-Z]/;

// Zero-argument getters, plus the getters that take a closed set of arguments.
const collectGetterCalls = () => {
  const calls = [];

  for (const [name, value] of Object.entries(config)) {
    if (typeof value !== "function" || !GETTER_PREFIX.test(name)) {
      continue;
    }

    if (name === "getRagIngestStageRetryPolicy") {
      for (const stage of config.RAG_INGEST_STAGES) {
        calls.push({ label: `${name}(${stage})`, run: () => value(stage) });
      }
      continue;
    }

    if (value.length === 0) {
      calls.push({ label: name, run: () => value() });
    }
  }

  return calls;
};

const GETTER_CALLS = collectGetterCalls();

const snapshotGetters = () => {
  const snapshot = new Map();

  for (const { label, run } of GETTER_CALLS) {
    try {
      const result = run();

      snapshot.set(
        label,
        result && typeof result.then === "function" ? { promise: true } : { value: result }
      );
    } catch (error) {
      snapshot.set(label, { error: `${error?.code ?? ""}:${error?.message ?? error}` });
    }
  }

  return snapshot;
};

// Paths at which two getter results differ, with both sides.
const diffValues = (left, right, path = "", out = []) => {
  if (Object.is(left, right)) {
    return out;
  }

  const bothObjects =
    left && right && typeof left === "object" && typeof right === "object";

  if (bothObjects && Array.isArray(left) === Array.isArray(right)) {
    if (left instanceof Map || right instanceof Map || left instanceof Set || right instanceof Set) {
      try {
        assert.deepStrictEqual(left, right);
      } catch {
        out.push({ left, path, right });
      }
      return out;
    }

    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

    for (const key of keys) {
      diffValues(left[key], right[key], `${path}.${key}`, out);
    }

    return out;
  }

  out.push({ left, path, right });
  return out;
};

const isNumericDifference = ({ left, right }) =>
  typeof left === "number" || typeof right === "number";

const withClearedEnv = (callback) => {
  const saved = new Map();

  for (const name of ENV_NAMES) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      saved.set(name, process.env[name]);
    }
    delete process.env[name];
  }

  try {
    return callback();
  } finally {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    for (const [name, value] of saved) {
      process.env[name] = value;
    }
  }
};

test("the env name and getter walk finds what config.js reads", () => {
  // Guards the walk itself: if the regexes stopped matching, the main test
  // would pass vacuously.
  for (const name of [
    "RAG_LLMOPS_MAX_TOKENS_PER_EVENT",
    "RAG_LLMOPS_MAX_COST_USD_PER_EVENT",
    "RAG_LLM_MAX_CONCURRENCY",
    "RAG_LLM_CIRCUIT_FAILURE_THRESHOLD",
    "RAG_BM25_K1",
    "RAG_BM25_B",
    "RAG_RRF_K",
    "RAG_CHUNK_OVERLAP",
    "AGENT_RUN_MAX_TOKENS",
    "RAG_INGEST_EMBED_RETRY_BASE_MS",
  ]) {
    assert.ok(ENV_NAMES.includes(name), `${name} was not collected`);
  }

  assert.ok(ENV_NAMES.length > 150, `only ${ENV_NAMES.length} env names collected`);
  assert.ok(GETTER_CALLS.length > 150, `only ${GETTER_CALLS.length} getters collected`);
  assert.ok(GETTER_CALLS.some(({ label }) => label === "getLlmOpsPolicy"));
});

test('"" and whitespace give every numeric getter the same value as an unset variable', () => {
  const failures = [];

  withClearedEnv(() => {
    const baseline = snapshotGetters();

    // The walk compares against a stable baseline only.
    assert.deepStrictEqual(snapshotGetters(), baseline);

    for (const name of ENV_NAMES) {
      for (const blank of ["", "   ", "\t"]) {
        process.env[name] = blank;

        const variant = snapshotGetters();

        for (const [label, expected] of baseline) {
          const actual = variant.get(label);
          const differences = diffValues(expected, actual).filter(isNumericDifference);

          for (const difference of differences) {
            failures.push(
              `${name}=${JSON.stringify(blank)} changed ${label}${difference.path}: ` +
                `${JSON.stringify(difference.left)} -> ${JSON.stringify(difference.right)}`
            );
          }
        }

        delete process.env[name];
      }
    }
  });

  assert.deepEqual(failures, []);
});

test("an empty value keeps the specific defaults the review named", () => {
  withClearedEnv(() => {
    const cases = [
      ["RAG_LLM_MAX_CONCURRENCY", () => config.getLlmMaxConcurrency(), 8],
      ["RAG_LLM_CIRCUIT_FAILURE_THRESHOLD", () => config.getLlmCircuitFailureThreshold(), 5],
      ["RAG_BM25_K1", () => config.getBm25K1(), 1.2],
      ["RAG_BM25_B", () => config.getBm25B(), 0.75],
      ["RAG_RRF_K", () => config.getRrfK(), 60],
      ["RAG_CHUNK_OVERLAP", () => config.getChunkOverlap(), 180],
    ];

    for (const [name, read, expected] of cases) {
      const unset = read();

      if (expected !== undefined) {
        assert.equal(unset, expected, `${name} default`);
      }

      for (const blank of ["", "  "]) {
        process.env[name] = blank;
        assert.equal(read(), unset, `${name}=${JSON.stringify(blank)}`);
        delete process.env[name];
      }
    }

    // An explicit 0 is still honoured where 0 is a documented value.
    process.env.RAG_LLM_MAX_CONCURRENCY = "0";
    assert.equal(config.getLlmMaxConcurrency(), 0);
    process.env.RAG_LLM_CIRCUIT_FAILURE_THRESHOLD = " 0 ";
    assert.equal(config.getLlmCircuitFailureThreshold(), 0);
  });
});

const runMetricUnderEnvPolicy = async () => {
  const recorded = [];
  let actionCalls = 0;

  const result = await runWithLlmOpsMetric({
    action: async () => {
      actionCalls += 1;
      return "ok";
    },
    metric: {
      estimatedCostUsd: 0.05,
      operation: LLMOPS_OPERATIONS.completion,
      stage: "complete_text",
      tokenSource: "estimated",
      totalTokens: 5000,
    },
    now: () => "2026-10-04T00:00:00.000Z",
    policy: config.getLlmOpsPolicy(),
    recorder: async (event) => {
      recorded.push(event);
    },
  });

  return { actionCalls, recorded, result };
};

test("empty LLMOps per-event budgets (as shipped in .env.example) neither flag nor block a call", async () => {
  const saved = {};
  const names = [
    "RAG_LLMOPS_POLICY_ENABLED",
    "RAG_LLMOPS_ENFORCEMENT_MODE",
    "RAG_LLMOPS_MAX_COST_USD_PER_EVENT",
    "RAG_LLMOPS_MAX_TOKENS_PER_EVENT",
    "RAG_LLMOPS_ALERT_BUDGET_EXCEEDED",
  ];

  for (const name of names) {
    saved[name] = process.env[name];
  }

  try {
    process.env.RAG_LLMOPS_POLICY_ENABLED = "true";
    process.env.RAG_LLMOPS_ENFORCEMENT_MODE = "block";
    process.env.RAG_LLMOPS_ALERT_BUDGET_EXCEEDED = "true";
    process.env.RAG_LLMOPS_MAX_COST_USD_PER_EVENT = "";
    process.env.RAG_LLMOPS_MAX_TOKENS_PER_EVENT = "";

    const policy = config.getLlmOpsPolicy();

    assert.equal(policy.budget.maxEstimatedCostUsdPerEvent, null);
    assert.equal(policy.budget.maxTotalTokensPerEvent, null);

    const { actionCalls, recorded, result } = await runMetricUnderEnvPolicy();

    assert.equal(result, "ok");
    assert.equal(actionCalls, 1);
    assert.equal(recorded.length, 1);
    assert.notEqual(recorded[0].budget.status, "exceeded");
    assert.deepEqual(recorded[0].budget.exceededKeys, []);
    assert.ok(
      !recorded[0].alerts.some((alert) => alert.id === "llmops_budget_exceeded"),
      "no budget alert"
    );
    assert.ok(
      !(recorded[0].annotations ?? []).some((annotation) => annotation.id === "llmops_budget_exceeded"),
      "no budget annotation"
    );

    // Contrast: a real budget below the call's usage still blocks, so the
    // assertion above is not vacuous.
    process.env.RAG_LLMOPS_MAX_TOKENS_PER_EVENT = "1000";

    await assert.rejects(runMetricUnderEnvPolicy(), LlmOpsBudgetExceededError);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  }
});
