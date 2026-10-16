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
  executeExecutionGraphNodeLaunch,
  orderExecutionGraphNodeStatesByLayer,
  prepareExecutionGraphNodeLaunch,
  recordExecutionGraphNodeSkip,
} from "./agent-execution-graph-node.js";
import {
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_REASON_CODES,
  compileExecutionGraph,
} from "./agent-execution-graph.js";

// Scheduler for a validated ExecutionGraph.
//
// It owns everything the planner is not allowed to decide: what runs, when,
// how many at once, what each node is allowed to read, and what a failure
// costs. The graph only says what the planner wants; this file says what
// actually happens.
//
// What a node does once it is launched (inputs, gates, budget, the fenced
// lifecycle, the settle order) lives in agent-execution-graph-node.js, so a
// second scheduler can run the same nodes. This file keeps the native
// scheduling: the validator's topological layer order as the queue
// (orderExecutionGraphNodeStatesByLayer), the concurrency cap, side-effect
// exclusivity, and the approval pause once nothing else can run. The two ends
// of a run that do not depend on how nodes are scheduled -- whole-graph
// admission before anything runs, and the tail once nothing more can run --
// are exported, so the LangGraph scheduler (langgraph/run-execution-graph.js)
// rejects, interrupts, pauses and reports exactly as this one does.
//
// Since phase 4 of docs/adr/0001-langgraph-runtime.md, LangGraph is the
// default scheduler (AGENT_RUNTIME unset). runExecutionGraph's scheduling
// loop is kept only as the AGENT_RUNTIME=native whole-runtime rollback switch
// for at least one release on the new default (ADR constraint 12). LangGraph
// no longer hands it any call: both schedulers queue in layer order, so the
// phase-2 delegation case (a graph not declared in layer order, whose
// declaration-order queue started a later layer first) is gone; the ADR's
// phase 5 section records what that changed natively. It is the rollback path
// to delete after that release. Admission, the tail (finishExecutionGraphRun)
// and the node module stay: LangGraph runs them.

export {
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_RUN_STATUSES,
  EXECUTION_GRAPH_SKIP_REASONS,
} from "./agent-execution-graph-node.js";

/**
 * Whole-graph admission, before any node state exists. Returns
 * { rejected } with runExecutionGraph's rejected result when the request's
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
 * this from its own async function settles in the same turn it did when this
 * code was inline in runExecutionGraph.
 */
export const finishExecutionGraphRun = ({
  context,
  control,
  graph,
  pauseForApproval = null,
  states,
  statesByNodeId,
}) => {
  // A rejected sibling may already have been removed from inFlight by the
  // time a successful Promise.race winner resumes the loop.
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

export const runExecutionGraph = async ({
  authorizedDocIds,
  authorizedSkillIds = null,
  completedNodeRuns = [],
  deniedNodeIds = [],
  docIds = [],
  graph,
  limits = EXECUTION_GRAPH_LIMITS,
  maxConcurrency,
  pauseForApproval = null,
  registry,
  // accessScope, the observability and lifecycle hooks, the request values
  // and the services every node reads: createExecutionGraphNodeContext.
  ...nodeOptions
} = {}) => {
  const { compiled, concurrencyCap, rejected, scopedDocIds } = admitExecutionGraphRun({
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
  const queue = orderExecutionGraphNodeStatesByLayer({ compiled, states });
  const context = createExecutionGraphNodeContext({
    ...nodeOptions,
    authorizedDocIds: scopedDocIds,
    docIds,
    graph,
  });
  const control = createExecutionGraphRunControl();
  const inFlight = new Map();
  const exclusiveInFlight = new Set();

  const launchNode = (state) => {
    const { node } = state;
    // The synchronous half runs inside this scheduling pass, as it always
    // has: the node is `running` before the loop looks at the next state, and
    // a throw there stops the pass without waiting for nodes in flight.
    const launch = prepareExecutionGraphNodeLaunch({ context, nodeOutputs, state });
    const task = executeExecutionGraphNodeLaunch({
      context,
      control,
      launch,
      nodeOutputs,
      state,
    });

    const tracked = task.catch((error) => {
      // Promise.race can resolve from a successful sibling in the same turn
      // that this node's checkpoint rejects. Keep the rejection independent of
      // the in-flight map, because finally removes settled promises from it.
      control.fatalError ??= error;
      control.aborted = true;
      throw error;
    }).finally(() => {
      inFlight.delete(node.nodeId);
      exclusiveInFlight.delete(node.nodeId);
    });

    inFlight.set(node.nodeId, tracked);

    if (!state.contract.parallelSafe) {
      exclusiveInFlight.add(node.nodeId);
    }

    return tracked;
  };

  const hasPending = () =>
    states.some((state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.pending);

  while (hasPending() || inFlight.size > 0) {
    if (control.fatalError) {
      await Promise.allSettled(inFlight.values());
      throw control.fatalError;
    }

    let progressed = false;

    for (const state of queue) {
      if (state.status !== EXECUTION_GRAPH_NODE_STATUSES.pending) {
        continue;
      }

      const { decision, reason } = decideExecutionGraphNode({
        aborted: control.aborted,
        dependencyStatuses: (state.node.dependsOn ?? []).map(
          (dependencyId) => statesByNodeId.get(dependencyId)?.status
        ),
        graphVersion: graph.version,
        interrupted: Boolean(control.interrupt),
        node: state.node,
        nodeOutputs,
      });

      if (decision === EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip) {
        recordExecutionGraphNodeSkip({ context, reason, state });
        progressed = true;
        continue;
      }

      if (decision !== EXECUTION_GRAPH_SCHEDULE_DECISIONS.launch) {
        continue;
      }

      // Layer order is the queue: a ready node that cannot start yet blocks
      // the ones behind it, so scheduling stays reproducible instead of
      // depending on which skill happened to resolve first. A held-back node
      // of an earlier layer is never overtaken by one of a later layer;
      // LangGraph enters the layers superstep by superstep, in this order.
      if (inFlight.size >= concurrencyCap) {
        break;
      }

      const needsExclusivity = !state.contract.parallelSafe;

      if ((needsExclusivity || exclusiveInFlight.size > 0) && inFlight.size > 0) {
        break;
      }

      const launched = launchNode(state);
      progressed = true;

      if (launched && needsExclusivity) {
        break;
      }
    }

    if (inFlight.size > 0) {
      try {
        await Promise.race(inFlight.values());
      } catch (error) {
        control.fatalError ??= error;
      }

      if (control.fatalError) {
        // A checkpoint failure must stop scheduling. Other already-running
        // nodes may settle; await them so their persistence errors cannot be
        // left unhandled while no dependent is launched.
        await Promise.allSettled(inFlight.values());
        throw control.fatalError;
      }
      continue;
    }

    if (!progressed) {
      break;
    }
  }

  return finishExecutionGraphRun({
    context,
    control,
    graph,
    pauseForApproval,
    states,
    statesByNodeId,
  });
};
