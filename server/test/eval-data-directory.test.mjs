import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { useEvaluationDataDirectory } from "../evaluation/eval-data-directory.mjs";
import { getRagDataDirectory } from "../rag/storage.js";

const evaluationDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "evaluation");

test("the evaluation data directory takes even after storage resolved its own", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-data-directory-"));
  const saved = process.env.RAG_DATA_DIRECTORY;

  t.after(async () => {
    if (saved === undefined) {
      delete process.env.RAG_DATA_DIRECTORY;
    } else {
      process.env.RAG_DATA_DIRECTORY = saved;
    }

    await rm(directory, { force: true, recursive: true });
  });

  // storage.js was imported above, before any directory was chosen.
  assert.notEqual(getRagDataDirectory(), path.join(directory, "rag-data"));
  assert.equal(useEvaluationDataDirectory(path.join(directory, "rag-data")), path.join(directory, "rag-data"));
  assert.equal(getRagDataDirectory(), path.join(directory, "rag-data"));
  assert.equal(process.env.RAG_DATA_DIRECTORY, path.join(directory, "rag-data"));
});

test("no evaluation runner points the data directory through the environment alone", async () => {
  const offenders = [];

  for (const name of await readdir(evaluationDirectory)) {
    if (!/\.(m?js)$/.test(name) || name === "eval-data-directory.mjs") {
      continue;
    }

    const source = await readFile(path.join(evaluationDirectory, name), "utf8");

    if (/process\.env\.RAG_DATA_DIRECTORY\s*=(?!=)/.test(source)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, [], "use useEvaluationDataDirectory (evaluation/eval-data-directory.mjs)");
});
