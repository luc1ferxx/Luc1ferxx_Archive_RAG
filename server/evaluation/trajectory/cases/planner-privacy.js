import { runAgentRag } from "../../../rag/agent.js";
import { createAgentRunStepExecutor } from "../../../rag/agent-run-step-executor.js";
import { createCustomSkillStepExecutor } from "../../../rag/agent-run-step-handlers/index.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../../../rag/agent-runs.js";
import {
  CAPABILITY_IDS,
  CAPABILITY_POLICY_DECISIONS,
  createCapabilityRegistry,
  createRecommendationImportSelectedCapability,
  createWebSearchCapability,
  evaluateCapabilityPolicy,
} from "../../../rag/capabilities/index.js";
import {
  getAgentWorkingMemory,
  getChatResponseBody,
  getClarification,
  getExecutionPlanner,
  getExecutionLoop,
  getIntentPlanner,
  getObservedSkill,
  getRunPhases,
  getSelectedSkillIds,
  getSkillChainIds,
  getTraceSteps,
  getTraceTypes,
  hasTraceStep,
} from "../../chat-response-contract.js";
import {
  buildScopedRagService,
  buildSource,
  createEvalTelemetry,
} from "../../agent-eval-harness.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
} from "../../../rag/skills/registry.js";
import {
  DEFAULT_ACCESS_SCOPE,
  buildTrajectoryCheck as buildCheck,
  finishTrajectoryCase as finishCase,
  sameTrajectoryScope as sameScope,
} from "../checks.js";

export const createPlannerFallbackCase = () => ({
  id: "planner_fallback",
  label: "Planner fallback",
  description:
    "Invalid intent and execution planner adapter output should fall back to deterministic whitelisted plans.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const unsafeIntentPlannerAdapter = {
      id: "unsafe_intent_adapter",
      selectIntentPlan: async () => ({
        selectedIntentId: "shell.exec",
        reason: "Attempt to select an unregistered tool.",
      }),
    };
    const unsafeExecutionPlannerAdapter = {
      id: "unsafe_execution_adapter",
      createExecutionPlan: async () => [
        {
          id: "shell_exec",
          skillId: "shell.exec",
        },
      ],
    };
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
        text:
          "Remote work requires manager approval before the first remote day. [Source 1]",
        citations: [
          buildSource({
            docId: "policy-1",
            fileName: "remote-work-policy.pdf",
            pageNumber: 2,
            excerpt:
              "Remote work requires manager approval before the first remote day.",
          }),
        ],
        abstained: false,
        resolvedQuery: question,
        memoryApplied: false,
      }),
    });
    const response = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: ["policy-1"],
      executionPlannerAdapter: unsafeExecutionPlannerAdapter,
      intentPlannerAdapter: unsafeIntentPlannerAdapter,
      question: "What does remote work require?",
      ragService,
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({
        text: "web should not run",
      }),
    });
    const body = getChatResponseBody(response);
    const intentPlanner = getIntentPlanner(response);
    const executionPlanner = getExecutionPlanner(response);

    return finishCase({
      id: "planner_fallback",
      label: "Planner fallback",
      description:
        "Invalid intent and execution planner adapter output should fall back to deterministic whitelisted plans.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "intent_planner_fell_back",
          label: "Intent planner fell back from invalid adapter output",
          category: "planner",
          passed:
            intentPlanner?.fallback === true &&
            intentPlanner?.requestedPlannerId === "unsafe_intent_adapter" &&
            intentPlanner?.selectedPlannerId === "deterministic",
          detail: intentPlanner,
        }),
        buildCheck({
          id: "execution_planner_fell_back",
          label: "Execution planner fell back from invalid adapter output",
          category: "planner",
          passed:
            executionPlanner?.fallback === true &&
            executionPlanner?.requestedPlannerId ===
              "unsafe_execution_adapter" &&
            executionPlanner?.selectedPlannerId === "deterministic",
          detail: executionPlanner,
        }),
        buildCheck({
          id: "fallback_runs_document_rag",
          label: "Fallback plan still runs whitelisted document RAG",
          category: "planner",
          passed:
            body.agentMode === "document" &&
            getSelectedSkillIds(response).includes(AGENT_SKILL_IDS.documentRag) &&
            hasTraceStep(response, "document_rag"),
          detail: {
            agentMode: body.agentMode,
            selectedSkills: getSelectedSkillIds(response),
            traceTypes: getTraceTypes(response),
          },
        }),
      ],
    });
  },
});


export const createPrivacySanitizationCase = () => ({
  id: "privacy_sanitization",
  label: "Privacy sanitization",
  description:
    "Capability approval previews should expose only whitelisted sanitized fields, not private selection tokens.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const secretToken = "secret-selection-token";
    const capability = createRecommendationImportSelectedCapability({
      arxivEnrichmentService: {
        importForDocument: async () => {
          throw new Error("Import should not execute during policy evaluation.");
        },
      },
    });
    const policyResult = evaluateCapabilityPolicy(capability, {
      accessScope: DEFAULT_ACCESS_SCOPE,
      input: {
        docId: "doc-1",
        provider: "arxiv",
        selectedIds: ["2401.00001v1"],
        selectionToken: secretToken,
      },
    });
    const preview = policyResult.approvalGate?.inputPreview ?? {};
    const previewText = JSON.stringify(preview);
    const response = {
      status: 200,
      body: {
        agentMode: "capability_privacy",
        agentTrace: [],
        agentObservability: {
          agentMode: "capability_privacy",
        },
      },
    };

    return finishCase({
      id: "privacy_sanitization",
      label: "Privacy sanitization",
      description:
        "Capability approval previews should expose only whitelisted sanitized fields, not private selection tokens.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "approval_required_for_import",
          label: "Recommendation import requires approval",
          category: "privacy",
          passed:
            policyResult.decision ===
              CAPABILITY_POLICY_DECISIONS.needsApproval &&
            policyResult.approvalGate?.capabilityId ===
              CAPABILITY_IDS.recommendationImportSelected,
          detail: policyResult.approvalGate ?? null,
        }),
        buildCheck({
          id: "selection_token_not_previewed",
          label: "Selection token is not included in approval preview",
          category: "privacy",
          passed:
            preview.selectionToken === undefined &&
            !previewText.includes(secretToken),
          detail: preview,
        }),
        buildCheck({
          id: "safe_preview_fields_remain",
          label: "Approval preview keeps safe contextual fields",
          category: "privacy",
          passed:
            preview.provider === "arxiv" &&
            preview.docId === "doc-1" &&
            Array.isArray(preview.selectedIds) &&
            preview.selectedIds.includes("2401.00001v1"),
          detail: preview,
        }),
        buildCheck({
          id: "risk_flags_visible",
          label: "Approval gate exposes privacy risk flags",
          category: "privacy",
          passed:
            policyResult.riskFlags.includes("external_call") &&
            policyResult.riskFlags.includes("writes_workspace") &&
            policyResult.riskFlags.includes("stores_result"),
          detail: policyResult.riskFlags,
        }),
      ],
    });
  },
});
