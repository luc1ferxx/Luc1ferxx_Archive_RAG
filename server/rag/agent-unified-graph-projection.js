import { isDeepStrictEqual } from "node:util";

import { EXECUTION_GRAPH_VERSIONS } from "./agent-execution-graph.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";
import { hasConsistentDocumentRagGraphResult } from "./skills/document-rag-graph-result.js";
import {
  getSkillContract,
  hasExplicitExecutionGraphContract,
  validateSkillValues,
} from "./skills/skill-contract.js";

// A shape adapter, not an execution or authorization boundary. The v3 graph
// still needs its own scoped catalog, durable lifecycle, approval continuation,
// and document evidence loop before callers can hand this state to finalization.
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

const PROJECTABLE_BUILT_INS = new Set([
  AGENT_SKILL_IDS.documentRag,
  AGENT_SKILL_IDS.webSearch,
  AGENT_SKILL_IDS.inventory,
  AGENT_SKILL_IDS.documentDiscovery,
]);

const RESERVED_BUILT_IN_IDS = new Set(Object.values(AGENT_SKILL_IDS));

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

  const state = emptyExecutionState();
  const customIds = new Set();
  const completedResults = [];

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
      !hasExplicitExecutionGraphContract(skill) ||
      nodeRun.skillVersion !== skill.version ||
      !(
        (skill.kind === "custom" && !RESERVED_BUILT_IN_IDS.has(skill.id)) ||
        (skill.kind === "built_in" && PROJECTABLE_BUILT_INS.has(skill.id))
      )
    ) {
      fail(`node ${node.nodeId} has no supported live typed Skill`);
    }

    if (nodeRun.status === "skipped") {
      if (
        (nodeRun.result !== null && nodeRun.result !== undefined) ||
        !["condition_not_met", "dependency_skipped"].includes(nodeRun.reason)
      ) {
        fail(`node ${node.nodeId} has an ambiguous skip receipt`);
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

    if (skill.id === AGENT_SKILL_IDS.documentRag) {
      if (state.ragResult || !isValidLegacyValue({ result, skillId: skill.id })) {
        fail("document RAG output is repeated or cannot represent the legacy result");
      }
      state.ragResult = result;
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

    fail(`Skill ${skill.id} has no legacy execution-state projection`);
  }

  if (
    completedResults.length === 0 ||
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

  state.customSkillGraphExecuted = state.customSkillResults.length > 0;
  return state;
};
