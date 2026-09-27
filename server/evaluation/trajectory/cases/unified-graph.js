import { runAgentRag } from "../../../rag/agent.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../../../rag/agent-runs.js";
import {
  digestUnifiedGraphFinalizedAnswer,
  UNIFIED_GRAPH_RUN_EVENTS,
} from "../../../rag/agent-unified-graph-run.js";
import {
  getBudget,
  getChatResponseBody,
} from "../../chat-response-contract.js";
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

// The unfreeze condition for the heterogeneous v3 graph: an orchestration the
// fixed V1 outer order cannot express, measured against V1 on the same
// request.
//
// A risk-review request. The graph answers from the selected documents first,
// runs the risk_review Skill only when that answer passes its own evidence
// check (a validated `when` edge), and hands the Skill the verified answer as
// its typed priorFindings input. V1 on the same request (both the chain and
// the V2 typed DAG for custom Skills) plans custom_skills without
// document_rag, so its Skill runs unconditionally and never sees a document
// answer. Both evidence variants run on both paths.
//
// What this does and does not show. The mock Skill answer does not depend on
// the upstream section (the Skill contract treats it as context, never
// evidence), so no answer-quality gain is claimed: the measured differences
// are which work runs, what it costs, and what typed input the Skill receives.
// The documented example of the unfreeze condition, "document evidence
// insufficient -> Web -> hand the Web result to a Skill", is NOT admitted:
// Web text is untrusted model output and admission refuses any binding of it
// into another node (a check here pins that refusal). Conditional Web itself
// is admitted and feeds only the finalizer.
//
// Evidence kind: every graph comes from an injected, deterministic proposal
// and every provider is a mock. This proves the runtime contract (admission,
// conditional scheduling, typed hand-off, budget, receipts, one path per
// request). It is not real-model planning evidence.

const CASE_ID = "unified_graph_evidence_gated_skill_hand_off";
const CASE_LABEL = "Unified graph evidence-gated Skill hand-off";
const CASE_DESCRIPTION =
  "Under AGENT_UNIFIED_GRAPH_ROLLOUT=guarded, a risk-review request runs the risk_review Skill only after the document answer passes its evidence check and hands it that verified answer as typed priorFindings; V1 on the same request (chain and V2 DAG) runs the Skill first and unconditionally, and a Web-to-Skill hand-off is refused at admission.";
const DOC_ID = "vendor-msa";
const FILE_NAME = "vendor-msa.pdf";
// Risk-review intent (V1 selects risk_review), no Web wording.
const QUESTION =
  "Run a risk review of the vendor notice terms: what notice period does the vendor require?";
const PROPOSAL_ID = "trajectory_evidence_gated_skill_proposal";
const HAND_OFF_PROPOSAL_ID = "trajectory_web_hand_off_proposal";
const DOCUMENT_EXCERPT = "The vendor requires 30 days written notice before renewal.";
const DOCUMENT_ANSWER = `${DOCUMENT_EXCERPT} [Source 1]`;
const UNRELATED_EXCERPT = "The agreement covers managed hosting services for the customer.";
const RISK_EXCERPT =
  "The agreement renews automatically unless the customer gives notice before the renewal date.";
const WEB_TEXT =
  "Vendor renewal notice: the published terms require 45 days notice before renewal. [Source 1]";
const WEB_MARKER = "45 days notice before renewal";
const RISK_PROMPT_PATTERN = /Perform a concise citation-backed risk review/;
const UPSTREAM_PATTERN = /Upstream findings from an earlier step/;
const STANDING_WEB_APPROVAL = Object.freeze({
  "web.search": Object.freeze({ approved: true }),
});
const EXPECTED_NODE_IDS = ["document", "evidence_check", "risk"];

const request = (field) => ({ field, source: "request" });
const upstream = (nodeId, output) => ({ nodeId, output, source: "node" });

const sameList = (left = [], right = []) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const documentNode = () => ({
  dependsOn: [],
  failurePolicy: "fail_fast",
  inputBindings: { docIds: request("docIds"), question: request("question") },
  nodeId: "document",
  skillId: "document_rag",
});

const evidenceCheckNode = () => ({
  dependsOn: ["document"],
  failurePolicy: "fail_fast",
  inputBindings: {
    docIds: request("docIds"),
    evidence: upstream("document", "evidence"),
    question: request("question"),
  },
  nodeId: "evidence_check",
  skillId: "document_evidence_check",
});

/**
 * The deterministic proposal: document -> evidence check -> (evidence
 * passed) risk_review reading the verified document answer.
 */
export const createEvidenceGatedSkillProposal = () => ({
  nodes: [
    documentNode(),
    evidenceCheckNode(),
    {
      dependsOn: ["document", "evidence_check"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: request("docIds"),
        priorFindings: upstream("document", "text"),
        question: request("question"),
      },
      nodeId: "risk",
      skillId: "risk_review",
      when: { equals: true, nodeId: "evidence_check", output: "passed" },
    },
  ],
});

/** The refused shape: Web text handed to a Skill prompt. */
export const createWebHandOffProposal = () => ({
  nodes: [
    documentNode(),
    evidenceCheckNode(),
    {
      dependsOn: ["evidence_check"],
      failurePolicy: "fail_fast",
      inputBindings: { question: request("question") },
      nodeId: "web",
      skillId: "web_search",
      when: { equals: false, nodeId: "evidence_check", output: "passed" },
    },
    {
      dependsOn: ["web"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: request("docIds"),
        priorFindings: upstream("web", "text"),
        question: request("question"),
      },
      nodeId: "risk",
      skillId: "risk_review",
    },
  ],
});

const createProposalAdapter = ({ contexts, createProposal, id }) => ({
  createExecutionGraph: (context) => {
    contexts.push(context);
    return createProposal();
  },
  id,
});

// The Skill's answer is the same whether or not its prompt carries an
// upstream section: nothing here rewards the hand-off with a better answer.
const createVendorRagService = ({ documentSufficient, telemetry }) =>
  buildScopedRagService({
    chat: async ({ question }) => {
      if (RISK_PROMPT_PATTERN.test(question)) {
        return {
          abstained: false,
          citations: [
            { docId: DOC_ID, excerpt: RISK_EXCERPT, fileName: FILE_NAME, pageNumber: 4 },
          ],
          text: ["Risk Review", `- Risk: ${RISK_EXCERPT} [Source 1]`].join("\n"),
        };
      }

      // Insufficient: an answer the cited evidence does not support (not an
      // abstention), so its evidence check fails.
      return documentSufficient
        ? {
            abstained: false,
            citations: [
              { docId: DOC_ID, excerpt: DOCUMENT_EXCERPT, fileName: FILE_NAME, pageNumber: 2 },
            ],
            text: DOCUMENT_ANSWER,
          }
        : {
            abstained: false,
            citations: [
              { docId: DOC_ID, excerpt: UNRELATED_EXCERPT, fileName: FILE_NAME, pageNumber: 1 },
            ],
            text: "The vendor requires 60 days notice before renewal. [Source 1]",
          };
    },
    documents: [{ docId: DOC_ID, fileName: FILE_NAME }],
    sameScope,
    telemetry,
  });

const runVendorQuestion = async ({
  capabilityApprovals = {},
  createProposal = createEvidenceGatedSkillProposal,
  documentSufficient,
  mode,
  plannerId = PROPOSAL_ID,
  skillGraphRollout = "guarded",
}) => {
  const telemetry = createEvalTelemetry();
  const webCalls = [];
  const plannerContexts = [];
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const response = await withEnvironmentOverrides(
    {
      AGENT_SKILL_GRAPH_ROLLOUT: skillGraphRollout,
      AGENT_UNIFIED_GRAPH_ROLLOUT: mode,
    },
    () =>
      runAgentRag({
        accessScope: DEFAULT_ACCESS_SCOPE,
        agentRunService,
        capabilityApprovals,
        docIds: [DOC_ID],
        question: QUESTION,
        ragService: createVendorRagService({ documentSufficient, telemetry }),
        sessionId: "trajectory-unified-session",
        unifiedGraphPlannerAdapter: createProposalAdapter({
          contexts: plannerContexts,
          createProposal,
          id: plannerId,
        }),
        userId: DEFAULT_ACCESS_SCOPE.userId,
        webChatService: async (webQuestion) => {
          webCalls.push(webQuestion);
          return {
            citations: [
              {
                excerpt: WEB_TEXT.replace(" [Source 1]", ""),
                title: "Vendor terms",
                url: "https://vendor.example/terms",
              },
            ],
            text: WEB_TEXT,
          };
        },
      })
  );
  const body = getChatResponseBody(response);
  const run = await agentRunService.getRun({
    accessScope: DEFAULT_ACCESS_SCOPE,
    runId: body.agentRunId,
  });
  const loadedCheckpoint = await agentRunService.getExecutionGraphCheckpoint({
    accessScope: DEFAULT_ACCESS_SCOPE,
    runId: body.agentRunId,
  });

  return {
    body,
    checkpoint: loadedCheckpoint?.checkpoint ?? null,
    plannerContexts,
    response,
    run,
    telemetry,
    webCalls,
  };
};

const eventsOf = (run, type) =>
  (run?.events ?? []).filter((event) => event.type === type);

const describePlannedEvents = (outcome) =>
  eventsOf(outcome.run, UNIFIED_GRAPH_RUN_EVENTS.planned).map((event) => ({
    errorCodes: [...(event.payload?.errorCodes ?? [])],
    fallback: event.payload?.fallback ?? null,
    mode: event.payload?.mode ?? null,
    nodeIds: [...(event.payload?.graph?.nodeIds ?? [])],
    requestedPlannerId: event.payload?.planner?.requestedPlannerId ?? null,
    status: event.payload?.status ?? null,
  }));

const describeUnifiedPath = (outcome) => {
  const executed = eventsOf(outcome.run, UNIFIED_GRAPH_RUN_EVENTS.executed);

  return {
    executedEventCount: executed.length,
    executedStatus: executed[0]?.payload?.status ?? null,
    outerPlanEventCount: eventsOf(outcome.run, "execution_planned").length,
    plannedEvents: describePlannedEvents(outcome),
    runStatus: outcome.run?.status ?? null,
  };
};

const describeNodeRuns = (outcome) =>
  (eventsOf(outcome.run, UNIFIED_GRAPH_RUN_EVENTS.executed)[0]?.payload?.nodeRuns ?? [])
    .map((nodeRun) => ({
      dependsOn: [...(nodeRun.dependsOn ?? [])],
      nodeId: nodeRun.nodeId,
      reason: nodeRun.reason ?? null,
      skillId: nodeRun.skillId,
      status: nodeRun.status,
    }));

const findGraphStep = (outcome, nodeId) =>
  (outcome.run?.steps ?? []).find(
    (step) => step.type === "graph_node" && step.input?.nodeId === nodeId
  ) ?? null;

const findNodeRun = (nodeRuns, nodeId) =>
  nodeRuns.find((nodeRun) => nodeRun.nodeId === nodeId) ?? null;

const riskCalls = (outcome) =>
  outcome.telemetry.chatCalls.filter((call) => RISK_PROMPT_PATTERN.test(call.question));

const describeCheckOutput = (outcome) =>
  (outcome.checkpoint?.nodeRuns ?? []).find(
    (nodeRun) => nodeRun.nodeId === "evidence_check"
  )?.result?.graphOutput ?? null;

const describeCheckpoint = (outcome) => {
  const checkpoint = outcome.checkpoint;

  return {
    finalizationMatchesResponse:
      Boolean(checkpoint?.finalization) &&
      checkpoint.finalization.answerDigest ===
        digestUnifiedGraphFinalizedAnswer({
          body: outcome.body,
          status: outcome.response.status,
        }),
    graphVersion: checkpoint?.graph?.version ?? null,
    hasFinalizationReceipt: Boolean(checkpoint?.finalization),
    phase: checkpoint?.phase ?? null,
    version: checkpoint?.version ?? null,
  };
};

const describeV1Run = ({ documentSufficient, outcome, skillGraphRollout }) => {
  const calls = riskCalls(outcome);
  const plannedStepIds =
    eventsOf(outcome.run, "execution_planned")[0]?.payload?.planner?.stepIds ?? [];

  return {
    customSkillCalls: getBudget(outcome.response)?.used?.customSkillCalls ?? null,
    customStageBeforeDocumentRag:
      plannedStepIds.includes("custom_skills") &&
      plannedStepIds.indexOf("custom_skills") < plannedStepIds.indexOf("document_rag"),
    documentRagCalls: getBudget(outcome.response)?.used?.documentRagCalls ?? null,
    documentSufficient,
    riskCallCount: calls.length,
    riskCallsWithUpstreamSection: calls.filter((call) => UPSTREAM_PATTERN.test(call.question))
      .length,
    skillGraphRollout,
    unifiedEventCount: eventsOf(outcome.run, UNIFIED_GRAPH_RUN_EVENTS.planned).length,
  };
};

export const createUnifiedGraphEvidenceGatedSkillCase = () => ({
  id: CASE_ID,
  label: CASE_LABEL,
  description: CASE_DESCRIPTION,
  run: async () => {
    const sufficient = await runVendorQuestion({ documentSufficient: true, mode: "guarded" });
    const insufficient = await runVendorQuestion({ documentSufficient: false, mode: "guarded" });
    const v1Runs = [];

    for (const skillGraphRollout of ["off", "guarded"]) {
      for (const documentSufficient of [true, false]) {
        v1Runs.push(describeV1Run({
          documentSufficient,
          outcome: await runVendorQuestion({ documentSufficient, mode: "off", skillGraphRollout }),
          skillGraphRollout,
        }));
      }
    }

    const refusedHandOff = await runVendorQuestion({
      capabilityApprovals: STANDING_WEB_APPROVAL,
      createProposal: createWebHandOffProposal,
      documentSufficient: false,
      mode: "guarded",
      plannerId: HAND_OFF_PROPOSAL_ID,
    });

    const path = describeUnifiedPath(sufficient);
    const nodeRuns = describeNodeRuns(sufficient);
    const insufficientNodeRuns = describeNodeRuns(insufficient);
    const documentStep = findGraphStep(sufficient, "document");
    const checkStep = findGraphStep(sufficient, "evidence_check");
    const riskStep = findGraphStep(sufficient, "risk");
    const sufficientRiskCalls = riskCalls(sufficient);
    const handOff = {
      priorFindingsIsDocumentAnswer:
        typeof riskStep?.input?.priorFindings === "string" &&
        riskStep.input.priorFindings === documentStep?.output?.text &&
        riskStep.input.priorFindings === DOCUMENT_ANSWER,
      riskDependsOn: [...(findNodeRun(nodeRuns, "risk")?.dependsOn ?? [])],
      riskQuestionCarriesDocumentAnswer:
        sufficientRiskCalls.length === 1 &&
        UPSTREAM_PATTERN.test(sufficientRiskCalls[0].question) &&
        sufficientRiskCalls[0].question.includes(DOCUMENT_EXCERPT),
      riskStartedAfterCheckCompleted:
        Boolean(riskStep?.startedAt && checkStep?.completedAt) &&
        riskStep.startedAt >= checkStep.completedAt,
    };
    const gating = {
      insufficient: {
        agentMode: insufficient.body.agentMode ?? null,
        checkPassed: describeCheckOutput(insufficient)?.passed ?? null,
        clarificationNeeded: insufficient.body.clarification?.needed === true,
        customSkillCalls: getBudget(insufficient.response)?.used?.customSkillCalls ?? null,
        documentRagCalls: getBudget(insufficient.response)?.used?.documentRagCalls ?? null,
        nodeRuns: insufficientNodeRuns,
        riskCallCount: riskCalls(insufficient).length,
      },
      sufficient: {
        checkPassed: describeCheckOutput(sufficient)?.passed ?? null,
        customSkillCalls: getBudget(sufficient.response)?.used?.customSkillCalls ?? null,
        documentRagCalls: getBudget(sufficient.response)?.used?.documentRagCalls ?? null,
        riskStatus: findNodeRun(nodeRuns, "risk")?.status ?? null,
      },
    };
    const externalHandOff = {
      // V1 may write its own custom-Skill (v1) checkpoint; a v3 graph never
      // got that far.
      unifiedCheckpointWritten: refusedHandOff.checkpoint?.graph?.version === "v3",
      graphNodeStepCount: (refusedHandOff.run?.steps ?? []).filter(
        (step) => step.type === "graph_node"
      ).length,
      plannedEvents: describePlannedEvents(refusedHandOff),
      v1OuterPlanRan: eventsOf(refusedHandOff.run, "execution_planned").length === 1,
      webTextReachedAnySkill: refusedHandOff.telemetry.chatCalls.some((call) =>
        call.question.includes(WEB_MARKER)
      ),
    };
    const checkpoint = describeCheckpoint(sufficient);
    const answer = {
      agentMode: sufficient.body.agentMode ?? null,
      includesDocumentAnswer: String(sufficient.body.agentAnswer ?? "").includes(
        DOCUMENT_EXCERPT
      ),
      includesRiskFinding: String(sufficient.body.agentAnswer ?? "").includes(
        "renews automatically"
      ),
      sourceKinds: (sufficient.body.ragSources ?? []).map((source) =>
        source.url ? "web" : source.docId ? "document" : "unknown"
      ),
    };
    const planner = {
      callCount: sufficient.plannerContexts.length,
      evidenceKind: "deterministic_injected_proposal",
      graphVersion: sufficient.plannerContexts[0]?.graphVersion ?? null,
      requestedPlannerId: path.plannedEvents[0]?.requestedPlannerId ?? null,
    };
    const insufficientRisk = findNodeRun(insufficientNodeRuns, "risk");

    return finishCase({
      id: CASE_ID,
      label: CASE_LABEL,
      description: CASE_DESCRIPTION,
      observed: {
        answer,
        checkpoint,
        externalHandOff,
        gating,
        handOff,
        nodeRuns,
        path,
        planner,
        v1Runs,
      },
      response: sufficient.response,
      telemetry: sufficient.telemetry,
      checks: [
        buildCheck({
          id: "unified_graph_took_request",
          label: "The admitted v3 graph answered the whole request; the V1 outer plan never ran",
          category: "unified_graph",
          passed:
            path.plannedEvents.length === 1 &&
            path.plannedEvents[0].status === "selected" &&
            path.plannedEvents[0].fallback === null &&
            path.plannedEvents[0].mode === "guarded" &&
            sameList(path.plannedEvents[0].nodeIds, EXPECTED_NODE_IDS) &&
            path.outerPlanEventCount === 0 &&
            path.executedEventCount === 1 &&
            path.executedStatus === "completed" &&
            path.runStatus === "completed" &&
            sufficient.response.status === 200,
          detail: path,
        }),
        buildCheck({
          id: "skill_gated_on_document_evidence",
          label: "The Skill ran only when the document answer passed its evidence check; otherwise it was skipped, never charged, and the user was asked",
          category: "unified_graph",
          passed:
            gating.sufficient.checkPassed === true &&
            gating.sufficient.riskStatus === "completed" &&
            gating.sufficient.customSkillCalls === 1 &&
            gating.insufficient.checkPassed === false &&
            insufficientRisk?.status === "skipped" &&
            insufficientRisk?.reason === "condition_not_met" &&
            gating.insufficient.customSkillCalls === 0 &&
            gating.insufficient.riskCallCount === 0 &&
            gating.insufficient.documentRagCalls === 1 &&
            gating.insufficient.clarificationNeeded,
          detail: gating,
        }),
        buildCheck({
          id: "skill_received_verified_document_answer",
          label: "The Skill started after the evidence check and received the verified document answer as its typed priorFindings input",
          category: "unified_graph",
          passed:
            handOff.priorFindingsIsDocumentAnswer &&
            handOff.riskQuestionCarriesDocumentAnswer &&
            handOff.riskStartedAfterCheckCompleted &&
            sameList(handOff.riskDependsOn, ["document", "evidence_check"]),
          detail: handOff,
        }),
        buildCheck({
          id: "v1_same_request_runs_skill_first_and_unconditionally",
          label: "V1 on the same request, chain and V2 DAG, both evidence variants: the Skill runs every time, with no document answer and no upstream section",
          category: "unified_graph",
          passed:
            v1Runs.length === 4 &&
            v1Runs.every((v1) =>
              v1.unifiedEventCount === 0 &&
              v1.customSkillCalls === 1 &&
              v1.riskCallCount === 1 &&
              v1.riskCallsWithUpstreamSection === 0 &&
              v1.documentRagCalls === 0 &&
              v1.customStageBeforeDocumentRag
            ),
          detail: v1Runs,
        }),
        buildCheck({
          id: "web_to_skill_hand_off_refused",
          label: "A graph that hands Web text to a Skill is refused whole before any node runs, and V1 answers",
          category: "unified_graph",
          passed:
            externalHandOff.plannedEvents.length === 1 &&
            externalHandOff.plannedEvents[0].status === "rejected" &&
            externalHandOff.plannedEvents[0].fallback === "v1" &&
            sameList(externalHandOff.plannedEvents[0].errorCodes, ["external_output_hand_off"]) &&
            !externalHandOff.unifiedCheckpointWritten &&
            externalHandOff.graphNodeStepCount === 0 &&
            externalHandOff.v1OuterPlanRan &&
            !externalHandOff.webTextReachedAnySkill,
          detail: externalHandOff,
        }),
        buildCheck({
          id: "graph_answer_finalized_with_receipt",
          label: "The shared finalizer kept the cited risk finding and the document answer, sealed as a finalization receipt",
          category: "unified_graph",
          passed:
            answer.agentMode === "risk_review" &&
            answer.includesRiskFinding &&
            answer.includesDocumentAnswer &&
            answer.sourceKinds.length > 0 &&
            answer.sourceKinds.every((kind) => kind === "document") &&
            checkpoint.version === "v2" &&
            checkpoint.graphVersion === "v3" &&
            checkpoint.phase === "completed" &&
            checkpoint.hasFinalizationReceipt &&
            checkpoint.finalizationMatchesResponse,
          detail: { answer, checkpoint },
        }),
        buildCheck({
          id: "graph_budget_charged_per_executed_node",
          label: "Budget was reserved once per executed node and the planner was a pinned deterministic proposal",
          category: "unified_graph",
          passed:
            gating.sufficient.documentRagCalls === 1 &&
            gating.sufficient.customSkillCalls === 1 &&
            (getBudget(sufficient.response)?.used?.webSearchCalls ?? 0) === 0 &&
            planner.callCount === 1 &&
            planner.graphVersion === "v3" &&
            planner.requestedPlannerId === PROPOSAL_ID,
          detail: {
            budgetUsed: getBudget(sufficient.response)?.used ?? null,
            planner,
          },
        }),
      ],
    });
  },
});
