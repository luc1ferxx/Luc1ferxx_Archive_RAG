#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
// Preloaded into every test file's process; see the file for why.
const keepEventLoopAliveUrl = pathToFileURL(
  path.join(__dirname, "keep-event-loop-alive.mjs")
).href;

const collectTestFiles = async () => {
  const entries = await readdir(__dirname, {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => fileName.endsWith(".test.mjs") && fileName !== "run.test.mjs")
    .sort()
    .map((fileName) => path.join("test", fileName));
};

const runTests = async (testFiles) =>
  new Promise((resolve) => {
    // Each test file runs in its own child process (node --test default
    // isolation), so per-process state (process.env, globalThis.fetch,
    // module singletons) never leaks across files even when they run
    // concurrently. node --test passes --import on to each of them.
    const child = spawn(process.execPath, ["--import", keepEventLoopAliveUrl, "--test", ...testFiles], {
      cwd: serverDirectory,
      env: process.env,
      stdio: "inherit",
    });

    child.on("close", (exitCode) => {
      resolve(exitCode ?? 1);
    });
  });

const testFiles = await collectTestFiles();
process.exitCode = await runTests(testFiles);
