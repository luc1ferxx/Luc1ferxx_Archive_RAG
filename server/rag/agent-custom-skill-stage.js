import { getRemainingBudget } from "./agent-budget.js";
import { runCustomSkills } from "./agent-custom-skill-runner.js";
import {
  buildExecutionGraphCheckpointOwner,
  createExecutionGraphCheckpoint,
  reconcileExecutionGraphCheckpoint,
  snapshotExecutionGraphNodeRun,
  updateExecutionGraphCheckpoint,
  verifyExecutionGraphCheckpoint,
} from "./agent-execution-graph-checkpoint.js";
import { createAgentExecutionGraphResult } from "./agent-dag-planner-adapter.js";
import {
  EXECUTION_GRAPH_LIMITS,
  validateExecutionGraph,
} from "./agent-execution-graph.js";
import {
  EXECUTION_GRAPH_RUN_STATUSES,
  runExecutionGraph,
} from "./agent-execution-graph-runner.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import { runShadowPlanner, sameStringList } from "./agent-planner-shadow.js";
import { REPLAN_DECISIONS, createReplanResult } from "./agent-replanner.js";
import { getAgentSkillGraphRollout } from "./config.js";
import { setSpanAttributes, withSpan } from "./tracing.js";

// The migration incision.
//
// The agent's execution plan still has exactly one custom_skills stage, still
// emits custom_skill steps, and still hands the rest of the run a flat array of
// skill results. What changes is the inside of that stage: instead of a
// sequential chain that splices earlier answers into the next skill's question,
// it can compile a typed DAG and let the scheduler decide what runs together.
//
// The rollout dial is the whole point of this file existing separately.
// `off` is the V1 chain untouched, `shadow` plans a graph beside the real run
// so the two can be compared on live traffic without risking an answer, and
// `guarded` executes the graph with V1 kept as the fallback for the one case
// where falling back is still safe: a graph rejected before any node ran.
//
// There is deliberately no fallback after partial execution. Once a node has
// spent budget and written a step, re-running the chain would repeat that work
// under a different plan and bill the user twice for one request.

const noop = () => {};

export const CUSTOM_SKILL_STAGE_MODES = Object.freeze({
  guarded: "guarded",
  off: "off",
  shadow: "shadow",
});

const describeGraph = (graph) =>
  graph
    ? {
        nodeIds: graph.nodes.map((node) => node.nodeId),
        version: graph.version,
      }
    : null;

/**
 * Drops the skill result from a node run before it reaches the observability
 * sink. The retrieved text and its citations already travel with the trace
 * step; copying them here would duplicate the evidence in a second place that
 * nothing verifies against.
 */
const serializeNodeRun = ({ result, ...run }) => ({
  ...run,
  abstained: Boolean(result?.abstained),
  ok: Boolean(result?.ok),
});

const serializeReplan = (replan) => ({
  decision: replan.decision,
  errorCodes: (replan.errors ?? []).map((error) => error.code),
  nodeIds: describeGraph(replan.graph)?.nodeIds ?? [],
  reason: replan.reason ?? null,
  reasonCode: replan.reasonCode ?? null,
  replanCount: replan.replanCount,
  trigger: replan.trigger ?? null,
});

export const runCustomSkillStage = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  authorizedDocIds = null,
  authorizedCustomSkills = null,
  budgetState,
  buildSkillTraceDetail,
  customSkills = [],
  docIds = [],
  executeObservedSkill,
  expectedGraphResumeClaimId = null,
  limits = EXECUTION_GRAPH_LIMITS,
  loadExecutionGraphCheckpoint = null,
  maxConcurrency,
  mode = getAgentSkillGraphRollout(),
  plan,
  plannerAdapter = null,
  question,
  ragService,
  recordExecutionGraph = noop,
  recordSkillResult = noop,
  recordSkippedSkill = noop,
  registry,
  replanAdapter = null,
  retrievalPlan,
  saveExecutionGraphCheckpoint = null,
  sessionId,
  stepLifecycle,
  taskMemory = null,
  userId,
} = {}) => {
  const graphSkills = Array.isArray(authorizedCustomSkills)
    ? authorizedCustomSkills
    : customSkills;
  const runV1 = () =>
    runCustomSkills({
      accessScope,
      addBudgetLimitTrace,
      addTraceStep,
      budgetState,
      buildSkillTraceDetail,
      customSkills,
      docIds,
      executeObservedSkill,
      plan,
      question,
      ragService,
      recordSkillResult,
      recordSkippedSkill,
      retrievalPlan,
      sessionId,
      stepLifecycle,
      userId,
    });

  if (
    mode === CUSTOM_SKILL_STAGE_MODES.off ||
    (customSkills.length === 0 && graphSkills.length === 0)
  ) {
    return runV1();
  }

  const effectiveLimits = { ...EXECUTION_GRAPH_LIMITS, ...limits };
  const scopedDocIds = authorizedDocIds ?? docIds;
  const planGraph = (budgetRemaining) =>
    withSpan("agent.plan skill_graph", { "agent.planner.kind": "skill_graph" }, async (span) => {
      const planned = await createAgentExecutionGraphResult({
        authorizedDocIds: scopedDocIds,
        budgetRemaining,
        limits: effectiveLimits,
        ...(plannerAdapter ? { plannerAdapter } : {}),
        plannerContext: { docIds, plan, question, taskMemory },
        registry,
        selectedSkills: graphSkills,
        fallbackSelectedSkills: customSkills,
      });

      setSpanAttributes(span, {
        "agent.graph.accepted": Boolean(planned?.graph),
        "agent.graph.node_count": planned?.graph?.nodes?.length,
        "agent.planner.fallback": Boolean(planned?.planner?.fallback),
        "agent.planner.id": planned?.planner?.selectedPlannerId,
      });

      return planned;
    });

  if (mode === CUSTOM_SKILL_STAGE_MODES.shadow) {
    // Snapshot the budget before V1 spends it. A shadow plan is meant to answer
    // "what would the graph runtime have done with this request", and validating
    // it against the leftovers of the chain that just ran would reject every
    // plan as over budget and make the comparison worthless.
    const budgetRemaining = getRemainingBudget(budgetState);
    const results = await runV1();
    // The real answer is already finished. Everything below is comparison
    // material, and runShadowPlanner guarantees that a bug in it surfaces as a
    // recorded error rather than as a failed request.
    const shadow = await runShadowPlanner({
      compare: ({ primary, shadow: shadowResult }) =>
        !sameStringList(
          primary,
          (shadowResult?.graph?.nodes ?? []).map((node) => node.skillId)
        ),
      describe: (shadowResult) => ({
        errorCodes: (shadowResult?.errors ?? []).map((error) => error.code),
        graph: describeGraph(shadowResult?.graph),
        planner: shadowResult?.planner ?? null,
      }),
      execute: () => {
        if (typeof registry?.get !== "function") {
          throw new Error("Skill registry unavailable for shadow graph validation.");
        }

        return planGraph(budgetRemaining);
      },
      primary: results.map((result) => result.skillId),
      shadowPlannerAdapter: plannerAdapter ?? { id: "deterministic_dag" },
    });

    try {
      await recordExecutionGraph({
        ...shadow,
        executed: false,
        fallback: null,
        mode,
        nodeRuns: [],
        replans: [],
      });
    } catch {
      // Shadow is observational: a failed event write must not turn an
      // already-completed V1 answer into an error. Keep the loss visible in
      // the request trace without exposing storage details or source text.
      addTraceStep({
        type: "skill_graph_shadow_observation",
        label: "Shadow graph observation",
        status: "failed",
        summary: "Shadow graph event could not be persisted.",
      });
    }

    return results;
  }

  const loadedCheckpoint = await loadExecutionGraphCheckpoint?.();
  const persistedCheckpoint = loadedCheckpoint?.checkpoint ?? null;
  let completedNodeRuns = [];
  let checkpoint = null;

  if (
    (persistedCheckpoint?.resumeClaim?.claimId ?? null) !==
    expectedGraphResumeClaimId
  ) {
    const error = new Error(
      "Execution graph checkpoint is owned by another executor."
    );
    error.code = "AGENT_GRAPH_EXECUTION_FENCED";
    error.status = 409;
    throw error;
  }

  if (persistedCheckpoint) {
    const verified = verifyExecutionGraphCheckpoint({
      accessScope,
      budgetState,
      checkpoint: persistedCheckpoint,
      docIds,
      plan,
      question,
      retrievalPlan,
      selectedSkills: graphSkills,
      sessionId,
      taskMemory,
      userId,
    });
    const graphValidation = verified.ok
      ? validateExecutionGraph({
          authorizedDocIds: scopedDocIds,
          authorizedSkillIds: graphSkills.map((skill) => skill.id),
          graph: persistedCheckpoint.graph,
          limits: effectiveLimits,
          registry,
        })
      : null;
    const reconciled = verified.ok && graphValidation?.ok
      ? reconcileExecutionGraphCheckpoint({
          checkpoint: persistedCheckpoint,
          steps: loadedCheckpoint.steps,
        })
      : verified.ok
        ? { ok: false, reason: "checkpoint_graph_invalid" }
        : verified;

    if (!reconciled.ok) {
      const error = new Error(
        `Execution graph checkpoint cannot be resumed: ${reconciled.reason}.`
      );
      error.code = "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY";
      error.status = 409;
      throw error;
    }

    checkpoint = persistedCheckpoint;
    completedNodeRuns = reconciled.completedNodeRuns;

    // The budget object is recreated on process restart. Charge every
    // persisted attempt, including a read that was in flight when the process
    // stopped, before allowing a pending node to reserve anything new.
    const attemptedByBudgetKey = new Map();

    for (const [budgetKey, initial] of Object.entries(
      checkpoint.owner.budget.usedAtEntry
    )) {
      budgetState.used[budgetKey] = Math.max(
        Number(budgetState.used[budgetKey] ?? 0),
        initial
      );
    }

    for (const step of loadedCheckpoint.steps ?? []) {
      if (!String(step?.id ?? "").startsWith("custom_skill:")) {
        continue;
      }

      const budgetKey = registry?.get?.(step.input?.skillId)?.budgetKey;

      if (budgetKey) {
        // A step record can represent a retried node. Conservatively charge
        // every persisted attempt before reserving budget for new nodes.
        const attemptCount = Number.isSafeInteger(step.attempt) && step.attempt > 0
          ? step.attempt
          : 1;
        attemptedByBudgetKey.set(
          budgetKey,
          (attemptedByBudgetKey.get(budgetKey) ?? 0) + attemptCount
        );
      }
    }

    for (const [budgetKey, attempted] of attemptedByBudgetKey) {
      const initial = Number(checkpoint.owner.budget.usedAtEntry[budgetKey] ?? 0);
      budgetState.used[budgetKey] = Math.max(
        Number(budgetState.used[budgetKey] ?? 0),
        initial + attempted
      );
    }

    if (["completed", "partial"].includes(checkpoint.phase)) {
      await recordExecutionGraph({
        errorCodes: [],
        executed: true,
        fallback: null,
        graph: describeGraph(checkpoint.graph),
        mode,
        nodeRuns: (checkpoint.nodeRuns ?? [])
          .filter((saved) => checkpoint.graph.nodes.some((node) => node.nodeId === saved.nodeId))
          .map((saved) =>
            serializeNodeRun({
              ...saved,
              dependsOn: checkpoint.graph.nodes.find(
                (node) => node.nodeId === saved.nodeId
              )?.dependsOn ?? [],
            })
          ),
        planner: checkpoint.planner ?? null,
        replans: checkpoint.replans ?? [],
        status: checkpoint.phase,
      });

      return checkpoint.graph.nodes
        .map((node) => completedNodeRuns.find((run) => run.nodeId === node.nodeId))
        .filter(Boolean)
        .map((run) => run.result);
    }
  }

  const planned = checkpoint
    ? { graph: checkpoint.graph, planner: checkpoint.planner ?? null }
    : await planGraph(getRemainingBudget(budgetState));

  if (!planned.graph) {
    // Rejected as a whole, which means nothing has run and nothing has been
    // charged. This is the only moment where handing the request back to the
    // V1 chain is safe, and it is why V1 has to stay until the gates close.
    await recordExecutionGraph({
      errorCodes: (planned.errors ?? []).map((error) => error.code),
      executed: false,
      fallback: "v1",
      graph: null,
      mode,
      nodeRuns: [],
      planner: planned.planner,
      replans: [],
      status: EXECUTION_GRAPH_RUN_STATUSES.rejected,
    });

    return runV1();
  }

  if (!checkpoint && saveExecutionGraphCheckpoint) {
    checkpoint = createExecutionGraphCheckpoint({
      graph: planned.graph,
      owner: buildExecutionGraphCheckpointOwner({
        accessScope,
        budgetState,
        docIds,
        plan,
        question,
        retrievalPlan,
        selectedSkills: graphSkills,
        sessionId,
        taskMemory,
        userId,
      }),
    });
    checkpoint = updateExecutionGraphCheckpoint(checkpoint, {
      planner: planned.planner,
      replans: [],
    });
    await saveExecutionGraphCheckpoint(checkpoint);
  }

  let checkpointQueue = Promise.resolve();
  const persistCheckpoint = (update) => {
    if (!checkpoint || !saveExecutionGraphCheckpoint) {
      return Promise.resolve();
    }

    checkpointQueue = checkpointQueue.then(async () => {
      const next = updateExecutionGraphCheckpoint(checkpoint, update(checkpoint));
      await saveExecutionGraphCheckpoint(next);
      checkpoint = next;
    });

    return checkpointQueue;
  };

  const runGraph = (graph, settledRuns = []) =>
    runExecutionGraph({
      accessScope,
      addBudgetLimitTrace,
      addTraceStep,
      authorizedDocIds: scopedDocIds,
      authorizedSkillIds: graphSkills.map((skill) => skill.id),
      budgetState,
      buildSkillTraceDetail,
      completedNodeRuns: settledRuns,
      docIds,
      executeObservedSkill,
      graph,
      graphResumeClaimId: checkpoint ? expectedGraphResumeClaimId : undefined,
      limits: effectiveLimits,
      maxConcurrency,
      onNodeSettled: checkpoint
        ? ({ nodeRun }) =>
            persistCheckpoint((current) => ({
              nodeRuns: [
                ...(current.nodeRuns ?? []).filter(
                  (run) => run.nodeId !== nodeRun.nodeId
                ),
                snapshotExecutionGraphNodeRun(nodeRun),
              ],
            }))
        : undefined,
      question,
      ragService,
      recordSkillResult,
      recordSkippedSkill,
      registry,
      retrievalPlan,
      sessionId,
      stepLifecycle,
      userId,
    });

  const replans = [...(checkpoint?.replans ?? [])];
  let fingerprints = [...(checkpoint?.fingerprints ?? [])];
  let graph = planned.graph;
  let run;

  try {
    run = await runGraph(graph, completedNodeRuns);

    while (replanAdapter) {
      const replan = await createReplanResult({
        authorizedDocIds: scopedDocIds,
        budgetRemaining: getRemainingBudget(budgetState),
        fingerprints,
        graph,
        limits: effectiveLimits,
        nodeRuns: run.nodeRuns,
        question,
        registry,
        replanAdapter,
        replanCount: replans.length,
        selectedSkills: graphSkills,
      });

      replans.push(serializeReplan(replan));
      // Carrying the fingerprints forward is what makes the loop bounded even
      // if maxReplans were ever raised: a patch that recreates a plan already
      // tried is refused rather than run again.
      fingerprints = replan.fingerprints;

      if (replan.decision !== REPLAN_DECISIONS.applied) {
        break;
      }

      graph = replan.graph;
      await persistCheckpoint(() => ({
        fingerprints,
        graph,
        replanCount: replans.length,
        replans,
      }));
      run = await runGraph(graph, replan.completedNodeRuns);
    }
  } catch (error) {
    if (isAgentRunInterrupt(error)) {
      // Resume needs to know which nodes are already settled, so the graph is
      // recorded before the interrupt continues upward. The stage does not
      // retry and does not fall back: the approval the user is about to see is
      // bound to the input this node was given.
      await recordExecutionGraph({
        errorCodes: [],
        executed: true,
        fallback: null,
        graph: describeGraph(graph),
        mode,
        nodeRuns: (error.executionGraphNodeRuns ?? []).map(serializeNodeRun),
        planner: planned.planner,
        replans,
        status: "interrupted",
      });
    }

    throw error;
  }

  await persistCheckpoint((current) => ({
    fingerprints,
    graph,
    nodeRuns: [
      ...(current.nodeRuns ?? []).filter(
        (saved) => !run.nodeRuns.some((current) => current.nodeId === saved.nodeId)
      ),
      ...run.nodeRuns.map(snapshotExecutionGraphNodeRun),
    ],
    phase: run.ok ? "completed" : "partial",
    replanCount: replans.length,
    replans,
  }));

  await recordExecutionGraph({
    errorCodes: (run.errors ?? []).map((error) => error.code),
    executed: true,
    fallback: null,
    graph: describeGraph(graph),
    mode,
    nodeRuns: run.nodeRuns.map(serializeNodeRun),
    planner: planned.planner,
    replans,
    status: run.status,
  });

  return run.results;
};
