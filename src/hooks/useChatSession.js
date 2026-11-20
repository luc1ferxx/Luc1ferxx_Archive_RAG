import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestSessionClear } from "../archiveApi";
import {
  createSessionId,
  persistSessionId,
  readStoredSessionId,
} from "../archiveSession";

export const useChatSession = () => {
  const [conversation, setConversation] = useState([]);
  const conversationRef = useRef(conversation);
  const [activeTurnIndex, setActiveTurnIndex] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState(() => readStoredSessionId());

  conversationRef.current = conversation;

  useEffect(() => {
    persistSessionId(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (conversation.length === 0) {
      setActiveTurnIndex(null);
      return;
    }

    if (activeTurnIndex === null || activeTurnIndex >= conversation.length) {
      setActiveTurnIndex(conversation.length - 1);
    }
  }, [activeTurnIndex, conversation]);

  const resetConversation = useCallback(() => {
    setConversation([]);
    setActiveTurnIndex(null);
  }, []);

  const rotateSession = useCallback(async () => {
    const previousSessionId = sessionId;
    const nextSessionId = createSessionId();

    try {
      await requestSessionClear(previousSessionId);
    } catch (error) {
      console.error("Failed to clear persisted session memory:", error);
    }

    setSessionId(nextSessionId);
    persistSessionId(nextSessionId);
  }, [sessionId]);

  const addConversationTurn = useCallback(
    (question, answer) => {
      setConversation((prev) => [...prev, { question, answer }]);
      setActiveTurnIndex(conversation.length);
    },
    [conversation.length]
  );

  // A run's result lands after an await, when New chat, a removed document or
  // a cleared workspace may have emptied the conversation and a new question
  // taken the run's old position: the turn is found by run id, and false
  // means it is gone.
  const updateTurnByRunId = useCallback((runId, updater) => {
    const turnIndex = conversationRef.current.findIndex(
      (turn) => turn.answer?.agentRunId === runId
    );

    if (turnIndex < 0) {
      return false;
    }

    setConversation((prev) =>
      prev.map((turn) => {
        if (turn.answer?.agentRunId !== runId) {
          return turn;
        }

        return typeof updater === "function" ? updater(turn) : updater;
      })
    );
    setActiveTurnIndex(turnIndex);
    return true;
  }, []);

  const currentTurn = useMemo(
    () =>
      activeTurnIndex !== null && conversation[activeTurnIndex]
        ? conversation[activeTurnIndex]
        : conversation[conversation.length - 1] ?? null,
    [activeTurnIndex, conversation]
  );

  return {
    activeTurnIndex,
    addConversationTurn,
    conversation,
    currentTurn,
    isLoading,
    resetConversation,
    rotateSession,
    sessionId,
    setActiveTurnIndex,
    setIsLoading,
    updateTurnByRunId,
  };
};
