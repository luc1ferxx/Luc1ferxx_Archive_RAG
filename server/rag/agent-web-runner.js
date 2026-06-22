import { consumeBudget } from "./agent-budget.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { runLifecycleStep } from "./agent-step-lifecycle-runner.js";
import {
  buildStepError,
  buildTextCitationStepOutput,
} from "./agent-step-io.js";
import { buildFailedSkillResult } from "./skills/registry.js";

const noop = () => {};
const WEB_SEARCH_PRIMARY_STEP_ID = "web_search:primary";

export const runWebSearchSkill = async ({
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  budgetState,
  buildSkillTraceDetail = (result) => result,
  capabilityRegistry,
  executeObservedSkill,
  plannedWebSearchSkill,
  question,
  recordSkippedSkill = noop,
  recordSkillResult = noop,
  shouldRunWeb,
  stepLifecycle,
  webChatService,
  webSearchSkill,
} = {}) => {
  if (!shouldRunWeb) {
    return {
      skippedWebBecauseBudget: false,
      webResult: null,
    };
  }

  const webBudget = consumeBudget(budgetState, webSearchSkill.budgetKey);

  if (!webBudget.ok) {
    recordSkippedSkill({
      skill: webSearchSkill,
      result: buildFailedSkillResult(webSearchSkill, new Error(webBudget.reason)),
      phase: plannedWebSearchSkill ? "primary" : "fallback",
      budget: webBudget,
    });
    addBudgetLimitTrace({
      tool: "Web Search",
      reason: webBudget.reason,
    });

    return {
      skippedWebBecauseBudget: true,
      webResult: null,
    };
  }

  const webInput = {
    question,
  };
  const webResult = await runLifecycleStep({
    buildError: (result) =>
      buildStepError(result, "Unable to answer from web search."),
    buildOutput: buildTextCitationStepOutput,
    execute: () =>
      executeObservedSkill(
        webSearchSkill,
        {
          capabilityRegistry,
          webChatService,
          question,
        },
        {
          phase: plannedWebSearchSkill ? "primary" : "fallback",
          budget: webBudget,
        }
      ),
    id: WEB_SEARCH_PRIMARY_STEP_ID,
    input: webInput,
    label: "Web Search",
    stepLifecycle,
    type: "web_search",
  });
  recordSkillResult(webResult);

  addTraceStep({
    id: WEB_SEARCH_PRIMARY_STEP_ID,
    type: "web_search",
    label: "Web Search",
    status: webResult.ok ? "completed" : "failed",
    summary: webResult.ok
      ? "Web search returned supplemental context."
      : `Web search failed: ${serializeError(
          webResult.error,
          "Unable to answer from web search."
        )}`,
    input: webInput,
    output: buildTextCitationStepOutput(webResult),
    error: buildStepError(webResult, "Unable to answer from web search."),
    detail: buildSkillTraceDetail(webResult),
  });

  return {
    skippedWebBecauseBudget: false,
    webResult,
  };
};
