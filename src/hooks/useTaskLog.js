import { useCallback, useState } from "react";
import { message } from "antd";
import { fetchTasks } from "../archiveApi";

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

export const TASK_TYPES = {
  externalRecommendation: "external_recommendation",
};

export const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);

export const hasActiveTasks = (tasks = []) =>
  tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status));

export const useTaskLog = () => {
  const [tasks, setTasks] = useState([]);
  const [isTaskLogLoading, setIsTaskLogLoading] = useState(false);

  const clearTasks = useCallback(() => {
    setTasks([]);
  }, []);

  const loadTasks = useCallback(async ({ silent = false, type } = {}) => {
    if (!silent) {
      setIsTaskLogLoading(true);
    }

    try {
      const result = await fetchTasks(type);
      const nextTasks = Array.isArray(result?.tasks) ? result.tasks : [];

      setTasks((prev) => deepEqual(prev, nextTasks) ? prev : nextTasks);
      return nextTasks;
    } catch (error) {
      if (!silent) {
        message.warning(getBackendMessage(error, "Unable to load task log."));
      }

      return [];
    } finally {
      if (!silent) {
        setIsTaskLogLoading(false);
      }
    }
  }, []);

  return {
    clearTasks,
    isTaskLogLoading,
    loadTasks,
    tasks,
  };
};
