import {
  Annotation,
  END,
  GraphDrained,
  START,
  StateGraph,
  interrupt,
  isGraphDrained,
  isGraphInterrupt,
} from "@langchain/langgraph";

import { normalizeTrimmedText } from "../../lib/normalize-text.js";
import { digestExecutionGraphTypedOutput } from "../agent-execution-graph-checkpoint.js";
import {
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_SCHEDULE_DECISIONS,
  decideExecutionGraphNode,
  isExecutionGraphNodeSettledOk,
  orderExecutionGraphNodeStatesByLayer,
  recordExecutionGraphNodeSkip,
  runExecutionGraphNode,
} from "../agent-execution-graph-node.js";
import { getRequestCancellation } from "../request-deadline.js";
import { assertLangSmithTracingDisabled } from "./langsmith-guard.js";
import { buildApprovalInterruptPayload } from "./unified-graph-approval.js";

// A validated ExecutionGraph (custom-Skill v2, or v3) as a LangGraph
// StateGraph: one LangGraph node per graph node, START into every node
// without dependencies, a join edge from a node's dependencies into it, and
// every node no other node depends on into END.
//
// "Native" in this file (the native scheduler, natively, the native pass or
// loop, what native would do) means the native graph scheduler that phase 6
// of docs/adr/0001-langgraph-runtime.md deleted. LangGraph must keep doing
// exactly what it did; the goldens frozen from it before the deletion
// (test/fixtures/graph-goldens/) pin that, and the known superstep
// differences are listed in run-execution-graph.js.
//
// LangGraph only decides when a node is entered. What it then does is the
// node code (agent-execution-graph-node.js) on the run's in-process state:
// the skip decision, the budget, the fenced step lifecycle, the typed output
// and the graph checkpoint write all happen exactly as they did under the
// native scheduler. LangGraph's own state is one channel of receipts, keyed by
// node (toExecutionGraphReceiptKey): { status, reason, outputDigest } -- ids,
// codes and a digest, never a typed output, a question or an answer, because
// whatever a state channel holds is what the thread checkpoint persists. The
// typed outputs stay in the run's v1 graph checkpoint, which remains the
// authority for reuse and recovery.
//
// Every node returns its receipt, skipped ones included, so a join always fires
// and every node of the graph is entered exactly once, in the superstep of its
// topological layer, and in name order inside it, which is the layer-order
// queue the native scheduler scanned (orderExecutionGraphNodeStatesByLayer). The
// one exception is a v3 node its approval preflight parked (phase 3): on a
// checkpointed thread it calls interrupt() instead of returning, so LangGraph
// stops after that superstep with the pause recorded in the thread, and the
// approval decision later resumes the same thread (run-execution-graph.js). The
// park spent nothing -- no step, no budget, no trace, no checkpoint write
// (agent-execution-graph-node.js) -- so interrupt() is the node's first
// effectful operation, and the re-run LangGraph does on resume repeats only
// reads before the stage's preflight hands the node its decided gate. The value
// interrupt() returns on that re-run is never read: the decision comes from the
// run store.
//
// The native scheduler paused only once nothing else could run: after a node
// parked it kept launching every pending node that did not depend on it,
// and the gate bound to the checkpoint those nodes settled into; LangGraph
// keeps that pause state. An
// interrupt() stops LangGraph after the parked node's superstep, so it is
// called only when every pending node of a later layer depends on the parked
// one (hasExecutionGraphWorkBeforePause); layers are static here, since every
// node is entered in the superstep of its layer. Otherwise the parked node
// returns its receipt like any other, the later layers run what the native
// pass would run (its dependants wait, as natively), and the executor
// persists the pause natively and drops the thread, so the continuation is
// the fresh invocation a native pause gets. Either way the pause state is the
// native one.
//
// Edges are resolved by the validator's node id (trimmed), as it resolved
// them when it accepted the graph; the node code then looks dependencies up
// by the id as written, exactly as the native scheduler did (a dependency
// written " a" for node "a" is accepted and never counts as settled there,
// so the node stays pending, as it did natively).

export const LANGGRAPH_EXECUTION_GRAPH_ERROR_CODES = Object.freeze({
  // What LangGraph records for a node that stopped the graph (see below).
  nodeStopped: "AGENT_LANGGRAPH_NODE_STOPPED",
});

const NODE_NAME_PREFIX = "node_";

/**
 * The LangGraph node name of the graph node at `index` of the launch queue
 * (orderExecutionGraphNodeStatesByLayer: the validator's layer order,
 * declaration order within a layer). LangGraph refuses names containing ":"
 * or "|", starting with "__", or equal to a state key, and a planner may
 * author any non-empty nodeId; base64url has none of those characters, and
 * the prefix keeps the name off "__" and off "receipts". The zero-padded
 * index comes first because LangGraph enters a superstep's nodes in name
 * order (pregel/algo.js candidateNodes sorts them): with it, that order is
 * the queue order, the order the native scheduler scanned in. Across
 * supersteps the queue order holds by construction, since every node is
 * entered in the superstep of its layer. The name never leaves one
 * invocation, so it does not need to stay stable across a replan.
 */
export const encodeExecutionGraphNodeName = ({ index, nodeCount, nodeId }) => {
  const width = String(Math.max(nodeCount - 1, 0)).length;
  const encodedId = Buffer.from(String(nodeId), "utf8").toString("base64url");

  return `${NODE_NAME_PREFIX}${String(index).padStart(width, "0")}_${encodedId}`;
};

/**
 * The key of a node's receipt in the receipts channel: "node:" + nodeId. Not
 * the bare nodeId, because LangGraph's deserializer (JsonPlusSerializer)
 * rebuilds an object by assigning its keys, and assigning "__proto__" -- a
 * nodeId the validator accepts -- would replace the prototype of a state read
 * back from the thread instead of adding a receipt.
 */
export const toExecutionGraphReceiptKey = (nodeId) => `node:${nodeId}`;

// The nodes reachable from `nodeId` through dependsOn edges (the ones whose
// launch waits on it), by the validator's trimmed id.
const collectExecutionGraphDescendants = ({ nodeId, states }) => {
  const dependants = new Map(states.map((state) => [normalizeTrimmedText(state.node.nodeId), []]));

  for (const state of states) {
    for (const dependencyId of state.node.dependsOn ?? []) {
      dependants.get(normalizeTrimmedText(dependencyId))?.push(normalizeTrimmedText(state.node.nodeId));
    }
  }

  const descendants = new Set();
  const frontier = [normalizeTrimmedText(nodeId)];

  while (frontier.length > 0) {
    for (const dependantId of dependants.get(frontier.pop()) ?? []) {
      if (!descendants.has(dependantId)) {
        descendants.add(dependantId);
        frontier.push(dependantId);
      }
    }
  }

  return descendants;
};

/**
 * Whether the native scheduler would still run (or skip) something before
 * pausing for the approval of `nodeId`: a pending node of a later layer than
 * that node's which does not depend on it, directly or through any node.
 * Such a node LangGraph has not entered yet, so an interrupt() in the parked
 * node's superstep would pause before it, where native pauses after it. A
 * pending node of the same layer is in the superstep already and settles
 * before the interrupt stops the graph; a pending dependant waits natively
 * too. `compiled` is admission's compileExecutionGraph result (its layers are
 * the validator's, trimmed ids), `states` the node states.
 */
export const hasExecutionGraphWorkBeforePause = ({ compiled, nodeId, states }) => {
  const layerByNodeId = new Map(
    (compiled?.layers ?? []).flatMap((layer, index) => layer.map((id) => [id, index]))
  );
  const parkedLayer = layerByNodeId.get(normalizeTrimmedText(nodeId));

  if (parkedLayer === undefined) {
    throw new TypeError("A parked node must belong to a compiled layer.");
  }

  const descendants = collectExecutionGraphDescendants({ nodeId, states });

  return states.some((state) => {
    const id = normalizeTrimmedText(state.node.nodeId);

    return (
      state.status === EXECUTION_GRAPH_NODE_STATUSES.pending &&
      !descendants.has(id) &&
      (layerByNodeId.get(id) ?? -1) > parkedLayer
    );
  });
};

// A node only ever writes its own key, so a keyed merge is the whole reducer.
// A reducer (not LastValue) is required anyway: nodes of one superstep write
// the channel concurrently.
const mergeReceipts = (current = {}, update = {}) => ({ ...current, ...update });

export const ExecutionGraphReceiptState = Annotation.Root({
  receipts: Annotation({ default: () => ({}), reducer: mergeReceipts }),
});

/**
 * The receipt a node returns to LangGraph: its status and skip reason as the
 * in-process node state holds them, and for a completed or reused node the
 * digest of the typed output its dependants bind.
 */
export const buildExecutionGraphReceipt = ({ nodeOutputs, state }) => ({
  outputDigest: isExecutionGraphNodeSettledOk(state.status)
    ? digestExecutionGraphTypedOutput(nodeOutputs.get(state.node.nodeId))
    : null,
  reason: state.reason ?? null,
  status: state.status,
});

// What LangGraph is allowed to persist for a node that stopped the graph: a
// stable code. LangGraph writes { message, name } of a node's error into the
// thread checkpoint (pregel/runner.js _commit); the original error stays in
// this process, on control.fatalError, and is the one the caller sees.
const createNodeStoppedError = (cause) => {
  const rawCode = typeof cause?.code === "string" ? cause.code : cause?.name;
  const code = /^[A-Za-z0-9_.-]{1,80}$/.test(String(rawCode ?? ""))
    ? String(rawCode)
    : "error";
  const error = new Error(`A graph node stopped the graph (${code}).`);
  error.name = "GraphNodeStopped";
  error.code = LANGGRAPH_EXECUTION_GRAPH_ERROR_CODES.nodeStopped;
  return error;
};

// The safe point of a native launch (throwIfRequestCancelled at the top of
// executeExecutionGraphNodeLaunch, which throws getRequestCancellation()), as
// a drain. A GraphDrained a node throws
// leaves no error write and no receipt for it, and the superstep's other
// nodes still finish and commit (pregel/runner.js tick keeps a drain as a
// bubble-up), which is what the native scheduler did with a cancellation:
// launch nothing more, let what is in flight settle. The cancellation itself
// is the run's fatal error, as it was natively.
const passSafePoint = (control) => {
  const cancellation = getRequestCancellation();

  if (cancellation) {
    control.fatalError ??= cancellation;
    control.aborted = true;
    throw new GraphDrained(cancellation.reason);
  }
};

const createNodeAction = ({
  compiled,
  context,
  control,
  gate,
  graph,
  interruptOnApproval,
  nodeOutputs,
  state,
  states,
  statesByNodeId,
  trackNode,
}) => {
  const { nodeId } = state.node;
  const toUpdate = () => ({
    receipts: {
      [toExecutionGraphReceiptKey(nodeId)]: buildExecutionGraphReceipt({ nodeOutputs, state }),
    },
  });
  const decide = () =>
    decideExecutionGraphNode({
      aborted: control.aborted,
      dependencyStatuses: (state.node.dependsOn ?? []).map(
        (dependencyId) => statesByNodeId.get(dependencyId)?.status
      ),
      graphVersion: graph.version,
      interrupted: Boolean(control.interrupt),
      node: state.node,
      nodeOutputs,
    });

  // `holdSlot` receives the gate's release once the node holds a slot; the
  // slot is given back by the caller (see below), not here.
  const runNode = async (holdSlot) => {
    // LangGraph configures a node's callbacks before calling it; a tracer
    // switched on since the outer entry checked must not see the next one.
    assertLangSmithTracingDisabled();

    // Settled before this invocation: reused from the graph checkpoint or
    // denied at its approval gate. Nothing is launched, so, as natively, no
    // safe point applies.
    if (state.status !== EXECUTION_GRAPH_NODE_STATUSES.pending) {
      return toUpdate();
    }

    passSafePoint(control);

    let { decision, reason } = decide();

    // `wait` (a dependency left pending by an interrupt or never settled)
    // and `hold` (a v3 graph with a pending interrupt) both leave the node
    // pending, as the native loop does once nothing else can run; the native
    // pass passes over such a node without stopping, so it takes no turn.
    if (decision !== EXECUTION_GRAPH_SCHEDULE_DECISIONS.launch) {
      if (decision === EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip) {
        // The native pass decides a skip when its scan reaches the node:
        // after the nodes ahead of it started, never ahead of one the cap or
        // an exclusive node still holds back, and not at all once a fatal
        // error ended scheduling. The turn decides at that point (a fail_fast
        // failure ahead of it in the queue turns its skip into
        // aborted_after_failure), and the skip is recorded once the nodes
        // started in that pass have run their synchronous part, as the scan
        // records it after theirs.
        const turn = await gate.awaitTurn(() => ({
          stopped: Boolean(control.fatalError),
          ...decide(),
        }));

        if (turn.stopped) {
          throw createNodeStoppedError({ code: "graph_stopped" });
        }

        if (turn.decision === EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip) {
          recordExecutionGraphNodeSkip({ context, reason: turn.reason, state });
        }
      }

      return toUpdate();
    }

    holdSlot(await gate.acquire({ exclusive: !state.contract.parallelSafe }));

    // A node that waited for its slot re-checks what may have changed
    // meanwhile, as the native loop does on every pass: a cancellation
    // launches nothing, a fatal error stops scheduling, and a fail_fast
    // failure or an interrupt skips what has not started.
    passSafePoint(control);

    if (control.fatalError) {
      throw createNodeStoppedError({ code: "graph_stopped" });
    }

    ({ decision, reason } = decide());

    if (decision === EXECUTION_GRAPH_SCHEDULE_DECISIONS.launch) {
      await runExecutionGraphNode({ context, control, nodeOutputs, state });

      if (
        interruptOnApproval &&
        state.status === EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval &&
        !hasExecutionGraphWorkBeforePause({ compiled, nodeId, states })
      ) {
        // Parked at its gate with nothing left that native would run before
        // pausing (see the header). On the first pass this throws
        // GraphInterrupt: LangGraph records the payload as the thread's
        // pending interrupt, lets the superstep's other nodes finish, and
        // returns; the stage then persists the gate against the checkpoint
        // those nodes settled into. The payload is public ids only
        // (unified-graph-approval.js). On a resumed thread interrupt()
        // returns the resume marker at once instead (never read), so a node
        // that parked again there would return an awaiting_approval receipt
        // and the executor would persist that pause natively, which the run
        // store refuses as a second gate; the stage's preflight hands the
        // approved node its decided gate, so it never parks again.
        interrupt(buildApprovalInterruptPayload({ nodeId }));
      }

      // An AgentRunInterruptError hands the node back as pending, and the
      // native loop decides it again on its next pass: a v2 node is then
      // skipped (aborted_after_failure, so its dependants are skipped too),
      // a v3 node is held pending. Entered only once here, the node takes
      // that decision now. It cannot be `launch` again: the interrupt is
      // pending.
      ({ decision, reason } = state.status === EXECUTION_GRAPH_NODE_STATUSES.pending
        ? decide()
        : { decision: null, reason: null });
    }

    if (decision === EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip) {
      recordExecutionGraphNodeSkip({ context, reason, state });
    }

    // The node's status is final here: execute resolves only after the
    // checkpoint write, so no receipt ever reaches LangGraph (and no
    // dependant is entered) before the run store holds the output.
    return toUpdate();
  };

  // No retryPolicy is ever set on these nodes: a retried node would run its
  // effect again before the step-start fence could tell, and LangGraph's
  // default retry handler retries a RequestCancelledError.
  return () => {
    let releaseSlot = null;
    const task = runNode((release) => {
      releaseSlot = release;
    })
      .catch((error) => {
        // A drain and an approval park are LangGraph's own stop signals, not
        // failures: neither sets the run's fatal error.
        if (
          isGraphDrained(error) ||
          isGraphInterrupt(error) ||
          error?.code === LANGGRAPH_EXECUTION_GRAPH_ERROR_CODES.nodeStopped
        ) {
          throw error;
        }

        // As the native scheduler's tracked task: the first error stops the
        // graph, and the original error is what the run throws.
        control.fatalError ??= error;
        control.aborted = true;
        throw createNodeStoppedError(error);
      })
      // The slot is given back only after this node's outcome is recorded,
      // as the native loop launches nothing before the in-flight promise
      // that failed has set fatalError: a node waiting for the slot must
      // see a checkpoint failure of the node it replaces, even when a
      // sibling's success lands in the same turn.
      .finally(() => releaseSlot?.());

    return trackNode(task);
  };
};

/**
 * Compiles one invocation's graph. `compiled` is admission's compiled graph
 * (required: its order names the nodes), `states` the node states of
 * createExecutionGraphNodeStates (declaration order), `context`, `control`
 * and `nodeOutputs` the run's shared node context, control flags and typed
 * outputs, `gate` the concurrency gate, and `trackNode(promise)` registers a
 * node's in-flight work and returns it.
 * `checkpointer` is a BaseCheckpointSaver or false. With `interruptOnApproval`
 * (which needs a checkpointer: interrupt() refuses to run without one) a node
 * parked at its approval gate stops the graph with interrupt() instead of
 * returning a receipt, unless native would still run something before the
 * pause (hasExecutionGraphWorkBeforePause); without it the parked node
 * returns its receipt and the graph runs on, as it did in phase 2.
 */
export const compileExecutionGraphOnLangGraph = ({
  checkpointer = false,
  compiled,
  context,
  control,
  gate,
  graph,
  interruptOnApproval = false,
  nodeOutputs,
  states,
  statesByNodeId,
  trackNode,
}) => {
  if (interruptOnApproval && !checkpointer) {
    throw new TypeError("An approval interrupt needs a LangGraph checkpointer.");
  }

  if (!Array.isArray(compiled?.layers) || !Array.isArray(compiled?.order)) {
    throw new TypeError("A LangGraph execution graph needs the compiled graph's layers.");
  }

  const builder = new StateGraph(ExecutionGraphReceiptState);
  // Keyed by the validator's id (see the header): every dependency it
  // accepted resolves here.
  const names = new Map();
  const dependencyIds = (state) => [
    ...new Set((state.node.dependsOn ?? []).map(normalizeTrimmedText)),
  ];

  // Named in queue order, so the gate's arrival order inside a superstep is
  // the native scan's (see encodeExecutionGraphNodeName).
  orderExecutionGraphNodeStatesByLayer({ compiled, states }).forEach((state, index) => {
    const name = encodeExecutionGraphNodeName({
      index,
      nodeCount: states.length,
      nodeId: state.node.nodeId,
    });

    names.set(normalizeTrimmedText(state.node.nodeId), name);
    builder.addNode(
      name,
      createNodeAction({
        compiled,
        context,
        control,
        gate,
        graph,
        interruptOnApproval,
        nodeOutputs,
        state,
        states,
        statesByNodeId,
        trackNode,
      })
    );
  });

  const dependedOn = new Set(states.flatMap(dependencyIds));

  for (const state of states) {
    const nodeId = normalizeTrimmedText(state.node.nodeId);
    const name = names.get(nodeId);
    const dependencies = dependencyIds(state).map((dependencyId) => {
      const dependencyName = names.get(dependencyId);

      // The validator refuses a dangling dependency; reaching this would
      // mean a graph that never passed admission.
      if (dependencyName === undefined) {
        throw new TypeError("A compiled execution graph has an unresolved dependency.");
      }

      return dependencyName;
    });

    if (dependencies.length === 0) {
      builder.addEdge(START, name);
    } else {
      // A join barrier for more than one dependency: the node is entered
      // once, after every dependency returned its receipt.
      builder.addEdge(dependencies.length === 1 ? dependencies[0] : dependencies, name);
    }

    if (!dependedOn.has(nodeId)) {
      builder.addEdge(name, END);
    }
  }

  return builder.compile({ checkpointer });
};
