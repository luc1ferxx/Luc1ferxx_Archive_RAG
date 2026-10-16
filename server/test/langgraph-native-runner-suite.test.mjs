// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Phase-2 evidence for AGENT_RUNTIME=langgraph (docs/adr/0001-langgraph-
// runtime.md): the native runner suite, test/agent-execution-graph-runner.
// test.mjs, run unchanged with its runExecutionGraph pointed at
// runExecutionGraphOnLangGraph. Its assertions are the native scheduler's
// contract (concurrency, exclusivity, fail_fast, budget, input and output
// gates, checkpoints, interrupts, approvals, recovery fences); every one must
// hold on LangGraph too. The redirect (test/langgraph-runtime-parity/) applies
// to that one file's import of the runner, so the LangGraph executor and
// every other module keep the real runner.
const RUNNER_SUITE_URL = new URL("./agent-execution-graph-runner.test.mjs", import.meta.url).href;
const SHIM_URL = new URL("./langgraph-runtime-parity/runner-on-langgraph.mjs", import.meta.url).href;

register("./langgraph-runtime-parity/redirect-hooks.mjs", import.meta.url, {
  data: {
    redirects: [
      {
        capture: SHIM_URL,
        fromPrefix: RUNNER_SUITE_URL,
        target: new URL("../rag/agent-execution-graph-runner.js", import.meta.url).href,
      },
    ],
  },
});

// Imported inside a describe block, not a test, so Node before 24 waits for
// every test the suite registers (see test/self-check-memo.test.mjs).
describe("native runner suite on the LangGraph executor", async () => {
  await import(RUNNER_SUITE_URL);
});

test("the runner suite's graphs were scheduled on LangGraph, not passed through to native", async () => {
  const { getRunnerSuiteCalls } = await import(SHIM_URL);
  const calls = getRunnerSuiteCalls();

  // Measured 2026-10-14: 45 calls scheduled on LangGraph, 6 refused at
  // admission (identically on both runtimes), none handed to native. A graph
  // the suite adds that LangGraph hands to native must be looked at, not
  // absorbed: it would pass here without testing LangGraph.
  assert.equal(calls.native, 0);
  assert.ok(calls.langgraph >= 45, `only ${calls.langgraph} calls reached LangGraph`);
  assert.ok(calls.refused >= 1);
});
