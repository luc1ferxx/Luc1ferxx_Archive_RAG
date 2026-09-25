import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";
import { createUnifiedAgentExecutionGraphResult } from "./agent-unified-dag-planner.js";

const noop = () => {};

/**
 * Observe an all-stage proposal without executing a graph node. The event is
 * deliberately smaller than the proposal: request text, document ids, bound
 * values, and executable catalog entries never become an observability copy.
 * A shadow failure must not change the V1 answer path.
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

  try {
    const result = await createUnifiedAgentExecutionGraphResult({
      accessScope,
      allowedCapabilityIds,
      budgetState,
      capabilityRegistry,
      docIds,
      plan,
      plannerAdapter,
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
        nodeCount: result.planner.nodeIds.length,
        reasonCodes: result.planner.reasonCodes,
        requestedPlannerId: result.planner.requestedPlannerId,
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
        requestedPlannerId: normalizeText(plannerAdapter?.id) || null,
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
