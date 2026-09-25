import { runAgentRag } from "../../../rag/agent.js";
import { DAG_PLANNER_IDS } from "../../../rag/agent-dag-planner-adapter.js";
import { EXECUTION_GRAPH_REASON_CODES } from "../../../rag/agent-execution-graph.js";
import {
  EXECUTION_GRAPH_NODE_STATUSES,
} from "../../../rag/agent-execution-graph-runner.js";
import {
  REPLAN_DECISIONS,
  REPLAN_REASON_CODES,
  REPLAN_TRIGGERS,
} from "../../../rag/agent-replanner.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../../../rag/agent-runs.js";
import { CUSTOM_SKILL_IDS } from "../../../rag/skills/registry.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
} from "../../../rag/skills/skill-contract.js";
import {
  getBudget,
  getChatResponseBody,
  getSkillChainIds,
  getTraceSteps,
  getTraceTypes,
} from "../../chat-response-contract.js";
import {
  buildScopedRagService,
  buildSource,
  createEvalTelemetry,
  withEnvironmentOverrides,
} from "../../agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  buildTrajectoryCheck as buildCheck,
  finishTrajectoryCase as finishCase,
  sameTrajectoryScope as sameScope,
} from "../checks.js";

// The custom skill stage has two execution paths behind one rollout dial, and
// the /chat response is deliberately identical for both. That is the point of
// the migration -- and it is also why a passing trajectory report on the
// default `off` setting says nothing about the graph. These cases pin the dial
// per case, then read the `skill_graph_planned` run event, which is the only
// place the two paths are distinguishable from the outside.
//
// Each case also records the one artefact the response cannot show: which
// question the second skill actually received. The V1 chain splices earlier
// answers into it under one header; the graph hands them over as a typed
// priorFindings input, and the skill renders that under a different header.

const SKILL_GRAPH_EVENT_TYPE = "skill_graph_planned";
const CUSTOM_SKILL_STEP_TYPE = "custom_skill";
const DOC_ID = "contract-1";
const QUESTION = "Review this contract for risks and key terms.";
const RETRY_NODE_ID = "risk_review_retry";
const FORGED_NODE_IDS = ["forged_summary", "exfiltrate"];
const EXPECTED_NODE_IDS = [
  CUSTOM_SKILL_IDS.summarizeContract,
  CUSTOM_SKILL_IDS.riskReview,
];
const EXPECTED_AUTHORIZED_SKILL_IDS = [
  CUSTOM_SKILL_IDS.compareDocuments,
  CUSTOM_SKILL_IDS.extractTimeline,
  CUSTOM_SKILL_IDS.riskReview,
  CUSTOM_SKILL_IDS.summarizeContract,
].sort();
const V1_TRACE_TYPES = [
  "plan",
  "query_planner",
  "skill_chain",
  "custom_skill",
  "custom_skill",
  "synthesis",
  "self_check",
  "answer_finalizer",
];
// What buildDagPlanningContext / buildReplanContext are allowed to hand a
// model. A context with any other key has crossed the redaction boundary.
const PLANNER_CONTEXT_KEYS = [
  "authorizedDocIds",
  "capabilities",
  "documentCount",
  "goal",
  "intentPlan",
  "limits",
  "taskMemoryPlanningContext",
];
const REPLAN_CONTEXT_KEYS = [
  "authorizedDocIds",
  "capabilities",
  "goal",
  "graph",
  "limits",
  "nodeRuns",
  "trigger",
];
const REPLAN_NODE_RUN_KEYS = [
  "abstained",
  "citationCount",
  "nodeId",
  "reason",
  "skillId",
  "status",
];
const CHAINED_QUESTION_PATTERN = /Previous skill outputs/;
const TYPED_UPSTREAM_PATTERN = /Upstream findings from an earlier step/;
const RISK_QUESTION_PATTERN = /risk review|risks?|gaps?|exceptions?/i;
const EVIDENCE_TEXT = "Late notice creates renewal risk";

const buildNodeStepId = (nodeId) => `${CUSTOM_SKILL_STEP_TYPE}:${nodeId}`;

const sameList = (left = [], right = []) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const sortedKeys = (value) => Object.keys(value ?? {}).sort();

const requestBinding = (field) => ({ field, source: "request" });

const nodeBinding = (nodeId, output) => ({ nodeId, output, source: "node" });

// Anything that would identify the caller or repeat retrieved evidence. A
// planner or replanner context that contains one of these has been handed
// more than a plan needs.
const leaksScopeOrEvidence = (value) => {
  const serialized = JSON.stringify(value ?? null);

  return [
    DEFAULT_ACCESS_SCOPE.userId,
    DEFAULT_ACCESS_SCOPE.workspaceId,
    EVIDENCE_TEXT,
  ].some((marker) => serialized.includes(marker));
};

const createContractRagService = ({ abstainOnCall = null, telemetry }) => {
  const citation = buildSource({
    docId: DOC_ID,
    fileName: "services-agreement.pdf",
    pageNumber: 3,
    excerpt:
      `Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice. ${EVIDENCE_TEXT}.`,
  });

  return buildScopedRagService({
    sameScope,
    documents: [
      {
        docId: DOC_ID,
        fileName: "services-agreement.pdf",
      },
    ],
    telemetry,
    chat: async ({ callIndex, question }) => {
      if (callIndex === abstainOnCall) {
        return {
          text: "",
          citations: [],
          abstained: true,
          resolvedQuery: question,
          memoryApplied: false,
        };
      }

      return {
        text: RISK_QUESTION_PATTERN.test(question)
          ? [
              "Risk Review",
              `- Risk: ${EVIDENCE_TEXT}. [Source 1]`,
            ].join("\n")
          : [
              "Contract Summary",
              "- Parties: Acme and Beta signed a services agreement. [Source 1]",
            ].join("\n"),
        citations: [citation],
        abstained: false,
        resolvedQuery: question,
        memoryApplied: false,
      };
    },
  });
};

const runContractReview = ({
  agentBudget = null,
  agentRunService,
  mode,
  plannerAdapter = null,
  ragService,
  replanAdapter = null,
}) =>
  withEnvironmentOverrides({ AGENT_SKILL_GRAPH_ROLLOUT: mode }, () =>
    runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      ...(agentBudget ? { agentBudget } : {}),
      agentRunService,
      ...(plannerAdapter ? { dagPlannerAdapter: plannerAdapter } : {}),
      docIds: [DOC_ID],
      question: QUESTION,
      ragService,
      ...(replanAdapter ? { replanAdapter } : {}),
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({
        text: "web should not run",
      }),
    })
  );

const loadGraphRecord = async ({ agentRunService, response }) => {
  const body = getChatResponseBody(response);
  const run = await agentRunService.getRun({
    accessScope: DEFAULT_ACCESS_SCOPE,
    runId: body.agentRunId,
  });
  const events = (run?.events ?? []).filter(
    (event) => event.type === SKILL_GRAPH_EVENT_TYPE
  );

  return {
    customSkillSteps: (run?.steps ?? []).filter(
      (step) => step.type === CUSTOM_SKILL_STEP_TYPE
    ),
    eventCount: events.length,
    graph: events[0]?.payload ?? null,
  };
};

const describeNodeRuns = (graph) =>
  (graph?.nodeRuns ?? []).map((nodeRun) => ({
    citationCount: nodeRun.citationCount ?? 0,
    dependsOn: [...(nodeRun.dependsOn ?? [])],
    nodeId: nodeRun.nodeId,
    status: nodeRun.status,
    stepId: nodeRun.stepId,
  }));

const describeQuestions = (telemetry) =>
  telemetry.chatCalls.map((call) => ({
    chained: CHAINED_QUESTION_PATTERN.test(call.question),
    typedUpstream: TYPED_UPSTREAM_PATTERN.test(call.question),
  }));

const describeReplayContracts = (steps) =>
  steps.map((step) => ({
    effects: step.input?.effects ?? null,
    hasPriorFindings:
      typeof step.input?.priorFindings === "string" &&
      step.input.priorFindings.length > 0,
    idempotency: step.input?.idempotency ?? null,
    stepId: step.id,
  }));

const describeGraph = (graph) => ({
  executed: graph?.executed ?? null,
  fallback: graph?.fallback ?? null,
  mode: graph?.mode ?? null,
  nodeIds: [...(graph?.graph?.nodeIds ?? [])],
  plannerFallback: graph?.planner?.fallback ?? null,
  requestedPlannerId: graph?.planner?.requestedPlannerId ?? null,
  selectedPlannerId: graph?.planner?.selectedPlannerId ?? null,
  status: graph?.status ?? null,
});

const describeReplans = (graph) =>
  (graph?.replans ?? []).map((replan) => ({
    decision: replan.decision,
    nodeIds: [...(replan.nodeIds ?? [])],
    reasonCode: replan.reasonCode ?? null,
    replanCount: replan.replanCount,
    trigger: replan.trigger ?? null,
  }));

const customSkillTraceStepIds = (response) =>
  getTraceSteps(response, CUSTOM_SKILL_STEP_TYPE).map((step) => step.id);

const isReadOnlyContract = (contract) =>
  contract.effects === SKILL_EFFECTS.readOnly &&
  contract.idempotency === SKILL_IDEMPOTENCY.readOnlyRag;

export const createSkillGraphGuardedExecutionCase = () => ({
  id: "skill_graph_guarded_execution",
  label: "Skill graph guarded execution",
  description:
    "Under AGENT_SKILL_GRAPH_ROLLOUT=guarded a contract review runs as a typed DAG of atomic skill nodes while the /chat response keeps its V1 skill-chain contract.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const ragService = createContractRagService({ telemetry });
    const response = await runContractReview({
      agentRunService,
      mode: "guarded",
      ragService,
    });
    const body = getChatResponseBody(response);
    const record = await loadGraphRecord({ agentRunService, response });
    const graph = describeGraph(record.graph);
    const nodeRuns = describeNodeRuns(record.graph);
    const riskNode =
      nodeRuns.find((nodeRun) => nodeRun.nodeId === CUSTOM_SKILL_IDS.riskReview) ??
      null;
    const questions = describeQuestions(telemetry);
    const replayContracts = describeReplayContracts(record.customSkillSteps);
    const riskContract =
      replayContracts.find(
        (contract) => contract.stepId === buildNodeStepId(CUSTOM_SKILL_IDS.riskReview)
      ) ?? null;
    const traceStepIds = customSkillTraceStepIds(response);
    const graphFieldsInResponse = ["graph", "nodeRuns", "replans"].filter(
      (key) => key in body
    );

    return finishCase({
      id: "skill_graph_guarded_execution",
      label: "Skill graph guarded execution",
      description:
        "Under AGENT_SKILL_GRAPH_ROLLOUT=guarded a contract review runs as a typed DAG of atomic skill nodes while the /chat response keeps its V1 skill-chain contract.",
      observed: {
        eventCount: record.eventCount,
        graph,
        graphFieldsInResponse,
        nodeRuns,
        questions,
        replayContracts,
        traceStepIds,
      },
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "graph_executed_in_guarded_mode",
          label: "The guarded rollout executed the typed graph instead of the V1 chain",
          category: "skill_graph",
          passed:
            record.eventCount === 1 &&
            graph.executed === true &&
            graph.mode === "guarded" &&
            graph.fallback === null &&
            graph.status === "completed" &&
            graph.plannerFallback === false,
          detail: { eventCount: record.eventCount, graph },
        }),
        buildCheck({
          id: "graph_nodes_are_atomic_skills",
          label: "Graph nodes are atomic skill ids in the V1 chain order, not a composite chain id",
          category: "skill_graph",
          passed:
            sameList(graph.nodeIds, EXPECTED_NODE_IDS) &&
            sameList(getSkillChainIds(response), EXPECTED_NODE_IDS) &&
            !graph.nodeIds.some((nodeId) => /^skill_chain/.test(nodeId)),
          detail: { nodeIds: graph.nodeIds, skillChain: getSkillChainIds(response) },
        }),
        buildCheck({
          id: "dependent_node_bound_upstream_output",
          label: "The risk node depended on the summary node and read it as a typed input rather than a spliced question",
          category: "skill_graph",
          passed:
            sameList(riskNode?.dependsOn ?? [], [CUSTOM_SKILL_IDS.summarizeContract]) &&
            riskNode?.stepId === buildNodeStepId(CUSTOM_SKILL_IDS.riskReview) &&
            questions.length === 2 &&
            questions[1].typedUpstream === true &&
            questions.every((question) => question.chained === false),
          detail: { questions, riskNode },
        }),
        buildCheck({
          id: "node_steps_persist_replay_contract",
          label: "Every node step persisted its read-only replay contract and the bound upstream input",
          category: "skill_graph",
          passed:
            replayContracts.length === 2 &&
            replayContracts.every(isReadOnlyContract) &&
            riskContract?.hasPriorFindings === true,
          detail: replayContracts,
        }),
        buildCheck({
          id: "chat_contract_unchanged_under_graph",
          label: "The /chat response kept the V1 skill-chain contract and gained no graph fields",
          category: "skill_graph",
          passed:
            body.agentMode === "skill_chain" &&
            graphFieldsInResponse.length === 0 &&
            sameList(getTraceTypes(response), V1_TRACE_TYPES) &&
            sameList(traceStepIds, EXPECTED_NODE_IDS.map(buildNodeStepId)) &&
            telemetry.chatCalls.length === 2 &&
            nodeRuns.every(
              (nodeRun) =>
                nodeRun.status === EXECUTION_GRAPH_NODE_STATUSES.completed &&
                nodeRun.citationCount === 1
            ),
          detail: {
            agentMode: body.agentMode,
            chatCallCount: telemetry.chatCalls.length,
            graphFieldsInResponse,
            nodeRuns,
            traceStepIds,
            traceTypes: getTraceTypes(response),
          },
        }),
      ],
    });
  },
});

export const createSkillGraphShadowComparisonCase = () => ({
  id: "skill_graph_shadow_comparison",
  label: "Skill graph shadow comparison",
  description:
    "Under AGENT_SKILL_GRAPH_ROLLOUT=shadow the V1 chain still answers while a graph is planned, validated, and compared beside it without executing.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const ragService = createContractRagService({ telemetry });
    const response = await runContractReview({
      agentRunService,
      mode: "shadow",
      ragService,
    });
    const body = getChatResponseBody(response);
    const record = await loadGraphRecord({ agentRunService, response });
    const graph = describeGraph(record.graph);
    const questions = describeQuestions(telemetry);
    const replayContracts = describeReplayContracts(record.customSkillSteps);
    const traceStepIds = customSkillTraceStepIds(response);
    const shadow = {
      diverged: record.graph?.diverged ?? null,
      error: record.graph?.error ?? null,
      nodeRunCount: (record.graph?.nodeRuns ?? []).length,
      replanCount: (record.graph?.replans ?? []).length,
      requestedPlannerId: record.graph?.requestedPlannerId ?? null,
    };

    return finishCase({
      id: "skill_graph_shadow_comparison",
      label: "Skill graph shadow comparison",
      description:
        "Under AGENT_SKILL_GRAPH_ROLLOUT=shadow the V1 chain still answers while a graph is planned, validated, and compared beside it without executing.",
      observed: {
        eventCount: record.eventCount,
        graph,
        questions,
        replayContracts,
        shadow,
        traceStepIds,
      },
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "shadow_answers_from_v1_chain",
          label: "The V1 chain produced the answer with its spliced question and step ids",
          category: "skill_graph",
          passed:
            body.agentMode === "skill_chain" &&
            questions.length === 2 &&
            questions[1].chained === true &&
            questions.every((question) => question.typedUpstream === false) &&
            sameList(traceStepIds, EXPECTED_NODE_IDS.map(buildNodeStepId)) &&
            replayContracts.every((contract) => contract.hasPriorFindings === false),
          detail: { agentMode: body.agentMode, questions, replayContracts, traceStepIds },
        }),
        buildCheck({
          id: "shadow_graph_planned_without_execution",
          label: "A graph was planned and validated beside the run but no node executed",
          category: "skill_graph",
          passed:
            record.eventCount === 1 &&
            graph.executed === false &&
            graph.mode === "shadow" &&
            graph.fallback === null &&
            shadow.nodeRunCount === 0 &&
            shadow.replanCount === 0 &&
            sameList(graph.nodeIds, EXPECTED_NODE_IDS) &&
            graph.status === "selected" &&
            shadow.error === null,
          detail: { eventCount: record.eventCount, graph, shadow },
        }),
        buildCheck({
          id: "shadow_comparison_recorded",
          label: "The shadow record says whether the graph diverged from the chain that answered",
          category: "skill_graph",
          passed:
            shadow.diverged === false &&
            shadow.requestedPlannerId === DAG_PLANNER_IDS.deterministic &&
            graph.selectedPlannerId === DAG_PLANNER_IDS.deterministic,
          detail: { graph, shadow },
        }),
        buildCheck({
          id: "shadow_budget_charged_once",
          label: "Shadow planning did not spend skill budget or retrieval calls",
          category: "skill_graph",
          passed:
            getBudget(response)?.used?.customSkillCalls === 2 &&
            telemetry.chatCalls.length === 2,
          detail: {
            budgetUsed: getBudget(response)?.used ?? null,
            chatCallCount: telemetry.chatCalls.length,
          },
        }),
      ],
    });
  },
});

/**
 * A planner that asks for exactly what the validator exists to refuse: a
 * pre-approved node, a skill that is not registered, and a document the
 * request never authorized. All three land in one graph so the case can show
 * that the whole graph was rejected, not repaired node by node.
 */
const createForgedPlannerAdapter = ({ contexts }) => ({
  createExecutionGraph: (context) => {
    contexts.push(context);

    return {
      nodes: [
        {
          approval: { approvalObjectHash: "deadbeef", status: "approved" },
          dependsOn: [],
          failurePolicy: "continue",
          inputBindings: {
            docIds: requestBinding("docIds"),
            question: requestBinding("question"),
          },
          nodeId: FORGED_NODE_IDS[0],
          rationale: "Skip the approval gate.",
          skillId: CUSTOM_SKILL_IDS.summarizeContract,
        },
        {
          dependsOn: [FORGED_NODE_IDS[0]],
          failurePolicy: "continue",
          inputBindings: {
            docIds: requestBinding("docIds"),
            question: requestBinding("question"),
          },
          nodeId: FORGED_NODE_IDS[1],
          rationale: "Read a document outside the request.",
          scope: { docIds: [DOC_ID, "contract-999"] },
          skillId: "export_all_documents",
        },
      ],
    };
  },
  id: DAG_PLANNER_IDS.llm,
});

export const createSkillGraphIllegalPlanCase = () => ({
  id: "skill_graph_illegal_plan_rejected",
  label: "Skill graph illegal plan rejected",
  description:
    "A planner graph carrying a forged approval, an unregistered skill, and an out-of-scope document is rejected whole before any node runs, and the deterministic graph answers within the authorized scope.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const plannerContexts = [];
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const ragService = createContractRagService({ telemetry });
    const response = await runContractReview({
      agentRunService,
      mode: "guarded",
      plannerAdapter: createForgedPlannerAdapter({ contexts: plannerContexts }),
      ragService,
    });
    const body = getChatResponseBody(response);
    const record = await loadGraphRecord({ agentRunService, response });
    const graph = describeGraph(record.graph);
    const nodeRuns = describeNodeRuns(record.graph);
    const traceStepIds = customSkillTraceStepIds(response);
    const reasonCodes = [...(record.graph?.planner?.fallbackReasonCodes ?? [])].sort();
    const expectedReasonCodes = [
      EXECUTION_GRAPH_REASON_CODES.forgedApproval,
      EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument,
      EXECUTION_GRAPH_REASON_CODES.unregisteredCapability,
    ].sort();
    const forgedNodeIdsRan = FORGED_NODE_IDS.filter(
      (nodeId) =>
        nodeRuns.some((nodeRun) => nodeRun.nodeId === nodeId) ||
        traceStepIds.includes(buildNodeStepId(nodeId)) ||
        record.customSkillSteps.some((step) => step.id === buildNodeStepId(nodeId))
    );
    const plannerContext = plannerContexts[0] ?? null;
    const plannerView = {
      authorizedDocIds: [...(plannerContext?.authorizedDocIds ?? [])],
      callCount: plannerContexts.length,
      capabilityIds: (plannerContext?.capabilities ?? []).map(
        (capability) => capability.id
      ),
      keys: sortedKeys(plannerContext),
      leaks: leaksScopeOrEvidence(plannerContext),
    };
    const chatDocIds = telemetry.chatCalls.map((call) => [...call.docIds]);

    return finishCase({
      id: "skill_graph_illegal_plan_rejected",
      label: "Skill graph illegal plan rejected",
      description:
        "A planner graph carrying a forged approval, an unregistered skill, and an out-of-scope document is rejected whole before any node runs, and the deterministic graph answers within the authorized scope.",
      observed: {
        chatDocIds,
        eventCount: record.eventCount,
        forgedNodeIdsRan,
        graph,
        nodeRuns,
        plannerView,
        reasonCodes,
      },
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "illegal_graph_rejected_before_any_node_ran",
          label: "The forged graph was rejected whole and none of its nodes executed",
          category: "skill_graph",
          passed:
            graph.plannerFallback === true &&
            record.graph?.planner?.status === "fallback" &&
            graph.requestedPlannerId === DAG_PLANNER_IDS.llm &&
            graph.selectedPlannerId === DAG_PLANNER_IDS.deterministic &&
            forgedNodeIdsRan.length === 0 &&
            telemetry.chatCalls.length === 2,
          detail: {
            chatCallCount: telemetry.chatCalls.length,
            forgedNodeIdsRan,
            graph,
          },
        }),
        buildCheck({
          id: "rejection_reason_codes_recorded",
          label: "Every violation was reported with its stable reason code",
          category: "skill_graph",
          passed: sameList(reasonCodes, expectedReasonCodes),
          detail: { expectedReasonCodes, reasonCodes },
        }),
        buildCheck({
          id: "planner_saw_only_redacted_context",
          label: "The planner received the redacted whitelist view and nothing that identifies the caller",
          category: "skill_graph",
          passed:
            plannerView.callCount === 1 &&
            sameList(plannerView.keys, PLANNER_CONTEXT_KEYS) &&
            sameList(plannerView.authorizedDocIds, [DOC_ID]) &&
            sameList(
              [...plannerView.capabilityIds].sort(),
              EXPECTED_AUTHORIZED_SKILL_IDS
            ) &&
            plannerView.leaks === false,
          detail: plannerView,
        }),
        buildCheck({
          id: "fallback_graph_answered_within_scope",
          label: "The deterministic fallback graph executed and every retrieval stayed inside the authorized documents",
          category: "skill_graph",
          passed:
            graph.executed === true &&
            graph.fallback === null &&
            sameList(graph.nodeIds, EXPECTED_NODE_IDS) &&
            chatDocIds.length === 2 &&
            chatDocIds.every((docIds) => sameList(docIds, [DOC_ID])) &&
            body.agentMode === "skill_chain" &&
            nodeRuns.every(
              (nodeRun) => nodeRun.status === EXECUTION_GRAPH_NODE_STATUSES.completed
            ),
          detail: { agentMode: body.agentMode, chatDocIds, graph, nodeRuns },
        }),
      ],
    });
  },
});

/**
 * A replanner that proposes the one legal thing it can: the same whitelisted
 * skill under a new node id, still bound to the summary node's output. It may
 * not retire the node that abstained, so the retry sits beside it.
 */
const createRetryPatchAdapter = ({ contexts }) => ({
  createPatch: (context) => {
    contexts.push(context);

    return {
      addNodes: [
        {
          dependsOn: [CUSTOM_SKILL_IDS.summarizeContract],
          failurePolicy: "continue",
          inputBindings: {
            docIds: requestBinding("docIds"),
            priorFindings: nodeBinding(CUSTOM_SKILL_IDS.summarizeContract, "text"),
            question: requestBinding("question"),
          },
          nodeId: RETRY_NODE_ID,
          rationale: "Retry the risk review with the summary as context.",
          skillId: CUSTOM_SKILL_IDS.riskReview,
        },
      ],
      rationale: "The first risk review found nothing.",
      removeNodeIds: [],
    };
  },
  id: "trajectory_replan",
});

export const createSkillGraphBoundedReplanCase = () => ({
  id: "skill_graph_bounded_replan",
  label: "Skill graph bounded replan",
  description:
    "When a node settles without evidence the runtime applies at most one replan patch, re-runs only the added node, reuses the rest, and then abstains at the replan limit.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const replanContexts = [];
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    // The second retrieval is the first risk review; it comes back empty.
    const ragService = createContractRagService({ abstainOnCall: 2, telemetry });
    const response = await runContractReview({
      // One call beyond the two-node plan, so the runtime can fund exactly the
      // retry and nothing more. The budget is the runtime's decision; the
      // replanner only proposes.
      agentBudget: { maxCustomSkillCalls: 3 },
      agentRunService,
      mode: "guarded",
      ragService,
      replanAdapter: createRetryPatchAdapter({ contexts: replanContexts }),
    });
    const body = getChatResponseBody(response);
    const record = await loadGraphRecord({ agentRunService, response });
    const graph = describeGraph(record.graph);
    const nodeRuns = describeNodeRuns(record.graph);
    const replans = describeReplans(record.graph);
    const questions = describeQuestions(telemetry);
    const replayContracts = describeReplayContracts(record.customSkillSteps);
    const traceStepIds = customSkillTraceStepIds(response);
    const findNodeRun = (nodeId) =>
      nodeRuns.find((nodeRun) => nodeRun.nodeId === nodeId) ?? null;
    const summaryNode = findNodeRun(CUSTOM_SKILL_IDS.summarizeContract);
    const riskNode = findNodeRun(CUSTOM_SKILL_IDS.riskReview);
    const retryNode = findNodeRun(RETRY_NODE_ID);
    const retryContract =
      replayContracts.find(
        (contract) => contract.stepId === buildNodeStepId(RETRY_NODE_ID)
      ) ?? null;
    const replanContext = replanContexts[0] ?? null;
    const replannerView = {
      authorizedDocIds: [...(replanContext?.authorizedDocIds ?? [])],
      callCount: replanContexts.length,
      keys: sortedKeys(replanContext),
      leaks: leaksScopeOrEvidence(replanContext),
      nodeRunKeys: (replanContext?.nodeRuns ?? []).map(sortedKeys),
      trigger: replanContext?.trigger ?? null,
    };
    const budgetUsed = getBudget(response)?.used?.customSkillCalls ?? null;
    const expectedNodeIds = [...EXPECTED_NODE_IDS, RETRY_NODE_ID];

    return finishCase({
      id: "skill_graph_bounded_replan",
      label: "Skill graph bounded replan",
      description:
        "When a node settles without evidence the runtime applies at most one replan patch, re-runs only the added node, reuses the rest, and then abstains at the replan limit.",
      observed: {
        budgetUsed,
        eventCount: record.eventCount,
        graph,
        nodeRuns,
        questions,
        replannerView,
        replans,
        replayContracts,
        traceStepIds,
      },
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "replan_triggered_by_insufficient_evidence",
          label: "The empty risk review triggered exactly one applied replan",
          category: "skill_graph",
          passed:
            replans[0]?.trigger === REPLAN_TRIGGERS.insufficientEvidence &&
            replans[0]?.decision === REPLAN_DECISIONS.applied &&
            replans[0]?.replanCount === 1 &&
            replannerView.callCount === 1 &&
            replannerView.trigger === REPLAN_TRIGGERS.insufficientEvidence,
          detail: { replannerView, replans },
        }),
        buildCheck({
          id: "replan_reran_only_affected_node",
          label: "Only the added node ran; the nodes that had already settled were reused",
          category: "skill_graph",
          passed:
            summaryNode?.status === EXECUTION_GRAPH_NODE_STATUSES.reused &&
            riskNode?.status === EXECUTION_GRAPH_NODE_STATUSES.reused &&
            riskNode?.citationCount === 0 &&
            retryNode?.status === EXECUTION_GRAPH_NODE_STATUSES.completed &&
            retryNode?.citationCount === 1 &&
            telemetry.chatCalls.length === 3 &&
            sameList(graph.nodeIds, expectedNodeIds) &&
            sameList(traceStepIds, expectedNodeIds.map(buildNodeStepId)),
          detail: {
            chatCallCount: telemetry.chatCalls.length,
            nodeIds: graph.nodeIds,
            nodeRuns,
            traceStepIds,
          },
        }),
        buildCheck({
          id: "replan_is_bounded",
          label: "The second replan attempt abstained at the limit and reused nodes were not charged again",
          category: "skill_graph",
          passed:
            replans.length === 2 &&
            replans[1]?.decision === REPLAN_DECISIONS.abstain &&
            replans[1]?.reasonCode === REPLAN_REASON_CODES.limitReached &&
            replannerView.callCount === 1 &&
            budgetUsed === 3 &&
            graph.executed === true &&
            graph.status === "completed",
          detail: { budgetUsed, graph, replans },
        }),
        buildCheck({
          id: "replanner_saw_status_only_context",
          label: "The replanner received node statuses and the whitelist, never evidence text or the caller's identity",
          category: "skill_graph",
          passed:
            sameList(replannerView.keys, REPLAN_CONTEXT_KEYS) &&
            replannerView.nodeRunKeys.length === 2 &&
            replannerView.nodeRunKeys.every((keys) =>
              sameList(keys, REPLAN_NODE_RUN_KEYS)
            ) &&
            sameList(replannerView.authorizedDocIds, [DOC_ID]) &&
            replannerView.leaks === false,
          detail: replannerView,
        }),
        buildCheck({
          id: "retry_node_bound_upstream_output",
          label: "The retry node read the summary as a typed input and persisted it for replay",
          category: "skill_graph",
          passed:
            sameList(retryNode?.dependsOn ?? [], [CUSTOM_SKILL_IDS.summarizeContract]) &&
            retryContract?.hasPriorFindings === true &&
            isReadOnlyContract(retryContract ?? {}) &&
            questions.length === 3 &&
            questions[2].typedUpstream === true &&
            questions[2].chained === false &&
            body.agentMode === "skill_chain",
          detail: { agentMode: body.agentMode, questions, retryContract, retryNode },
        }),
      ],
    });
  },
});
