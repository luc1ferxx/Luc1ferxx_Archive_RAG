import { isDeepStrictEqual } from "node:util";

import { EXECUTION_GRAPH_VERSIONS } from "./agent-execution-graph.js";
import { selectBetterRagResult } from "./agent-self-check.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";
import { hasConsistentDocumentRagGraphResult } from "./skills/document-rag-graph-result.js";
import {
  getSkillContract,
  hasExplicitExecutionGraphContract,
  validateSkillValues,
} from "./skills/skill-contract.js";

// A shape adapter, not an execution or authorization boundary. The guarded v3
// path hands this state to the existing finalizeAgentRun; the scoped catalog,
// durable lifecycle, and document-loop working memory live in their own
// modules. describeUnifiedGraphProjectionShape is the static half of this
// adapter: a graph it refuses is rejected before any node runs, so a planner
// can never execute work the legacy finalizer cannot represent.
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const projectionError = (reason) => {
  const error = new Error(`Unified graph result cannot be projected: ${reason}.`);
  error.code = "AGENT_UNIFIED_GRAPH_PROJECTION_INVALID";
  error.status = 409;
  return error;
};

const fail = (reason) => {
  throw projectionError(reason);
};

const isValidNormalizedResult = ({ result, skill }) => {
  if (
    !isRecord(result) ||
    result.ok !== true ||
    result.skillId !== skill.id ||
    result.skillVersion !== skill.version ||
    typeof result.text !== "string" ||
    !Array.isArray(result.citations) ||
    !result.citations.every(isRecord) ||
    typeof result.abstained !== "boolean" ||
    !Object.hasOwn(result, "value") ||
    result.value === undefined ||
    !isRecord(result.graphOutput)
  ) {
    return false;
  }

  const validation = validateSkillValues({
    allowNestedValue: false,
    output: result.graphOutput,
    schema: getSkillContract(skill).outputSchema,
  });

  return (
    validation.ok &&
    isDeepStrictEqual(validation.output, result.graphOutput) &&
    ["text", "citations", "abstained"].every(
      (field) =>
        !Object.hasOwn(validation.output, field) ||
        isDeepStrictEqual(validation.output[field], result[field])
    )
  );
};

const isValidLegacyValue = ({ result, skillId }) => {
  if (!isRecord(result.value) || result.value.text !== result.text) {
    return false;
  }

  // Document RAG's old response path reads these from value, including during
  // evidence checking and Web fallback. A normalized answer envelope alone is
  // not enough to represent an atomic RAG result there.
  if (skillId === AGENT_SKILL_IDS.documentRag) {
    return Array.isArray(result.value.citations) &&
      typeof result.value.abstained === "boolean" &&
      hasConsistentDocumentRagGraphResult(result);
  }

  // chatMCP currently returns { text }, so the Web value can legitimately lack
  // citations/abstained even though the normalized Skill result has both.
  return (
    (result.value.citations === undefined ||
      isDeepStrictEqual(result.value.citations, result.citations)) &&
    (result.value.abstained === undefined ||
      result.value.abstained === result.abstained)
  );
};

const emptyExecutionState = () => ({
  arxivImportAnswer: null,
  actionAnswer: null,
  customSkillResults: [],
  customSkillGraphExecuted: false,
  customSkills: [],
  discoveryAnswer: null,
  documentEvidenceClarification: null,
  documentRagSkill: null,
  inventoryAnswer: null,
  ragResult: null,
  researchBrief: null,
  response: null,
  shouldRunWeb: false,
  skippedWebBecauseBudget: false,
  webResult: null,
});

// The skip reason of a node whose approval gate the user rejected (the
// runner's EXECUTION_GRAPH_SKIP_REASONS.approvalDenied).
export const APPROVAL_DENIED_SKIP_REASON = "approval_denied";

const PROJECTABLE_BUILT_INS = new Set([
  AGENT_SKILL_IDS.documentRag,
  AGENT_SKILL_IDS.documentEvidenceCheck,
  AGENT_SKILL_IDS.webSearch,
  AGENT_SKILL_IDS.inventory,
  AGENT_SKILL_IDS.documentDiscovery,
]);

const RESERVED_BUILT_IN_IDS = new Set(Object.values(AGENT_SKILL_IDS));
const DIRECT_BUILT_IN_IDS = new Set([
  AGENT_SKILL_IDS.inventory,
  AGENT_SKILL_IDS.documentDiscovery,
]);

const isNodeBinding = (binding, nodeId, output) =>
  isRecord(binding) &&
  binding.source === "node" &&
  binding.nodeId === nodeId &&
  binding.output === output;

// V1 represents a Capability's answer only as the workspace action the intent
// asked for (`actionAnswer`, synthesized for plan.mode "workspace_action").
// A Capability node is projectable exactly there, once per graph.
const isIntentActionCapability = (skill, plan) =>
  skill?.kind === "capability" &&
  plan?.mode === "workspace_action" &&
  typeof plan.actionCapabilityId === "string" &&
  skill.id === `capability:${plan.actionCapabilityId}`;

const isProjectableSkill = (skill, plan) =>
  Boolean(skill) &&
  hasExplicitExecutionGraphContract(skill) &&
  ((skill.kind === "custom" && !RESERVED_BUILT_IN_IDS.has(skill.id)) ||
    (skill.kind === "built_in" && PROJECTABLE_BUILT_INS.has(skill.id)) ||
    isIntentActionCapability(skill, plan));

/** The workspace-action answer of a Capability node the user rejected. */
export const buildDeniedCapabilityAnswer = (skill) =>
  `${skill?.label || "The workspace action"} was not run: the approval was denied.`;

const shapeError = (reason) => ({ ok: false, reason });

/**
 * Static projection contract for a validated v3 graph. The legacy execution
 * state has one ragResult (the better of a primary document answer and at most
 * one conditional follow-up), one webResult, a flat custom-Skill list, a
 * direct answer only for a standalone inventory/discovery request, and one
 * workspace action answer (the Capability the intent itself asked for). A graph
 * outside that shape is refused before execution instead of failing after
 * its nodes have already spent budget and written session state.
 */
export const describeUnifiedGraphProjectionShape = ({ graph, plan, registry } = {}) => {
  if (
    graph?.version !== EXECUTION_GRAPH_VERSIONS.v3 ||
    !Array.isArray(graph.nodes) ||
    graph.nodes.length === 0 ||
    typeof registry?.get !== "function"
  ) {
    return shapeError("graph_or_registry_missing");
  }

  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const documentNodeIds = [];
  const checkSources = new Map();
  let webNodeCount = 0;
  let capabilityNodeCount = 0;

  for (const node of graph.nodes) {
    const skill = registry.get(node?.skillId);

    if (!isProjectableSkill(skill, plan)) {
      return shapeError(`node_${node?.nodeId}_not_projectable`);
    }

    if (skill.kind === "capability") {
      capabilityNodeCount += 1;
    } else if (skill.id === AGENT_SKILL_IDS.documentRag) {
      documentNodeIds.push(node.nodeId);
    } else if (skill.id === AGENT_SKILL_IDS.webSearch) {
      webNodeCount += 1;
    } else if (skill.id === AGENT_SKILL_IDS.documentEvidenceCheck) {
      const binding = node.inputBindings?.evidence;
      const source = nodes.get(binding?.nodeId);

      if (
        !isNodeBinding(binding, binding?.nodeId, "evidence") ||
        source?.skillId !== AGENT_SKILL_IDS.documentRag ||
        !(node.dependsOn ?? []).includes(binding.nodeId)
      ) {
        return shapeError(`check_${node.nodeId}_without_document_evidence`);
      }

      checkSources.set(node.nodeId, binding.nodeId);
    } else if (DIRECT_BUILT_IN_IDS.has(skill.id)) {
      if (graph.nodes.length !== 1 || plan?.mode !== skill.id) {
        return shapeError("direct_skill_not_standalone");
      }
    }
  }

  if (webNodeCount > 1) {
    return shapeError("repeated_web_output");
  }

  if (capabilityNodeCount > 1) {
    return shapeError("repeated_action_output");
  }

  if (documentNodeIds.length > 2) {
    return shapeError("repeated_document_output");
  }

  const [primaryDocumentNodeId = null, followUpNodeId = null] = documentNodeIds;
  let followUpCheckNodeId = null;

  if (followUpNodeId) {
    const followUp = nodes.get(followUpNodeId);
    const checkNodeId = followUp.when?.nodeId;

    // A second document call is admissible only as the conditional follow-up
    // of the primary answer's own evidence check: it runs when that check asks
    // for one and reads the check's focused question, never a free-form one.
    if (
      checkSources.get(checkNodeId) !== primaryDocumentNodeId ||
      followUp.when?.output !== "retryRecommended" ||
      followUp.when?.equals !== true ||
      !isNodeBinding(followUp.inputBindings?.question, checkNodeId, "followUpQuestion")
    ) {
      return shapeError("repeated_document_output");
    }

    followUpCheckNodeId = checkNodeId;
  }

  return {
    followUpCheckNodeId,
    followUpNodeId,
    ok: true,
    primaryDocumentNodeId,
    reason: null,
  };
};

/**
 * Project completed, validated v3 node results into runAgentExecutionPlan's
 * existing state shape. It never reclassifies an unknown node as a custom Skill
 * and never reconstructs a RAG/Web result from a text-only graph output.
 */
export const projectUnifiedGraphRun = ({ graph, run, registry, plan } = {}) => {
  if (
    graph?.version !== EXECUTION_GRAPH_VERSIONS.v3 ||
    run?.graphVersion !== EXECUTION_GRAPH_VERSIONS.v3 ||
    run?.ok !== true ||
    run?.status !== "completed" ||
    !Array.isArray(graph.nodes) ||
    graph.nodes.length === 0 ||
    !Array.isArray(run.nodeRuns) ||
    run.nodeRuns.length !== graph.nodes.length ||
    !Array.isArray(run.results) ||
    typeof registry?.get !== "function"
  ) {
    fail("a completed v3 graph, node receipts, and live Skill registry are required");
  }

  const nodes = new Map();
  for (const node of graph.nodes) {
    if (
      !isRecord(node) ||
      typeof node.nodeId !== "string" ||
      !node.nodeId ||
      typeof node.skillId !== "string" ||
      !node.skillId ||
      nodes.has(node.nodeId)
    ) {
      fail("graph node identity is missing or duplicated");
    }
    nodes.set(node.nodeId, node);
  }

  const receipts = new Map();
  for (const nodeRun of run.nodeRuns) {
    if (
      !isRecord(nodeRun) ||
      !nodes.has(nodeRun.nodeId) ||
      receipts.has(nodeRun.nodeId)
    ) {
      fail("node receipt identity is missing, duplicated, or outside the graph");
    }
    receipts.set(nodeRun.nodeId, nodeRun);
  }

  const shape = describeUnifiedGraphProjectionShape({ graph, plan, registry });
  const documentResults = new Map();
  const state = emptyExecutionState();
  const customIds = new Set();
  const completedResults = [];
  let deniedActions = 0;

  // Graph declaration order is the scheduler's stable presentation order.
  for (const node of graph.nodes) {
    const nodeRun = receipts.get(node.nodeId);
    if (nodeRun.skillId !== node.skillId) {
      fail(`node ${node.nodeId} receipt names another Skill`);
    }

    const skill = registry.get(node.skillId);
    if (
      !skill ||
      skill.id !== node.skillId ||
      nodeRun.skillVersion !== skill.version ||
      !isProjectableSkill(skill, plan)
    ) {
      fail(`node ${node.nodeId} has no supported live typed Skill`);
    }

    if (nodeRun.status === "skipped") {
      const denied = nodeRun.reason === APPROVAL_DENIED_SKIP_REASON && skill.kind === "capability";

      if (
        (nodeRun.result !== null && nodeRun.result !== undefined) ||
        (!denied && !["condition_not_met", "dependency_skipped"].includes(nodeRun.reason))
      ) {
        fail(`node ${node.nodeId} has an ambiguous skip receipt`);
      }

      if (denied) {
        // The user rejected the action: the answer says so, and nothing the
        // Capability would have produced exists.
        state.actionAnswer = buildDeniedCapabilityAnswer(skill);
        deniedActions += 1;
      }
      continue;
    }

    if (!["completed", "reused"].includes(nodeRun.status)) {
      fail(`node ${node.nodeId} is not successfully settled`);
    }

    if (!isValidNormalizedResult({ result: nodeRun.result, skill })) {
      fail(`node ${node.nodeId} has no matching live typed Skill result`);
    }

    const result = nodeRun.result;
    completedResults.push(result);

    if (skill.kind === "custom") {
      state.customSkillResults.push(result);
      if (!customIds.has(skill.id)) {
        state.customSkills.push(skill);
        customIds.add(skill.id);
      }
      continue;
    }

    if (skill.id === AGENT_SKILL_IDS.documentEvidenceCheck) {
      // A control node: its typed check feeds the document loop's working
      // memory and gap handling, never the answer sources.
      if (!shape.ok) {
        fail(`document evidence check cannot be projected (${shape.reason})`);
      }
      continue;
    }

    if (skill.id === AGENT_SKILL_IDS.documentRag) {
      if (
        documentResults.has(node.nodeId) ||
        !isValidLegacyValue({ result, skillId: skill.id }) ||
        (documentResults.size > 0 &&
          (!shape.ok || shape.followUpNodeId !== node.nodeId))
      ) {
        fail("document RAG output is repeated or cannot represent the legacy result");
      }
      documentResults.set(node.nodeId, result);
      state.documentRagSkill = skill;
      continue;
    }

    if (skill.id === AGENT_SKILL_IDS.webSearch) {
      if (state.webResult || !isValidLegacyValue({ result, skillId: skill.id })) {
        fail("Web output is repeated or cannot represent the legacy result");
      }
      state.webResult = result;
      state.shouldRunWeb = true;
      continue;
    }

    if (skill.id === AGENT_SKILL_IDS.inventory) {
      if (state.inventoryAnswer !== null || !result.text) {
        fail("inventory output is repeated or empty");
      }
      state.inventoryAnswer = result.text;
      continue;
    }

    if (skill.id === AGENT_SKILL_IDS.documentDiscovery) {
      if (state.discoveryAnswer !== null || !result.text) {
        fail("document discovery output is repeated or empty");
      }
      state.discoveryAnswer = result.text;
      continue;
    }

    if (skill.kind === "capability") {
      if (state.actionAnswer !== null || !result.text) {
        fail("workspace action output is repeated or empty");
      }
      state.actionAnswer = result.text;
      continue;
    }

    fail(`Skill ${skill.id} has no legacy execution-state projection`);
  }

  if (documentResults.size > 0) {
    const primary = shape.ok && shape.primaryDocumentNodeId
      ? documentResults.get(shape.primaryDocumentNodeId) ?? null
      : [...documentResults.values()][0];
    const followUp = shape.ok && shape.followUpNodeId
      ? documentResults.get(shape.followUpNodeId) ?? null
      : null;

    if (!primary) {
      fail("a follow-up document result has no primary answer");
    }

    // The same choice runDocumentRagLoop makes between its two calls.
    state.ragResult = followUp
      ? selectBetterRagResult({ primary, retry: followUp })
      : primary;
  }

  // A graph whose only node was a rejected action completed with no result;
  // any other empty graph did not.
  if (
    (completedResults.length === 0 && deniedActions === 0) ||
    run.results.length !== completedResults.length ||
    run.results.some((result, index) =>
      !isDeepStrictEqual(result, completedResults[index])
    )
  ) {
    fail("graph results disagree with completed node receipts");
  }

  const directResults = [state.inventoryAnswer, state.discoveryAnswer].filter(
    (value) => value !== null
  );
  if (
    directResults.length > 0 &&
    (completedResults.length !== 1 ||
      ![AGENT_SKILL_IDS.inventory, AGENT_SKILL_IDS.documentDiscovery].includes(
        plan?.mode
      ) ||
      (state.inventoryAnswer !== null && plan.mode !== AGENT_SKILL_IDS.inventory) ||
      (state.discoveryAnswer !== null &&
        plan.mode !== AGENT_SKILL_IDS.documentDiscovery))
  ) {
    fail("legacy synthesis can only represent a matching standalone direct Skill");
  }

  // The graph-evidence policy (every node's citations, Web included, count
  // as verification sources) applies only when a custom Skill actually
  // answered. An abstaining Skill node contributes no answer, so it must not
  // switch the finalizer away from the evidence policy the same request gets
  // without it (where Web context never verifies a document-mode claim).
  state.customSkillGraphExecuted = state.customSkillResults.some(
    (result) => result.abstained !== true
  );
  return state;
};
