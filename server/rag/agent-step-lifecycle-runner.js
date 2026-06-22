import { isAgentRunInterrupt } from "./agent-interrupts.js";

const noop = async () => {};

const buildInterruptStepDetail = (error = {}) => ({
  approvalGate: error.detail?.approvalGate ?? null,
  interruptType: error.type ?? null,
});

export const runLifecycleStep = async ({
  buildError = (result) => result?.error ?? null,
  buildOutput = () => null,
  completeDetail,
  execute,
  failDetail,
  id,
  input,
  label,
  stepLifecycle,
  succeeded = (result) => result?.ok !== false,
  type,
} = {}) => {
  await (stepLifecycle?.startStep ?? noop)({
    id,
    input,
    label,
    type,
  });

  let result;

  try {
    result = await execute();
  } catch (error) {
    if (isAgentRunInterrupt(error)) {
      await (stepLifecycle?.pauseStep ?? noop)({
        detail: buildInterruptStepDetail(error),
        id,
      });
      throw error;
    }

    await (stepLifecycle?.failStep ?? noop)({
      detail: typeof failDetail === "function" ? failDetail({ error }) : failDetail,
      error,
      id,
    });
    throw error;
  }

  const output = buildOutput(result);

  if (succeeded(result)) {
    await (stepLifecycle?.completeStep ?? noop)({
      detail:
        typeof completeDetail === "function"
          ? completeDetail({ output, result })
          : completeDetail,
      id,
      output,
    });
  } else {
    await (stepLifecycle?.failStep ?? noop)({
      detail:
        typeof failDetail === "function"
          ? failDetail({ output, result })
          : failDetail,
      error: buildError(result),
      id,
      output,
    });
  }

  return result;
};
