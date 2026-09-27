import { isDeepStrictEqual } from "node:util";

// Result text is trimmed, not whitespace-collapsed, by the Skill registry; the
// raw-value and evidence comparisons below must use the same normalizer.
import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";
import {
  EXECUTION_GRAPH_CHECKPOINT_VERSIONS,
  buildExecutionGraphNodeStepId,
} from "./agent-execution-graph-checkpoint.js";
import {
  EXECUTION_GRAPH_VERSIONS,
  validateExecutionGraph,
} from "./agent-execution-graph.js";
import { AGENT_SKILL_IDS } from "./skills/registry.js";
import { hasConsistentDocumentRagGraphResult } from "./skills/document-rag-graph-result.js";
import {
  SKILL_VALUE_TYPES,
  getSkillContract,
  hasExplicitExecutionGraphContract,
  validateSkillValues,
} from "./skills/skill-contract.js";

// A completed-run data boundary only. This does not authorize a graph, execute
// nodes, resume approvals, choose answer candidates, or synthesize a response.
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const invalid = (reason) => {
  const error = new Error(`Unified graph results are invalid: ${reason}.`);
  error.code = "AGENT_UNIFIED_GRAPH_RESULTS_INVALID";
  error.status = 409;
  return error;
};

const fail = (reason) => {
  throw invalid(reason);
};

const ANSWER_BUILT_INS = new Set([
  AGENT_SKILL_IDS.documentRag,
  AGENT_SKILL_IDS.webSearch,
]);
const CONTROL_BUILT_INS = new Set([AGENT_SKILL_IDS.documentEvidenceCheck]);
const DIRECT_BUILT_INS = new Set([
  AGENT_SKILL_IDS.inventory,
  AGENT_SKILL_IDS.documentDiscovery,
]);
const RESERVED_BUILT_INS = new Set(Object.values(AGENT_SKILL_IDS));
const SETTLED = new Set(["completed", "reused"]);
const BENIGN_SKIPS = new Set(["condition_not_met", "dependency_skipped"]);
// A rejected approval gate. Only a Capability node carries one.
const APPROVAL_DENIED = "approval_denied";

const classifySkill = (skill) => {
  if (skill.kind === "built_in") {
    if (ANSWER_BUILT_INS.has(skill.id)) return "answer";
    if (CONTROL_BUILT_INS.has(skill.id)) return "control";
    if (DIRECT_BUILT_INS.has(skill.id)) return "direct";
    fail(`built-in ${skill.id} has no graph result category`);
  }

  if (skill.kind === "custom" && !RESERVED_BUILT_INS.has(skill.id)) {
    return "answer";
  }

  if (skill.kind === "capability" && skill.id.startsWith("capability:")) {
    return "capability";
  }

  fail(`Skill ${skill.id} has no supported graph result category`);
};

const checkTypedResult = ({ nodeId, result, skill, contract }) => {
  if (
    !isRecord(result) ||
    result.ok !== true ||
    result.skillId !== skill.id ||
    result.skillVersion !== skill.version ||
    typeof result.text !== "string" ||
    !Array.isArray(result.citations) ||
    !result.citations.every(isRecord) ||
    typeof result.abstained !== "boolean" ||
    !isRecord(result.value) ||
    !isRecord(result.graphOutput)
  ) {
    fail(`node ${nodeId} has no complete successful typed result`);
  }

  for (const [field, type] of [
    ["text", SKILL_VALUE_TYPES.string],
    ["citations", SKILL_VALUE_TYPES.citationArray],
    ["abstained", SKILL_VALUE_TYPES.boolean],
  ]) {
    if (
      contract.outputSchema[field]?.required !== true ||
      contract.outputSchema[field]?.type !== type
    ) {
      fail(`node ${nodeId} has no explicit answer envelope`);
    }
  }

  const validation = validateSkillValues({
    allowNestedValue: false,
    output: result.graphOutput,
    schema: contract.outputSchema,
  });

  if (
    !validation.ok ||
    !isDeepStrictEqual(validation.output, result.graphOutput) ||
    !isDeepStrictEqual(result.graphOutput.text, result.text) ||
    !isDeepStrictEqual(result.graphOutput.citations, result.citations) ||
    !isDeepStrictEqual(result.graphOutput.abstained, result.abstained)
  ) {
    fail(`node ${nodeId} typed output disagrees with its result`);
  }

  // The raw value remains available for future response compatibility. If it
  // also carries a typed field, it must not tell a different story from the
  // validated graph output. In particular, document retrievedContexts may
  // never diverge from the downstream-bound evidence object.
  for (const field of Object.keys(contract.outputSchema)) {
    // `evidence` is a trusted projection of selected raw RAG fields, not a
    // promise that an arbitrary raw value.evidence is itself that projection.
    if (skill.id === AGENT_SKILL_IDS.documentRag && field === "evidence") {
      continue;
    }

    if (
      Object.hasOwn(result.value, field) &&
      !isDeepStrictEqual(
        field === "text" ? normalizeText(result.value[field]) : result.value[field],
        result.graphOutput[field]
      )
    ) {
      fail(`node ${nodeId} raw value disagrees on ${field}`);
    }
  }

  if (skill.id === AGENT_SKILL_IDS.documentRag) {
    if (!hasConsistentDocumentRagGraphResult(result)) {
      fail(`node ${nodeId} document evidence disagrees with its raw value`);
    }
  }

  return validation.output;
};

const verifyDocumentCheck = ({ entry, byNodeId, graphNodes }) => {
  const binding = entry.node.inputBindings?.evidence;
  const sourceNode = graphNodes.get(binding?.nodeId);

  if (
    binding?.source !== "node" ||
    binding.output !== "evidence" ||
    sourceNode?.skillId !== AGENT_SKILL_IDS.documentRag ||
    !(entry.node.dependsOn ?? []).includes(binding.nodeId)
  ) {
    fail(`node ${entry.nodeId} must bind evidence from an upstream document_rag`);
  }

  entry.sourceDocumentNodeId = binding.nodeId;

  if (entry.status === "skipped") {
    return;
  }

  const source = byNodeId.get(binding.nodeId);
  const evidence = source?.output?.evidence;
  const output = entry.output;

  if (
    !source ||
    !SETTLED.has(source.status) ||
    !isRecord(evidence) ||
    !isRecord(output.check) ||
    output.text !== normalizeText(evidence.text) ||
    !isDeepStrictEqual(output.citations, evidence.citations) ||
    output.abstained !== (evidence.abstained || !output.passed) ||
    output.check.passed !== output.passed ||
    output.check.retryRecommended !== output.retryRecommended ||
    (output.retryRecommended
      ? !output.followUpQuestion.trim()
      : output.followUpQuestion !== "")
  ) {
    fail(`node ${entry.nodeId} check disagrees with its document evidence`);
  }
};

const verifySettledDependencies = ({ entry, byNodeId }) => {
  const dependencies = (entry.node.dependsOn ?? []).map((nodeId) =>
    byNodeId.get(nodeId)
  );

  if (entry.status === "skipped") {
    if (entry.reason === "dependency_skipped") {
      if (
        !dependencies.some((dependency) => dependency?.status === "skipped") ||
        dependencies.some((dependency) => !dependency || ![
          ...SETTLED,
          "skipped",
        ].includes(dependency.status))
      ) {
        fail(`node ${entry.nodeId} has no settled skipped dependency`);
      }
      return;
    }

    if (entry.reason === APPROVAL_DENIED) {
      // The gate was reached, so everything the node waited for completed.
      if (!dependencies.every((dependency) => SETTLED.has(dependency?.status))) {
        fail(`node ${entry.nodeId} was denied before its dependencies completed`);
      }
      return;
    }

    if (
      entry.reason !== "condition_not_met" ||
      !isRecord(entry.node.when) ||
      !dependencies.every((dependency) => SETTLED.has(dependency?.status)) ||
      byNodeId.get(entry.node.when.nodeId)?.output?.[entry.node.when.output] ===
        entry.node.when.equals
    ) {
      fail(`node ${entry.nodeId} has no false condition for its skip`);
    }
    return;
  }

  if (!dependencies.every((dependency) => SETTLED.has(dependency?.status))) {
    fail(`node ${entry.nodeId} ran without all dependencies completed`);
  }

  if (
    entry.node.when &&
    byNodeId.get(entry.node.when.nodeId)?.output?.[entry.node.when.output] !==
      entry.node.when.equals
  ) {
    fail(`node ${entry.nodeId} ran despite a false condition`);
  }
};

/**
 * Collects validated, node-addressable v3 results without collapsing repeated
 * Skills into V1's singleton ragResult/webResult slots. The caller must supply
 * the same request-scoped registry used for graph validation/execution; this
 * collector cannot establish the original caller's authorization by itself.
 */
export const collectUnifiedGraphResults = ({
  authorizedDocIds = [],
  graph,
  registry,
  run,
} = {}) => {
  if (
    graph?.version !== EXECUTION_GRAPH_VERSIONS.v3 ||
    run?.graphVersion !== EXECUTION_GRAPH_VERSIONS.v3 ||
    run?.status !== "completed" ||
    run?.ok !== true ||
    !Array.isArray(run.nodeRuns) ||
    !Array.isArray(run.results) ||
    !Array.isArray(run.errors) ||
    run.errors.length !== 0 ||
    typeof registry?.get !== "function" ||
    typeof registry?.list !== "function"
  ) {
    fail("a successful completed v3 run and live scoped registry are required");
  }

  const registered = registry.list();

  if (
    !Array.isArray(registered) ||
    registered.some((skill) =>
      !isRecord(skill) || registry.get(skill.id) !== skill
    ) ||
    new Set(registered.map((skill) => skill.id)).size !== registered.length
  ) {
    fail("live registry identity is missing or duplicated");
  }

  const validation = validateExecutionGraph({
    authorizedDocIds,
    authorizedSkillIds: registered.map((skill) => skill.id),
    graph,
    registry,
  });

  if (!validation.ok) {
    fail(`graph contract failed (${validation.errors[0]?.code ?? "unknown"})`);
  }

  if (run.nodeRuns.length !== graph.nodes.length) {
    fail("node receipts do not cover the whole graph");
  }

  const graphNodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const receipts = new Map();

  for (const receipt of run.nodeRuns) {
    if (
      !isRecord(receipt) ||
      !graphNodes.has(receipt.nodeId) ||
      receipts.has(receipt.nodeId)
    ) {
      fail("node receipts contain an unknown or duplicate identity");
    }
    receipts.set(receipt.nodeId, receipt);
  }

  const entries = [];
  const byNodeId = new Map();
  const groups = {
    answer: [],
    control: [],
    direct: [],
    capability: [],
    skipped: [],
  };

  for (const node of graph.nodes) {
    const receipt = receipts.get(node.nodeId);
    const skill = registry.get(node.skillId);

    if (
      !receipt ||
      !skill ||
      !hasExplicitExecutionGraphContract(skill) ||
      typeof skill.execute !== "function"
    ) {
      fail(`node ${node.nodeId} has no supported live Skill contract`);
    }

    const contract = getSkillContract(skill);
    const category = classifySkill(skill);
    const expectedStepId = buildExecutionGraphNodeStepId({
      checkpointVersion: EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2,
      nodeId: node.nodeId,
    });

    if (
      receipt.skillId !== skill.id ||
      receipt.skillVersion !== skill.version ||
      receipt.stepId !== expectedStepId ||
      receipt.effects !== contract.effects ||
      receipt.idempotency !== contract.idempotency ||
      receipt.parallelSafe !== contract.parallelSafe ||
      !isDeepStrictEqual(receipt.dependsOn, node.dependsOn ?? [])
    ) {
      fail(`node ${node.nodeId} receipt disagrees with the graph or live contract`);
    }

    let output = null;
    let result = null;

    if (receipt.status === "skipped") {
      if (
        !(BENIGN_SKIPS.has(receipt.reason) ||
          (receipt.reason === APPROVAL_DENIED && category === "capability")) ||
        receipt.result != null ||
        receipt.citationCount !== 0
      ) {
        fail(`node ${node.nodeId} has an ambiguous skipped receipt`);
      }
    } else if (SETTLED.has(receipt.status)) {
      if (receipt.reason != null) {
        fail(`node ${node.nodeId} has a completion reason`);
      }
      result = receipt.result;
      output = checkTypedResult({ nodeId: node.nodeId, result, skill, contract });

      if (receipt.citationCount !== result.citations.length) {
        fail(`node ${node.nodeId} receipt citation count disagrees`);
      }
    } else {
      fail(`node ${node.nodeId} is not successfully settled`);
    }

    const entry = {
      category,
      dependsOn: [...(node.dependsOn ?? [])],
      node,
      nodeId: node.nodeId,
      output,
      reason: receipt.reason ?? null,
      result,
      skillId: skill.id,
      skillVersion: skill.version,
      sourceDocumentNodeId: null,
      status: receipt.status,
      stepId: receipt.stepId,
    };

    entries.push(entry);
    byNodeId.set(node.nodeId, entry);
    groups[receipt.status === "skipped" ? "skipped" : category].push(entry);
  }

  for (const entry of entries) {
    verifySettledDependencies({ entry, byNodeId });

    if (entry.category === "control") {
      verifyDocumentCheck({ entry, byNodeId, graphNodes });
    }
  }

  const successfulResults = entries
    .filter((entry) => SETTLED.has(entry.status))
    .map((entry) => entry.result);

  const deniedActions = entries.filter((entry) => entry.reason === APPROVAL_DENIED);

  if (
    (successfulResults.length === 0 && deniedActions.length === 0) ||
    !isDeepStrictEqual(run.results, successfulResults)
  ) {
    fail("flat run results disagree with successful node receipts");
  }

  return {
    byNodeId,
    entries,
    graphVersion: EXECUTION_GRAPH_VERSIONS.v3,
    groups,
  };
};
