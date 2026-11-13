import {
  createArxivImportStepHandler,
  createCapabilityCallStepHandler,
  createWebSearchStepHandler,
} from "./capability-steps.js";
import { createResearchQuestionStepHandler } from "./research-steps.js";
import {
  createDocumentRagStepHandler,
  createFollowUpRetrievalStepHandler,
} from "./document-steps.js";
import { getStepReplaySafetyPolicy } from "../agent-run-step-replay-safety.js";
import { toArray } from "./shared.js";

export * from "./capability-steps.js";
export * from "./research-steps.js";
export * from "./document-steps.js";
export * from "./retriable-step-runner.js";

export const createAgentRunStepHandlerRegistry = (handlers = []) => {
  const normalizedHandlers = toArray(handlers).filter(
    (handler) =>
      handler &&
      typeof handler.canHandle === "function" &&
      typeof handler.execute === "function"
  );

  return {
    list: () =>
      normalizedHandlers.map((handler) => ({
        id: handler.id,
        label: handler.label ?? handler.id,
        replaySafety:
          handler.replaySafety ?? getStepReplaySafetyPolicy(handler.id),
      })),
    resolve: (context = {}) =>
      normalizedHandlers.find((handler) => handler.canHandle(context)) ?? null,
  };
};

// One handler per step type an approval or an operator's retry can run. There
// is none for `custom_skill`: a custom Skill runs only as a node of its
// execution graph (ADR 0001 phase 9 removed the handler the deleted V1 chain's
// steps used).
export const createDefaultAgentRunStepHandlerRegistry = ({
  executeDocumentRagStep,
  executeResearchQuestionStep,
  extraHandlers = [],
} = {}) =>
  createAgentRunStepHandlerRegistry([
    ...toArray(extraHandlers),
    createCapabilityCallStepHandler(),
    createWebSearchStepHandler(),
    createArxivImportStepHandler(),
    createDocumentRagStepHandler({
      executeDocumentRagStep,
    }),
    createFollowUpRetrievalStepHandler({
      executeDocumentRagStep,
    }),
    createResearchQuestionStepHandler({
      executeResearchQuestionStep,
    }),
  ]);
