import {
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_SCHEDULE_DECISIONS,
  EXECUTION_GRAPH_SKIP_REASONS,
  buildExecutionGraphNodeRun,
  buildExecutionGraphRunResult,
  buildRejectedExecutionGraphRun,
  createExecutionGraphNodeContext,
  createExecutionGraphNodeStates,
  createExecutionGraphRunControl,
  decideExecutionGraphNode,
  orderExecutionGraphNodeStatesByLayer,
  recordExecutionGraphNodeSkip,
} from "./agent-execution-graph-node.js";
import {
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_REASON_CODES,
  compileExecutionGraph,
} from "./agent-execution-graph.js";

// The two ends of a validated ExecutionGraph's run that do not depend on how
// its nodes are scheduled, plus the replay of a settled graph.
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
// (orderExecutionGraphNodeStatesByLayer) as the queue, the concurrency cap,
// side-effect exclusivity and the approval pause. Phase 6 of
// docs/adr/0001-langgraph-runtime.md deleted the native scheduling loop
// (runExecutionGraph) that used to live here as the AGENT_RUNTIME=native
// rollback; what it did is frozen as golden fixtures under
// test/fixtures/graph-goldens/. replayExecutionGraphRun schedules nothing, so
// it needs no scheduler.

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

const pauseExecutionGraphRunForApproval = async ({ graph, pauseForApproval, state, states }) => {
  // Every in-flight node has settled and checkpointed. The hook persists
  // the gate against that checkpoint and throws the run's interrupt.
  await pauseForApproval({
    boundInputs: state.awaiting.boundInputs,
    graph,
    node: state.node,
    nodeDocIds: state.awaiting.nodeDocIds,
    nodeRuns: states.map(buildExecutionGraphNodeRun),
    skill: state.skill,
  });

  const error = new Error("The approval pause did not interrupt the graph.");
  error.code = "AGENT_UNIFIED_GRAPH_APPROVAL_UNAVAILABLE";
  error.status = 409;
  throw error;
};

/**
 * The end of a run once no node can be launched any more: the first fatal
 * error, then a pending AgentRunInterruptError (carrying every node run), then
 * the approval pause of a parked node (or its abandonment after a failure),
 * and otherwise the run result. The caller must have let every in-flight node
 * settle first.
 *
 * Synchronous on every path but the approval pause, which returns the
 * (always rejecting) promise of pauseForApproval: a scheduler that returns
 * this from its own async function settles in the turn its last node
 * settled.
 */
export const finishExecutionGraphRun = ({
  context,
  control,
  graph,
  pauseForApproval = null,
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

  const awaiting = states.filter(
    (state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval
  );

  if (awaiting.length > 0) {
    // A graph that already failed a node will not complete, so asking the
    // user to approve more work in it would only defer the failure.
    if (
      control.aborted ||
      states.some((state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.failed)
    ) {
      for (const state of awaiting) {
        recordExecutionGraphNodeSkip({
          context,
          reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure,
          state,
        });
      }
    } else {
      if (typeof pauseForApproval !== "function" || awaiting.length !== 1) {
        const error = new Error(
          "An approval-gated graph node has no single durable approval pause."
        );
        error.code = "AGENT_UNIFIED_GRAPH_APPROVAL_UNAVAILABLE";
        error.status = 409;
        throw error;
      }

      return pauseExecutionGraphRunForApproval({
        graph,
        pauseForApproval,
        state: awaiting[0],
        states,
      });
    }
  }

  return buildExecutionGraphRunResult({ graph, states, statesByNodeId });
};

/**
 * The result of a graph whose work is all settled, rebuilt without a
 * scheduler: every node is reused from `completedNodeRuns`, denied, or skipped
 * because of those (a false condition, a skipped dependency). Each pending
 * node is decided in the validator's layer order exactly as a scheduling pass
 * decides it, and every skip is recorded through recordSkippedSkill as a
 * scheduler records it. A node that would launch (or wait for one that
 * would) throws `refuseLaunch({ nodeId })` instead: nothing is launched, so
 * no step, budget, preflight or checkpoint hook is ever reached.
 *
 * For a settled graph this is the same result and the same skip records a
 * scheduler produces, which then launches nothing either: in layer order a
 * dependency is decided before its dependants, so one pass settles every
 * node. Takes runExecutionGraphOnLangGraph's graph options and returns its
 * result synchronously (a rejected one for a graph admission refuses).
 */
export const replayExecutionGraphRun = ({
  authorizedDocIds,
  authorizedSkillIds = null,
  completedNodeRuns = [],
  deniedNodeIds = [],
  docIds = [],
  graph,
  limits = EXECUTION_GRAPH_LIMITS,
  maxConcurrency,
  refuseLaunch,
  registry,
  // As runExecutionGraphOnLangGraph: createExecutionGraphNodeContext. Only
  // recordSkippedSkill is ever called.
  ...nodeOptions
} = {}) => {
  const { compiled, rejected, scopedDocIds } = admitExecutionGraphRun({
    authorizedDocIds,
    authorizedSkillIds,
    docIds,
    graph,
    limits,
    maxConcurrency,
    registry,
  });

  if (rejected) {
    return rejected;
  }

  const { nodeOutputs, states, statesByNodeId } = createExecutionGraphNodeStates({
    completedNodeRuns,
    deniedNodeIds,
    graph,
    registry,
  });
  const context = createExecutionGraphNodeContext({
    ...nodeOptions,
    authorizedDocIds: scopedDocIds,
    docIds,
    graph,
  });

  for (const state of orderExecutionGraphNodeStatesByLayer({ compiled, states })) {
    if (state.status !== EXECUTION_GRAPH_NODE_STATUSES.pending) {
      continue;
    }

    const { decision, reason } = decideExecutionGraphNode({
      dependencyStatuses: (state.node.dependsOn ?? []).map(
        (dependencyId) => statesByNodeId.get(dependencyId)?.status
      ),
      graphVersion: graph.version,
      node: state.node,
      nodeOutputs,
    });

    if (decision !== EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip) {
      throw refuseLaunch({ nodeId: state.node.nodeId });
    }

    recordExecutionGraphNodeSkip({ context, reason, state });
  }

  return finishExecutionGraphRun({
    context,
    control: createExecutionGraphRunControl(),
    graph,
    states,
    statesByNodeId,
  });
};
