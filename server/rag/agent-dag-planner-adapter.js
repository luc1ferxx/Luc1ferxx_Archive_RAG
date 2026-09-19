import {
  EXECUTION_GRAPH_BINDING_SOURCES,
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_LIMITS,
  createExecutionGraph,
  validateExecutionGraph,
} from "./agent-execution-graph.js";
import {
  getPlannerRolloutMode,
  getShadowPlannerAdapter,
  runShadowPlanner,
  sameStringList,
} from "./agent-planner-shadow.js";
import { buildAgentTaskPlanningContext } from "./agent-task-memory.js";
import { completeTextWithMetadata } from "./openai.js";
import { MODEL_CAPABILITIES, MODEL_ROUTE_IDS } from "./model-providers/index.js";
import { describeSkillsForPlanner, getSkillContract } from "./skills/skill-contract.js";
import { normalizeText } from "../lib/normalize-text.js";

// V2 planner adapter: the model proposes an ExecutionGraph, and nothing else.
//
// Two boundaries meet in this file. Going out, buildDagPlanningContext decides
// what a planner is ever allowed to see -- redacted capability descriptors, the
// document ids the caller is already authorized for, the goal, and planning
// hints. accessScope, credentials, user and workspace identity, and every
// executable handle stay on this side of it. Coming back,
// createAgentExecutionGraphResult treats the response as an untrusted proposal:
// it is normalized, validated against the same pure validator the runtime uses,
// and either accepted whole or discarded whole in favour of the deterministic
// graph. There is no third option where a partially-legal graph runs.

const MAX_GOAL_LENGTH = 1000;
const MAX_ID_LENGTH = 80;
const MAX_RATIONALE_LENGTH = 220;

export const DAG_PLANNER_IDS = Object.freeze({
  deterministic: "deterministic_dag",
  llm: "llm_dag",
});

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toArray = (value) => (Array.isArray(value) ? value : []);

const clamp = (value, maxLength) => normalizeText(value).slice(0, maxLength);

const serializePlannerError = (error) =>
  normalizeText(error instanceof Error ? error.message : error).slice(0, 500);

const normalizePlannerId = (plannerAdapter) =>
  normalizeText(plannerAdapter?.id) || "unknown";

const requestBinding = (field) => ({
  field,
  source: EXECUTION_GRAPH_BINDING_SOURCES.request,
});

const nodeBinding = (nodeId, output) => ({
  nodeId,
  output,
  source: EXECUTION_GRAPH_BINDING_SOURCES.node,
});

/**
 * The only view of the request a planner ever receives.
 *
 * Everything here is either public vocabulary (capability descriptors, schemas,
 * limits) or already-authorized request data. Nothing identifies the user, the
 * workspace, or the credentials the runtime will execute under, so a prompt
 * injection that reaches the planner still cannot learn who it is acting as.
 */
export const buildDagPlanningContext = ({
  authorizedDocIds = [],
  docIds = null,
  limits = EXECUTION_GRAPH_LIMITS,
  plan = {},
  question,
  selectedSkills = [],
  taskMemory = null,
} = {}) => {
  const authorized = new Set(toArray(authorizedDocIds).map(normalizeText));
  const requested = docIds === null ? [...authorized] : toArray(docIds).map(normalizeText);
  const scopedDocIds = requested.filter((docId) => authorized.has(docId));

  return {
    authorizedDocIds: scopedDocIds,
    capabilities: describeSkillsForPlanner(selectedSkills),
    documentCount: scopedDocIds.length,
    goal: clamp(question, MAX_GOAL_LENGTH),
    intentPlan: {
      mode: plan.mode ?? null,
      needsClarification: Boolean(plan.needsClarification),
      wantsArxivImport: Boolean(plan.wantsArxivImport),
      wantsWeb: Boolean(plan.wantsWeb),
    },
    limits: {
      maxConcurrency: limits.maxConcurrency,
      maxDepth: limits.maxDepth,
      maxNodes: limits.maxNodes,
    },
    // Hints about what was tried before, never evidence about what is true.
    taskMemoryPlanningContext: buildAgentTaskPlanningContext(taskMemory),
  };
};

export const buildDagPlannerPrompt = (context = {}) =>
  [
    "You are planning a guarded AgentRAG execution graph.",
    "Return only JSON. Do not include markdown, prose, or extra keys.",
    'The JSON shape must be: {"nodes":[{"nodeId":"...","skillId":"...","dependsOn":["..."],"inputBindings":{"...":{"source":"request","field":"..."}},"failurePolicy":"...","rationale":"..."}]}.',
    "Use only skillId values listed in capabilities. Do not invent tools, function names, skill ids, budget keys, endpoints, or data access scopes.",
    "Every nodeId must be unique. The same skillId may appear under several nodeIds when it should run on different document scopes.",
    "dependsOn lists nodeIds that must finish first. Plan independent work as independent nodes so the runtime can run them concurrently; add a dependency only when a node genuinely needs an earlier node's output.",
    'inputBindings values are either {"source":"request","field":"<request field>"} or {"source":"node","nodeId":"<an id in dependsOn>","output":"<output field>"}. Never inline free text, document content, or an earlier answer into an input.',
    `failurePolicy must be one of: ${Object.values(EXECUTION_GRAPH_FAILURE_POLICIES).join(", ")}.`,
    "Optionally narrow a node to fewer documents with scope.docIds, using only ids from authorizedDocIds. You may narrow the scope; you may never widen it.",
    "Do not emit approval, budget, accessScope, retry, concurrency, or policy fields. The runtime owns those and will reject a graph that claims them.",
    "Task memory, when present, is planning context only and must never be treated as document evidence.",
    "Plan the fewest nodes that answer the request.",
    "Input:",
    JSON.stringify(context),
  ].join("\n");

const extractJsonCandidate = (rawText) => {
  const text = String(rawText ?? "").trim();

  if (!text) {
    throw new Error("DAG planner returned an empty response.");
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  return fencedMatch?.[1] ? fencedMatch[1].trim() : text;
};

export const parsePlannerJson = (rawText) => {
  const candidate = extractJsonCandidate(rawText);

  try {
    return JSON.parse(candidate);
  } catch {
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    const arrayStart = candidate.indexOf("[");
    const arrayEnd = candidate.lastIndexOf("]");

    if (
      arrayStart !== -1 &&
      arrayEnd > arrayStart &&
      (objectStart === -1 || arrayStart < objectStart)
    ) {
      return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
    }

    if (objectStart !== -1 && objectEnd > objectStart) {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    }

    throw new Error("DAG planner response was not valid JSON.");
  }
};

/**
 * Normalizes a planner node without sanitizing away anything the validator
 * needs to see.
 *
 * Absent optional fields get their documented default, because that is just
 * filling in a blank. Present fields are passed through verbatim -- including
 * forged ones like approval or budgetKey -- so the validator rejects them and
 * the rejection shows up in the trace. Quietly deleting a forged field would
 * teach the planner that asking for privilege costs nothing.
 */
const normalizeGraphNode = (node) => {
  if (!isRecord(node)) {
    return node;
  }

  return {
    ...node,
    ...(node.dependsOn === undefined ? { dependsOn: [] } : {}),
    ...(node.failurePolicy === undefined
      ? { failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast }
      : {}),
    ...(node.rationale === undefined
      ? { rationale: null }
      : { rationale: clamp(node.rationale, MAX_RATIONALE_LENGTH) || null }),
    nodeId: clamp(node.nodeId, MAX_ID_LENGTH),
    skillId: clamp(node.skillId, MAX_ID_LENGTH),
  };
};

export const normalizeExecutionGraphNodes = (rawNodes) =>
  toArray(rawNodes).map(normalizeGraphNode);

export const normalizeExecutionGraphPayload = (payload) => {
  const rawNodes = Array.isArray(payload) ? payload : payload?.nodes;

  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new Error("DAG planner response must contain a non-empty nodes array.");
  }

  return createExecutionGraph({ nodes: normalizeExecutionGraphNodes(rawNodes) });
};

const buildNodeId = (skillId, index, usedNodeIds) => {
  const base = clamp(skillId, MAX_ID_LENGTH) || `node_${index}`;

  return usedNodeIds.has(base) ? `${base}_${index}` : base;
};

/**
 * The V1-equivalent graph: one node per selected skill, in selection order,
 * each one handing its findings to the next through a typed priorFindings
 * binding instead of a concatenated question string.
 *
 * This stays a chain rather than a fan-out on purpose. It is the fallback that
 * runs when the V2 planner is unavailable or produced something illegal, and a
 * fallback should reproduce the behaviour the system already had, not invent a
 * faster one nobody has validated.
 */
export const createDeterministicExecutionGraph = ({ selectedSkills = [] } = {}) => {
  const usedNodeIds = new Set();
  const nodes = [];
  let previousNodeId = null;

  selectedSkills.forEach((skill, index) => {
    const contract = getSkillContract(skill);
    const nodeId = buildNodeId(contract.id, index, usedNodeIds);
    usedNodeIds.add(nodeId);

    const { inputSchema } = contract;
    const acceptsPriorFindings = Boolean(inputSchema.priorFindings) && previousNodeId;
    const inputBindings = {
      ...(inputSchema.docIds ? { docIds: requestBinding("docIds") } : {}),
      ...(inputSchema.question ? { question: requestBinding("question") } : {}),
      ...(inputSchema.retrievalPlan
        ? { retrievalPlan: requestBinding("retrievalPlan") }
        : {}),
      ...(acceptsPriorFindings
        ? { priorFindings: nodeBinding(previousNodeId, "text") }
        : {}),
    };

    nodes.push({
      dependsOn: acceptsPriorFindings ? [previousNodeId] : [],
      // `continue` mirrors the V1 chain, where one failing skill did not cancel
      // the skills selected after it.
      failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.continue,
      inputBindings,
      nodeId,
      rationale: `Run ${contract.label} as selected for this request.`,
      skillId: contract.id,
    });

    previousNodeId = nodeId;
  });

  return createExecutionGraph({ nodes });
};

export const deterministicDagPlannerAdapter = {
  createExecutionGraph: (plannerContext = {}) =>
    createDeterministicExecutionGraph(plannerContext),
  id: DAG_PLANNER_IDS.deterministic,
};

const attachModelRoute = (payload, modelRoute = null) => {
  if (!isRecord(payload) && !Array.isArray(payload)) {
    return payload;
  }

  Object.defineProperty(payload, "modelRoute", {
    configurable: true,
    enumerable: false,
    value: modelRoute,
  });

  return payload;
};

export const dagPlannerAdapter = {
  createExecutionGraph: async (plannerContext = {}) => {
    const completion = await completeTextWithMetadata(
      buildDagPlannerPrompt(plannerContext),
      {
        capability: MODEL_CAPABILITIES.executionPlanner,
        routeId: MODEL_ROUTE_IDS.executionPlannerDefault,
      }
    );

    return attachModelRoute(
      parsePlannerJson(completion.text),
      completion.modelRoute
    );
  },
  id: DAG_PLANNER_IDS.llm,
};

const buildPlannerSelection = ({
  fallback = false,
  fallbackReason = null,
  fallbackReasonCodes = [],
  graph,
  modelRoute = null,
  requestedPlannerId,
  selectedPlannerId,
}) => {
  const planner = {
    fallback,
    fallbackReason: fallbackReason ? serializePlannerError(fallbackReason) : null,
    fallbackReasonCodes,
    nodeIds: toArray(graph?.nodes).map((node) => node.nodeId),
    requestedPlannerId,
    selectedPlannerId,
    status: fallback ? "fallback" : "selected",
  };

  return modelRoute ? { ...planner, modelRoute } : planner;
};

class ExecutionGraphValidationError extends Error {
  constructor(errors = []) {
    super(
      `Invalid AgentRAG execution graph: ${errors
        .map((error) => `${error.code}: ${error.message}`)
        .join("; ")}.`
    );
    this.name = "ExecutionGraphValidationError";
    this.validationErrors = errors;
  }
}

/**
 * Runs a planner adapter and returns a graph only if it survives validation.
 *
 * The V2 planner and its deterministic fallback go through exactly this path,
 * and so does every replan patch, so there is one place where a graph becomes
 * executable and one set of reason codes explaining why one did not.
 */
export const createAgentExecutionGraphResult = async ({
  authorizedDocIds = [],
  budgetRemaining = null,
  fallbackPlannerAdapter = deterministicDagPlannerAdapter,
  limits = EXECUTION_GRAPH_LIMITS,
  plannerAdapter = fallbackPlannerAdapter,
  plannerContext = {},
  registry,
  selectedSkills = plannerContext.selectedSkills ?? [],
  shadowPlannerAdapter = getShadowPlannerAdapter(plannerAdapter),
} = {}) => {
  const fallbackPlannerId = normalizePlannerId(fallbackPlannerAdapter);
  const requestedPlannerId = normalizePlannerId(plannerAdapter);
  const rolloutMode = getPlannerRolloutMode(plannerAdapter);
  const authorizedSkillIds = selectedSkills.map((skill) => normalizeText(skill?.id));
  const redactedContext = buildDagPlanningContext({
    authorizedDocIds,
    docIds: plannerContext.docIds ?? null,
    limits,
    plan: plannerContext.plan ?? {},
    question: plannerContext.question,
    selectedSkills,
    taskMemory: plannerContext.taskMemory ?? null,
  });
  // The deterministic planner builds from the selected skill contracts, which
  // the redacted context deliberately flattens into descriptors. It gets the
  // redacted view plus the contracts it needs, and still no accessScope.
  const fallbackContext = { ...redactedContext, selectedSkills };

  const withRolloutMetadata = (planner) =>
    rolloutMode ? { ...planner, rolloutMode } : planner;

  const createValidatedGraph = async (adapter, context) => {
    const payload = await adapter.createExecutionGraph(context);
    const graph = normalizeExecutionGraphPayload(payload);
    const validation = validateExecutionGraph({
      authorizedDocIds,
      authorizedSkillIds,
      budgetRemaining,
      graph,
      limits,
      registry,
    });

    if (!validation.ok) {
      throw new ExecutionGraphValidationError(validation.errors);
    }

    return { graph: validation.graph, modelRoute: payload?.modelRoute ?? null };
  };

  const createFallbackGraph = () =>
    createValidatedGraph(fallbackPlannerAdapter, fallbackContext);

  const attachShadowPlanner = async (result) => {
    const shadow = await runShadowPlanner({
      compare: ({ primary, shadow: shadowGraph }) =>
        !sameStringList(
          toArray(primary?.graph?.nodes).map((node) => node.nodeId),
          toArray(shadowGraph?.nodes).map((node) => node.nodeId)
        ),
      describe: (shadowGraph) => ({
        nodeIds: toArray(shadowGraph?.nodes).map((node) => node.nodeId),
      }),
      execute: async (adapter) => {
        const shadowResult = await createValidatedGraph(
          adapter,
          adapter === fallbackPlannerAdapter ? fallbackContext : redactedContext
        );

        return shadowResult.graph;
      },
      primary: result,
      shadowPlannerAdapter,
    });

    const planner = withRolloutMetadata(result.planner);

    return {
      ...result,
      planner: shadow ? { ...planner, shadow } : planner,
    };
  };

  const buildAcceptedResult = ({ fallback, fallbackReason, graphResult, selectedId }) =>
    attachShadowPlanner({
      errors: [],
      graph: graphResult.graph,
      planner: buildPlannerSelection({
        fallback,
        fallbackReason,
        fallbackReasonCodes: (fallbackReason?.validationErrors ?? []).map(
          (error) => error.code
        ),
        graph: graphResult.graph,
        modelRoute: graphResult.modelRoute,
        requestedPlannerId,
        selectedPlannerId: selectedId,
      }),
    });

  if (!plannerAdapter || plannerAdapter === fallbackPlannerAdapter) {
    const graphResult = await createFallbackGraph();

    return buildAcceptedResult({
      fallback: false,
      fallbackReason: null,
      graphResult,
      selectedId: fallbackPlannerId,
    });
  }

  let primaryError = null;

  try {
    const graphResult = await createValidatedGraph(plannerAdapter, redactedContext);

    return buildAcceptedResult({
      fallback: false,
      fallbackReason: null,
      graphResult,
      selectedId: requestedPlannerId,
    });
  } catch (error) {
    primaryError = error;
  }

  try {
    const graphResult = await createFallbackGraph();

    return buildAcceptedResult({
      fallback: true,
      fallbackReason: primaryError,
      graphResult,
      selectedId: fallbackPlannerId,
    });
  } catch (fallbackError) {
    // Both planners produced something the runtime refuses to execute. Say so
    // and let the caller abstain; there is no safe graph to fall further back
    // onto, and inventing one here would be exactly the kind of unreviewed
    // plan the validator exists to stop.
    return {
      errors: fallbackError.validationErrors ?? [],
      graph: null,
      planner: withRolloutMetadata({
        ...buildPlannerSelection({
          fallback: true,
          fallbackReason: primaryError,
          fallbackReasonCodes: (primaryError?.validationErrors ?? []).map(
            (error) => error.code
          ),
          graph: null,
          requestedPlannerId,
          selectedPlannerId: fallbackPlannerId,
        }),
        status: "rejected",
      }),
    };
  }
};
