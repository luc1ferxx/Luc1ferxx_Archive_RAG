import { runAgentRag } from "../../../rag/agent.js";
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
} from "../../agent-eval-harness.js";
import {
  AGENT_EXECUTION_STEP_IDS,
  AGENT_EXECUTION_STEP_SCHEMA,
} from "../../../rag/agent-execution-plan.js";
import { llmPlannerAdapter } from "../../../rag/agent-llm-planner-adapter.js";
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

export const buildMockPlannerResponse = (prompt) => {
  const payload = extractPromptPayload(prompt);
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
  createInvalidFallbackCase(),
];
