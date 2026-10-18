// A pool of worker_threads that run pdf.js (PDF_PARSE_WORKERS > 0).
//
// pdf.js parses in the thread that calls it, and a large PDF holds that
// thread for seconds: in the API process every request waits behind it. The
// pool moves the parsing onto workers, each with its own pdf.js, and
// rag/pdfjs-document.js splits a document into page ranges the workers parse
// at once. A task is one page range: { data, options } in, the
// extractPdfPageRange result out (pdf-parse-worker.js).
//
//   - Created on first use with the size the caller passes (the configured
//     PDF_PARSE_WORKERS); workers are spawned as tasks need them, up to that
//     size. When the size or PDF_PARSE_WORKER_MAX_OLD_GENERATION_MB changes,
//     the next task gets a new pool and the old one finishes the tasks it
//     holds, then terminates its workers, so for a moment both run.
//   - Tasks wait in FIFO order. A document never has more tasks in the pool
//     than it has workers (pdfjs-document.js queues its next range when one
//     of its own finishes), so a later document waits behind at most one
//     range per worker of each document ahead of it. A worker is ref()'d
//     while it runs a task and unref()'d while idle, so an idle pool never
//     keeps a process alive.
//   - Every task posts its own copy of the bytes (transferred, so the worker
//     owns it), made when the task starts, so a queue of a large document's
//     ranges holds the caller's buffer once and never touches it.
//   - An error the parse throws comes back with its name and message (and
//     code/status) and is thrown again here, so a malformed PDF fails as it
//     does in process. A worker that exits or crashes mid-task (out of memory
//     under its resourceLimits included) fails that task with
//     PDF_PARSE_WORKER_FAILED (500) and is replaced on the next task; a task
//     over PDF_PARSE_TIMEOUT_MS terminates its worker and fails with
//     PDF_PARSE_TIMEOUT (504).
//
// The worker is a file next to this one: a single-file executable bundle has
// no such file, so a bundled build keeps PDF_PARSE_WORKERS=0.

import { Worker } from "node:worker_threads";
import {
  getPdfParseTimeoutMs,
  getPdfParseWorkerMaxOldGenerationMb,
  getPdfParseWorkers,
} from "./config.js";

const WORKER_URL = new URL("./pdf-parse-worker.js", import.meta.url);

export const PDF_PARSE_WORKER_FAILED = "PDF_PARSE_WORKER_FAILED";
export const PDF_PARSE_TIMEOUT = "PDF_PARSE_TIMEOUT";
export const PDF_PARSE_POOL_STOPPED = "PDF_PARSE_POOL_STOPPED";
export const PDF_PARSE_TASK_CANCELLED = "PDF_PARSE_TASK_CANCELLED";

export class PdfParsePoolError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PdfParsePoolError";
    this.code = code;
    this.status = status;
  }
}

const BUILT_IN_ERRORS = Object.freeze({
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
});

// The worker's error as the in-process parse would have thrown it: the same
// name and message, the built-in class when the name is one (a TypeError for
// a bad maxPages), code and status when it had them.
const toTaskError = ({ name, message, code, status } = {}) => {
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

const workerFailedError = (cause, exitCode) =>
  new PdfParsePoolError(
    `The PDF parse worker stopped before it finished its page range${
      cause?.code ? ` (${cause.code})` : Number.isInteger(exitCode) ? ` (exit code ${exitCode})` : ""
    }.`,
    { cause: cause ?? undefined, code: PDF_PARSE_WORKER_FAILED, status: 500 }
  );

const stoppedError = () =>
  new PdfParsePoolError("The PDF parse pool was stopped.", { code: PDF_PARSE_POOL_STOPPED, status: 503 });

const cancelledError = () =>
  new PdfParsePoolError("The PDF parse task was cancelled before it started.", {
    code: PDF_PARSE_TASK_CANCELLED,
    status: 499,
  });

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
    failTask(task, workerFailedError(cause, exitCode));
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
  failTask(
    task,
    new PdfParsePoolError(`The PDF parse worker did not finish its page range within ${timeoutMs} ms.`, {
      code: PDF_PARSE_TIMEOUT,
      status: 504,
    })
  );
  dispatch(slot.pool);
};

const spawnSlot = (pool) => {
  const worker = new Worker(WORKER_URL, {
    // A worker inherits the parent's CLI options by default, and it needs
    // none of them: some break it (--input-type, which a worker refuses with
    // a file entry point) and others would only load more into every worker
    // (an --import preload).
    execArgv: [],
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

  const timeoutMs = getPdfParseTimeoutMs();

  if (timeoutMs > 0) {
    slot.timer = setTimeout(() => timeOutTask(slot, task, timeoutMs), timeoutMs);
  }

  try {
    const bytes = new Uint8Array(task.data);

    slot.worker.postMessage(
      { data: bytes, id: task.id, options: task.options, testHook: task.testHook },
      [bytes.buffer]
    );
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
        failTask(pool.queue.shift(), workerFailedError(error));
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
  const maxOldGenerationMb = getPdfParseWorkerMaxOldGenerationMb();

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
 * Runs extractPdfPageRange(data, options) on a worker of a pool of `size`
 * (default PDF_PARSE_WORKERS). `signal` drops the task while it still waits
 * in the queue (PDF_PARSE_TASK_CANCELLED); a task already running finishes.
 * `testHook` makes the worker fail on purpose (tests only).
 */
export const runPdfParseTask = (data, options = {}, { signal, size = getPdfParseWorkers(), testHook } = {}) => {
  if (!Number.isInteger(size) || size < 1) {
    return Promise.reject(new TypeError("The PDF parse pool size must be a positive integer."));
  }

  if (signal?.aborted) {
    return Promise.reject(cancelledError());
  }

  const pool = resolvePool(size);

  return new Promise((resolve, reject) => {
    const task = { data, id: nextTaskId, options, pool, reject, resolve, testHook };

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
 * or waiting for one and tasks waiting for a worker over the current pool and
 * any pool still finishing after a size change, and process-wide totals
 * (failedTasks counts every task that failed, a parse error included;
 * restartedWorkers every worker lost to a crash, an exit or a timeout).
 */
export const getPdfParsePoolSnapshot = () => {
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

/**
 * Terminates every worker. Tasks still waiting or running fail with
 * PDF_PARSE_POOL_STOPPED; the next task starts a new pool.
 */
export const stopPdfParsePool = async () => {
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

/** stopPdfParsePool, and the totals back to 0 (tests). */
export const resetPdfParsePool = async () => {
  await stopPdfParsePool();
  totals.completedTasks = 0;
  totals.failedTasks = 0;
  totals.restartedWorkers = 0;
};
