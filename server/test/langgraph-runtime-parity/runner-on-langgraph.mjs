// Stands in for rag/agent-execution-graph-runner.js inside
// test/agent-execution-graph-runner.test.mjs while
// test/langgraph-native-runner-suite.test.mjs runs (redirect-hooks.mjs does
// the redirect, for that one importer only). Everything is the real runner's
// except runExecutionGraph, which is the LangGraph executor, so the native
// runner suite runs unchanged against it. Each call is classified, ids and
// counts only: refused at admission, or scheduled on LangGraph (since phase 5
// the executor has no path to the native scheduler: both queue in layer
// order), so the wrapper can show the suite reached LangGraph.
import { createExecutionGraphNodeStates } from "../../rag/agent-execution-graph-node.js";
import { admitExecutionGraphRun } from "../../rag/agent-execution-graph-runner.js";
import { runExecutionGraphOnLangGraph } from "../../rag/langgraph/run-execution-graph.js";

export * from "../../rag/agent-execution-graph-runner.js";

const calls = { langgraph: 0, refused: 0 };

const classify = (options) => {
  try {
    if (admitExecutionGraphRun(options).rejected) {
      return "refused";
    }

    createExecutionGraphNodeStates(options);
    return "langgraph";
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
