const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

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

    list({ accessScope = {}, type = "" } = {}) {
      const scopeKey = buildTaskScopeKey(accessScope);
      const normalizedType = normalizeText(type);

      return [...tasks.values()]
        .filter(
          (task) =>
            task.scopeKey === scopeKey &&
            (!normalizedType || task.type === normalizedType)
        )
        .sort((left, right) =>
          String(right.updatedAt).localeCompare(String(left.updatedAt))
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
        createdAt: normalizedTask.createdAt || existingTask?.createdAt || timestamp,
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

  async listTasks({ accessScope = {}, type = "" } = {}) {
    return {
      tasks: toArray(
        await taskStore.list({
          accessScope,
          type,
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

  async patchTask({ accessScope = {}, taskId, patch = {} } = {}) {
    const task = await taskStore.patch({
      accessScope,
      taskId,
      patch,
    });

    return task ? stripInternalTaskFields(task) : null;
  },

  async upsertTask({ accessScope = {}, task } = {}) {
    const storedTask = await taskStore.upsert({
      accessScope,
      task,
    });

    return storedTask ? stripInternalTaskFields(storedTask) : null;
  },
});
