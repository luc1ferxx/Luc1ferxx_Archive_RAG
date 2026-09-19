import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";
import {
  EXECUTION_REQUEST_FIELD_TYPES,
  SKILL_EFFECTS,
  getSkillContract,
  isAssignableValueType,
} from "./skills/skill-contract.js";

// Versioned typed DAG for the governed Plan-and-Execute runtime.
//
// This module is a pure function boundary: it never executes a skill, never
// touches the registry beyond a read-only get(), never reads config, and never
// mutates the graph it is handed. Everything it can refuse, it refuses here --
// so an illegal graph is rejected as a whole and no node ever partially runs.

export const EXECUTION_GRAPH_VERSION = "v1";

export const EXECUTION_GRAPH_FAILURE_POLICIES = Object.freeze({
  abstain: "abstain",
  continue: "continue",
  failFast: "fail_fast",
});

export const EXECUTION_GRAPH_LIMITS = Object.freeze({
  maxConcurrency: 3,
  maxDepth: 5,
  maxNodes: 12,
});

export const EXECUTION_GRAPH_REASON_CODES = Object.freeze({
  budgetExceeded: "budget_exceeded",
  cycleDetected: "cycle_detected",
  danglingDependency: "dangling_dependency",
  duplicateNodeId: "duplicate_node_id",
  emptyGraph: "empty_graph",
  forgedApproval: "forged_approval",
  forgedPolicy: "forged_policy",
  illegalOutputReference: "illegal_output_reference",
  inputTypeMismatch: "input_type_mismatch",
  invalidGraphVersion: "invalid_graph_version",
  invalidNodeShape: "invalid_node_shape",
  maxDepthExceeded: "max_depth_exceeded",
  maxNodesExceeded: "max_nodes_exceeded",
  missingRequiredInput: "missing_required_input",
  outOfScopeDocument: "out_of_scope_document",
  selfDependency: "self_dependency",
  unregisteredCapability: "unregistered_capability",
  unsafeParallelSideEffect: "unsafe_parallel_side_effect",
});

export const EXECUTION_GRAPH_BINDING_SOURCES = Object.freeze({
  node: "node",
  request: "request",
});

// Runtime-owned fields. A planner-authored node that carries any of these is
// trying to grant itself something the runtime alone decides, so the graph is
// rejected rather than sanitized -- silently stripping them would teach the
// planner that asking is free.
const FORGED_APPROVAL_FIELDS = Object.freeze(["approval", "approvalGateId", "approvedGate"]);
const FORGED_POLICY_FIELDS = Object.freeze([
  "accessScope",
  "budget",
  "budgetKey",
  "concurrency",
  "docIds",
  "maxReplans",
  "policy",
  "requiresAccessScope",
  "requiresApproval",
  "retryLimit",
  "secrets",
  "workspaceId",
]);

const VALID_FAILURE_POLICIES = new Set(Object.values(EXECUTION_GRAPH_FAILURE_POLICIES));

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toArray = (value) => (Array.isArray(value) ? value : []);

export const createExecutionGraph = ({
  nodes = [],
  revision = 0,
  version = EXECUTION_GRAPH_VERSION,
} = {}) => ({
  nodes: toArray(nodes),
  revision,
  version,
});

const buildError = ({ code, message, nodeId = null }) => ({
  code,
  message,
  nodeId,
});

const normalizeNodeId = (node) => normalizeText(node?.nodeId);

const collectNodeShapeErrors = ({ index, node }) => {
  const errors = [];
  const nodeId = normalizeNodeId(node);
  const label = nodeId || `index ${index}`;

  if (!isRecord(node)) {
    return [
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
        message: `Graph node at index ${index} must be an object.`,
        nodeId: null,
      }),
    ];
  }

  if (!nodeId) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
        message: `Graph node at index ${index} requires a non-empty nodeId.`,
      })
    );
  }

  if (!normalizeText(node.skillId)) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
        message: `Node ${label} requires a non-empty skillId.`,
        nodeId: nodeId || null,
      })
    );
  }

  if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
        message: `Node ${label} dependsOn must be an array.`,
        nodeId: nodeId || null,
      })
    );
  }

  if (!isRecord(node.inputBindings)) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
        message: `Node ${label} requires an inputBindings object.`,
        nodeId: nodeId || null,
      })
    );
  }

  if (!VALID_FAILURE_POLICIES.has(node.failurePolicy)) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
        message: `Node ${label} failurePolicy must be one of ${[
          ...VALID_FAILURE_POLICIES,
        ].join(", ")}.`,
        nodeId: nodeId || null,
      })
    );
  }

  return errors;
};

const collectForgedFieldErrors = (node) => {
  const nodeId = normalizeNodeId(node);
  const errors = [];

  for (const field of FORGED_APPROVAL_FIELDS) {
    if (node[field] !== undefined) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.forgedApproval,
          message: `Node ${nodeId} may not declare ${field}; approvals are issued by the runtime.`,
          nodeId,
        })
      );
    }
  }

  for (const field of FORGED_POLICY_FIELDS) {
    if (node[field] !== undefined) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.forgedPolicy,
          message: `Node ${nodeId} may not declare ${field}; it is runtime-owned policy.`,
          nodeId,
        })
      );
    }
  }

  return errors;
};

const collectScopeErrors = ({ authorizedDocIds, node }) => {
  if (node.scope === undefined) {
    return [];
  }

  const nodeId = normalizeNodeId(node);

  if (!isRecord(node.scope)) {
    return [
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.forgedPolicy,
        message: `Node ${nodeId} scope must be an object.`,
        nodeId,
      }),
    ];
  }

  const errors = [];
  const extraKeys = Object.keys(node.scope).filter((key) => key !== "docIds");

  if (extraKeys.length > 0) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.forgedPolicy,
        message: `Node ${nodeId} scope may only narrow docIds, received ${extraKeys.join(", ")}.`,
        nodeId,
      })
    );
  }

  const authorized = new Set(toArray(authorizedDocIds).map(normalizeText));
  const outOfScope = toArray(node.scope.docIds)
    .map(normalizeText)
    .filter((docId) => !authorized.has(docId));

  if (outOfScope.length > 0) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument,
        message: `Node ${nodeId} references documents outside the authorized scope: ${outOfScope.join(", ")}.`,
        nodeId,
      })
    );
  }

  return errors;
};

const collectDependencyErrors = ({ knownNodeIds, node }) => {
  const nodeId = normalizeNodeId(node);
  const errors = [];

  for (const dependency of toArray(node.dependsOn)) {
    const dependencyId = normalizeText(dependency);

    if (dependencyId && dependencyId === nodeId) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.selfDependency,
          message: `Node ${nodeId} cannot depend on itself.`,
          nodeId,
        })
      );
      continue;
    }

    if (!knownNodeIds.has(dependencyId)) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.danglingDependency,
          message: `Node ${nodeId} depends on unknown node ${dependencyId || "(empty)"}.`,
          nodeId,
        })
      );
    }
  }

  return errors;
};

const collectBindingErrors = ({ contract, node, skillContractsByNodeId }) => {
  const nodeId = normalizeNodeId(node);
  const errors = [];
  const bindings = isRecord(node.inputBindings) ? node.inputBindings : {};
  const dependencies = new Set(toArray(node.dependsOn).map(normalizeText));

  for (const [field, binding] of Object.entries(bindings)) {
    const targetField = contract.inputSchema[field];

    if (!targetField) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.illegalOutputReference,
          message: `Node ${nodeId} binds unknown input field ${field} for skill ${contract.id}.`,
          nodeId,
        })
      );
      continue;
    }

    if (!isRecord(binding)) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.illegalOutputReference,
          message: `Node ${nodeId} input ${field} must bind to a request field or an upstream node output.`,
          nodeId,
        })
      );
      continue;
    }

    const source = normalizeText(binding.source);

    if (source === EXECUTION_GRAPH_BINDING_SOURCES.request) {
      const requestField = normalizeText(binding.field);
      const requestType = EXECUTION_REQUEST_FIELD_TYPES[requestField];

      if (!requestType) {
        errors.push(
          buildError({
            code: EXECUTION_GRAPH_REASON_CODES.illegalOutputReference,
            message: `Node ${nodeId} input ${field} binds unknown request field ${requestField || "(empty)"}.`,
            nodeId,
          })
        );
        continue;
      }

      if (!isAssignableValueType(requestType, targetField.type)) {
        errors.push(
          buildError({
            code: EXECUTION_GRAPH_REASON_CODES.inputTypeMismatch,
            message: `Node ${nodeId} input ${field} expects ${targetField.type} but request field ${requestField} is ${requestType}.`,
            nodeId,
          })
        );
      }

      continue;
    }

    if (source !== EXECUTION_GRAPH_BINDING_SOURCES.node) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.illegalOutputReference,
          message: `Node ${nodeId} input ${field} uses unsupported binding source ${source || "(empty)"}; only request fields and upstream node outputs are allowed.`,
          nodeId,
        })
      );
      continue;
    }

    const sourceNodeId = normalizeText(binding.nodeId);

    if (!dependencies.has(sourceNodeId)) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.illegalOutputReference,
          message: `Node ${nodeId} input ${field} references node ${sourceNodeId || "(empty)"} that is not in dependsOn.`,
          nodeId,
        })
      );
      continue;
    }

    const sourceContract = skillContractsByNodeId.get(sourceNodeId);

    if (!sourceContract) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.illegalOutputReference,
          message: `Node ${nodeId} input ${field} references node ${sourceNodeId} with no resolvable skill contract.`,
          nodeId,
        })
      );
      continue;
    }

    const outputField = normalizeText(binding.output);
    const sourceOutput = sourceContract.outputSchema[outputField];

    if (!sourceOutput) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.illegalOutputReference,
          message: `Node ${nodeId} input ${field} references output ${outputField || "(empty)"} that node ${sourceNodeId} does not declare.`,
          nodeId,
        })
      );
      continue;
    }

    if (!isAssignableValueType(sourceOutput.type, targetField.type)) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.inputTypeMismatch,
          message: `Node ${nodeId} input ${field} expects ${targetField.type} but ${sourceNodeId}.${outputField} is ${sourceOutput.type}.`,
          nodeId,
        })
      );
    }
  }

  for (const [field, schema] of Object.entries(contract.inputSchema)) {
    if (schema.required && bindings[field] === undefined) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.missingRequiredInput,
          message: `Node ${nodeId} is missing required input ${field} for skill ${contract.id}.`,
          nodeId,
        })
      );
    }
  }

  return errors;
};

const collectBudgetErrors = ({ budgetRemaining, nodes, skillContractsByNodeId }) => {
  if (!isRecord(budgetRemaining)) {
    return [];
  }

  const demandByBudgetKey = new Map();

  for (const node of nodes) {
    const contract = skillContractsByNodeId.get(normalizeNodeId(node));

    if (!contract?.budgetKey) {
      continue;
    }

    demandByBudgetKey.set(
      contract.budgetKey,
      (demandByBudgetKey.get(contract.budgetKey) ?? 0) + 1
    );
  }

  return [...demandByBudgetKey.entries()]
    .filter(([budgetKey, demand]) => {
      const remaining = budgetRemaining[budgetKey];

      return Number.isFinite(remaining) && demand > remaining;
    })
    .map(([budgetKey, demand]) =>
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.budgetExceeded,
        message: `Graph needs ${demand} ${budgetKey} call(s) but only ${budgetRemaining[budgetKey]} remain.`,
        nodeId: null,
      })
    );
};

// Kahn's algorithm with declaration-order tie-breaking, so the same graph
// always compiles to the same layers and the same order. Nodes left over
// carry a cycle.
const topologicallyLayer = (nodes) => {
  const order = nodes.map(normalizeNodeId);
  const indegree = new Map(order.map((nodeId) => [nodeId, 0]));
  const dependents = new Map(order.map((nodeId) => [nodeId, []]));

  for (const node of nodes) {
    const nodeId = normalizeNodeId(node);

    for (const dependency of toArray(node.dependsOn).map(normalizeText)) {
      if (!dependents.has(dependency) || dependency === nodeId) {
        continue;
      }

      dependents.get(dependency).push(nodeId);
      indegree.set(nodeId, (indegree.get(nodeId) ?? 0) + 1);
    }
  }

  const layers = [];
  const settled = new Set();
  let frontier = order.filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0);

  while (frontier.length > 0) {
    layers.push([...frontier]);
    frontier.forEach((nodeId) => settled.add(nodeId));

    const next = [];

    for (const nodeId of frontier) {
      for (const dependent of dependents.get(nodeId) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);

        if (remaining === 0) {
          next.push(dependent);
        }
      }
    }

    // Re-sort by declaration order rather than discovery order.
    frontier = order.filter((nodeId) => next.includes(nodeId));
  }

  return {
    hasCycle: settled.size !== order.length,
    layers,
    unsettled: order.filter((nodeId) => !settled.has(nodeId)),
  };
};

/**
 * Validates a graph against the registry, the caller's authorized scope, and
 * the runtime limits. Pure: returns a report, never throws for planner error,
 * never mutates the input.
 */
export const validateExecutionGraph = ({
  authorizedDocIds = [],
  authorizedSkillIds = null,
  budgetRemaining = null,
  graph,
  limits = EXECUTION_GRAPH_LIMITS,
  registry,
} = {}) => {
  const errors = [];
  const effectiveLimits = { ...EXECUTION_GRAPH_LIMITS, ...limits };

  if (!isRecord(graph)) {
    return {
      errors: [
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
          message: "Execution graph must be an object.",
        }),
      ],
      graph: null,
      ok: false,
    };
  }

  if (normalizeText(graph.version) !== EXECUTION_GRAPH_VERSION) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.invalidGraphVersion,
        message: `Execution graph version must be ${EXECUTION_GRAPH_VERSION}, received ${normalizeText(graph.version) || "(empty)"}.`,
      })
    );
  }

  const nodes = toArray(graph.nodes);

  if (nodes.length === 0) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.emptyGraph,
        message: "Execution graph must contain at least one node.",
      })
    );

    return { errors, graph: null, ok: false };
  }

  if (nodes.length > effectiveLimits.maxNodes) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.maxNodesExceeded,
        message: `Execution graph has ${nodes.length} nodes, above the limit of ${effectiveLimits.maxNodes}.`,
      })
    );
  }

  const shapeErrors = nodes.flatMap((node, index) =>
    collectNodeShapeErrors({ index, node })
  );
  errors.push(...shapeErrors);

  if (shapeErrors.length > 0) {
    return { errors, graph: null, ok: false };
  }

  const knownNodeIds = new Set(nodes.map(normalizeNodeId));
  const whitelist = Array.isArray(authorizedSkillIds)
    ? new Set(authorizedSkillIds.map(normalizeText))
    : null;
  const skillContractsByNodeId = new Map();
  const seenNodeIds = new Set();

  for (const node of nodes) {
    const nodeId = normalizeNodeId(node);
    const skillId = normalizeText(node.skillId);
    const skill = registry?.get?.(skillId) ?? null;
    const authorized = Boolean(skill) && (!whitelist || whitelist.has(skillId));

    if (authorized && !skillContractsByNodeId.has(nodeId)) {
      skillContractsByNodeId.set(nodeId, getSkillContract(skill));
    }
  }

  for (const node of nodes) {
    const nodeId = normalizeNodeId(node);
    const skillId = normalizeText(node.skillId);
    const skill = registry?.get?.(skillId) ?? null;

    if (!skill || (whitelist && !whitelist.has(skillId))) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.unregisteredCapability,
          message: `Node ${nodeId} references skill ${skillId} that is not registered and authorized for this request.`,
          nodeId,
        })
      );
    }

    if (seenNodeIds.has(nodeId)) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.duplicateNodeId,
          message: `Duplicate nodeId ${nodeId}.`,
          nodeId,
        })
      );
    }
    seenNodeIds.add(nodeId);

    errors.push(...collectForgedFieldErrors(node));
    errors.push(...collectScopeErrors({ authorizedDocIds, node }));
    errors.push(...collectDependencyErrors({ knownNodeIds, node }));

    const contract = skillContractsByNodeId.get(nodeId);

    if (!contract) {
      continue;
    }

    if (node.parallelSafe === true && contract.effects !== SKILL_EFFECTS.readOnly) {
      errors.push(
        buildError({
          code: EXECUTION_GRAPH_REASON_CODES.unsafeParallelSideEffect,
          message: `Node ${nodeId} declares parallelSafe but skill ${skillId} has ${contract.effects} effects.`,
          nodeId,
        })
      );
    }

    errors.push(
      ...collectBindingErrors({ contract, node, skillContractsByNodeId })
    );
  }

  errors.push(
    ...collectBudgetErrors({ budgetRemaining, nodes, skillContractsByNodeId })
  );

  // Kahn's algorithm keys on nodeId, so a duplicated id collapses two nodes
  // into one entry and leaves a leftover that is indistinguishable from a
  // cycle. The duplicate is already reported above; adding a cycle that does
  // not exist would send whoever reads the trace looking for the wrong bug.
  const hasDuplicateNodeIds = seenNodeIds.size !== nodes.length;
  const { hasCycle, layers, unsettled } = hasDuplicateNodeIds
    ? { hasCycle: false, layers: [], unsettled: [] }
    : topologicallyLayer(nodes);

  if (hasCycle) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.cycleDetected,
        message: `Execution graph contains a dependency cycle involving: ${unsettled.join(", ")}.`,
      })
    );
  } else if (layers.length > effectiveLimits.maxDepth) {
    errors.push(
      buildError({
        code: EXECUTION_GRAPH_REASON_CODES.maxDepthExceeded,
        message: `Execution graph depth ${layers.length} is above the limit of ${effectiveLimits.maxDepth}.`,
      })
    );
  }

  return {
    errors,
    graph: errors.length === 0 ? graph : null,
    ok: errors.length === 0,
  };
};

/**
 * Validates then lowers the graph into deterministic execution layers. Returns
 * layers: null when the graph is illegal, so a caller cannot accidentally
 * schedule a partially-valid graph.
 */
export const compileExecutionGraph = (options = {}) => {
  const validation = validateExecutionGraph(options);

  if (!validation.ok) {
    return {
      depth: 0,
      errors: validation.errors,
      layers: null,
      ok: false,
      order: null,
    };
  }

  const { layers } = topologicallyLayer(toArray(options.graph.nodes));

  return {
    depth: layers.length,
    errors: [],
    layers,
    ok: true,
    order: layers.flat(),
  };
};

export const getExecutionGraphNode = (graph, nodeId) =>
  toArray(graph?.nodes).find((node) => normalizeNodeId(node) === normalizeText(nodeId)) ??
  null;
