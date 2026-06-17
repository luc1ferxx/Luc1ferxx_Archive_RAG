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

export const createSkillChainCase = () => ({
  id: "skill_chain_contract_review",
  label: "Contract review skill chain",
  description:
    "A contract risk review should select the summarize_contract -> risk_review whitelist chain.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const citation = buildSource({
      docId: "contract-1",
      fileName: "services-agreement.pdf",
      pageNumber: 3,
      excerpt:
        "Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice. Late notice creates renewal risk. Security audit timing is not specified.",
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
        const isRiskReview = /risk review|risks?|gaps?|exceptions?/i.test(question);

        return {
          text: isRiskReview
            ? [
                "Risk Review",
                "- Risk: Late notice creates renewal risk. [Source 1]",
                "- Gap: Security audit timing is not specified. [Source 1]",
              ].join("\n")
            : [
                "Contract Summary",
                "- Parties: Acme and Beta signed a services agreement. [Source 1]",
                "- Key Terms: The agreement renews every 12 months unless either party gives 30 days notice. [Source 1]",
              ].join("\n"),
          citations: [citation],
          abstained: false,
          resolvedQuery: question,
          memoryApplied: false,
        };
      },
    });
    const response = await runAgentRag({
      ragService,
      webChatService: async () => ({
        text: "web should not run",
      }),
      question: "Review this contract for risks and key terms.",
      docIds: ["contract-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const chainIds = getSkillChainIds(response);
    const customSkillSteps = getTraceSteps(response, "custom_skill");
    const body = getChatResponseBody(response);

    return finishCase({
      id: "skill_chain_contract_review",
      label: "Contract review skill chain",
      description:
        "A contract risk review should select the summarize_contract -> risk_review whitelist chain.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "mode_is_skill_chain",
          label: "Agent mode is skill_chain",
          category: "skill_selection",
          passed: body.agentMode === "skill_chain",
          detail: body.agentMode,
        }),
        buildCheck({
          id: "expected_chain_order",
          label: "Selected chain order is summarize_contract -> risk_review",
          category: "skill_selection",
          passed:
            chainIds.join(">") ===
            `${CUSTOM_SKILL_IDS.summarizeContract}>${CUSTOM_SKILL_IDS.riskReview}`,
          detail: chainIds,
        }),
        buildCheck({
          id: "skill_chain_trace_step",
          label: "Trace records the skill_chain step",
          category: "skill_selection",
          passed: hasTraceStep(response, "skill_chain"),
          detail: getTraceTypes(response),
        }),
        buildCheck({
          id: "both_custom_skills_ran",
          label: "Both custom skills ran in the trajectory",
          category: "skill_selection",
          passed: customSkillSteps.length === 2,
          detail: customSkillSteps.map((step) => step.detail?.skillId),
        }),
      ],
    });
  },
});


export const createFollowUpCase = () => ({
  id: "document_follow_up_retrieval",
  label: "Document evidence follow-up",
  description:
    "Unsupported document claims should trigger gap_analysis and a focused follow-up retrieval.",
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
      chat: async ({ callIndex, question }) => {
        if (callIndex === 1) {
          return {
            text:
              "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
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
          };
        }

        return {
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
        };
      },
    });
    const response = await runAgentRag({
      ragService,
      webChatService: async () => {
        throw new Error("Web search should not run when follow-up resolves evidence.");
      },
      question: "What does remote work require?",
      docIds: ["policy-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const selfChecks = getTraceSteps(response, "self_check");
    const documentObservation = getObservedSkill(response, AGENT_SKILL_IDS.documentRag);
    const executionLoop = getExecutionLoop(response);
    const workingMemory = getAgentWorkingMemory(response);
    const unresolvedGaps = Array.isArray(workingMemory.unresolvedGaps)
      ? workingMemory.unresolvedGaps
      : [];
    const resolvedGaps = Array.isArray(workingMemory.resolvedGaps)
      ? workingMemory.resolvedGaps
      : [];

    return finishCase({
      id: "document_follow_up_retrieval",
      label: "Document evidence follow-up",
      description:
        "Unsupported document claims should trigger gap_analysis and a focused follow-up retrieval.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "self_check_failed_then_passed",
          label: "Self-check failed before follow-up and passed after follow-up",
          category: "follow_up",
          passed:
            selfChecks.length === 2 &&
            selfChecks[0].status === "failed" &&
            selfChecks[1].status === "completed",
          detail: selfChecks.map((step) => step.status),
        }),
        buildCheck({
          id: "gap_analysis_recorded",
          label: "Gap analysis recorded unsupported claim",
          category: "follow_up",
          passed:
            hasTraceStep(response, "gap_analysis") &&
            executionLoop.gaps?.[0]?.type === "unsupported_claim",
          detail: executionLoop.gaps ?? [],
        }),
        buildCheck({
          id: "follow_up_retrieval_ran",
          label: "Focused follow-up retrieval ran",
          category: "follow_up",
          passed:
            hasTraceStep(response, "follow_up_retrieval") &&
            getRunPhases(response, AGENT_SKILL_IDS.documentRag).includes("follow_up"),
          detail: getRunPhases(response, AGENT_SKILL_IDS.documentRag),
        }),
        buildCheck({
          id: "working_memory_resolved_gap",
          label: "Working memory resolved the evidence gap",
          category: "follow_up",
          passed:
            unresolvedGaps.length === 0 &&
            resolvedGaps.length > 0,
          detail: workingMemory,
        }),
        buildCheck({
          id: "document_budget_bounded",
          label: "Document RAG stayed within retry budget",
          category: "budget",
          passed:
            documentObservation?.attempts === 2 &&
            documentObservation?.budgetUsed === 2 &&
            executionLoop.followUpsRun === 1,
          detail: {
            attempts: documentObservation?.attempts,
            budgetUsed: documentObservation?.budgetUsed,
            followUpsRun: executionLoop.followUpsRun,
          },
        }),
      ],
    });
  },
});


export const createClarificationCase = () => ({
  id: "comparison_requires_clarification",
  label: "Comparison clarification gate",
  description:
    "A comparison request with only one selected document should ask for clarification instead of running tools.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const ragService = buildScopedRagService({
      sameScope,
      documents: [
        {
          docId: "contract-1",
          fileName: "contract-a.pdf",
        },
      ],
      telemetry,
      chat: async () => {
        throw new Error("Document chat should not run before clarification.");
      },
    });
    const response = await runAgentRag({
      ragService,
      webChatService: async () => {
        throw new Error("Web search should not run before clarification.");
      },
      question: "Compare this contract against the other agreement.",
      docIds: ["contract-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const body = getChatResponseBody(response);
    const clarification = getClarification(response);

    return finishCase({
      id: "comparison_requires_clarification",
      label: "Comparison clarification gate",
      description:
        "A comparison request with only one selected document should ask for clarification instead of running tools.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "agent_mode_clarification",
          label: "Agent returned clarification mode",
          category: "clarification",
          passed: body.agentMode === "clarification",
          detail: body.agentMode,
        }),
        buildCheck({
          id: "comparison_reason",
          label: "Clarification reason identifies missing comparison document",
          category: "clarification",
          passed:
            clarification?.reason ===
            "comparison_requires_multiple_documents",
          detail: clarification,
        }),
        buildCheck({
          id: "clarification_trace",
          label: "Trace records the clarification gate",
          category: "clarification",
          passed: hasTraceStep(response, "clarification_gate"),
          detail: getTraceTypes(response),
        }),
        buildCheck({
          id: "no_tool_execution_before_clarification",
          label: "No document chat ran before clarification",
          category: "clarification",
          passed: telemetry.chatCalls.length === 0,
          detail: telemetry.chatCalls,
        }),
      ],
    });
  },
});


export const createAccessScopeCase = () => ({
  id: "custom_skill_access_scope",
  label: "Custom skill access scope",
  description:
    "A custom skill must pass the authenticated accessScope to document listing and RAG chat.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const ragService = buildScopedRagService({
      sameScope,
      documents: [
        {
          docId: "security-1",
          fileName: "security-policy.pdf",
        },
      ],
      telemetry,
      chat: async ({ question }) => ({
        text: [
          "Risk Review",
          "- Risk: Security exceptions require written approval. [Source 1]",
          "- Gap: Audit cadence is not specified. [Source 1]",
        ].join("\n"),
        citations: [
          buildSource({
            docId: "security-1",
            fileName: "security-policy.pdf",
            pageNumber: 5,
            excerpt:
              "Security exceptions require written approval. Audit cadence is not specified.",
          }),
        ],
        abstained: false,
        resolvedQuery: question,
        memoryApplied: false,
      }),
    });
    const response = await runAgentRag({
      ragService,
      webChatService: async () => ({
        text: "web should not run",
      }),
      question: "Review this policy for risks and gaps.",
      docIds: ["security-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const customStep = getTraceSteps(response, "custom_skill")[0];

    return finishCase({
      id: "custom_skill_access_scope",
      label: "Custom skill access scope",
      description:
        "A custom skill must pass the authenticated accessScope to document listing and RAG chat.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "risk_review_selected",
          label: "Risk review custom skill selected",
          category: "skill_selection",
          passed: getSelectedSkillIds(response).includes(CUSTOM_SKILL_IDS.riskReview),
          detail: getSelectedSkillIds(response),
        }),
        buildCheck({
          id: "list_documents_scoped",
          label: "Document listing received the accessScope",
          category: "access_scope",
          passed:
            telemetry.listDocumentScopes.length > 0 &&
            telemetry.listDocumentScopes.every(sameScope),
          detail: telemetry.listDocumentScopes,
        }),
        buildCheck({
          id: "chat_scoped",
          label: "RAG chat received the accessScope",
          category: "access_scope",
          passed:
            telemetry.chatCalls.length > 0 &&
            telemetry.chatCalls.every((call) => sameScope(call.accessScope)),
          detail: telemetry.chatCalls.map((call) => call.accessScope),
        }),
        buildCheck({
          id: "selected_doc_count_scoped",
          label: "Trace shows scoped selected document count",
          category: "access_scope",
          passed: customStep?.detail?.selectedDocumentCount === 1,
          detail: customStep?.detail ?? null,
        }),
      ],
    });
  },
});


export const createBudgetCase = () => ({
  id: "budget_exhaustion_clarification",
  label: "Budget exhaustion clarification",
  description:
    "When follow-up budget is exhausted, the agent should stop and ask for clarification instead of looping.",
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
          "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
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
      agentBudget: {
        maxDocumentRagCalls: 1,
      },
      ragService,
      webChatService: async () => {
        throw new Error("Web search should not run for budget clarification.");
      },
      question: "What does remote work require?",
      docIds: ["policy-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const documentObservation = getObservedSkill(response, AGENT_SKILL_IDS.documentRag);
    const body = getChatResponseBody(response);
    const clarification = getClarification(response);

    return finishCase({
      id: "budget_exhaustion_clarification",
      label: "Budget exhaustion clarification",
      description:
        "When follow-up budget is exhausted, the agent should stop and ask for clarification instead of looping.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "budget_reason_clarification",
          label: "Clarification reason identifies exhausted document follow-up budget",
          category: "budget",
          passed:
            body.agentMode === "clarification" &&
            clarification?.reason ===
              "document_follow_up_budget_exhausted",
          detail: clarification,
        }),
        buildCheck({
          id: "budget_limit_trace",
          label: "Trace records budget_limit instead of unbounded retry",
          category: "budget",
          passed: hasTraceStep(response, "budget_limit"),
          detail: getTraceTypes(response),
        }),
        buildCheck({
          id: "no_follow_up_after_budget_exhaustion",
          label: "Follow-up retrieval did not run after budget exhaustion",
          category: "budget",
          passed:
            !hasTraceStep(response, "follow_up_retrieval") &&
            documentObservation?.attempts === 1 &&
            documentObservation?.budgetUsed === 1,
          detail: {
            attempts: documentObservation?.attempts,
            budgetUsed: documentObservation?.budgetUsed,
            traceTypes: getTraceTypes(response),
          },
        }),
      ],
    });
  },
});
