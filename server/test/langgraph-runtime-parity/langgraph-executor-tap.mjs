// Stands in for rag/langgraph/run-execution-graph.js inside rag/ while
// test/langgraph-runtime-parity.test.mjs runs (redirect-hooks.mjs does the
// redirect; agent-custom-skill-stage.js imports the executor on demand). A
// parity result means nothing unless the LangGraph pass really scheduled the
// graphs on LangGraph, so every invocation is recorded -- ids only: the node
// ids, the reused ones, and whether a run binding (and with it the
// checkpointer) was passed. The real executor does all the work.
import { runExecutionGraphOnLangGraph as runOnLangGraph } from "../../rag/langgraph/run-execution-graph.js";

export * from "../../rag/langgraph/run-execution-graph.js";

const invocations = [];

export const runExecutionGraphOnLangGraph = (options = {}) => {
  invocations.push({
    boundToRun: Boolean(options.agentRunService && options.agentRunId),
    nodeIds: (options.graph?.nodes ?? []).map((node) => node.nodeId),
    reusedNodeIds: (options.completedNodeRuns ?? []).map((nodeRun) => nodeRun.nodeId),
  });

  return runOnLangGraph(options);
};

/** The invocations since the last call, in order. Clears the record. */
export const takeLangGraphInvocations = () => invocations.splice(0);
