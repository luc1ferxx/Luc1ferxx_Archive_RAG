import { useCallback } from "react";
import { message } from "antd";
import {
  fetchAgentRun,
  requestAgentRunAction,
  requestAgentRunRecoveryAction,
  requestAgentRunStepRetry,
} from "../archiveApi";
import { getRecoveryActionSuccessMessage } from "../components/workbenchFormatters";

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

const buildAgentRunActionAnswer = (currentAnswer = {}, result = {}) => {
  const run = result?.run;
  const nextAnswer = result?.response
    ? {
        ...result.response,
      }
    : {
        ...currentAnswer,
      };

  return {
    ...nextAnswer,
    agentRunRecovery: run?.recovery ?? nextAnswer.agentRunRecovery,
    agentRunStatus: run?.status ?? nextAnswer.agentRunStatus,
    agentRunSteps: run?.steps ?? nextAnswer.agentRunSteps,
    approvalGates: run?.approvalGates ?? nextAnswer.approvalGates,
  };
};

// A failed action can still have moved the run (an approved capability ran
// and failed, a gate was decided elsewhere, a failed retry added a failed
// step): show the run as the server holds it on the turn that holds it.
// Unread, the turn stays as it was.
const showRunAsServerHolds = async (
  runId,
  updateTurnByRunId,
  adjustAnswer = (answer) => answer
) => {
  const run = await fetchAgentRun(runId).catch(() => null);

  if (run) {
    updateTurnByRunId(runId, (currentTurn) => ({
      ...currentTurn,
      answer: adjustAnswer(
        buildAgentRunActionAnswer(currentTurn.answer, { run }),
        run
      ),
    }));
  }
};

export const useAgentRunActions = ({
  conversation,
  refreshAgentRunRecovery,
  setIsLoading,
  setSelectedSource,
  updateTurnByRunId,
  t,
}) => {
  const handleAgentApprovalAction = useCallback(
    async ({ action, gate, turnIndex }) => {
      const turn = conversation[turnIndex];
      const runId = turn?.answer?.agentRunId;
      const approvalObjectHash =
        typeof gate?.approvalObjectHash === "string"
          ? gate.approvalObjectHash.trim()
          : "";
      const gateId = typeof gate?.id === "string" ? gate.id.trim() : "";

      if (!runId || !gateId || !approvalObjectHash) {
        message.error(t("app.approvalMissing"));
        return;
      }

      setIsLoading(true);

      try {
        const result = await requestAgentRunAction(runId, action, {
          approvalObjectHash,
          gateId,
        });

        // An approval that ran the Capability carries the run's answer. A
        // denial returns the run alone.
        if (action === "approve" && result?.response) {
          const nextAnswer = buildAgentRunActionAnswer(turn.answer, result);

          if (
            updateTurnByRunId(runId, {
              question: turn.question,
              answer: nextAnswer,
            })
          ) {
            setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
          }
          message.success(t("app.approvalRecorded"));
          return;
        }

        const updatedGates = result?.run?.approvalGates ?? [];
        const updatedSteps = result?.run?.steps ?? [];

        updateTurnByRunId(runId, (currentTurn) => ({
          ...currentTurn,
          answer: {
            ...currentTurn.answer,
            agentAnswer: t("app.approvalDeniedAnswer"),
            agentRunStatus: result?.run?.status ?? currentTurn.answer?.agentRunStatus,
            agentRunSteps: updatedSteps,
            approvalGates: updatedGates,
            clarification: {
              ...(currentTurn.answer?.clarification ?? {}),
              needed: false,
            },
          },
        }));
        message.info(t("app.approvalDenied"));
      } catch (error) {
        const backendMessage =
          getBackendMessage(error, t("app.approvalMissing"));
        message.error(backendMessage);

        // Unread, the turn keeps its usable gate; a run no longer waiting no
        // longer asks for the approval.
        await showRunAsServerHolds(runId, updateTurnByRunId, (answer, run) =>
          run.status === "waiting_for_user"
            ? answer
            : {
                ...answer,
                agentAnswer: t("app.approvalNotCompletedAnswer", {
                  reason: backendMessage,
                }),
                clarification: { ...(answer.clarification ?? {}), needed: false },
              }
        );
      } finally {
        // Whether the decision went through or not, the run may have joined
        // or left the recovery list.
        await refreshAgentRunRecovery();
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateTurnByRunId,
      t,
    ]
  );

  const handleAgentStepRetry = useCallback(
    async ({ step, turnIndex }) => {
      const turn = conversation[turnIndex];
      const runId = turn?.answer?.agentRunId;

      if (!runId || !step?.id) {
        message.error(t("app.retryMissing"));
        return;
      }

      setIsLoading(true);

      try {
        const result = await requestAgentRunStepRetry(runId, step.id);
        const nextAnswer = buildAgentRunActionAnswer(turn.answer, result);

        if (
          updateTurnByRunId(runId, {
            question: turn.question,
            answer: nextAnswer,
          })
        ) {
          setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
        }
        message.success(t("app.retryComplete"));
      } catch (error) {
        const backendMessage =
          getBackendMessage(error, t("app.retryFailed"));
        message.error(backendMessage);
        await showRunAsServerHolds(runId, updateTurnByRunId);
      } finally {
        // A failed retry adds a failed step, which the recovery card's Retry
        // must name next.
        await refreshAgentRunRecovery();
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateTurnByRunId,
      t,
    ]
  );

  const handleAgentRecoveryAction = useCallback(
    async ({ action, runId, stepId, turnIndex }) => {
      const resolvedRunId = runId?.trim();
      const resolvedTurnIndex = Number.isInteger(turnIndex)
        ? turnIndex
        : conversation.findIndex(
            (turn) => turn?.answer?.agentRunId === resolvedRunId
          );
      const turn =
        resolvedTurnIndex >= 0 ? conversation[resolvedTurnIndex] : null;

      if (!resolvedRunId || !action) {
        message.error(t("app.recoverMissing"));
        return;
      }

      setIsLoading(true);

      try {
        const payload = stepId
          ? {
              stepId,
            }
          : {};
        const result = await requestAgentRunRecoveryAction(
          resolvedRunId,
          action,
          payload
        );

        if (turn) {
          const nextAnswer = buildAgentRunActionAnswer(turn.answer, result);

          if (
            updateTurnByRunId(resolvedRunId, {
              question: turn.question,
              answer: nextAnswer,
            })
          ) {
            setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
          }
        }

        message.success(getRecoveryActionSuccessMessage(action, t));
      } catch (error) {
        const backendMessage =
          getBackendMessage(error, t("app.recoverFailed"));
        message.error(backendMessage);
        await showRunAsServerHolds(resolvedRunId, updateTurnByRunId);
      } finally {
        // As after a step retry: the card must name the run's new failed step.
        await refreshAgentRunRecovery();
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateTurnByRunId,
      t,
    ]
  );

  return {
    handleAgentApprovalAction,
    handleAgentRecoveryAction,
    handleAgentStepRetry,
  };
};
