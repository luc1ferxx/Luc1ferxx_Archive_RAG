// One worker of the Office parse pool (office-parse-pool.js). For each task
// the pool posts, { id, data, formats }, it runs parseDocumentBytes on the
// bytes and answers { id, result } or { id, error }: the error's name,
// message, code and status, whether it is a DocumentFormatError, and its
// cause's name and message, which the pool turns back into the error the
// calling thread would have thrown. Nothing here loads pdf.js.
import { parentPort } from "node:worker_threads";
import { isDocumentFormatError } from "./document-format-errors.js";
import { parseDocumentBytes } from "./office/office-document-pages.js";
import { runWorkerTestHook, serializeTaskError } from "./worker-task-pool.js";

const serializeError = (error) => {
  const serialized = serializeTaskError(error);

  if (isDocumentFormatError(error)) {
    serialized.documentFormatError = true;

    // A library's own error a refusal keeps (createArchiveInvalidError); it
    // may quote the file, so it stays a cause and never becomes the message.
    if (error.cause !== undefined) {
      serialized.cause = serializeTaskError(error.cause);
    }
  }

  return serialized;
};

/** The answer to one task message; never throws. */
export const runOfficeParseWorkerTask = async ({ id, data, formats, testHook } = {}) => {
  try {
    // Failure modes the pool must survive, reachable only through
    // runOfficeParseTask's testHook (test/office-parse-pool.test.mjs);
    // nothing in the application sets one.
    if (testHook) {
      await runWorkerTestHook(testHook, "Office parse worker");
    }

    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    return { id, result: await parseDocumentBytes(bytes, { formats }) };
  } catch (error) {
    return { id, error: serializeError(error) };
  }
};

// Imported outside a worker (a test), the module only defines the handler.
parentPort?.on("message", async (message) => {
  parentPort.postMessage(await runOfficeParseWorkerTask(message));
});
