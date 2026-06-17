import { consumeBudget } from "./agent-budget.js";
import { buildAgentRetrievalPlan } from "./agent-query-planner.js";
import {
  buildEvidenceClarification,
  serializeAgentError as serializeError,
} from "./agent-response-builder.js";
import {
  buildEvidenceRetryQuestion,
  buildEvidenceGaps,
  evaluateDocumentEvidence,
  selectBetterRagResult,
} from "./agent-self-check.js";
import {
  buildGapAnalysisSummary,
  buildSelfCheckSummary,
} from "./agent-trace.js";
import { buildFailedSkillResult } from "./skills/registry.js";

const noop = () => {};

const buildRagStepOutput = (result = {}) =>
  result.ok
    ? {
        abstained: Boolean(result.value?.abstained),
        citationCount: result.value?.citations?.length ?? 0,
        text: result.text ?? result.value?.text ?? "",
      }
    : null;

const buildRagStepError = (result = {}, fallbackMessage) =>
  result.ok
    ? null
    : {
        message: serializeError(result.error, fallbackMessage),
        name: result.error?.name ?? "Error",
      };

export const runDocumentRagLoop = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  budgetState,
  buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result?.skillId,
    skillVersion: result?.skillVersion,
    ...detail,
  }),
  docIds = [],
  documentRagSkill,
  executeObservedSkill,
  executionLoop,
  plan,
  question,
  ragService,
  recordExecutionGaps = () => [],
  recordSkippedSkill = noop,
  recordSkillResult = noop,
  recordWorkingMemoryClaimSupport = noop,
  recordWorkingMemoryGaps = noop,
  resolveWorkingMemoryGaps = noop,
  retrievalPlan,
  sessionId,
  userId,
} = {}) => {
  if (!documentRagSkill) {
    return {
      documentEvidenceClarification: null,
      ragResult: null,
    };
  }

  let documentEvidenceClarification = null;
  let ragResult = null;
  const primaryInput = {
    docIds,
    question,
    retrievalPlan,
    sessionId,
    userId,
  };
  const primaryBudget = consumeBudget(budgetState, documentRagSkill.budgetKey);
  const primaryRagResult = primaryBudget.ok
    ? await executeObservedSkill(
        documentRagSkill,
        {
          ...primaryInput,
          accessScope,
          ragService,
        },
        {
          phase: "primary",
          budget: primaryBudget,
        }
      )
    : buildFailedSkillResult(documentRagSkill, new Error(primaryBudget.reason));

  ragResult = primaryRagResult;
  recordSkillResult(primaryRagResult);

  if (!primaryBudget.ok) {
    recordSkippedSkill({
      skill: documentRagSkill,
      result: primaryRagResult,
      phase: "primary",
      budget: primaryBudget,
    });
    addBudgetLimitTrace({
      tool: "Document RAG",
      reason: primaryBudget.reason,
    });
  } else {
    addTraceStep({
      type: "document_rag",
      label: "Document RAG",
      status: primaryRagResult.ok ? "completed" : "failed",
      summary: primaryRagResult.ok
        ? primaryRagResult.value.abstained
          ? "Document RAG ran but reported insufficient evidence."
          : `Document RAG returned ${
              primaryRagResult.value.citations?.length ?? 0
            } citation${
              primaryRagResult.value.citations?.length === 1 ? "" : "s"
            }.`
        : `Document RAG failed: ${serializeError(
            primaryRagResult.error,
            "Unable to answer from the document."
          )}`,
      input: primaryInput,
      output: buildRagStepOutput(primaryRagResult),
      error: buildRagStepError(
        primaryRagResult,
        "Unable to answer from the document."
      ),
      detail: buildSkillTraceDetail(
        primaryRagResult,
        primaryRagResult.traceDetail ?? {}
      ),
    });
  }

  const primaryCheck = evaluateDocumentEvidence({
    ragResult: primaryRagResult,
    docIds,
  });

  if (primaryBudget.ok) {
    recordWorkingMemoryClaimSupport({
      skill: documentRagSkill,
      phase: "primary",
      check: primaryCheck,
    });

    addTraceStep({
      type: "self_check",
      label: "Self Check",
      status: primaryCheck.passed ? "completed" : "failed",
      summary: buildSelfCheckSummary(primaryCheck),
      detail: primaryCheck,
    });
  }

  if (
    primaryCheck.retryRecommended &&
    executionLoop.followUpsRun < executionLoop.maxFollowUps
  ) {
    const gaps = recordExecutionGaps({
      skill: documentRagSkill,
      check: primaryCheck,
    });

    executionLoop.stoppedReason = "follow_up_planned";

    addTraceStep({
      type: "gap_analysis",
      label: "Gap Analysis",
      status: gaps.length > 0 ? "completed" : "skipped",
      summary: buildGapAnalysisSummary(gaps),
      detail: {
        skillId: documentRagSkill.id,
        skillVersion: documentRagSkill.version,
        followUpRecommended: gaps.length > 0,
        gaps,
      },
    });

    const followUpQuestion = buildEvidenceRetryQuestion({
      question,
      check: primaryCheck,
    });
    const followUpRetrievalPlan = buildAgentRetrievalPlan({
      question: followUpQuestion,
      plan,
      docIds,
      phase: "follow_up",
      focus: {
        originalQuestion: question,
        reasons: primaryCheck.reasons,
        unsupportedClaims: primaryCheck.claimSupport?.claims
          ?.filter((claim) => !claim.supported)
          .map((claim) => claim.text) ?? [],
        gaps,
      },
    });
    const followUpBudget = consumeBudget(
      budgetState,
      documentRagSkill.budgetKey
    );

    if (!followUpBudget.ok) {
      executionLoop.stoppedReason = "budget_exhausted";
      documentEvidenceClarification = buildEvidenceClarification({
        reason: "document_follow_up_budget_exhausted",
        check: primaryCheck,
        gaps,
      });
      recordSkippedSkill({
        skill: documentRagSkill,
        result: buildFailedSkillResult(
          documentRagSkill,
          new Error(followUpBudget.reason)
        ),
        phase: "follow_up",
        budget: followUpBudget,
      });
      addBudgetLimitTrace({
        tool: "Document follow-up",
        reason: followUpBudget.reason,
      });
    } else {
      const followUpInput = {
        docIds,
        question: followUpQuestion,
        retrievalPlan: followUpRetrievalPlan,
        sessionId,
        userId,
      };
      const followUpRagResult = await executeObservedSkill(
        documentRagSkill,
        {
          ...followUpInput,
          accessScope,
          ragService,
        },
        {
          phase: "follow_up",
          budget: followUpBudget,
        }
      );
      executionLoop.followUpsRun += 1;
      executionLoop.stoppedReason = "follow_up_completed";
      recordSkillResult(followUpRagResult);

      addTraceStep({
        type: "follow_up_retrieval",
        label: "Follow-up Retrieval",
        status: followUpRagResult.ok ? "completed" : "failed",
        summary: followUpRagResult.ok
          ? `Focused follow-up returned ${
              followUpRagResult.value.citations?.length ?? 0
            } citation${
              followUpRagResult.value.citations?.length === 1 ? "" : "s"
            }.`
          : `Focused follow-up failed: ${serializeError(
              followUpRagResult.error,
              "Unable to run follow-up document evidence lookup."
            )}`,
        input: followUpInput,
        output: buildRagStepOutput(followUpRagResult),
        error: buildRagStepError(
          followUpRagResult,
          "Unable to run follow-up document evidence lookup."
        ),
        detail: buildSkillTraceDetail(followUpRagResult, {
          followUpQuestion,
          retrievalPlan: followUpRetrievalPlan,
          gaps,
        }),
      });

      if (followUpRagResult.ok) {
        const followUpCheck = evaluateDocumentEvidence({
          ragResult: followUpRagResult,
          docIds,
        });
        recordWorkingMemoryClaimSupport({
          skill: documentRagSkill,
          phase: "follow_up",
          check: followUpCheck,
        });

        addTraceStep({
          type: "self_check",
          label: "Follow-up Self Check",
          status: followUpCheck.passed ? "completed" : "failed",
          summary: buildSelfCheckSummary(followUpCheck),
          detail: followUpCheck,
        });

        executionLoop.stoppedReason = followUpCheck.passed
          ? "follow_up_resolved"
          : "follow_up_unresolved";

        if (followUpCheck.passed) {
          resolveWorkingMemoryGaps({
            skill: documentRagSkill,
            phase: "follow_up",
          });
        }

        if (!followUpCheck.passed) {
          const followUpGaps = (followUpCheck.gaps?.length
            ? followUpCheck.gaps
            : buildEvidenceGaps(followUpCheck)).map((gap) => ({
              ...gap,
              skillId: documentRagSkill.id,
              skillVersion: documentRagSkill.version,
            }));

          recordWorkingMemoryGaps({
            gaps: followUpGaps,
            phase: "follow_up",
          });
          documentEvidenceClarification = buildEvidenceClarification({
            reason: "document_evidence_unresolved_after_follow_up",
            check: followUpCheck,
            gaps: followUpGaps,
          });
        }
      }

      ragResult = selectBetterRagResult({
        primary: primaryRagResult,
        retry: followUpRagResult,
      });
    }
  } else if (primaryCheck.retryRecommended) {
    executionLoop.stoppedReason = "follow_up_limit_reached";
    documentEvidenceClarification = buildEvidenceClarification({
      reason: "document_follow_up_limit_reached",
      check: primaryCheck,
      gaps: primaryCheck.gaps?.length
        ? primaryCheck.gaps
        : buildEvidenceGaps(primaryCheck),
    });
  }

  return {
    documentEvidenceClarification,
    ragResult,
  };
};
