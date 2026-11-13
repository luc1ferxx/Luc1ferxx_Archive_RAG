// One worker of the pdf.js parse pool (pdf-parse-pool.js). It runs
// extractPdfPageRange for each task the pool posts, { id, data, options }, and
// answers { id, result } or { id, error } with the error's name, message,
// code and status only, which the pool turns back into an Error.

// Must stay above every import that reaches pdfjs: it installs globals that
// pdfjs reads while evaluating its own module body, and a worker evaluates its
// modules from scratch. See the file itself, and the import order in
// pdf-loader.js.
import "./pdf-runtime-shim.js";
import { parentPort } from "node:worker_threads";
import { extractPdfPageRange } from "./pdf-page-extraction.js";
import { runWorkerTestHook, serializeTaskError } from "./worker-task-pool.js";

/** The answer to one task message; never throws. */
export const runPdfParseWorkerTask = async ({ id, data, options, testHook } = {}) => {
  try {
    // Failure modes the pool must survive, reachable only through
    // runPdfParseTask's testHook (test/pdf-parse-pool.test.mjs); nothing in
    // the application sets one.
    if (testHook) {
      await runWorkerTestHook(testHook, "PDF parse worker");
    }

    return { id, result: await extractPdfPageRange(data, options) };
  } catch (error) {
    return { id, error: serializeTaskError(error) };
  }
};

// Imported outside a worker (a test), the module only defines the handler.
parentPort?.on("message", async (message) => {
  parentPort.postMessage(await runPdfParseWorkerTask(message));
});
