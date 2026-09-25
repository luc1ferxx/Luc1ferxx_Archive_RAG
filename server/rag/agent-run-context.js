import {
  appendTraceStep,
  buildBudgetLimitStep,
  createAgentBudget,
  getBudgetSnapshot as getAgentBudgetSnapshot,
} from "./agent-budget.js";
import { getActiveRunUsage } from "./run-usage.js";
import { addActiveSpanEvent, getActiveTraceId } from "./tracing.js";
import { buildAgentExperienceMemoryObservability } from "./agent-experience-memory.js";
import { buildClarificationResponse } from "./agent-response-builder.js";
import { getSkillDescriptor } from "./agent-skill-observability.js";
import { buildAgentTraceSummary, buildStep } from "./agent-trace.js";
import { emitTraceStep } from "./agent-event-stream.js";
import { createLongMemoryObservability } from "./long-memory.js";
import { recordRagTrace } from "./observability.js";

const defaultSkillTracker = {
  getAgentSkills: () => [],
  getSelectedSkills: () => [],
  getSkillObservations: () => [],
  getSkillRuns: () => [],
};

const createDefaultExecutionPlanner = () => ({
  fallback: false,
  fallbackReason: null,
  requestedPlannerId: null,
  selectedPlannerId: null,
  status: "not_run",
  stepIds: [],
});

const createDefaultIntentPlanner = () => ({
  candidateIntentIds: [],
  fallback: false,
  fallbackReason: null,
  requestedPlannerId: null,
  selectedIntentId: null,
  selectedMode: null,
  selectedPlannerId: null,
  selectionReason: null,
  status: "not_run",
});

export const createAgentRunContext = ({
  agentBudget,
  chainSkills = [],
  docIds = [],
  experienceMemory = null,
  executionLoop,
  intentPlanner: initialIntentPlanner,
  longMemory = null,
  plan,
  question,
  recordTrace = recordRagTrace,
  selectedSkills = [],
  taskMemory = null,
  timestamp = () => new Date().toISOString(),
  workingMemory,
} = {}) => {
  const trace = [];
  const budgetState = createAgentBudget(agentBudget, {
    runUsage: getActiveRunUsage(),
  });
  let agentRetrievalPlan = null;
  let executionPlanner = createDefaultExecutionPlanner();
  let intentPlanner = {
    ...createDefaultIntentPlanner(),
    ...(initialIntentPlanner ?? {}),
    candidateIntentIds: Array.isArray(initialIntentPlanner?.candidateIntentIds)
      ? initialIntentPlanner.candidateIntentIds
      : [],
  };
  let skillTracker = defaultSkillTracker;

  const getBudgetSnapshot = () => getAgentBudgetSnapshot(budgetState);

  // A step reaches a streaming client only once it is really in the trace, so the
  // stream never shows a step the trace budget dropped.
  const recordStep = (builtStep) => {
    const appended = appendTraceStep({ budgetState, trace, step: builtStep });

    if (appended) {
      emitTraceStep(builtStep);
      // The same compact fields the stream gets; never step detail.
      addActiveSpanEvent("agent.step", {
        "agent.step.label": builtStep.label,
        "agent.step.status": builtStep.status,
        "agent.step.type": builtStep.type,
      });
    }

    return appended;
  };

  const addTraceStep = (step) =>
    recordStep(
      buildStep({
        index: trace.length + 1,
        ...step,
      })
    );

  const addBudgetLimitTrace = ({ reason, tool }) =>
    recordStep(
      buildBudgetLimitStep({
        index: trace.length + 1,
        reason,
        tool,
      })
    );

  const setSkillTracker = (tracker = {}) => {
    skillTracker = {
      ...defaultSkillTracker,
      ...tracker,
    };
  };

  const setAgentRetrievalPlan = (retrievalPlan) => {
    agentRetrievalPlan = retrievalPlan;
    return agentRetrievalPlan;
  };

  const getAgentRetrievalPlan = () => agentRetrievalPlan;

  const setExecutionPlanner = (planner = {}) => {
    executionPlanner = {
      ...createDefaultExecutionPlanner(),
      ...planner,
      stepIds: Array.isArray(planner.stepIds) ? planner.stepIds : [],
    };

    return executionPlanner;
  };

  const setIntentPlanner = (planner = {}) => {
    intentPlanner = {
      ...createDefaultIntentPlanner(),
      ...planner,
      candidateIntentIds: Array.isArray(planner.candidateIntentIds)
        ? planner.candidateIntentIds
        : [],
    };

    return intentPlanner;
  };

  const buildAgentObservability = ({ agentMode }) => ({
    agentMode,
    longMemory:
      longMemory?.observability ??
      longMemory ??
      createLongMemoryObservability(),
    experienceMemory: buildAgentExperienceMemoryObservability(experienceMemory),
    planMode: plan.mode,
    intentPlanner,
    executionPlanner,
    taskMemory,
    skillChain: chainSkills.map((skill) => getSkillDescriptor(skill)),
    executionLoop,
    workingMemory,
    selectedSkills: (
      skillTracker.getSelectedSkills().length > 0
        ? skillTracker.getSelectedSkills()
        : selectedSkills
    ).map((skill) => getSkillDescriptor(skill)),
    skills: skillTracker.getSkillObservations(),
    runs: skillTracker.getSkillRuns(),
    budget: getBudgetSnapshot(),
    // Only when a tracing SDK is recording, so the default response is
    // unchanged; lets a /chat response, feedback record, or agent trace point
    // at its OpenTelemetry trace.
    ...(getActiveTraceId() ? { traceId: getActiveTraceId() } : {}),
  });

  const recordAgentTrace = async ({
    agentMode,
    agentObservability,
    agentSkills,
    status,
  }) =>
    recordTrace({
      traceType: "agent",
      timestamp: timestamp(),
      agentMode,
      planMode: plan.mode,
      docIds,
      agentSkills,
      agentObservability,
      agentIntentPlanner: intentPlanner,
      agentRetrievalPlan,
      agentTraceSummary: buildAgentTraceSummary(trace),
      status,
    });

  const returnClarification = async (clarification, responseContext = {}) => {
    const agentMode = "clarification";

    addTraceStep({
      type: clarification.traceType ?? "clarification_gate",
      label: clarification.traceLabel ?? "Clarification Gate",
      status: "needs_input",
      summary: clarification.summary,
      detail: {
        reason: clarification.reason,
        clarificationQuestion: clarification.question,
        ...(clarification.detail ?? {}),
      },
    });

    const agentObservability = buildAgentObservability({
      agentMode,
    });
    const status = 200;
    const agentSkills = skillTracker.getAgentSkills();

    await recordAgentTrace({
      agentMode,
      agentObservability,
      agentSkills,
      status,
    });

    return buildClarificationResponse({
      clarification,
      agentMode,
      trace,
      agentSkills,
      agentObservability,
      workingMemory,
      question,
      ...responseContext,
    });
  };

  return {
    addBudgetLimitTrace,
    addTraceStep,
    budgetState,
    buildAgentObservability,
    getAgentRetrievalPlan,
    getBudgetSnapshot,
    recordAgentTrace,
    returnClarification,
    setAgentRetrievalPlan,
    setExecutionPlanner,
    setIntentPlanner,
    setSkillTracker,
    trace,
  };
};
