import { runAgentRag } from "../../../rag/agent.js";
import { dagPlannerAdapter } from "../../../rag/agent-dag-planner-adapter.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../../../rag/agent-runs.js";
import {
  getChatResponseBody,
  getExecutionPlanner,
  getSelectedSkillIds,
  getSkillChain,
  getTraceTypes,
  normalizeArray,
} from "../../chat-response-contract.js";
import {
  buildScopedRagService,
  buildSource,
  createEvalTelemetry,
  withEnvironmentOverrides,
} from "../../agent-eval-harness.js";
import {
  AGENT_EXECUTION_STEP_IDS,
  AGENT_EXECUTION_STEP_SCHEMA,
} from "../../../rag/agent-execution-plan.js";
import { llmPlannerAdapter } from "../../../rag/agent-llm-planner-adapter.js";
import { unifiedGraphLlmPlannerAdapter } from "../../../rag/agent-unified-dag-planner-adapter.js";
import { UNIFIED_GRAPH_RUN_EVENTS } from "../../../rag/agent-unified-graph-run.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
} from "../../../rag/skills/registry.js";
import {
  DEFAULT_ACCESS_SCOPE,
  buildPlannerCheck as buildCheck,
  finishPlannerCase as finishCase,
  samePlannerScope as sameScope,
} from "../checks.js";

const BUILT_IN_SKILL_TO_STEP = {
  [AGENT_SKILL_IDS.researchBrief]: AGENT_EXECUTION_STEP_IDS.researchBrief,
  [AGENT_SKILL_IDS.inventory]: AGENT_EXECUTION_STEP_IDS.inventory,
  [AGENT_SKILL_IDS.documentDiscovery]: AGENT_EXECUTION_STEP_IDS.documentDiscovery,
  [AGENT_SKILL_IDS.documentRag]: AGENT_EXECUTION_STEP_IDS.documentRag,
  [AGENT_SKILL_IDS.webSearch]: AGENT_EXECUTION_STEP_IDS.webSearch,
};

const STEP_ORDER = [
  AGENT_EXECUTION_STEP_IDS.researchBrief,
  AGENT_EXECUTION_STEP_IDS.inventory,
  AGENT_EXECUTION_STEP_IDS.documentDiscovery,
  AGENT_EXECUTION_STEP_IDS.customSkills,
  AGENT_EXECUTION_STEP_IDS.documentRag,
  AGENT_EXECUTION_STEP_IDS.webSearch,
];

const extractPromptPayload = (prompt) => {
  const text = String(prompt ?? "");
  const marker = "Input:";
  const markerIndex = text.lastIndexOf(marker);

  if (markerIndex === -1) {
    throw new Error("Planner prompt did not include an Input payload.");
  }

  return JSON.parse(text.slice(markerIndex + marker.length).trim());
};

const stepForId = ({ reason, stepId }) => {
  const schema = AGENT_EXECUTION_STEP_SCHEMA[stepId];

  return {
    condition: schema.condition,
    id: stepId,
    ...(schema.skillId ? { skillId: schema.skillId } : {}),
    reason,
  };
};

const UNIFIED_PLANNER_PROMPT_PREFIX =
  "You are planning one guarded AgentRAG execution graph (contract v3)";

// The mock v3 plan: the document answer, its evidence check, and the intent's
// Skill (or, for a workspace action, its Capability) only when that answer
// passed, reading it as priorFindings (or as the action's description).
const buildMockUnifiedGraphResponse = (payload) => {
  const skillIds = new Set(normalizeArray(payload.capabilities).map((skill) => skill.id));
  const actionId = `capability:${payload.intentPlan?.actionCapabilityId ?? ""}`;
  const isAction = payload.intentPlan?.mode === "workspace_action";
  const skillId = isAction ? actionId : payload.intentPlan?.mode;

  if (!skillIds.has("document_rag") || !skillIds.has("document_evidence_check") || !skillIds.has(skillId)) {
    throw new Error("Mock unified planner requires the document loop and the intent Skill.");
  }

  const request = (field) => ({ source: "request", field });
  const upstream = (nodeId, output) => ({ source: "node", nodeId, output });
  const gatedInputs = isAction
    ? { title: request("question"), description: upstream("document", "text") }
    : {
        docIds: request("docIds"),
        priorFindings: upstream("document", "text"),
        question: request("question"),
      };

  return JSON.stringify({
    nodes: [
      {
        nodeId: "document",
        skillId: "document_rag",
        dependsOn: [],
        inputBindings: { docIds: request("docIds"), question: request("question"), retrievalPlan: null },
        failurePolicy: "fail_fast",
        when: null,
        rationale: "Answer from the selected documents first.",
      },
      {
        nodeId: "evidence_check",
        skillId: "document_evidence_check",
        dependsOn: ["document"],
        inputBindings: {
          docIds: request("docIds"),
          evidence: upstream("document", "evidence"),
          question: request("question"),
        },
        failurePolicy: "fail_fast",
        when: null,
        rationale: "Check the document answer against its evidence.",
      },
      {
        nodeId: isAction ? "action" : skillId,
        skillId,
        dependsOn: ["document", "evidence_check"],
        inputBindings: gatedInputs,
        failurePolicy: "fail_fast",
        when: { nodeId: "evidence_check", output: "passed", equals: true },
        rationale: "Review only a verified document answer.",
      },
    ],
  });
};

export const buildMockPlannerResponse = (prompt) => {
  const payload = extractPromptPayload(prompt);
  if (prompt.startsWith(UNIFIED_PLANNER_PROMPT_PREFIX)) {
    return buildMockUnifiedGraphResponse(payload);
  }
  if (prompt.startsWith("You are planning a guarded AgentRAG execution graph.")) {
    const skillIds = new Set(normalizeArray(payload.capabilities).map((skill) => skill.id));
    const wantsComparison = /compare|differences?/i.test(payload.goal ?? "");
    const firstSkillId = wantsComparison
      ? CUSTOM_SKILL_IDS.compareDocuments
      : CUSTOM_SKILL_IDS.summarizeContract;
    const secondSkillId = CUSTOM_SKILL_IDS.riskReview;
    if (!skillIds.has(firstSkillId) || !skillIds.has(secondSkillId)) {
      throw new Error("Mock DAG planner requires the authorized goal skills.");
    }

    return JSON.stringify({
      nodes: [
        {
          nodeId: firstSkillId,
          skillId: firstSkillId,
          dependsOn: [],
          inputBindings: {
            docIds: { source: "request", field: "docIds" },
            question: { source: "request", field: "question" },
          },
          failurePolicy: "fail_fast",
          rationale: "Establish the document facts first.",
        },
        {
          nodeId: secondSkillId,
          skillId: secondSkillId,
          dependsOn: [firstSkillId],
          inputBindings: {
            docIds: { source: "request", field: "docIds" },
            question: { source: "request", field: "question" },
            priorFindings: {
              source: "node",
              nodeId: firstSkillId,
              output: "text",
            },
          },
          failurePolicy: "fail_fast",
          rationale: "Review risks arising from the documented differences.",
        },
      ],
    });
  }
  const selectedSkills = normalizeArray(payload.selectedSkills);
  const selectedSkillIds = new Set(selectedSkills.map((skill) => skill.id));
  const hasCustomSkill = selectedSkills.some((skill) => skill.kind === "custom");
  const selectedStepIds = [];

  for (const skillId of selectedSkillIds) {
    const stepId = BUILT_IN_SKILL_TO_STEP[skillId];

    if (stepId) {
      selectedStepIds.push(stepId);
    }
  }

  if (hasCustomSkill) {
    selectedStepIds.push(AGENT_EXECUTION_STEP_IDS.customSkills);
  }

  if (
    selectedStepIds.includes(AGENT_EXECUTION_STEP_IDS.documentRag) &&
    !selectedStepIds.includes(AGENT_EXECUTION_STEP_IDS.webSearch)
  ) {
    selectedStepIds.push(AGENT_EXECUTION_STEP_IDS.webSearch);
  }

  const orderedStepIds = STEP_ORDER.filter((stepId) =>
    selectedStepIds.includes(stepId)
  );

  if (orderedStepIds.length === 0) {
    throw new Error("Mock planner could not derive a step from selected skills.");
  }

  return JSON.stringify({
    steps: orderedStepIds.map((stepId) =>
      stepForId({
        reason: "Mock planner selected this registered AgentRAG step.",
        stepId,
      })
    ),
  });
};

export const createMockPlannerProvider = () => ({
  completeText: async (prompt) => buildMockPlannerResponse(prompt),
});

const createInventoryCase = ({ plannerAdapter = llmPlannerAdapter } = {}) => ({
  id: "planner_inventory",
  label: "Inventory planner selection",
  description:
    "The LLM planner should select the inventory step for a workspace document listing request.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const ragService = buildScopedRagService({
      sameScope,
      documents: [
        {
          chunkCount: 14,
          docId: "policy-1",
          fileName: "remote-work-policy.pdf",
          pageCount: 8,
        },
        {
          chunkCount: 21,
          docId: "contract-1",
          fileName: "services-agreement.pdf",
          pageCount: 12,
        },
      ],
      telemetry,
      chat: async () => {
        throw new Error("Document RAG should not run for inventory prompts.");
      },
    });
    const response = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: [],
      executionPlannerAdapter: plannerAdapter,
      question: "What documents are indexed?",
      ragService,
      sessionId: "planner-eval",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => {
        throw new Error("Web search should not run for inventory prompts.");
      },
    });
    const planner = getExecutionPlanner(response);
    const body = getChatResponseBody(response);

    return finishCase({
      checks: [
        buildCheck({
          category: "planner",
          detail: planner,
          id: "llm_planner_selected",
          label: "LLM planner selected the inventory step",
          passed:
            planner?.requestedPlannerId === "llm" &&
            planner?.selectedPlannerId === "llm" &&
            planner?.status === "selected" &&
            planner?.stepIds?.join(">") === AGENT_EXECUTION_STEP_IDS.inventory,
        }),
        buildCheck({
          category: "execution",
          detail: body.agentMode,
          id: "inventory_mode",
          label: "Agent answered in inventory mode",
          passed: body.agentMode === "inventory",
        }),
        buildCheck({
          category: "observability",
          detail: getSelectedSkillIds(response),
          id: "selected_inventory_skill",
          label: "Observability records the selected inventory skill",
          passed: getSelectedSkillIds(response).includes(AGENT_SKILL_IDS.inventory),
        }),
      ],
      description:
        "The LLM planner should select the inventory step for a workspace document listing request.",
      id: "planner_inventory",
      label: "Inventory planner selection",
      response,
      telemetry,
    });
  },
});

const createDocumentCase = ({ plannerAdapter = llmPlannerAdapter } = {}) => ({
  id: "planner_document_rag",
  label: "Document planner selection",
  description:
    "The LLM planner should select document_rag with a conditional web fallback for a selected-document QA request.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const citation = buildSource({
      docId: "policy-1",
      excerpt:
        "Remote work requires manager approval before the first remote day.",
      fileName: "remote-work-policy.pdf",
      pageNumber: 2,
    });
    const ragService = buildScopedRagService({
      sameScope,
      documents: [
        {
          docId: "policy-1",
          fileName: "remote-work-policy.pdf",
        },
      ],
      telemetry,
      chat: async ({ question }) => ({
        abstained: false,
        citations: [citation],
        memoryApplied: false,
        resolvedQuery: question,
        text: "Remote work requires manager approval before the first remote day. [Source 1]",
      }),
    });
    const response = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: ["policy-1"],
      executionPlannerAdapter: plannerAdapter,
      question: "What does remote work require?",
      ragService,
      sessionId: "planner-eval",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => {
        throw new Error(
          "Web search should not run when document evidence is sufficient."
        );
      },
    });
    const planner = getExecutionPlanner(response);

    return finishCase({
      checks: [
        buildCheck({
          category: "planner",
          detail: planner,
          id: "llm_planner_selected_document_rag",
          label: "LLM planner selected document_rag",
          passed:
            planner?.requestedPlannerId === "llm" &&
            planner?.selectedPlannerId === "llm" &&
            planner?.stepIds?.includes(AGENT_EXECUTION_STEP_IDS.documentRag),
        }),
        buildCheck({
          category: "planner",
          detail: planner,
          id: "llm_planner_kept_conditional_web_fallback",
          label: "LLM planner kept web_search as a conditional fallback",
          passed:
            planner?.stepIds?.join(">") ===
            [
              AGENT_EXECUTION_STEP_IDS.documentRag,
              AGENT_EXECUTION_STEP_IDS.webSearch,
            ].join(">"),
        }),
        buildCheck({
          category: "execution",
          detail: getTraceTypes(response),
          id: "document_trace_ran",
          label: "Document RAG trace ran",
          passed: getTraceTypes(response).includes("document_rag"),
        }),
        buildCheck({
          category: "execution",
          detail: getTraceTypes(response),
          id: "web_fallback_not_executed_when_document_sufficient",
          label: "Web fallback did not execute when document evidence was sufficient",
          passed: !getTraceTypes(response).includes("web_search"),
        }),
        buildCheck({
          category: "validator",
          detail: planner,
          id: "no_planner_fallback",
          label: "Validated plan did not fallback",
          passed: planner?.fallback === false,
        }),
      ],
      description:
        "The LLM planner should select document_rag with a conditional web fallback for a selected-document QA request.",
      id: "planner_document_rag",
      label: "Document planner selection",
      response,
      telemetry,
    });
  },
});

const createWebCase = ({ plannerAdapter = llmPlannerAdapter } = {}) => ({
  id: "planner_web_search",
  label: "Web planner selection",
  description:
    "The LLM planner should select web_search for a current-information request without selected documents.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const ragService = buildScopedRagService({
      sameScope,
      documents: [],
      telemetry,
      chat: async () => {
        throw new Error("Document RAG should not run for web-only prompts.");
      },
    });
    const response = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: [],
      executionPlannerAdapter: plannerAdapter,
      question: "What is the latest OpenAI news today?",
      ragService,
      sessionId: "planner-eval",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({
        citations: [],
        text: "Current web answer.",
      }),
    });
    const planner = getExecutionPlanner(response);
    const body = getChatResponseBody(response);

    return finishCase({
      checks: [
        buildCheck({
          category: "planner",
          detail: planner,
          id: "llm_planner_selected_web_search",
          label: "LLM planner selected web_search",
          passed:
            planner?.requestedPlannerId === "llm" &&
            planner?.selectedPlannerId === "llm" &&
            planner?.stepIds?.join(">") === AGENT_EXECUTION_STEP_IDS.webSearch,
        }),
        buildCheck({
          category: "execution",
          detail: {
            agentMode: body.agentMode,
            clarification: body.clarification,
            traceTypes: getTraceTypes(response),
          },
          id: "web_action_boundary_gate",
          label: "Web search stops at the capability approval gate",
          passed:
            body.agentMode === "clarification" &&
            body.clarification?.reason === "capability_approval_required" &&
            getTraceTypes(response).includes("capability_approval_gate") &&
            !getTraceTypes(response).includes("web_search"),
        }),
        buildCheck({
          category: "observability",
          detail: getSelectedSkillIds(response),
          id: "selected_web_skill",
          label: "Observability records web_search selection",
          passed: getSelectedSkillIds(response).includes(AGENT_SKILL_IDS.webSearch),
        }),
      ],
      description:
        "The LLM planner should select web_search for a current-information request without selected documents.",
      id: "planner_web_search",
      label: "Web planner selection",
      response,
      telemetry,
    });
  },
});

const createCustomChainCase = ({ plannerAdapter = llmPlannerAdapter } = {}) => ({
  id: "planner_custom_chain",
  label: "Custom skill chain planner selection",
  description:
    "The LLM planner should route a contract review chain through the custom_skills step.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const citation = buildSource({
      docId: "contract-1",
      excerpt:
        "The services agreement renews every 12 months unless either party gives 30 days notice.",
      fileName: "services-agreement.pdf",
      pageNumber: 3,
    });
    const ragService = buildScopedRagService({
      sameScope,
      documents: [
        {
          docId: "contract-1",
          fileName: "services-agreement.pdf",
        },
      ],
      telemetry,
      chat: async ({ question }) => {
        const isRiskReview = /risk review|risks?|gaps?|exceptions?/i.test(
          question
        );

        return {
          abstained: false,
          citations: [citation],
          memoryApplied: false,
          resolvedQuery: question,
          text: isRiskReview
            ? [
                "Risk Review",
                "- Risk: Late notice creates renewal risk. [Source 1]",
              ].join("\n")
            : [
                "Contract Summary",
                "- Key Terms: The agreement renews every 12 months unless either party gives 30 days notice. [Source 1]",
              ].join("\n"),
        };
      },
    });
    const response = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: ["contract-1"],
      executionPlannerAdapter: plannerAdapter,
      question: "Review this contract for risks and key terms.",
      ragService,
      sessionId: "planner-eval",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({
        text: "web should not run",
      }),
    });
    const planner = getExecutionPlanner(response);
    const skillChain = getSkillChain(response);

    return finishCase({
      checks: [
        buildCheck({
          category: "planner",
          detail: planner,
          id: "llm_planner_selected_custom_skills",
          label: "LLM planner selected custom_skills",
          passed:
            planner?.requestedPlannerId === "llm" &&
            planner?.selectedPlannerId === "llm" &&
            planner?.stepIds?.join(">") === AGENT_EXECUTION_STEP_IDS.customSkills,
        }),
        buildCheck({
          category: "execution",
          detail: skillChain,
          id: "custom_chain_order",
          label: "Custom skill chain order is preserved",
          passed:
            skillChain.map((skill) => skill.skillId).join(">") ===
            `${CUSTOM_SKILL_IDS.summarizeContract}>${CUSTOM_SKILL_IDS.riskReview}`,
        }),
        buildCheck({
          category: "observability",
          detail: getTraceTypes(response),
          id: "custom_skill_trace",
          label: "Custom skill traces ran",
          passed:
            getTraceTypes(response).filter((type) => type === "custom_skill")
              .length === 2,
        }),
      ],
      description:
        "The LLM planner should route a contract review chain through the custom_skills step.",
      id: "planner_custom_chain",
      label: "Custom skill chain planner selection",
      response,
      telemetry,
    });
  },
});

const createDynamicSkillGraphCase = ({ plannerAdapter = llmPlannerAdapter } = {}) => ({
  id: "planner_dynamic_skill_graph",
  label: "Real DAG planner composes atomic skills",
  description:
    "With only the compare intent selected, the DAG planner must compose comparison and risk review from the authorized atomic Skill catalog.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const docIds = ["agreement-a", "agreement-b"];
    const sources = [
      buildSource({
        docId: docIds[0],
        excerpt: "Agreement A requires 30 days notice before renewal.",
        fileName: "agreement-a.pdf",
        pageNumber: 2,
      }),
      buildSource({
        docId: docIds[1],
        excerpt: "Agreement B requires 60 days notice before renewal.",
        fileName: "agreement-b.pdf",
        pageNumber: 3,
      }),
    ];
    const ragService = buildScopedRagService({
      sameScope,
      documents: docIds.map((docId, index) => ({
        docId,
        fileName: `agreement-${index === 0 ? "a" : "b"}.pdf`,
      })),
      telemetry,
      chat: async ({ callIndex, question }) => ({
        abstained: false,
        citations: sources,
        memoryApplied: false,
        resolvedQuery: question,
        text: callIndex === 1
          ? "Comparison: Agreement A requires 30 days notice [Source 1]; Agreement B requires 60 days notice [Source 2]."
          : "Risk review: A 45-day notice meets Agreement A's 30-day requirement [Source 1] but misses Agreement B's 60-day requirement [Source 2].",
      }),
    });
    const compareOnlyIntentAdapter = {
      id: "deterministic",
      selectIntentPlan: async ({ candidates = [] } = {}) => ({
        selectedIntentId: candidates.find(
          (candidate) => candidate.id === CUSTOM_SKILL_IDS.compareDocuments
        )?.id ?? "",
        reason: "Pin the narrower compare intent to test atomic DAG composition.",
      }),
    };
    const response = await withEnvironmentOverrides(
      { AGENT_SKILL_GRAPH_ROLLOUT: "guarded" },
      () => runAgentRag({
        accessScope: DEFAULT_ACCESS_SCOPE,
        agentRunService,
        dagPlannerAdapter,
        docIds,
        executionPlannerAdapter: plannerAdapter,
        intentPlannerAdapter: compareOnlyIntentAdapter,
        question:
          "Compare the two selected agreements and identify risks caused by their differences.",
        ragService,
        sessionId: "planner-dynamic-graph-eval",
        userId: DEFAULT_ACCESS_SCOPE.userId,
        webChatService: async () => {
          throw new Error("Web search must not run for selected-document comparison.");
        },
      })
    );
    const body = getChatResponseBody(response);
    const run = await agentRunService.getRun({
      accessScope: DEFAULT_ACCESS_SCOPE,
      runId: body.agentRunId,
    });
    const graphEvent = (run?.events ?? []).filter(
      (event) => event.type === "skill_graph_planned"
    ).at(-1)?.payload ?? null;
    const nodeRuns = graphEvent?.nodeRuns ?? [];
    const compareNodeId = nodeRuns.find(
      (nodeRun) => nodeRun.skillId === CUSTOM_SKILL_IDS.compareDocuments
    )?.nodeId;
    const graph = {
      errorCodes: graphEvent?.errorCodes ?? [],
      executed: graphEvent?.executed ?? false,
      fallback: graphEvent?.fallback ?? null,
      mode: graphEvent?.mode ?? null,
      nodeStatuses: nodeRuns.map((nodeRun) => nodeRun.status),
      nodeSkills: nodeRuns.map((nodeRun) => nodeRun.skillId),
      plannerFallback: graphEvent?.planner?.fallback ?? null,
      plannerFallbackReason: graphEvent?.planner?.fallbackReason ?? null,
      selectedPlannerId: graphEvent?.planner?.selectedPlannerId ?? null,
      status: graphEvent?.status ?? null,
      riskDependsOnCompare: nodeRuns.find(
        (nodeRun) => nodeRun.skillId === CUSTOM_SKILL_IDS.riskReview
      )?.dependsOn?.includes(compareNodeId) ?? false,
    };
    telemetry.skillGraph = graph;

    return finishCase({
      checks: [
        buildCheck({
          category: "planner",
          detail: body.agentObservability?.intentPlanner,
          id: "compare_only_intent_selected",
          label: "The upstream intent selected only comparison",
          passed:
            body.agentObservability?.intentPlanner?.selectedIntentId ===
            CUSTOM_SKILL_IDS.compareDocuments,
        }),
        buildCheck({
          category: "planner",
          detail: graph,
          id: "real_dag_planner_selected",
          label: "The guarded DAG used the LLM planner without fallback",
          passed:
            graph.mode === "guarded" &&
            graph.executed === true &&
            graph.fallback === null &&
            graph.status === "completed" &&
            graph.plannerFallback === false &&
            graph.selectedPlannerId === "llm_dag",
        }),
        buildCheck({
          category: "execution",
          detail: graph,
          id: "dag_composed_compare_then_risk",
          label: "The DAG composed comparison then risk review",
          passed:
            graph.nodeSkills.join(">") ===
              `${CUSTOM_SKILL_IDS.compareDocuments}>${CUSTOM_SKILL_IDS.riskReview}` &&
            graph.nodeStatuses.join(">") === "completed>completed" &&
            graph.riskDependsOnCompare,
        }),
        buildCheck({
          category: "observability",
          detail: getSelectedSkillIds(response),
          id: "dag_selected_skills_observed",
          label: "Both executed skills are visible in Agent observability",
          passed:
            getSelectedSkillIds(response).includes(CUSTOM_SKILL_IDS.compareDocuments) &&
            getSelectedSkillIds(response).includes(CUSTOM_SKILL_IDS.riskReview) &&
            getTraceTypes(response).filter((type) => type === "custom_skill")
              .length === 2,
        }),
        buildCheck({
          category: "execution",
          detail: telemetry.chatCalls.map((call) => call.docIds),
          id: "dag_kept_document_scope",
          label: "Both skills read exactly the two selected documents",
          passed:
            telemetry.chatCalls.length === 2 &&
            telemetry.chatCalls.every((call) =>
              call.docIds.length === docIds.length &&
              new Set(call.docIds).size === docIds.length &&
              docIds.every((docId) => call.docIds.includes(docId))
            ),
        }),
      ],
      description:
        "With only the compare intent selected, the DAG planner must compose comparison and risk review from the authorized atomic Skill catalog.",
      id: "planner_dynamic_skill_graph",
      label: "Real DAG planner composes atomic skills",
      response,
      telemetry,
    });
  },
});

// The v3 (unified) graph planner: one graph for the whole request. A
// risk-review request on a selected document should be planned as the
// document answer, its evidence check, and the Skill gated on that check,
// reading the verified answer; the runtime validator and admission judge the
// plan, and a refused plan is replaced whole by the deterministic graph (which
// fails the planner checks here: the model's own plan is what is measured).
const UNIFIED_DOC_ID = "vendor-msa";
const UNIFIED_QUESTION =
  "Run a risk review of the vendor notice terms: what notice period does the vendor require?";
const UNIFIED_EXCERPT = "The vendor requires 30 days written notice before renewal.";
const UNIFIED_RISK_EXCERPT =
  "The agreement renews automatically unless the customer gives notice before the renewal date.";

const createUnifiedGraphCase = ({
  unifiedPlannerAdapter = unifiedGraphLlmPlannerAdapter,
} = {}) => ({
  id: "planner_unified_graph",
  label: "Unified graph planner composes an evidence-gated graph",
  description:
    "Under AGENT_UNIFIED_GRAPH_ROLLOUT=guarded the v3 planner should plan the whole request as the document answer, its evidence check, and the risk_review Skill gated on that check, and the runtime should admit and execute its plan without fallback.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const ragService = buildScopedRagService({
      sameScope,
      documents: [{ docId: UNIFIED_DOC_ID, fileName: "vendor-msa.pdf" }],
      telemetry,
      chat: async ({ question }) =>
        /Perform a concise citation-backed risk review/.test(question)
          ? {
              abstained: false,
              citations: [
                buildSource({
                  docId: UNIFIED_DOC_ID,
                  excerpt: UNIFIED_RISK_EXCERPT,
                  fileName: "vendor-msa.pdf",
                  pageNumber: 4,
                }),
              ],
              text: ["Risk Review", `- Risk: ${UNIFIED_RISK_EXCERPT} [Source 1]`].join("\n"),
            }
          : {
              abstained: false,
              citations: [
                buildSource({
                  docId: UNIFIED_DOC_ID,
                  excerpt: UNIFIED_EXCERPT,
                  fileName: "vendor-msa.pdf",
                  pageNumber: 2,
                }),
              ],
              text: `${UNIFIED_EXCERPT} [Source 1]`,
            },
    });
    const response = await withEnvironmentOverrides(
      { AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded" },
      () => runAgentRag({
        accessScope: DEFAULT_ACCESS_SCOPE,
        agentRunService,
        docIds: [UNIFIED_DOC_ID],
        question: UNIFIED_QUESTION,
        ragService,
        sessionId: "planner-unified-graph-eval",
        unifiedGraphPlannerAdapter: unifiedPlannerAdapter,
        userId: DEFAULT_ACCESS_SCOPE.userId,
        webChatService: async () => {
          throw new Error("Web search must not run for a selected-document risk review.");
        },
      })
    );
    const body = getChatResponseBody(response);
    const run = await agentRunService.getRun({
      accessScope: DEFAULT_ACCESS_SCOPE,
      runId: body.agentRunId,
    });
    const checkpoint = (await agentRunService.getExecutionGraphCheckpoint({
      accessScope: DEFAULT_ACCESS_SCOPE,
      runId: body.agentRunId,
    }))?.checkpoint ?? null;
    const plannedEvent = (run?.events ?? []).filter(
      (event) => event.type === UNIFIED_GRAPH_RUN_EVENTS.planned
    ).at(-1)?.payload ?? null;
    const executedEvent = (run?.events ?? []).filter(
      (event) => event.type === UNIFIED_GRAPH_RUN_EVENTS.executed
    ).at(-1)?.payload ?? null;
    const nodes = checkpoint?.graph?.nodes ?? [];
    const documentNode = nodes.find((node) => node.skillId === AGENT_SKILL_IDS.documentRag) ?? null;
    const checkNode =
      nodes.find((node) => node.skillId === AGENT_SKILL_IDS.documentEvidenceCheck) ?? null;
    const riskNode = nodes.find((node) => node.skillId === CUSTOM_SKILL_IDS.riskReview) ?? null;
    const plannerCall = plannedEvent?.planner?.plannerCall ?? null;
    const graph = {
      errorCodes: plannedEvent?.errorCodes ?? [],
      executed: executedEvent?.executed ?? false,
      fallback: plannedEvent?.fallback ?? null,
      mode: plannedEvent?.mode ?? null,
      nodeSkills: nodes.map((node) => node.skillId),
      nodeStatuses: (executedEvent?.nodeRuns ?? []).map((nodeRun) => nodeRun.status),
      plannerFallback: plannedEvent?.planner?.fallback ?? null,
      plannerFallbackReasonCodes: plannedEvent?.planner?.fallbackReasonCodes ?? [],
      selectedPlannerId: plannedEvent?.planner?.selectedPlannerId ?? null,
      status: plannedEvent?.status ?? null,
    };
    telemetry.skillGraph = graph;

    return finishCase({
      checks: [
        buildCheck({
          category: "planner",
          detail: plannedEvent?.planner ?? null,
          id: "unified_planner_selected",
          label: "The v3 planner's own plan was admitted, without fallback",
          passed:
            graph.status === "selected" &&
            graph.fallback === null &&
            graph.plannerFallback === false &&
            plannedEvent?.planner?.requestedPlannerId === "llm_unified_graph" &&
            graph.selectedPlannerId === "llm_unified_graph",
        }),
        buildCheck({
          category: "execution",
          detail: { executedStatus: executedEvent?.status ?? null, runStatus: run?.status ?? null },
          id: "unified_graph_answered_request",
          label: "The admitted graph answered the whole request; the V1 outer plan never ran",
          passed:
            executedEvent?.status === "completed" &&
            run?.status === "completed" &&
            response.status === 200 &&
            !(run?.events ?? []).some((event) => event.type === "execution_planned"),
        }),
        buildCheck({
          category: "execution",
          detail: documentNode,
          id: "unified_graph_document_first",
          label: "The document answer runs first, unconditionally, on the request",
          passed:
            Boolean(documentNode) &&
            (documentNode.dependsOn ?? []).length === 0 &&
            documentNode.when === undefined &&
            documentNode.inputBindings?.question?.source === "request",
        }),
        buildCheck({
          category: "planner",
          detail: { checkNode, riskNode },
          id: "unified_graph_skill_gated_on_evidence",
          label: "risk_review runs only when the document answer passed its evidence check",
          passed:
            Boolean(checkNode && riskNode && documentNode) &&
            checkNode.inputBindings?.evidence?.nodeId === documentNode.nodeId &&
            riskNode.when?.nodeId === checkNode.nodeId &&
            riskNode.when?.output === "passed" &&
            riskNode.when?.equals === true,
        }),
        buildCheck({
          category: "observability",
          detail: plannerCall,
          id: "unified_planner_call_measured",
          label: "The planner call's latency and prompt template are recorded on the run",
          passed:
            Number.isFinite(plannerCall?.latencyMs) &&
            plannerCall?.promptTemplate?.id === "unified_graph_planner",
        }),
      ],
      description:
        "Under AGENT_UNIFIED_GRAPH_ROLLOUT=guarded the v3 planner should plan the whole request as the document answer, its evidence check, and the risk_review Skill gated on that check, and the runtime should admit and execute its plan without fallback.",
      id: "planner_unified_graph",
      label: "Unified graph planner composes an evidence-gated graph",
      response,
      telemetry,
    });
  },
});

const createInvalidFallbackCase = () => ({
  id: "planner_invalid_fallback",
  label: "Invalid planner fallback",
  description:
    "An unsafe LLM-style execution plan should fail validation and fallback to deterministic execution.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const unsafePlannerAdapter = {
      id: "llm",
      createExecutionPlan: async () => [
        {
          id: "shell_tool",
          reason: "Attempt to call an unregistered tool.",
        },
      ],
    };
    const ragService = buildScopedRagService({
      sameScope,
      documents: [
        {
          chunkCount: 4,
          docId: "policy-1",
          fileName: "remote-work-policy.pdf",
          pageCount: 2,
        },
      ],
      telemetry,
      chat: async () => {
        throw new Error("Document RAG should not run for inventory prompts.");
      },
    });
    const response = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: [],
      executionPlannerAdapter: unsafePlannerAdapter,
      question: "What documents are indexed?",
      ragService,
      sessionId: "planner-eval",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => {
        throw new Error("Web search should not run for inventory prompts.");
      },
    });
    const planner = getExecutionPlanner(response);
    const body = getChatResponseBody(response);

    return finishCase({
      checks: [
        buildCheck({
          category: "fallback",
          detail: planner,
          id: "fallback_to_deterministic",
          label: "Invalid planner output falls back to deterministic",
          passed:
            planner?.requestedPlannerId === "llm" &&
            planner?.selectedPlannerId === "deterministic" &&
            planner?.status === "fallback" &&
            planner?.fallback === true,
        }),
        buildCheck({
          category: "validator",
          detail: planner?.fallbackReason,
          id: "fallback_reason_records_validator_error",
          label: "Fallback reason records validator rejection",
          passed: /unknown execution step shell_tool/.test(
            planner?.fallbackReason ?? ""
          ),
        }),
        buildCheck({
          category: "execution",
          detail: body.agentMode,
          id: "fallback_still_executes",
          label: "Fallback plan still executes the request",
          passed: body.agentMode === "inventory",
        }),
      ],
      description:
        "An unsafe LLM-style execution plan should fail validation and fallback to deterministic execution.",
      id: "planner_invalid_fallback",
      label: "Invalid planner fallback",
      response,
      telemetry,
    });
  },
});

export const createDefaultPlannerCases = ({
  plannerAdapter = llmPlannerAdapter,
} = {}) => [
  createInventoryCase({
    plannerAdapter,
  }),
  createDocumentCase({
    plannerAdapter,
  }),
  createWebCase({
    plannerAdapter,
  }),
  createCustomChainCase({
    plannerAdapter,
  }),
  createDynamicSkillGraphCase({
    plannerAdapter,
  }),
  createUnifiedGraphCase(),
  createInvalidFallbackCase(),
];
