// Stands in for rag/agent-run-step-lifecycle.js inside the v3 stage
// (rag/agent-unified-graph-stage.js) while
// test/langgraph-unified-graph-without-run-target.test.mjs runs. Everything is
// the real module's; getAgentRunStepLifecycleTarget answers null while the
// suite hides the run target, so the stage sees the lifecycle every
// production caller hands it (which still records each step on the run) as
// one without a run, the case no production caller reaches.
import { getAgentRunStepLifecycleTarget as getTarget } from "../../rag/agent-run-step-lifecycle.js";

export * from "../../rag/agent-run-step-lifecycle.js";

export const getAgentRunStepLifecycleTarget = (stepLifecycle) => {
  const probe = globalThis.__archiveRagStageProbe;

  probe.targetLookups += 1;

  return probe.hideRunTarget ? null : getTarget(stepLifecycle);
};
