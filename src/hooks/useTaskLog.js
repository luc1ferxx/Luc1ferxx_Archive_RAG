import { useCallback, useState } from "react";
import { message } from "antd";
import { fetchTasks } from "../archiveApi";

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

export const TASK_TYPES = {
  externalRecommendation: "external_recommendation",
};

export const useTaskLog = () => {
  const [tasks, setTasks] = useState([]);
  const [isTaskLogLoading, setIsTaskLogLoading] = useState(false);

  const clearTasks = useCallback(() => {
    setTasks([]);
  }, []);

  const loadTasks = useCallback(async ({ silent = false, type } = {}) => {
    setIsTaskLogLoading(true);

    try {
      const result = await fetchTasks(type);
      const nextTasks = Array.isArray(result?.tasks) ? result.tasks : [];

      setTasks(nextTasks);
      return nextTasks;
    } catch (error) {
      if (!silent) {
        message.warning(getBackendMessage(error, "Unable to load task log."));
      }

      return [];
    } finally {
      setIsTaskLogLoading(false);
    }
  }, []);

  return {
    clearTasks,
    isTaskLogLoading,
    loadTasks,
    tasks,
  };
};
