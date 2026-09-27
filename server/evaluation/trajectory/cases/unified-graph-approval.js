import {
  continueAgentExecutionGraphApproval,
  runAgentRag,
} from "../../../rag/agent.js";
import { createAgentRunStepExecutor } from "../../../rag/agent-run-step-executor.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../../../rag/agent-runs.js";
import { UNIFIED_GRAPH_RUN_EVENTS } from "../../../rag/agent-unified-graph-run.js";
import {
  createCapabilityRegistry,
  createDefaultCapabilityRegistry,
} from "../../../rag/capabilities/index.js";
import { createTaskCreateCapability } from "../../../rag/capabilities/actions.js";
import { getBudget, getChatResponseBody } from "../../chat-response-contract.js";
import {
  buildScopedRagService,
  createEvalTelemetry,
  withEnvironmentOverrides,
} from "../../agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  buildTrajectoryCheck as buildCheck,
  finishTrajectoryCase as finishCase,
  sameTrajectoryScope as sameScope,
} from "../checks.js";
import { describeUnifiedPlannerDecisions } from "./unified-graph-planner.js";

// Approval continuation inside the guarded v3 graph, measured against V1 on
// the same request.
//
// A workspace-action request (create a task) on a selected document. The
// graph answers from the document first, checks that answer, and only when it
// passed runs the approval-gated task.create Capability with the verified
// answer as the task description. The Capability parks at its gate (the nodes
// before it have run, the Capability has not), the approval endpoint's own
// handler decides it, and the SAME graph continues from its checkpoint: an
// approval runs the Capability once with the approved input, a rejection
// finalizes without it, and an approval of a changed Capability is refused
// before anything is decided. V1 on the same request runs the action alone
// and asks the user to approve a task whose description is the raw question.
//
// Evidence kind: by default an injected deterministic proposal and mock
// providers (runtime-contract evidence, not model-planning evidence). With a
// `planner` option the graph is planned by that adapter instead (the real-model
// planner run, evaluation/trajectory/unified-graph-planner-eval.js).

const CASE_ID = "unified_graph_approval_gated_action";
const CASE_LABEL = "Unified graph approval-gated action";
const CASE_DESCRIPTION =
  "Under AGENT_UNIFIED_GRAPH_ROLLOUT=guarded, a task-creation request runs task.create only after the document answer passes its evidence check, pauses at a graph-bound approval gate whose input carries the verified answer, and the approval endpoint continues the same graph (approve: the Capability runs once; deny: finalized without it; a changed Capability version is refused); V1 on the same request asks to approve a task built from the raw question.";
const DOC_ID = "vendor-msa";
const FILE_NAME = "vendor-msa.pdf";
const QUESTION = "Create a follow-up task for the vendor renewal notice period";
const PROPOSAL_ID = "trajectory_approval_gated_action_proposal";
const DOCUMENT_EXCERPT = "The vendor requires 30 days written notice before renewal.";
const DOCUMENT_ANSWER = `${DOCUMENT_EXCERPT} [Source 1]`;
const CAPABILITY_ID = "task.create";
const STALE_VERSION = "1.0.1";

const request = (field) => ({ field, source: "request" });
const upstream = (nodeId, output) => ({ nodeId, output, source: "node" });

export const createApprovalGatedActionProposal = () => ({
  nodes: [
    {
      dependsOn: [],
      failurePolicy: "fail_fast",
      inputBindings: { docIds: request("docIds"), question: request("question") },
      nodeId: "document",
      skillId: "document_rag",
    },
    {
      dependsOn: ["document"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: request("docIds"),
        evidence: upstream("document", "evidence"),
        question: request("question"),
      },
      nodeId: "evidence_check",
      skillId: "document_evidence_check",
    },
    {
      dependsOn: ["document", "evidence_check"],
      failurePolicy: "fail_fast",
      inputBindings: {
        description: upstream("document", "text"),
        title: request("question"),
      },
      nodeId: "task",
      skillId: `capability:${CAPABILITY_ID}`,
      when: { equals: true, nodeId: "evidence_check", output: "passed" },
    },
  ],
});

const createRagService = (telemetry) =>
  buildScopedRagService({
    chat: async () => ({
      abstained: false,
      citations: [{ docId: DOC_ID, excerpt: DOCUMENT_EXCERPT, fileName: FILE_NAME, pageNumber: 2 }],
      text: DOCUMENT_ANSWER,
    }),
    documents: [{ docId: DOC_ID, fileName: FILE_NAME }],
    sameScope,
    telemetry,
  });

// task.create writes are counted, never persisted anywhere real.
const createTaskRegistry = ({ ragService, version = null, writes }) => {
  const actionTaskService = {
    createActionTask: async (task) => {
      writes.push(task);
      return { id: task.taskId || `task-${writes.length}`, label: task.label, status: task.status };
    },
  };
  const defaults = createDefaultCapabilityRegistry({
    actionTaskService,
    ragService,
    webChatService: async () => ({ citations: [], text: "" }),
  });

  return version
    ? createCapabilityRegistry(
        defaults.list().map((capability) =>
          capability.id === CAPABILITY_ID
            ? { ...createTaskCreateCapability({ actionTaskService }), version }
            : defaults.get(capability.id)
        )
      )
    : defaults;
};

const createProposalAdapter = ({ contexts }) => ({
  createExecutionGraph: (context) => {
    contexts.push(context);
    return createApprovalGatedActionProposal();
  },
  id: PROPOSAL_ID,
});

const eventsOf = (run, type) => (run?.events ?? []).filter((event) => event.type === type);

const pauseRequest = async ({ mode = "guarded", planner = null }) => {
  const telemetry = createEvalTelemetry();
  const ragService = createRagService(telemetry);
  const writes = [];
  const registry = createTaskRegistry({ ragService, writes });
  const plannerContexts = [];
  const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const response = await withEnvironmentOverrides(
    { AGENT_UNIFIED_GRAPH_ROLLOUT: mode },
    () =>
      runAgentRag({
        accessScope: DEFAULT_ACCESS_SCOPE,
        agentRunService,
        capabilityRegistry: registry,
        docIds: [DOC_ID],
        question: QUESTION,
        ragService,
        sessionId: "trajectory-unified-approval-session",
        unifiedGraphAllowedCapabilityIds: [CAPABILITY_ID],
        unifiedGraphPlannerAdapter: planner?.adapter ?? createProposalAdapter({ contexts: plannerContexts }),
        userId: DEFAULT_ACCESS_SCOPE.userId,
      })
  );
  const body = getChatResponseBody(response);

  return {
    agentRunService,
    body,
    gate: body.approvalGates?.[0] ?? null,
    plannerContexts,
    ragService,
    registry,
    response,
    runId: body.agentRunId,
    telemetry,
    writes,
  };
};

// The approval endpoint's own handler (routes/tasks.js), wired as
// app-services wires it. The decision reads the operator allowlist live, so
// it is configured here exactly as the request's injected list.
const decide = ({ action, context, hash, registry = context.registry }) =>
  withEnvironmentOverrides({
    AGENT_UNIFIED_GRAPH_CAPABILITIES: CAPABILITY_ID,
    AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
  }, () =>
    createAgentRunStepExecutor({
      agentRunService: context.agentRunService,
      capabilityRegistry: registry,
      continueExecutionGraphApproval: (args) =>
        continueAgentExecutionGraphApproval({
          ...args,
          agentRunService: context.agentRunService,
          capabilityRegistry: registry,
          ragService: context.ragService,
        }),
    }).applyApprovalAction({
      accessScope: DEFAULT_ACCESS_SCOPE,
      action,
      gateId: context.gate?.id,
      payload: { approvalObjectHash: hash ?? context.gate?.approvalObjectHash },
      runId: context.runId,
    })
  );

const settle = async (promise) => {
  try {
    return { error: null, value: await promise };
  } catch (error) {
    return { error: { code: error?.code ?? null, status: error?.status ?? null }, value: null };
  }
};

const load = async (context) => ({
  checkpoint: (await context.agentRunService.getExecutionGraphCheckpoint({
    accessScope: DEFAULT_ACCESS_SCOPE,
    runId: context.runId,
  }))?.checkpoint ?? null,
  run: await context.agentRunService.getRun({
    accessScope: DEFAULT_ACCESS_SCOPE,
    runId: context.runId,
  }),
});

const describeNodeRuns = (run) =>
  (eventsOf(run, UNIFIED_GRAPH_RUN_EVENTS.executed).at(-1)?.payload?.nodeRuns ?? []).map(
    (nodeRun) => ({
      nodeId: nodeRun.nodeId,
      reason: nodeRun.reason ?? null,
      skillId: nodeRun.skillId,
      status: nodeRun.status,
    })
  );

const describePause = async (context) => {
  const { checkpoint, run } = await load(context);
  const actionNodeId = context.gate?.nodeId ?? null;

  return {
    actionNodeId,
    agentMode: context.body.agentMode ?? null,
    checkpointPhase: checkpoint?.phase ?? null,
    clarificationReason: context.body.clarification?.reason ?? null,
    completedBeforePause: (checkpoint?.nodeRuns ?? [])
      .filter((nodeRun) => nodeRun.status === "completed")
      .map((nodeRun) => nodeRun.skillId),
    documentCallsBeforePause: context.telemetry.chatCalls.length,
    gateBoundToCheckpoint:
      Boolean(context.gate) &&
      checkpoint?.approvalBoundary?.gateId === context.gate.id &&
      checkpoint?.approvalBoundary?.graphDigest === context.gate.graphDigest,
    gateCapabilityId: context.gate?.capabilityId ?? null,
    gateInputCarriesVerifiedAnswer: context.gate?.inputPreview?.description === DOCUMENT_ANSWER,
    gateType: context.gate?.type ?? null,
    lastEvent: run?.events?.at(-1)?.type ?? null,
    outerPlanEventCount: eventsOf(run, "execution_planned").length,
    runStatus: run?.status ?? null,
    writesBeforeDecision: context.writes.length,
  };
};

// Planner mode only: every graph the run executed was the configured planner's
// own proposal (none was replaced by the deterministic graph or refused).
const buildModelPlanCheck = (decisions) =>
  buildCheck({
    id: "model_plan_used",
    label: "Every executed graph was the configured planner's own plan, without fallback",
    category: "planner",
    passed:
      decisions.length > 0 &&
      decisions.every((decision) => decision.admitted && !decision.fallback),
    detail: decisions,
  });

export const createUnifiedGraphApprovalGatedActionCase = ({ planner = null } = {}) => ({
  id: CASE_ID,
  label: CASE_LABEL,
  description: CASE_DESCRIPTION,
  run: async () => {
    // 1. Pause, a refused wrong object, the approval, a refused repeat.
    const approved = await pauseRequest({ planner });
    const pause = await describePause(approved);
    const beforeDecision = await load(approved);
    const wrongObject = await settle(
      decide({ action: "approve", context: approved, hash: `sha256:${"0".repeat(64)}` })
    );
    const unchangedAfterWrongObject =
      JSON.stringify((await load(approved)).checkpoint) ===
      JSON.stringify(beforeDecision.checkpoint);
    const approval = await settle(decide({ action: "approve", context: approved }));
    const afterApproval = await load(approved);
    const repeated = await settle(decide({ action: "approve", context: approved }));
    const approvedResponse = approval.value
      ? { body: approval.value.response, status: approval.value.status }
      : approved.response;

    // 2. The rejection path.
    const denied = await pauseRequest({ planner });
    const denial = await settle(decide({ action: "deny", context: denied }));
    const afterDenial = await load(denied);

    // 3. A deploy changed the Capability between the gate and the approval.
    const stale = await pauseRequest({ planner });
    const bumpedWrites = [];
    const staleApproval = await settle(
      decide({
        action: "approve",
        context: stale,
        registry: createTaskRegistry({
          ragService: stale.ragService,
          version: STALE_VERSION,
          writes: bumpedWrites,
        }),
      })
    );
    const afterStale = await load(stale);

    // 4. V1 on the same request.
    const v1 = await pauseRequest({ mode: "off" });
    const v1Run = (await load(v1)).run;

    const observed = {
      approval: {
        agentMode: approval.value?.response?.agentMode ?? null,
        answerNamesTask: /^Task recorded as task /.test(approval.value?.response?.agentAnswer ?? ""),
        documentCallsTotal: approved.telemetry.chatCalls.length,
        error: approval.error,
        finalizationMatchesAnswer:
          afterApproval.checkpoint?.finalization?.response?.body?.agentAnswer ===
          approval.value?.response?.agentAnswer,
        graphNodeCount: afterApproval.checkpoint?.graph?.nodes?.length ?? null,
        nodeRuns: describeNodeRuns(afterApproval.run),
        plannedEventCount: eventsOf(afterApproval.run, UNIFIED_GRAPH_RUN_EVENTS.planned).length,
        runStatus: afterApproval.run?.status ?? null,
        writeInputMatchesGate:
          approved.writes.length === 1 &&
          approved.writes[0].input?.description === approved.gate?.inputPreview?.description &&
          approved.writes[0].input?.title === approved.gate?.inputPreview?.title,
        writes: approved.writes.length,
      },
      denial: {
        agentAnswer: denial.value?.response?.agentAnswer ?? null,
        error: denial.error,
        gateStatus: afterDenial.run?.approvalGates?.[0]?.status ?? null,
        nodeRuns: describeNodeRuns(afterDenial.run),
        runStatus: afterDenial.run?.status ?? null,
        writes: denied.writes.length,
      },
      pause,
      refusals: {
        repeatedApproval: repeated.error,
        staleCapability: staleApproval.error,
        staleRunStatus: afterStale.run?.status ?? null,
        staleWrites: stale.writes.length + bumpedWrites.length,
        unchangedAfterWrongObject,
        wrongObject: wrongObject.error,
      },
      v1: {
        agentMode: v1.body.agentMode ?? null,
        documentCalls: v1.telemetry.chatCalls.length,
        gateInputIsRawQuestion:
          v1.gate?.inputPreview?.description === QUESTION && v1.gate?.type !== "graph_capability_approval",
        outerPlanRan: eventsOf(v1Run, "execution_planned").length === 1,
        unifiedEventCount: eventsOf(v1Run, UNIFIED_GRAPH_RUN_EVENTS.planned).length,
        writes: v1.writes.length,
      },
    };
    const actionNode = (nodeRuns) => nodeRuns.find((nodeRun) => nodeRun.skillId === `capability:${CAPABILITY_ID}`);
    const approvedAction = actionNode(observed.approval.nodeRuns);
    const deniedAction = actionNode(observed.denial.nodeRuns);

    if (planner) {
      observed.plannerDecisions = [
        ...describeUnifiedPlannerDecisions(afterApproval.run),
        ...describeUnifiedPlannerDecisions(afterDenial.run),
        ...describeUnifiedPlannerDecisions(afterStale.run),
      ];
    }

    return finishCase({
      id: CASE_ID,
      label: CASE_LABEL,
      description: CASE_DESCRIPTION,
      observed,
      response: approvedResponse,
      telemetry: approved.telemetry,
      checks: [
        buildCheck({
          id: "graph_paused_at_capability_gate",
          label: "The guarded graph ran the document answer and its check, then paused at a graph-bound gate whose input carries the verified answer; the Capability did not run",
          category: "unified_graph",
          passed:
            pause.agentMode === "clarification" &&
            pause.clarificationReason === "capability_approval_required" &&
            pause.runStatus === "waiting_for_user" &&
            pause.checkpointPhase === "awaiting_approval" &&
            pause.gateType === "graph_capability_approval" &&
            pause.gateCapabilityId === CAPABILITY_ID &&
            pause.gateBoundToCheckpoint &&
            pause.gateInputCarriesVerifiedAnswer &&
            pause.completedBeforePause.includes("document_rag") &&
            pause.completedBeforePause.includes("document_evidence_check") &&
            pause.writesBeforeDecision === 0 &&
            pause.outerPlanEventCount === 0 &&
            pause.lastEvent === "graph_approval_gate_created",
          detail: pause,
        }),
        buildCheck({
          id: "approval_continued_same_graph_once",
          label: "The approval endpoint continued the same graph: completed nodes reused, the Capability ran once with the approved input, and the run completed with a sealed answer",
          category: "unified_graph",
          passed:
            observed.approval.error === null &&
            observed.approval.runStatus === "completed" &&
            observed.approval.agentMode === "workspace_action" &&
            observed.approval.answerNamesTask &&
            observed.approval.writes === 1 &&
            observed.approval.writeInputMatchesGate &&
            observed.approval.documentCallsTotal === 1 &&
            observed.approval.plannedEventCount === 1 &&
            observed.approval.finalizationMatchesAnswer &&
            approvedAction?.status === "completed" &&
            observed.approval.nodeRuns
              .filter((nodeRun) => nodeRun !== approvedAction)
              .every((nodeRun) => nodeRun.status === "reused"),
          detail: observed.approval,
        }),
        buildCheck({
          id: "stale_or_repeated_approval_refused",
          label: "A wrong approval object, a repeated decision, and an approval of a changed Capability version are refused without writing anything",
          category: "unified_graph",
          passed:
            observed.refusals.wrongObject?.code === "approval_object_hash_mismatch" &&
            observed.refusals.unchangedAfterWrongObject &&
            observed.refusals.repeatedApproval?.status === 409 &&
            observed.refusals.staleCapability?.code === "graph_approval_stale" &&
            observed.refusals.staleRunStatus === "waiting_for_user" &&
            observed.refusals.staleWrites === 0 &&
            observed.approval.writes === 1,
          detail: observed.refusals,
        }),
        buildCheck({
          id: "denied_approval_finalized_without_capability",
          label: "A rejection finalized the same graph without the Capability: its node is skipped as approval_denied and nothing was written",
          category: "unified_graph",
          passed:
            observed.denial.error === null &&
            observed.denial.runStatus === "completed" &&
            observed.denial.gateStatus === "denied" &&
            observed.denial.writes === 0 &&
            deniedAction?.status === "skipped" &&
            deniedAction?.reason === "approval_denied" &&
            /approval was denied/.test(observed.denial.agentAnswer ?? ""),
          detail: observed.denial,
        }),
        buildCheck({
          id: "v1_same_request_action_ungrounded",
          label: "V1 on the same request runs the action alone: no document answer, and the approval shows a task built from the raw question",
          category: "unified_graph",
          passed:
            observed.v1.agentMode === "clarification" &&
            observed.v1.outerPlanRan &&
            observed.v1.unifiedEventCount === 0 &&
            observed.v1.documentCalls === 0 &&
            observed.v1.gateInputIsRawQuestion &&
            observed.v1.writes === 0,
          detail: observed.v1,
        }),
        buildCheck({
          id: "approval_graph_budget_and_planner",
          label: "Budget was charged once for the document answer and the planner was the configured one",
          category: "unified_graph",
          passed:
            (getBudget(approvedResponse)?.used?.documentRagCalls ?? null) === 1 &&
            (planner
              ? (observed.plannerDecisions ?? []).length > 0
              : approved.plannerContexts.length === 1 &&
                approved.plannerContexts[0]?.graphVersion === "v3"),
          detail: {
            budgetUsed: getBudget(approvedResponse)?.used ?? null,
            plannerCallCount: planner ? null : approved.plannerContexts.length,
          },
        }),
        ...(planner ? [buildModelPlanCheck(observed.plannerDecisions ?? [])] : []),
      ],
    });
  },
});
