import { isDeepStrictEqual } from "node:util";

import { getRemainingBudget, reserveBudget } from "./agent-budget.js";
import {
  buildExecutionGraphNodeStepId,
  reconcileExecutionGraphCheckpoint,
  verifyExecutionGraphCheckpoint,
} from "./agent-execution-graph-checkpoint.js";
import { compileExecutionGraph } from "./agent-execution-graph.js";
import {
  describeSkillReplayContract,
  getSkillContract,
  hasExplicitExecutionGraphContract,
  validateSkillValues,
} from "./skills/skill-contract.js";

// A pure, deliberately narrow v3 recovery preflight. It does not claim a run,
// resume a node, or make v3 eligible for the production startup worker. The
// existing checkpoint reconciler remains the receipt authority; this layer
// supplies the live registry, scope, binding, and budget checks a future
// dedicated continuation would need before attempting its CAS claim.
const manual = (reason) => ({ decision: "manual", eligible: false, reason });

const jsonEqual = (left, right) => {
  try {
    return isDeepStrictEqual(
      JSON.parse(JSON.stringify(left)),
      JSON.parse(JSON.stringify(right))
    );
  } catch {
    return false;
  }
};

const isNonNegativeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0;

const restoreBudget = ({ budgetState, checkpoint, completedNodeRuns, registry }) => {
  const restored = {
    limits: { ...budgetState.limits },
    used: {},
  };

  try {
    for (const [key, count] of Object.entries(checkpoint.owner.budget.usedAtEntry)) {
      if (!isNonNegativeInteger(count) || !reserveBudget(restored, key, count).ok) {
        return null;
      }
    }

    const remainingAtEntry = getRemainingBudget(restored);

    for (const run of completedNodeRuns) {
      const budgetKey = getSkillContract(registry.get(run.skillId)).budgetKey;

      if (budgetKey && !reserveBudget(restored, budgetKey, 1).ok) {
        return null;
      }
    }

    return { remainingAtEntry, usedAtResume: restored.used };
  } catch {
    return null;
  }
};

const expectedBoundInputs = ({ node, nodeOutputs, requestValues }) => {
  const values = {};

  for (const [field, binding] of Object.entries(node.inputBindings ?? {})) {
    if (binding.source === "request") {
      values[field] = requestValues[binding.field];
    } else {
      const upstream = nodeOutputs.get(binding.nodeId);

      if (!upstream) {
        return null;
      }

      values[field] = upstream[binding.output];
    }
  }

  return values;
};

/**
 * Classify only a completed-receipt node boundary as potentially auto
 * recoverable. A positive result is not execution authority: the caller must
 * still atomically claim the current run revision before invoking a dedicated
 * v3 continuation. Unknown work, approval, or an abandoned claim stays manual.
 * All authorization inputs must be rebuilt by trusted runtime code, never
 * copied from the checkpoint or a planner response.
 */
export const assessUnifiedGraphRecoveryEligibility = ({
  accessScope,
  authorizedDocIds,
  authorizedSkills,
  budgetState,
  checkpoint,
  docIds,
  limits,
  plan,
  question,
  registry,
  retrievalPlan,
  run,
  sessionId,
  taskMemory,
  userId,
} = {}) => {
  if (
    checkpoint?.version !== "v2" ||
    checkpoint.graph?.version !== "v3" ||
    checkpoint.phase !== "running"
  ) {
    return manual("unsupported_checkpoint_state");
  }

  if (checkpoint.resumeClaim) {
    return manual("graph_already_claimed");
  }

  if (
    run?.status !== "running" ||
    run?.result?.recovery?.mode === "manual" ||
    !Array.isArray(run?.steps) ||
    !Array.isArray(run?.approvalGates) ||
    run.approvalGates.length > 0
  ) {
    return manual("run_or_approval_not_resumable");
  }

  if (
    !Array.isArray(docIds) ||
    !Array.isArray(authorizedDocIds) ||
    !Array.isArray(authorizedSkills) ||
    !budgetState?.limits ||
    typeof registry?.get !== "function" ||
    !plan ||
    !jsonEqual(run.goal, question) ||
    !jsonEqual(run.input?.docIds, docIds) ||
    !jsonEqual(run.input?.sessionId ?? "", sessionId ?? "") ||
    !jsonEqual(run.input?.userId ?? "", userId ?? "") ||
    !jsonEqual(run.plan?.mode, plan.mode) ||
    !jsonEqual(run.plan?.summary ?? "", plan.summary ?? "") ||
    docIds.some((id) => !authorizedDocIds.includes(id))
  ) {
    return manual("trusted_owner_or_scope_mismatch");
  }

  const authorizedSkillIds = new Set();

  for (const skill of authorizedSkills) {
    const live = registry.get(skill?.id);

    if (
      !skill?.id ||
      authorizedSkillIds.has(skill.id) ||
      !live ||
      !hasExplicitExecutionGraphContract(live) ||
      !isDeepStrictEqual(getSkillContract(live), getSkillContract(skill))
    ) {
      return manual("authorized_registry_contract_mismatch");
    }

    authorizedSkillIds.add(skill.id);
  }

  let verified;

  try {
    verified = verifyExecutionGraphCheckpoint({
      accessScope,
      budgetState,
      checkpoint,
      docIds,
      plan,
      question,
      retrievalPlan,
      selectedSkills: authorizedSkills,
      sessionId,
      taskMemory,
      userId,
    });
  } catch {
    return manual("checkpoint_verification_failed");
  }

  if (!verified.ok) {
    return manual(verified.reason);
  }

  const reconciled = reconcileExecutionGraphCheckpoint({
    checkpoint,
    steps: run.steps,
  });

  if (!reconciled.ok) {
    return manual(reconciled.reason);
  }

  // The existing reconciler permits historical failed/skipped entries for
  // other workflows. This narrower preflight admits only finished receipts.
  if (
    run.steps.some((step) =>
      step.type !== "graph_node" ||
      step.status !== "completed" ||
      (step.attempt !== undefined && step.attempt !== 1)
    ) ||
    checkpoint.nodeRuns.length !== reconciled.completedNodeRuns.length ||
    checkpoint.nodeRuns.some((nodeRun) =>
      !["completed", "reused"].includes(nodeRun.status)
    )
  ) {
    return manual("non_completed_node_receipt");
  }

  const budget = restoreBudget({
    budgetState,
    checkpoint,
    completedNodeRuns: reconciled.completedNodeRuns,
    registry,
  });

  if (!budget) {
    return manual("budget_receipt_mismatch");
  }

  const compiled = compileExecutionGraph({
    authorizedDocIds,
    authorizedSkillIds: [...authorizedSkillIds],
    budgetRemaining: budget.remainingAtEntry,
    graph: checkpoint.graph,
    limits,
    registry,
  });

  if (!compiled.ok) {
    return manual("graph_registry_scope_or_budget_invalid");
  }

  const graphNodes = new Map(checkpoint.graph.nodes.map((node) => [node.nodeId, node]));
  const savedRuns = new Map(reconciled.completedNodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));

  if ([...savedRuns.keys()].some((nodeId) => !graphNodes.has(nodeId))) {
    return manual("retired_node_receipt");
  }

  const steps = new Map(run.steps.map((step) => [step.id, step]));
  const nodeOutputs = new Map();
  const requestValues = { docIds, question, retrievalPlan: retrievalPlan ?? undefined };

  for (const nodeId of compiled.order) {
    const saved = savedRuns.get(nodeId);

    if (!saved) {
      continue;
    }

    const node = graphNodes.get(nodeId);
    const skill = registry.get(node.skillId);
    const contract = getSkillContract(skill);
    const step = steps.get(buildExecutionGraphNodeStepId({ checkpointVersion: "v2", nodeId }));
    const validated = validateSkillValues({
      allowNestedValue: false,
      output: saved.result?.graphOutput,
      schema: contract.outputSchema,
    });

    if (
      contract.version !== saved.skillVersion ||
      !validated.ok ||
      !jsonEqual(validated.output, saved.result.graphOutput) ||
      ["text", "citations", "abstained"].some((field) =>
        Object.hasOwn(validated.output, field) &&
        !jsonEqual(validated.output[field], saved.result[field])
      )
    ) {
      return manual("live_output_contract_mismatch");
    }

    const boundInputs = expectedBoundInputs({ node, nodeOutputs, requestValues });
    const boundDocIds = boundInputs?.docIds ?? docIds;
    const narrowedDocIds = Array.isArray(node.scope?.docIds)
      ? boundDocIds.filter((id) => node.scope.docIds.includes(id))
      : boundDocIds;

    if (
      !boundInputs ||
      !Array.isArray(boundDocIds) ||
      boundDocIds.some((id) => !docIds.includes(id) || !authorizedDocIds.includes(id)) ||
      (contract.inputSchema.docIds?.scoped &&
        (contract.inputSchema.docIds?.required || boundInputs.docIds !== undefined) &&
        narrowedDocIds.length === 0)
    ) {
      return manual("persisted_input_scope_mismatch");
    }

    const expectedInput = {
      boundInputs,
      docIds: narrowedDocIds,
      nodeId,
      graphVersion: "v3",
      question: boundInputs.question ?? question,
      retrievalPlan: boundInputs.retrievalPlan ?? retrievalPlan,
      sessionId: sessionId ?? null,
      skillId: contract.id,
      skillVersion: contract.version,
      userId: userId ?? null,
      ...(boundInputs.priorFindings === undefined
        ? {}
        : { priorFindings: boundInputs.priorFindings }),
      ...describeSkillReplayContract(skill),
    };

    if (!jsonEqual(step?.input, expectedInput)) {
      return manual("persisted_input_binding_mismatch");
    }

    nodeOutputs.set(nodeId, validated.output);
  }

  return {
    completedNodeIds: reconciled.completedNodeRuns.map((nodeRun) => nodeRun.nodeId),
    decision: "auto_eligible",
    eligible: true,
    reason: null,
    usedBudgetAtResume: budget.usedAtResume,
  };
};
