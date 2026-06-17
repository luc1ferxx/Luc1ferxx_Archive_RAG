import { AGENT_RUN_STATUSES } from "../agent-runs.js";
import { AGENT_RUN_STEP_STATUSES } from "../agent-run-steps.js";
import {
  fail,
  normalizeRecord,
  serializeError,
  toArray,
} from "./shared.js";

const completeRunAfterStepFailure = async ({
  accessScope = {},
  agentMode = "agent",
  agentRunService,
  error,
  run,
  runAfterStep,
  status = 500,
} = {}) => {
  if (!agentRunService?.completeRun || !run?.runId) {
    return runAfterStep ?? run;
  }

  return agentRunService.completeRun({
    accessScope,
    approvalGates: runAfterStep?.approvalGates ?? run.approvalGates ?? [],
    decisions: runAfterStep?.decisions ?? run.decisions ?? [],
    observations: runAfterStep?.observations ?? run.observations ?? [],
    result: {
      agentMode,
      answer: "",
      error: serializeError(error, "Agent run step failed."),
      status,
    },
    runId: run.runId,
    status: AGENT_RUN_STATUSES.failed,
    steps: runAfterStep?.steps ?? run.steps ?? [],
  });
};

const buildCompletedRunResult = ({ citations = [], responseBody = {} } = {}) => ({
  agentMode: responseBody.agentMode,
  answer: responseBody.agentAnswer,
  citationCount: citations.length,
  ragAbstained: Boolean(responseBody.ragAbstained),
  status: 200,
});

const buildStepPatch = (builder, context = {}) => {
  if (typeof builder === "function") {
    return normalizeRecord(builder(context), {});
  }

  return normalizeRecord(builder, {});
};

export const runRetriableStep = async ({
  accessScope = {},
  agentMode = "agent",
  agentRunService,
  buildCompletedPatch,
  buildFailedPatch,
  buildObservation,
  buildResponse,
  buildRunResult = buildCompletedRunResult,
  buildStartedPatch,
  execute,
  failureMessage = "Agent run step failed.",
  getCitations = () => [],
  getFailedResultError = () => new Error(failureMessage),
  input,
  isFailedResult = () => false,
  run,
  step,
} = {}) => {
  if (!step?.id) {
    fail("Agent run step is missing a resumable step id.");
  }

  await agentRunService.updateRunStep({
    accessScope,
    eventType: "step_started",
    patch: buildStepPatch(buildStartedPatch, { input, run, step }),
    runId: run.runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: step.id,
  });

  let result;

  try {
    result = await execute({
      accessScope,
      input,
      run,
      step,
    });
  } catch (error) {
    const runAfterStep = await agentRunService.updateRunStep({
      accessScope,
      eventType: "step_failed",
      patch: buildStepPatch(buildFailedPatch, {
        error,
        input,
        run,
        step,
      }),
      runId: run.runId,
      status: AGENT_RUN_STEP_STATUSES.failed,
      stepId: step.id,
    });
    await completeRunAfterStepFailure({
      accessScope,
      agentMode,
      agentRunService,
      error,
      run,
      runAfterStep,
      status: error.status ?? 500,
    });
    throw error;
  }

  if (isFailedResult(result)) {
    const error = getFailedResultError(result);
    const runAfterStep = await agentRunService.updateRunStep({
      accessScope,
      eventType: "step_failed",
      patch: buildStepPatch(buildFailedPatch, {
        error,
        input,
        result,
        run,
        step,
      }),
      runId: run.runId,
      status: AGENT_RUN_STEP_STATUSES.failed,
      stepId: step.id,
    });
    await completeRunAfterStepFailure({
      accessScope,
      agentMode,
      agentRunService,
      error,
      run,
      runAfterStep,
      status: error.status ?? 500,
    });
    throw error;
  }

  const citations = toArray(getCitations(result));
  const runAfterStep = await agentRunService.updateRunStep({
    accessScope,
    eventType: "step_completed",
    patch: buildStepPatch(buildCompletedPatch, {
      citations,
      input,
      result,
      run,
      step,
    }),
    runId: run.runId,
    status: AGENT_RUN_STEP_STATUSES.completed,
    stepId: step.id,
  });
  const responseBody = buildResponse({
    citations,
    input,
    result,
    run: runAfterStep,
    step,
  });
  const observation = buildObservation?.({
    citations,
    input,
    result,
    run: runAfterStep,
    step,
  });
  const completedRun = await agentRunService.completeRun({
    accessScope,
    approvalGates: runAfterStep.approvalGates ?? [],
    decisions: runAfterStep.decisions ?? [],
    observations: observation
      ? [...(runAfterStep.observations ?? []), observation]
      : runAfterStep.observations ?? [],
    result: buildRunResult({
      citations,
      input,
      responseBody,
      result,
      run: runAfterStep,
      step,
    }),
    runId: run.runId,
    status: AGENT_RUN_STATUSES.completed,
    steps: runAfterStep.steps ?? [],
  });

  return {
    response: {
      ...responseBody,
      agentRunStatus: completedRun.status,
      agentRunSteps: completedRun.steps ?? [],
    },
    run: completedRun,
  };
};
