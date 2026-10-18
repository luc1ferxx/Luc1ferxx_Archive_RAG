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

const serializeError = (error) => {
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

// Failure modes the pool must survive, reachable only through
// runPdfParseTask's testHook (test/pdf-parse-pool.test.mjs); nothing in the
// application sets one.
const runTestHook = async (hook) => {
  switch (hook) {
    case "exit":
      process.exit(3);
      break;
    case "uncaught":
      setImmediate(() => {
        throw new Error("PDF parse worker test hook: uncaught error.");
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

/** The answer to one task message; never throws. */
export const runPdfParseWorkerTask = async ({ id, data, options, testHook } = {}) => {
  try {
    if (testHook) {
      await runTestHook(testHook);
    }

    return { id, result: await extractPdfPageRange(data, options) };
  } catch (error) {
    return { id, error: serializeError(error) };
  }
};

// Imported outside a worker (a test), the module only defines the handler.
parentPort?.on("message", async (message) => {
  parentPort.postMessage(await runPdfParseWorkerTask(message));
});
