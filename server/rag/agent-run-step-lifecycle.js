import { AGENT_RUN_STEP_STATUSES } from "./agent-run-steps.js";

const hasLifecycleTarget = ({ agentRunService, runId } = {}) =>
  Boolean(agentRunService?.recordRunStep && runId);

export const createAgentRunStepLifecycle = ({
  accessScope = {},
  agentRunService,
  runId,
} = {}) => {
  const recordStep = (patch = {}) => {
    if (!hasLifecycleTarget({ agentRunService, runId })) {
      return null;
    }

    return agentRunService.recordRunStep({
      accessScope,
      runId,
      ...patch,
    });
  };

  return {
    completeStep({ detail, id, output } = {}) {
      return recordStep({
        detail,
        output,
        status: AGENT_RUN_STEP_STATUSES.completed,
        stepId: id,
      });
    },

    failStep({ detail, error, id, output } = {}) {
      return recordStep({
        detail,
        error,
        output,
        status: AGENT_RUN_STEP_STATUSES.failed,
        stepId: id,
      });
    },

    pauseStep({ detail, id } = {}) {
      return recordStep({
        detail,
        status: AGENT_RUN_STEP_STATUSES.paused,
        stepId: id,
      });
    },

    startStep({ detail, id, input, label, type } = {}) {
      return recordStep({
        detail,
        input,
        label,
        status: AGENT_RUN_STEP_STATUSES.running,
        stepId: id,
        type,
      });
    },
  };
};
