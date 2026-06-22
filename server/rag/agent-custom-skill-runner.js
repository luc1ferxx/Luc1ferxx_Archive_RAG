import { consumeBudget } from "./agent-budget.js";
import {
  SKILL_CHAIN_MODE,
  buildChainedSkillQuestion,
} from "./agent-planner.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { runLifecycleStep } from "./agent-step-lifecycle-runner.js";
import { buildFailedSkillResult } from "./skills/registry.js";

const noop = () => {};

const buildSkillStepOutput = (result = {}) => {
  const hasOutput =
    result.ok ||
    Boolean(result.text) ||
    Boolean(result.citations?.length) ||
    Boolean(result.abstained);

  return hasOutput
    ? {
        abstained: Boolean(result.abstained),
        citationCount: result.citations?.length ?? 0,
        text: result.text ?? "",
      }
    : null;
};

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
  stepLifecycle,
  userId,
} = {}) => {
  const customSkillResults = [];
  const previousChainResults = [];
  const skillExecutionCounts = new Map();

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
      : null;

    if (customBudget && !customBudget.ok) {
      customSkillResults.push(customResult);
      recordSkillResult(customResult);
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

    const executionCount = skillExecutionCounts.get(customSkill.id) ?? 0;
    skillExecutionCounts.set(customSkill.id, executionCount + 1);
    const customStepId =
      executionCount === 0
        ? `custom_skill:${customSkill.id}`
        : `custom_skill:${customSkill.id}:${executionCount + 1}`;
    const customInput = {
      docIds,
      question: chainQuestion,
      retrievalPlan,
      sessionId: sessionId ?? null,
      skillId: customSkill.id,
      skillVersion: customSkill.version,
      userId: userId ?? null,
    };
    const executedCustomResult = await runLifecycleStep({
      buildError: buildSkillStepError,
      buildOutput: buildSkillStepOutput,
      execute: () =>
        executeObservedSkill(
          customSkill,
          {
            ragService,
            question: chainQuestion,
            docIds,
            sessionId,
            userId,
            accessScope,
            retrievalPlan,
          },
          {
            phase: "primary",
            budget: customBudget,
          }
        ),
      id: customStepId,
      input: customInput,
      label: customSkill.label,
      stepLifecycle,
      type: "custom_skill",
    });

    customSkillResults.push(executedCustomResult);
    recordSkillResult(executedCustomResult);

    if (executedCustomResult.ok) {
      previousChainResults.push(executedCustomResult);
    }

    addTraceStep({
      id: customStepId,
      type: "custom_skill",
      label: customSkill.label,
      status: executedCustomResult.ok ? "completed" : "failed",
      summary: executedCustomResult.ok
        ? `${customSkill.label} completed with ${executedCustomResult.citations?.length ?? 0} citation${
            executedCustomResult.citations?.length === 1 ? "" : "s"
          }.`
        : `${customSkill.label} failed: ${serializeError(
            executedCustomResult.error,
            "Unable to run custom skill."
          )}`,
      input: customInput,
      output: buildSkillStepOutput(executedCustomResult),
      error: buildSkillStepError(executedCustomResult),
      detail: buildSkillTraceDetail(executedCustomResult, {
        skillKind: customSkill.kind,
        chainMode: plan.mode === SKILL_CHAIN_MODE,
        previousSkillCount: Math.max(0, previousChainResults.length - 1),
        ...(executedCustomResult.traceDetail ?? {}),
      }),
    });
  }

  return customSkillResults;
};
