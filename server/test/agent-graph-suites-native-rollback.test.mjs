import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LANGSMITH_TRACING_VARIABLES } from "../rag/langgraph/langsmith-guard.js";

// AGENT_RUNTIME=native is the whole-runtime rollback for at least one release
// on the LangGraph default (docs/adr/0001-langgraph-runtime.md, constraint 12).
// Since phase 4 every suite that does not pin AGENT_RUNTIME runs its guarded
// custom-Skill and v3 graphs on LangGraph only, and the scenarios that exist
// only in these suites (approval refusals, admission boundaries, cancellation,
// checkpoint claims, the stage contracts) would otherwise never run on the
// rollback scheduler again. This file runs each of them once more, unchanged,
// in its own process under AGENT_RUNTIME=native, one after the other.
//
// test/langgraph-support/native-rollback-guard.mjs, preloaded into each, makes
// the pass mean what it says: loading the LangGraph executor fails the suite,
// and the graphs the native scheduler ran are counted. Delete this file with
// the native scheduler, after that release.
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.join(testDirectory, "..");
const keepEventLoopAliveUrl = pathToFileURL(path.join(testDirectory, "keep-event-loop-alive.mjs")).href;
const guardUrl = pathToFileURL(path.join(testDirectory, "langgraph-support", "native-rollback-guard.mjs")).href;
const GUARD_PREFIX = "NATIVE_ROLLBACK_GUARD ";

// Each suite with the graphs it scheduled natively and the settled v3 graphs
// it replayed for their finalization (no scheduler on either runtime since
// the stage replays them with replayExecutionGraphRun), measured 2026-10-16.
// The guarded suite's 36 native graphs of the first measurement are those 33
// and 3 replays. A suite may add graphs; one that schedules or replays fewer
// has stopped testing the rollback and must be looked at.
const SUITES = Object.freeze([
  ["agent-cancellation.test.mjs", 7, 0],
  ["agent-custom-skill-stage.test.mjs", 15, 0],
  ["agent-execution-graph-checkpoint.test.mjs", 20, 0],
  ["agent-unified-graph-approval.test.mjs", 24, 0],
  ["agent-unified-graph-boundaries.test.mjs", 9, 0],
  ["agent-unified-graph-guarded.test.mjs", 33, 3],
  ["agent-unified-graph-stage.test.mjs", 3, 0],
  ["app-planner-adapters.test.mjs", 1, 0],
  ["runtime-smoke-graph-signal.test.mjs", 1, 0],
]);

const runSuiteOnNative = (suite) =>
  new Promise((resolve, reject) => {
    const env = { ...process.env, AGENT_RUNTIME: "native" };

    for (const name of LANGSMITH_TRACING_VARIABLES) {
      delete env[name];
    }

    // Run directly (not under --test), so the guard's exit report comes from
    // the suite's own process.
    const child = spawn(
      process.execPath,
      ["--import", keepEventLoopAliveUrl, "--import", guardUrl, path.join("test", suite)],
      { cwd: serverDirectory, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stderr, stdout }));
  });

for (const [suite, measuredNativeGraphs, measuredReplays] of SUITES) {
  test(`${suite} passes unchanged on the AGENT_RUNTIME=native rollback scheduler`, { timeout: 300_000 }, async () => {
    const { exitCode, stderr, stdout } = await runSuiteOnNative(suite);
    const output = `${stdout}\n${stderr}`.slice(-8000);
    const line = stderr.split("\n").find((candidate) => candidate.startsWith(GUARD_PREFIX));

    assert.equal(exitCode, 0, output);
    assert.ok(line, `the native rollback guard did not report:\n${output}`);
    const guard = JSON.parse(line.slice(GUARD_PREFIX.length));

    assert.equal(guard.langGraphExecutorImports, 0, output);
    assert.ok(
      guard.nativeSchedulerCalls >= measuredNativeGraphs,
      `${suite} scheduled ${guard.nativeSchedulerCalls} graphs natively, ${measuredNativeGraphs} measured`
    );
    assert.ok(
      guard.settledGraphReplays >= measuredReplays,
      `${suite} replayed ${guard.settledGraphReplays} settled graphs, ${measuredReplays} measured`
    );
  });
}
