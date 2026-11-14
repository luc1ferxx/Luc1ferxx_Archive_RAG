import { getRemainingBudget } from "./agent-budget.js";
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
import { EXECUTION_GRAPH_RUN_STATUSES } from "./agent-execution-graph-runner.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import { REPLAN_DECISIONS, createReplanResult } from "./agent-replanner.js";
import { getAgentRunStepLifecycleTarget } from "./agent-run-step-lifecycle.js";
import { assertAgentRuntimeSupported } from "./config.js";
import { assertLangSmithTracingDisabled } from "./langgraph/langsmith-guard.js";
import { buildFailedSkillResult } from "./skills/registry.js";
import { setSpanAttributes, withSpan } from "./tracing.js";

// The custom_skills stage.
//
// The agent's execution plan has exactly one custom_skills stage, it emits
// custom_skill steps, and it hands the rest of the run a flat array of skill
// results. Inside, the stage plans a typed DAG over the Skills the runtime
// authorized for this request and LangGraph schedules it
// (langgraph/run-execution-graph.js, docs/adr/0001-langgraph-runtime.md).
//
// There is no other executor. The V1 sequential chain, which ran the selected
// Skills one after another and spliced earlier answers into the next Skill's
// question, was this stage's first form and then its fallback for a graph
// rejected before any node ran. ADR 0001 phase 8 deleted it, together with
// the AGENT_SKILL_GRAPH_ROLLOUT values that selected it (`off`, `shadow`).
// What the chain did is the graph's own business now:
//
// - The deterministic graph plans what the chain ran: one node per selected
//   Skill, in selection order, each handing its findings to the next as a
//   typed input (agent-dag-planner-adapter.js). It is not rejected for the
//   call budget when it is planned. The executor reserves the budget per node
//   at launch and skips a node it cannot pay for, which is what the chain did
//   per Skill, so a budget that covers one of two selected Skills still runs
//   that one. Two things differ from the chain, and already did in every
//   graph run before the deletion: a Skill whose predecessor failed or was
//   skipped does not run (it depends on that node's findings; the chain ran
//   it on the original question), and a node skipped at launch leaves no
//   entry in the result array.
// - A graph rejected for any other reason (a selected Skill the runtime did
//   not authorize for this request, a limit) runs nothing. Each selected
//   Skill is reported as not run, with the validator's reason, and the
//   request goes on without them.
//
// There is deliberately no second attempt under another plan after partial
// execution either. Once a node has spent budget and written a step, running
// its Skill again would repeat that work and bill the user twice for one
// request.

const noop = () => {};

// Every graph event carries the mode it ran under. `guarded` is the only one
// there is; the field stays because stored runs hold it and the replay guard,
// recovery and the reports read it (agent-run-graph-replay-guard.js).
export const CUSTOM_SKILL_GRAPH_MODE = "guarded";

export const AGENT_SKILL_GRAPH_REJECTED_CODE = "AGENT_SKILL_GRAPH_REJECTED";

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

/**
 * A graph rejected before any node ran leaves the selected Skills unrun.
 * Nothing was charged and nothing will run in its place, so each selected
 * Skill gets a failed result naming the validator's reason: the response lists
 * it as not run instead of leaving it out, and one trace step says why the
 * stage did nothing. With no Skill selected there is nothing to report.
 */
const reportSkillsNotRun = ({
  addTraceStep,
  customSkills,
  errorCodes,
  recordSkillResult,
  recordSkippedSkill,
}) => {
  if (customSkills.length === 0) {
    return [];
  }

  const reasonCodes = [...new Set(errorCodes)];
  const reason = reasonCodes.length > 0
    ? `no legal execution graph (${reasonCodes.join(", ")})`
    : "no legal execution graph";
  const results = customSkills.map((skill) => {
    const error = new Error(`${skill.label} was not run: ${reason}.`);
    error.code = AGENT_SKILL_GRAPH_REJECTED_CODE;

    const result = buildFailedSkillResult(skill, error);

    recordSkillResult(result);
    recordSkippedSkill({ budget: null, phase: "primary", result, skill });

    return result;
  });

  addTraceStep({
    detail: {
      reasonCodes,
      skillIds: customSkills.map((skill) => skill.id),
    },
    label: "Skill graph rejected",
    status: "skipped",
    summary: `Skipped ${customSkills.map((skill) => skill.label).join(", ")}: ${reason}.`,
    type: "skill_graph_rejected",
  });

  return results;
};

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
  const mode = CUSTOM_SKILL_GRAPH_MODE;
  const graphSkills = Array.isArray(authorizedCustomSkills)
    ? authorizedCustomSkills
    : customSkills;

  // Nothing selected and nothing authorized: there is no graph to plan.
  if (customSkills.length === 0 && graphSkills.length === 0) {
    return [];
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

  // Refused before anything durable exists: a request that cannot run on
  // LangGraph must not leave a graph checkpoint for recovery to resume. The
  // executor checks again at its own entry. A removed AGENT_RUNTIME or
  // AGENT_OUTER_PLAN_RUNTIME value asked for a native scheduler, and a removed
  // AGENT_SKILL_GRAPH_ROLLOUT value (`off`, `shadow`) asked for the sequential
  // chain; neither exists any more, and running the graph on LangGraph instead
  // would ignore the request silently.
  assertLangSmithTracingDisabled();
  assertAgentRuntimeSupported();
  // Imported on first use. That keeps the graph executor and compiler out of
  // a process that never runs a custom-Skill graph; LangGraph itself is loaded by
  // then in any process that answers agent requests, because the outer plan
  // that reached this stage runs on it (ADR 0001 phase 7). The api edge of a
  // split deployment runs no agent and loads neither.
  const { runExecutionGraphOnLangGraph: executeGraph } = await import(
    "./langgraph/run-execution-graph.js"
  );

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
    // Rejected as a whole: nothing has run and nothing has been charged, and
    // nothing runs in the graph's place. `fallback` stays in the event (the
    // replay guard and the reports read it) and is always null.
    const errorCodes = (planned.errors ?? []).map((error) => error.code);

    await recordExecutionGraph({
      errorCodes,
      executed: false,
      fallback: null,
      graph: null,
      mode,
      nodeRuns: [],
      planner: planned.planner,
      replans: [],
      status: EXECUTION_GRAPH_RUN_STATUSES.rejected,
    });

    return reportSkillsNotRun({
      addTraceStep,
      customSkills,
      errorCodes,
      recordSkillResult,
      recordSkippedSkill,
    });
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

  // The save that settles the graph (phase completed or partial) also drops
  // the run's LangGraph thread record in the same CAS
  // (saveExecutionGraphCheckpoint's dropLangGraphRecord): the record rides on
  // the run row, so a thread kept after the graph settled would be rewritten
  // whole
  // by every later CAS of the run (the finalizer's steps, completeRun) and
  // stored with the finished run, while nothing ever resumes a settled
  // graph's thread (a replan or a recovery starts a fresh invocation, and a
  // settled graph is replayed from the graph checkpoint without one). A
  // running graph keeps its thread. On a run that holds no record (a graph
  // run without a graph checkpoint, and so without a checkpointer) the flag
  // changes nothing.
  let checkpointQueue = Promise.resolve();
  const persistCheckpoint = (update, { settles = false } = {}) => {
    if (!checkpoint || !saveExecutionGraphCheckpoint) {
      return Promise.resolve();
    }

    checkpointQueue = checkpointQueue.then(async () => {
      const next = updateExecutionGraphCheckpoint(checkpoint, update(checkpoint));
      await (settles
        ? saveExecutionGraphCheckpoint(next, { dropLangGraphRecord: true })
        : saveExecutionGraphCheckpoint(next));
      checkpoint = next;
    });

    return checkpointQueue;
  };

  // LangGraph checkpoints its thread into the run whose graph checkpoint this
  // stage keeps, and only then: that checkpoint is what recovery, reuse and
  // fencing are decided from, so a thread record without one would be state
  // nothing can trust. The run, scope and cursor are the ones the node steps
  // are written with (getAgentRunStepLifecycleTarget).
  const langGraphRun = checkpoint
    ? getAgentRunStepLifecycleTarget(stepLifecycle)
    : null;

  const runGraph = (graph, settledRuns = []) =>
    executeGraph({
      ...(langGraphRun
        ? {
            agentRunId: langGraphRun.runId,
            agentRunService: langGraphRun.agentRunService,
            runCursor: langGraphRun.runCursor,
          }
        : {}),
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
  }), { settles: true });

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
