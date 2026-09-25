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
    completeGraphStep({ detail, expectedResumeClaimId = null, id, output } = {}) {
      return recordStep({
        detail,
        graphResumeClaimId: expectedResumeClaimId,
        output,
        status: AGENT_RUN_STEP_STATUSES.completed,
        stepId: id,
      });
    },

    completeStep({ detail, id, output } = {}) {
      return recordStep({
        detail,
        output,
        status: AGENT_RUN_STEP_STATUSES.completed,
        stepId: id,
      });
    },

    failGraphStep({ detail, error, expectedResumeClaimId = null, id, output } = {}) {
      return recordStep({
        detail,
        error,
        graphResumeClaimId: expectedResumeClaimId,
        output,
        status: AGENT_RUN_STEP_STATUSES.failed,
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

    pauseStep({ detail, id, input = null } = {}) {
      return recordStep({
        detail,
        input,
        status: AGENT_RUN_STEP_STATUSES.paused,
        stepId: id,
      });
    },

    pauseGraphStep({ detail, expectedResumeClaimId = null, id } = {}) {
      return recordStep({
        detail,
        graphResumeClaimId: expectedResumeClaimId,
        status: AGENT_RUN_STEP_STATUSES.paused,
        stepId: id,
      });
    },

    startGraphStep({ expectedResumeClaimId = null, id, input, label, type } = {}) {
      return recordStep({
        graphResumeClaimId: expectedResumeClaimId,
        input,
        label,
        status: AGENT_RUN_STEP_STATUSES.running,
        stepId: id,
        type,
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
