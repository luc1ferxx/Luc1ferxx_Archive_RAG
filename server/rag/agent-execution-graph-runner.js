import { isDeepStrictEqual } from "node:util";

import { releaseBudget, reserveBudget } from "./agent-budget.js";
import {
  EXECUTION_GRAPH_CHECKPOINT_VERSIONS,
  buildExecutionGraphNodeStepId,
  digestExecutionGraphTypedOutput,
} from "./agent-execution-graph-checkpoint.js";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_REASON_CODES,
  EXECUTION_GRAPH_VERSIONS,
  compileExecutionGraph,
} from "./agent-execution-graph.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { runLifecycleStep } from "./agent-step-lifecycle-runner.js";
import { AGENT_SKILL_IDS, buildFailedSkillResult } from "./skills/registry.js";
import { hasConsistentDocumentRagGraphResult } from "./skills/document-rag-graph-result.js";
import {
  EXECUTION_REQUEST_FIELD_TYPES,
  createSkillInputContractError,
  createSkillOutputContractError,
  describeSkillReplayContract,
  getSkillContract,
  validateSkillValues,
} from "./skills/skill-contract.js";

// Scheduler for a validated ExecutionGraph.
//
// It owns everything the planner is not allowed to decide: what runs, when,
// how many at once, what each node is allowed to read, and what a failure
// costs. The graph only says what the planner wants; this file says what
// actually happens.
//
// v1/v2 retain the `custom_skill` lifecycle identity. v3 uses a distinct
// graph-node identity so heterogeneous stages cannot be mistaken for V1
// custom-Skill steps by replay or recovery code.

const noop = () => {};

export const EXECUTION_GRAPH_NODE_STATUSES = Object.freeze({
  // A node whose preflight needs a user decision. It holds no lifecycle step
  // and no budget; its dependants wait, independent nodes keep running.
  awaitingApproval: "awaiting_approval",
  completed: "completed",
  failed: "failed",
  pending: "pending",
  reused: "reused",
  running: "running",
  skipped: "skipped",
});

export const EXECUTION_GRAPH_SKIP_REASONS = Object.freeze({
  abortedAfterFailure: "aborted_after_failure",
  // The user rejected the node's approval gate: it never ran and never will.
  approvalDenied: "approval_denied",
  budgetExhausted: "budget_exhausted",
  conditionNotMet: "condition_not_met",
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
        ...(result.ok
          ? { typedOutputDigest: digestExecutionGraphTypedOutput(result.graphOutput) }
          : {}),
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

const graphNodeIdentity = (graph, nodeId) => {
  const heterogeneous = graph.version === EXECUTION_GRAPH_VERSIONS.v3;

  return {
    stepId: buildExecutionGraphNodeStepId({
      checkpointVersion: heterogeneous
        ? EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v2
        : EXECUTION_GRAPH_CHECKPOINT_VERSIONS.v1,
      nodeId,
    }),
    stepType: heterogeneous ? "graph_node" : "custom_skill",
  };
};

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

// A node may narrow the request's document scope but never widen it. The
// caller checks each bound id against the original request before this helper
// intersects the plan's optional narrowing scope.
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
  stepId: state.stepId,
});

// A persisted node run is only reusable when it is unambiguously the same work:
// same node, same skill, and a result that actually succeeded. A matching node
// with an invalid persisted result must fail closed, not be executed again:
// its effect may already have happened even if its output can no longer be
// decoded under the current contract.
//
// A run the previous replan already reused counts as finished work too. Taking
// only `completed` forward would mean a second replan re-ran what the first one
// correctly skipped -- wasted budget for a read, a repeated write otherwise.
const REUSABLE_NODE_RUN_STATUSES = new Set([
  EXECUTION_GRAPH_NODE_STATUSES.completed,
  EXECUTION_GRAPH_NODE_STATUSES.reused,
]);

const invalidCompletedRun = (nodeId) => {
  const error = new Error(
    `Completed graph node ${nodeId} cannot be safely reused; manual recovery is required.`
  );
  error.code = "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY";
  error.status = 409;
  return error;
};

const buildReusableRuns = ({ completedNodeRuns, statesByNodeId }) => {
  const reusable = new Map();

  for (const completed of completedNodeRuns) {
    const state = statesByNodeId.get(completed?.nodeId);

    // A bounded replan can retire a node from the next graph. Historical runs
    // for retired node IDs are irrelevant; runs for retained IDs are not.
    if (!state) {
      continue;
    }

    const result = completed.result;

    if (
      reusable.has(completed.nodeId) ||
      !REUSABLE_NODE_RUN_STATUSES.has(completed.status) ||
      completed.skillId !== state.contract.id ||
      (completed.skillVersion !== undefined &&
        completed.skillVersion !== state.contract.version) ||
      !result?.ok ||
      result.skillId !== state.contract.id ||
      result.skillVersion !== state.contract.version
    ) {
      throw invalidCompletedRun(completed.nodeId);
    }

    // Checkpoint data is not an authorization or type boundary. An older run
    // may lack graphOutput, but it must still contain every required field in
    // the live skill's contract before it can feed a dependent node.
    const validation = validateSkillValues({
      allowNestedValue: result.graphOutput === undefined,
      output: result.graphOutput ?? result,
      schema: state.contract.outputSchema,
    });

    if (!validation.ok) {
      throw invalidCompletedRun(completed.nodeId);
    }

    // A stored typed envelope may be structurally valid but disagree with the
    // saved answer/evidence receipt. Never feed the alternative value to a
    // dependent or silently rerun the node that already produced an effect.
    if (
      result.graphOutput !== undefined &&
      ["text", "citations", "abstained"].some(
        (field) =>
          Object.hasOwn(validation.output, field) &&
          !isDeepStrictEqual(validation.output[field], result[field])
      )
    ) {
      throw invalidCompletedRun(completed.nodeId);
    }

    if (
      state.contract.id === AGENT_SKILL_IDS.documentRag &&
      !hasConsistentDocumentRagGraphResult(result)
    ) {
      throw invalidCompletedRun(completed.nodeId);
    }

    reusable.set(completed.nodeId, { output: validation.output, result });
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
  capabilityRegistry,
  buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result?.skillId,
    skillVersion: result?.skillVersion,
    ...detail,
  }),
  completedNodeRuns = [],
  deniedNodeIds = [],
  docIds = [],
  executeObservedSkill,
  graph,
  graphResumeClaimId = undefined,
  limits = EXECUTION_GRAPH_LIMITS,
  maxConcurrency,
  onNodeSettled = noop,
  pauseForApproval = null,
  preflightNode = null,
  question,
  ragService,
  recordSkillResult = noop,
  recordSkippedSkill = noop,
  registry,
  retrievalPlan,
  services,
  sessionId,
  stepLifecycle,
  userId,
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
      errors: [{
        code: EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument,
        message: "Request docIds exceed the authorized document scope.",
        nodeId: null,
      }],
      graphVersion: graph?.version ?? null,
      nodeRuns: [],
      ok: false,
      results: [],
      status: EXECUTION_GRAPH_RUN_STATUSES.rejected,
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
  const requestedDocIds = new Set(docIds);
  const requestValues = {
    docIds,
    question,
    // Null optional request values mean "not supplied", not a concrete value
    // of the declared object/string type.
    retrievalPlan: retrievalPlan ?? undefined,
  };
  const states = graph.nodes.map((node) => ({
    contract: getSkillContract(registry.get(node.skillId)),
    node,
    reason: null,
    result: null,
    skill: registry.get(node.skillId),
    status: EXECUTION_GRAPH_NODE_STATUSES.pending,
    ...graphNodeIdentity(graph, node.nodeId),
  }));
  const statesByNodeId = new Map(states.map((state) => [state.node.nodeId, state]));
  const nodeOutputs = new Map();
  const inFlight = new Map();
  const exclusiveInFlight = new Set();

  let aborted = false;
  let interrupt = null;
  let fatalError = null;
  const persistFencedGraphStep = async (method, step) => {
    if (typeof stepLifecycle?.[method] !== "function") {
      const error = new Error(
        "Durable graph execution requires a fenced step lifecycle."
      );
      error.code = "AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE";
      error.status = 409;
      throw error;
    }

    const persisted = await stepLifecycle[method]({
      ...step,
      expectedResumeClaimId: graphResumeClaimId,
    });

    if (!persisted) {
      const error = new Error(
        "Durable graph step transition was not recorded before continuing."
      );
      error.code = "AGENT_GRAPH_EXECUTION_FENCE_UNAVAILABLE";
      error.status = 409;
      throw error;
    }

    return persisted;
  };
  const graphStepLifecycle = graphResumeClaimId === undefined
    ? stepLifecycle
    : {
        ...stepLifecycle,
        completeStep: (step) => persistFencedGraphStep("completeGraphStep", step),
        failStep: (step) => persistFencedGraphStep("failGraphStep", step),
        pauseStep: (step) => persistFencedGraphStep("pauseGraphStep", step),
        startStep: (step) => persistFencedGraphStep("startGraphStep", step),
      };

  for (const [nodeId, { output, result }] of buildReusableRuns({
    completedNodeRuns,
    statesByNodeId,
  })) {
    const state = statesByNodeId.get(nodeId);
    state.result = result;
    state.status = EXECUTION_GRAPH_NODE_STATUSES.reused;
    nodeOutputs.set(nodeId, output);
  }

  const settleSkip = (state, reason) => {
    state.reason = reason;
    state.status = EXECUTION_GRAPH_NODE_STATUSES.skipped;
  };

  // A rejected approval gate settles its node before scheduling starts: it
  // spends nothing, starts no lifecycle step, and its dependants are skipped
  // with it. Only a node that never ran can be denied.
  for (const nodeId of Array.isArray(deniedNodeIds) ? deniedNodeIds : []) {
    const state = statesByNodeId.get(nodeId);

    if (!state || state.status !== EXECUTION_GRAPH_NODE_STATUSES.pending) {
      throw invalidCompletedRun(nodeId);
    }

    settleSkip(state, EXECUTION_GRAPH_SKIP_REASONS.approvalDenied);
  }

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
    const resolvedInputs = resolveNodeInputs({ node, nodeOutputs, requestValues });
    const boundDocIds = resolvedInputs.docIds ?? docIds;
    const nodeDocIds = resolveNodeDocIds({
      boundDocIds,
      node,
    });
    const scopedDocInput = contract.inputSchema.docIds?.scoped === true;
    const inputErrors = [];

    // An upstream typed string[] is not an authorization grant. It may be a
    // well-formed value while containing a different user's document id.
    if (
      scopedDocInput &&
      Array.isArray(boundDocIds) &&
      boundDocIds.some((docId) =>
        !requestedDocIds.has(docId) || !authorized.has(docId)
      )
    ) {
      inputErrors.push("docIds must remain within the authorized request");
    }

    // Some document adapters interpret [] as "all workspace documents".
    // An empty narrowed scope must never turn a selected-doc operation into
    // a workspace-wide read after the graph validator has accepted it.
    if (
      scopedDocInput &&
      (contract.inputSchema.docIds.required || resolvedInputs.docIds !== undefined) &&
      nodeDocIds.length === 0
    ) {
      inputErrors.push("scoped docIds must contain at least one document");
    }

    const schemaValidation = validateSkillValues({
      allowNestedValue: false,
      output: scopedDocInput && resolvedInputs.docIds !== undefined
        ? { ...resolvedInputs, docIds: nodeDocIds }
        : resolvedInputs,
      schema: contract.inputSchema,
    });
    const inputValidation = inputErrors.length > 0
      ? {
          errors: [...schemaValidation.errors, ...inputErrors],
          ok: false,
          output: null,
        }
      : schemaValidation;
    const nodeQuestion = resolvedInputs.question ?? question;
    const nodeRetrievalPlan = resolvedInputs.retrievalPlan ?? retrievalPlan;
    const { stepId, stepType } = state;
    const persistedInput = {
      // Store the exact validated binding values for a cross-process replay.
      // Access scope and approvals never enter this map; they remain runtime-
      // owned inputs supplied afresh by the recovery handler.
      boundInputs: resolvedInputs,
      docIds: nodeDocIds,
      nodeId: node.nodeId,
      graphVersion: graph.version,
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
      let budget = null;
      let nodeRuntime = null;
      // A preflight that refuses the resolved input (a Capability policy
      // block, an out-of-scope value) fails this node like an invalid
      // binding: a failed lifecycle step, no budget, no execution.
      let preflightRejection = null;

      try {
        // An approval-required Capability must be checked at a clean node
        // boundary: no lifecycle step or budget attempt may exist yet. The
        // injected preflight may persist a graph-bound gate and interrupt;
        // ordinary Skills leave this hook unused.
        if (inputValidation.ok && typeof preflightNode === "function") {
          nodeRuntime = await preflightNode({
            accessScope,
            boundInputs: inputValidation.output,
            graph,
            graphResumeClaimId,
            node,
            nodeDocIds,
            persistedInput,
            skill,
          });

          if (
            nodeRuntime != null &&
            (typeof nodeRuntime !== "object" || Array.isArray(nodeRuntime) ||
              skill.kind !== "capability")
          ) {
            throw new Error("Only a trusted Capability preflight may provide node runtime grants.");
          }

          // The node needs a user decision. It is parked at a clean boundary:
          // no lifecycle step, no budget, no output. Its dependants wait with
          // it while independent nodes keep running; the pause itself is
          // persisted only once nothing else can run (see pauseForApproval).
          if (nodeRuntime?.awaitingApproval === true) {
            state.awaiting = {
              boundInputs: inputValidation.output,
              nodeDocIds,
              persistedInput,
            };
            state.status = EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval;
            return;
          }

          if (nodeRuntime?.rejectedInput instanceof Error) {
            preflightRejection = nodeRuntime.rejectedInput;
            nodeRuntime = null;
          }
        }

        // A malformed binding must not execute the skill or consume call
        // budget. The node still enters the lifecycle and fails under its
        // declared failure policy.
        budget = inputValidation.ok && !preflightRejection && contract.budgetKey
          ? reserveBudget(budgetState, contract.budgetKey, 1)
          : null;

        if (budget && !budget.ok) {
          recordSkip({ budget, reason: EXECUTION_GRAPH_SKIP_REASONS.budgetExhausted, state });
          addBudgetLimitTrace({ reason: budget.reason, tool: skill.label });
          return;
        }

        result = await runLifecycleStep({
          buildError: buildSkillStepError,
          buildOutput: buildSkillStepOutput,
          execute: async () => {
            // Enforce the input gate in the scheduler itself. Observability
            // adapters may be injected or replaced; none may receive an
            // invalid bound input or invoke the real Skill with it.
            if (!inputValidation.ok || preflightRejection) {
              const invalidResult = buildFailedSkillResult(
                skill,
                preflightRejection ?? createSkillInputContractError(inputValidation.errors)
              );

              // Preserve the per-Skill failure observation without treating a
              // preflight rejection as an executed or budgeted call.
              recordSkippedSkill({
                budget: null,
                phase: "primary",
                result: invalidResult,
                skill,
                status: "failed",
              });

              return invalidResult;
            }

            const observedResult = await executeObservedSkill(
              skill,
              {
                ...resolvedInputs,
                accessScope,
                ...(nodeRuntime?.capabilityApproval
                  ? { approval: nodeRuntime.capabilityApproval }
                  : {}),
                capabilityRegistry,
                docIds: nodeDocIds,
                priorFindings: resolvedInputs.priorFindings,
                question: nodeQuestion,
                ragService,
                retrievalPlan: nodeRetrievalPlan,
                services: nodeRuntime?.services ?? services,
                sessionId,
                userId,
              },
              {
                budget,
                phase: "primary",
                validateInput: () => inputValidation,
                validateOutput: (output) =>
                  validateSkillValues({ output, schema: contract.outputSchema }),
              }
            );

            if (!observedResult?.ok) {
              return observedResult;
            }

            // The regular tracker validates the raw skill return. This
            // second check protects the runner when an injected observer or
            // an older adapter does not implement that optional hook.
            const validation = validateSkillValues({
              allowNestedValue: observedResult.graphOutput === undefined,
              output: observedResult.graphOutput ?? observedResult,
              schema: contract.outputSchema,
            });

            if (!validation.ok) {
              return buildFailedSkillResult(
                skill,
                createSkillOutputContractError(validation.errors)
              );
            }

            observedResult.graphOutput = {
              ...validation.output,
              // Keep the typed envelope identical to the normalized result
              // that answer synthesis and traces consume.
              ...(Object.hasOwn(validation.output, "abstained")
                ? { abstained: observedResult.abstained }
                : {}),
              ...(Object.hasOwn(validation.output, "citations")
                ? { citations: observedResult.citations }
                : {}),
              ...(Object.hasOwn(validation.output, "text")
                ? { text: observedResult.text }
                : {}),
            };

            if (
              contract.id === AGENT_SKILL_IDS.documentRag &&
              !hasConsistentDocumentRagGraphResult(observedResult)
            ) {
              return buildFailedSkillResult(
                skill,
                createSkillOutputContractError([
                  "Document RAG graph evidence does not match its raw result",
                ])
              );
            }

            return observedResult;
          },
          id: stepId,
          input: persistedInput,
          label: skill.label,
          stepLifecycle: graphStepLifecycle,
          type: stepType,
        });
      } catch (error) {
        // An interrupt means the node never consumed its call: the run pauses
        // and this node executes again on resume, so hand the reservation back
        // rather than charging the user twice for one approval gate.
        if (isAgentRunInterrupt(error) && contract.budgetKey && budget?.ok) {
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
      const settledStatus = result.ok
        ? EXECUTION_GRAPH_NODE_STATUSES.completed
        : EXECUTION_GRAPH_NODE_STATUSES.failed;
      recordSkillResult(result);

      if (result.ok) {
        nodeOutputs.set(node.nodeId, result.graphOutput);
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
        type: stepType,
      });

      // A durable checkpoint must settle before any dependent node is
      // eligible to run. This hook is deliberately after the ordinary step
      // lifecycle and trace, but still inside the in-flight node promise.
      // Keep the scheduler-visible status `running` until the write resolves:
      // an unrelated parallel node may finish and wake the scheduling loop.
      await onNodeSettled({
        graph,
        nodeRun: buildNodeRun({ ...state, status: settledStatus }),
      });
      state.status = settledStatus;
    })();

    const tracked = task.catch((error) => {
      // Promise.race can resolve from a successful sibling in the same turn
      // that this node's checkpoint rejects. Keep the rejection independent of
      // the in-flight map, because finally removes settled promises from it.
      fatalError ??= error;
      aborted = true;
      throw error;
    }).finally(() => {
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
    if (fatalError) {
      await Promise.allSettled(inFlight.values());
      throw fatalError;
    }

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

      if (interrupt && graph.version === EXECUTION_GRAPH_VERSIONS.v3) {
        // A pre-execution approval gate leaves the heterogeneous graph at a
        // clean pending node boundary. Do not fabricate skipped receipts for
        // work that must remain eligible after the dedicated continuation.
        continue;
      }

      if (aborted || interrupt) {
        recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure, state });
        progressed = true;
        continue;
      }

      // A v2 condition is a validated boolean dependency output. Its source
      // node has finished and its checkpoint has settled before this state is
      // eligible; a false branch spends no budget and starts no lifecycle step.
      const when = state.node.when;

      if (
        when &&
        nodeOutputs.get(when.nodeId)?.[when.output] !== when.equals
      ) {
        recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.conditionNotMet, state });
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
      try {
        await Promise.race(inFlight.values());
      } catch (error) {
        fatalError ??= error;
      }

      if (fatalError) {
        // A checkpoint failure must stop scheduling. Other already-running
        // nodes may settle; await them so their persistence errors cannot be
        // left unhandled while no dependent is launched.
        await Promise.allSettled(inFlight.values());
        throw fatalError;
      }
      continue;
    }

    if (!progressed) {
      break;
    }
  }

  // A rejected sibling may already have been removed from inFlight by the
  // time a successful Promise.race winner resumes the loop.
  if (fatalError) {
    throw fatalError;
  }

  if (interrupt) {
    interrupt.executionGraphNodeRuns = states.map(buildNodeRun);
    throw interrupt;
  }

  const awaiting = states.filter(
    (state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval
  );

  if (awaiting.length > 0) {
    // A graph that already failed a node will not complete, so asking the
    // user to approve more work in it would only defer the failure.
    if (
      aborted ||
      states.some((state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.failed)
    ) {
      for (const state of awaiting) {
        recordSkip({ reason: EXECUTION_GRAPH_SKIP_REASONS.abortedAfterFailure, state });
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

      const [state] = awaiting;

      // Every in-flight node has settled and checkpointed. The hook persists
      // the gate against that checkpoint and throws the run's interrupt.
      await pauseForApproval({
        boundInputs: state.awaiting.boundInputs,
        graph,
        node: state.node,
        nodeDocIds: state.awaiting.nodeDocIds,
        nodeRuns: states.map(buildNodeRun),
        skill: state.skill,
      });

      const error = new Error("The approval pause did not interrupt the graph.");
      error.code = "AGENT_UNIFIED_GRAPH_APPROVAL_UNAVAILABLE";
      error.status = 409;
      throw error;
    }
  }

  const nodeRuns = states.map(buildNodeRun);
  const results = states
    .filter((state) => state.result)
    .map((state) => state.result);
  const benignTerminal = (state) => {
    if (!state) {
      return false;
    }

    if (SETTLED_OK.has(state.status)) {
      return true;
    }

    if (state.status !== EXECUTION_GRAPH_NODE_STATUSES.skipped) {
      return false;
    }

    // A false condition and a rejected approval are decisions, not failures:
    // the graph completes without that node.
    if (
      state.reason === EXECUTION_GRAPH_SKIP_REASONS.conditionNotMet ||
      state.reason === EXECUTION_GRAPH_SKIP_REASONS.approvalDenied
    ) {
      return true;
    }

    const dependencies = (state.node.dependsOn ?? []).map((nodeId) =>
      statesByNodeId.get(nodeId)
    );

    return state.reason === EXECUTION_GRAPH_SKIP_REASONS.dependencySkipped &&
      dependencies.some((dependency) =>
        dependency?.status === EXECUTION_GRAPH_NODE_STATUSES.skipped
      ) &&
      dependencies.every(benignTerminal);
  };
  const status = states.every(benignTerminal)
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
