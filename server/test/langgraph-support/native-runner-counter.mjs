// Stands in for rag/agent-execution-graph-runner.js inside the two graph
// stages while a suite runs under the AGENT_RUNTIME=native rollback
// (native-rollback-guard.mjs): it counts the graphs the native scheduler ran.
// The real runner does all the work.
import { runExecutionGraph as runNatively } from "../../rag/agent-execution-graph-runner.js";

export * from "../../rag/agent-execution-graph-runner.js";

export const runExecutionGraph = (options) => {
  globalThis.__archiveRagNativeRollbackGuard.nativeSchedulerCalls += 1;

  return runNatively(options);
};
