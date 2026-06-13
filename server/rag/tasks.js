const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeAccessScope = (accessScope = {}) => ({
  userId: normalizeText(accessScope.userId),
  workspaceId: normalizeText(accessScope.workspaceId),
});

const buildScopeKey = (accessScope = {}) => {
  const scope = normalizeAccessScope(accessScope);

  return `${scope.userId}\u0000${scope.workspaceId}`;
};

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

export const TASK_STATUSES = Object.freeze({
  completed: "completed",
  failed: "failed",
  pending: "pending",
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
    action: normalizeText(task.action),
    counts: normalizeRecord(task.counts),
    input: normalizeRecord(task.input),
    result: normalizeRecord(task.result),
    error: task.error ?? null,
    requiredUserAction: normalizeText(task.requiredUserAction),
    createdAt: normalizeText(task.createdAt),
    updatedAt: normalizeText(task.updatedAt),
  };
};

export const createInMemoryTaskStore = ({ now = () => new Date().toISOString() } = {}) => {
  const tasks = new Map();

  const buildTaskKey = ({ accessScope = {}, taskId }) =>
    `${buildScopeKey(accessScope)}\u0000${normalizeText(taskId)}`;

  return {
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
      const scopeKey = buildScopeKey(accessScope);
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
          result: {
            ...existingTask.result,
            ...normalizeRecord(patch.result),
          },
        },
      });
    },

    upsert({ accessScope = {}, task } = {}) {
      const normalizedTask = normalizeTask(task);

      if (!normalizedTask) {
        throw new Error("Task requires id and type.");
      }

      const scopeKey = buildScopeKey(accessScope);
      const existingTask = this.get({
        accessScope,
        taskId: normalizedTask.id,
      });
      const timestamp = now();
      const storedTask = {
        ...normalizedTask,
        createdAt: normalizedTask.createdAt || existingTask?.createdAt || timestamp,
        updatedAt: normalizedTask.updatedAt || timestamp,
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
  const { scopeKey, ...publicTask } = task;

  return publicTask;
};

export const createTaskService = ({
  taskStore = createInMemoryTaskStore(),
} = {}) => ({
  deleteTask({ accessScope = {}, taskId } = {}) {
    return taskStore.delete({
      accessScope,
      taskId,
    });
  },

  getTask({ accessScope = {}, taskId } = {}) {
    const task = taskStore.get({
      accessScope,
      taskId,
    });

    return task ? stripInternalTaskFields(task) : null;
  },

  listTasks({ accessScope = {}, type = "" } = {}) {
    return {
      tasks: toArray(
        taskStore.list({
          accessScope,
          type,
        })
      ).map(stripInternalTaskFields),
    };
  },

  patchTask({ accessScope = {}, taskId, patch = {} } = {}) {
    const task = taskStore.patch({
      accessScope,
      taskId,
      patch,
    });

    return task ? stripInternalTaskFields(task) : null;
  },

  upsertTask({ accessScope = {}, task } = {}) {
    return stripInternalTaskFields(
      taskStore.upsert({
        accessScope,
        task,
      })
    );
  },
});
