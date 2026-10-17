import { normalizeText } from "../../lib/normalize-text.js";

// The contract between a v3 graph node parked at its approval gate and the
// executor that resumes it (docs/adr/0001-langgraph-runtime.md, phase 3).
//
// A parked node calls LangGraph's interrupt() with a payload, and LangGraph
// persists that payload in the run's thread record (as an __interrupt__
// pending write) and hands it to whoever reads the thread. So the payload is
// public ids only: the node id, and the gate id once one exists (never: the
// gate is created after the superstep, by the stage's pause CAS, so it is
// always null here). Never the private approval snapshot, the bound input,
// the question or any text (ADR constraint 5; the snapshot is a
// non-enumerable property that LangGraph's serializer would either drop or
// leak).
//
// The value LangGraph is resumed with is persisted too (as a __resume__
// write), and the phase-0 spike showed a client's own resume value would land
// in the run row that way. The executor therefore resumes only with the
// marker below, and the decision itself is always read back from the run
// store (the decided gate and its private snapshot), never taken from the
// resume value, which is why interrupt()'s return value is ignored.

export const UNIFIED_GRAPH_INTERRUPT_KIND = "archive-rag.graph-approval/v1";

/**
 * The only value ever handed to Command({ resume }) on an approval thread.
 * Truthy (LangGraph drops a falsy resume value, EmptyInputError) and id-free.
 */
export const RUNTIME_RESUME_MARKER = Object.freeze({
  kind: UNIFIED_GRAPH_INTERRUPT_KIND,
  resume: "runtime",
});

/**
 * The interrupt() payload of a node parked at its approval gate.
 */
export const buildApprovalInterruptPayload = ({ nodeId }) => {
  const normalizedNodeId = normalizeText(nodeId);

  if (!normalizedNodeId || nodeId !== normalizedNodeId) {
    throw new TypeError("An approval interrupt needs the node's canonical id.");
  }

  return { gateId: null, kind: UNIFIED_GRAPH_INTERRUPT_KIND, nodeId };
};

/**
 * Whether `value` (an interrupt value read back from a thread) is an approval
 * payload this module wrote: exactly its three fields, a non-empty node id,
 * and a gate id that is null or a non-empty string. Anything else -- another
 * module's interrupt, a tampered record -- is not one.
 */
export const isApprovalInterruptPayload = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 3 &&
  value.kind === UNIFIED_GRAPH_INTERRUPT_KIND &&
  typeof value.nodeId === "string" &&
  value.nodeId !== "" &&
  value.nodeId === normalizeText(value.nodeId) &&
  (value.gateId === null || (typeof value.gateId === "string" && value.gateId !== ""));
