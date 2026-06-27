export const AGENT_WORKFLOW_TYPE = "agent_workflow";
export const AGENT_WORKFLOW_SPEC_VERSION = "1.0.0";

export const AGENT_WORKFLOW_PHASE_TYPES = Object.freeze({
  agentQuestion: "agent_question",
  capabilityCall: "capability_call",
  capabilityOrAgentQuestion: "capability_or_agent_question",
});

const VALID_PHASE_TYPES = new Set(Object.values(AGENT_WORKFLOW_PHASE_TYPES));
const MAX_TEXT_LENGTH = 320;
const MAX_TEMPLATE_LENGTH = 1200;

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeTemplateText = (value) =>
  String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_TEMPLATE_LENGTH);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeTextList = (value, maxLength = MAX_TEXT_LENGTH) =>
  toArray(value).map((item) => normalizeText(item, maxLength)).filter(Boolean);

const normalizeTemplate = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalizeTemplateText).filter(Boolean);
  }

  const normalizedValue = normalizeTemplateText(value);

  return normalizedValue ? [normalizedValue] : [];
};

const normalizeTriggerPattern = (pattern) => {
  if (typeof pattern === "string") {
    return {
      flags: "i",
      source: normalizeText(pattern, 500),
    };
  }

  const patternRecord = normalizeRecord(pattern, {});

  return {
    flags: normalizeText(patternRecord.flags, 20) || "i",
    source: normalizeText(patternRecord.source ?? patternRecord.pattern, 500),
  };
};

const normalizeTrigger = (trigger = {}) => {
  const triggerRecord = normalizeRecord(trigger);

  return {
    keywords: normalizeTextList(triggerRecord.keywords, 120),
    patterns: toArray(triggerRecord.patterns)
      .map(normalizeTriggerPattern)
      .filter((pattern) => pattern.source),
  };
};

const normalizeInputContract = (input = {}) => {
  const inputRecord = normalizeRecord(input);

  return {
    optional: normalizeTextList(inputRecord.optional, 80),
    required: normalizeTextList(inputRecord.required, 80),
  };
};

const normalizeOptionalNumber = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
};

const normalizeWhen = (when = {}) => {
  const whenRecord = normalizeRecord(when, {});
  const minDocCount = normalizeOptionalNumber(whenRecord.minDocCount);
  const maxDocCount = normalizeOptionalNumber(whenRecord.maxDocCount);

  return {
    maxDocCount: maxDocCount === null ? null : Math.max(0, maxDocCount),
    minDocCount: minDocCount === null ? null : Math.max(0, minDocCount),
  };
};

const normalizePhaseVariant = (variant = {}) => {
  const variantRecord = normalizeRecord(variant);

  return {
    expectedCapability: normalizeText(variantRecord.expectedCapability, 120),
    expectedSkill: normalizeText(variantRecord.expectedSkill, 120),
    id: normalizeText(variantRecord.id, 80),
    label: normalizeText(variantRecord.label, 120),
    questionTemplate: normalizeTemplate(variantRecord.questionTemplate),
    summary: normalizeText(variantRecord.summary),
    when: normalizeWhen(variantRecord.when),
  };
};

export const normalizeAgentWorkflowPhase = (phase = {}) => {
  const phaseRecord = normalizeRecord(phase);

  return {
    approvalRequired: phaseRecord.approvalRequired === true,
    expectedCapability: normalizeText(phaseRecord.expectedCapability, 120),
    expectedSkill: normalizeText(phaseRecord.expectedSkill, 120),
    id: normalizeText(phaseRecord.id, 80),
    label: normalizeText(phaseRecord.label, 120),
    questionTemplate: normalizeTemplate(phaseRecord.questionTemplate),
    summary: normalizeText(phaseRecord.summary),
    type:
      normalizeText(phaseRecord.type, 80) ||
      AGENT_WORKFLOW_PHASE_TYPES.agentQuestion,
    variants: toArray(phaseRecord.variants).map(normalizePhaseVariant),
  };
};

const normalizeDeliverable = (deliverable = {}) => {
  const deliverableRecord = normalizeRecord(deliverable);

  return {
    approvalRequired: deliverableRecord.approvalRequired !== false,
    artifactType: normalizeText(deliverableRecord.artifactType, 80),
    capabilityId: normalizeText(deliverableRecord.capabilityId, 120),
    label: normalizeText(deliverableRecord.label, 120),
    optional: deliverableRecord.optional === true,
    title: normalizeText(deliverableRecord.title, 160),
    triggerPatterns: toArray(deliverableRecord.triggerPatterns)
      .map(normalizeTriggerPattern)
      .filter((pattern) => pattern.source),
  };
};

const normalizeIterationBudget = (budget = {}) => {
  const budgetRecord = normalizeRecord(budget);
  const maxIterations = normalizeOptionalNumber(budgetRecord.maxIterations);
  const phaseBuffer = normalizeOptionalNumber(budgetRecord.phaseBuffer);

  return {
    maxIterations:
      maxIterations === null ? null : Math.max(1, Math.trunc(maxIterations)),
    phaseBuffer: phaseBuffer === null ? 0 : Math.max(0, Math.trunc(phaseBuffer)),
  };
};

export const normalizeAgentWorkflowSpec = (workflow = {}) => {
  const workflowRecord = normalizeRecord(workflow);

  return {
    id: normalizeText(workflowRecord.id, 120),
    version:
      normalizeText(workflowRecord.version, 40) || AGENT_WORKFLOW_SPEC_VERSION,
    type: normalizeText(workflowRecord.type, 80) || AGENT_WORKFLOW_TYPE,
    label: normalizeText(workflowRecord.label, 160),
    description: normalizeText(workflowRecord.description, 500),
    trigger: normalizeTrigger(workflowRecord.trigger),
    input: normalizeInputContract(workflowRecord.input),
    iterationBudget: normalizeIterationBudget(workflowRecord.iterationBudget),
    phases: toArray(workflowRecord.phases).map(normalizeAgentWorkflowPhase),
    deliverables: toArray(workflowRecord.deliverables).map(normalizeDeliverable),
    completionChecks: normalizeTextList(workflowRecord.completionChecks, 120),
    metadata: normalizeRecord(workflowRecord.metadata),
  };
};

const addDuplicateErrors = ({ errors, items = [], label }) => {
  const seen = new Set();

  for (const item of items) {
    if (!item.id) {
      continue;
    }

    if (seen.has(item.id)) {
      errors.push(`${label} id must be unique: ${item.id}`);
    }

    seen.add(item.id);
  }
};

const validateTriggerPatterns = ({ errors, patterns = [], path }) => {
  for (const pattern of patterns) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern.source, pattern.flags);
    } catch {
      errors.push(`${path} pattern is not a valid regular expression.`);
    }
  }
};

export const validateAgentWorkflowSpec = (workflow = {}) => {
  const spec = normalizeAgentWorkflowSpec(workflow);
  const errors = [];

  if (!spec.id) {
    errors.push("Workflow id is required.");
  }

  if (spec.type !== AGENT_WORKFLOW_TYPE) {
    errors.push(`Workflow type must be ${AGENT_WORKFLOW_TYPE}.`);
  }

  if (!spec.label) {
    errors.push("Workflow label is required.");
  }

  if (
    spec.trigger.keywords.length === 0 &&
    spec.trigger.patterns.length === 0
  ) {
    errors.push("Workflow trigger requires at least one keyword or pattern.");
  }

  validateTriggerPatterns({
    errors,
    path: "Workflow trigger",
    patterns: spec.trigger.patterns,
  });

  if (spec.input.required.length === 0) {
    errors.push("Workflow input requires at least one required field.");
  }

  if (spec.phases.length === 0) {
    errors.push("Workflow requires at least one phase.");
  }

  addDuplicateErrors({
    errors,
    items: spec.phases,
    label: "Phase",
  });

  for (const phase of spec.phases) {
    if (!phase.id) {
      errors.push("Phase id is required.");
    }

    if (!VALID_PHASE_TYPES.has(phase.type)) {
      errors.push(`Phase ${phase.id || "unknown"} has unsupported type.`);
    }

    if (!phase.label) {
      errors.push(`Phase ${phase.id || "unknown"} label is required.`);
    }

    if (
      phase.questionTemplate.length === 0 &&
      phase.variants.length === 0 &&
      !phase.expectedCapability
    ) {
      errors.push(
        `Phase ${phase.id || "unknown"} requires a question template, variant, or capability.`
      );
    }

    addDuplicateErrors({
      errors,
      items: phase.variants,
      label: `Phase ${phase.id || "unknown"} variant`,
    });

    validateTriggerPatterns({
      errors,
      path: `Phase ${phase.id || "unknown"} deliverable trigger`,
      patterns: phase.triggerPatterns,
    });

    for (const variant of phase.variants) {
      if (!variant.id) {
        errors.push(`Phase ${phase.id || "unknown"} variant id is required.`);
      }

      if (variant.questionTemplate.length === 0 && !variant.expectedCapability) {
        errors.push(
          `Phase ${phase.id || "unknown"} variant ${variant.id || "unknown"} requires a question template or capability.`
        );
      }
    }
  }

  for (const deliverable of spec.deliverables) {
    if (!deliverable.artifactType) {
      errors.push("Deliverable artifactType is required.");
    }

    if (!deliverable.capabilityId) {
      errors.push(
        `Deliverable ${deliverable.artifactType || "unknown"} capabilityId is required.`
      );
    }

    validateTriggerPatterns({
      errors,
      path: `Deliverable ${deliverable.artifactType || "unknown"}`,
      patterns: deliverable.triggerPatterns,
    });
  }

  if (spec.completionChecks.length === 0) {
    errors.push("Workflow requires at least one completion check.");
  }

  return {
    errors,
    spec,
    valid: errors.length === 0,
  };
};

const getDocCount = ({ docCount, docIds = [] } = {}) => {
  const parsedDocCount = Number(docCount);

  if (Number.isFinite(parsedDocCount)) {
    return parsedDocCount;
  }

  return toArray(docIds).filter(Boolean).length;
};

export const workflowConditionMatches = (when = {}, context = {}) => {
  const condition = normalizeWhen(when);
  const docCount = getDocCount(context);

  if (condition.minDocCount !== null && docCount < condition.minDocCount) {
    return false;
  }

  if (condition.maxDocCount !== null && docCount > condition.maxDocCount) {
    return false;
  }

  return true;
};

export const selectAgentWorkflowPhaseVariant = (phase = {}, context = {}) => {
  const normalizedPhase = normalizeAgentWorkflowPhase(phase);

  return (
    normalizedPhase.variants.find((variant) =>
      workflowConditionMatches(variant.when, context)
    ) ?? null
  );
};

export const resolveAgentWorkflowPhase = (phase = {}, context = {}) => {
  const normalizedPhase = normalizeAgentWorkflowPhase(phase);
  const variant = selectAgentWorkflowPhaseVariant(normalizedPhase, context);

  if (!variant) {
    return normalizedPhase;
  }

  return {
    ...normalizedPhase,
    expectedCapability:
      variant.expectedCapability || normalizedPhase.expectedCapability,
    expectedSkill: variant.expectedSkill || normalizedPhase.expectedSkill,
    label: variant.label || normalizedPhase.label,
    questionTemplate:
      variant.questionTemplate.length > 0
        ? variant.questionTemplate
        : normalizedPhase.questionTemplate,
    summary: variant.summary || normalizedPhase.summary,
    variantId: variant.id,
  };
};

export const renderAgentWorkflowTemplate = (template = [], context = {}) => {
  const values = {
    docCount: String(getDocCount(context)),
    docIds: toArray(context.docIds).join(", "),
    goal: normalizeText(context.goal ?? context.question, 1000),
    ...normalizeRecord(context.values),
  };

  return normalizeTemplate(template)
    .join("\n\n")
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) =>
      String(values[key] ?? "")
    )
    .trim();
};
