import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";
import { getRemainingBudget } from "./agent-budget.js";
import {
  buildDagPlanningContext,
  normalizeExecutionGraphPayload,
} from "./agent-dag-planner-adapter.js";
import {
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_REASON_CODES,
  EXECUTION_GRAPH_VERSIONS,
  validateExecutionGraph,
} from "./agent-execution-graph.js";
import { buildAuthorizedUnifiedGraphCatalog } from "./skills/unified-graph-catalog.js";

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const reject = ({ code, message, plannerId = null } = {}) => ({
  catalog: [],
  errors: [{ code, message, nodeId: null }],
  graph: null,
  planner: {
    nodeIds: [],
    reasonCodes: [code],
    requestedPlannerId: plannerId,
    status: "rejected",
  },
});

// The caller's already-authorized document ids are checked again at the
// planning boundary. A broken or asynchronous scoped lookup cannot silently
// turn an unauthorized document question into an unscoped Web plan.
const verifyRequestedDocuments = ({ accessScope, docIds, ragService }) => {
  if (!Array.isArray(docIds) || docIds.some((id) => !normalizeText(id))) {
    return false;
  }

  if (docIds.length === 0) {
    return true;
  }

  if (typeof ragService?.getDocument !== "function") {
    return false;
  }

  try {
    return docIds.every((docId) => {
      const document = ragService.getDocument(docId, accessScope);

      return document &&
        typeof document.then !== "function" &&
        normalizeText(document.docId) === normalizeText(docId);
    });
  } catch {
    return false;
  }
};

const serializePlannerError = (error) =>
  normalizeText(error instanceof Error ? error.message : error).slice(0, 300);

// What one planner call cost, when the adapter measured it (the model adapter
// does; an injected or deterministic proposal costs nothing).
const describePlannerCall = (call) =>
  isRecord(call)
    ? {
        latencyMs: Number.isFinite(call.latencyMs) ? call.latencyMs : null,
        modelRoute: call.modelRoute ?? null,
        promptTemplate: call.promptTemplate
          ? {
              fingerprint: call.promptTemplate.fingerprint,
              id: call.promptTemplate.id,
              version: call.promptTemplate.version,
            }
          : null,
        responseFormatDigest:
          typeof call.responseFormatDigest === "string" ? call.responseFormatDigest : null,
        tokens: Number.isFinite(call.tokens) ? call.tokens : null,
      }
    : null;

/**
 * Plan a single heterogeneous v3 graph from a runtime-authorized catalog.
 * This is a proposal boundary only: no node runs and no V1 fallback runs
 * here. The production caller may fall back to V1 only before execution.
 * The adapter is injected, so deterministic/mock tests never call a model.
 *
 * An adapter that names a `fallbackPlannerAdapter` (the model adapter names
 * the deterministic graph) gets one replacement: a proposal that fails, does
 * not parse, fails validation, or is refused by `assessGraph` (the caller's
 * pure admission check) is discarded whole and the fallback is planned from
 * the same redacted context. An adapter without one is judged as proposed
 * (injected test proposals rely on that). `allowPlannerFallback: false`
 * judges every adapter as proposed: shadow observation measures the observed
 * planner itself, never the graph that would have replaced it.
 */
export const createUnifiedAgentExecutionGraphResult = async ({
  accessScope,
  allowPlannerFallback = true,
  allowedCapabilityIds = [],
  assessGraph = null,
  budgetState,
  capabilityRegistry,
  docIds = [],
  limits = EXECUTION_GRAPH_LIMITS,
  plan = {},
  plannerAdapter,
  question,
  ragService,
  registry,
  taskMemory = null,
} = {}) => {
  const plannerId = normalizeText(plannerAdapter?.id) || null;

  if (!isRecord(accessScope) || !verifyRequestedDocuments({
    accessScope,
    docIds,
    ragService,
  })) {
    return reject({
      code: EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument,
      message: "The requested document set cannot be verified in the caller's access scope.",
      plannerId,
    });
  }

  if (!isRecord(budgetState) || !isRecord(budgetState.limits) || !isRecord(budgetState.used)) {
    return reject({
      code: EXECUTION_GRAPH_REASON_CODES.budgetExceeded,
      message: "A runtime-owned budget is required before planning an execution graph.",
      plannerId,
    });
  }

  if (typeof plannerAdapter?.createExecutionGraph !== "function") {
    return reject({
      code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
      message: "A unified graph planner adapter is unavailable.",
      plannerId,
    });
  }

  const catalog = buildAuthorizedUnifiedGraphCatalog({
    accessScope,
    allowedCapabilityIds,
    capabilityRegistry,
    docIds,
    ragService,
    registry,
  });
  const budgetRemaining = getRemainingBudget(budgetState);
  const baseContext = buildDagPlanningContext({
    authorizedDocIds: docIds,
    docIds,
    limits,
    plan,
    question,
    selectedSkills: catalog.skills,
    taskMemory,
  });
  const plannerContext = {
    ...baseContext,
    budgetRemaining,
    capabilities: catalog.descriptors,
    graphVersion: EXECUTION_GRAPH_VERSIONS.v3,
    // The intent's routing flags a v3 planner needs; never document text.
    intentPlan: {
      ...baseContext.intentPlan,
      actionCapabilityId: normalizeText(plan.actionCapabilityId) || null,
      skillChain: Array.isArray(plan.skillChain) ? plan.skillChain.map(normalizeText) : [],
      wantsDocumentRag: Boolean(plan.wantsDocumentRag),
    },
  };

  const propose = async (adapter) => {
    let payload;

    try {
      payload = await adapter.createExecutionGraph(plannerContext);
    } catch (error) {
      return {
        call: describePlannerCall(error?.plannerCall),
        errors: [{
          code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
          message: `Unified graph planner failed: ${serializePlannerError(error)}.`,
          nodeId: null,
        }],
        graph: null,
      };
    }

    const call = describePlannerCall(payload?.plannerCall);
    let graph;

    try {
      graph = normalizeExecutionGraphPayload(payload, {
        version: EXECUTION_GRAPH_VERSIONS.v3,
      });
    } catch (error) {
      return {
        call,
        errors: [{
          code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
          message: `Unified graph planner failed: ${serializePlannerError(error)}.`,
          nodeId: null,
        }],
        graph: null,
      };
    }

    if (graph.version !== EXECUTION_GRAPH_VERSIONS.v3) {
      return {
        call,
        errors: [{
          code: EXECUTION_GRAPH_REASON_CODES.invalidGraphVersion,
          message: "A unified graph proposal must use contract v3.",
          nodeId: null,
        }],
        graph: null,
      };
    }

    const validation = validateExecutionGraph({
      authorizedDocIds: docIds,
      authorizedSkillIds: catalog.skills.map((skill) => skill.id),
      budgetRemaining,
      graph,
      limits,
      registry: catalog.graphRegistry,
    });

    if (!validation.ok) {
      return { call, errors: validation.errors, graph: null, proposed: graph };
    }

    const admission = typeof assessGraph === "function"
      ? assessGraph({ graph: validation.graph, graphRegistry: catalog.graphRegistry })
      : null;

    return {
      admission,
      call,
      errors: [],
      graph: validation.graph,
    };
  };

  const fallbackAdapter = allowPlannerFallback
    ? plannerAdapter.fallbackPlannerAdapter ?? null
    : null;
  const primary = await propose(plannerAdapter);
  const primaryAccepted = Boolean(primary.graph) && primary.admission?.admitted !== false;
  const primaryReasonCodes = primary.graph
    ? primary.admission?.reasonCodes ?? []
    : primary.errors.map((error) => error.code);
  let selected = primary;
  let selectedPlannerId = plannerId;
  let fallback = false;

  if (!primaryAccepted && fallbackAdapter && fallbackAdapter !== plannerAdapter) {
    selected = await propose(fallbackAdapter);
    selectedPlannerId = normalizeText(fallbackAdapter.id) || null;
    fallback = true;
  }

  const planner = {
    fallback,
    fallbackReason: fallback
      ? primary.graph
        ? `The proposal was not admissible: ${primaryReasonCodes.join(", ")}.`
        : primary.errors.map((error) => error.message).join(" ").slice(0, 500) || null
      : null,
    fallbackReasonCodes: fallback ? primaryReasonCodes : [],
    nodeIds: selected.graph ? selected.graph.nodes.map((node) => node.nodeId) : [],
    plannerCall: primary.call ?? null,
    reasonCodes: selected.errors.map((error) => error.code),
    requestedPlannerId: plannerId,
    selectedPlannerId: selected.graph ? selectedPlannerId : null,
    status: selected.graph ? "selected" : "rejected",
  };

  return {
    catalog: catalog.descriptors,
    errors: selected.errors,
    graph: selected.graph,
    // The request-scoped executable registry the graph was validated against.
    // Trusted runtime code may use it for admission; it is never planner input.
    graphRegistry: catalog.graphRegistry,
    planner,
  };
};
