import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateSyntheticCorpus,
} from "../evaluation/synthetic-corpus-validation.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const evaluationDirectory = path.join(testDirectory, "..", "evaluation");

const createCorpus = (fileName) => ({
  cases: [],
  documents: [
    {
      fileName,
      key: "policy",
      pages: ["Policy text."],
    },
  ],
});

test("synthetic corpus validation preserves safe PDF basenames", () => {
  const safeFileNames = [
    "policy handbook-2026.pdf",
    "政策 手册.pdf",
    `${"a".repeat(251)}.pdf`,
  ];

  for (const fileName of safeFileNames) {
    const corpus = createCorpus(fileName);

    assert.equal(validateSyntheticCorpus(corpus), corpus);
  }
});

test("synthetic corpus validation rejects document paths and platform aliases", () => {
  const unsafeFileNames = [
    "../../../results/latest.json",
    "..\\..\\results\\latest.pdf",
    "/tmp/report.pdf",
    "report.pdf:alternate",
    "NUL.pdf",
    "report.pdf ",
    "report\0.pdf",
  ];

  for (const fileName of unsafeFileNames) {
    assert.throws(
      () => validateSyntheticCorpus(createCorpus(fileName)),
      /documents\[0\]\.fileName/
    );
  }
});

test("synthetic corpus validation rejects duplicate destination names", () => {
  const corpus = createCorpus("policy.pdf");

  corpus.documents.push({
    fileName: "POLICY.pdf",
    key: "policy-copy",
    pages: ["Duplicate destination."],
  });

  assert.throws(
    () => validateSyntheticCorpus(corpus),
    /documents\[1\]\.fileName/
  );
});

test("synthetic corpus validation accepts every tracked synthetic corpus", async () => {
  const fileNames = (await readdir(evaluationDirectory)).filter(
    (fileName) =>
      fileName.startsWith("synthetic-corpus") && fileName.endsWith(".json")
  );

  assert.ok(fileNames.length > 0);

  for (const fileName of fileNames) {
    const corpus = JSON.parse(
      await readFile(path.join(evaluationDirectory, fileName), "utf8")
    );

    assert.equal(validateSyntheticCorpus(corpus), corpus, fileName);
  }
});
