import { getRemainingBudget } from "./agent-budget.js";
import { runCustomSkills } from "./agent-custom-skill-runner.js";
import { createAgentExecutionGraphResult } from "./agent-dag-planner-adapter.js";
import { EXECUTION_GRAPH_LIMITS } from "./agent-execution-graph.js";
import {
  EXECUTION_GRAPH_RUN_STATUSES,
  runExecutionGraph,
} from "./agent-execution-graph-runner.js";
import { isAgentRunInterrupt } from "./agent-interrupts.js";
import { runShadowPlanner, sameStringList } from "./agent-planner-shadow.js";
import { REPLAN_DECISIONS, createReplanResult } from "./agent-replanner.js";
import { getAgentSkillGraphRollout } from "./config.js";

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
  budgetState,
  buildSkillTraceDetail,
  customSkills = [],
  docIds = [],
  executeObservedSkill,
  limits = EXECUTION_GRAPH_LIMITS,
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
  sessionId,
  stepLifecycle,
  taskMemory = null,
  userId,
} = {}) => {
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

  if (mode === CUSTOM_SKILL_STAGE_MODES.off || customSkills.length === 0) {
    return runV1();
  }

  const effectiveLimits = { ...EXECUTION_GRAPH_LIMITS, ...limits };
  const scopedDocIds = authorizedDocIds ?? docIds;
  const planGraph = (budgetRemaining) =>
    createAgentExecutionGraphResult({
      authorizedDocIds: scopedDocIds,
      budgetRemaining,
      limits: effectiveLimits,
      ...(plannerAdapter ? { plannerAdapter } : {}),
      plannerContext: { docIds, plan, question, taskMemory },
      registry,
      selectedSkills: customSkills,
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
      execute: () => planGraph(budgetRemaining),
      primary: results.map((result) => result.skillId),
      shadowPlannerAdapter: plannerAdapter ?? { id: "deterministic_dag" },
    });

    recordExecutionGraph({
      ...shadow,
      executed: false,
      fallback: null,
      mode,
      nodeRuns: [],
      replans: [],
    });

    return results;
  }

  const planned = await planGraph(getRemainingBudget(budgetState));

  if (!planned.graph) {
    // Rejected as a whole, which means nothing has run and nothing has been
    // charged. This is the only moment where handing the request back to the
    // V1 chain is safe, and it is why V1 has to stay until the gates close.
    recordExecutionGraph({
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

  const runGraph = (graph, completedNodeRuns = []) =>
    runExecutionGraph({
      accessScope,
      addBudgetLimitTrace,
      addTraceStep,
      authorizedDocIds: scopedDocIds,
      authorizedSkillIds: customSkills.map((skill) => skill.id),
      budgetState,
      buildSkillTraceDetail,
      completedNodeRuns,
      docIds,
      executeObservedSkill,
      graph,
      limits: effectiveLimits,
      maxConcurrency,
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

  const replans = [];
  let fingerprints = [];
  let graph = planned.graph;
  let run;

  try {
    run = await runGraph(graph);

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
        selectedSkills: customSkills,
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
      run = await runGraph(graph, replan.completedNodeRuns);
    }
  } catch (error) {
    if (isAgentRunInterrupt(error)) {
      // Resume needs to know which nodes are already settled, so the graph is
      // recorded before the interrupt continues upward. The stage does not
      // retry and does not fall back: the approval the user is about to see is
      // bound to the input this node was given.
      recordExecutionGraph({
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

  recordExecutionGraph({
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
