import {
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_REASON_CODES,
  createExecutionGraph,
  validateExecutionGraph,
} from "./agent-execution-graph.js";
import {
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_SKIP_REASONS,
} from "./agent-execution-graph-runner.js";
import { normalizeExecutionGraphNodes } from "./agent-dag-planner-adapter.js";
import {
  SKILL_EFFECTS,
  SKILL_VALUE_TYPES,
  describeSkillsForPlanner,
  getSkillContract,
} from "./skills/skill-contract.js";
import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";

// Bounded local replanning: one patch, re-validated, or an abstention.
//
// A replan is the only moment where a plan changes after the runtime has
// already acted on it, which makes it the natural place to try to reach
// something the first plan was refused. So this module gives the replanner
// strictly less than the planner had: the same redacted capability view, the
// same authorized documents, a status-only summary of what already ran, and a
// patch-shaped answer. Everything else is a refusal with a reason code.
//
// The termination argument is deliberately boring. maxReplans caps the depth,
// the fingerprint set catches a patch that recreates a plan already tried, an
// empty patch counts as no progress, and an exhausted budget stops the loop
// before the model is even asked. A replan that cannot make progress is not
// retried harder; it becomes a clarification or an abstention upstream.

const MAX_RATIONALE_LENGTH = 400;

export const DEFAULT_MAX_REPLANS = 1;

export const REPLAN_TRIGGERS = Object.freeze({
  insufficientEvidence: "insufficient_evidence",
  missingInput: "missing_input",
  outputSchemaFailure: "output_schema_failure",
  retryableFailure: "retryable_failure",
  unmetSuccessCriterion: "unmet_success_criterion",
});

export const REPLAN_DECISIONS = Object.freeze({
  abstain: "abstain",
  applied: "applied",
});

export const REPLAN_REASON_CODES = Object.freeze({
  adapterFailed: "replan_adapter_failed",
  budgetExhausted: "replan_budget_exhausted",
  completedNodeRetired: "replan_completed_node_retired",
  duplicatePlan: "replan_duplicate_plan",
  invalidPatch: "replan_invalid_patch",
  limitReached: "replan_limit_reached",
  noProgress: "replan_no_progress",
  notTriggered: "replan_not_triggered",
  sideEffectNodeRetired: "replan_side_effect_node_retired",
});

const VALID_TRIGGERS = new Set(Object.values(REPLAN_TRIGGERS));

// Skipping for a dependency that never produced an output is a missing input.
// Skipping for an exhausted budget or an aborted run is not -- those are the
// runtime's own limits doing their job, and replanning around them would mean
// spending budget to work around the budget.
const MISSING_INPUT_SKIP_REASONS = new Set([
  EXECUTION_GRAPH_SKIP_REASONS.dependencyFailed,
  EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped,
]);

const SETTLED_OK = new Set([
  EXECUTION_GRAPH_NODE_STATUSES.completed,
  EXECUTION_GRAPH_NODE_STATUSES.reused,
]);

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toArray = (value) => (Array.isArray(value) ? value : []);

const serializeError = (error) =>
  normalizeText(error instanceof Error ? error.message : error).slice(0, 500);

const getContract = (registry, skillId) => {
  const skill = registry?.get?.(normalizeText(skillId)) ?? null;

  return skill ? getSkillContract(skill) : null;
};

const matchesValueType = (value, type) => {
  switch (type) {
    case SKILL_VALUE_TYPES.boolean:
      return typeof value === "boolean";
    case SKILL_VALUE_TYPES.citationArray:
    case SKILL_VALUE_TYPES.stringArray:
      return Array.isArray(value);
    case SKILL_VALUE_TYPES.number:
      return typeof value === "number" && Number.isFinite(value);
    case SKILL_VALUE_TYPES.object:
      return isRecord(value);
    case SKILL_VALUE_TYPES.string:
      return typeof value === "string";
    default:
      // An unrecognized declared type is a contract problem, not a run
      // problem. Do not manufacture a replan trigger out of it.
      return true;
  }
};

/**
 * True when a settled node returned a field its own outputSchema says it does
 * not return.
 *
 * Only fields that are actually present are checked. An absent optional output
 * is not a violation, and an absent required one surfaces as insufficient
 * evidence downstream, which is the more accurate description of what went
 * wrong for the user.
 */
const hasOutputSchemaFailure = ({ contract, run }) => {
  if (!contract || !isRecord(run?.result)) {
    return false;
  }

  return Object.entries(contract.outputSchema ?? {}).some(([field, schema]) => {
    const value = run.result[field];

    return value !== undefined && value !== null && !matchesValueType(value, schema?.type);
  });
};

const producedEvidence = (run) =>
  SETTLED_OK.has(run?.status) &&
  !run?.result?.abstained &&
  Number(run?.citationCount ?? 0) > 0;

/**
 * Names the one thing worth replanning about, most concrete first.
 *
 * The order matters more than it looks: a run can be several kinds of
 * unsatisfying at once, and picking the most specific cause is what makes the
 * next patch targeted instead of a blind second attempt. A broken node beats a
 * malformed output, which beats a starved node, which beats a run that found
 * nothing, which beats a criterion the caller is still waiting on.
 *
 * Returns null when there is nothing to replan, which is the common case and
 * the one that keeps the runtime from spending a model call on a good answer.
 */
export const detectReplanTrigger = ({
  nodeRuns = [],
  registry = null,
  successCriteria = [],
} = {}) => {
  const runs = toArray(nodeRuns);

  if (runs.length === 0) {
    return null;
  }

  const contracts = new Map(
    runs.map((run) => [run?.nodeId, getContract(registry, run?.skillId)])
  );

  const retryableFailure = runs.some(
    (run) =>
      run?.status === EXECUTION_GRAPH_NODE_STATUSES.failed &&
      contracts.get(run?.nodeId)?.retryable === true
  );

  if (retryableFailure) {
    return REPLAN_TRIGGERS.retryableFailure;
  }

  const schemaFailure = runs.some((run) =>
    hasOutputSchemaFailure({ contract: contracts.get(run?.nodeId), run })
  );

  if (schemaFailure) {
    return REPLAN_TRIGGERS.outputSchemaFailure;
  }

  const missingInput = runs.some(
    (run) =>
      run?.status === EXECUTION_GRAPH_NODE_STATUSES.skipped &&
      MISSING_INPUT_SKIP_REASONS.has(run?.reason)
  );

  if (missingInput) {
    return REPLAN_TRIGGERS.missingInput;
  }

  // A node that settled without citing anything is a hole in the answer even
  // when its siblings found plenty: the plan asked for that piece of work and
  // got nothing back for it. Judging the run only by its best node would
  // declare a half-answered question finished.
  const settled = runs.filter((run) => SETTLED_OK.has(run?.status));

  if (settled.length === 0 || !settled.every(producedEvidence)) {
    return REPLAN_TRIGGERS.insufficientEvidence;
  }

  if (toArray(successCriteria).some((criterion) => criterion?.met === false)) {
    return REPLAN_TRIGGERS.unmetSuccessCriterion;
  }

  return null;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce((canonical, key) => {
      canonical[key] = canonicalize(value[key]);

      return canonical;
    }, {});
};

/**
 * A stable identity for "this plan, structurally".
 *
 * Node declaration order and the revision counter are excluded because neither
 * changes what would run: a replan that reorders the same nodes or only bumps
 * the revision has not proposed anything new, and treating it as new is how a
 * bounded loop quietly becomes an unbounded one.
 */
export const fingerprintExecutionGraph = (graph) => {
  const nodes = toArray(graph?.nodes)
    .map(canonicalize)
    .sort((left, right) =>
      String(left?.nodeId ?? "").localeCompare(String(right?.nodeId ?? ""))
    );

  return JSON.stringify({ nodes, version: graph?.version ?? null });
};

/**
 * Applies a patch to a graph and returns a new revision. Pure: the graph it is
 * handed is never mutated, so a rejected patch leaves the running plan intact.
 */
export const applyExecutionGraphPatch = ({ graph, patch } = {}) => {
  const removed = new Set(toArray(patch?.removeNodeIds).map(normalizeText));
  const kept = toArray(graph?.nodes).filter(
    (node) => !removed.has(normalizeText(node?.nodeId))
  );

  return createExecutionGraph({
    nodes: [...kept, ...toArray(patch?.addNodes)],
    revision: Number(graph?.revision ?? 0) + 1,
    version: graph?.version,
  });
};

const normalizeReplanPatch = (patch) => ({
  addNodes: normalizeExecutionGraphNodes(patch?.addNodes),
  rationale: normalizeText(patch?.rationale).slice(0, MAX_RATIONALE_LENGTH) || null,
  removeNodeIds: toArray(patch?.removeNodeIds).map(normalizeText).filter(Boolean),
});

/**
 * The replanner's entire view of the world.
 *
 * Node runs are projected down to status, not content: the replanner decides
 * what to run next, and it can do that from "this node abstained with zero
 * citations" without ever reading the retrieved text. Keeping evidence out of
 * this context is what stops a replanner from drifting into answering the
 * question itself, and it means a prompt injection inside a document cannot
 * reach the component that chooses the next tools.
 */
export const buildReplanContext = ({
  authorizedDocIds = [],
  graph,
  limits = EXECUTION_GRAPH_LIMITS,
  nodeRuns = [],
  question,
  selectedSkills = [],
  trigger = null,
} = {}) => ({
  authorizedDocIds: toArray(authorizedDocIds).map(normalizeText),
  capabilities: describeSkillsForPlanner(selectedSkills),
  goal: normalizeText(question),
  graph: {
    nodes: toArray(graph?.nodes).map((node) => ({
      dependsOn: toArray(node?.dependsOn).map(normalizeText),
      nodeId: normalizeText(node?.nodeId),
      skillId: normalizeText(node?.skillId),
      ...(isRecord(node?.scope) ? { scope: node.scope } : {}),
    })),
    revision: Number(graph?.revision ?? 0),
  },
  limits: {
    maxConcurrency: limits.maxConcurrency,
    maxDepth: limits.maxDepth,
    maxNodes: limits.maxNodes,
  },
  nodeRuns: toArray(nodeRuns).map((run) => ({
    abstained: Boolean(run?.result?.abstained),
    citationCount: Number(run?.citationCount ?? 0),
    nodeId: normalizeText(run?.nodeId),
    reason: run?.reason ?? null,
    skillId: normalizeText(run?.skillId),
    status: normalizeText(run?.status),
  })),
  trigger,
});

export const buildReplannerPrompt = (context = {}) =>
  [
    "A guarded AgentRAG execution graph has already run and did not satisfy the request.",
    "Propose the smallest patch that could change that. Return only JSON.",
    'The JSON shape must be: {"addNodes":[<graph node>],"removeNodeIds":["..."],"rationale":"..."}.',
    "A graph node has the same shape as in the original plan: nodeId, skillId, dependsOn, inputBindings, failurePolicy, rationale.",
    "Nodes that already completed stay in the graph and will not run again. Do not re-add, rename, or remove them.",
    "Every new nodeId must be unique across the whole graph. Use only skillId values listed in capabilities.",
    "You may narrow a node with scope.docIds using ids from authorizedDocIds. You may never widen the scope, add documents, or name a skill that is not listed.",
    "Do not emit approval, budget, accessScope, retry, concurrency, replan, or policy fields. The runtime owns those and will reject a patch that claims them.",
    "You are proposing a plan, not producing an answer, and you cannot call anything yourself.",
    "If no legal patch would help, return an empty addNodes array.",
    "Input:",
    JSON.stringify(context),
  ].join("\n");

const abstain = ({ fingerprints, reason = null, reasonCode, replanCount, trigger }) => ({
  completedNodeRuns: [],
  decision: REPLAN_DECISIONS.abstain,
  errors: [],
  fingerprint: null,
  fingerprints,
  graph: null,
  patch: null,
  reason,
  reasonCode,
  replanCount,
  trigger,
});

const hasSpendableBudget = (budgetRemaining) =>
  !isRecord(budgetRemaining) ||
  Object.values(budgetRemaining).some((value) => Number(value) > 0);

/**
 * Budget demanded by the nodes that have not already been paid for.
 *
 * Completed and reused nodes are excluded on purpose. The validator charges a
 * graph for every node it contains, which is right for a first plan and wrong
 * for a revision, where most of the graph has already run. Charging twice would
 * reject legal replans as over budget; not charging at all would let a patch
 * plan work the runtime cannot fund.
 */
const collectPendingBudgetShortfall = ({ budgetRemaining, graph, registry, settledNodeIds }) => {
  if (!isRecord(budgetRemaining)) {
    return null;
  }

  const demandByBudgetKey = new Map();

  for (const node of toArray(graph?.nodes)) {
    if (settledNodeIds.has(normalizeText(node?.nodeId))) {
      continue;
    }

    const budgetKey = getContract(registry, node?.skillId)?.budgetKey;

    if (!budgetKey) {
      continue;
    }

    demandByBudgetKey.set(budgetKey, (demandByBudgetKey.get(budgetKey) ?? 0) + 1);
  }

  for (const [budgetKey, demand] of demandByBudgetKey) {
    const remaining = budgetRemaining[budgetKey];

    if (Number.isFinite(remaining) && demand > remaining) {
      return `Replan needs ${demand} ${budgetKey} call(s) but only ${remaining} remain.`;
    }
  }

  return null;
};

/**
 * Runs at most one bounded replan and returns a revised graph or an abstention.
 *
 * Never executes a skill and never reserves budget: the caller re-enters the
 * normal runtime with the returned graph, passing completedNodeRuns back so
 * finished work is reused rather than repeated. Every rejection path returns a
 * reason code instead of a graph, so "we gave up" is always traceable to which
 * rule stopped it.
 */
export const createReplanResult = async ({
  authorizedDocIds = [],
  budgetRemaining = null,
  fingerprints = [],
  graph,
  limits = EXECUTION_GRAPH_LIMITS,
  maxReplans = DEFAULT_MAX_REPLANS,
  nodeRuns = [],
  question,
  registry,
  replanAdapter,
  replanCount = 0,
  selectedSkills = [],
  successCriteria = [],
  trigger = null,
} = {}) => {
  const currentFingerprint = fingerprintExecutionGraph(graph);
  const seenFingerprints = [
    ...new Set([...toArray(fingerprints), currentFingerprint]),
  ];
  // A caller cannot raise its own ceiling: maxReplans narrows the default, it
  // never widens it. Anything else would make the bound advisory.
  const effectiveMaxReplans = Math.min(
    Number.isFinite(maxReplans) ? maxReplans : DEFAULT_MAX_REPLANS,
    DEFAULT_MAX_REPLANS
  );
  const activeTrigger = VALID_TRIGGERS.has(trigger)
    ? trigger
    : detectReplanTrigger({ nodeRuns, registry, successCriteria });
  const refuse = (reasonCode, reason = null) =>
    abstain({
      fingerprints: seenFingerprints,
      reason,
      reasonCode,
      replanCount,
      trigger: activeTrigger,
    });

  if (!activeTrigger) {
    return refuse(REPLAN_REASON_CODES.notTriggered);
  }

  if (replanCount >= effectiveMaxReplans) {
    return refuse(REPLAN_REASON_CODES.limitReached);
  }

  if (!hasSpendableBudget(budgetRemaining)) {
    return refuse(REPLAN_REASON_CODES.budgetExhausted, "No skill budget remains.");
  }

  const runsByNodeId = new Map(
    toArray(nodeRuns).map((run) => [normalizeText(run?.nodeId), run])
  );
  const completedNodeRuns = toArray(nodeRuns).filter((run) => SETTLED_OK.has(run?.status));
  const settledNodeIds = new Set(
    completedNodeRuns.map((run) => normalizeText(run?.nodeId))
  );

  const replanContext = buildReplanContext({
    authorizedDocIds,
    graph,
    limits,
    nodeRuns,
    question,
    selectedSkills,
    trigger: activeTrigger,
  });

  let patch = null;

  try {
    patch = normalizeReplanPatch(await replanAdapter.createPatch(replanContext));
  } catch (error) {
    return refuse(REPLAN_REASON_CODES.adapterFailed, serializeError(error));
  }

  if (patch.addNodes.length === 0 && patch.removeNodeIds.length === 0) {
    return refuse(REPLAN_REASON_CODES.noProgress, "Replan proposed no change.");
  }

  for (const nodeId of patch.removeNodeIds) {
    // Retiring finished work would either repeat it or erase it from the
    // trace. A replan may add to the record; it may not rewrite it.
    if (settledNodeIds.has(nodeId)) {
      return refuse(
        REPLAN_REASON_CODES.completedNodeRetired,
        `Node ${nodeId} already completed and cannot be retired by a replan.`
      );
    }

    const effects = getContract(registry, runsByNodeId.get(nodeId)?.skillId)?.effects;

    // A side-effecting node that was attempted may have landed its effect even
    // though it reported failure. Dropping it from the graph would hide that.
    if (runsByNodeId.has(nodeId) && effects && effects !== SKILL_EFFECTS.readOnly) {
      return refuse(
        REPLAN_REASON_CODES.sideEffectNodeRetired,
        `Node ${nodeId} has side effects and cannot be retired by a replan.`
      );
    }
  }

  const revisedGraph = applyExecutionGraphPatch({ graph, patch });
  const revisedFingerprint = fingerprintExecutionGraph(revisedGraph);

  if (seenFingerprints.includes(revisedFingerprint)) {
    return refuse(
      REPLAN_REASON_CODES.duplicatePlan,
      "Replan reproduced a plan that was already tried."
    );
  }

  const validation = validateExecutionGraph({
    authorizedDocIds,
    authorizedSkillIds: selectedSkills.map((skill) => normalizeText(skill?.id)),
    // Budget is checked against pending nodes below rather than here, because
    // the whole-graph check would charge a revision again for work that has
    // already been paid for and completed.
    graph: revisedGraph,
    limits,
    registry,
  });

  if (!validation.ok) {
    return {
      ...refuse(REPLAN_REASON_CODES.invalidPatch),
      errors: validation.errors,
      patch,
    };
  }

  const shortfall = collectPendingBudgetShortfall({
    budgetRemaining,
    graph: validation.graph,
    registry,
    settledNodeIds,
  });

  if (shortfall) {
    return refuse(REPLAN_REASON_CODES.budgetExhausted, shortfall);
  }

  return {
    completedNodeRuns,
    decision: REPLAN_DECISIONS.applied,
    errors: [],
    fingerprint: revisedFingerprint,
    fingerprints: [...seenFingerprints, revisedFingerprint],
    graph: validation.graph,
    patch,
    reason: patch.rationale,
    reasonCode: null,
    replanCount: replanCount + 1,
    trigger: activeTrigger,
  };
};
