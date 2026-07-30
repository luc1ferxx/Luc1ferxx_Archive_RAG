import { normalizeText } from "../lib/normalize-text.js";


export const normalizeTaskAccessScope = (accessScope = {}) => ({
  userId: normalizeText(accessScope.userId),
  workspaceId: normalizeText(accessScope.workspaceId),
});

export const buildTaskScopeKey = (accessScope = {}) => {
  const scope = normalizeTaskAccessScope(accessScope);

  return `${scope.userId}\u0000${scope.workspaceId}`;
};

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

export const TASK_STATUSES = Object.freeze({
  canceled: "canceled",
  completed: "completed",
  failed: "failed",
  pending: "pending",
  queued: "queued",
  running: "running",
  waitingForUser: "waiting_for_user",
});

export const DEFAULT_TASK_CLAIM_LEASE_MS = 60_000;

export const TASK_MUTATION_OUTCOMES = Object.freeze({
  claimLost: "claim_lost",
  claimed: "claimed",
  notAllowed: "not_allowed",
  notFound: "not_found",
  notRunnable: "not_runnable",
  renewed: "renewed",
  transitioned: "transitioned",
  updated: "updated",
});

const VALID_TASK_STATUSES = new Set(Object.values(TASK_STATUSES));

const normalizeTaskStatus = (status) => {
  const normalizedStatus = normalizeText(status);

  return VALID_TASK_STATUSES.has(normalizedStatus)
    ? normalizedStatus
    : TASK_STATUSES.pending;
};

const normalizeTaskItem = (item = {}) => {
  const id = normalizeText(item.id);

  if (!id) {
    return null;
  }

  return {
    id,
    status: normalizeTaskStatus(item.status),
    label: normalizeText(item.label),
    summary: normalizeText(item.summary),
    result: normalizeRecord(item.result),
    error: item.error ?? null,
    updatedAt: normalizeText(item.updatedAt),
  };
};

const normalizeTaskItems = (items) =>
  toArray(items).map(normalizeTaskItem).filter(Boolean);

const normalizeTaskAttemptCount = (value) => {
  const attemptCount = Number(value);

  return Number.isSafeInteger(attemptCount) && attemptCount >= 0
    ? attemptCount
    : 0;
};

const toTimestamp = (value) => {
  const timestamp = new Date(value).getTime();

  return Number.isFinite(timestamp) ? timestamp : null;
};

const normalizeTaskLeaseMs = (value) => {
  const leaseMs = Number(value);

  return Number.isFinite(leaseMs) && leaseMs > 0
    ? Math.floor(leaseMs)
    : DEFAULT_TASK_CLAIM_LEASE_MS;
};

const getTaskClaimRetryAt = ({ leaseMs, task } = {}) => {
  if (!task) {
    return "";
  }

  const nextRunAt = toTimestamp(task.nextRunAt);

  if (task.status === TASK_STATUSES.queued && nextRunAt !== null) {
    return new Date(nextRunAt).toISOString();
  }

  const leaseStartedAt = toTimestamp(task.claimedAt || task.updatedAt);

  return task.status === TASK_STATUSES.running && leaseStartedAt !== null
    ? new Date(leaseStartedAt + normalizeTaskLeaseMs(leaseMs)).toISOString()
    : "";
};

const isTaskRunnable = ({ leaseMs, now, task } = {}) => {
  const currentTimestamp = toTimestamp(now);

  if (!task || currentTimestamp === null) {
    return false;
  }

  if (task.status === TASK_STATUSES.queued) {
    const nextRunAt = toTimestamp(task.nextRunAt);

    return nextRunAt === null || nextRunAt <= currentTimestamp;
  }

  if (task.status !== TASK_STATUSES.running) {
    return false;
  }

  const leaseStartedAt = toTimestamp(task.claimedAt || task.updatedAt);

  return (
    leaseStartedAt === null ||
    leaseStartedAt <= currentTimestamp - normalizeTaskLeaseMs(leaseMs)
  );
};

export const normalizeTask = (task = {}) => {
  const id = normalizeText(task.id);
  const type = normalizeText(task.type);

  if (!id || !type) {
    return null;
  }

  return {
    id,
    type,
    status: normalizeTaskStatus(task.status),
    label: normalizeText(task.label),
    summary: normalizeText(task.summary),
    provider: normalizeRecord(task.provider, null),
    subject: normalizeRecord(task.subject, null),
    runnerId: normalizeText(task.runnerId),
    action: normalizeText(task.action),
    counts: normalizeRecord(task.counts),
    input: normalizeRecord(task.input),
    items: normalizeTaskItems(task.items),
    result: normalizeRecord(task.result),
    error: task.error ?? null,
    payload: normalizeRecord(task.payload, null),
    requiredUserAction: normalizeText(task.requiredUserAction),
    createdAt: normalizeText(task.createdAt),
    updatedAt: normalizeText(task.updatedAt),
  };
};

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;
const MIN_LIST_LIMIT = 1;

const normalizePaginationParams = ({ limit, offset } = {}) => {
  let normalizedLimit = Number(limit);

  if (limit === "all") {
    // Internal callers pass "all" when correctness needs the complete result
    // set (status counts, recovery scans). HTTP-facing callers stay capped.
    normalizedLimit = null;
  } else if (!Number.isFinite(normalizedLimit) || normalizedLimit < MIN_LIST_LIMIT) {
    normalizedLimit = DEFAULT_LIST_LIMIT;
  } else if (normalizedLimit > MAX_LIST_LIMIT) {
    normalizedLimit = MAX_LIST_LIMIT;
  } else {
    normalizedLimit = Math.floor(normalizedLimit);
  }

  let normalizedOffset = Number(offset);

  if (!Number.isFinite(normalizedOffset) || normalizedOffset < 0) {
    normalizedOffset = 0;
  } else {
    normalizedOffset = Math.floor(normalizedOffset);
  }

  return { limit: normalizedLimit, offset: normalizedOffset };
};

export const createInMemoryTaskStore = ({ now = () => new Date().toISOString() } = {}) => {
  const tasks = new Map();

  const buildTaskKey = ({ accessScope = {}, taskId }) =>
    `${buildTaskScopeKey(accessScope)}\u0000${normalizeText(taskId)}`;

  return {
    initialize() {
      return true;
    },

    delete({ accessScope = {}, taskId } = {}) {
      return tasks.delete(
        buildTaskKey({
          accessScope,
          taskId,
        })
      );
    },

    get({ accessScope = {}, taskId } = {}) {
      return (
        tasks.get(
          buildTaskKey({
            accessScope,
            taskId,
          })
        ) ?? null
      );
    },

    list({ accessScope = {}, type = "", limit, offset } = {}) {
      const scopeKey = buildTaskScopeKey(accessScope);
      const normalizedType = normalizeText(type);
      const pagination = normalizePaginationParams({ limit, offset });

      return [...tasks.values()]
        .filter(
          (task) =>
            task.scopeKey === scopeKey &&
            (!normalizedType || task.type === normalizedType)
        )
        .sort((left, right) =>
          String(right.updatedAt).localeCompare(String(left.updatedAt))
        )
        .slice(
          pagination.offset,
          pagination.limit === null
            ? undefined
            : pagination.offset + pagination.limit
        );
    },

    listRecoverable({ statuses = [] } = {}) {
      const normalizedStatuses = new Set(
        toArray(statuses).map(normalizeTaskStatus)
      );

      return [...tasks.values()]
        .filter((task) => normalizedStatuses.has(task.status))
        .sort((left, right) =>
          String(left.updatedAt).localeCompare(String(right.updatedAt))
        );
    },

    claim({
      accessScope = {},
      claimId,
      leaseMs = DEFAULT_TASK_CLAIM_LEASE_MS,
      taskId,
    } = {}) {
      const existingTask = this.get({
        accessScope,
        taskId,
      });

      if (!existingTask) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notFound,
          retryAfterMs: 0,
          retryAt: "",
          task: null,
        };
      }

      const timestamp = now();

      if (
        !normalizeText(claimId) ||
        !isTaskRunnable({
          leaseMs,
          now: timestamp,
          task: existingTask,
        })
      ) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notRunnable,
          retryAfterMs: normalizeTaskLeaseMs(leaseMs),
          retryAt: getTaskClaimRetryAt({
            leaseMs,
            task: existingTask,
          }),
          task: existingTask,
        };
      }

      const claimedTask = this.upsert({
        accessScope,
        task: {
          ...existingTask,
          attemptCount: normalizeTaskAttemptCount(existingTask.attemptCount) + 1,
          claimedAt: timestamp,
          claimedBy: normalizeText(claimId),
          nextRunAt: "",
          status: TASK_STATUSES.running,
          updatedAt: timestamp,
        },
      });

      return {
        applied: true,
        attemptCount: claimedTask.attemptCount,
        outcome: TASK_MUTATION_OUTCOMES.claimed,
        retryAfterMs: 0,
        retryAt: "",
        task: claimedTask,
      };
    },

    patchClaimed({
      accessScope = {},
      attemptCount,
      claimId,
      patch = {},
      taskId,
    } = {}) {
      const existingTask = this.get({
        accessScope,
        taskId,
      });

      if (!existingTask) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notFound,
          task: null,
        };
      }

      const normalizedAttemptCount = normalizeTaskAttemptCount(attemptCount);
      const normalizedClaimId = normalizeText(claimId);

      if (
        !normalizedClaimId ||
        normalizedAttemptCount <= 0 ||
        existingTask.status !== TASK_STATUSES.running ||
        existingTask.claimedBy !== normalizedClaimId ||
        existingTask.attemptCount !== normalizedAttemptCount
      ) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.claimLost,
          task: existingTask,
        };
      }

      const nextStatus =
        patch.status === undefined
          ? existingTask.status
          : normalizeTaskStatus(patch.status);
      const shouldReleaseClaim = nextStatus !== TASK_STATUSES.running;
      const task = this.patch({
        accessScope,
        taskId,
        patch: {
          ...patch,
          attemptCount: existingTask.attemptCount,
          claimedAt: shouldReleaseClaim ? "" : now(),
          claimedBy: shouldReleaseClaim ? "" : existingTask.claimedBy,
          nextRunAt:
            patch.nextRunAt === undefined
              ? existingTask.nextRunAt
              : patch.nextRunAt,
        },
      });

      return {
        applied: true,
        outcome: TASK_MUTATION_OUTCOMES.updated,
        task,
      };
    },

    renewClaim({
      accessScope = {},
      attemptCount,
      claimId,
      taskId,
    } = {}) {
      const existingTask = this.get({
        accessScope,
        taskId,
      });
      const normalizedAttemptCount = normalizeTaskAttemptCount(attemptCount);
      const normalizedClaimId = normalizeText(claimId);

      if (
        !existingTask ||
        !normalizedClaimId ||
        normalizedAttemptCount <= 0 ||
        existingTask.status !== TASK_STATUSES.running ||
        existingTask.claimedBy !== normalizedClaimId ||
        existingTask.attemptCount !== normalizedAttemptCount
      ) {
        return {
          applied: false,
          outcome: existingTask
            ? TASK_MUTATION_OUTCOMES.claimLost
            : TASK_MUTATION_OUTCOMES.notFound,
          task: existingTask,
        };
      }

      const timestamp = now();
      const task = this.upsert({
        accessScope,
        task: {
          ...existingTask,
          claimedAt: timestamp,
          updatedAt: timestamp,
        },
      });

      return {
        applied: true,
        outcome: TASK_MUTATION_OUTCOMES.renewed,
        task,
      };
    },

    transition({
      accessScope = {},
      expectedStatuses = [],
      patch = {},
      taskId,
    } = {}) {
      const existingTask = this.get({
        accessScope,
        taskId,
      });

      if (!existingTask) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notFound,
          task: null,
        };
      }

      const allowedStatuses = new Set(
        toArray(expectedStatuses).map(normalizeTaskStatus)
      );

      if (!allowedStatuses.has(existingTask.status)) {
        return {
          applied: false,
          outcome: TASK_MUTATION_OUTCOMES.notAllowed,
          task: existingTask,
        };
      }

      const task = this.patch({
        accessScope,
        taskId,
        patch: {
          ...patch,
          attemptCount: existingTask.attemptCount,
          claimedAt: "",
          claimedBy: "",
        },
      });

      return {
        applied: true,
        outcome: TASK_MUTATION_OUTCOMES.transitioned,
        task,
      };
    },

    patch({ accessScope = {}, taskId, patch = {} } = {}) {
      const existingTask = this.get({
        accessScope,
        taskId,
      });

      if (!existingTask) {
        return null;
      }

      return this.upsert({
        accessScope,
        task: {
          ...existingTask,
          ...patch,
          counts: {
            ...existingTask.counts,
            ...normalizeRecord(patch.counts),
          },
          input: {
            ...existingTask.input,
            ...normalizeRecord(patch.input),
          },
          items: patch.items ?? existingTask.items,
          result: {
            ...existingTask.result,
            ...normalizeRecord(patch.result),
          },
          payload:
            patch.payload === undefined ? existingTask.payload : patch.payload,
        },
      });
    },

    upsert({ accessScope = {}, task } = {}) {
      const normalizedTask = normalizeTask(task);

      if (!normalizedTask) {
        throw new Error("Task requires id and type.");
      }

      const normalizedAccessScope = normalizeTaskAccessScope(accessScope);
      const scopeKey = buildTaskScopeKey(normalizedAccessScope);
      const existingTask = this.get({
        accessScope: normalizedAccessScope,
        taskId: normalizedTask.id,
      });
      const timestamp = now();
      const storedTask = {
        ...normalizedTask,
        attemptCount: normalizeTaskAttemptCount(
          task.attemptCount ?? existingTask?.attemptCount
        ),
        claimedAt:
          task.claimedAt === undefined
            ? normalizeText(existingTask?.claimedAt)
            : normalizeText(task.claimedAt),
        claimedBy:
          task.claimedBy === undefined
            ? normalizeText(existingTask?.claimedBy)
            : normalizeText(task.claimedBy),
        createdAt: normalizedTask.createdAt || existingTask?.createdAt || timestamp,
        nextRunAt:
          task.nextRunAt === undefined
            ? normalizeText(existingTask?.nextRunAt)
            : normalizeText(task.nextRunAt),
        updatedAt: normalizedTask.updatedAt || timestamp,
        accessScope: normalizedAccessScope,
        scopeKey,
      };

      tasks.set(
        buildTaskKey({
          accessScope,
          taskId: storedTask.id,
        }),
        storedTask
      );

      return storedTask;
    },
  };
};

const stripInternalTaskFields = (task = {}) => {
  const {
    accessScope,
    attemptCount,
    claimedAt,
    claimedBy,
    nextRunAt,
    payload,
    scopeKey,
    ...publicTask
  } = task;

  return publicTask;
};

export const createTaskService = ({
  taskStore = createInMemoryTaskStore(),
} = {}) => ({
  async initialize() {
    return taskStore.initialize?.() ?? true;
  },

  async deleteTask({ accessScope = {}, taskId } = {}) {
    return taskStore.delete({
      accessScope,
      taskId,
    });
  },

  async getTask({ accessScope = {}, taskId } = {}) {
    const task = await taskStore.get({
      accessScope,
      taskId,
    });

    return task ? stripInternalTaskFields(task) : null;
  },

  async getInternalTask({ accessScope = {}, taskId } = {}) {
    return taskStore.get({
      accessScope,
      taskId,
    });
  },

  async listTasks({ accessScope = {}, type = "", limit, offset } = {}) {
    return {
      tasks: toArray(
        await taskStore.list({
          accessScope,
          type,
          limit,
          offset,
        })
      ).map(stripInternalTaskFields),
    };
  },

  async listRecoverableTasks({ statuses = [] } = {}) {
    return {
      tasks: toArray(
        taskStore.listRecoverable
          ? await taskStore.listRecoverable({
              statuses,
            })
          : []
      ),
    };
  },

  async claimTaskForRun({
    accessScope = {},
    claimId,
    leaseMs = DEFAULT_TASK_CLAIM_LEASE_MS,
    taskId,
  } = {}) {
    return taskStore.claim({
      accessScope,
      claimId,
      leaseMs,
      taskId,
    });
  },

  async patchTask({ accessScope = {}, taskId, patch = {} } = {}) {
    const task = await taskStore.patch({
      accessScope,
      taskId,
      patch,
    });

    return task ? stripInternalTaskFields(task) : null;
  },

  async patchClaimedTask({
    accessScope = {},
    attemptCount,
    claimId,
    patch = {},
    taskId,
  } = {}) {
    const result = await taskStore.patchClaimed({
      accessScope,
      attemptCount,
      claimId,
      patch,
      taskId,
    });

    return {
      ...result,
      task: result.task ? stripInternalTaskFields(result.task) : null,
    };
  },

  async renewTaskClaim({
    accessScope = {},
    attemptCount,
    claimId,
    taskId,
  } = {}) {
    return taskStore.renewClaim({
      accessScope,
      attemptCount,
      claimId,
      taskId,
    });
  },

  async transitionTask({
    accessScope = {},
    expectedStatuses = [],
    patch = {},
    taskId,
  } = {}) {
    const result = await taskStore.transition({
      accessScope,
      expectedStatuses,
      patch,
      taskId,
    });

    return {
      ...result,
      task: result.task ? stripInternalTaskFields(result.task) : null,
    };
  },

  async upsertTask({ accessScope = {}, task } = {}) {
    const storedTask = await taskStore.upsert({
      accessScope,
      task,
    });

    return storedTask ? stripInternalTaskFields(storedTask) : null;
  },
});
