import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultServerDirectory = path.join(__dirname, "..");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_FORCE_KILL_AFTER_MS = 5 * 1000;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024;

export const QUALITY_CORPUS_IDS = Object.freeze({
  compareHard: "compare-hard",
  default: "default",
  nearDuplicate: "near-duplicate",
  rerankHardCs: "rerank-hard-cs",
  chunking: "chunking",
});

const qualityCorpusPathById = Object.freeze(
  Object.assign(Object.create(null), {
    [QUALITY_CORPUS_IDS.default]: "evaluation/synthetic-corpus.json",
    [QUALITY_CORPUS_IDS.nearDuplicate]:
      "evaluation/synthetic-corpus-near-duplicate.json",
    [QUALITY_CORPUS_IDS.compareHard]:
      "evaluation/synthetic-corpus-compare-hard.json",
    [QUALITY_CORPUS_IDS.rerankHardCs]:
      "evaluation/synthetic-corpus-rerank-hard-cs.json",
    [QUALITY_CORPUS_IDS.chunking]:
      "evaluation/synthetic-corpus-chunking.json",
  })
);

const createRunnerError = ({
  cause,
  code,
  expose = false,
  message,
  status,
} = {}) => {
  const error = new Error(message, cause ? { cause } : undefined);

  error.code = code;
  error.expose = expose;
  error.status = status;
  return error;
};

const normalizeRunnerRequest = (request) =>
  request && typeof request === "object" && !Array.isArray(request)
    ? request
    : {};

const resolveQualityCorpus = (request = {}) => {
  const normalizedRequest = normalizeRunnerRequest(request);

  if (Object.prototype.hasOwnProperty.call(normalizedRequest, "corpusPath")) {
    throw createRunnerError({
      code: "QUALITY_CORPUS_PATH_FORBIDDEN",
      expose: true,
      message:
        "corpusPath is not supported. Select a registered corpusId instead.",
      status: 400,
    });
  }

  const hasCorpusId = Object.prototype.hasOwnProperty.call(
    normalizedRequest,
    "corpusId"
  );
  const corpusId = hasCorpusId
    ? typeof normalizedRequest.corpusId === "string"
      ? normalizedRequest.corpusId.trim()
      : ""
    : QUALITY_CORPUS_IDS.default;
  const corpusPath = qualityCorpusPathById[corpusId];

  if (!corpusPath) {
    throw createRunnerError({
      code: "QUALITY_CORPUS_UNKNOWN",
      expose: true,
      message: "Unknown quality corpusId.",
      status: 400,
    });
  }

  return {
    corpusId,
    corpusPath,
  };
};

const appendStderrTail = ({ chunk, maxBytes, tail }) => {
  const chunkBuffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), "utf8");

  if (chunkBuffer.length >= maxBytes) {
    return chunkBuffer.subarray(chunkBuffer.length - maxBytes);
  }

  const bytesToKeep = Math.max(0, maxBytes - chunkBuffer.length);
  const retainedTail =
    tail.length > bytesToKeep
      ? tail.subarray(tail.length - bytesToKeep)
      : tail;

  return Buffer.concat([retainedTail, chunkBuffer]);
};

const tryKill = (child, signal) => {
  try {
    child.kill(signal);
  } catch {
    // The close/error handlers retain ownership of the active slot.
  }
};

export const createSyntheticQualityEvaluationRunner = ({
  clearTimer = clearTimeout,
  environment = process.env,
  forceKillAfterMs = DEFAULT_FORCE_KILL_AFTER_MS,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  readLatestReport,
  runtimePath = process.execPath,
  serverDirectory = defaultServerDirectory,
  setTimer = setTimeout,
  spawnProcess = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  if (typeof readLatestReport !== "function") {
    throw new TypeError("readLatestReport must be a function.");
  }

  let activeRun = null;

  return async (request = {}) => {
    const corpus = resolveQualityCorpus(request);

    if (activeRun) {
      throw createRunnerError({
        code: "QUALITY_EVALUATION_IN_PROGRESS",
        expose: true,
        message: "A synthetic quality evaluation is already running.",
        status: 409,
      });
    }

    const runToken = Symbol(corpus.corpusId);
    activeRun = runToken;

    return new Promise((resolve, reject) => {
      let child;
      let closeHandled = false;
      let forceKillTimer = null;
      let processErrorHandled = false;
      let responseSettled = false;
      let stderrTail = Buffer.alloc(0);
      let timeoutTimer = null;

      const settleResponse = ({ error, value } = {}) => {
        if (responseSettled) {
          return;
        }

        responseSettled = true;

        if (error) {
          reject(error);
          return;
        }

        resolve(value);
      };

      const clearRunTimers = () => {
        if (timeoutTimer) {
          clearTimer(timeoutTimer);
          timeoutTimer = null;
        }
        if (forceKillTimer) {
          clearTimer(forceKillTimer);
          forceKillTimer = null;
        }
      };

      const releaseActiveRun = () => {
        clearRunTimers();

        if (activeRun === runToken) {
          activeRun = null;
        }
      };

      const handleClose = async (code) => {
        if (closeHandled) {
          return;
        }

        closeHandled = true;

        if (responseSettled) {
          releaseActiveRun();
          return;
        }

        if (code !== 0) {
          const stderr = stderrTail.toString("utf8");
          const suffix = stderr ? `: ${stderr}` : "";

          releaseActiveRun();
          settleResponse({
            error: createRunnerError({
              code: "QUALITY_EVALUATION_FAILED",
              message: `Synthetic evaluation failed with exit code ${code}${suffix}`,
              status: 500,
            }),
          });
          return;
        }

        try {
          const report = await readLatestReport();

          releaseActiveRun();
          settleResponse({
            value: report,
          });
        } catch (error) {
          releaseActiveRun();
          settleResponse({
            error,
          });
        }
      };

      try {
        child = spawnProcess(
          runtimePath,
          [
            "--max-old-space-size=512",
            "evaluation/run-synthetic-eval.mjs",
            corpus.corpusPath,
            "--openai-provider",
            "deterministic",
          ],
          {
            cwd: serverDirectory,
            env: environment,
            shell: false,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
          }
        );
      } catch (error) {
        releaseActiveRun();
        settleResponse({
          error: createRunnerError({
            cause: error,
            code: "QUALITY_EVALUATION_SPAWN_FAILED",
            message: "Failed to start synthetic quality evaluation.",
            status: 500,
          }),
        });
        return;
      }

      child.stderr?.on("data", (chunk) => {
        stderrTail = appendStderrTail({
          chunk,
          maxBytes: maxStderrBytes,
          tail: stderrTail,
        });
      });

      child.on("error", (error) => {
        if (processErrorHandled) {
          return;
        }

        processErrorHandled = true;
        settleResponse({
          error: createRunnerError({
            cause: error,
            code: "QUALITY_EVALUATION_PROCESS_ERROR",
            message: "Synthetic quality evaluation process failed.",
            status: 500,
          }),
        });

        if (!child.pid) {
          releaseActiveRun();
        }
      });
      child.once("close", handleClose);

      timeoutTimer = setTimer(() => {
        settleResponse({
          error: createRunnerError({
            code: "QUALITY_EVALUATION_TIMEOUT",
            expose: true,
            message: "Synthetic quality evaluation timed out.",
            status: 504,
          }),
        });

        if (closeHandled) {
          releaseActiveRun();
          return;
        }

        tryKill(child, "SIGTERM");
        forceKillTimer = setTimer(() => {
          if (!closeHandled && activeRun === runToken) {
            tryKill(child, "SIGKILL");
          }
        }, forceKillAfterMs);
        forceKillTimer?.unref?.();
      }, timeoutMs);
      timeoutTimer?.unref?.();
    });
  };
};
