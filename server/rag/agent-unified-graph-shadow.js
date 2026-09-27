import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";
import { getShadowPlannerAdapter } from "./agent-planner-shadow.js";
import { createUnifiedAgentExecutionGraphResult } from "./agent-unified-dag-planner.js";

const noop = () => {};

/**
 * Observe an all-stage proposal without executing a graph node. The event is
 * deliberately smaller than the proposal: request text, document ids, bound
 * values, and executable catalog entries never become an observability copy.
 * A shadow failure must not change the V1 answer path.
 *
 * The event describes the observed planner's own outcome. When the planning
 * rollout carries a shadow planner (AGENT_PLANNER_ROLLOUT=shadow: the model
 * beside the deterministic primary) that model is the one observed, and no
 * planner fallback applies here: a model proposal that fails to parse,
 * validate, or pass admission is recorded as `rejected` with its reason codes,
 * never replaced by the deterministic graph and counted as a model success.
 * The planning call is awaited on the request path (a model plan adds its
 * latency to shadow requests).
 */
export const observeUnifiedAgentGraphShadow = async ({
  accessScope,
  addTraceStep = noop,
  allowedCapabilityIds = [],
  budgetState,
  capabilityRegistry,
  docIds,
  plan,
  plannerAdapter,
  question,
  ragService,
  record = noop,
  registry,
  taskMemory,
} = {}) => {
  let event;
  const observedAdapter = getShadowPlannerAdapter(plannerAdapter) ?? plannerAdapter;

  try {
    const result = await createUnifiedAgentExecutionGraphResult({
      accessScope,
      allowPlannerFallback: false,
      allowedCapabilityIds,
      budgetState,
      capabilityRegistry,
      docIds,
      plan,
      plannerAdapter: observedAdapter,
      question,
      ragService,
      registry,
      taskMemory,
    });

    event = {
      errorCodes: result.errors.map((error) => error.code),
      executed: false,
      fallback: null,
      graph: result.graph
        ? {
            nodeCount: result.graph.nodes.length,
            skillIds: result.graph.nodes.map((node) => node.skillId),
            version: result.graph.version,
          }
        : null,
      mode: "shadow",
      planner: {
        fallback: result.planner.fallback === true,
        nodeCount: result.planner.nodeIds.length,
        plannerCall: result.planner.plannerCall ?? null,
        reasonCodes: result.planner.reasonCodes,
        requestedPlannerId: result.planner.requestedPlannerId,
        selectedPlannerId: result.planner.selectedPlannerId ?? null,
        status: result.planner.status,
      },
      status: result.planner.status,
    };
  } catch (error) {
    event = {
      errorCodes: ["shadow_planner_error"],
      executed: false,
      fallback: null,
      graph: null,
      mode: "shadow",
      planner: {
        fallback: false,
        requestedPlannerId: normalizeText(observedAdapter?.id) || null,
        status: "error",
      },
      status: "error",
    };
  }

  try {
    await record(event);
  } catch {
    try {
      addTraceStep({
        label: "Unified graph shadow observation",
        status: "failed",
        summary: "Shadow graph event could not be persisted.",
        type: "unified_graph_shadow_observation",
      });
    } catch {
      // Observation is best-effort; neither sink owns the real answer path.
    }
  }

  return event;
};
