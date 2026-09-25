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

/**
 * Plan a single heterogeneous v3 graph from a runtime-authorized catalog.
 * This is a proposal boundary only: no node runs and no V1 fallback runs
 * here. The production caller may fall back to V1 only before execution.
 * The adapter is injected, so deterministic/mock tests never call a model.
 */
export const createUnifiedAgentExecutionGraphResult = async ({
  accessScope,
  allowedCapabilityIds = [],
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
  const plannerContext = {
    ...buildDagPlanningContext({
      authorizedDocIds: docIds,
      docIds,
      limits,
      plan,
      question,
      selectedSkills: catalog.skills,
      taskMemory,
    }),
    budgetRemaining,
    capabilities: catalog.descriptors,
    graphVersion: EXECUTION_GRAPH_VERSIONS.v3,
  };

  let graph;

  try {
    const proposal = await plannerAdapter.createExecutionGraph(plannerContext);
    graph = normalizeExecutionGraphPayload(proposal, {
      version: EXECUTION_GRAPH_VERSIONS.v3,
    });
  } catch (error) {
    return reject({
      code: EXECUTION_GRAPH_REASON_CODES.invalidNodeShape,
      message: `Unified graph planner failed: ${normalizeText(error?.message ?? error).slice(0, 300)}.`,
      plannerId,
    });
  }

  if (graph.version !== EXECUTION_GRAPH_VERSIONS.v3) {
    return reject({
      code: EXECUTION_GRAPH_REASON_CODES.invalidGraphVersion,
      message: "A unified graph proposal must use contract v3.",
      plannerId,
    });
  }

  const validation = validateExecutionGraph({
    authorizedDocIds: docIds,
    authorizedSkillIds: catalog.skills.map((skill) => skill.id),
    budgetRemaining,
    graph,
    limits,
    registry: catalog.graphRegistry,
  });

  return {
    catalog: catalog.descriptors,
    errors: validation.errors,
    graph: validation.graph,
    planner: {
      nodeIds: validation.ok ? graph.nodes.map((node) => node.nodeId) : [],
      reasonCodes: validation.errors.map((error) => error.code),
      requestedPlannerId: plannerId,
      status: validation.ok ? "selected" : "rejected",
    },
  };
};
