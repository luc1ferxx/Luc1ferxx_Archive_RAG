import { useCallback, useEffect, useMemo, useState } from "react";
import { requestSessionClear } from "../archiveApi";
import {
  createSessionId,
  persistSessionId,
  persistUserId,
  readStoredSessionId,
  readStoredUserId,
} from "../archiveSession";

export const useChatSession = () => {
  const [conversation, setConversation] = useState([]);
  const [activeTurnIndex, setActiveTurnIndex] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState(() => readStoredSessionId());
  const [userId] = useState(() => readStoredUserId());

  useEffect(() => {
    persistSessionId(sessionId);
  }, [sessionId]);

  useEffect(() => {
    persistUserId(userId);
  }, [userId]);

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

  const updateConversationTurn = useCallback((turnIndex, updater) => {
    setConversation((prev) =>
      prev.map((turn, index) => {
        if (index !== turnIndex) {
          return turn;
        }

        return typeof updater === "function" ? updater(turn) : updater;
      })
    );
    setActiveTurnIndex(turnIndex);
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
    updateConversationTurn,
    userId,
  };
};
