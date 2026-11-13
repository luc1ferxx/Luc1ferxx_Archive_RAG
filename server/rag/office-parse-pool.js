// A pool of worker_threads that parse Word, PowerPoint and Excel files
// (RAG_OFFICE_PARSE_WORKERS, 1 by default; 0 parses in the calling thread).
//
// mammoth, SheetJS and the PPTX reader parse in the thread that calls them: a
// large document held the event loop for as long as it took, and a parse that
// ran out of memory took the whole process down with it. A task here is one
// document: the archive guard and its reader run on a worker
// (office-parse-worker.js, the same parseDocumentBytes the calling thread
// would run), so the event loop stays free, and the worker's own heap, capped
// by RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB, is what a hostile file
// exhausts. The scheduling is rag/worker-task-pool.js, shared with the pdf.js
// pool.
//
//   - The caller reads and decrypts the file (the working-file key lives in
//     the calling thread) and hands the plaintext over; each task posts its
//     own copy, transferred, so the caller's buffer is never touched.
//   - Workers share the process's environment (SHARE_ENV), so they read the
//     same RAG_OFFICE_* and RAG_XLSX_MAX_CELLS values at the same moment the
//     calling thread would, a value changed at run time included.
//   - A refusal comes back as the DocumentFormatError it was (status, code,
//     message, its cause's name and message), any other error with its name,
//     message, code and status, as rag/worker-task-pool.js restores them.
//   - A worker that runs out of memory fails the document with 413
//     DOCUMENT_ARCHIVE_TOO_LARGE: one task runs on a worker at a time, so the
//     document is what needed the memory, and parsing it again would only run
//     out again. A worker that exits or crashes otherwise fails its task with
//     OFFICE_PARSE_WORKER_FAILED (500); a task over RAG_OFFICE_PARSE_TIMEOUT_MS
//     terminates its worker and fails with OFFICE_PARSE_TIMEOUT (504). The
//     async ingest queue retries both; it fails a 413 at once.
//
// The worker is a file next to this one: a single-file executable bundle has
// no such file, so a bundled build sets RAG_OFFICE_PARSE_WORKERS=0.

import { SHARE_ENV } from "node:worker_threads";
import {
  getOfficeParseTimeoutMs,
  getOfficeParseWorkerMaxOldGenerationMb,
  getOfficeParseWorkers,
} from "./config.js";
import { DocumentFormatError, createArchiveTooLargeError } from "./document-format-errors.js";
import { createWorkerTaskPool, restoreSerializedError } from "./worker-task-pool.js";

const WORKER_URL = new URL("./office-parse-worker.js", import.meta.url);

export const OFFICE_PARSE_WORKER_FAILED = "OFFICE_PARSE_WORKER_FAILED";
export const OFFICE_PARSE_TIMEOUT = "OFFICE_PARSE_TIMEOUT";
export const OFFICE_PARSE_POOL_STOPPED = "OFFICE_PARSE_POOL_STOPPED";
export const OFFICE_PARSE_TASK_CANCELLED = "OFFICE_PARSE_TASK_CANCELLED";

export class OfficeParsePoolError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "OfficeParsePoolError";
    this.code = code;
    this.status = status;
  }
}

// The refusal the worker threw, as the calling thread would have thrown it.
const toTaskError = (serialized = {}) => {
  if (!serialized.documentFormatError) {
    return restoreSerializedError(serialized);
  }

  return new DocumentFormatError(String(serialized.message ?? ""), {
    cause: serialized.cause ? restoreSerializedError(serialized.cause) : undefined,
    code: serialized.code ?? null,
    status: serialized.status,
  });
};

const pool = createWorkerTaskPool({
  buildMessage: ({ payload: { bytes, formats, testHook } }) => {
    const data = new Uint8Array(bytes);

    return { message: { data, formats, testHook }, transfer: [data.buffer] };
  },
  cancelledError: () =>
    new OfficeParsePoolError("The Office parse task was cancelled before it started.", {
      code: OFFICE_PARSE_TASK_CANCELLED,
      status: 499,
    }),
  getMaxOldGenerationMb: getOfficeParseWorkerMaxOldGenerationMb,
  getTimeoutMs: getOfficeParseTimeoutMs,
  memoryLimitSetting: "RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB",
  stoppedError: () =>
    new OfficeParsePoolError("The Office parse pool was stopped.", { code: OFFICE_PARSE_POOL_STOPPED, status: 503 }),
  timeoutError: (timeoutMs) =>
    new OfficeParsePoolError(`The Office parse worker did not finish the document within ${timeoutMs} ms.`, {
      code: OFFICE_PARSE_TIMEOUT,
      status: 504,
    }),
  toTaskError,
  workerLostError: (cause, exitCode) => {
    if (cause?.code === "ERR_WORKER_OUT_OF_MEMORY") {
      return createArchiveTooLargeError(
        "parsing it needs more memory than an Office parse worker may use (RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB)"
      );
    }

    return new OfficeParsePoolError(
      `The Office parse worker stopped before it finished the document${
        cause?.code ? ` (${cause.code})` : Number.isInteger(exitCode) ? ` (exit code ${exitCode})` : ""
      }.`,
      { cause: cause ?? undefined, code: OFFICE_PARSE_WORKER_FAILED, status: 500 }
    );
  },
  workerOptions: { env: SHARE_ENV },
  workerUrl: WORKER_URL,
});

/**
 * parseDocumentBytes(bytes, { formats }) (rag/office/office-document-pages.js)
 * on a worker of a pool of `size` (default RAG_OFFICE_PARSE_WORKERS): the
 * document's { format, mimeType, pages, parse }, or { format: "pdf", mimeType }
 * for a PDF. `signal` drops the task while it still waits in the queue
 * (OFFICE_PARSE_TASK_CANCELLED); a task already running finishes. `testHook`
 * makes the worker fail on purpose (tests only).
 */
export const runOfficeParseTask = (bytes, { formats } = {}, { signal, size = getOfficeParseWorkers(), testHook } = {}) => {
  if (!Number.isInteger(size) || size < 1) {
    return Promise.reject(new TypeError("The Office parse pool size must be a positive integer."));
  }

  return pool.run({ bytes, formats, testHook }, { signal, size });
};

/**
 * { size, busy, idle, queued, completedTasks, failedTasks, restartedWorkers },
 * as rag/worker-task-pool.js counts them (failedTasks includes a refused
 * document; restartedWorkers every worker lost to a crash, an exit, running
 * out of memory or a timeout).
 */
export const getOfficeParsePoolSnapshot = () => pool.snapshot();

/**
 * Terminates every worker. Tasks still waiting or running fail with
 * OFFICE_PARSE_POOL_STOPPED (503); the next task starts a new pool.
 */
export const stopOfficeParsePool = () => pool.stop();

/** stopOfficeParsePool, and the totals back to 0 (tests). */
export const resetOfficeParsePool = () => pool.reset();
