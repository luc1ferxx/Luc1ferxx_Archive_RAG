// The scheduling both parse pools share (rag/pdf-parse-pool.js for pdf.js,
// rag/office-parse-pool.js for the Office readers): a pool of worker_threads
// running one task at a time each, created per pool definition by
// createWorkerTaskPool. What differs between the two (the worker file, the
// settings, the errors and their wording, the message a task posts) is passed
// in; the scheduling below is the one pdf-parse-pool.js always had.
//
//   - Created on first use with the size the caller passes; workers are
//     spawned as tasks need them, up to that size. When the size or the
//     worker memory limit changes, the next task gets a new pool and the old
//     one finishes the tasks it holds, then terminates its workers, so for a
//     moment both run.
//   - Tasks wait in FIFO order. A worker is ref()'d while it runs a task and
//     unref()'d while idle, so an idle pool never keeps a process alive.
//   - A task's message is built when the task starts (buildMessage), so a
//     queued task holds what its caller gave and nothing more.
//   - An error the task throws in the worker comes back serialized and is
//     rebuilt by toTaskError. A worker that exits or crashes mid-task (out of
//     memory under its resourceLimits included) fails that task with
//     workerLostError(cause, exitCode) and is replaced on the next task; a
//     task over the timeout terminates its worker and fails with
//     timeoutError(timeoutMs).

import { Worker } from "node:worker_threads";

/**
 * A pool definition:
 *   workerUrl              the worker file (a URL)
 *   workerOptions          extra Worker options (e.g. { env: SHARE_ENV })
 *   getTimeoutMs           () => ms one task may run, 0 = none (read per task)
 *   getMaxOldGenerationMb  () => resourceLimits.maxOldGenerationSizeMb, 0 = Node's default
 *   buildMessage(task)     => { message, transfer }: what to post for task
 *                          (task.payload is what run() was given); `id` is added
 *   toTaskError(error)     the serialized error a worker answered -> an Error
 *   workerLostError(cause, exitCode)  the error of a task whose worker died
 *   timeoutError(ms), stoppedError(), cancelledError()
 * Returns { run(payload, { signal, size }), snapshot(), stop(), reset() }.
 */
export const createWorkerTaskPool = ({
  buildMessage,
  cancelledError,
  getMaxOldGenerationMb,
  getTimeoutMs,
  stoppedError,
  timeoutError,
  toTaskError,
  workerLostError,
  workerOptions = {},
  workerUrl,
}) => {
  let currentPool = null;
  const retiringPools = new Set();
  const totals = { completedTasks: 0, failedTasks: 0, restartedWorkers: 0 };
  let nextTaskId = 1;

  const createPool = ({ size, maxOldGenerationMb }) => ({
    idle: [],
    maxOldGenerationMb,
    queue: [],
    retired: false,
    size,
    slots: new Set(),
  });

  const settleTask = (task, settle, value) => {
    task.detach?.();
    settle(value);
  };

  const failTask = (task, error) => {
    totals.failedTasks += 1;
    settleTask(task, task.reject, error);
  };

  const closeSlot = (slot) => {
    slot.closed = true;
    clearTimeout(slot.timer);
    slot.timer = null;
    slot.pool.slots.delete(slot);

    const index = slot.pool.idle.indexOf(slot);

    if (index >= 0) {
      slot.pool.idle.splice(index, 1);
    }
  };

  const terminateSlot = (slot) => {
    if (slot.closed) {
      return Promise.resolve();
    }

    closeSlot(slot);
    return slot.worker.terminate().catch(() => {});
  };

  const releaseSlot = (slot) => {
    slot.worker.unref();

    if (slot.pool.retired && slot.pool.queue.length === 0) {
      terminateSlot(slot);
    } else {
      slot.pool.idle.push(slot);
    }
  };

  // The worker died on its own: an exit, an uncaught error, out of memory.
  const loseSlot = (slot, cause, exitCode) => {
    if (slot.closed) {
      return;
    }

    const { task } = slot;

    slot.task = null;
    closeSlot(slot);
    totals.restartedWorkers += 1;

    if (task) {
      failTask(task, workerLostError(cause, exitCode));
    }

    dispatch(slot.pool);
  };

  const answerTask = (slot, message) => {
    const { task } = slot;

    if (!task || message?.id !== task.id) {
      return;
    }

    clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;

    if (message.error) {
      failTask(task, toTaskError(message.error));
    } else {
      totals.completedTasks += 1;
      settleTask(task, task.resolve, message.result);
    }

    releaseSlot(slot);
    dispatch(slot.pool);
  };

  const timeOutTask = (slot, task, timeoutMs) => {
    if (slot.task !== task) {
      return;
    }

    slot.task = null;
    totals.restartedWorkers += 1;
    terminateSlot(slot);
    failTask(task, timeoutError(timeoutMs));
    dispatch(slot.pool);
  };

  const spawnSlot = (pool) => {
    const worker = new Worker(workerUrl, {
      // A worker inherits the parent's CLI options by default, and it needs
      // none of them: some break it (--input-type, which a worker refuses with
      // a file entry point) and others would only load more into every worker
      // (an --import preload).
      execArgv: [],
      ...workerOptions,
      ...(pool.maxOldGenerationMb > 0 ? { resourceLimits: { maxOldGenerationSizeMb: pool.maxOldGenerationMb } } : {}),
    });
    const slot = { closed: false, pool, task: null, timer: null, worker };

    worker.unref();
    worker.on("message", (message) => answerTask(slot, message));
    worker.on("error", (error) => loseSlot(slot, error));
    worker.on("exit", (exitCode) => loseSlot(slot, null, exitCode));
    pool.slots.add(slot);
    return slot;
  };

  const startTask = (slot, task) => {
    slot.task = task;
    slot.worker.ref();

    const timeoutMs = getTimeoutMs();

    if (timeoutMs > 0) {
      slot.timer = setTimeout(() => timeOutTask(slot, task, timeoutMs), timeoutMs);
    }

    try {
      const { message, transfer } = buildMessage(task);

      slot.worker.postMessage({ ...message, id: task.id }, transfer);
    } catch (error) {
      clearTimeout(slot.timer);
      slot.timer = null;
      slot.task = null;
      failTask(task, error);
      releaseSlot(slot);
    }
  };

  const dispatch = (pool) => {
    while (pool.queue.length > 0) {
      let slot = pool.idle.pop();

      if (!slot) {
        if (pool.slots.size >= pool.size) {
          break;
        }

        try {
          slot = spawnSlot(pool);
        } catch (error) {
          failTask(pool.queue.shift(), workerLostError(error));
          continue;
        }
      }

      startTask(slot, pool.queue.shift());
    }

    if (pool.retired && pool.queue.length === 0) {
      for (const slot of [...pool.idle]) {
        terminateSlot(slot);
      }

      if (pool.slots.size === 0) {
        retiringPools.delete(pool);
      }
    }
  };

  const resolvePool = (size) => {
    const maxOldGenerationMb = getMaxOldGenerationMb();

    if (currentPool?.size === size && currentPool.maxOldGenerationMb === maxOldGenerationMb) {
      return currentPool;
    }

    if (currentPool) {
      currentPool.retired = true;
      retiringPools.add(currentPool);
      dispatch(currentPool);
    }

    currentPool = createPool({ maxOldGenerationMb, size });
    return currentPool;
  };

  const cancelQueuedTask = (task) => {
    const index = task.pool.queue.indexOf(task);

    // A task already running finishes; its caller ignores the answer.
    if (index >= 0) {
      task.pool.queue.splice(index, 1);
      settleTask(task, task.reject, cancelledError());
    }
  };

  /**
   * Runs one task on a worker of a pool of `size` (a positive integer, which
   * the caller checks). `signal` drops the task while it still waits in the
   * queue (cancelledError); a task already running finishes.
   */
  const run = (payload, { signal, size } = {}) => {
    if (signal?.aborted) {
      return Promise.reject(cancelledError());
    }

    const pool = resolvePool(size);

    return new Promise((resolve, reject) => {
      const task = { id: nextTaskId, payload, pool, reject, resolve };

      nextTaskId += 1;

      if (signal) {
        const onAbort = () => cancelQueuedTask(task);

        signal.addEventListener("abort", onAbort, { once: true });
        task.detach = () => signal.removeEventListener("abort", onAbort);
      }

      pool.queue.push(task);
      dispatch(pool);
    });
  };

  /**
   * { size, busy, idle, queued, completedTasks, failedTasks, restartedWorkers }:
   * the current pool's size (0 before the first task), workers running a task
   * or waiting for one and tasks waiting for a worker over the current pool
   * and any pool still finishing after a size change, and process-wide totals
   * (failedTasks counts every task that failed, a parse error included;
   * restartedWorkers every worker lost to a crash, an exit or a timeout).
   */
  const snapshot = () => {
    let busy = 0;
    let idle = 0;
    let queued = 0;

    for (const pool of [currentPool, ...retiringPools]) {
      if (!pool) {
        continue;
      }

      for (const slot of pool.slots) {
        if (slot.task) {
          busy += 1;
        } else {
          idle += 1;
        }
      }

      queued += pool.queue.length;
    }

    return {
      size: currentPool?.size ?? 0,
      busy,
      idle,
      queued,
      completedTasks: totals.completedTasks,
      failedTasks: totals.failedTasks,
      restartedWorkers: totals.restartedWorkers,
    };
  };

  /** Terminates every worker. Tasks still waiting or running fail with stoppedError(); the next task starts a new pool. */
  const stop = async () => {
    const pools = [currentPool, ...retiringPools].filter(Boolean);
    const terminations = [];

    currentPool = null;
    retiringPools.clear();

    for (const pool of pools) {
      pool.retired = true;

      for (const task of pool.queue.splice(0)) {
        failTask(task, stoppedError());
      }

      for (const slot of [...pool.slots]) {
        const { task } = slot;

        slot.task = null;
        terminations.push(terminateSlot(slot));

        if (task) {
          failTask(task, stoppedError());
        }
      }
    }

    await Promise.all(terminations);
  };

  /** stop(), and the totals back to 0 (tests). */
  const reset = async () => {
    await stop();
    totals.completedTasks = 0;
    totals.failedTasks = 0;
    totals.restartedWorkers = 0;
  };

  return { reset, run, snapshot, stop };
};

const BUILT_IN_ERRORS = Object.freeze({
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
});

/**
 * A worker's serialized error as the in-process call would have thrown it:
 * the same name and message, the built-in class when the name is one, code
 * and status when it had them.
 */
export const restoreSerializedError = ({ name, message, code, status } = {}) => {
  const Constructor = Object.hasOwn(BUILT_IN_ERRORS, name) ? BUILT_IN_ERRORS[name] : Error;
  const error = new Constructor(String(message ?? ""));

  if (typeof name === "string" && name && error.name !== name) {
    error.name = name;
  }

  if (code !== undefined) {
    error.code = code;
  }

  if (status !== undefined) {
    error.status = status;
  }

  return error;
};

/** An error as a worker answers it: name, message, and code and status when they are strings or numbers. */
export const serializeTaskError = (error) => {
  const serialized = {
    name: typeof error?.name === "string" ? error.name : "Error",
    message: typeof error?.message === "string" ? error.message : String(error),
  };

  for (const key of ["code", "status"]) {
    if (typeof error?.[key] === "string" || typeof error?.[key] === "number") {
      serialized[key] = error[key];
    }
  }

  return serialized;
};

const exhaustHeap = () => {
  const retained = [];

  for (;;) {
    retained.push(new Array(1_000_000).fill(retained.length));
  }
};

/**
 * Failure modes a pool must survive, run inside a worker before its task when
 * the task carries a testHook (tests only; nothing in the application sets
 * one): "exit", "uncaught", "hang", "out_of_memory".
 */
export const runWorkerTestHook = async (hook, label) => {
  switch (hook) {
    case "exit":
      process.exit(3);
      break;
    case "uncaught":
      setImmediate(() => {
        throw new Error(`${label} test hook: uncaught error.`);
      });
      await new Promise(() => {});
      break;
    case "hang":
      await new Promise(() => {});
      break;
    case "out_of_memory":
      exhaustHeap();
      break;
    default:
      break;
  }
};
