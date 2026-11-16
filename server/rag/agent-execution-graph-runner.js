import {
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_SKIP_REASONS,
  buildExecutionGraphNodeRun,
  buildExecutionGraphRunResult,
  buildRejectedExecutionGraphRun,
} from "./agent-execution-graph-node.js";
import {
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_REASON_CODES,
  compileExecutionGraph,
} from "./agent-execution-graph.js";

// The two ends of a validated ExecutionGraph's run that do not depend on how
// its nodes are scheduled.
//
// The runtime owns everything the planner is not allowed to decide: what
// runs, when, how many at once, what each node is allowed to read, and what a
// failure costs. The graph only says what the planner wants; the runtime says
// what actually happens. Whole-graph admission (admitExecutionGraphRun)
// decides before anything runs; the tail (finishExecutionGraphRun) decides
// once nothing more can run. What a node does once it is launched (inputs,
// gates, budget, the fenced lifecycle, the settle order) lives in
// agent-execution-graph-node.js.
//
// The scheduler is LangGraph (langgraph/run-execution-graph.js
// runExecutionGraphOnLangGraph): the validator's topological layer order
// (orderExecutionGraphNodeStatesByLayer) as the queue, the concurrency cap
// and side-effect exclusivity. Phase 6 of
// docs/adr/0001-langgraph-runtime.md deleted the native scheduling loop
// (runExecutionGraph) that used to live here as the AGENT_RUNTIME=native
// rollback; what it did is frozen as golden fixtures under
// test/fixtures/graph-goldens/. Phase 11 deleted what only the removed v3
// unified graph used here: the approval pause of a parked node and the
// scheduler-free replay of a settled graph (replayExecutionGraphRun).

export {
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_RUN_STATUSES,
  EXECUTION_GRAPH_SKIP_REASONS,
} from "./agent-execution-graph-node.js";

/**
 * Whole-graph admission, before any node state exists. Returns
 * { rejected } with the run's rejected result when the request's
 * docIds leave the authorized scope or the graph does not compile, and
 * otherwise { compiled, concurrencyCap, rejected: null, scopedDocIds }.
 * Nothing is run or persisted either way.
 */
export const admitExecutionGraphRun = ({
  authorizedDocIds,
  authorizedSkillIds = null,
  docIds = [],
  graph,
  limits = EXECUTION_GRAPH_LIMITS,
  maxConcurrency,
  registry,
} = {}) => {
  const effectiveLimits = { ...EXECUTION_GRAPH_LIMITS, ...limits };
  const scopedDocIds = authorizedDocIds ?? docIds;
  const authorized = new Set(Array.isArray(scopedDocIds) ? scopedDocIds : []);

  // A request binding can supply docIds even when a node has no explicit
  // scope. Check the concrete request against the authorized set before graph
  // compilation or execution; silently intersecting it would change the work
  // the planner asked the Skill to do.
  if (
    !Array.isArray(docIds) ||
    !Array.isArray(scopedDocIds) ||
    docIds.some((docId) => !authorized.has(docId))
  ) {
    return {
      rejected: buildRejectedExecutionGraphRun({
        errors: [{
          code: EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument,
          message: "Request docIds exceed the authorized document scope.",
          nodeId: null,
        }],
        graph,
      }),
    };
  }

  const compiled = compileExecutionGraph({
    authorizedDocIds: scopedDocIds,
    authorizedSkillIds,
    graph,
    limits: effectiveLimits,
    registry,
  });

  // Reject as a whole. Nothing below this point has run, so an illegal graph
  // cannot leave half a plan behind.
  if (!compiled.ok) {
    return {
      rejected: buildRejectedExecutionGraphRun({ errors: compiled.errors, graph }),
    };
  }

  return {
    compiled,
    concurrencyCap: Math.max(
      1,
      Math.min(
        Number.isFinite(maxConcurrency) ? maxConcurrency : effectiveLimits.maxConcurrency,
        effectiveLimits.maxConcurrency
      )
    ),
    rejected: null,
    scopedDocIds,
  };
};

/**
 * The end of a run once no node can be launched any more: the first fatal
 * error, then a pending AgentRunInterruptError (carrying every node run), and
 * otherwise the run result. The caller must have let every in-flight node
 * settle first. Synchronous: a scheduler that returns this from its own async
 * function settles in the turn its last node settled.
 */
export const finishExecutionGraphRun = ({
  control,
  graph,
  states,
  statesByNodeId,
}) => {
  // The first fatal error wins, even when a node that settled after it
  // succeeded: the scheduler records it the moment the node rejects.
  if (control.fatalError) {
    throw control.fatalError;
  }

  if (control.interrupt) {
    control.interrupt.executionGraphNodeRuns = states.map(buildExecutionGraphNodeRun);
    throw control.interrupt;
  }

  return buildExecutionGraphRunResult({ graph, states, statesByNodeId });
};
