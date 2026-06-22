import {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
  assertAgentRunStepStatusTransition,
  createUnsupportedAgentRunStepStatusError,
  isKnownAgentRunStepStatus,
  normalizeAgentRunStepKind,
  normalizeAgentRunStepStatus,
} from "./agent-run-transitions.js";

export {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
  assertAgentRunStepStatusTransition,
  createUnsupportedAgentRunStepStatusError,
  isKnownAgentRunStepStatus,
  normalizeAgentRunStepKind,
  normalizeAgentRunStepStatus,
} from "./agent-run-transitions.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toPositiveInteger = (value, fallback = 1) => {
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const TOOL_TRACE_TYPES = new Set([
  "arxiv_import",
  "custom_skill",
  "document_discovery",
  "document_rag",
  "follow_up_retrieval",
  "inventory",
  "research_question",
  "web_search",
]);

const OBSERVATION_TRACE_TYPES = new Set([
  "evidence_clarification",
  "gap_analysis",
  "self_check",
]);

const PLAN_TRACE_TYPES = new Set([
  "plan",
  "query_planner",
  "research_plan",
  "skill_chain",
]);

const DECISION_TRACE_TYPES = new Set([
  "budget_limit",
  "clarification_gate",
  "execution_planner",
  "finalizer",
  "synthesis",
]);

const classifyTraceStep = (step = {}) => {
  const type = normalizeText(step.type).toLowerCase();

  if (type.includes("approval") || step.status === "needs_input") {
    return AGENT_RUN_STEP_KINDS.approvalGate;
  }

  if (PLAN_TRACE_TYPES.has(type)) {
    return AGENT_RUN_STEP_KINDS.plan;
  }

  if (TOOL_TRACE_TYPES.has(type)) {
    return AGENT_RUN_STEP_KINDS.toolCall;
  }

  if (OBSERVATION_TRACE_TYPES.has(type)) {
    return AGENT_RUN_STEP_KINDS.observation;
  }

  if (DECISION_TRACE_TYPES.has(type)) {
    return AGENT_RUN_STEP_KINDS.decision;
  }

  return AGENT_RUN_STEP_KINDS.observation;
};

const getApprovalGateFromTraceStep = (step = {}) => {
  const detail = normalizeRecord(step.detail);
  const approvalGate = normalizeRecord(detail.approvalGate, null);

  if (approvalGate) {
    return approvalGate;
  }

  const approvalGates = toArray(detail.approvalGates);

  return approvalGates[0] ?? null;
};

const getStepTimestamps = ({ existingStep = {}, status, timestamp }) => {
  const base = {
    completedAt: existingStep.completedAt ?? "",
    createdAt: existingStep.createdAt || timestamp,
    pausedAt: existingStep.pausedAt ?? "",
    startedAt: existingStep.startedAt ?? timestamp,
    updatedAt: timestamp,
  };

  if (status === AGENT_RUN_STEP_STATUSES.completed) {
    return {
      ...base,
      completedAt: base.completedAt || timestamp,
    };
  }

  if (status === AGENT_RUN_STEP_STATUSES.failed) {
    return {
      ...base,
      completedAt: base.completedAt || timestamp,
    };
  }

  if (status === AGENT_RUN_STEP_STATUSES.paused) {
    return {
      ...base,
      pausedAt: base.pausedAt || timestamp,
    };
  }

  return base;
};

const normalizeOutputRecord = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  const text = normalizeText(value);

  return text ? { text } : null;
};

const normalizeErrorRecord = (value, fallbackMessage = "") => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  const message = normalizeText(value) || normalizeText(fallbackMessage);

  return message ? { message } : null;
};

const getTraceStepOutput = ({ detail, existingStep, traceStep } = {}) =>
  normalizeOutputRecord(traceStep?.output) ??
  buildDerivedTraceStepOutput({
    detail,
    traceStep,
  }) ??
  normalizeOutputRecord(detail?.output) ??
  existingStep?.output ??
  null;

const countItems = (value) => (Array.isArray(value) ? value.length : 0);

const countUnsupportedClaims = (claimSupport = {}) =>
  typeof claimSupport.unsupportedClaimCount === "number"
    ? claimSupport.unsupportedClaimCount
    : countItems(
        Array.isArray(claimSupport.claims)
          ? claimSupport.claims.filter((claim) => !claim.supported)
          : []
      );

const buildDerivedTraceStepOutput = ({ detail, traceStep } = {}) => {
  const type = normalizeText(traceStep?.type).toLowerCase();

  if (type === "self_check") {
    return normalizeOutputRecord({
      gapCount: countItems(detail?.gaps),
      passed: Boolean(detail?.passed),
      retryRecommended: Boolean(detail?.retryRecommended),
      unsupportedClaimCount: countUnsupportedClaims(detail?.claimSupport),
    });
  }

  if (type === "gap_analysis") {
    return normalizeOutputRecord({
      finalAnswer: Boolean(detail?.finalAnswer),
      followUpRecommended: Boolean(detail?.followUpRecommended),
      gapCount: countItems(detail?.gaps),
    });
  }

  if (type === "answer_finalizer") {
    return normalizeOutputRecord({
      abstained: Boolean(detail?.abstained),
      changed: Boolean(detail?.changed),
      removedClaimCount: countItems(detail?.removedClaims),
      skippedReason: detail?.skippedReason ?? "",
      unsupportedClaimCount: countUnsupportedClaims(detail?.claimSupport),
    });
  }

  return null;
};

const getTraceStepError = ({
  detail,
  existingStep,
  status,
  traceStep,
} = {}) => {
  const explicitError = normalizeErrorRecord(traceStep?.error ?? detail?.error);

  if (explicitError) {
    return explicitError;
  }

  return (
    existingStep?.error ??
    normalizeErrorRecord(
      null,
      status === AGENT_RUN_STEP_STATUSES.failed ? traceStep?.summary : ""
    )
  );
};

export const normalizeAgentRunStep = (
  step = {},
  { index = 0, now = () => new Date().toISOString() } = {}
) => {
  const type = normalizeText(step.type) || "step";
  const id =
    normalizeText(step.id) ||
    normalizeText(step.stepId) ||
    `step:${index + 1}:${type}`;
  const status = normalizeAgentRunStepStatus(step.status);
  const timestamp = normalizeText(step.updatedAt) || now();

  return {
    id,
    type,
    kind: normalizeAgentRunStepKind(step.kind ?? classifyTraceStep(step)),
    status,
    label: normalizeText(step.label) || type,
    summary: normalizeText(step.summary),
    detail: normalizeRecord(step.detail, null),
    parentStepId: normalizeText(step.parentStepId),
    traceStepId: normalizeText(step.traceStepId),
    approvalGateId: normalizeText(step.approvalGateId),
    capabilityId: normalizeText(step.capabilityId),
    capabilityVersion: normalizeText(step.capabilityVersion),
    input: normalizeRecord(step.input, null),
    attempt: toPositiveInteger(step.attempt, 1),
    retryOfStepId: normalizeText(step.retryOfStepId),
    decision: normalizeText(step.decision),
    error: normalizeRecord(step.error, null),
    output: normalizeRecord(step.output, null),
    createdAt: normalizeText(step.createdAt),
    startedAt: normalizeText(step.startedAt),
    pausedAt: normalizeText(step.pausedAt),
    completedAt: normalizeText(step.completedAt),
    updatedAt: timestamp,
  };
};

export const normalizeAgentRunSteps = (steps = []) =>
  toArray(steps).map((step, index) => normalizeAgentRunStep(step, { index }));

export const upsertAgentRunStep = ({ steps = [], step } = {}) => {
  const normalizedStep = normalizeAgentRunStep(step);
  const nextSteps = [];
  let replaced = false;

  for (const existingStep of normalizeAgentRunSteps(steps)) {
    if (existingStep.id === normalizedStep.id) {
      nextSteps.push({
        ...existingStep,
        ...normalizedStep,
        detail: normalizedStep.detail ?? existingStep.detail,
        input: normalizedStep.input ?? existingStep.input,
        output: normalizedStep.output ?? existingStep.output,
        error: normalizedStep.error ?? existingStep.error,
        createdAt: normalizedStep.createdAt || existingStep.createdAt,
        startedAt: normalizedStep.startedAt || existingStep.startedAt,
      });
      replaced = true;
      continue;
    }

    nextSteps.push(existingStep);
  }

  if (!replaced) {
    nextSteps.push(normalizedStep);
  }

  return nextSteps;
};

export const updateAgentRunStep = ({
  now = () => new Date().toISOString(),
  patch = {},
  status,
  stepId,
  steps = [],
} = {}) => {
  const normalizedStepId = normalizeText(stepId);
  const timestamp = now();
  let updatedStep = null;
  const nextSteps = normalizeAgentRunSteps(steps).map((step) => {
    if (step.id !== normalizedStepId) {
      return step;
    }

    const nextStatus =
      status === undefined ? step.status : normalizeAgentRunStepStatus(status);
    if (status !== undefined && !isKnownAgentRunStepStatus(status)) {
      throw createUnsupportedAgentRunStepStatusError(status);
    }
    if (status !== undefined) {
      assertAgentRunStepStatusTransition({
        from: step.status,
        to: nextStatus,
      });
    }
    const timestamps = getStepTimestamps({
      existingStep: step,
      status: nextStatus,
      timestamp,
    });
    updatedStep = normalizeAgentRunStep({
      ...step,
      ...patch,
      ...timestamps,
      status: nextStatus,
      updatedAt: timestamp,
    });

    return updatedStep;
  });

  return {
    matched: Boolean(updatedStep),
    step: updatedStep,
    steps: nextSteps,
  };
};

export const buildAgentRunStepsFromTrace = ({
  existingSteps = [],
  now = () => new Date().toISOString(),
  trace = [],
} = {}) => {
  const timestamp = now();
  const existingById = new Map(
    normalizeAgentRunSteps(existingSteps).map((step) => [step.id, step])
  );
  const seen = new Set();
  let nextSteps = [];

  for (const [index, traceStep] of toArray(trace).entries()) {
    const approvalGate = getApprovalGateFromTraceStep(traceStep);
    const existingStep = existingById.get(traceStep.id);
    const status = normalizeAgentRunStepStatus(traceStep.status ?? "completed");
    const detail = normalizeRecord(traceStep.detail, null);
    const input =
      normalizeRecord(traceStep.input, null) ??
      normalizeRecord(detail?.input, null) ??
      existingStep?.input ??
      null;
    const output = getTraceStepOutput({
      detail,
      existingStep,
      traceStep,
    });
    const error = getTraceStepError({
      detail,
      existingStep,
      status,
      traceStep,
    });
    const timestamps = getStepTimestamps({
      existingStep,
      status,
      timestamp,
    });
    const runStep = normalizeAgentRunStep(
      {
        ...existingStep,
        ...timestamps,
        id: traceStep.id,
        type: traceStep.type,
        kind: classifyTraceStep(traceStep),
        status,
        label: traceStep.label,
        summary: traceStep.summary,
        detail: {
          ...(detail ?? {}),
          traceStatus: traceStep.status ?? "completed",
        },
        input,
        output,
        error,
        traceStepId: traceStep.id,
        approvalGateId: approvalGate?.id,
        capabilityId: approvalGate?.capabilityId,
        capabilityVersion: approvalGate?.capabilityVersion,
      },
      {
        index,
        now,
      }
    );

    nextSteps = upsertAgentRunStep({
      steps: nextSteps,
      step: runStep,
    });
    seen.add(runStep.id);
  }

  for (const existingStep of normalizeAgentRunSteps(existingSteps)) {
    if (!seen.has(existingStep.id)) {
      nextSteps.push(existingStep);
    }
  }

  return nextSteps;
};

export const attachApprovalGateStepIds = ({ gates = [], steps = [] } = {}) => {
  const normalizedSteps = normalizeAgentRunSteps(steps);

  return toArray(gates).map((gate) => {
    const gateId = normalizeText(gate.id);
    const matchingStep = normalizedSteps.find(
      (step) =>
        step.approvalGateId === gateId ||
        (step.kind === AGENT_RUN_STEP_KINDS.approvalGate &&
          step.capabilityId === gate.capabilityId)
    );

    return matchingStep
      ? {
          ...gate,
          stepId: gate.stepId ?? matchingStep.id,
        }
      : gate;
  });
};

const buildCapabilityStepId = (gate = {}) =>
  `capability:${normalizeText(gate.capabilityId)}:${normalizeText(gate.id)}`;

const getStepApprovalGateId = (step = {}) =>
  normalizeText(step.approvalGateId) ||
  normalizeText(step.detail?.approvalGateId) ||
  normalizeText(step.detail?.approvalGate?.id);

const resolvePausedPrimaryApprovalSteps = ({
  action,
  capabilityStepId = "",
  gate = {},
  now,
  steps = [],
} = {}) => {
  const normalizedAction = normalizeText(action).toLowerCase();
  const gateId = normalizeText(gate.id);
  let nextSteps = steps;

  if (!gateId || !["approve", "deny"].includes(normalizedAction)) {
    return nextSteps;
  }

  for (const step of normalizeAgentRunSteps(nextSteps)) {
    if (
      step.status !== AGENT_RUN_STEP_STATUSES.paused ||
      step.kind === AGENT_RUN_STEP_KINDS.approvalGate ||
      step.kind === AGENT_RUN_STEP_KINDS.capabilityCall ||
      getStepApprovalGateId(step) !== gateId
    ) {
      continue;
    }

    const updateResult = updateAgentRunStep({
      now,
      patch: {
        decision: normalizedAction,
        detail: {
          ...(step.detail ?? {}),
          ...(normalizedAction === "approve"
            ? {
                approvalDelegated: true,
                delegatedStepId: capabilityStepId,
              }
            : {
                approvalDenied: true,
              }),
          approvalGateId: gateId,
          capabilityId: gate.capabilityId ?? step.capabilityId,
        },
        summary:
          step.summary ||
          (normalizedAction === "approve"
            ? `${step.label || step.type || "Step"} was delegated to the approved capability call.`
            : `${step.label || step.type || "Step"} was skipped because approval was denied.`),
      },
      status: AGENT_RUN_STEP_STATUSES.skipped,
      stepId: step.id,
      steps: nextSteps,
    });

    nextSteps = updateResult.steps;
  }

  return nextSteps;
};

export const applyApprovalActionToSteps = ({
  action,
  gate = {},
  now = () => new Date().toISOString(),
  steps = [],
} = {}) => {
  const normalizedAction = normalizeText(action).toLowerCase();
  const timestamp = now();
  const gateStepId = normalizeText(gate.stepId);
  const capabilityStepId = buildCapabilityStepId(gate);
  let nextSteps = normalizeAgentRunSteps(steps);
  let gateStep = null;

  if (gateStepId) {
    const updateResult = updateAgentRunStep({
      now,
      patch: {
        decision: normalizedAction,
        detail: {
          action: normalizedAction,
          approvalGateId: gate.id,
          capabilityId: gate.capabilityId,
        },
      },
      status: AGENT_RUN_STEP_STATUSES.completed,
      stepId: gateStepId,
      steps: nextSteps,
    });
    nextSteps = updateResult.steps;
    gateStep = updateResult.step;
  }

  if (["approve", "deny"].includes(normalizedAction)) {
    nextSteps = resolvePausedPrimaryApprovalSteps({
      action: normalizedAction,
      capabilityStepId,
      gate,
      now,
      steps: nextSteps,
    });
  }

  const capabilityStep = normalizeAgentRunStep({
    id: capabilityStepId,
    type: "capability_call",
    kind: AGENT_RUN_STEP_KINDS.capabilityCall,
    status:
      normalizedAction === "approve"
        ? AGENT_RUN_STEP_STATUSES.pending
        : AGENT_RUN_STEP_STATUSES.skipped,
    label: gate.capabilityLabel ?? gate.capabilityId ?? "Capability",
    summary:
      normalizedAction === "approve"
        ? "Capability call is approved and ready to resume."
        : "Capability call was skipped because approval was denied.",
    parentStepId: gateStepId,
    approvalGateId: gate.id,
    capabilityId: gate.capabilityId,
    capabilityVersion: gate.capabilityVersion,
    input: gate.inputPreview ?? null,
    createdAt: timestamp,
    startedAt: normalizedAction === "approve" ? "" : timestamp,
    completedAt: normalizedAction === "approve" ? "" : timestamp,
    updatedAt: timestamp,
    decision: normalizedAction,
  });

  nextSteps = upsertAgentRunStep({
    steps: nextSteps,
    step: capabilityStep,
  });

  return {
    capabilityStep,
    gateStep,
    steps: nextSteps,
  };
};

export const queueAgentRunStepRetry = ({
  now = () => new Date().toISOString(),
  stepId,
  steps = [],
} = {}) => {
  const normalizedSteps = normalizeAgentRunSteps(steps);
  const originalStep = normalizedSteps.find((step) => step.id === stepId);

  if (!originalStep) {
    return {
      matched: false,
      retryStep: null,
      steps: normalizedSteps,
    };
  }

  const retryAttempt =
    1 +
    normalizedSteps.filter(
      (step) =>
        step.id === originalStep.id || step.retryOfStepId === originalStep.id
    ).length;
  const retryStep = normalizeAgentRunStep({
    ...originalStep,
    id: `${originalStep.id}:retry:${retryAttempt}`,
    status: AGENT_RUN_STEP_STATUSES.pending,
    summary: `Retry queued for ${originalStep.label}.`,
    retryOfStepId: originalStep.id,
    attempt: retryAttempt,
    error: null,
    output: null,
    createdAt: now(),
    startedAt: "",
    pausedAt: "",
    completedAt: "",
    updatedAt: now(),
  });

  return {
    matched: true,
    retryStep,
    steps: upsertAgentRunStep({
      steps: normalizedSteps,
      step: retryStep,
    }),
  };
};
