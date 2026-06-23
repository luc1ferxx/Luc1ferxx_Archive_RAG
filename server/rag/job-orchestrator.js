import { createTaskService, TASK_STATUSES } from "./tasks.js";
import { recordRagTrace } from "./observability.js";

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
  recordTaskRecoveryTrace = recordRagTrace,
  runners = {},
  schedule = defaultSchedule,
  taskService = createTaskService(),
} = {}) => {
  const recordTaskTrace = async (event = {}) =>
    recordTaskRecoveryTrace?.({
      traceType: "agent_task_recovery",
      ...event,
    });

  const buildTaskRef = (task = {}) => ({
    runnerId: normalizeText(task.runnerId),
    status: normalizeText(task.status),
    taskId: normalizeText(task.id),
  });

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

  const runTask = async ({ accessScope = {}, recovery = false, taskId } = {}) => {
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
      if (recovery) {
        await recordTaskTrace({
          eventType: "task_recovery_run",
          errorStatus: 404,
          resultStatus: "",
          runnerId: "",
          status: "failed",
          taskId,
        });
      }

      throw buildJobError("Task not found.", 404);
    }

    if ([TASK_STATUSES.canceled, TASK_STATUSES.completed].includes(task.status)) {
      return taskService.getTask({
        accessScope,
        taskId,
      });
    }

    let runner = null;

    try {
      runner = getRunner(task);
    } catch (error) {
      if (recovery) {
        await recordTaskTrace({
          eventType: "task_recovery_run",
          errorStatus: error?.status ?? 500,
          resultStatus: task.status,
          runnerId: normalizeText(task.runnerId),
          status: "failed",
          taskId,
        });
      }

      throw error;
    }

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

      const completedTask = await patchTask({
        accessScope,
        taskId,
        patch: {
          status: TASK_STATUSES.completed,
          ...resultPatch,
        },
      });

      if (recovery) {
        await recordTaskTrace({
          eventType: "task_recovery_run",
          resultStatus: completedTask.status,
          runnerId: normalizeText(task.runnerId),
          status: "completed",
          taskId,
        });
      }

      return completedTask;
    } catch (error) {
      const failedTask = await patchTask({
        accessScope,
        taskId,
        patch: {
          error: error instanceof Error ? error.message : String(error),
          status: TASK_STATUSES.failed,
        },
      });

      if (recovery) {
        await recordTaskTrace({
          eventType: "task_recovery_run",
          errorStatus: error?.status ?? 500,
          resultStatus: failedTask.status,
          runnerId: normalizeText(task.runnerId),
          status: "failed",
          taskId,
        });
      }

      return failedTask;
    }
  };

  const scheduleTaskRun = ({ accessScope = {}, recovery = false, taskId } = {}) => {
    schedule(() => {
      return runTask({
        accessScope,
        recovery,
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
        recovery: true,
        taskId: task.id,
      });
    }

    await recordTaskTrace({
      eventType: "task_recovery_scheduled",
      scheduledCount: tasks.length,
      taskRefs: tasks.map(buildTaskRef),
    });

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
    const normalizedAction = normalizeText(action);
    let task = null;
    let runnerId = "";
    const recordResumeTrace = async ({ error, resultTask } = {}) => {
      await recordTaskTrace({
        action: normalizedAction,
        eventType: "task_resume_action",
        resultStatus: resultTask?.status ?? task?.status ?? "",
        runnerId,
        status: error ? "failed" : "completed",
        taskId,
        ...(error
          ? {
              errorStatus: error?.status ?? 500,
            }
          : {}),
      });
    };

    try {
      task = taskService.getInternalTask
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

      runnerId = normalizeText(task.runnerId);

      if (normalizedAction === TASK_ACTIONS.cancel) {
        const canceledTask = await patchTask({
          accessScope,
          taskId,
          patch: {
            requiredUserAction: "",
            status: TASK_STATUSES.canceled,
          },
        });

        await recordResumeTrace({
          resultTask: canceledTask,
        });

        return canceledTask;
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

      await recordResumeTrace({
        resultTask: nextTask,
      });

      return nextTask;
    } catch (error) {
      await recordResumeTrace({
        error,
      });
      throw error;
    }
  };

  return {
    recoverRunnableTasks,
    resumeTask,
    runTask,
    scheduleTaskRun,
  };
};
