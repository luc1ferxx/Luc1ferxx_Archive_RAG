import { runDocumentRagLoop } from "./agent-document-loop.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import {
  AGENT_EXECUTION_CONDITIONS,
  AGENT_EXECUTION_STEP_IDS,
  createDeterministicAgentExecutionPlan,
  validateAgentExecutionPlan,
} from "./agent-execution-plan.js";
import {
  runArxivImportSkill,
  runDocumentDiscoverySkill,
  runInventorySkill,
  runResearchBriefSkill,
  runWorkspaceActionSkill,
} from "./agent-built-in-skill-runners.js";
import { runCustomSkillStage } from "./agent-custom-skill-stage.js";
import { runWebSearchSkill } from "./agent-web-runner.js";
import { getAgentOuterPlanRuntime } from "./config.js";
import { toDependencyOutageError } from "./dependency-outage.js";
import { throwIfRequestCancelled } from "./request-deadline.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";

// The V1 outer execution plan: the fixed stages (built-in Skills, custom
// Skills, the document loop, the Web fallback) in the order the validated plan
// lists them. Two schedulers walk the same stages: runAgentExecutionPlan below
// (the native loop, under both values of AGENT_RUNTIME) and
// rag/langgraph/execution-plan-graph.js (a low-level LangGraph Pregel, only
// under the experimental AGENT_OUTER_PLAN_RUNTIME=langgraph). The stages, their
// closure-owned state and the two decisions the loop makes between them (the
// safe point before a stage, the early return once a stage produced the
// response) are defined here once, so the graph reuses them and never
// re-derives the plan.
//
// The native loop is not part of the phase-4 rollback set
// (docs/adr/0001-langgraph-runtime.md): the phase-3 load test decided that
// the outer plan stays on it whatever AGENT_RUNTIME says, so it is the
// production scheduler of the outer plan, not a fallback to delete. Phase 4
// flipped only AGENT_RUNTIME's default; AGENT_OUTER_PLAN_RUNTIME still
// defaults to `native`.

const getCustomSkills = (selectedSkills = []) =>
  selectedSkills.filter((skill) => skill.kind === "custom");

// A stage whose every Skill failed because a dependency is down produced
// nothing to answer with: the run ends with that outage (dependency-outage.js)
// instead of finalizing an empty answer.
const findWholeStageOutage = (results = []) => {
  if (results.length === 0 || results.some((result) => result?.ok !== false)) {
    return null;
  }

  const outages = results.map((result) => toDependencyOutageError(result.error));

  return outages.every(Boolean) ? outages[0] : null;
};

/** The loop's one routing decision: a stage set the response, so the plan ends. */
export const hasAgentExecutionPlanResponse = (state) => Boolean(state?.response);

// The built-in stages whose body, without its selected Skill, is a
// getSelectedSkill lookup and a runner whose first statement is
// `if (!skill) return null` (agent-built-in-skill-runners.js): stage id -> the
// Skill id that stage body looks up. custom_skills, document_rag and
// web_search are deliberately absent: each decides at run time (the custom
// stage may run authorized Skills the intent did not select, the document
// loop runs without a selected Skill, the Web stage is the document result's
// fallback). test/agent-execution-plan-pruning.test.mjs runs each of these
// stage bodies with every collaborator wired to a tripwire and pins that the
// body looks up exactly this Skill id and touches nothing else.
const SELECTED_SKILL_ONLY_STAGE_SKILL_IDS = Object.freeze({
  [AGENT_EXECUTION_STEP_IDS.arxivImport]: AGENT_SKILL_IDS.arxivImport,
  [AGENT_EXECUTION_STEP_IDS.workspaceAction]: AGENT_SKILL_IDS.workspaceAction,
  [AGENT_EXECUTION_STEP_IDS.researchBrief]: AGENT_SKILL_IDS.researchBrief,
  [AGENT_EXECUTION_STEP_IDS.inventory]: AGENT_SKILL_IDS.inventory,
  [AGENT_EXECUTION_STEP_IDS.documentDiscovery]: AGENT_SKILL_IDS.documentDiscovery,
});

/**
 * True exactly when the stage body of `step` would return without any effect
 * (no step, run event, trace step, budget charge, agent event or state
 * change): one of the five built-in stages above, under its `selected_skill`
 * condition, whose Skill `getSelectedSkill` -- the same lookup, over the same
 * options, the stage body makes -- does not return. A scheduler may skip such
 * a stage; the only thing it then leaves out is the safe point before it,
 * which the next stage's safe point (or the end of the plan) stands in for,
 * because the skipped body could not have changed anything in between.
 * Anything it cannot decide (no lookup, a lookup that throws) is not inert,
 * so the stage runs and fails exactly as natively. The native loop never
 * calls it.
 */
export const isAgentExecutionPlanStageStaticallyInert = (step, { getSelectedSkill } = {}) => {
  const skillId = Object.hasOwn(SELECTED_SKILL_ONLY_STAGE_SKILL_IDS, step?.id)
    ? SELECTED_SKILL_ONLY_STAGE_SKILL_IDS[step.id]
    : null;

  if (
    !skillId ||
    step.condition !== AGENT_EXECUTION_CONDITIONS.selectedSkill ||
    typeof getSelectedSkill !== "function"
  ) {
    return false;
  }

  try {
    return !getSelectedSkill(skillId);
  } catch {
    return false;
  }
};

/**
 * An error a stage threw, as the loop rethrows it: an approval interrupt
 * carries the execution state so far (agent.js answers the clarification
 * with the document result already in hand); every other error is unchanged.
 */
export const tagAgentExecutionPlanError = (error, state) => {
  if (isAgentRunInterrupt(error)) {
    error.agentExecutionState = state;
  }

  return error;
};

/**
 * Validates the plan and builds its stages over one shared state object:
 * `{ executionPlan, getStage, state }`, where `getStage(step)` returns the
 * stage body of a validated step (and throws for an unknown one). Each stage
 * decides for itself whether its Skill was selected, exactly as the native
 * loop always ran them (a built-in stage without its Skill returns null,
 * the custom stage may run authorized Skills the intent did not select, and
 * the Web stage reads the document result), so a scheduler enters every
 * stage of the plan in order and reads the two decisions above between them.
 */
export const createAgentExecutionPlanStages = ({
  accessScope,
  addBudgetLimitTrace,
  addTraceStep,
  agentRunId,
  authorizedCustomSkills = null,
  arxivImportService,
  budgetState,
  buildSkillTraceDetail,
  capabilityRegistry,
  dagPlannerAdapter = null,
  docIds,
  executeObservedSkill,
  executionLoop,
  executionPlan = createDeterministicAgentExecutionPlan(),
  getSelectedSkill,
  loadExecutionGraphCheckpoint = null,
  plan,
  question,
  ragService,
  recordExecutionGaps,
  recordExecutionGraph,
  recordSkippedSkill,
  recordSkillResult,
  recordWorkingMemoryClaimSupport,
  recordWorkingMemoryGaps,
  registry,
  replanAdapter = null,
  resolveWorkingMemoryGaps,
  retrievalPlan,
  returnClarification,
  selectedSkills = [],
  sessionId,
  saveExecutionGraphCheckpoint = null,
  skillGraphMode,
  stepLifecycle,
  taskMemory = null,
  userId,
  webChatService,
} = {}) => {
  const validatedExecutionPlan = validateAgentExecutionPlan({
    accessScope,
    authorizedCustomSkills: authorizedCustomSkills ?? [],
    executionPlan,
    registry,
    selectedSkills,
  });
  const state = {
    arxivImportAnswer: null,
    actionAnswer: null,
    customSkillResults: [],
    customSkillGraphExecuted: false,
    customSkills: getCustomSkills(selectedSkills),
    discoveryAnswer: null,
    documentEvidenceClarification: null,
    documentRagSkill: null,
    inventoryAnswer: null,
    ragResult: null,
    researchBrief: null,
    response: null,
    shouldRunWeb: false,
    skippedWebBecauseBudget: false,
    webResult: null,
  };

  const stepHandlers = {
    [AGENT_EXECUTION_STEP_IDS.arxivImport]: async () => {
      const arxivImportSkill = getSelectedSkill(AGENT_SKILL_IDS.arxivImport);

      state.arxivImportAnswer = await runArxivImportSkill({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        arxivImportService,
        arxivImportSkill,
        budgetState,
        buildSkillTraceDetail,
        capabilityRegistry,
        executeObservedSkill,
        question,
        recordSkippedSkill,
        recordSkillResult,
        stepLifecycle,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.workspaceAction]: async () => {
      const workspaceActionSkill = getSelectedSkill(
        AGENT_SKILL_IDS.workspaceAction
      );

      state.actionAnswer = await runWorkspaceActionSkill({
        accessScope,
        addTraceStep,
        agentRunId,
        buildSkillTraceDetail,
        capabilityRegistry,
        docIds,
        executeObservedSkill,
        plan,
        question,
        recordSkillResult,
        workspaceActionSkill,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.researchBrief]: async () => {
      const researchSkill = getSelectedSkill(AGENT_SKILL_IDS.researchBrief);

      state.researchBrief = await runResearchBriefSkill({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        docIds,
        executeObservedSkill,
        question,
        ragService,
        recordSkillResult,
        researchSkill,
        sessionId,
        stepLifecycle,
        userId,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.inventory]: async () => {
      const inventorySkill = getSelectedSkill(AGENT_SKILL_IDS.inventory);

      state.inventoryAnswer = await runInventorySkill({
        accessScope,
        addTraceStep,
        buildSkillTraceDetail,
        capabilityRegistry,
        executeObservedSkill,
        inventorySkill,
        ragService,
        recordSkillResult,
        stepLifecycle,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.documentDiscovery]: async () => {
      const discoverySkill = getSelectedSkill(AGENT_SKILL_IDS.documentDiscovery);

      state.discoveryAnswer = await runDocumentDiscoverySkill({
        accessScope,
        addTraceStep,
        buildSkillTraceDetail,
        capabilityRegistry,
        discoverySkill,
        docIds,
        executeObservedSkill,
        question,
        ragService,
        recordSkillResult,
        stepLifecycle,
      });
    },

    [AGENT_EXECUTION_STEP_IDS.customSkills]: async () => {
      // Still one stage, still custom_skill steps, still a flat result array.
      // Everything the rollout dial changes happens inside runCustomSkillStage,
      // so this call site does not learn whether a chain or a graph ran.
      state.customSkillResults = await runCustomSkillStage({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        authorizedCustomSkills,
        customSkills: state.customSkills,
        docIds,
        executeObservedSkill,
        loadExecutionGraphCheckpoint,
        plan,
        plannerAdapter: dagPlannerAdapter,
        question,
        ragService,
        recordExecutionGraph: (event) => {
          state.customSkillGraphExecuted =
            event?.mode === "guarded" && event?.executed === true;
          return recordExecutionGraph?.(event);
        },
        recordSkippedSkill,
        recordSkillResult,
        registry,
        replanAdapter,
        retrievalPlan,
        saveExecutionGraphCheckpoint,
        sessionId,
        stepLifecycle,
        taskMemory,
        userId,
        ...(skillGraphMode ? { mode: skillGraphMode } : {}),
      });

      const outage = findWholeStageOutage(state.customSkillResults);

      if (outage) {
        throw outage;
      }
    },

    [AGENT_EXECUTION_STEP_IDS.documentRag]: async () => {
      state.documentRagSkill = getSelectedSkill(AGENT_SKILL_IDS.documentRag);

      const documentLoopResult = await runDocumentRagLoop({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        docIds,
        documentRagSkill: state.documentRagSkill,
        executeObservedSkill,
        executionLoop,
        plan,
        question,
        ragService,
        recordExecutionGaps,
        recordSkippedSkill,
        recordSkillResult,
        recordWorkingMemoryClaimSupport,
        recordWorkingMemoryGaps,
        resolveWorkingMemoryGaps,
        retrievalPlan,
        sessionId,
        stepLifecycle,
        userId,
      });

      state.ragResult = documentLoopResult.ragResult;
      state.documentEvidenceClarification =
        documentLoopResult.documentEvidenceClarification;

      if (state.documentEvidenceClarification && !plan.wantsWeb) {
        state.response = await returnClarification(
          state.documentEvidenceClarification
        );
      }
    },

    [AGENT_EXECUTION_STEP_IDS.webSearch]: async () => {
      const plannedWebSearchSkill = getSelectedSkill(AGENT_SKILL_IDS.webSearch);
      const webSearchSkill =
        plannedWebSearchSkill ??
        registry?.get?.(AGENT_SKILL_IDS.webSearch) ??
        null;

      state.shouldRunWeb =
        Boolean(webSearchSkill) &&
        (Boolean(plannedWebSearchSkill) ||
          (state.ragResult?.ok && state.ragResult.value.abstained) ||
          state.ragResult?.ok === false);

      const webSearchResult = await runWebSearchSkill({
        accessScope,
        addBudgetLimitTrace,
        addTraceStep,
        budgetState,
        buildSkillTraceDetail,
        capabilityRegistry,
        executeObservedSkill,
        plannedWebSearchSkill,
        question,
        recordSkippedSkill,
        recordSkillResult,
        shouldRunWeb: state.shouldRunWeb,
        stepLifecycle,
        webChatService,
        webSearchSkill,
      });

      state.webResult = webSearchResult.webResult;
      state.skippedWebBecauseBudget = webSearchResult.skippedWebBecauseBudget;
    },
  };

  const getStage = (step) => {
    const runStep = stepHandlers[step.id];

    if (!runStep) {
      throw new Error(`Unknown AgentRAG execution step: ${step.id}.`);
    }

    return runStep;
  };

  return { executionPlan: validatedExecutionPlan, getStage, state };
};

export const runAgentExecutionPlan = async (options = {}) => {
  const { executionPlan, getStage, state } = createAgentExecutionPlanStages(options);

  for (const step of executionPlan) {
    const runStep = getStage(step);

    try {
      // Each stage boundary is a safe point for a cancelled request
      // (request-deadline.js); inside a stage, step starts are.
      throwIfRequestCancelled();
      await runStep(step);
    } catch (error) {
      throw tagAgentExecutionPlanError(error, state);
    }

    if (hasAgentExecutionPlanResponse(state)) {
      return state;
    }
  }

  return state;
};

/**
 * The scheduler of the outer plan for `runtime` (AGENT_OUTER_PLAN_RUNTIME,
 * never AGENT_RUNTIME: config.js says why): the native loop, or the LangGraph
 * Pregel over the same stages. The LangGraph module is imported only when
 * selected, so a process with the outer plan on the native loop never loads
 * it. Both take runAgentExecutionPlan's options and return its state.
 */
export const resolveAgentExecutionPlanRunner = async (
  runtime = getAgentOuterPlanRuntime()
) => {
  if (runtime !== "langgraph") {
    return runAgentExecutionPlan;
  }

  const { runAgentExecutionPlanOnLangGraph } = await import(
    "./langgraph/execution-plan-graph.js"
  );

  return runAgentExecutionPlanOnLangGraph;
};
