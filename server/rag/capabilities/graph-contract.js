import { normalizeText } from "../../lib/normalize-text.js";
import { createAgentBudget, getRemainingBudget } from "../agent-budget.js";
import {
  SKILL_EFFECTS,
  SKILL_VALUE_TYPES,
  createSkillInputContractError,
  createSkillOutputContractError,
  hasExplicitExecutionGraphContract,
  validateSkillValues,
} from "../skills/skill-contract.js";

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const GRAPH_CONTRACT_FIELDS = [
  "budgetKey",
  "effects",
  "idempotency",
  "inputSchema",
  "outputSchema",
  "parallelSafe",
  "replaySafe",
  "retryable",
  "projectOutput",
];
const KNOWN_BUDGET_KEYS = new Set(
  Object.keys(getRemainingBudget(createAgentBudget())).filter(
    (key) => key !== "traceSteps"
  )
);

const capabilityInputType = (field = {}) => {
  if (field.type === "array" && field.items?.type === "string") {
    return SKILL_VALUE_TYPES.stringArray;
  }

  if (field.type === "integer" || field.type === "number") {
    return SKILL_VALUE_TYPES.number;
  }

  return field.type;
};

const hasMatchingInputContract = (capability, graphContract) => {
  if (!Array.isArray(capability.inputSchema?.required)) {
    return false;
  }

  const requiredFields = new Set(capability.inputSchema.required);
  const properties = capability.inputSchema?.properties;

  if (!isRecord(properties) || !isRecord(graphContract.inputSchema)) {
    return false;
  }

  for (const field of requiredFields) {
    if (graphContract.inputSchema[field]?.required !== true) {
      return false;
    }
  }

  return Object.entries(graphContract.inputSchema).every(([field, spec]) =>
    isRecord(spec) &&
    isRecord(properties[field]) &&
    capabilityInputType(properties[field]) === spec.type &&
    (!requiredFields.has(field) || spec.required === true)
  );
};

const hasExplicitGraphContract = (capability) => {
  const graphContract = capability?.executionGraph;
  const approvalMode = normalizeText(capability?.approvalPolicy?.mode).toLowerCase();
  const requiresApproval =
    capability?.approvalPolicy?.userConfirmationRequired === true ||
    capability?.approvalPolicy?.requiresApproval === true ||
    ["approval_required", "manual", "user_confirmation"].includes(approvalMode);

  if (
    !isRecord(graphContract) ||
    GRAPH_CONTRACT_FIELDS.some((field) => !Object.hasOwn(graphContract, field)) ||
    typeof graphContract.projectOutput !== "function" ||
    !(
      graphContract.budgetKey === null ||
      KNOWN_BUDGET_KEYS.has(graphContract.budgetKey)
    ) ||
    (capability.approvalPolicy?.writesWorkspace === true &&
      graphContract.effects !== SKILL_EFFECTS.workspaceWrite &&
      graphContract.effects !== SKILL_EFFECTS.externalWrite) ||
    (capability.privacyPolicy?.externalCall === true &&
      graphContract.effects === SKILL_EFFECTS.readOnly) ||
    // An approval must pause at a clean graph boundary, and a write cannot
    // race another node while its durable outcome is still unknown.
    ((requiresApproval ||
      [SKILL_EFFECTS.workspaceWrite, SKILL_EFFECTS.externalWrite].includes(
        graphContract.effects
      )) && graphContract.parallelSafe !== false) ||
    !hasMatchingInputContract(capability, graphContract)
  ) {
    return false;
  }

  return hasExplicitExecutionGraphContract({
    id: capability.id,
    version: capability.version,
    ...graphContract,
  });
};

const assertRequiredScope = (capability, accessScope) => {
  if (
    capability.accessScope?.required === true &&
    !isRecord(accessScope)
  ) {
    const error = new Error(
      `Capability ${capability.id} requires a runtime accessScope object.`
    );
    error.name = "CapabilityGraphScopeError";
    throw error;
  }
};

const assertRegistered = (registry, capability) => {
  if (registry.get(capability.id) !== capability) {
    const error = new Error(
      `Capability ${capability.id} changed after its graph adapter was created.`
    );
    error.name = "CapabilityGraphRegistryError";
    throw error;
  }
};

/**
 * A trusted, Skill-shaped adapter for one registered Capability. This is not a
 * model catalog: callers must still authorize which adapter IDs a graph may use.
 * The Capability registry remains the only execution and approval authority.
 */
export const createCapabilityGraphAdapter = ({
  capabilityId,
  capabilityRegistry,
} = {}) => {
  const id = normalizeText(capabilityId);
  const registeredCapabilities = capabilityRegistry?.list?.();
  const registryIds = Array.isArray(registeredCapabilities)
    ? registeredCapabilities.map((item) => item.id)
    : [];
  const capability = capabilityRegistry?.get?.(id) ?? null;

  if (
    !id ||
    !registryIds.includes(id) ||
    typeof capabilityRegistry?.execute !== "function" ||
    !capability ||
    !hasExplicitGraphContract(capability)
  ) {
    return null;
  }

  const graphContract = capability.executionGraph;
  const inputFields = Object.keys(graphContract.inputSchema);

  return {
    id: `capability:${id}`,
    version: capability.version,
    label: capability.label,
    kind: "capability",
    budgetKey: graphContract.budgetKey,
    requiresAccessScope: capability.accessScope.required === true,
    effects: graphContract.effects,
    idempotency: graphContract.idempotency,
    parallelSafe: graphContract.parallelSafe,
    replaySafe: graphContract.replaySafe,
    retryable: graphContract.retryable,
    inputSchema: graphContract.inputSchema,
    outputSchema: graphContract.outputSchema,
    plannerSummary: normalizeText(graphContract.plannerSummary),
    approvalMode: normalizeText(capability.approvalPolicy?.mode),
    requiresApproval:
      capability.approvalPolicy?.userConfirmationRequired === true ||
      capability.approvalPolicy?.requiresApproval === true ||
      ["approval_required", "manual", "user_confirmation"].includes(
        normalizeText(capability.approvalPolicy?.mode).toLowerCase()
      ),
    execute: async ({
      accessScope,
      approval,
      input: nestedInput,
      services,
      ...boundFields
    } = {}) => {
      assertRegistered(capabilityRegistry, capability);
      assertRequiredScope(capability, accessScope);

      const suppliedInput = nestedInput === undefined ? boundFields : nestedInput;

      if (!isRecord(suppliedInput)) {
        throw createSkillInputContractError(["capability input must be an object"]);
      }

      if (
        nestedInput !== undefined &&
        Object.keys(suppliedInput).some((field) => !inputFields.includes(field))
      ) {
        throw createSkillInputContractError([
          "capability input contains an undeclared field",
        ]);
      }

      // A graph runner passes trusted service handles alongside bound fields;
      // only explicitly declared fields ever reach the Capability policy layer.
      const selectedInput = Object.fromEntries(
        inputFields
          .filter((field) => Object.hasOwn(suppliedInput, field))
          .map((field) => [field, suppliedInput[field]])
      );
      const checkedInput = validateSkillValues({
        allowNestedValue: false,
        output: selectedInput,
        schema: graphContract.inputSchema,
      });

      if (!checkedInput.ok) {
        throw createSkillInputContractError(checkedInput.errors);
      }

      const value = await capabilityRegistry.execute(id, {
        accessScope,
        approval,
        input: checkedInput.output,
        services,
      });
      const projectedOutput = graphContract.projectOutput(value);
      const checkedOutput = validateSkillValues({
        allowNestedValue: false,
        output: projectedOutput,
        schema: graphContract.outputSchema,
      });

      if (!checkedOutput.ok) {
        throw createSkillOutputContractError(checkedOutput.errors);
      }

      return {
        value,
        ...checkedOutput.output,
      };
    },
  };
};

export const listCapabilityGraphAdapters = ({ capabilityRegistry } = {}) => {
  const registeredCapabilities = capabilityRegistry?.list?.();

  return (Array.isArray(registeredCapabilities) ? registeredCapabilities : [])
    .map(({ id }) =>
      createCapabilityGraphAdapter({ capabilityId: id, capabilityRegistry })
    )
    .filter(Boolean);
};
