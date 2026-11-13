import { normalizeText } from "../lib/normalize-text.js";
import {
  buildExecutionGraphNodeStepId,
  EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY,
  sealExecutionGraphCheckpoint,
} from "./agent-execution-graph-checkpoint.js";

const V3_GRAPH_STEP_PREFIX = "agent_graph_node:";
const TERMINAL_GRAPH_PHASES = new Set(["completed", "partial"]);
const POST_GRAPH_STEP_EVENTS = new Set([
  "step_started",
  "step_paused",
  "step_completed",
  "step_failed",
]);

// One refusal for everything this guard stops. A custom Skill step is refused
// whatever its run looks like: a custom Skill runs only as a node of its
// execution graph, so nothing may retry or update its step on its own (ADR
// 0001 phase 9; before it, a `custom_skill` step without a `nodeId` -- a step
// of the deleted V1 sequential chain -- was let through to a standalone
// handler). Who asks this guard: the step executor before a retry, and the
// run store inside `retryStep` and `updateRunStep`. A graph writes its own
// node steps through the step lifecycle (`recordRunStep`), which asks only
// when the run holds a checkpoint and the step is not one of its nodes.
const failStandaloneGraphAction = () => {
  const error = new Error(
    "Guarded ExecutionGraph runs cannot be replayed as standalone steps; use whole-graph recovery."
  );
  error.code = "AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY";
  error.status = 409;
  throw error;
};

const findStep = (run, stepId) =>
  (Array.isArray(run?.steps) ? run.steps : []).find(
    (step) => normalizeText(step?.id) === stepId
  );

const resolveOriginalStep = (run, stepId) => {
  let current = findStep(run, stepId);
  let markedAsGraphNode = false;
  const seen = new Set();

  while (current) {
    const currentId = normalizeText(current.id);

    if (!currentId || seen.has(currentId)) {
      return { id: "", markedAsGraphNode };
    }
    seen.add(currentId);
    // Normalized the way the replay matrix and the step handlers read a type.
    const currentType = normalizeText(current.type).toLowerCase();

    markedAsGraphNode ||= currentType === "custom_skill" ||
      currentType === "graph_node" ||
      currentId.startsWith(V3_GRAPH_STEP_PREFIX);

    const parentId = normalizeText(current.retryOfStepId);

    if (!parentId) {
      return { id: currentId, markedAsGraphNode };
    }
    current = findStep(run, parentId);
  }

  return { id: "", markedAsGraphNode };
};

const isTerminalCheckpoint = (checkpoint) => {
  if (
    !checkpoint ||
    !TERMINAL_GRAPH_PHASES.has(checkpoint.phase) ||
    checkpoint.resumeClaim ||
    !Array.isArray(checkpoint.graph?.nodes) ||
    !Array.isArray(checkpoint.nodeRuns)
  ) {
    return false;
  }

  try {
    return sealExecutionGraphCheckpoint(checkpoint).digest === checkpoint.digest;
  } catch {
    return false;
  }
};

const findTerminalGraphEventIndex = (checkpoint, events) => {
  const expectedNodeIds = checkpoint.graph.nodes.map((node) => node.nodeId);

  return events.findLastIndex((event) => {
    const payload = event?.payload;

    return event?.type === "skill_graph_planned" &&
      payload?.mode === "guarded" &&
      payload.executed === true &&
      payload.fallback === null &&
      payload.status === checkpoint.phase &&
      payload.graph?.version === checkpoint.graph.version &&
      Array.isArray(payload.graph?.nodeIds) &&
      payload.graph.nodeIds.length === expectedNodeIds.length &&
      payload.graph.nodeIds.every((nodeId, index) => nodeId === expectedNodeIds[index]);
  });
};

/**
 * Pure replay gate for a single current run revision. The caller must provide
 * the private checkpoint in run.result when one exists and, for a mutation,
 * invoke this inside the same run-revision CAS as the mutation itself.
 */
export const assertStandaloneGraphReplayAllowed = ({
  gateId = "",
  run,
  stepId = "",
} = {}) => {
  const normalizedStepId = normalizeText(stepId);
  const normalizedGateId = normalizeText(gateId);
  const step = normalizedStepId ? findStep(run, normalizedStepId) : null;
  const original = normalizedStepId
    ? resolveOriginalStep(run, normalizedStepId)
    : { id: "", markedAsGraphNode: false };
  const checkpoint = run?.result?.[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY];

  // The step type is the marker, so a graph node stays refused even if its
  // run's checkpoint was lost.
  if (original.markedAsGraphNode) {
    failStandaloneGraphAction();
  }

  if (!checkpoint) {
    return;
  }

  const graphNodes = Array.isArray(checkpoint.graph?.nodes)
    ? checkpoint.graph.nodes
    : [];
  // A step whose type does not say so can still carry a node's step id.
  const originalIsGraphNode = graphNodes.some((node) => {
    try {
      return buildExecutionGraphNodeStepId({
        checkpointVersion: checkpoint.version,
        nodeId: node.nodeId,
      }) === original.id;
    } catch {
      return false;
    }
  });

  if (originalIsGraphNode || !isTerminalCheckpoint(checkpoint)) {
    failStandaloneGraphAction();
  }

  const events = Array.isArray(run?.events) ? run.events : [];
  const graphEventIndex = findTerminalGraphEventIndex(checkpoint, events);

  if (graphEventIndex < 0) {
    failStandaloneGraphAction();
  }

  // Event order is durable in both run stores. Post-graph approval is allowed
  // only for the pending gate actually created after the terminal graph event;
  // step replay likewise needs a lifecycle event for its original step or an
  // approved gate created after the graph. The latter is necessary when the
  // approval CAS has just queued a capability step with no lifecycle event yet.
  const laterEvents = events.slice(graphEventIndex + 1);
  const approvalGates = Array.isArray(run?.approvalGates) ? run.approvalGates : [];
  const wasGateCreatedAfterGraph = (id) => laterEvents.some(
    (event) => event?.type === "approval_gate_created" &&
      normalizeText(event.payload?.gateId) === id
  );
  const pendingGate = normalizedGateId && approvalGates.find(
    (gate) => gate.status === "pending" && normalizeText(gate.id) === normalizedGateId
  );
  const gateIsPostGraph = Boolean(pendingGate) &&
    wasGateCreatedAfterGraph(normalizedGateId);
  const stepGateId = normalizeText(step?.approvalGateId);
  const approvedStepGate = stepGateId && approvalGates.find(
    (gate) => gate.status === "approved" &&
      normalizeText(gate.id) === stepGateId &&
      step?.type === "capability_call" &&
      step?.kind === "capability_call" &&
      normalizeText(step.capabilityId) === normalizeText(gate.capabilityId) &&
      normalizeText(step.capabilityVersion) === normalizeText(gate.capabilityVersion) &&
      normalizeText(step.detail?.approvalObjectHash) ===
        normalizeText(gate.approvalObjectHash)
  );
  const stepGateIsPostGraph = Boolean(approvedStepGate) &&
    wasGateCreatedAfterGraph(stepGateId);
  const stepIsPostGraph = Boolean(step && original.id) && laterEvents.some(
    (event) => POST_GRAPH_STEP_EVENTS.has(event?.type) &&
      normalizeText(event.payload?.stepId) === original.id
  );

  if (!gateIsPostGraph && !stepIsPostGraph && !stepGateIsPostGraph) {
    failStandaloneGraphAction();
  }
};
