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

export const createApprovalResumeCase = () => ({
  id: "capability_approval_resume",
  label: "Capability approval resume",
  description:
    "A risky external capability should pause before execution and resume on the same agent run after approval.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const question = "Search the web for the current launch date";
    let webSearchCalls = 0;
    const capabilityRegistry = createCapabilityRegistry([
      createWebSearchCapability({
        webChatService: async (searchQuestion) => {
          webSearchCalls += 1;

          return {
            text: `Approved web answer for: ${searchQuestion}`,
          };
        },
      }),
    ]);
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const agentRunStepExecutor = createAgentRunStepExecutor({
      agentRunService,
      capabilityRegistry,
    });
    const ragService = buildScopedRagService({
      sameScope,
      documents: [],
      telemetry,
      chat: async () => {
        throw new Error("Document chat should not run for direct web prompts.");
      },
    });
    const pendingResponse = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      agentRunService,
      capabilityRegistry,
      docIds: [],
      question,
      ragService,
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => {
        throw new Error("Fallback web service should not run when registry is used.");
      },
    });
    const pendingBody = getChatResponseBody(pendingResponse);
    const gate = pendingBody.approvalGates?.[0] ?? null;
    const pendingRun = await agentRunService.getRun({
      accessScope: DEFAULT_ACCESS_SCOPE,
      runId: pendingBody.agentRunId,
    });
    const webSearchCallsBeforeResume = webSearchCalls;
    const resumeResult = await agentRunStepExecutor.applyApprovalAction({
      accessScope: DEFAULT_ACCESS_SCOPE,
      action: "approve",
      gateId: gate?.id,
      runId: pendingBody.agentRunId,
    });
    const resumedResponse = {
      status: 200,
      body: resumeResult.response,
    };
    const resumedBody = getChatResponseBody(resumedResponse);
    const eventTypes = resumeResult.run?.events?.map((event) => event.type) ?? [];
    const capabilityStep = (resumeResult.run?.steps ?? []).find(
      (step) =>
        step.kind === "capability_call" &&
        step.capabilityId === CAPABILITY_IDS.webSearch
    );

    return finishCase({
      id: "capability_approval_resume",
      label: "Capability approval resume",
      description:
        "A risky external capability should pause before execution and resume on the same agent run after approval.",
      response: resumedResponse,
      telemetry,
      checks: [
        buildCheck({
          id: "web_skill_selected_before_gate",
          label: "Web search skill was selected before the approval gate",
          category: "skill_selection",
          passed: getSelectedSkillIds(pendingResponse).includes(
            AGENT_SKILL_IDS.webSearch
          ),
          detail: getSelectedSkillIds(pendingResponse),
        }),
        buildCheck({
          id: "approval_gate_pauses_execution",
          label: "Approval gate pauses external execution",
          category: "approval",
          passed:
            pendingBody.agentMode === "clarification" &&
            pendingBody.clarification?.reason ===
              "capability_approval_required" &&
            pendingRun?.status === AGENT_RUN_STATUSES.waitingForUser &&
            webSearchCallsBeforeResume === 0,
          detail: {
            agentMode: pendingBody.agentMode,
            clarificationReason: pendingBody.clarification?.reason,
            runStatus: pendingRun?.status,
            webSearchCallsBeforeResume,
          },
        }),
        buildCheck({
          id: "approval_preview_is_sanitized",
          label: "Approval gate exposes only the sanitized input preview",
          category: "approval",
          passed:
            gate?.capabilityId === CAPABILITY_IDS.webSearch &&
            gate?.inputPreview?.question === question &&
            Object.keys(gate?.inputPreview ?? {}).length === 1,
          detail: gate,
        }),
        buildCheck({
          id: "approval_resumes_same_run",
          label: "Approval resumes the same agent run and completes",
          category: "approval",
          passed:
            webSearchCalls === 1 &&
            resumedBody.agentRunId === pendingBody.agentRunId &&
            resumedBody.agentMode === "web" &&
            resumedBody.agentRunStatus === AGENT_RUN_STATUSES.completed &&
            resumeResult.run?.status === AGENT_RUN_STATUSES.completed,
          detail: {
            agentRunId: resumedBody.agentRunId,
            pendingAgentRunId: pendingBody.agentRunId,
            agentMode: resumedBody.agentMode,
            responseStatus: resumedBody.agentRunStatus,
            runStatus: resumeResult.run?.status,
            webSearchCalls,
          },
        }),
        buildCheck({
          id: "capability_step_completed_after_approval",
          label: "Capability call step completed after approval",
          category: "approval",
          passed:
            capabilityStep?.status === "completed" &&
            capabilityStep?.approvalGateId === gate?.id,
          detail: capabilityStep ?? null,
        }),
        buildCheck({
          id: "approval_resume_events_recorded",
          label: "Run events record gate creation, approval, step execution, and completion",
          category: "approval",
          passed:
            eventTypes.join(">") ===
            [
              "run_created",
              "run_prepared",
              "execution_planned",
              "approval_gate_created",
              "run_completed",
              "approval_gate_approved",
              "step_started",
              "step_completed",
              "run_completed",
            ].join(">"),
          detail: eventTypes,
        }),
      ],
    });
  },
});


export const createCustomSkillRetryCase = () => ({
  id: "custom_skill_retry",
  label: "Custom skill retry",
  description:
    "A failed custom skill step should persist input/output/error and retry from the failed step.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const citation = buildSource({
      docId: "risk-1",
      fileName: "risk-policy.pdf",
      pageNumber: 4,
      excerpt:
        "Security exceptions require written approval before production deployment.",
    });
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const ragService = buildScopedRagService({
      sameScope,
      documents: [
        {
          docId: "risk-1",
          fileName: "risk-policy.pdf",
        },
      ],
      telemetry,
      chat: async ({ callIndex, question }) => {
        if (callIndex === 1) {
          throw new Error("Transient custom skill failure.");
        }

        return {
          text:
            "Risk Review\n- Risk: Security exceptions require written approval before production deployment. [Source 1]",
          citations: [citation],
          abstained: false,
          resolvedQuery: question,
          memoryApplied: false,
        };
      },
    });
    const agentRunStepExecutor = createAgentRunStepExecutor({
      agentRunService,
      executeCustomSkillStep: createCustomSkillStepExecutor({
        ragService,
      }),
    });
    const initialResponse = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      agentRunService,
      docIds: ["risk-1"],
      question: "Review this policy for risks and gaps.",
      ragService,
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({
        text: "web should not run",
      }),
    });
    const initialBody = getChatResponseBody(initialResponse);
    const initialRun = await agentRunService.getRun({
      accessScope: DEFAULT_ACCESS_SCOPE,
      runId: initialBody.agentRunId,
    });
    const failedStep = (initialRun?.steps ?? []).find(
      (step) => step.type === "custom_skill" && step.status === "failed"
    );
    let retryResult = null;
    let retryError = null;

    if (failedStep?.id) {
      try {
        retryResult = await agentRunStepExecutor.retryStep({
          accessScope: DEFAULT_ACCESS_SCOPE,
          runId: initialBody.agentRunId,
          stepId: failedStep.id,
        });
      } catch (error) {
        retryError = error instanceof Error ? error.message : String(error);
      }
    }

    const retryStep = (retryResult?.run?.steps ?? []).find(
      (step) => step.retryOfStepId === failedStep?.id
    );
    const retryResponse = retryResult
      ? {
          status: 200,
          body: retryResult.response,
        }
      : initialResponse;

    return finishCase({
      id: "custom_skill_retry",
      label: "Custom skill retry",
      description:
        "A failed custom skill step should persist input/output/error and retry from the failed step.",
      response: retryResponse,
      telemetry,
      checks: [
        buildCheck({
          id: "failed_custom_step_persisted_input",
          label: "Failed custom skill step persisted retry input and error",
          category: "retry",
          passed:
            failedStep?.input?.skillId === CUSTOM_SKILL_IDS.riskReview &&
            Boolean(failedStep?.input?.question) &&
            /Transient custom skill failure/.test(
              failedStep?.error?.message ?? ""
            ),
          detail: failedStep ?? null,
        }),
        buildCheck({
          id: "retry_completed_same_run",
          label: "Retry completed on the same agent run",
          category: "retry",
          passed:
            !retryError &&
            retryResult?.run?.status === AGENT_RUN_STATUSES.completed &&
            retryResult?.response?.agentRunId === initialBody.agentRunId,
          detail: {
            retryError,
            retryRunId: retryResult?.response?.agentRunId ?? null,
            initialRunId: initialBody.agentRunId,
            runStatus: retryResult?.run?.status ?? null,
          },
        }),
        buildCheck({
          id: "retry_step_completed",
          label: "Retried step completed with output detail",
          category: "retry",
          passed:
            retryStep?.status === "completed" &&
            retryStep?.output?.citationCount === 1 &&
            retryStep?.attempt === 2,
          detail: retryStep ?? null,
        }),
        buildCheck({
          id: "custom_skill_was_retried_once",
          label: "Custom skill execution retried exactly once",
          category: "retry",
          passed: telemetry.chatCalls.length === 2,
          detail: telemetry.chatCalls.map((call) => call.question),
        }),
      ],
    });
  },
});


export const createWebApprovalDenyCase = () => ({
  id: "web_approval_deny",
  label: "Web approval deny",
  description:
    "Denying a web capability approval should complete the run without executing the external call.",
  run: async () => {
    const telemetry = createEvalTelemetry();
    const question = "Search the web for the current launch date";
    let webSearchCalls = 0;
    const capabilityRegistry = createCapabilityRegistry([
      createWebSearchCapability({
        webChatService: async () => {
          webSearchCalls += 1;

          return {
            text: "This should not execute after denial.",
          };
        },
      }),
    ]);
    const agentRunService = createAgentRunService({
      agentRunStore: createInMemoryAgentRunStore(),
    });
    const agentRunStepExecutor = createAgentRunStepExecutor({
      agentRunService,
      capabilityRegistry,
    });
    const ragService = buildScopedRagService({
      sameScope,
      documents: [],
      telemetry,
      chat: async () => {
        throw new Error("Document chat should not run for direct web prompts.");
      },
    });
    const pendingResponse = await runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      agentRunService,
      capabilityRegistry,
      docIds: [],
      question,
      ragService,
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => {
        throw new Error("Fallback web service should not run when registry is used.");
      },
    });
    const pendingBody = getChatResponseBody(pendingResponse);
    const gate = pendingBody.approvalGates?.[0] ?? null;
    const pendingRun = await agentRunService.getRun({
      accessScope: DEFAULT_ACCESS_SCOPE,
      runId: pendingBody.agentRunId,
    });
    const webSearchCallsBeforeDeny = webSearchCalls;
    const denyResult = await agentRunStepExecutor.applyApprovalAction({
      accessScope: DEFAULT_ACCESS_SCOPE,
      action: "deny",
      gateId: gate?.id,
      payload: {
        reason: "Trajectory test denial.",
      },
      runId: pendingBody.agentRunId,
    });
    const deniedRun = denyResult.run;
    const eventTypes = deniedRun?.events?.map((event) => event.type) ?? [];
    const skippedStep = (deniedRun?.steps ?? []).find(
      (step) =>
        step.kind === "capability_call" &&
        step.capabilityId === CAPABILITY_IDS.webSearch
    );

    return finishCase({
      id: "web_approval_deny",
      label: "Web approval deny",
      description:
        "Denying a web capability approval should complete the run without executing the external call.",
      response: pendingResponse,
      telemetry,
      checks: [
        buildCheck({
          id: "web_gate_created_without_call",
          label: "Web approval gate was created before any external call",
          category: "approval",
          passed:
            pendingBody.clarification?.reason ===
              "capability_approval_required" &&
            pendingRun?.status === AGENT_RUN_STATUSES.waitingForUser &&
            webSearchCallsBeforeDeny === 0,
          detail: {
            clarification: pendingBody.clarification,
            runStatus: pendingRun?.status ?? null,
            webSearchCallsBeforeDeny,
          },
        }),
        buildCheck({
          id: "deny_skips_capability",
          label: "Deny skipped the capability call",
          category: "approval",
          passed:
            webSearchCalls === 0 &&
            deniedRun?.status === AGENT_RUN_STATUSES.completed &&
            deniedRun?.result?.approvalDenied === true &&
            skippedStep?.status === "skipped",
          detail: {
            runStatus: deniedRun?.status ?? null,
            result: deniedRun?.result ?? null,
            skippedStep: skippedStep ?? null,
            webSearchCalls,
          },
        }),
        buildCheck({
          id: "deny_event_recorded",
          label: "Run events record approval denial without step execution",
          category: "approval",
          passed:
            eventTypes.includes("approval_gate_denied") &&
            !eventTypes.includes("step_started") &&
            !eventTypes.includes("step_completed"),
          detail: eventTypes,
        }),
      ],
    });
  },
});
