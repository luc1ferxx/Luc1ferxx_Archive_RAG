import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  buildTaskScopeKey,
  createTaskService,
  DEFAULT_TASK_CLAIM_LEASE_MS,
  TASK_MUTATION_OUTCOMES,
  TASK_STATUSES,
} from "./tasks.js";
import { getTenantMaxQueuedTasks, getTenantMaxRunningTasks } from "./config.js";
import { recordRagTrace } from "./observability.js";
import { runAsDatabaseSystem, runWithDatabaseTenant } from "./postgres-tenant.js";
import { runOutsideRequestDeadline } from "./request-deadline.js";
import { normalizeText } from "../lib/normalize-text.js";

export const TASK_ACTIONS = Object.freeze({
  cancel: "cancel",
  confirm: "confirm",
});

const buildJobError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const defaultSchedule = (work, delayMs = 0) => {
  setTimeout(work, delayMs);
};

const TASK_CLAIM_LOST = "TASK_CLAIM_LOST";

const buildTaskClaimLostError = () => {
  const error = buildJobError("Task execution claim is no longer active.", 409);

  error.code = TASK_CLAIM_LOST;

  return error;
};

const isTaskClaimLostError = (error) => error?.code === TASK_CLAIM_LOST;

// Per-tenant task caps (TENANT_MAX_RUNNING_TASKS, TENANT_MAX_QUEUED_TASKS; 0,
// the default, is off). A tenant is the task's exact (user, workspace) pair,
// the unit the task store and its row policy use.
//   running  checked here right before a claim: a queued (or stale running)
//            task whose tenant already holds that many live claims is not
//            claimed and stays as it is; it is tried again when one of the
//            tenant's tasks finishes in this process, and every
//            DEFAULT_RUNNING_CAP_RETRY_MS (other processes' tasks finish
//            too). Check and claim are serialized per tenant in this process;
//            claims racing in several processes may overshoot by the number
//            racing.
//   queued   checked when a task is created (rag/agent-tasks.js): over it
//            POST /agent-tasks answers 429 TENANT_TASK_LIMITED.
export const TENANT_TASK_LIMITED = "TENANT_TASK_LIMITED";
export const DEFAULT_RUNNING_CAP_RETRY_MS = 5_000;

export const readTenantTaskLimits = () => ({
  maxQueued: getTenantMaxQueuedTasks(),
  maxRunning: getTenantMaxRunningTasks(),
});

export const createTenantTaskLimitedError = () =>
  Object.assign(
    new Error(
      "Too many agent tasks of this account are waiting to run. Try again once some have finished."
    ),
    { code: TENANT_TASK_LIMITED, expose: true, status: 429 }
  );

// Serializes `callback`s that share `key` in this process (a promise chain
// per key), so a cap check and the write it guards are not interleaved.
export const createKeyedSerializer = () => {
  const tails = new Map();

  return async (key, callback) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);

    tails.set(key, chained);

    try {
      await previous;
      return await callback();
    } finally {
      release();

      if (tails.get(key) === chained) {
        tails.delete(key);
      }
    }
  };
};

const CAPPED_CLAIM_STATUSES = new Set([TASK_STATUSES.queued, TASK_STATUSES.running]);

const getClaimRetryDelayMs = ({ retryAfterMs, retryAt } = {}) => {
  const hasRetryAfterMs =
    retryAfterMs !== undefined && retryAfterMs !== null && retryAfterMs !== "";
  const normalizedRetryAfterMs = Number(retryAfterMs);

  if (
    hasRetryAfterMs &&
    Number.isFinite(normalizedRetryAfterMs) &&
    normalizedRetryAfterMs >= 0
  ) {
    return Math.floor(normalizedRetryAfterMs);
  }

  const retryTimestamp = new Date(retryAt).getTime();

  return Number.isFinite(retryTimestamp)
    ? Math.max(0, retryTimestamp - Date.now())
    : null;
};

export const createJobOrchestrator = ({
  claimLeaseMs = DEFAULT_TASK_CLAIM_LEASE_MS,
  clearTaskClaimHeartbeat = clearInterval,
  createTaskClaimId = randomUUID,
  now = () => performance.now(),
  recordTaskRecoveryTrace = recordRagTrace,
  runners = {},
  runningCapRetryMs = DEFAULT_RUNNING_CAP_RETRY_MS,
  schedule = defaultSchedule,
  startTaskClaimHeartbeat = setInterval,
  taskLimits = readTenantTaskLimits,
  taskService = createTaskService(),
} = {}) => {
  const activeTaskExecutions = new Map();
  // Runs held back by the running cap, per tenant, oldest first.
  const deferredRuns = new Map();
  const serializeTenantClaims = createKeyedSerializer();
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

  const getPublicTask = ({ accessScope = {}, taskId } = {}) =>
    taskService.getTask({
      accessScope,
      taskId,
    });
  const getActiveTaskExecutionKey = ({ accessScope = {}, taskId } = {}) =>
    `${buildTaskScopeKey(accessScope)}\u0000${normalizeText(taskId)}`;

  const readMaxRunning = () => {
    const maxRunning = Math.floor(Number(taskLimits?.()?.maxRunning));

    return Number.isFinite(maxRunning) && maxRunning > 0 ? maxRunning : 0;
  };

  // The claim, unless the tenant's running cap is reached: then nothing is
  // claimed and `{ deferred: true }` comes back. Without a cap (the default)
  // this is exactly the claim.
  const claimWithinRunningCap = async ({ accessScope, claimId, task, taskId }) => {
    const claim = () =>
      taskService.claimTaskForRun({
        accessScope,
        claimId,
        leaseMs: claimLeaseMs,
        taskId,
      });
    const maxRunning = readMaxRunning();

    if (
      maxRunning === 0 ||
      typeof taskService.countActiveTasks !== "function" ||
      !CAPPED_CLAIM_STATUSES.has(task?.status)
    ) {
      return claim();
    }

    return serializeTenantClaims(buildTaskScopeKey(accessScope), async () => {
      const active = await taskService.countActiveTasks({
        accessScope,
        excludeTaskId: taskId,
        leaseMs: claimLeaseMs,
      });

      if ((Number(active?.running) || 0) >= maxRunning) {
        return { applied: false, deferred: true, outcome: "deferred_running_cap", task };
      }

      return claim();
    });
  };

  const takeDeferredRun = (scopeKey, taskId, entry) => {
    const waiting = deferredRuns.get(scopeKey);

    if (!waiting || waiting.get(taskId) !== entry) {
      return false;
    }

    waiting.delete(taskId);

    if (waiting.size === 0) {
      deferredRuns.delete(scopeKey);
    }

    return true;
  };

  // Holds a run back until the tenant has room: retried after
  // runningCapRetryMs, or sooner when one of the tenant's tasks finishes here
  // (wakeDeferredRun). Whichever comes first runs it; the other finds the
  // entry gone. A newer deferral of the same task replaces the older one.
  const deferTaskRun = ({ accessScope = {}, recovery = false, taskId } = {}) => {
    const scopeKey = buildTaskScopeKey(accessScope);
    const normalizedTaskId = normalizeText(taskId);
    const waiting = deferredRuns.get(scopeKey) ?? new Map();
    const entry = { accessScope, recovery, taskId: normalizedTaskId };

    waiting.delete(normalizedTaskId);
    waiting.set(normalizedTaskId, entry);
    deferredRuns.set(scopeKey, waiting);
    schedule(() => {
      if (takeDeferredRun(scopeKey, normalizedTaskId, entry)) {
        scheduleTaskRun(entry);
      }
    }, runningCapRetryMs);
  };

  const wakeDeferredRun = (accessScope = {}) => {
    const scopeKey = buildTaskScopeKey(accessScope);
    const oldest = deferredRuns.get(scopeKey)?.values().next().value;

    if (oldest && takeDeferredRun(scopeKey, oldest.taskId, oldest)) {
      scheduleTaskRun(oldest);
    }
  };

  const createClaimHeartbeat = ({
    accessScope = {},
    attemptCount,
    claimId,
    onClaimLost,
    taskId,
  } = {}) => {
    const heartbeatMs = Math.max(1, Math.floor(claimLeaseMs / 3));
    const readLocalTime = () => {
      const value = Number(now());

      return Number.isFinite(value) ? value : performance.now();
    };
    let heartbeat = null;
    let lastSuccessfulRenewalAt = readLocalTime();
    let renewInFlight = false;
    let stopped = false;

    const stop = () => {
      stopped = true;

      if (heartbeat !== null) {
        clearTaskClaimHeartbeat(heartbeat);
        heartbeat = null;
      }
    };
    const abortForLostClaim = () => {
      const error = buildTaskClaimLostError();

      stop();
      onClaimLost?.(error);
    };

    heartbeat = startTaskClaimHeartbeat(() => {
      if (stopped) {
        return;
      }

      if (readLocalTime() - lastSuccessfulRenewalAt >= claimLeaseMs) {
        abortForLostClaim();
        return;
      }

      if (renewInFlight) {
        return;
      }

      renewInFlight = true;
      Promise.resolve()
        .then(() =>
          taskService.renewTaskClaim({
            accessScope,
            attemptCount,
            claimId,
            taskId,
          })
        )
        .then((result) => {
          if (stopped) {
            return;
          }

          if (result?.applied) {
            lastSuccessfulRenewalAt = readLocalTime();
            return;
          }

          if (
            [
              TASK_MUTATION_OUTCOMES.claimLost,
              TASK_MUTATION_OUTCOMES.notFound,
            ].includes(result?.outcome)
          ) {
            abortForLostClaim();
          }
        })
        .catch((error) => {
          if (stopped) {
            return;
          }

          console.error("Task claim heartbeat failed.", error);
        })
        .finally(() => {
          renewInFlight = false;
        });
    }, heartbeatMs);
    heartbeat?.unref?.();

    return stop;
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

    const claimId = normalizeText(createTaskClaimId());
    const claimResult = await claimWithinRunningCap({
      accessScope,
      claimId,
      task,
      taskId,
    });

    if (claimResult?.deferred) {
      deferTaskRun({
        accessScope,
        recovery,
        taskId,
      });

      await recordTaskTrace({
        eventType: recovery ? "task_recovery_run" : "task_run_deferred",
        reason: "tenant_running_cap",
        resultStatus: task.status,
        runnerId: normalizeText(task.runnerId),
        status: "deferred",
        taskId,
      });

      return getPublicTask({
        accessScope,
        taskId,
      });
    }

    if (claimResult?.outcome === TASK_MUTATION_OUTCOMES.notFound) {
      if (recovery) {
        await recordTaskTrace({
          eventType: "task_recovery_run",
          errorStatus: 404,
          resultStatus: "",
          runnerId: normalizeText(task.runnerId),
          status: "failed",
          taskId,
        });
      }

      throw buildJobError("Task not found.", 404);
    }

    if (!claimResult?.applied) {
      if (
        recovery &&
        claimResult?.outcome === TASK_MUTATION_OUTCOMES.notRunnable
      ) {
        const delayMs = getClaimRetryDelayMs(claimResult);

        if (delayMs !== null) {
          scheduleTaskRun({
            accessScope,
            delayMs,
            recovery: true,
            taskId,
          });
        }
      }

      if (recovery) {
        await recordTaskTrace({
          eventType: "task_recovery_run",
          resultStatus: claimResult?.task?.status ?? "",
          runnerId: normalizeText(task.runnerId),
          status: "skipped",
          taskId,
        });
      }

      return getPublicTask({
        accessScope,
        taskId,
      });
    }

    const claimedTask = claimResult.task;
    const attemptCount = claimResult.attemptCount;
    const executionController = new AbortController();
    const activeTaskExecutionKey = getActiveTaskExecutionKey({
      accessScope,
      taskId,
    });
    const abortExecution = (error = buildTaskClaimLostError()) => {
      if (!executionController.signal.aborted) {
        executionController.abort(error);
      }
    };
    const assertClaimActive = () => {
      if (!executionController.signal.aborted) {
        return;
      }

      throw executionController.signal.reason instanceof Error
        ? executionController.signal.reason
        : buildTaskClaimLostError();
    };
    const execution = {
      abort: abortExecution,
      claimId,
    };
    const previousExecution = activeTaskExecutions.get(activeTaskExecutionKey);

    previousExecution?.abort(buildTaskClaimLostError());
    activeTaskExecutions.set(activeTaskExecutionKey, execution);

    const stopClaimHeartbeat = createClaimHeartbeat({
      accessScope,
      attemptCount,
      claimId,
      onClaimLost: abortExecution,
      taskId,
    });
    let writeQueue = Promise.resolve();
    const patchClaimedTask = (nextPatch = {}) => {
      const write = writeQueue.then(() =>
        taskService.patchClaimedTask({
          accessScope,
          attemptCount,
          claimId,
          patch: nextPatch,
          taskId,
        })
      );

      writeQueue = write.catch(() => {});

      return write.then((result) => {
        if (!result?.applied) {
          const error = buildTaskClaimLostError();

          abortExecution(error);
          throw error;
        }

        return result.task;
      });
    };
    const taskWriter = {
      getTask: () =>
        getPublicTask({
          accessScope,
          taskId,
        }),
      patchTask: ({ patch = {}, taskId: requestedTaskId } = {}) => {
        if (requestedTaskId && normalizeText(requestedTaskId) !== taskId) {
          throw buildJobError("Runner cannot write a different task.", 403);
        }

        return patchClaimedTask(patch);
      },
      upsertTask: ({ task: nextTask = {} } = {}) => {
        if (nextTask.id && normalizeText(nextTask.id) !== taskId) {
          throw buildJobError("Runner cannot write a different task.", 403);
        }

        return patchClaimedTask(nextTask);
      },
    };

    try {
      assertClaimActive();
      const resultPatch =
        (await runner.run?.({
          accessScope,
          assertClaimActive,
          patchTask: patchClaimedTask,
          signal: executionController.signal,
          task: claimedTask,
          taskWriter,
        })) ?? {};

      assertClaimActive();
      const completedTask = await patchClaimedTask({
        status: TASK_STATUSES.completed,
        ...resultPatch,
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
      let claimWasLost = isTaskClaimLostError(error);
      let failedTask = null;

      if (claimWasLost) {
        failedTask = await getPublicTask({
          accessScope,
          taskId,
        });
      } else {
        try {
          failedTask = await patchClaimedTask({
            error: error instanceof Error ? error.message : String(error),
            status: TASK_STATUSES.failed,
          });
        } catch (claimError) {
          if (!isTaskClaimLostError(claimError)) {
            throw claimError;
          }

          claimWasLost = true;
          failedTask = await getPublicTask({
            accessScope,
            taskId,
          });
        }
      }

      if (recovery) {
        const executionWasFenced =
          claimWasLost || failedTask?.status === TASK_STATUSES.canceled;

        await recordTaskTrace({
          eventType: "task_recovery_run",
          errorStatus: executionWasFenced ? 409 : error?.status ?? 500,
          resultStatus: failedTask?.status ?? "",
          runnerId: normalizeText(task.runnerId),
          status: executionWasFenced ? "skipped" : "failed",
          taskId,
        });
      }

      return failedTask;
    } finally {
      stopClaimHeartbeat();

      if (activeTaskExecutions.get(activeTaskExecutionKey) === execution) {
        activeTaskExecutions.delete(activeTaskExecutionKey);
      }

      // This claim is settled, so a run the tenant's running cap held back
      // may take its place.
      wakeDeferredRun(accessScope);
    }
  };

  const scheduleTaskRun = ({
    accessScope = {},
    delayMs = 0,
    recovery = false,
    taskId,
  } = {}) => {
    // A scheduled run acts for its task's own scope, whatever context
    // scheduled it (a request, an admin recovery action, or startup), and
    // never with the deadline or cancellation of a request that scheduled it.
    schedule(
      () => {
        return runOutsideRequestDeadline(() =>
          runWithDatabaseTenant(accessScope, () =>
            runTask({
              accessScope,
              recovery,
              taskId,
            })
          )
        ).catch((error) => {
          console.error(
            "Task runner failed before task state could be updated.",
            error
          );
        });
      },
      delayMs
    );
  };

  const recoverRunnableTasks = async ({
    statuses = [TASK_STATUSES.queued, TASK_STATUSES.running],
  } = {}) => {
    // Recovery lists every tenant's runnable tasks, including when an admin
    // triggers it from a request.
    const recoverableTasks = taskService.listRecoverableTasks
      ? await runAsDatabaseSystem(() =>
          taskService.listRecoverableTasks({
            statuses,
          })
        )
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
        const transition = await taskService.transitionTask({
          accessScope,
          expectedStatuses: [
            TASK_STATUSES.pending,
            TASK_STATUSES.queued,
            TASK_STATUSES.running,
            TASK_STATUSES.waitingForUser,
          ],
          taskId,
          patch: {
            requiredUserAction: "",
            status: TASK_STATUSES.canceled,
          },
        });

        if (transition?.outcome === TASK_MUTATION_OUTCOMES.notFound) {
          throw buildJobError("Task not found.", 404);
        }

        const canceledTask = transition.task;

        if (canceledTask?.status === TASK_STATUSES.canceled) {
          activeTaskExecutions
            .get(
              getActiveTaskExecutionKey({
                accessScope,
                taskId,
              })
            )
            ?.abort(buildTaskClaimLostError());
        }

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
          deferTaskPersistence: true,
          payload,
          task,
        })) ?? {};
      const transition = await taskService.transitionTask({
        accessScope,
        expectedStatuses: [
          TASK_STATUSES.failed,
          TASK_STATUSES.waitingForUser,
        ],
        taskId,
        patch: {
          requiredUserAction: "",
          status: TASK_STATUSES.queued,
          ...nextPatch,
        },
      });

      if (transition?.outcome === TASK_MUTATION_OUTCOMES.notFound) {
        throw buildJobError("Task not found.", 404);
      }

      const nextTask = transition.task;

      if (transition.applied && runImmediately) {
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
