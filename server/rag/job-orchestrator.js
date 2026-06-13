import { createTaskService, TASK_STATUSES } from "./tasks.js";

export const TASK_ACTIONS = Object.freeze({
  cancel: "cancel",
  confirm: "confirm",
});

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const buildJobError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const defaultSchedule = (work) => {
  setTimeout(work, 0);
};

export const createJobOrchestrator = ({
  runners = {},
  schedule = defaultSchedule,
  taskService = createTaskService(),
} = {}) => {
  const getRunner = (task) => {
    const runnerId = normalizeText(task?.runnerId);
    const runner = runners[runnerId];

    if (!runnerId || !runner) {
      throw buildJobError("No runner is registered for this task.", 409);
    }

    return runner;
  };

  const patchTask = async ({ accessScope = {}, taskId, patch }) => {
    const task = await taskService.patchTask({
      accessScope,
      taskId,
      patch,
    });

    if (!task) {
      throw buildJobError("Task not found.", 404);
    }

    return task;
  };

  const runTask = async ({ accessScope = {}, taskId } = {}) => {
    const task = taskService.getInternalTask
      ? await taskService.getInternalTask({
          accessScope,
          taskId,
        })
      : await taskService.getTask({
          accessScope,
          taskId,
        });

    if (!task) {
      throw buildJobError("Task not found.", 404);
    }

    if ([TASK_STATUSES.canceled, TASK_STATUSES.completed].includes(task.status)) {
      return taskService.getTask({
        accessScope,
        taskId,
      });
    }

    const runner = getRunner(task);

    await patchTask({
      accessScope,
      taskId,
      patch: {
        status: TASK_STATUSES.running,
      },
    });

    try {
      const resultPatch =
        (await runner.run?.({
          accessScope,
          patchTask: (patch) =>
            patchTask({
              accessScope,
              taskId,
              patch,
            }),
          task,
          taskService,
        })) ?? {};

      return patchTask({
        accessScope,
        taskId,
        patch: {
          status: TASK_STATUSES.completed,
          ...resultPatch,
        },
      });
    } catch (error) {
      return patchTask({
        accessScope,
        taskId,
        patch: {
          error: error instanceof Error ? error.message : String(error),
          status: TASK_STATUSES.failed,
        },
      });
    }
  };

  const scheduleTaskRun = ({ accessScope = {}, taskId } = {}) => {
    schedule(() => {
      return runTask({
        accessScope,
        taskId,
      }).catch((error) => {
        console.error("Task runner failed before task state could be updated.", error);
      });
    });
  };

  const recoverRunnableTasks = async ({
    statuses = [TASK_STATUSES.queued, TASK_STATUSES.running],
  } = {}) => {
    const recoverableTasks = taskService.listRecoverableTasks
      ? await taskService.listRecoverableTasks({
          statuses,
        })
      : { tasks: [] };
    const tasks = Array.isArray(recoverableTasks.tasks)
      ? recoverableTasks.tasks
      : [];

    for (const task of tasks) {
      scheduleTaskRun({
        accessScope: task.accessScope,
        taskId: task.id,
      });
    }

    return {
      scheduledCount: tasks.length,
    };
  };

  const resumeTask = async ({
    accessScope = {},
    action,
    payload = {},
    runImmediately = true,
    taskId,
  } = {}) => {
    const task = taskService.getInternalTask
      ? await taskService.getInternalTask({
          accessScope,
          taskId,
        })
      : await taskService.getTask({
          accessScope,
          taskId,
        });

    if (!task) {
      throw buildJobError("Task not found.", 404);
    }

    const normalizedAction = normalizeText(action);

    if (normalizedAction === TASK_ACTIONS.cancel) {
      return patchTask({
        accessScope,
        taskId,
        patch: {
          requiredUserAction: "",
          status: TASK_STATUSES.canceled,
        },
      });
    }

    const runner = getRunner(task);
    const nextPatch =
      (await runner.resume?.({
        accessScope,
        action: normalizedAction,
        payload,
        task,
        taskService,
      })) ?? {};
    const nextTask = await patchTask({
      accessScope,
      taskId,
      patch: {
        requiredUserAction: "",
        status: TASK_STATUSES.queued,
        ...nextPatch,
      },
    });

    if (runImmediately) {
      scheduleTaskRun({
        accessScope,
        taskId,
      });
    }

    return nextTask;
  };

  return {
    recoverRunnableTasks,
    resumeTask,
    runTask,
    scheduleTaskRun,
  };
};
