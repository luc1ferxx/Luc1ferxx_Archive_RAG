// Stands in for rag/langgraph/execution-plan-graph.js inside rag/ while
// test/langgraph-execution-plan-graph.test.mjs,
// test/langgraph-chat-stream.test.mjs and test/langgraph-routes.test.mjs run
// (redirect-hooks.mjs of the phase-2 parity suite does the redirect;
// agent-execution-plan-runner.js imports the graph on demand). A run that
// equals the native loop's golden proves nothing unless the outer plan was
// really scheduled on the graph, so every invocation is recorded -- ids only:
// the step ids of the validated plan as the graph received them, and whether
// an agent run id was bound. The real module does all the work.
import { runAgentExecutionPlanOnLangGraph as runOnLangGraph } from "../../rag/langgraph/execution-plan-graph.js";

export * from "../../rag/langgraph/execution-plan-graph.js";

const invocations = [];

export const runAgentExecutionPlanOnLangGraph = (options = {}) => {
  invocations.push({
    boundToRun: Boolean(options.agentRunId),
    stepIds: (options.executionPlan ?? []).map((step) =>
      typeof step === "string" ? step : step?.id ?? null
    ),
  });

  return runOnLangGraph(options);
};

/** The invocations since the last call, in order. Clears the record. */
export const takePlanGraphInvocations = () => invocations.splice(0);
