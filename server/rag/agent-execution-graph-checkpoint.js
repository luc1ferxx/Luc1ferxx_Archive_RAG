import { createHash } from "node:crypto";

import { normalizeText } from "../lib/normalize-text.js";
import { normalizeTaskAccessScope } from "./tasks.js";

export const EXECUTION_GRAPH_CHECKPOINT_VERSIONS = Object.freeze({
  v1: "v1",
  v2: "v2",
});
export const EXECUTION_GRAPH_CHECKPOINT_VERSION = EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v1;
export const EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY = "__skillGraphCheckpoint";
const V2_GRAPH_VERSION = "v3";
const V2_GRAPH_NODE_STEP_PREFIX = "agent_graph_node:";

export const buildExecutionGraphNodeStepId = ({
  checkpointVersion = EXECUTION_GRAPH_CHECKPOINT_VERSION,
  nodeId,
} = {}) => {
  if (checkpointVersion === EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v1) {
    // Preserve the existing graph receipt identity byte for byte.
    return `custom_skill:${nodeId}`;
  }

  if (checkpointVersion !== EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2) {
    throw new Error("Unsupported execution graph checkpoint version.");
  }

  const normalizedNodeId = normalizeText(nodeId);
  if (!normalizedNodeId || nodeId !== normalizedNodeId) {
    throw new Error("Execution graph nodeId must be a non-empty canonical string.");
  }

  // Node IDs are planner-authored and may contain punctuation. Encoding keeps
  // the v3 receipt namespace injective without reserving delimiter characters.
  return `${V2_GRAPH_NODE_STEP_PREFIX}${Buffer.from(nodeId, "utf8").toString("base64url")}`;
};

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
    (checkpoint.version === EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2 &&
      checkpoint.graph?.version !== V2_GRAPH_VERSION) ||
    (checkpoint.version === EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v1 &&
      checkpoint.graph?.version === V2_GRAPH_VERSION) ||
    !isRecord(checkpoint.graph) ||
    !isRecord(checkpoint.owner) ||
    !isRecord(checkpoint.owner.budget?.limits) ||
    !isRecord(checkpoint.owner.budget?.usedAtEntry) ||
    !Array.isArray(checkpoint.nodeRuns) ||
    !["running", "completed", "partial", "awaiting_approval"].includes(checkpoint.phase) ||
    (checkpoint.phase === "awaiting_approval" &&
      (checkpoint.version !== EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2 ||
        !isRecord(checkpoint.approvalBoundary) ||
        checkpoint.resumeClaim)) ||
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
  const v2 = checkpoint?.version === EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2;
  if (v2 && checkpoint.graph?.version !== V2_GRAPH_VERSION) {
    return { ok: false, reason: "invalid_checkpoint_shape" };
  }

  const graphNodes = new Map(
    toArray(checkpoint?.graph?.nodes).map((node) => [node.nodeId, node])
  );
  const checkpointRuns = new Map(
    toArray(checkpoint?.nodeRuns).map((run) => [run.nodeId, run])
  );
  if (v2 && graphNodes.size !== toArray(checkpoint?.graph?.nodes).length) {
    return { ok: false, reason: "duplicate_graph_node_id" };
  }
  if (checkpointRuns.size !== toArray(checkpoint?.nodeRuns).length) {
    return { ok: false, reason: "duplicate_checkpoint_node_run" };
  }

  const v2NodeIdsByStepId = new Map();
  if (v2) {
    try {
      for (const nodeId of new Set([...graphNodes.keys(), ...checkpointRuns.keys()])) {
        v2NodeIdsByStepId.set(
          buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId }),
          nodeId
        );
      }
    } catch {
      return { ok: false, reason: "invalid_checkpoint_shape" };
    }
  }

  const completedNodeRuns = [];
  const attemptedStepIds = new Set();

  for (const step of toArray(steps)) {
    const stepId = normalizeText(step?.id);
    const isV2GraphStep = v2 && (
      stepId.startsWith(V2_GRAPH_NODE_STEP_PREFIX) ||
      step?.type === "graph_node" ||
      Boolean(step?.input?.nodeId && (
        graphNodes.has(step.input.nodeId) || checkpointRuns.has(step.input.nodeId)
      ))
    );
    if (v2 && !isV2GraphStep) {
      // A v3 graph owns the entire execution path. An unclassified lifecycle
      // step may have performed work; ignoring it would make a resume unsafe.
      return {
        ok: false,
        reason: ["pending", "running", "paused"].includes(step?.status)
          ? "unknown_in_flight_node"
          : "checkpoint_step_mismatch",
      };
    }
    if (!v2 && !stepId.startsWith("custom_skill:")) {
      continue;
    }

    if (v2 && attemptedStepIds.has(stepId)) {
      return { ok: false, reason: "duplicate_graph_step_receipt" };
    }
    attemptedStepIds.add(stepId);
    const nodeId = v2
      ? v2NodeIdsByStepId.get(stepId)
      : stepId.slice("custom_skill:".length);
    if (v2 && !nodeId) {
      return { ok: false, reason: "checkpoint_step_mismatch" };
    }
    const node = graphNodes.get(nodeId);
    const saved = checkpointRuns.get(nodeId);

    if (step.status === "running" || step.status === "paused" || (v2 && step.status === "pending")) {
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
      (v2 && (
        stepId !== buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId }) ||
        saved.stepId !== stepId ||
        step.type !== "graph_node" ||
        step.input?.nodeId !== nodeId
      )) ||
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

    if (v2 && step.status === "skipped" && saved.status !== "skipped") {
      return { ok: false, reason: "checkpoint_step_mismatch" };
    }

    if (v2 && !["completed", "failed", "skipped"].includes(step.status)) {
      return { ok: false, reason: "checkpoint_step_mismatch" };
    }
  }

  for (const saved of checkpointRuns.values()) {
    if (v2 && saved.stepId !== buildExecutionGraphNodeStepId({
      checkpointVersion: "v2",
      nodeId: saved.nodeId,
    })) {
      return { ok: false, reason: "checkpoint_step_mismatch" };
    }

    if (
      ["completed", "reused"].includes(saved.status) &&
      !completedNodeRuns.some((run) => run.nodeId === saved.nodeId)
    ) {
      return { ok: false, reason: "checkpoint_missing_completed_step" };
    }

    if (v2 && saved.status === "failed" && !attemptedStepIds.has(saved.stepId)) {
      return { ok: false, reason: "checkpoint_missing_node_step" };
    }
  }

  return {
    attemptedStepCount: attemptedStepIds.size,
    completedNodeRuns,
    ok: true,
    reason: null,
  };
};
