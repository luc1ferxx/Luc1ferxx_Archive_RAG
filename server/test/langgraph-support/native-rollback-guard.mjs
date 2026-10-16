// Preloaded (--import) into each suite that
// test/agent-graph-suites-native-rollback.test.mjs runs under
// AGENT_RUNTIME=native, in that suite's own process.
//
// It makes the pass mean what it says. The stages' import of the LangGraph
// executor (rag/langgraph/run-execution-graph.js, imported on demand only
// under AGENT_RUNTIME=langgraph) is sent to a module that refuses to load, so
// a graph that reached LangGraph fails the suite; and the stages' import of
// the native runner is sent to a counter, so a pass that scheduled no graph
// natively is caught by the wrapper. The counts are written to stderr when
// the process exits, for the wrapper to read.
import { register } from "node:module";

if (process.env.AGENT_RUNTIME !== "native") {
  throw new Error("native-rollback-guard.mjs runs only under AGENT_RUNTIME=native.");
}

export const NATIVE_ROLLBACK_GUARD_PREFIX = "NATIVE_ROLLBACK_GUARD ";

const ragUrl = new URL("../../rag/", import.meta.url).href;
const runnerUrl = new URL("agent-execution-graph-runner.js", ragUrl).href;
const counterUrl = new URL("./native-runner-counter.mjs", import.meta.url).href;

globalThis.__archiveRagNativeRollbackGuard = {
  langGraphExecutorImports: 0,
  nativeSchedulerCalls: 0,
  settledGraphReplays: 0,
};

register("../langgraph-runtime-parity/redirect-hooks.mjs", import.meta.url, {
  data: {
    redirects: [
      {
        capture: new URL("./langgraph-executor-forbidden.mjs", import.meta.url).href,
        fromPrefix: ragUrl,
        target: new URL("langgraph/run-execution-graph.js", ragUrl).href,
      },
      ...["agent-custom-skill-stage.js", "agent-unified-graph-stage.js"].map((stage) => ({
        capture: counterUrl,
        fromPrefix: new URL(stage, ragUrl).href,
        target: runnerUrl,
      })),
    ],
  },
});

process.on("exit", () => {
  process.stderr.write(
    `\n${NATIVE_ROLLBACK_GUARD_PREFIX}${JSON.stringify(globalThis.__archiveRagNativeRollbackGuard)}\n`
  );
});
