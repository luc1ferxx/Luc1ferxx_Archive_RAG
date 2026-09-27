import { normalizeTrimmedText as normalizeText } from "../../lib/normalize-text.js";
import { CAPABILITY_IDS } from "../capabilities/shared.js";
import { validateCapabilityContract } from "../capabilities/registry.js";
import { createCapabilityGraphAdapter } from "../capabilities/graph-contract.js";
import { listAuthorizedAtomicCustomSkills } from "./authorized-catalog.js";
import { AGENT_SKILL_IDS } from "./built-ins.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
  SKILL_VALUE_TYPES,
  describeSkillForPlanner,
  getSkillContract,
  hasExplicitExecutionGraphContract,
} from "./skill-contract.js";

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const createGraphRegistry = (skills) => {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));

  return {
    get: (id) => byId.get(id) ?? null,
    list: () => [...byId.values()],
  };
};

const hasOutputEnvelope = (schema) =>
  schema.text?.required === true &&
  schema.text?.type === SKILL_VALUE_TYPES.string &&
  schema.citations?.required === true &&
  schema.citations?.type === SKILL_VALUE_TYPES.citationArray &&
  schema.abstained?.required === true &&
  schema.abstained?.type === SKILL_VALUE_TYPES.boolean;

const getExplicitBuiltIn = (registry, skillId) => {
  if (typeof registry?.get !== "function" || typeof registry?.list !== "function") {
    return null;
  }

  try {
    const skill = registry.get(skillId);

    return skill?.id === skillId &&
      skill.kind === "built_in" &&
      typeof skill.execute === "function" &&
      registry.list().includes(skill) &&
      hasExplicitExecutionGraphContract(skill)
      ? skill
      : null;
  } catch {
    return null;
  }
};

// getDocument is the /chat scoped lookup. A missing, asynchronous, or
// inconsistent lookup cannot authorize a document-bearing graph descriptor.
const hasVerifiedDocuments = ({ accessScope, docIds, ragService }) => {
  if (
    !isRecord(accessScope) ||
    !Array.isArray(docIds) ||
    docIds.length === 0 ||
    typeof ragService?.getDocument !== "function"
  ) {
    return false;
  }

  try {
    for (const candidate of docIds) {
      const docId = normalizeText(candidate);

      if (!docId) {
        return false;
      }

      const document = ragService.getDocument(docId, accessScope);

      if (
        !document ||
        typeof document.then === "function" ||
        normalizeText(document.docId) !== docId
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
};

// Inventory may run with no selected docIds, but only through a synchronous
// scoped listing whose returned IDs round-trip through the same scoped lookup.
// Discovery also needs this listing because its capability searches metadata
// rather than the document RAG index.
const hasVerifiedScopedListing = ({ accessScope, ragService }) => {
  if (
    !isRecord(accessScope) ||
    typeof ragService?.listDocuments !== "function" ||
    typeof ragService?.getDocument !== "function"
  ) {
    return false;
  }

  try {
    const documents = ragService.listDocuments(accessScope);

    if (!Array.isArray(documents)) {
      return false;
    }

    const seen = new Set();

    for (const document of documents) {
      const docId = normalizeText(document?.docId);

      if (!docId || seen.has(docId)) {
        return false;
      }

      const verified = ragService.getDocument(docId, accessScope);

      if (
        !verified ||
        typeof verified.then === "function" ||
        normalizeText(verified.docId) !== docId
      ) {
        return false;
      }

      seen.add(docId);
    }
  } catch {
    return false;
  }

  return true;
};

const isInventoryEntry = (skill) => {
  if (!skill) {
    return false;
  }

  const contract = getSkillContract(skill);

  return contract.requiresAccessScope &&
    contract.budgetKey === null &&
    contract.effects === SKILL_EFFECTS.readOnly &&
    contract.idempotency === SKILL_IDEMPOTENCY.readOnlyRag &&
    contract.replaySafe &&
    contract.retryable &&
    !contract.parallelSafe &&
    Object.keys(contract.inputSchema).length === 0 &&
    contract.outputSchema.documentCount?.required === true &&
    contract.outputSchema.documentCount?.type === SKILL_VALUE_TYPES.number &&
    contract.outputSchema.hasDocuments?.required === true &&
    contract.outputSchema.hasDocuments?.type === SKILL_VALUE_TYPES.boolean &&
    hasOutputEnvelope(contract.outputSchema);
};

const hasGuardedDiscoveryCapability = (capabilityRegistry) => {
  if (
    typeof capabilityRegistry?.get !== "function" ||
    typeof capabilityRegistry?.execute !== "function"
  ) {
    return false;
  }

  try {
    const capability = capabilityRegistry.get(CAPABILITY_IDS.documentDiscovery);

    if (!capability || capability.id !== CAPABILITY_IDS.documentDiscovery) {
      return false;
    }

    validateCapabilityContract(capability);

    return capability.accessScope.required === true &&
      capability.approvalPolicy.mode === "user_confirmation" &&
      capability.approvalPolicy.userConfirmationRequired === true &&
      capability.approvalPolicy.writesWorkspace === false &&
      capability.privacyPolicy.externalCall === false &&
      capability.privacyPolicy.storesResult === false &&
      capability.inputSchema.required?.includes("question") === true &&
      capability.inputSchema.properties?.question?.type === "string" &&
      capability.inputSchema.properties?.docIds?.type === "array" &&
      capability.inputSchema.properties?.docIds?.items?.type === "string";
  } catch {
    return false;
  }
};

const isDocumentDiscoveryEntry = (skill, capabilityRegistry) => {
  if (!skill || !hasGuardedDiscoveryCapability(capabilityRegistry)) {
    return false;
  }

  const contract = getSkillContract(skill);

  return contract.requiresAccessScope &&
    contract.budgetKey === null &&
    contract.effects === SKILL_EFFECTS.readOnly &&
    contract.idempotency === SKILL_IDEMPOTENCY.adapterDefined &&
    !contract.replaySafe &&
    !contract.retryable &&
    !contract.parallelSafe &&
    contract.inputSchema.docIds?.required === true &&
    contract.inputSchema.docIds?.scoped === true &&
    contract.inputSchema.docIds?.type === SKILL_VALUE_TYPES.stringArray &&
    contract.inputSchema.question?.required === true &&
    contract.inputSchema.question?.type === SKILL_VALUE_TYPES.string &&
    contract.outputSchema.matchedDocIds?.required === true &&
    contract.outputSchema.matchedDocIds?.type === SKILL_VALUE_TYPES.stringArray &&
    contract.outputSchema.hasMatches?.required === true &&
    contract.outputSchema.hasMatches?.type === SKILL_VALUE_TYPES.boolean &&
    hasOutputEnvelope(contract.outputSchema);
};

const isDocumentRagEntry = (skill) => {
  if (!skill) {
    return false;
  }

  const contract = getSkillContract(skill);

  return contract.requiresAccessScope &&
    contract.budgetKey === "documentRagCalls" &&
    contract.effects === SKILL_EFFECTS.workspaceWrite &&
    contract.idempotency === SKILL_IDEMPOTENCY.adapterDefined &&
    !contract.replaySafe &&
    !contract.retryable &&
    !contract.parallelSafe &&
    contract.inputSchema.docIds?.required === true &&
    contract.inputSchema.docIds?.scoped === true &&
    contract.inputSchema.docIds?.type === SKILL_VALUE_TYPES.stringArray &&
    contract.inputSchema.question?.required === true &&
    contract.inputSchema.question?.type === SKILL_VALUE_TYPES.string &&
    contract.inputSchema.retrievalPlan?.type === SKILL_VALUE_TYPES.object &&
    contract.outputSchema.evidence?.required === true &&
    contract.outputSchema.evidence?.type === SKILL_VALUE_TYPES.object &&
    hasOutputEnvelope(contract.outputSchema);
};

const isDocumentEvidenceCheckEntry = (skill) => {
  if (!skill) {
    return false;
  }

  const contract = getSkillContract(skill);

  return contract.requiresAccessScope &&
    contract.budgetKey === null &&
    contract.effects === SKILL_EFFECTS.readOnly &&
    contract.idempotency === SKILL_IDEMPOTENCY.deterministic &&
    contract.replaySafe &&
    contract.retryable &&
    contract.parallelSafe &&
    contract.inputSchema.docIds?.required === true &&
    contract.inputSchema.docIds?.scoped === true &&
    contract.inputSchema.docIds?.type === SKILL_VALUE_TYPES.stringArray &&
    contract.inputSchema.question?.required === true &&
    contract.inputSchema.question?.type === SKILL_VALUE_TYPES.string &&
    contract.inputSchema.evidence?.required === true &&
    contract.inputSchema.evidence?.type === SKILL_VALUE_TYPES.object &&
    contract.outputSchema.check?.required === true &&
    contract.outputSchema.check?.type === SKILL_VALUE_TYPES.object &&
    contract.outputSchema.passed?.required === true &&
    contract.outputSchema.passed?.type === SKILL_VALUE_TYPES.boolean &&
    contract.outputSchema.retryRecommended?.required === true &&
    contract.outputSchema.retryRecommended?.type === SKILL_VALUE_TYPES.boolean &&
    contract.outputSchema.followUpQuestion?.required === true &&
    contract.outputSchema.followUpQuestion?.type === SKILL_VALUE_TYPES.string &&
    hasOutputEnvelope(contract.outputSchema);
};

const hasGuardedWebCapability = (capabilityRegistry) => {
  if (
    typeof capabilityRegistry?.get !== "function" ||
    typeof capabilityRegistry?.execute !== "function"
  ) {
    return false;
  }

  try {
    const capability = capabilityRegistry.get(CAPABILITY_IDS.webSearch);

    if (!capability || capability.id !== CAPABILITY_IDS.webSearch) {
      return false;
    }

    validateCapabilityContract(capability);

    return capability.approvalPolicy.mode === "user_confirmation" &&
      capability.approvalPolicy.userConfirmationRequired === true &&
      capability.approvalPolicy.writesWorkspace === false &&
      capability.privacyPolicy.externalCall === true &&
      capability.inputSchema.properties?.question?.type === "string" &&
      capability.inputSchema.required?.includes("question") === true;
  } catch {
    return false;
  }
};

const isWebEntry = (skill, capabilityRegistry) => {
  if (!skill || !hasGuardedWebCapability(capabilityRegistry)) {
    return false;
  }

  const contract = getSkillContract(skill);

  return contract.budgetKey === "webSearchCalls" &&
    contract.effects === SKILL_EFFECTS.externalRead &&
    contract.idempotency === SKILL_IDEMPOTENCY.nondeterministic &&
    !contract.replaySafe &&
    !contract.retryable &&
    !contract.parallelSafe &&
    contract.inputSchema.question?.required === true &&
    contract.inputSchema.question?.type === SKILL_VALUE_TYPES.string &&
    hasOutputEnvelope(contract.outputSchema);
};

/**
 * Trusted catalog for the all-stage DAG. The model receives only
 * `descriptors`; the runtime may use the narrowed `graphRegistry`. Capability
 * adapters are included only when a trusted caller explicitly allowlists their
 * ids, and still delegate execution/approval to the Capability registry.
 * Building a catalog routes nothing (`executionWired` stays false for this
 * module): only the guarded rollout in agent-unified-graph-run.js executes a
 * graph drawn from it, after admission. An approval-gated Capability node in
 * such a graph pauses at a graph-bound gate and continues after the decision
 * (agent-unified-graph-stage.js).
 */
export const buildAuthorizedUnifiedGraphCatalog = ({
  accessScope,
  allowedCapabilityIds = [],
  capabilityRegistry,
  docIds = [],
  ragService,
  registry,
} = {}) => {
  if (!isRecord(accessScope)) {
    return {
      descriptors: [],
      executionWired: false,
      graphRegistry: createGraphRegistry([]),
      skills: [],
    };
  }

  const customSkills = listAuthorizedAtomicCustomSkills({
    accessScope,
    docIds,
    ragService,
    registry,
  }).filter(hasExplicitExecutionGraphContract);
  const skills = [...customSkills];
  const stages = new Map(customSkills.map((skill) => [skill.id, "custom_skill"]));
  const hasScopedListing = hasVerifiedScopedListing({ accessScope, ragService });

  if (hasScopedListing) {
    const inventorySkill = getExplicitBuiltIn(registry, AGENT_SKILL_IDS.inventory);

    if (isInventoryEntry(inventorySkill)) {
      skills.push(inventorySkill);
      stages.set(inventorySkill.id, "inventory");
    }
  }

  if (hasVerifiedDocuments({ accessScope, docIds, ragService })) {
    const documentSkill = getExplicitBuiltIn(registry, AGENT_SKILL_IDS.documentRag);

    if (isDocumentRagEntry(documentSkill)) {
      skills.push(documentSkill);
      stages.set(documentSkill.id, "document_rag_primary");

      const evidenceCheckSkill = getExplicitBuiltIn(
        registry,
        AGENT_SKILL_IDS.documentEvidenceCheck
      );

      if (isDocumentEvidenceCheckEntry(evidenceCheckSkill)) {
        skills.push(evidenceCheckSkill);
        stages.set(evidenceCheckSkill.id, "document_evidence_check");
      }
    }

    if (hasScopedListing) {
      const discoverySkill = getExplicitBuiltIn(registry, AGENT_SKILL_IDS.documentDiscovery);

      if (isDocumentDiscoveryEntry(discoverySkill, capabilityRegistry)) {
        skills.push(discoverySkill);
        stages.set(discoverySkill.id, "document_discovery");
      }
    }
  }

  const webSkill = getExplicitBuiltIn(registry, AGENT_SKILL_IDS.webSearch);

  if (isWebEntry(webSkill, capabilityRegistry)) {
    skills.push(webSkill);
    stages.set(webSkill.id, "web_search");
  }

  const capabilityAdapters = Array.isArray(allowedCapabilityIds)
    ? [...new Set(allowedCapabilityIds.map(normalizeText))]
        .map((capabilityId) => createCapabilityGraphAdapter({
          capabilityId,
          capabilityRegistry,
        }))
        .filter((adapter) => adapter && hasExplicitExecutionGraphContract(adapter))
    : [];

  for (const adapter of capabilityAdapters) {
    // A direct Capability and its legacy built-in wrapper must not be two
    // separate planner choices for the same external Web call.
    if (adapter.id === `capability:${CAPABILITY_IDS.webSearch}`) {
      const legacyWebIndex = skills.findIndex((skill) => skill.id === AGENT_SKILL_IDS.webSearch);

      if (legacyWebIndex >= 0) {
        skills.splice(legacyWebIndex, 1);
        stages.delete(AGENT_SKILL_IDS.webSearch);
      }
    }

    skills.push(adapter);
    stages.set(adapter.id, "capability");
  }

  const descriptors = skills.map((skill) => ({
    ...describeSkillForPlanner(skill),
    // Informational only: runtime recovery rechecks the live registered
    // contract and never accepts a planner-authored replay declaration.
    replayPolicy: {
      replaySafe: getSkillContract(skill).replaySafe,
      retryable: getSkillContract(skill).retryable,
    },
    stage: stages.get(skill.id),
    ...([AGENT_SKILL_IDS.webSearch, AGENT_SKILL_IDS.documentDiscovery].includes(skill.id)
      ? { approval: { mode: "user_confirmation", required: true } }
      : skill.kind === "capability"
        ? { approval: { mode: skill.approvalMode, required: skill.requiresApproval } }
        : {}),
  }));

  return {
    descriptors,
    executionWired: false,
    graphRegistry: createGraphRegistry(skills),
    skills,
  };
};

export const listAuthorizedUnifiedGraphDescriptors = (options) =>
  buildAuthorizedUnifiedGraphCatalog(options).descriptors;
