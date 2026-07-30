import { useCallback } from "react";
import { message } from "antd";
import {
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

export const useAgentRunActions = ({
  conversation,
  refreshAgentRunRecovery,
  setIsLoading,
  setSelectedSource,
  updateConversationTurn,
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

        if (action === "approve" && result?.response) {
          const nextAnswer = buildAgentRunActionAnswer(turn.answer, result);

          updateConversationTurn(turnIndex, {
            question: turn.question,
            answer: nextAnswer,
          });
          setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
          await refreshAgentRunRecovery();
          message.success(t("app.approvalRecorded"));
          return;
        }

        const updatedGates = result?.run?.approvalGates ?? [];
        const updatedSteps = result?.run?.steps ?? [];

        updateConversationTurn(turnIndex, (currentTurn) => ({
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
        await refreshAgentRunRecovery();
        message.info(t("app.approvalDenied"));
      } catch (error) {
        const backendMessage =
          getBackendMessage(error, t("app.approvalMissing"));
        message.error(backendMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateConversationTurn,
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

        updateConversationTurn(turnIndex, {
          question: turn.question,
          answer: nextAnswer,
        });
        setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
        await refreshAgentRunRecovery();
        message.success(t("app.retryComplete"));
      } catch (error) {
        const backendMessage =
          getBackendMessage(error, t("app.retryFailed"));
        message.error(backendMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateConversationTurn,
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

          updateConversationTurn(resolvedTurnIndex, {
            question: turn.question,
            answer: nextAnswer,
          });
          setSelectedSource(nextAnswer?.ragSources?.[0] ?? null);
        }

        await refreshAgentRunRecovery();
        message.success(getRecoveryActionSuccessMessage(action));
      } catch (error) {
        const backendMessage =
          getBackendMessage(error, t("app.recoverFailed"));
        message.error(backendMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [
      conversation,
      refreshAgentRunRecovery,
      setIsLoading,
      setSelectedSource,
      updateConversationTurn,
      t,
    ]
  );

  return {
    handleAgentApprovalAction,
    handleAgentRecoveryAction,
    handleAgentStepRetry,
  };
};
