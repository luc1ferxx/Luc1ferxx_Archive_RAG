import { randomUUID } from "node:crypto";

import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";
import { describeUnifiedGraphProjectionShape } from "./agent-unified-graph-projection.js";
import {
  CAPABILITY_POLICY_DECISIONS,
  evaluateCapabilityPolicy,
} from "./capabilities/policy-enforcer.js";
import { CAPABILITY_IDS } from "./capabilities/shared.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";
import {
  SKILL_EFFECTS,
  SKILL_VALUE_TYPES,
  getSkillContract,
} from "./skills/skill-contract.js";

// Guarded v3 admission: the last pure decision before a graph may take the
// request away from the V1 path. Nothing here runs a node, writes a step, or
// reserves budget, so a refusal can still hand the request to V1 unchanged.
//
// Approval continuation inside the graph is frozen. A node that could pause
// for a user decision mid-graph would leave earlier nodes executed and the
// request unable to fall back, so every such node refuses the whole graph:
//   * a direct Capability adapter that declares an approval gate, always;
//   * a built-in wrapper (Web search, document discovery) whose Capability
//     requires confirmation, unless the request already carries a standing,
//     input-independent grant for it (the same grant V1 would apply).
// The graph must also fit the legacy finalizer's state (projection shape), or
// its answer could not be finalized after its nodes already ran.
//
// Three data boundaries hold for every admitted graph, whatever the planner
// proposed:
//   * a node with an external effect (Web search, an external Capability)
//     reads only the user's own request: its string inputs bind to
//     request.question, never to an upstream output that may carry document
//     text to a third-party provider;
//   * the output of such a node never binds into another node's input. Web
//     text is model output built from external pages; the only consumer that
//     treats it as untrusted evidence is the finalizer, so it reaches the
//     answer there and never a Skill prompt (a boolean `when` on it is fine);
//   * a request the intent scoped to its selected documents keeps them first:
//     its primary document RAG node runs unconditionally on the request, and
//     when the intent did not ask for the Web a Web node runs only after that
//     primary answer failed its own evidence check (the V1 order extended from
//     abstention to a failed check).

export const UNIFIED_GRAPH_ADMISSION_REASON_CODES = Object.freeze({
  approvalGatedCapability: "approval_gated_capability",
  approvalWithoutStandingGrant: "approval_required_without_standing_grant",
  documentRequestWithoutDocumentNode: "document_request_without_document_node",
  externalInputNotRequestQuestion: "external_input_not_request_question",
  externalOutputHandOff: "external_output_hand_off",
  graphNotProjectable: "graph_not_projectable",
  webNotGatedOnDocumentEvidence: "web_not_gated_on_document_evidence",
});

const EXTERNAL_EFFECTS = new Set([
  SKILL_EFFECTS.externalRead,
  SKILL_EFFECTS.externalWrite,
]);

// Built-in Skills that execute through a confirmation-gated Capability. Their
// approval happens inside execute(), not at a graph node boundary.
const CAPABILITY_BACKED_BUILT_INS = Object.freeze({
  [AGENT_SKILL_IDS.webSearch]: CAPABILITY_IDS.webSearch,
  [AGENT_SKILL_IDS.documentDiscovery]: CAPABILITY_IDS.documentDiscovery,
});

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * True only when `approvals` grants `capabilityId` for any input. The probe
 * input is an unpredictable string: an approval bound to an approval-object
 * hash can never match it, while an unbound grant (a background task's
 * standing approval) matches every input. This is the property the graph
 * needs, because a Web node's question may be bound from an upstream output
 * that does not exist yet.
 */
export const hasStandingCapabilityGrant = ({
  accessScope,
  approvals = {},
  capabilityId,
  capabilityRegistry,
  docIds = [],
} = {}) => {
  const capability = capabilityRegistry?.get?.(capabilityId) ?? null;
  const approval = isRecord(approvals)
    ? approvals[capabilityId] ?? approvals["*"]
    : null;

  if (!capability || !isRecord(approval)) {
    return false;
  }

  const probe = `unified-graph-admission-probe:${randomUUID()}`;
  const input = capabilityId === CAPABILITY_IDS.documentDiscovery
    ? { docIds: [...docIds], question: probe }
    : { question: probe };

  try {
    return evaluateCapabilityPolicy(capability, {
      accessScope,
      approval,
      input,
    }).decision === CAPABILITY_POLICY_DECISIONS.allowed;
  } catch {
    return false;
  }
};

const capabilityRequiresConfirmation = (capabilityRegistry, capabilityId) => {
  const policy = capabilityRegistry?.get?.(capabilityId)?.approvalPolicy;

  // Unknown policy counts as gated: admission fails closed.
  return !isRecord(policy) ||
    policy.userConfirmationRequired === true ||
    policy.requiresApproval === true ||
    ["approval_required", "manual", "user_confirmation"].includes(
      normalizeText(policy.mode).toLowerCase()
    );
};

/**
 * The approval refusal for one node, or null when it may start without a
 * user decision. Recovery also asks this right before a node would start.
 */
export const assessUnifiedGraphNodeApproval = ({
  accessScope,
  capabilityApprovals = {},
  capabilityRegistry,
  docIds = [],
  skill,
} = {}) => {
  if (skill?.kind === "capability") {
    return skill.requiresApproval !== false
      ? UNIFIED_GRAPH_ADMISSION_REASON_CODES.approvalGatedCapability
      : null;
  }

  if (!Object.hasOwn(CAPABILITY_BACKED_BUILT_INS, skill?.id ?? "")) {
    return null;
  }

  const capabilityId = CAPABILITY_BACKED_BUILT_INS[skill.id];

  return capabilityRequiresConfirmation(capabilityRegistry, capabilityId) &&
    !hasStandingCapabilityGrant({
      accessScope,
      approvals: capabilityApprovals,
      capabilityId,
      capabilityRegistry,
      docIds,
    })
    ? UNIFIED_GRAPH_ADMISSION_REASON_CODES.approvalWithoutStandingGrant
    : null;
};

const hasExternalEffect = (skill) =>
  Boolean(skill) && EXTERNAL_EFFECTS.has(getSkillContract(skill).effects);

const bindingSource = (binding) => normalizeText(binding?.source);

/**
 * Graph-wide data boundaries (see the header). Pure in the graph, the
 * registry, the intent plan, and the request's document ids; a recovery
 * boundary re-derives the same verdict for the same digest-bound graph.
 */
const assessUnifiedGraphDataBoundaries = ({ docIds = [], graph, plan, registry, shape }) => {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const skillOf = (node) => registry?.get?.(node?.skillId) ?? null;
  const findings = [];
  const block = (reasonCode, nodeId) => findings.push({ nodeId, reasonCode });

  for (const node of nodes) {
    const skill = skillOf(node);
    const inputSchema = skill ? getSkillContract(skill).inputSchema ?? {} : {};
    const bindings = Object.entries(
      node?.inputBindings && typeof node.inputBindings === "object"
        ? node.inputBindings
        : {}
    );

    if (hasExternalEffect(skill)) {
      const leaksUpstreamText = bindings.some(([field, binding]) =>
        bindingSource(binding) !== "request" ||
        (inputSchema[field]?.type === SKILL_VALUE_TYPES.string &&
          normalizeText(binding?.field) !== "question")
      );

      if (leaksUpstreamText) {
        block(UNIFIED_GRAPH_ADMISSION_REASON_CODES.externalInputNotRequestQuestion, node.nodeId);
      }
    }

    if (
      bindings.some(([, binding]) =>
        bindingSource(binding) === "node" &&
        hasExternalEffect(skillOf(byId.get(normalizeText(binding?.nodeId))))
      )
    ) {
      block(UNIFIED_GRAPH_ADMISSION_REASON_CODES.externalOutputHandOff, node.nodeId);
    }
  }

  const documentScoped = plan?.wantsDocumentRag === true &&
    Array.isArray(docIds) &&
    docIds.length > 0;
  const primaryDocumentNodeId = shape.ok
    ? shape.primaryDocumentNodeId
    : nodes.find((node) => node?.skillId === AGENT_SKILL_IDS.documentRag)?.nodeId ?? null;

  // The primary document answer must always exist for such a request: a
  // primary node behind a condition or another node could be skipped and
  // leave a Web-only answer labelled with the document intent.
  const primaryDocumentNode = byId.get(primaryDocumentNodeId);

  if (
    documentScoped &&
    (!primaryDocumentNode ||
      primaryDocumentNode.when !== undefined ||
      (primaryDocumentNode.dependsOn ?? []).length > 0)
  ) {
    block(
      UNIFIED_GRAPH_ADMISSION_REASON_CODES.documentRequestWithoutDocumentNode,
      primaryDocumentNode?.nodeId ?? null
    );
  }

  if (plan?.wantsWeb !== true) {
    for (const node of nodes) {
      if (node?.skillId !== AGENT_SKILL_IDS.webSearch) {
        continue;
      }

      const check = byId.get(node.when?.nodeId);
      const evidence = check?.inputBindings?.evidence;
      const gatedOnPrimaryEvidence =
        Boolean(primaryDocumentNodeId) &&
        check?.skillId === AGENT_SKILL_IDS.documentEvidenceCheck &&
        node.when.output === "passed" &&
        node.when.equals === false &&
        (node.dependsOn ?? []).includes(check.nodeId) &&
        bindingSource(evidence) === "node" &&
        evidence.nodeId === primaryDocumentNodeId &&
        evidence.output === "evidence";

      if (!gatedOnPrimaryEvidence) {
        block(UNIFIED_GRAPH_ADMISSION_REASON_CODES.webNotGatedOnDocumentEvidence, node.nodeId);
      }
    }
  }

  return findings;
};

/**
 * Decide whether a validated v3 graph may execute under `guarded`.
 * `nodeIds` narrows the approval check to nodes still to run (a recovery
 * boundary reuses completed nodes and never re-executes them); the shape and
 * data boundaries always cover the whole graph.
 */
export const assessUnifiedGraphAdmission = ({
  accessScope,
  capabilityApprovals = {},
  capabilityRegistry,
  docIds = [],
  graph,
  nodeIds = null,
  plan,
  registry,
} = {}) => {
  const reasonCodes = new Set();
  const blockedNodeIds = [];
  const pending = Array.isArray(nodeIds) ? new Set(nodeIds) : null;
  const shape = describeUnifiedGraphProjectionShape({ graph, plan, registry });

  if (!shape.ok) {
    reasonCodes.add(UNIFIED_GRAPH_ADMISSION_REASON_CODES.graphNotProjectable);
  }

  for (const { nodeId, reasonCode } of assessUnifiedGraphDataBoundaries({
    docIds,
    graph,
    plan,
    registry,
    shape,
  })) {
    reasonCodes.add(reasonCode);
    if (nodeId && !blockedNodeIds.includes(nodeId)) {
      blockedNodeIds.push(nodeId);
    }
  }

  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (pending && !pending.has(node.nodeId)) {
      continue;
    }

    const reasonCode = assessUnifiedGraphNodeApproval({
      accessScope,
      capabilityApprovals,
      capabilityRegistry,
      docIds,
      skill: registry?.get?.(node.skillId) ?? null,
    });

    if (reasonCode) {
      reasonCodes.add(reasonCode);
      if (!blockedNodeIds.includes(node.nodeId)) {
        blockedNodeIds.push(node.nodeId);
      }
    }
  }

  return {
    admitted: reasonCodes.size === 0,
    blockedNodeIds,
    reasonCodes: [...reasonCodes].sort(),
    shape,
  };
};
