import { createDefaultAgentTriggerRegistry } from "./agent-triggers/registry.js";
import {
  AGENT_TRIGGER_MODES,
  renderAgentTriggerTemplate,
} from "./agent-triggers/schema.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const buildDispatchError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const isPresent = (value) => {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "string") {
    return normalizeText(value).length > 0;
  }

  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return value !== null && value !== undefined;
};

const getPathValue = (source = {}, path = "") => {
  const parts = normalizeText(path).split(".").filter(Boolean);
  let current = source;

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = current[part];
  }

  return current;
};

const setPathValue = (target = {}, path = "", value) => {
  const parts = normalizeText(path).split(".").filter(Boolean);

  if (parts.length === 0 || !isPresent(value)) {
    return target;
  }

  let current = target;

  for (const part of parts.slice(0, -1)) {
    current[part] = normalizeRecord(current[part]);
    current = current[part];
  }

  current[parts.at(-1)] = value;

  return target;
};

const flattenRecord = (value = {}, prefix = "") => {
  const record = normalizeRecord(value, null);

  if (!record) {
    return {};
  }

  return Object.entries(record).reduce((flattened, [key, nestedValue]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    flattened[path] = nestedValue;

    if (
      nestedValue &&
      typeof nestedValue === "object" &&
      !Array.isArray(nestedValue)
    ) {
      return {
        ...flattened,
        ...flattenRecord(nestedValue, path),
      };
    }

    return flattened;
  }, {});
};

const filterAllowedPayload = ({
  allowedPayloadFields = [],
  payload = {},
} = {}) =>
  toArray(allowedPayloadFields).reduce((filteredPayload, field) => {
    const value = getPathValue(payload, field);

    return setPathValue(filteredPayload, field, value);
  }, {});

const requireFields = ({ fields = [], label, values = {} } = {}) => {
  const missingFields = toArray(fields).filter((field) => !isPresent(values[field]));

  if (missingFields.length > 0) {
    throw buildDispatchError(
      `${label} missing required field(s): ${missingFields.join(", ")}.`,
      400
    );
  }
};

const getDispatchMode = ({ event = {}, mode = "" } = {}) => {
  const normalizedMode = normalizeText(mode);

  if (normalizedMode) {
    return normalizedMode;
  }

  return normalizeText(event.source) || normalizeText(event.eventType)
    ? AGENT_TRIGGER_MODES.event
    : "";
};

const assertTriggerScope = ({ accessScope = {}, scopePolicy = {}, taskInput = {} } = {}) => {
  if (
    scopePolicy.requiresUserId &&
    !normalizeText(accessScope.userId) &&
    !normalizeText(taskInput.userId)
  ) {
    throw buildDispatchError("Agent trigger requires a user scope.", 403);
  }

  if (scopePolicy.requiresWorkspaceId && !normalizeText(accessScope.workspaceId)) {
    throw buildDispatchError("Agent trigger requires a workspace scope.", 403);
  }
};

const buildTemplateValues = ({
  event = {},
  request = {},
  taskInput = {},
  triggerId = "",
} = {}) => ({
  ...flattenRecord(taskInput),
  ...flattenRecord(event, "event"),
  ...flattenRecord(request, "request"),
  triggerId: normalizeText(triggerId),
});

const buildIdempotencyKey = ({ trigger = {}, values = {} } = {}) => {
  const keyTemplate = normalizeText(trigger.idempotency?.keyTemplate);

  if (!keyTemplate) {
    return "";
  }

  requireFields({
    fields: trigger.idempotency?.requiredFields,
    label: "Trigger idempotency",
    values,
  });

  const key = renderAgentTriggerTemplate([keyTemplate], {
    triggerId: trigger.id,
    values,
  });

  if (!key) {
    throw buildDispatchError("Trigger idempotency key rendered empty.", 400);
  }

  return key;
};

const buildTaskRequest = ({ accessScope = {}, trigger = {}, values = {} } = {}) => {
  const question = renderAgentTriggerTemplate(trigger.target.questionTemplate, {
    docIds: values.docIds,
    question: values.question,
    triggerId: trigger.id,
    values,
  });

  if (!question) {
    throw buildDispatchError("Trigger target question rendered empty.", 400);
  }

  return {
    accessScope,
    docIds: values.docIds,
    idempotencyKey: buildIdempotencyKey({
      trigger,
      values,
    }),
    maxIterations: values.maxIterations,
    question,
    sessionId: values.sessionId,
    userPreferences: values.userPreferences,
    userId: normalizeText(accessScope.userId) || values.userId,
  };
};

const buildDispatchSummary = ({ task = {}, taskRequest = {}, trigger = {} } = {}) => ({
  idempotent: Boolean(taskRequest.idempotencyKey),
  mode: trigger.trigger.mode,
  target: {
    runnerId: trigger.target.runnerId,
    workflowId: trigger.target.workflowId,
  },
  taskId: task.id,
  triggerId: trigger.id,
});

export const createAgentTriggerDispatcher = ({
  agentTaskService,
  triggerRegistry = createDefaultAgentTriggerRegistry(),
} = {}) => ({
  async dispatch({
    accessScope = {},
    event = {},
    input = {},
    mode = "",
    payload = null,
    request = {},
    triggerId = "",
  } = {}) {
    if (!agentTaskService?.createTask) {
      throw buildDispatchError("Agent task service is not configured.", 500);
    }

    const trigger = triggerRegistry.select({
      event,
      mode: getDispatchMode({
        event,
        mode,
      }),
      triggerId,
    });

    if (!trigger) {
      throw buildDispatchError("Agent trigger not found.", 404);
    }

    const incomingPayload = normalizeRecord(payload ?? input);
    const allowedPayload = filterAllowedPayload({
      allowedPayloadFields: trigger.privacyPolicy.allowedPayloadFields,
      payload: incomingPayload,
    });
    const taskInput = {
      ...normalizeRecord(trigger.target.defaultInput),
      ...allowedPayload,
    };
    const values = buildTemplateValues({
      event,
      request,
      taskInput,
      triggerId: trigger.id,
    });

    requireFields({
      fields: trigger.trigger.input.required,
      label: "Trigger input",
      values,
    });
    requireFields({
      fields: trigger.trigger.event.requiredFields,
      label: "Trigger event",
      values,
    });
    assertTriggerScope({
      accessScope,
      scopePolicy: trigger.scopePolicy,
      taskInput,
    });

    const taskRequest = buildTaskRequest({
      accessScope,
      trigger,
      values,
    });
    const task = await agentTaskService.createTask(taskRequest);

    return {
      task,
      triggerDispatch: buildDispatchSummary({
        task,
        taskRequest,
        trigger,
      }),
    };
  },
});
