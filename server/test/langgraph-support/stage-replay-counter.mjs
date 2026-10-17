// Stands in for rag/agent-execution-graph-runner.js inside the v3 stage
// (rag/agent-unified-graph-stage.js) while
// test/langgraph-unified-graph-without-run-target.test.mjs runs. Everything is
// the real runner's; the stage's replays of a settled graph
// (replayExecutionGraphRun, which runs no scheduler) are counted. It replaces
// the tripwire that, until phase 6 of docs/adr/0001-langgraph-runtime.md
// deleted the native scheduler, also counted and refused that scheduler.
import { replayExecutionGraphRun as replay } from "../../rag/agent-execution-graph-runner.js";

export * from "../../rag/agent-execution-graph-runner.js";

export const replayExecutionGraphRun = (options) => {
  globalThis.__archiveRagStageProbe.replays += 1;

  return replay(options);
};
