import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { robustEvalSuite } from "../evaluation/eval-suite.js";
import { verifyPinnedCorpus } from "../evaluation/pinned-corpus-validation.js";

const serverDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const arxivReport = robustEvalSuite.reports.find(
  (report) => report.id === "arxiv-real-paper-rerank"
);
const pinnedCorpusPath = path.resolve(
  serverDirectory,
  arxivReport.corpusPath
);

test("checked-in arXiv corpus matches its pinned content and identity", async () => {
  const verification = await verifyPinnedCorpus({
    expected: arxivReport.corpusIntegrity,
    filePath: pinnedCorpusPath,
  });

  assert.deepEqual(verification, arxivReport.corpusIntegrity);
});

test("checked-in arXiv corpus contains no host-specific absolute paths", async () => {
  const corpus = JSON.parse(await readFile(pinnedCorpusPath, "utf8"));
  const persistedPaths = [
    corpus.metadata?.casesSource,
    ...(corpus.buildReport?.documents ?? []).map(
      (document) => document.pdfPath
    ),
  ].filter(Boolean);

  assert.equal(persistedPaths.length, 9);
  for (const persistedPath of persistedPaths) {
    assert.equal(path.isAbsolute(persistedPath), false, persistedPath);
    assert.equal(path.win32.isAbsolute(persistedPath), false, persistedPath);
  }
});

test("pinned corpus verification rejects one-byte content drift", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "archive-rag-pinned-corpus-")
  );
  const filePath = path.join(directory, "tampered.json");

  try {
    const content = await readFile(pinnedCorpusPath);
    const tampered = Buffer.concat([content, Buffer.from(" ")]);
    await writeFile(filePath, tampered);

    await assert.rejects(
      verifyPinnedCorpus({
        expected: arxivReport.corpusIntegrity,
        filePath,
      }),
      /Pinned corpus content hash mismatch/
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("pinned corpus verification rejects a mismatched manifest identity", async () => {
  await assert.rejects(
    verifyPinnedCorpus({
      expected: {
        ...arxivReport.corpusIntegrity,
        id: "different-corpus",
      },
      filePath: pinnedCorpusPath,
    }),
    /Pinned corpus identity mismatch/
  );
});
