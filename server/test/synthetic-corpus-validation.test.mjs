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
  id: "synthetic-corpus-test",
  version: "1",
  cases: [],
  documents: [
    {
      fileName,
      key: "policy",
      pages: ["Policy text."],
    },
  ],
});

test("synthetic corpus validation requires immutable corpus identity", () => {
  for (const field of ["id", "version"]) {
    const corpus = createCorpus("policy.pdf");

    delete corpus[field];
    assert.throws(
      () => validateSyntheticCorpus(corpus),
      new RegExp(`root\\.${field}`)
    );
  }
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

test("synthetic corpus validation rejects duplicate deterministic document keys", () => {
  const corpus = createCorpus("policy.pdf");

  corpus.documents.push({
    fileName: "policy-copy.pdf",
    key: "policy",
    pages: ["Duplicate identity."],
  });

  assert.throws(
    () => validateSyntheticCorpus(corpus),
    /documents\[1\]\.key/u
  );
});

test("synthetic corpus validation rejects unknown comparison expectations", () => {
  const corpus = createCorpus("policy.pdf");

  corpus.cases.push({
    compareExpectation: "probably_the_same",
    docKeys: ["policy", "policy-copy"],
    id: "compare-policy",
    question: "Compare the policies.",
    shouldAbstain: false,
    type: "compare",
  });

  assert.throws(
    () => validateSyntheticCorpus(corpus),
    /cases\[0\]\.compareExpectation/
  );
});

test("synthetic corpus validation requires complete and consistent comparison expectations", () => {
  const missingExpectation = createCorpus("policy.pdf");

  missingExpectation.id = "synthetic-corpus-compare-hard";
  missingExpectation.cases.push({
    docKeys: ["policy", "policy-copy"],
    id: "compare-policy",
    question: "Compare the policies.",
    shouldAbstain: false,
    type: "compare",
  });
  assert.throws(
    () => validateSyntheticCorpus(missingExpectation),
    /compareExpectation is required/
  );

  for (const [compareExpectation, shouldAbstain] of [
    ["abstain", false],
    ["difference", true],
  ]) {
    const inconsistent = createCorpus("policy.pdf");

    inconsistent.cases.push({
      compareExpectation,
      docKeys: ["policy", "policy-copy"],
      id: "compare-policy",
      question: "Compare the policies.",
      shouldAbstain,
      type: "compare",
    });
    assert.throws(
      () => validateSyntheticCorpus(inconsistent),
      /compareExpectation must agree with shouldAbstain/
    );
  }

  const nonComparison = createCorpus("policy.pdf");

  nonComparison.cases.push({
    compareExpectation: "difference",
    docKeys: ["policy"],
    id: "qa-policy",
    question: "Summarize the policy.",
    shouldAbstain: false,
    type: "qa",
  });
  assert.throws(
    () => validateSyntheticCorpus(nonComparison),
    /only valid when type is compare/
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
