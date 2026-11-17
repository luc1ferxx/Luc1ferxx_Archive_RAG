import { consumeBudget } from "./agent-budget.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { runLifecycleStep } from "./agent-step-lifecycle-runner.js";
import { buildStepError } from "./agent-step-io.js";
import { buildFailedSkillResult } from "./skills/registry.js";

const noop = () => {};
const WEB_SEARCH_PRIMARY_STEP_ID = "web_search:primary";

export const runWebSearchSkill = async ({
  accessScope,
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

  // Web search asks the user first, and a request carries no approval: the
  // Skill's approval interrupt pauses this step and the run (runLifecycleStep
  // rethrows it), and the approved capability_call step searches and answers
  // (agent-run-step-handlers/capability-steps.js). The result here is a failed
  // Skill: input the Capability's policy refused, no registry, or the Skill's
  // own invariant error (skills/built-ins.js).
  const webInput = {
    question,
  };
  const webResult = await runLifecycleStep({
    buildError: (result) =>
      buildStepError(result, "Unable to answer from web search."),
    execute: () =>
      executeObservedSkill(
        webSearchSkill,
        {
          accessScope,
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
    persistedInput: null,
    stepLifecycle,
    type: "web_search",
  });
  recordSkillResult(webResult);

  addTraceStep({
    id: WEB_SEARCH_PRIMARY_STEP_ID,
    type: "web_search",
    label: "Web Search",
    status: "failed",
    summary: `Web search failed: ${serializeError(
      webResult.error,
      "Unable to answer from web search."
    )}`,
    input: webInput,
    output: null,
    error: buildStepError(webResult, "Unable to answer from web search."),
    detail: buildSkillTraceDetail(webResult),
  });

  return {
    skippedWebBecauseBudget: false,
    webResult,
  };
};
