#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");

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
    const child = spawn(
      process.execPath,
      ["--test", "--test-concurrency=1", ...testFiles],
      {
        cwd: serverDirectory,
        env: process.env,
        stdio: "inherit",
      }
    );

    child.on("close", (exitCode) => {
      resolve(exitCode ?? 1);
    });
  });

const testFiles = await collectTestFiles();
process.exitCode = await runTests(testFiles);
