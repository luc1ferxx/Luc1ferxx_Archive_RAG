// Stands in for rag/agent-execution-graph-runner.js inside
// test/agent-execution-graph-runner.test.mjs while
// test/langgraph-native-runner-suite.test.mjs runs (redirect-hooks.mjs does
// the redirect, for that one importer only). Everything is the real runner's
// except runExecutionGraph, which is the LangGraph executor, so the native
// runner suite runs unchanged against it. Each call is classified, ids and
// counts only: refused at admission, handed to the native scheduler
// (canScheduleExecutionGraphOnLangGraph), or scheduled on LangGraph, so the
// wrapper can show the suite did not pass by never leaving native.
import { createExecutionGraphNodeStates } from "../../rag/agent-execution-graph-node.js";
import { admitExecutionGraphRun } from "../../rag/agent-execution-graph-runner.js";
import { canScheduleExecutionGraphOnLangGraph } from "../../rag/langgraph/compile-execution-graph.js";
import { runExecutionGraphOnLangGraph } from "../../rag/langgraph/run-execution-graph.js";

export * from "../../rag/agent-execution-graph-runner.js";

const calls = { langgraph: 0, native: 0, refused: 0 };

const classify = (options) => {
  try {
    const admission = admitExecutionGraphRun(options);

    if (admission.rejected) {
      return "refused";
    }

    const { states } = createExecutionGraphNodeStates(options);

    return canScheduleExecutionGraphOnLangGraph({
      compiled: admission.compiled,
      concurrencyCap: admission.concurrencyCap,
      graph: options.graph,
      states,
    })
      ? "langgraph"
      : "native";
  } catch {
    // An invalid reuse or denial list throws before anything runs, on both.
    return "refused";
  }
};

export const runExecutionGraph = (options = {}) => {
  calls[classify(options)] += 1;
  return runExecutionGraphOnLangGraph(options);
};

/** How the suite's calls were scheduled so far. */
export const getRunnerSuiteCalls = () => ({ ...calls });
