import { useCallback, useState } from "react";
import { message } from "antd";
import { fetchAgentRunRecoveryRuns } from "../archiveApi";

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

const deepEqual = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
};

export const useAgentRunRecovery = () => {
  const [isRecoveryLoading, setIsRecoveryLoading] = useState(false);
  const [runs, setRuns] = useState([]);

  const clearRecoveryRuns = useCallback(() => {
    setRuns([]);
  }, []);

  const loadRecoveryRuns = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setIsRecoveryLoading(true);
    }

    try {
      const result = await fetchAgentRunRecoveryRuns();
      const nextRuns = Array.isArray(result?.runs) ? result.runs : [];

      setRuns((prev) => deepEqual(prev, nextRuns) ? prev : nextRuns);
      return nextRuns;
    } catch (error) {
      if (!silent) {
        message.warning(
          getBackendMessage(error, "Unable to load agent run recovery queue.")
        );
      }

      return [];
    } finally {
      if (!silent) {
        setIsRecoveryLoading(false);
      }
    }
  }, []);

  return {
    clearRecoveryRuns,
    isRecoveryLoading,
    loadRecoveryRuns,
    runs,
  };
};
