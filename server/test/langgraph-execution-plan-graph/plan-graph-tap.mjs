// Stands in for rag/langgraph/execution-plan-graph.js inside rag/ while
// test/langgraph-execution-plan-graph.test.mjs and
// test/langgraph-chat-stream.test.mjs run (redirect-hooks.mjs of the phase-2
// parity suite does the redirect; agent-execution-plan-runner.js imports the
// graph on demand). Parity between two runs proves nothing unless the
// LangGraph pass really scheduled the outer plan on LangGraph, so every
// invocation is recorded -- ids only: the step ids of the validated plan as
// the graph received them, and whether an agent run id was bound. The real
// module does all the work.
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
