import { createHash } from "node:crypto";

import { normalizeText } from "../lib/normalize-text.js";
import { normalizeTaskAccessScope } from "./tasks.js";

// The custom-Skill graph's checkpoint. v2 was the checkpoint of the removed v3
// unified graph (ADR 0001 phases 10 and 11): nothing writes or reads one any
// more, and a run that still stores one is handled, by that version string
// alone, in agent-removed-unified-graph.js.
const EXECUTION_GRAPH_CHECKPOINT_VERSIONS = Object.freeze({
  v1: "v1",
});
export const EXECUTION_GRAPH_CHECKPOINT_VERSION = EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v1;
export const EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY = "__skillGraphCheckpoint";

// The lifecycle step of a graph node: the graph receipt identity, byte for
// byte what it has always been.
export const buildExecutionGraphNodeStepId = ({ nodeId } = {}) => `custom_skill:${nodeId}`;

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toArray = (value) => (Array.isArray(value) ? value : []);

const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
};

const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

// A completed step is a separate durable receipt from the graph checkpoint.
// Bind the entire typed node output (including citation identities and any
// future declared fields), not just its text, to that receipt. The domain and
// version keep this digest distinct from the checkpoint's own integrity hash.
export const digestExecutionGraphTypedOutput = (output) =>
  isRecord(output)
    ? `v1:sha256:${createHash("sha256")
        .update("agent-execution-graph-typed-output:v1\0")
        .update(JSON.stringify(canonicalize(output)))
        .digest("hex")}`
    : null;

const jsonCopy = (value) => JSON.parse(JSON.stringify(value));

const skillIdentity = (skills) =>
  toArray(skills)
    .map((skill) => ({
      id: normalizeText(skill?.id),
      version: normalizeText(skill?.version),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

export const buildExecutionGraphCheckpointOwner = ({
  accessScope,
  budgetState,
  docIds,
  plan,
  question,
  retrievalPlan,
  selectedSkills,
  sessionId,
  taskMemory,
  userId,
} = {}) => ({
  accessScope: normalizeTaskAccessScope(accessScope),
  budget: {
    limits: jsonCopy(budgetState?.limits ?? {}),
    usedAtEntry: jsonCopy(budgetState?.used ?? {}),
  },
  docIds: toArray(docIds).map(normalizeText),
  intentPlan: jsonCopy(plan ?? null),
  question: normalizeText(question),
  retrievalPlan: jsonCopy(retrievalPlan ?? null),
  selectedSkills: skillIdentity(selectedSkills),
  sessionId: normalizeText(sessionId),
  taskMemory: jsonCopy(taskMemory ?? null),
  userId: normalizeText(userId),
});

export const sealExecutionGraphCheckpoint = (checkpoint = {}) => {
  const version = checkpoint.version ?? EXECUTION_GRAPH_CHECKPOINT_VERSION;
  if (!Object.values(EXECUTION_GRAPH_CHECKPOINT_VERSIONS).includes(version)) {
    throw new Error("Unsupported execution graph checkpoint version.");
  }

  const body = jsonCopy({
    ...checkpoint,
    version,
  });
  delete body.digest;

  return {
    ...body,
    digest: digest(body),
  };
};

/**
 * Whether the checkpoint is one this runtime sealed and nothing changed
 * since: its digest reseals. A checkpoint version this runtime does not
 * write (the removed v3 unified graph's v2 among them) cannot be resealed,
 * so it is not intact; this never throws.
 */
export const isExecutionGraphCheckpointIntact = (checkpoint) => {
  try {
    return sealExecutionGraphCheckpoint(checkpoint).digest === checkpoint.digest;
  } catch {
    return false;
  }
};

export const createExecutionGraphCheckpoint = ({
  graph,
  owner,
  version = EXECUTION_GRAPH_CHECKPOINT_VERSION,
} = {}) =>
  sealExecutionGraphCheckpoint({
    graph,
    nodeRuns: [],
    owner,
    phase: "running",
    replanCount: 0,
    fingerprints: [],
    sequence: 0,
    version,
  });

export const updateExecutionGraphCheckpoint = (checkpoint, patch = {}) =>
  sealExecutionGraphCheckpoint({
    ...checkpoint,
    ...patch,
    sequence: Number(checkpoint?.sequence ?? 0) + 1,
  });

export const verifyExecutionGraphCheckpoint = ({
  accessScope,
  budgetState,
  checkpoint,
  docIds,
  plan,
  question,
  retrievalPlan,
  selectedSkills,
  sessionId,
  taskMemory,
  userId,
} = {}) => {
  if (
    !isRecord(checkpoint) ||
    !Object.values(EXECUTION_GRAPH_CHECKPOINT_VERSIONS).includes(checkpoint.version) ||
    !isRecord(checkpoint.graph) ||
    // The removed unified graph's contract: never a custom-Skill graph.
    checkpoint.graph.version === "v3" ||
    !isRecord(checkpoint.owner) ||
    !isRecord(checkpoint.owner.budget?.limits) ||
    !isRecord(checkpoint.owner.budget?.usedAtEntry) ||
    !Array.isArray(checkpoint.nodeRuns) ||
    !["running", "completed", "partial"].includes(checkpoint.phase) ||
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0
  ) {
    return { ok: false, reason: "invalid_checkpoint_shape" };
  }

  const { digest: storedDigest, ...body } = checkpoint;

  if (storedDigest !== digest(body)) {
    return { ok: false, reason: "checkpoint_digest_mismatch" };
  }

  const liveOwner = buildExecutionGraphCheckpointOwner({
    accessScope,
    budgetState,
    docIds,
    plan,
    question,
    retrievalPlan,
    selectedSkills,
    sessionId,
    taskMemory,
    userId,
  });
  const expectedOwner = {
    ...liveOwner,
    budget: checkpoint.owner.budget,
  };

  if (
    digest(expectedOwner) !== digest(checkpoint.owner) ||
    digest(liveOwner.budget.limits) !==
      digest(checkpoint.owner.budget?.limits ?? {}) ||
    Object.values(checkpoint.owner.budget.usedAtEntry).some(
      (used) => !Number.isSafeInteger(used) || used < 0
    )
  ) {
    return { ok: false, reason: "checkpoint_owner_mismatch" };
  }

  return { ok: true, reason: null };
};

export const snapshotExecutionGraphNodeRun = (nodeRun = {}) => ({
  nodeId: normalizeText(nodeRun.nodeId),
  skillId: normalizeText(nodeRun.skillId),
  skillVersion: normalizeText(nodeRun.skillVersion),
  status: normalizeText(nodeRun.status),
  stepId: normalizeText(nodeRun.stepId),
  ...(nodeRun.status === "completed" || nodeRun.status === "reused"
    ? { result: jsonCopy(nodeRun.result) }
    : {}),
});

export const reconcileExecutionGraphCheckpoint = ({ checkpoint, steps = [] } = {}) => {
  // Only the custom-Skill graph's checkpoint has node steps this reads; a
  // stored v2 checkpoint of the removed v3 unified graph is never reconciled.
  if (checkpoint?.version !== EXECUTION_GRAPH_CHECKPOINT_VERSION) {
    return { ok: false, reason: "invalid_checkpoint_shape" };
  }

  const graphNodes = new Map(
    toArray(checkpoint?.graph?.nodes).map((node) => [node.nodeId, node])
  );
  const checkpointRuns = new Map(
    toArray(checkpoint?.nodeRuns).map((run) => [run.nodeId, run])
  );
  if (checkpointRuns.size !== toArray(checkpoint?.nodeRuns).length) {
    return { ok: false, reason: "duplicate_checkpoint_node_run" };
  }

  const completedNodeRuns = [];
  const attemptedStepIds = new Set();

  for (const step of toArray(steps)) {
    const stepId = normalizeText(step?.id);
    if (!stepId.startsWith("custom_skill:")) {
      continue;
    }

    attemptedStepIds.add(stepId);
    const nodeId = stepId.slice("custom_skill:".length);
    const node = graphNodes.get(nodeId);
    const saved = checkpointRuns.get(nodeId);

    if (step.status === "running" || step.status === "paused") {
      // A process may have reached a write even when its completed node run
      // was never checkpointed. An active step is therefore never inferred to
      // be safe from a missing checkpoint entry or a read-only declaration.
      return { ok: false, reason: "unknown_in_flight_node" };
    }

    // A bounded replan may retire a failed node from the current graph. Its
    // persisted step still consumed an attempt, but is never eligible for
    // reuse; the saved run is the only admissible historical identity.
    if (
      !saved ||
      step.input?.skillId !== saved.skillId ||
      (node && step.input?.skillId !== node.skillId) ||
      step.input?.skillVersion !== saved.skillVersion
    ) {
      return { ok: false, reason: "checkpoint_step_mismatch" };
    }

    if (step.status === "completed") {
      const typedOutputDigest = digestExecutionGraphTypedOutput(
        saved?.result?.graphOutput
      );

      if (
        !["completed", "reused"].includes(saved.status) ||
        !saved.result?.ok ||
        saved.result.skillId !== saved.skillId ||
        saved.result.skillVersion !== saved.skillVersion ||
        saved.result.text !== step.output?.text ||
        !typedOutputDigest ||
        step.output?.typedOutputDigest !== typedOutputDigest
      ) {
        // The effect may already have landed. Never re-run a completed step
        // merely because its separate graph checkpoint write was interrupted
        // or an old/changed receipt cannot prove the typed output is the same.
        return { ok: false, reason: "completed_step_without_checkpoint" };
      }

      completedNodeRuns.push(saved);
      continue;
    }

    if (
      step.status === "failed" &&
      checkpoint.phase === "running" &&
      node
    ) {
      return { ok: false, reason: "failed_node_requires_recovery" };
    }

    if (
      step.status === "failed" &&
      !["failed", "reused"].includes(saved.status)
    ) {
      return { ok: false, reason: "failed_step_checkpoint_mismatch" };
    }
  }

  for (const saved of checkpointRuns.values()) {
    if (
      ["completed", "reused"].includes(saved.status) &&
      !completedNodeRuns.some((run) => run.nodeId === saved.nodeId)
    ) {
      return { ok: false, reason: "checkpoint_missing_completed_step" };
    }
  }

  return {
    attemptedStepCount: attemptedStepIds.size,
    completedNodeRuns,
    ok: true,
    reason: null,
  };
};
