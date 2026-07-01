import { createResearchDossierTriggerSpec } from "./built-ins/research-dossier.js";
import {
  AGENT_TRIGGER_MODES,
  compactAgentTriggerSpec,
  normalizeAgentTriggerSpec,
  validateAgentTriggerSpec,
} from "./schema.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const cloneTriggerSpec = (trigger = {}) =>
  JSON.parse(JSON.stringify(trigger ?? {}));

export const createBuiltInAgentTriggers = () => [
  createResearchDossierTriggerSpec(),
];

const buildRegistryError = ({ errors = [], trigger = {} } = {}) => {
  const error = new Error(
    `Invalid agent trigger ${trigger.id || "unknown"}: ${errors.join(", ")}`
  );

  error.errors = errors;
  return error;
};

const normalizeEventSelector = (event = {}) => ({
  eventType: normalizeText(event.eventType),
  source: normalizeText(event.source),
});

const triggerMatchesEvent = (trigger = {}, event = {}) => {
  const eventSelector = normalizeEventSelector(event);

  return (
    trigger.trigger.mode === AGENT_TRIGGER_MODES.event &&
    normalizeText(trigger.trigger.event.source) === eventSelector.source &&
    normalizeText(trigger.trigger.event.eventType) === eventSelector.eventType
  );
};

const triggerMatchesMode = ({ mode = "", trigger = {} } = {}) =>
  !mode || trigger.trigger.mode === normalizeText(mode);

export const createAgentTriggerRegistry = ({
  triggers = createBuiltInAgentTriggers(),
} = {}) => {
  const triggerMap = new Map();

  const register = (trigger = {}) => {
    const validation = validateAgentTriggerSpec(trigger);

    if (!validation.valid) {
      throw buildRegistryError({
        errors: validation.errors,
        trigger: validation.spec,
      });
    }

    if (triggerMap.has(validation.spec.id)) {
      throw new Error(`Duplicate agent trigger id: ${validation.spec.id}`);
    }

    triggerMap.set(validation.spec.id, validation.spec);

    return cloneTriggerSpec(validation.spec);
  };

  for (const trigger of triggers) {
    register(trigger);
  }

  return {
    get(triggerId) {
      const trigger = triggerMap.get(normalizeText(triggerId));

      return trigger ? cloneTriggerSpec(trigger) : null;
    },

    getPublic(triggerId) {
      const trigger = this.get(triggerId);

      return trigger ? compactAgentTriggerSpec(trigger) : null;
    },

    list({ enabledOnly = false } = {}) {
      return [...triggerMap.values()]
        .filter((trigger) => !enabledOnly || trigger.enabled)
        .map(cloneTriggerSpec);
    },

    listPublic({ enabledOnly = false } = {}) {
      return this.list({ enabledOnly }).map(compactAgentTriggerSpec);
    },

    register,

    select({ event = {}, mode = "", triggerId = "" } = {}) {
      const requestedTriggerId = normalizeText(triggerId);

      if (requestedTriggerId) {
        const trigger = triggerMap.get(requestedTriggerId);

        return trigger?.enabled ? cloneTriggerSpec(trigger) : null;
      }

      const normalizedMode = normalizeText(mode);
      const candidates = [...triggerMap.values()].filter(
        (trigger) => trigger.enabled && triggerMatchesMode({ mode, trigger })
      );

      const selectedTrigger =
        normalizedMode === AGENT_TRIGGER_MODES.event
          ? candidates.find((trigger) => triggerMatchesEvent(trigger, event))
          : candidates[0];

      return selectedTrigger ? cloneTriggerSpec(selectedTrigger) : null;
    },
  };
};

export const createDefaultAgentTriggerRegistry = () =>
  createAgentTriggerRegistry();

export {
  compactAgentTriggerSpec,
  normalizeAgentTriggerSpec,
  validateAgentTriggerSpec,
} from "./schema.js";
