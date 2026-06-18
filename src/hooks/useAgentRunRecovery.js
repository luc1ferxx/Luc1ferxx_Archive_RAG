import { useCallback, useState } from "react";
import { message } from "antd";
import { fetchAgentRunRecoveryRuns } from "../archiveApi";

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

export const useAgentRunRecovery = () => {
  const [isRecoveryLoading, setIsRecoveryLoading] = useState(false);
  const [runs, setRuns] = useState([]);

  const clearRecoveryRuns = useCallback(() => {
    setRuns([]);
  }, []);

  const loadRecoveryRuns = useCallback(async ({ silent = false } = {}) => {
    setIsRecoveryLoading(true);

    try {
      const result = await fetchAgentRunRecoveryRuns();
      const nextRuns = Array.isArray(result?.runs) ? result.runs : [];

      setRuns(nextRuns);
      return nextRuns;
    } catch (error) {
      if (!silent) {
        message.warning(
          getBackendMessage(error, "Unable to load agent run recovery queue.")
        );
      }

      return [];
    } finally {
      setIsRecoveryLoading(false);
    }
  }, []);

  return {
    clearRecoveryRuns,
    isRecoveryLoading,
    loadRecoveryRuns,
    runs,
  };
};
