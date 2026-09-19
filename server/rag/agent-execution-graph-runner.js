import { releaseBudget, reserveBudget } from "./agent-budget.js";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_LIMITS,
  compileExecutionGraph,
} from "./agent-execution-graph.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { runLifecycleStep } from "./agent-step-lifecycle-runner.js";
import { buildFailedSkillResult } from "./skills/registry.js";
import {
  EXECUTION_REQUEST_FIELD_TYPES,
  describeSkillReplayContract,
  getSkillContract,
} from "./skills/skill-contract.js";

// Scheduler for a validated ExecutionGraph.
//
// It owns everything the planner is not allowed to decide: what runs, when,
// how many at once, what each node is allowed to read, and what a failure
// costs. The graph only says what the planner wants; this file says what
// actually happens.
//
// The step type stays `custom_skill`, so every node keeps the replay-safety
// policy, approval policy, and persistence contract the V1 chain already had.

const noop = () => {};

export const EXECUTION_GRAPH_NODE_STATUSES = Object.freeze({
  completed: "completed",
  failed: "failed",
  pending: "pending",
  reused: "reused",
  running: "running",
  skipped: "skipped",
});

export const EXECUTION_GRAPH_SKIP_REASONS = Object.freeze({
  abortedAfterFailure: "aborted_after_failure",
  budgetExhausted: "budget_exhausted",
  dependencyFailed: "dependency_failed",
  dependencySkipped: "dependency_skipped",
});

export const EXECUTION_GRAPH_RUN_STATUSES = Object.freeze({
  completed: "completed",
  partial: "partial",
  rejected: "rejected",
});

const SETTLED_OK = new Set([
  EXECUTION_GRAPH_NODE_STATUSES.completed,
  EXECUTION_GRAPH_NODE_STATUSES.reused,
]);

const buildSkillStepOutput = (result = {}) => {
  const hasOutput =
    result.ok ||
    Boolean(result.text) ||
    Boolean(result.citations?.length) ||
    Boolean(result.abstained);

  return hasOutput
    ? {
        abstained: Boolean(result.abstained),
        citationCount: result.citations?.length ?? 0,
        text: result.text ?? "",
      }
    : null;
};

const buildSkillStepError = (result = {}) =>
  result.ok
    ? null
    : {
        message: serializeError(result.error, "Unable to run custom skill."),
        name: result.error?.name ?? "Error",
      };

const buildNodeStepId = (nodeId) => `custom_skill:${nodeId}`;

/**
 * Resolves a node's declared bindings into concrete values.
 *
 * Only two sources exist: validated request fields and structured outputs of
 * nodes this node declared a dependency on. There is no third source, which is
 * what stops the V1 habit of splicing the last few skill answers into the next
 * skill's question string.
 */
const resolveNodeInputs = ({ node, nodeOutputs, requestValues }) => {
  const resolved = {};

  for (const [field, binding] of Object.entries(node.inputBindings ?? {})) {
    if (binding.source === "request") {
      if (EXECUTION_REQUEST_FIELD_TYPES[binding.field] !== undefined) {
        resolved[field] = requestValues[binding.field];
      }

      continue;
    }

    if (binding.source === "node") {
      resolved[field] = nodeOutputs.get(binding.nodeId)?.[binding.output];
    }
  }

  return resolved;
};

// A node may narrow the request's document scope but never widen it: the
// intersection is taken against docIds the caller was already authorized for,
// so a scope the validator somehow let through still cannot reach a new doc.
const resolveNodeDocIds = ({ boundDocIds, node }) => {
  const requested = Array.isArray(boundDocIds) ? boundDocIds : [];
  const scoped = node.scope?.docIds;

  if (!Array.isArray(scoped)) {
    return requested;
  }

  const allowed = new Set(scoped);

  return requested.filter((docId) => allowed.has(docId));
};

const buildNodeRun = (state) => ({
  citationCount: state.result?.citations?.length ?? 0,
  dependsOn: [...(state.node.dependsOn ?? [])],
  effects: state.contract.effects,
  idempotency: state.contract.idempotency,
  nodeId: state.node.nodeId,
  parallelSafe: state.contract.parallelSafe,
  reason: state.reason,
  result: state.result,
  skillId: state.contract.id,
  skillVersion: state.contract.version,
  status: state.status,
  stepId: buildNodeStepId(state.node.nodeId),
});

// A persisted node run is only reusable when it is unambiguously the same work:
// same node, same skill, and a result that actually succeeded. Anything else is
// re-run, because silently trusting a mismatched record is how recovery starts
// answering with the wrong document's evidence.
//
// A run the previous replan already reused counts as finished work too. Taking
// only `completed` forward would mean a second replan re-ran what the first one
// correctly skipped -- wasted budget for a read, a repeated write otherwise.
const REUSABLE_NODE_RUN_STATUSES = new Set([
  EXECUTION_GRAPH_NODE_STATUSES.completed,
  EXECUTION_GRAPH_NODE_STATUSES.reused,
]);

const buildReusableRuns = ({ completedNodeRuns, statesByNodeId }) => {
  const reusable = new Map();

  for (const completed of completedNodeRuns) {
    const state = statesByNodeId.get(completed?.nodeId);

    if (!state || !REUSABLE_NODE_RUN_STATUSES.has(completed.status)) {
      continue;
    }

    const result = completed.result;

    if (!result?.ok || result.skillId !== state.contract.id) {
      continue;
    }

    reusable.set(completed.nodeId, result);
  }

  return reusable;
};

export const runExecutionGraph = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  authorizedDocIds,
  authorizedSkillIds = null,
  budgetState,
  buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result?.skillId,
    skillVersion: result?.skillVersion,
    ...detail,
  }),
  completedNodeRuns = [],
  docIds = [],
  executeObservedSkill,
  graph,
  limits = EXECUTION_GRAPH_LIMITS,
  maxConcurrency,
  question,
  ragService,
  recordSkillResult = noop,
  recordSkippedSkill = noop,
  registry,
  retrievalPlan,
  sessionId,
  stepLifecycle,
  userId,
} = {}) => {
  const effectiveLimits = { ...EXECUTION_GRAPH_LIMITS, ...limits };
  const compiled = compileExecutionGraph({
    authorizedDocIds: authorizedDocIds ?? docIds,
    authorizedSkillIds,
    graph,
    limits: effectiveLimits,
    registry,
  });

  // Reject as a whole. Nothing below this point has run, so an illegal graph
  // cannot leave half a plan behind.
  if (!compiled.ok) {
    return {
      errors: compiled.errors,
      graphVersion: graph?.version ?? null,
      nodeRuns: [],
      ok: false,
      results: [],
      status: EXECUTION_GRAPH_RUN_STATUSES.rejected,
    };
  }

  const concurrencyCap = Math.max(
    1,
    Math.min(
      Number.isFinite(maxConcurrency) ? maxConcurrency : effectiveLimits.maxConcurrency,
      effectiveLimits.maxConcurrency
    )
  );
  const requestValues = {
    docIds,
    question,
    retrievalPlan,
    sessionId: sessionId ?? null,
    userId: userId ?? null,
  };
  const states = graph.nodes.map((node) => ({
    contract: getSkillContract(registry.get(node.skillId)),
    node,
    reason: null,
    result: null,
    skill: registry.get(node.skillId),
    status: EXECUTION_GRAPH_NODE_STATUSES.pending,
  }));
  const statesByNodeId = new Map(states.map((state) => [state.node.nodeId, state]));
  const nodeOutputs = new Map();
  const inFlight = new Map();
  const exclusiveInFlight = new Set();

  let aborted = false;
  let interrupt = null;

  for (const [nodeId, result] of buildReusableRuns({
    completedNodeRuns,
    statesByNodeId,
  })) {
    const state = statesByNodeId.get(nodeId);
    state.result = result;
    state.status = EXECUTION_GRAPH_NODE_STATUSES.reused;
    nodeOutputs.set(nodeId, {
      abstained: Boolean(result.abstained),
      citations: result.citations ?? [],
      text: result.text ?? "",
    });
  }

  const settleSkip = (state, reason) => {
    state.reason = reason;
    state.status = EXECUTION_GRAPH_NODE_STATUSES.skipped;
  };

  const recordSkip = ({ budget = null, reason, state }) => {
    const result = buildFailedSkillResult(
      state.skill,
      new Error(budget?.reason ?? `Node ${state.node.nodeId} skipped: ${reason}.`)
    );

    settleSkip(state, reason);
    recordSkippedSkill({ budget, phase: "primary", result, skill: state.skill });
  };

  const launchNode = (state) => {
    const { contract, node, skill } = state;
    const budget = contract.budgetKey
      ? reserveBudget(budgetState, contract.budgetKey, 1)
      : null;

    if (budget && !budget.ok) {
      recordSkip({ budget, reason: EXECUTION_GRAPH_SKIP_REASONS.budgetExhausted, state });
      addBudgetLimitTrace({ reason: budget.reason, tool: skill.label });

      return null;
    }

    const resolvedInputs = resolveNodeInputs({ node, nodeOutputs, requestValues });
    const nodeDocIds = resolveNodeDocIds({
      boundDocIds: resolvedInputs.docIds ?? docIds,
      node,
    });
    const nodeQuestion = resolvedInputs.question ?? question;
    const nodeRetrievalPlan = resolvedInputs.retrievalPlan ?? retrievalPlan;
    const stepId = buildNodeStepId(node.nodeId);
    const persistedInput = {
      docIds: nodeDocIds,
      nodeId: node.nodeId,
      question: nodeQuestion,
      retrievalPlan: nodeRetrievalPlan,
      sessionId: sessionId ?? null,
      skillId: contract.id,
      skillVersion: contract.version,
      userId: userId ?? null,
      // A dependent node's upstream text is part of its input, not of its
      // question, so a retry that only replays the question would silently run
      // the node on different data than the original. Persist the bound value
      // alongside the request fields the recovery handler already replays.
      ...(resolvedInputs.priorFindings === undefined
        ? {}
        : { priorFindings: resolvedInputs.priorFindings }),
      // The node run carries this for the trace, but recovery is handed the
      // persisted step and nothing else. Without the contract here, a node that
      // writes is indistinguishable from a RAG read and auto-replay would
      // re-run it unattended.
      ...describeSkillReplayContract(state.skill),
    };

    state.status = EXECUTION_GRAPH_NODE_STATUSES.running;

    const task = (async () => {
      let result;

      try {
        result = await runLifecycleStep({
          buildError: buildSkillStepError,
          buildOutput: buildSkillStepOutput,
          execute: () =>
            executeObservedSkill(
              skill,
              {
                accessScope,
                docIds: nodeDocIds,
                priorFindings: resolvedInputs.priorFindings,
                question: nodeQuestion,
                ragService,
                retrievalPlan: nodeRetrievalPlan,
                sessionId,
                userId,
              },
              { budget, phase: "primary" }
            ),
          id: stepId,
          input: persistedInput,
          label: skill.label,
          stepLifecycle,
          type: "custom_skill",
        });
      } catch (error) {
        // An interrupt means the node never consumed its call: the run pauses
        // and this node executes again on resume, so hand the reservation back
        // rather than charging the user twice for one approval gate.
        if (contract.budgetKey && budget?.ok) {
          releaseBudget(budgetState, contract.budgetKey, budget.reserved);
        }

        state.status = EXECUTION_GRAPH_NODE_STATUSES.pending;

        if (isAgentRunInterrupt(error)) {
          interrupt = error;

          return;
        }

        throw error;
      }

      state.result = result;
      state.status = result.ok
        ? EXECUTION_GRAPH_NODE_STATUSES.completed
        : EXECUTION_GRAPH_NODE_STATUSES.failed;
      recordSkillResult(result);

      if (result.ok) {
        nodeOutputs.set(node.nodeId, {
          abstained: Boolean(result.abstained),
          citations: result.citations ?? [],
          text: result.text ?? "",
        });
      } else if (node.failurePolicy === EXECUTION_GRAPH_FAILURE_POLICIES.failFast) {
        aborted = true;
      }

      addTraceStep({
        detail: buildSkillTraceDetail(result, {
          dependsOn: [...(node.dependsOn ?? [])],
          graphVersion: graph.version,
          nodeId: node.nodeId,
          rationale: node.rationale ?? null,
          skillKind: skill.kind,
          ...(result.traceDetail ?? {}),
        }),
        error: buildSkillStepError(result),
        id: stepId,
        input: persistedInput,
        label: skill.label,
        output: buildSkillStepOutput(result),
        status: result.ok ? "completed" : "failed",
        summary: result.ok
          ? `${skill.label} completed with ${result.citations?.length ?? 0} citation${
              result.citations?.length === 1 ? "" : "s"
            }.`
          : `${skill.label} failed: ${serializeError(
              result.error,
              "Unable to run custom skill."
            )}`,
        type: "custom_skill",
      });
    })();

    const tracked = task.then(() => {
      inFlight.delete(node.nodeId);
      exclusiveInFlight.delete(node.nodeId);
    });

    inFlight.set(node.nodeId, tracked);

    if (!contract.parallelSafe) {
      exclusiveInFlight.add(node.nodeId);
    }

    return tracked;
  };

  const hasPending = () =>
    states.some((state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.pending);

  while (hasPending() || inFlight.size > 0) {
    let progressed = false;

    for (const state of states) {
      if (state.status !== EXECUTION_GRAPH_NODE_STATUSES.pending) {
        continue;
      }

      const dependencyStates = (state.node.dependsOn ?? []).map((dependencyId) =>
        statesByNodeId.get(dependencyId)
      );

      if (
        dependencyStates.some(
          (dependency) => dependency?.status === EXECUTION_GRAPH_NODE_STATUSES.failed
        )
      ) {
        recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.dependencyFailed, state });
        progressed = true;
        continue;
      }

      if (
        dependencyStates.some(
          (dependency) => dependency?.status === EXECUTION_GRAPH_NODE_STATUSES.skipped
        )
      ) {
        recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped, state });
        progressed = true;
        continue;
      }

      if (!dependencyStates.every((dependency) => SETTLED_OK.has(dependency?.status))) {
        continue;
      }

      if (aborted || interrupt) {
        recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure, state });
        progressed = true;
        continue;
      }

      // Declaration order is the queue: a ready node that cannot start yet
      // blocks the ones behind it, so scheduling stays reproducible instead of
      // depending on which skill happened to resolve first.
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
      await Promise.race(inFlight.values());
      continue;
    }

    if (!progressed) {
      break;
    }
  }

  if (interrupt) {
    interrupt.executionGraphNodeRuns = states.map(buildNodeRun);
    throw interrupt;
  }

  const nodeRuns = states.map(buildNodeRun);
  const results = states
    .filter((state) => state.result)
    .map((state) => state.result);
  const status = nodeRuns.every((run) => SETTLED_OK.has(run.status))
    ? EXECUTION_GRAPH_RUN_STATUSES.completed
    : EXECUTION_GRAPH_RUN_STATUSES.partial;

  return {
    errors: [],
    graphVersion: graph.version,
    nodeRuns,
    ok: status === EXECUTION_GRAPH_RUN_STATUSES.completed,
    results,
    status,
  };
};
