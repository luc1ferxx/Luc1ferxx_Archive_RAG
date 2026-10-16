// Stands in for rag/agent-execution-graph-runner.js inside the two graph
// stages while a suite runs under the AGENT_RUNTIME=native rollback
// (native-rollback-guard.mjs): it counts the graphs the native scheduler ran,
// and apart from them the settled v3 graphs the stage replayed for their
// finalization, which no scheduler runs on either runtime. The real runner
// does all the work.
import {
  replayExecutionGraphRun as replay,
  runExecutionGraph as runNatively,
} from "../../rag/agent-execution-graph-runner.js";

export * from "../../rag/agent-execution-graph-runner.js";

export const runExecutionGraph = (options) => {
  globalThis.__archiveRagNativeRollbackGuard.nativeSchedulerCalls += 1;

  return runNatively(options);
};

export const replayExecutionGraphRun = (options) => {
  globalThis.__archiveRagNativeRollbackGuard.settledGraphReplays += 1;

  return replay(options);
};
