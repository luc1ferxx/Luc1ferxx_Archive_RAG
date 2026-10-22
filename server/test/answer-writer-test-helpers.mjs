// Shared by the answer-writer suites (comparison-structured-output,
// qa-extractive-output): each test runs in its own RAG data directory with
// the suite's environment variables cleared, and the model is a stand-in that
// answers scripted replies. Not a test suite.
import { afterEach, beforeEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";

/**
 * Registers beforeEach/afterEach hooks: a fresh temp data directory per test,
 * `keys` deleted from the environment and `set` applied, everything restored
 * after the test and the stand-in model reset.
 */
export const useIsolatedAnswerWriterEnvironment = ({ keys, prefix, set = {} }) => {
  const originalDataDirectory = getRagDataDirectory();
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let tempRoot = null;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
    configureRagDataDirectory(path.join(tempRoot, "rag-data"));

    for (const key of keys) {
      delete process.env[key];
    }

    Object.assign(process.env, set);
  });

  afterEach(async () => {
    resetOpenAIProvider();
    configureRagDataDirectory(originalDataDirectory);

    for (const key of keys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }

    await rm(tempRoot, { recursive: true, force: true });
  });
};

/**
 * A stand-in model answering one reply per call, the last one repeated; an
 * object is sent as JSON. Returns the calls it received ({ options, prompt }).
 */
export const stubModelReplies = (replies) => {
  const queue = [...replies];
  const calls = [];

  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map(() => [1]),
    embedQuery: async () => [1],
    completeText: async (prompt, options) => {
      calls.push({ options, prompt });
      const reply = queue.length > 1 ? queue.shift() : queue[0];

      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
  });

  return calls;
};
