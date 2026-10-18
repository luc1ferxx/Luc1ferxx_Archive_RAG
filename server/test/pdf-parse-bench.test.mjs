import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  formatPdfParseBenchMarkdown,
  parsePdfParseBenchArguments,
  PARITY_CONFIGURATIONS,
  runPdfParseBench,
} from "../evaluation/run-pdf-parse-bench.mjs";
import { buildMixedPdf, buildProsePdf } from "./pdf-fixture-builder.mjs";

test("bench arguments: directories, pool sizes and repeats are checked", () => {
  const options = parsePdfParseBenchArguments(["--pdf-dir", "a", "--pdf-dir", "b", "--workers", "2, 3", "--repeat", "1"]);

  assert.deepEqual(options.pdfDirs, [path.resolve("a"), path.resolve("b")]);
  assert.deepEqual(options.workers, [2, 3]);
  assert.equal(options.repeat, 1);
  assert.throws(() => parsePdfParseBenchArguments([]), /--pdf-dir/);
  assert.throws(() => parsePdfParseBenchArguments(["--pdf-dir", "a", "--workers", "0"]), /--workers/);
  assert.throws(() => parsePdfParseBenchArguments(["--pdf-dir", "a", "--repeat", "x"]), /--repeat/);
  assert.throws(() => parsePdfParseBenchArguments(["--pdf-dir"]), /Unknown or incomplete/);
});

test("bench: the pool matches in-process, duplicates are dropped, and the report holds no page text", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pdf-parse-bench-"));

  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(path.join(directory, "mixed.pdf"), buildMixedPdf());
  await writeFile(path.join(directory, "prose.pdf"), buildProsePdf());
  await writeFile(path.join(directory, "prose-copy.pdf"), buildProsePdf());

  const report = await runPdfParseBench({ pdfDirs: [directory], repeat: 1, workers: [2] });

  assert.equal(report.corpus.documents, 2);
  assert.equal(report.parity.length, PARITY_CONFIGURATIONS.length * 2);
  assert.ok(report.parity.every((row) => row.differing.length === 0));
  assert.equal(report.timing.length, 3 * 2);
  assert.ok(report.timing.every((row) => row.runs.length === 1 && Number.isFinite(row.runs[0].ms)));
  assert.equal(
    Object.values(report.routing.totals).reduce((sum, count) => sum + count, 0),
    report.corpus.pages
  );

  const serialized = `${JSON.stringify(report)}\n${formatPdfParseBenchMarkdown(report)}`;

  assert.doesNotMatch(serialized, /Second page opens|First item of a list/);
});
