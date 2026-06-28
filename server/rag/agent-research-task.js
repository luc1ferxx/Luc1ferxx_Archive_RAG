import { createDefaultAgentWorkflowRegistry } from "./agent-workflows/registry.js";
import {
  renderAgentWorkflowTemplate,
  resolveAgentWorkflowPhase,
} from "./agent-workflows/schema.js";

export const AGENT_RESEARCH_TASK_VERSION = "1.0.0";
export const AGENT_RESEARCH_TASK_TYPE = "research_task";

const MAX_TEXT_LENGTH = 320;

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeDocIds = (value) =>
  toArray(value).map((item) => normalizeText(item)).filter(Boolean);

const isClarificationResponse = (body = {}) =>
  body.clarification?.needed === true || body.agentMode === "clarification";

const defaultWorkflowRegistry = createDefaultAgentWorkflowRegistry();

const buildPhase = ({
  expectedCapability = "",
  expectedSkill = "",
  id,
  label,
  question,
  summary,
} = {}) => ({
  expectedCapability: normalizeText(expectedCapability, 120),
  expectedSkill: normalizeText(expectedSkill, 120),
  id: normalizeText(id, 80),
  label: normalizeText(label, 120),
  question: normalizeText(question, 1000),
  status: "pending",
  summary: normalizeText(summary),
});

const selectResearchTaskWorkflow = ({
  question = "",
  workflowRegistry = defaultWorkflowRegistry,
} = {}) => workflowRegistry?.select?.({ question }) ?? null;

export const isResearchTaskGoal = ({
  question = "",
  workflowRegistry = defaultWorkflowRegistry,
} = {}) =>
  Boolean(
    selectResearchTaskWorkflow({
      question: normalizeText(question),
      workflowRegistry,
    })
  );

const normalizeOptionalNumber = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
};

function compactWorkflowDeliverable(deliverable = {}) {
  const deliverableRecord = normalizeRecord(deliverable);

  return {
    approvalRequired: deliverableRecord.approvalRequired !== false,
    artifactType: normalizeText(deliverableRecord.artifactType, 80),
    capabilityId: normalizeText(deliverableRecord.capabilityId, 120),
    label: normalizeText(deliverableRecord.label, 120),
    optional: deliverableRecord.optional === true,
    title: normalizeText(deliverableRecord.title, 160),
  };
}

const buildWorkflowSnapshot = (workflow = {}) => {
  const workflowRecord = normalizeRecord(workflow);
  const workflowId = normalizeText(workflowRecord.id, 120);

  if (!workflowId) {
    return null;
  }

  return {
    completionChecks: toArray(workflowRecord.completionChecks).map((item) =>
      normalizeText(item, 120)
    ),
    deliverables: toArray(workflowRecord.deliverables).map(
      compactWorkflowDeliverable
    ),
    id: workflowId,
    label: normalizeText(workflowRecord.label, 160),
    type: normalizeText(workflowRecord.type, 80),
    version: normalizeText(workflowRecord.version, 40),
  };
};

const getWorkflowMaxIterations = ({ phaseCount = 0, workflow = {} } = {}) => {
  const budget = normalizeRecord(workflow.iterationBudget);
  const phaseBuffer = normalizeOptionalNumber(budget.phaseBuffer) ?? 4;
  const fallbackMaxIterations = Math.min(phaseCount + phaseBuffer, 10);
  const maxIterations = normalizeOptionalNumber(budget.maxIterations);

  return maxIterations !== null
    ? Math.min(Math.max(1, Math.trunc(maxIterations)), 10)
    : fallbackMaxIterations;
};

const buildResearchTaskPhasesFromWorkflow = ({
  docIds = [],
  goal = "",
  workflow = {},
} = {}) => {
  const context = {
    docIds,
    goal,
    question: goal,
  };

  return toArray(workflow.phases).map((phase) => {
    const resolvedPhase = resolveAgentWorkflowPhase(phase, context);

    return buildPhase({
      expectedCapability: resolvedPhase.expectedCapability,
      expectedSkill: resolvedPhase.expectedSkill,
      id: resolvedPhase.id,
      label: resolvedPhase.label,
      question: renderAgentWorkflowTemplate(
        resolvedPhase.questionTemplate,
        context
      ),
      summary: resolvedPhase.summary,
    });
  });
};

const getFirstPendingPhase = (phases = []) =>
  phases.find((phase) => phase.status === "pending") ?? null;

const getPhaseIndex = ({ phases = [], phaseId = "" } = {}) =>
  phases.findIndex((phase) => phase.id === phaseId);

export const createResearchTaskFlow = ({
  docIds = [],
  question = "",
  workflowRegistry = defaultWorkflowRegistry,
} = {}) => {
  const goal = normalizeText(question);
  const workflow = selectResearchTaskWorkflow({
    question: goal,
    workflowRegistry,
  });

  if (!workflow) {
    return null;
  }

  const normalizedDocIds = normalizeDocIds(docIds);
  const phases = buildResearchTaskPhasesFromWorkflow({
    docIds: normalizedDocIds,
    goal,
    workflow,
  });
  const firstPhase = phases[0] ?? null;

  return {
    version: AGENT_RESEARCH_TASK_VERSION,
    type: AGENT_RESEARCH_TASK_TYPE,
    goal,
    status: firstPhase ? "running" : "completed",
    currentPhaseId: firstPhase?.id ?? null,
    docIds: normalizedDocIds,
    workflow: buildWorkflowSnapshot(workflow),
    phases: firstPhase
      ? [
          {
            ...firstPhase,
            status: "running",
          },
          ...phases.slice(1),
        ]
      : [],
    maxIterations: getWorkflowMaxIterations({
      phaseCount: phases.length,
      workflow,
    }),
  };
};

export const normalizeResearchTaskFlow = (flow = null) => {
  const normalizedFlow = normalizeRecord(flow, null);

  if (!normalizedFlow) {
    return null;
  }

  const phases = toArray(normalizedFlow.phases)
    .map((phase) => ({
      expectedCapability: normalizeText(phase.expectedCapability, 120),
      expectedSkill: normalizeText(phase.expectedSkill, 120),
      id: normalizeText(phase.id, 80),
      label: normalizeText(phase.label, 120),
      question: normalizeText(phase.question, 1000),
      status: normalizeText(phase.status, 80) || "pending",
      summary: normalizeText(phase.summary),
    }))
    .filter((phase) => phase.id);
  const currentPhaseId =
    normalizeText(normalizedFlow.currentPhaseId, 80) ||
    phases.find((phase) => phase.status === "running")?.id ||
    getFirstPendingPhase(phases)?.id ||
    null;

  return {
    version: normalizeText(normalizedFlow.version, 40) || AGENT_RESEARCH_TASK_VERSION,
    type: normalizeText(normalizedFlow.type, 80) || AGENT_RESEARCH_TASK_TYPE,
    goal: normalizeText(normalizedFlow.goal),
    status: normalizeText(normalizedFlow.status, 80) || "running",
    currentPhaseId,
    docIds: normalizeDocIds(normalizedFlow.docIds),
    workflow: buildWorkflowSnapshot(normalizedFlow.workflow),
    phases,
    maxIterations: Number.isFinite(Number(normalizedFlow.maxIterations))
      ? Number(normalizedFlow.maxIterations)
      : Math.min(phases.length + 4, 10),
  };
};

export const getResearchTaskActivePhase = (flow = null) => {
  const normalizedFlow = normalizeResearchTaskFlow(flow);

  if (!normalizedFlow || normalizedFlow.status !== "running") {
    return null;
  }

  return (
    normalizedFlow.phases.find(
      (phase) => phase.id === normalizedFlow.currentPhaseId
    ) ??
    normalizedFlow.phases.find((phase) => phase.status === "running") ??
    getFirstPendingPhase(normalizedFlow.phases)
  );
};

export const getResearchTaskQuestion = (flow = null) =>
  normalizeText(getResearchTaskActivePhase(flow)?.question, 1000);

export const getResearchTaskIterationPhase = (flow = null) => {
  const phase = getResearchTaskActivePhase(flow);

  return phase
    ? {
        expectedCapability: phase.expectedCapability,
        expectedSkill: phase.expectedSkill,
        id: phase.id,
        label: phase.label,
        summary: phase.summary,
      }
    : null;
};

export const advanceResearchTaskFlow = ({
  body = {},
  flow = null,
  responseStatus = 200,
} = {}) => {
  const normalizedFlow = normalizeResearchTaskFlow(flow);
  const activePhase = getResearchTaskActivePhase(normalizedFlow);

  if (!normalizedFlow || !activePhase) {
    return normalizedFlow;
  }

  if (responseStatus >= 400 || isClarificationResponse(body)) {
    return normalizedFlow;
  }

  const activeIndex = getPhaseIndex({
    phases: normalizedFlow.phases,
    phaseId: activePhase.id,
  });
  const phases = normalizedFlow.phases.map((phase, index) => {
    if (index < activeIndex || phase.status === "completed") {
      return {
        ...phase,
        status: "completed",
      };
    }

    if (index === activeIndex) {
      return {
        ...phase,
        status: "completed",
      };
    }

    return {
      ...phase,
      status: "pending",
    };
  });
  const nextPhase = phases.find((phase) => phase.status === "pending") ?? null;

  if (!nextPhase) {
    return {
      ...normalizedFlow,
      currentPhaseId: null,
      phases,
      status: "completed",
    };
  }

  return {
    ...normalizedFlow,
    currentPhaseId: nextPhase.id,
    phases: phases.map((phase) =>
      phase.id === nextPhase.id
        ? {
            ...phase,
            status: "running",
          }
        : phase
    ),
    status: "running",
  };
};

export const shouldContinueResearchTask = (flow = null) =>
  Boolean(getResearchTaskQuestion(flow));

export const compactResearchTaskFlow = (flow = null) => {
  const normalizedFlow = normalizeResearchTaskFlow(flow);

  if (!normalizedFlow) {
    return null;
  }

  return {
    version: normalizedFlow.version,
    type: normalizedFlow.type,
    goal: normalizedFlow.goal,
    status: normalizedFlow.status,
    currentPhaseId: normalizedFlow.currentPhaseId,
    counts: {
      completed: normalizedFlow.phases.filter(
        (phase) => phase.status === "completed"
      ).length,
      total: normalizedFlow.phases.length,
    },
    phases: normalizedFlow.phases.map((phase) => ({
      expectedCapability: phase.expectedCapability,
      expectedSkill: phase.expectedSkill,
      id: phase.id,
      label: phase.label,
      status: phase.status,
      summary: phase.summary,
    })),
  };
};
