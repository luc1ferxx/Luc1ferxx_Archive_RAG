export const AGENT_TRIGGER_TYPE = "agent_trigger";
export const AGENT_TRIGGER_SPEC_VERSION = "1.0.0";

export const AGENT_TRIGGER_MODES = Object.freeze({
  event: "event",
  manual: "manual",
  schedule: "schedule",
});

export const AGENT_TRIGGER_APPROVAL_MODES = Object.freeze({
  ownerApproved: "owner_approved",
  userConfirmation: "user_confirmation",
});

const VALID_TRIGGER_MODES = new Set(Object.values(AGENT_TRIGGER_MODES));
const VALID_APPROVAL_MODES = new Set(
  Object.values(AGENT_TRIGGER_APPROVAL_MODES)
);
const MAX_TEXT_LENGTH = 320;
const MAX_TEMPLATE_LENGTH = 1200;
const SENSITIVE_FIELD_PATTERN =
  /(^|[._-])(api[_-]?key|authorization|auth[_-]?token|bearer|cookie|credential|password|secret|token)([._-]|$)/i;

const normalizeBoundedText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeTemplateText = (value) =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, MAX_TEMPLATE_LENGTH);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const cloneJson = (value, fallback = {}) =>
  JSON.parse(JSON.stringify(value ?? fallback));

const normalizeTextList = (value, maxLength = MAX_TEXT_LENGTH) =>
  toArray(value)
    .map((item) => normalizeBoundedText(item, maxLength))
    .filter(Boolean);

const normalizeTemplate = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalizeTemplateText).filter(Boolean);
  }

  const normalizedValue = normalizeTemplateText(value);

  return normalizedValue ? [normalizedValue] : [];
};

const normalizeTriggerEvent = (event = {}) => {
  const eventRecord = normalizeRecord(event);

  return {
    eventType: normalizeBoundedText(eventRecord.eventType, 120),
    requiredFields: normalizeTextList(eventRecord.requiredFields, 120),
    source: normalizeBoundedText(eventRecord.source, 120),
  };
};

const normalizeTriggerSchedule = (schedule = {}) => {
  const scheduleRecord = normalizeRecord(schedule);

  return {
    cron: normalizeBoundedText(scheduleRecord.cron, 160),
    timezone: normalizeBoundedText(scheduleRecord.timezone, 120) || "UTC",
  };
};

const normalizeTriggerInput = (input = {}) => {
  const inputRecord = normalizeRecord(input);

  return {
    optional: normalizeTextList(inputRecord.optional, 80),
    required: normalizeTextList(inputRecord.required, 80),
  };
};

const normalizeTrigger = (trigger = {}) => {
  const triggerRecord = normalizeRecord(trigger);
  const mode =
    normalizeBoundedText(triggerRecord.mode, 80) || AGENT_TRIGGER_MODES.manual;

  return {
    event: normalizeTriggerEvent(triggerRecord.event),
    input: normalizeTriggerInput(triggerRecord.input),
    mode,
    schedule: normalizeTriggerSchedule(triggerRecord.schedule),
  };
};

const normalizeTarget = (target = {}) => {
  const targetRecord = normalizeRecord(target);

  return {
    defaultInput: cloneJson(targetRecord.defaultInput),
    questionTemplate: normalizeTemplate(targetRecord.questionTemplate),
    runnerId: normalizeBoundedText(targetRecord.runnerId, 160),
    workflowId: normalizeBoundedText(targetRecord.workflowId, 160),
  };
};

const normalizeScopePolicy = (scopePolicy = {}) => {
  const policyRecord = normalizeRecord(scopePolicy);

  return {
    requiresUserId: policyRecord.requiresUserId !== false,
    requiresWorkspaceId: policyRecord.requiresWorkspaceId !== false,
  };
};

const normalizeApprovalPolicy = (approvalPolicy = {}) => {
  const policyRecord = normalizeRecord(approvalPolicy);

  return {
    mode:
      normalizeBoundedText(policyRecord.mode, 80) ||
      AGENT_TRIGGER_APPROVAL_MODES.userConfirmation,
    requiresApproval: policyRecord.requiresApproval !== false,
  };
};

const normalizeIdempotency = (idempotency = {}) => {
  const idempotencyRecord = normalizeRecord(idempotency);

  return {
    keyTemplate: normalizeBoundedText(idempotencyRecord.keyTemplate, 500),
    requiredFields: normalizeTextList(idempotencyRecord.requiredFields, 120),
  };
};

const normalizePrivacyPolicy = (privacyPolicy = {}) => {
  const policyRecord = normalizeRecord(privacyPolicy);

  return {
    allowedPayloadFields: normalizeTextList(policyRecord.allowedPayloadFields, 120),
    redactedFields: normalizeTextList(policyRecord.redactedFields, 120),
    storesRawPayload: policyRecord.storesRawPayload === true,
  };
};

export const normalizeAgentTriggerSpec = (trigger = {}) => {
  const triggerRecord = normalizeRecord(trigger);

  return {
    approvalPolicy: normalizeApprovalPolicy(triggerRecord.approvalPolicy),
    description: normalizeBoundedText(triggerRecord.description, 500),
    enabled: triggerRecord.enabled !== false,
    id: normalizeBoundedText(triggerRecord.id, 120),
    idempotency: normalizeIdempotency(triggerRecord.idempotency),
    label: normalizeBoundedText(triggerRecord.label, 160),
    metadata: cloneJson(triggerRecord.metadata),
    privacyPolicy: normalizePrivacyPolicy(triggerRecord.privacyPolicy),
    scopePolicy: normalizeScopePolicy(triggerRecord.scopePolicy),
    target: normalizeTarget(triggerRecord.target),
    trigger: normalizeTrigger(triggerRecord.trigger),
    type: normalizeBoundedText(triggerRecord.type, 80) || AGENT_TRIGGER_TYPE,
    version:
      normalizeBoundedText(triggerRecord.version, 40) ||
      AGENT_TRIGGER_SPEC_VERSION,
  };
};

const isSensitiveFieldName = (fieldName = "") =>
  SENSITIVE_FIELD_PATTERN.test(normalizeBoundedText(fieldName, 200));

const collectObjectPaths = (value = {}, prefix = "") => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    if (
      nestedValue &&
      typeof nestedValue === "object" &&
      !Array.isArray(nestedValue)
    ) {
      return [path, ...collectObjectPaths(nestedValue, path)];
    }

    return [path];
  });
};

const collectTemplatePlaceholders = (template = []) =>
  normalizeTemplate(template).flatMap((line) =>
    [...line.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map(
      (match) => match[1]
    )
  );

const addSensitiveFieldErrors = ({ errors, fields = [], path }) => {
  for (const field of fields) {
    if (isSensitiveFieldName(field)) {
      errors.push(`${path} must not allow sensitive field: ${field}`);
    }
  }
};

const isValidCronExpression = (cron = "") => {
  const parts = normalizeBoundedText(cron, 160).split(/\s+/).filter(Boolean);

  return parts.length === 5 || parts.length === 6;
};

const isValidTimezone = (timezone = "") => {
  try {
    Intl.DateTimeFormat("en-US", {
      timeZone: normalizeBoundedText(timezone, 120) || "UTC",
    }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

export const validateAgentTriggerSpec = (trigger = {}) => {
  const spec = normalizeAgentTriggerSpec(trigger);
  const errors = [];

  if (!spec.id) {
    errors.push("Trigger id is required.");
  }

  if (spec.type !== AGENT_TRIGGER_TYPE) {
    errors.push(`Trigger type must be ${AGENT_TRIGGER_TYPE}.`);
  }

  if (!spec.label) {
    errors.push("Trigger label is required.");
  }

  if (!VALID_TRIGGER_MODES.has(spec.trigger.mode)) {
    errors.push(`Trigger mode must be one of: ${[...VALID_TRIGGER_MODES].join(", ")}.`);
  }

  if (spec.trigger.input.required.length === 0) {
    errors.push("Trigger input requires at least one required field.");
  }

  addSensitiveFieldErrors({
    errors,
    fields: [
      ...spec.trigger.input.required,
      ...spec.trigger.input.optional,
      ...spec.trigger.event.requiredFields,
    ],
    path: "Trigger input",
  });

  if (spec.trigger.mode === AGENT_TRIGGER_MODES.event) {
    if (!spec.trigger.event.source) {
      errors.push("Event trigger source is required.");
    }

    if (!spec.trigger.event.eventType) {
      errors.push("Event trigger eventType is required.");
    }
  }

  if (spec.trigger.mode === AGENT_TRIGGER_MODES.schedule) {
    if (!spec.trigger.schedule.cron) {
      errors.push("Schedule trigger cron is required.");
    } else if (!isValidCronExpression(spec.trigger.schedule.cron)) {
      errors.push("Schedule trigger cron must have 5 or 6 fields.");
    }

    if (!isValidTimezone(spec.trigger.schedule.timezone)) {
      errors.push("Schedule trigger timezone is invalid.");
    }
  }

  if (
    [AGENT_TRIGGER_MODES.event, AGENT_TRIGGER_MODES.schedule].includes(
      spec.trigger.mode
    ) &&
    !spec.idempotency.keyTemplate
  ) {
    errors.push("Event and schedule triggers require idempotency.keyTemplate.");
  }

  if (!spec.target.runnerId) {
    errors.push("Trigger target runnerId is required.");
  }

  if (spec.target.questionTemplate.length === 0) {
    errors.push("Trigger target questionTemplate is required.");
  }

  addSensitiveFieldErrors({
    errors,
    fields: collectTemplatePlaceholders(spec.target.questionTemplate),
    path: "Trigger target questionTemplate",
  });

  addSensitiveFieldErrors({
    errors,
    fields: collectTemplatePlaceholders([spec.idempotency.keyTemplate]),
    path: "Trigger idempotency keyTemplate",
  });

  addSensitiveFieldErrors({
    errors,
    fields: collectObjectPaths(spec.target.defaultInput),
    path: "Trigger target defaultInput",
  });

  if (
    !spec.scopePolicy.requiresUserId &&
    !spec.scopePolicy.requiresWorkspaceId
  ) {
    errors.push("Trigger scopePolicy must require userId or workspaceId.");
  }

  if (!VALID_APPROVAL_MODES.has(spec.approvalPolicy.mode)) {
    errors.push(
      `Trigger approval mode must be one of: ${[...VALID_APPROVAL_MODES].join(", ")}.`
    );
  }

  if (
    spec.approvalPolicy.mode === AGENT_TRIGGER_APPROVAL_MODES.userConfirmation &&
    spec.approvalPolicy.requiresApproval !== true
  ) {
    errors.push("User-confirmation triggers must require approval.");
  }

  if (spec.privacyPolicy.storesRawPayload) {
    errors.push("Trigger privacyPolicy must not store raw payload.");
  }

  addSensitiveFieldErrors({
    errors,
    fields: spec.privacyPolicy.allowedPayloadFields,
    path: "Trigger privacyPolicy.allowedPayloadFields",
  });

  return {
    errors,
    spec,
    valid: errors.length === 0,
  };
};

const compactTriggerActivation = (trigger = {}) => {
  const activation = {
    input: cloneJson(trigger.input),
    mode: trigger.mode,
  };

  if (trigger.mode === AGENT_TRIGGER_MODES.event) {
    activation.event = {
      eventType: trigger.event.eventType,
      requiredFields: [...trigger.event.requiredFields],
      source: trigger.event.source,
    };
  }

  if (trigger.mode === AGENT_TRIGGER_MODES.schedule) {
    activation.schedule = {
      cron: trigger.schedule.cron,
      timezone: trigger.schedule.timezone,
    };
  }

  return activation;
};

export const compactAgentTriggerSpec = (trigger = {}) => {
  const spec = normalizeAgentTriggerSpec(trigger);

  return {
    approvalPolicy: cloneJson(spec.approvalPolicy),
    description: spec.description,
    enabled: spec.enabled,
    id: spec.id,
    idempotency: {
      hasKeyTemplate: Boolean(spec.idempotency.keyTemplate),
      requiredFields: [...spec.idempotency.requiredFields],
    },
    label: spec.label,
    metadata: {
      source: normalizeBoundedText(spec.metadata.source, 120),
    },
    privacyPolicy: {
      allowedPayloadFields: [...spec.privacyPolicy.allowedPayloadFields],
      storesRawPayload: spec.privacyPolicy.storesRawPayload,
    },
    scopePolicy: cloneJson(spec.scopePolicy),
    target: {
      runnerId: spec.target.runnerId,
      workflowId: spec.target.workflowId,
    },
    trigger: compactTriggerActivation(spec.trigger),
    type: spec.type,
    version: spec.version,
  };
};

export const renderAgentTriggerTemplate = (template = [], context = {}) => {
  const values = {
    docIds: toArray(context.docIds).join(", "),
    question: normalizeBoundedText(context.question, 1000),
    triggerId: normalizeBoundedText(context.triggerId, 120),
    ...normalizeRecord(context.values),
  };

  return normalizeTemplate(template)
    .join("\n\n")
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) =>
      String(values[key] ?? "")
    )
    .trim();
};
