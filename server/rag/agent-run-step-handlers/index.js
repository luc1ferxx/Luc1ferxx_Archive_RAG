import {
  createArxivImportStepHandler,
  createCapabilityCallStepHandler,
  createWebSearchStepHandler,
} from "./capability-steps.js";
import {
  createCustomSkillStepHandler,
  createResearchQuestionStepHandler,
} from "./custom-research-steps.js";
import {
  createDocumentRagStepHandler,
  createFollowUpRetrievalStepHandler,
} from "./document-steps.js";
import { getStepReplaySafetyPolicy } from "../agent-run-step-replay-safety.js";
import { toArray } from "./shared.js";

export * from "./capability-steps.js";
export * from "./custom-research-steps.js";
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

export const createDefaultAgentRunStepHandlerRegistry = ({
  executeCustomSkillStep,
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
    createCustomSkillStepHandler({
      executeCustomSkillStep,
    }),
    createResearchQuestionStepHandler({
      executeResearchQuestionStep,
    }),
  ]);
