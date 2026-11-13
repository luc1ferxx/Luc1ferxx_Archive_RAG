// A pool of worker_threads that run pdf.js (PDF_PARSE_WORKERS > 0).
//
// pdf.js parses in the thread that calls it, and a large PDF holds that
// thread for seconds: in the API process every request waits behind it. The
// pool moves the parsing onto workers, each with its own pdf.js, and
// rag/pdfjs-document.js splits a document into page ranges the workers parse
// at once. A task is one page range: { data, options } in, the
// extractPdfPageRange result out (pdf-parse-worker.js). The scheduling is
// rag/worker-task-pool.js, shared with the Office parse pool.
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

import {
  getPdfParseTimeoutMs,
  getPdfParseWorkerMaxOldGenerationMb,
  getPdfParseWorkers,
} from "./config.js";
import { createWorkerTaskPool, restoreSerializedError } from "./worker-task-pool.js";

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

const pool = createWorkerTaskPool({
  // Each task posts its own copy of the bytes, transferred to the worker.
  buildMessage: ({ payload: { data, options, testHook } }) => {
    const bytes = new Uint8Array(data);

    return { message: { data: bytes, options, testHook }, transfer: [bytes.buffer] };
  },
  cancelledError: () =>
    new PdfParsePoolError("The PDF parse task was cancelled before it started.", {
      code: PDF_PARSE_TASK_CANCELLED,
      status: 499,
    }),
  getMaxOldGenerationMb: getPdfParseWorkerMaxOldGenerationMb,
  getTimeoutMs: getPdfParseTimeoutMs,
  memoryLimitSetting: "PDF_PARSE_WORKER_MAX_OLD_GENERATION_MB",
  stoppedError: () =>
    new PdfParsePoolError("The PDF parse pool was stopped.", { code: PDF_PARSE_POOL_STOPPED, status: 503 }),
  timeoutError: (timeoutMs) =>
    new PdfParsePoolError(`The PDF parse worker did not finish its page range within ${timeoutMs} ms.`, {
      code: PDF_PARSE_TIMEOUT,
      status: 504,
    }),
  // The worker's error as the in-process parse would have thrown it: the same
  // name and message, the built-in class when the name is one (a TypeError for
  // a bad maxPages), code and status when it had them.
  toTaskError: restoreSerializedError,
  workerLostError: (cause, exitCode) =>
    new PdfParsePoolError(
      `The PDF parse worker stopped before it finished its page range${
        cause?.code ? ` (${cause.code})` : Number.isInteger(exitCode) ? ` (exit code ${exitCode})` : ""
      }.`,
      { cause: cause ?? undefined, code: PDF_PARSE_WORKER_FAILED, status: 500 }
    ),
  workerUrl: WORKER_URL,
});

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

  return pool.run({ data, options, testHook }, { signal, size });
};

/**
 * { size, busy, idle, queued, completedTasks, failedTasks, restartedWorkers }:
 * the current pool's size (0 before the first task), workers running a task
 * or waiting for one and tasks waiting for a worker over the current pool and
 * any pool still finishing after a size change, and process-wide totals
 * (failedTasks counts every task that failed, a parse error included;
 * restartedWorkers every worker lost to a crash, an exit or a timeout).
 */
export const getPdfParsePoolSnapshot = () => pool.snapshot();

/**
 * Terminates every worker. Tasks still waiting or running fail with
 * PDF_PARSE_POOL_STOPPED; the next task starts a new pool.
 */
export const stopPdfParsePool = () => pool.stop();

/** stopPdfParsePool, and the totals back to 0 (tests). */
export const resetPdfParsePool = () => pool.reset();
