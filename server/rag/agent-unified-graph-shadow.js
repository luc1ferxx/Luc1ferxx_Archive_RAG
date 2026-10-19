import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";
import { getShadowPlannerAdapter } from "./agent-planner-shadow.js";
import { createUnifiedAgentExecutionGraphResult } from "./agent-unified-dag-planner.js";
import { assessUnifiedGraphAdmission } from "./agent-unified-graph-admission.js";

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
 *
 * It poses the planning problem `guarded` poses (agent-unified-graph-run.js):
 * the same Capability allowlist (AGENT_UNIFIED_GRAPH_CAPABILITIES), the base
 * Capability registry for the catalog, and the same pure admission
 * (assessUnifiedGraphAdmission with the request's capability approvals) on
 * the validated graph, so `selected` means this graph would pass guarded's
 * admission and `rejected` carries admission's reason codes. It does not
 * predict which graph guarded plans: under AGENT_PLANNER_ROLLOUT=shadow this
 * observes the side model while guarded uses the deterministic graph, and
 * guarded replaces a refused model proposal with the deterministic graph
 * (allowPlannerFallback here is false). What it does not check is
 * what only an execution checks (a durable run store, a re-entered run, the
 * stage's own refusal before its first checkpoint write). Blocked nodes are
 * recorded by skill id only (`blockedSkillIds`, present only on an admission
 * refusal and empty for a graph-level reason), never by node id. The
 * planning call is awaited on the request path (a model plan adds its
 * latency to shadow requests).
 */
export const observeUnifiedAgentGraphShadow = async ({
  accessScope,
  addTraceStep = noop,
  allowedCapabilityIds = [],
  baseCapabilityRegistry,
  budgetState,
  capabilityApprovals = {},
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
  // The registry guarded plans and admits against: without the request's
  // approvals folded in (agent.js passes both).
  const planningCapabilityRegistry = baseCapabilityRegistry ?? capabilityRegistry;

  try {
    const result = await createUnifiedAgentExecutionGraphResult({
      accessScope,
      allowPlannerFallback: false,
      allowedCapabilityIds,
      budgetState,
      capabilityRegistry: planningCapabilityRegistry,
      docIds,
      plan,
      plannerAdapter: observedAdapter,
      question,
      ragService,
      registry,
      taskMemory,
    });

    const admission = result.graph
      ? assessUnifiedGraphAdmission({
          accessScope,
          capabilityApprovals,
          capabilityRegistry: planningCapabilityRegistry,
          docIds,
          graph: result.graph,
          plan,
          registry: result.graphRegistry,
        })
      : null;
    const refusedByAdmission = admission !== null && !admission.admitted;
    const blockedNodeIds = new Set(refusedByAdmission ? admission.blockedNodeIds : []);

    event = {
      ...(refusedByAdmission
        ? {
            blockedSkillIds: [
              ...new Set(
                result.graph.nodes
                  .filter((node) => blockedNodeIds.has(node.nodeId))
                  .map((node) => node.skillId)
              ),
            ].sort(),
          }
        : {}),
      errorCodes: refusedByAdmission ? admission.reasonCodes : result.errors.map((error) => error.code),
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
      status: refusedByAdmission ? "rejected" : result.planner.status,
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
