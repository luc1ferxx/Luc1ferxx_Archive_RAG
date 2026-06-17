import { consumeBudget } from "./agent-budget.js";
import {
  SKILL_CHAIN_MODE,
  buildChainedSkillQuestion,
} from "./agent-planner.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { buildFailedSkillResult } from "./skills/registry.js";

const noop = () => {};

const buildSkillStepOutput = (result = {}) =>
  result.ok
    ? {
        abstained: Boolean(result.abstained),
        citationCount: result.citations?.length ?? 0,
        text: result.text ?? "",
      }
    : null;

const buildSkillStepError = (result = {}) =>
  result.ok
    ? null
    : {
        message: serializeError(result.error, "Unable to run custom skill."),
        name: result.error?.name ?? "Error",
      };

export const runCustomSkills = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  budgetState,
  buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result?.skillId,
    skillVersion: result?.skillVersion,
    ...detail,
  }),
  customSkills = [],
  docIds = [],
  executeObservedSkill,
  plan,
  question,
  ragService,
  recordSkippedSkill = noop,
  recordSkillResult = noop,
  retrievalPlan,
  sessionId,
  userId,
} = {}) => {
  const customSkillResults = [];
  const previousChainResults = [];

  for (const customSkill of customSkills) {
    const chainQuestion = plan.mode === SKILL_CHAIN_MODE
      ? buildChainedSkillQuestion({
          question,
          previousResults: previousChainResults,
        })
      : question;
    const customBudget = customSkill.budgetKey
      ? consumeBudget(budgetState, customSkill.budgetKey)
      : null;
    const customResult = customBudget && !customBudget.ok
      ? buildFailedSkillResult(customSkill, new Error(customBudget.reason))
      : await executeObservedSkill(customSkill, {
          ragService,
          question: chainQuestion,
          docIds,
          sessionId,
          userId,
          accessScope,
          retrievalPlan,
        }, {
          phase: "primary",
          budget: customBudget,
        });

    customSkillResults.push(customResult);
    recordSkillResult(customResult);

    if (customResult.ok) {
      previousChainResults.push(customResult);
    }

    if (customBudget && !customBudget.ok) {
      recordSkippedSkill({
        skill: customSkill,
        result: customResult,
        phase: "primary",
        budget: customBudget,
      });
      addBudgetLimitTrace({
        tool: customSkill.label,
        reason: customBudget.reason,
      });
      continue;
    }

    const customInput = {
      docIds,
      question: chainQuestion,
      retrievalPlan,
      sessionId: sessionId ?? null,
      skillId: customSkill.id,
      skillVersion: customSkill.version,
      userId: userId ?? null,
    };

    addTraceStep({
      type: "custom_skill",
      label: customSkill.label,
      status: customResult.ok ? "completed" : "failed",
      summary: customResult.ok
        ? `${customSkill.label} completed with ${customResult.citations?.length ?? 0} citation${
            customResult.citations?.length === 1 ? "" : "s"
          }.`
        : `${customSkill.label} failed: ${serializeError(
            customResult.error,
            "Unable to run custom skill."
          )}`,
      input: customInput,
      output: buildSkillStepOutput(customResult),
      error: buildSkillStepError(customResult),
      detail: buildSkillTraceDetail(customResult, {
        skillKind: customSkill.kind,
        chainMode: plan.mode === SKILL_CHAIN_MODE,
        previousSkillCount: Math.max(0, previousChainResults.length - 1),
        ...(customResult.traceDetail ?? {}),
      }),
    });
  }

  return customSkillResults;
};
