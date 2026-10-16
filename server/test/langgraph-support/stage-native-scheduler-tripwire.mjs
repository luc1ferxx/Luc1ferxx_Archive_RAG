// Stands in for rag/agent-execution-graph-runner.js inside the v3 stage
// (rag/agent-unified-graph-stage.js) while
// test/langgraph-unified-graph-without-run-target.test.mjs runs. Everything is
// the real runner's; the stage's two entries into it are counted per
// AGENT_RUNTIME, and the native scheduler refuses to run on any runtime but
// native, so a LangGraph request that still reached it fails the suite.
import {
  replayExecutionGraphRun as replay,
  runExecutionGraph as runNatively,
} from "../../rag/agent-execution-graph-runner.js";
import { getAgentRuntime } from "../../rag/config.js";

export * from "../../rag/agent-execution-graph-runner.js";

export const runExecutionGraph = (options) => {
  const runtime = getAgentRuntime();

  globalThis.__archiveRagStageProbe.nativeScheduler[runtime] += 1;

  if (runtime !== "native") {
    throw new Error(`The v3 stage reached the native scheduler on AGENT_RUNTIME=${runtime}.`);
  }

  return runNatively(options);
};

export const replayExecutionGraphRun = (options) => {
  globalThis.__archiveRagStageProbe.replays[getAgentRuntime()] += 1;

  return replay(options);
};
