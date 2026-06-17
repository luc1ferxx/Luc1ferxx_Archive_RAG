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

export const createMemoryNotEvidenceCase = () => ({
  id: "memory_not_evidence",
  label: "Memory is not evidence",
  description:
    "Long-memory hints may affect context, but unsupported memory-derived claims must not count as document evidence.",
  run: async () => {
    const telemetry = createEvalTelemetry();
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
          "Remote work requires manager approval. Alice prefers 20 remote days. [Source 1]",
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
        memoryApplied: true,
      }),
    });
    const response = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      agentBudget: {
        maxDocumentRagCalls: 1,
      },
      docIds: ["policy-1"],
      question: "What does remote work require?",
      ragService,
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => {
        throw new Error("Web search should not run for memory evidence checks.");
      },
    });
    const body = getChatResponseBody(response);
    const selfCheck = getTraceSteps(response, "self_check")[0];
    const workingMemory = getAgentWorkingMemory(response);
    const unsupportedClaims = Array.isArray(workingMemory.unsupportedClaims)
      ? workingMemory.unsupportedClaims
      : [];

    return finishCase({
      id: "memory_not_evidence",
      label: "Memory is not evidence",
      description:
        "Long-memory hints may affect context, but unsupported memory-derived claims must not count as document evidence.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "memory_not_promoted_to_evidence",
          label: "Clarification did not promote memory-only text to evidence",
          category: "memory",
          passed:
            body.ragMemoryApplied === false &&
            body.ragAbstained === true &&
            (body.ragSources ?? []).length === 0,
          detail: {
            ragAbstained: body.ragAbstained,
            ragMemoryApplied: body.ragMemoryApplied,
            sourceCount: body.ragSources?.length ?? 0,
          },
        }),
        buildCheck({
          id: "memory_claim_failed_support",
          label: "Memory-derived claim failed claim support",
          category: "memory",
          passed:
            selfCheck?.status === "failed" &&
            unsupportedClaims.some((claim) =>
              /alice prefers 20 remote days/i.test(claim.text)
            ),
          detail: {
            selfCheckStatus: selfCheck?.status ?? null,
            unsupportedClaims,
          },
        }),
        buildCheck({
          id: "memory_gap_not_evidence",
          label: "Unsupported memory claim became a gap instead of evidence",
          category: "memory",
          passed:
            hasTraceStep(response, "gap_analysis") &&
            body.clarification?.reason === "document_follow_up_budget_exhausted",
          detail: {
            clarification: body.clarification,
            traceTypes: getTraceTypes(response),
          },
        }),
      ],
    });
  },
});


export const createMultiDocConflictCase = () => ({
  id: "multi_doc_conflict",
  label: "Multi-doc conflict",
  description:
    "A multi-document comparison should surface conflicts with evidence from each selected document.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const docACitation = buildSource({
      docId: "policy-a",
      fileName: "remote-policy-a.pdf",
      pageNumber: 1,
      excerpt: "Policy A allows two remote work days per week.",
    });
    const docBCitation = buildSource({
      docId: "policy-b",
      fileName: "remote-policy-b.pdf",
      pageNumber: 1,
      excerpt: "Policy B allows three remote work days per week.",
    });
    const ragService = buildScopedRagService({
      sameScope,
      documents: [
        {
          docId: "policy-a",
          fileName: "remote-policy-a.pdf",
        },
        {
          docId: "policy-b",
          fileName: "remote-policy-b.pdf",
        },
      ],
      telemetry,
      chat: async ({ question }) => ({
        text: [
          "Document Comparison",
          "Conflicts",
          "- Conflict: Policy A allows two remote work days per week, while Policy B allows three remote work days per week. [Source 1] [Source 2]",
        ].join("\n"),
        citations: [docACitation, docBCitation],
        abstained: false,
        resolvedQuery: question,
        memoryApplied: false,
      }),
    });
    const response = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: ["policy-a", "policy-b"],
      question: "Compare these remote work policies for differences.",
      ragService,
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({
        text: "web should not run",
      }),
    });
    const body = getChatResponseBody(response);
    const citationDocIds = new Set(
      (body.ragSources ?? []).map((source) => source.docId).filter(Boolean)
    );
    const customStep = getTraceSteps(response, "custom_skill")[0];

    return finishCase({
      id: "multi_doc_conflict",
      label: "Multi-doc conflict",
      description:
        "A multi-document comparison should surface conflicts with evidence from each selected document.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "compare_skill_selected",
          label: "Compare documents custom skill selected",
          category: "conflict",
          passed: getSelectedSkillIds(response).includes(
            CUSTOM_SKILL_IDS.compareDocuments
          ),
          detail: getSelectedSkillIds(response),
        }),
        buildCheck({
          id: "conflict_answered",
          label: "Answer surfaces a conflict",
          category: "conflict",
          passed:
            body.agentMode === CUSTOM_SKILL_IDS.compareDocuments &&
            /conflict/i.test(body.agentAnswer ?? ""),
          detail: {
            agentMode: body.agentMode,
            answer: body.agentAnswer,
          },
        }),
        buildCheck({
          id: "both_documents_cited",
          label: "Conflict cites both selected documents",
          category: "conflict",
          passed:
            citationDocIds.has("policy-a") &&
            citationDocIds.has("policy-b") &&
            customStep?.detail?.selectedDocumentCount === 2,
          detail: {
            citationDocIds: [...citationDocIds],
            customStep: customStep?.detail ?? null,
          },
        }),
      ],
    });
  },
});
