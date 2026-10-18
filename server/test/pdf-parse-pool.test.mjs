// The pdf.js worker pool (rag/pdf-parse-pool.js, PDF_PARSE_WORKERS > 0) and
// the page-range split in rag/pdfjs-document.js: the result must equal the
// in-process parse byte for byte, a failure must look the same, a worker that
// dies or hangs must fail only its own task and be replaced, and an idle
// pool must never keep a process alive.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getMetricsRegistry } from "../rag/metrics.js";
import { collectPdfParsePool } from "../rag/metrics-pdf-pool.js";
import {
  getPdfParsePoolSnapshot,
  PDF_PARSE_POOL_STOPPED,
  PDF_PARSE_TASK_CANCELLED,
  PDF_PARSE_TIMEOUT,
  PDF_PARSE_WORKER_FAILED,
  resetPdfParsePool,
  runPdfParseTask,
  stopPdfParsePool,
} from "../rag/pdf-parse-pool.js";
import { runPdfParseWorkerTask } from "../rag/pdf-parse-worker.js";
import { parsePdfBytesWithPdfjs } from "../rag/pdfjs-document.js";
import { parseExposition, sampleValue } from "./metrics-exposition.mjs";
import { buildMixedPdf, buildPdf, buildProsePdf, textLines } from "./pdf-fixture-builder.mjs";

const SERVER_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POOL_ENV = [
  "PDF_PARSE_PAGES_PER_TASK",
  "PDF_PARSE_TIMEOUT_MS",
  "PDF_PARSE_WORKERS",
  "PDF_PARSE_WORKER_MAX_OLD_GENERATION_MB",
];
const savedEnv = Object.fromEntries(POOL_ENV.map((name) => [name, process.env[name]]));

const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = String(value);
    }
  }
};

afterEach(async () => {
  await resetPdfParsePool();
  setEnv(savedEnv);
});

const RANGE_OPTIONS = { firstPage: 1, lastPage: 7, paragraphDetection: true };

test("every pool size and range split gives the in-process result, signals and metadata included", async () => {
  setEnv({ PDF_PARSE_PAGES_PER_TASK: 2 });

  const documents = [buildProsePdf(), buildMixedPdf()];
  const optionSets = [
    {},
    { collectSignals: true, includeMetadata: true },
    { collectSignals: true, maxPages: 5 },
    { includeMetadata: true, maxPages: 1 },
    { maxPages: 3 },
  ];

  const cases = [];

  for (const bytes of documents) {
    for (const paragraphDetection of [true, false]) {
      for (const options of optionSets) {
        cases.push({
          bytes,
          expected: await parsePdfBytesWithPdfjs(bytes, { ...options, paragraphDetection, workers: 0 }),
          options: { ...options, paragraphDetection },
        });
      }
    }
  }

  // Pool size outermost: a new size replaces the pool and its workers.
  for (const workers of [1, 2, 4]) {
    for (const { bytes, expected, options } of cases) {
      const actual = await parsePdfBytesWithPdfjs(bytes, { ...options, workers });

      assert.deepStrictEqual(actual, expected, JSON.stringify({ ...options, workers }));
    }
  }

  // One task per document with the default range of 32 pages.
  setEnv({ PDF_PARSE_PAGES_PER_TASK: undefined });

  const before = getPdfParsePoolSnapshot().completedTasks;
  const single = await parsePdfBytesWithPdfjs(documents[0], { collectSignals: true, workers: 2 });

  assert.deepStrictEqual(single, await parsePdfBytesWithPdfjs(documents[0], { collectSignals: true, workers: 0 }));
  assert.equal(getPdfParsePoolSnapshot().completedTasks - before, 1);

  const snapshot = getPdfParsePoolSnapshot();

  assert.equal(snapshot.busy, 0);
  assert.equal(snapshot.queued, 0);
  assert.equal(snapshot.failedTasks, 0);
  assert.equal(snapshot.restartedWorkers, 0);
});

test("pages are cut into ranges of PDF_PARSE_PAGES_PER_TASK, the first one alone", async () => {
  setEnv({ PDF_PARSE_PAGES_PER_TASK: 3 });

  const bytes = buildProsePdf();

  await parsePdfBytesWithPdfjs(bytes, { workers: 2 });
  // 1-3 first, then 4-6 and 7.
  assert.equal(getPdfParsePoolSnapshot().completedTasks, 3);

  await parsePdfBytesWithPdfjs(bytes, { maxPages: 4, workers: 2 });
  assert.equal(getPdfParsePoolSnapshot().completedTasks, 5);
});

test("a malformed PDF and a bad maxPages fail exactly as in process", async () => {
  const malformed = Buffer.from("%PDF-1.4\nnot-a-document\n%%EOF\n");
  const expected = await parsePdfBytesWithPdfjs(malformed, { workers: 0 }).catch((error) => error);
  const actual = await parsePdfBytesWithPdfjs(malformed, { workers: 2 }).catch((error) => error);

  assert.ok(expected instanceof Error);
  assert.equal(actual.constructor, expected.constructor);
  assert.equal(actual.name, expected.name);
  assert.equal(actual.message, expected.message);

  for (const maxPages of [-1, 2.5]) {
    await assert.rejects(parsePdfBytesWithPdfjs(buildProsePdf(), { maxPages, workers: 2 }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "maxPages must be a non-negative integer.");
      return true;
    });
  }

  assert.equal(getPdfParsePoolSnapshot().failedTasks, 3);
  assert.equal(getPdfParsePoolSnapshot().restartedWorkers, 0);
});

test("the caller's bytes are neither detached nor changed by the workers", async () => {
  setEnv({ PDF_PARSE_PAGES_PER_TASK: 2 });

  const bytes = buildProsePdf();
  const copy = Buffer.from(bytes);

  await parsePdfBytesWithPdfjs(bytes, { collectSignals: true, workers: 3 });

  assert.equal(bytes.byteLength, copy.byteLength);
  assert.ok(bytes.equals(copy));
});

test("a worker that exits or throws mid-task fails that task and is replaced", async () => {
  const bytes = buildProsePdf();
  const expected = await parsePdfBytesWithPdfjs(bytes, { workers: 0 });

  for (const testHook of ["exit", "uncaught"]) {
    await assert.rejects(runPdfParseTask(bytes, RANGE_OPTIONS, { size: 1, testHook }), (error) => {
      assert.equal(error.code, PDF_PARSE_WORKER_FAILED);
      assert.equal(error.status, 500);
      return true;
    });

    // The next document parses on a replacement worker.
    assert.deepStrictEqual(await parsePdfBytesWithPdfjs(bytes, { workers: 1 }), expected);
  }

  const snapshot = getPdfParsePoolSnapshot();

  assert.equal(snapshot.restartedWorkers, 2);
  assert.equal(snapshot.failedTasks, 2);
  assert.equal(snapshot.busy + snapshot.idle, 1);
});

test("a worker over its old-generation limit fails its task with PDF_PARSE_WORKER_FAILED", async () => {
  setEnv({ PDF_PARSE_WORKER_MAX_OLD_GENERATION_MB: 64 });

  const bytes = buildProsePdf();

  await assert.rejects(runPdfParseTask(bytes, RANGE_OPTIONS, { size: 1, testHook: "out_of_memory" }), (error) => {
    assert.equal(error.code, PDF_PARSE_WORKER_FAILED);
    assert.equal(error.status, 500);
    assert.equal(error.cause?.code, "ERR_WORKER_OUT_OF_MEMORY");
    return true;
  });

  // Under the same limit an ordinary document still parses.
  assert.deepStrictEqual(
    await parsePdfBytesWithPdfjs(bytes, { workers: 1 }),
    await parsePdfBytesWithPdfjs(bytes, { workers: 0 })
  );
  assert.equal(getPdfParsePoolSnapshot().restartedWorkers, 1);
});

test("a task over PDF_PARSE_TIMEOUT_MS terminates its worker and fails with PDF_PARSE_TIMEOUT", async () => {
  setEnv({ PDF_PARSE_TIMEOUT_MS: 300 });

  const bytes = buildProsePdf();

  await assert.rejects(runPdfParseTask(bytes, RANGE_OPTIONS, { size: 1, testHook: "hang" }), (error) => {
    assert.equal(error.code, PDF_PARSE_TIMEOUT);
    assert.equal(error.status, 504);
    return true;
  });

  assert.equal(getPdfParsePoolSnapshot().restartedWorkers, 1);
  assert.equal(getPdfParsePoolSnapshot().busy + getPdfParsePoolSnapshot().idle, 0);

  // The timeout applies to tasks as they start; a generous one lets the
  // replacement worker load pdf.js and parse.
  setEnv({ PDF_PARSE_TIMEOUT_MS: 60_000 });
  assert.deepStrictEqual(
    await parsePdfBytesWithPdfjs(bytes, { workers: 1 }),
    await parsePdfBytesWithPdfjs(bytes, { workers: 0 })
  );
});

test("several documents at once never run more tasks than the pool has workers", async () => {
  setEnv({ PDF_PARSE_PAGES_PER_TASK: 1 });

  const documents = [buildProsePdf(), buildMixedPdf(), buildProsePdf({ title: "Third" }), buildMixedPdf()];
  const expected = await Promise.all(
    documents.map((bytes) => parsePdfBytesWithPdfjs(bytes, { collectSignals: true, workers: 0 }))
  );
  let maxBusy = 0;
  let maxQueued = 0;
  let done = false;
  const sampling = (async () => {
    while (!done) {
      const { busy, queued, size } = getPdfParsePoolSnapshot();

      assert.ok(size === 0 || size === 2);
      maxBusy = Math.max(maxBusy, busy);
      maxQueued = Math.max(maxQueued, queued);
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  const actual = await Promise.all(
    documents.map((bytes) => parsePdfBytesWithPdfjs(bytes, { collectSignals: true, workers: 2 }))
  ).finally(() => {
    done = true;
  });

  await sampling;
  assert.deepStrictEqual(actual, expected);
  assert.ok(maxBusy <= 2, `busy reached ${maxBusy}`);
  assert.ok(maxBusy >= 1);
  assert.ok(maxQueued > 0, "the ranges queued behind two workers");

  const snapshot = getPdfParsePoolSnapshot();

  assert.equal(snapshot.size, 2);
  assert.equal(snapshot.busy, 0);
  assert.equal(snapshot.queued, 0);
  assert.ok(snapshot.idle <= 2);
  // 7 + 5 + 7 + 5 pages, one task each.
  assert.equal(snapshot.completedTasks, 24);
});

test("a task still queued can be cancelled; a running one finishes", async () => {
  const bytes = buildProsePdf();
  const controller = new AbortController();
  const running = runPdfParseTask(bytes, RANGE_OPTIONS, { size: 1 });
  const queued = runPdfParseTask(bytes, RANGE_OPTIONS, { signal: controller.signal, size: 1 });

  assert.equal(getPdfParsePoolSnapshot().queued, 1);
  controller.abort();
  await assert.rejects(queued, { code: PDF_PARSE_TASK_CANCELLED });
  assert.equal((await running).pages.length, 7);
  await assert.rejects(runPdfParseTask(bytes, RANGE_OPTIONS, { signal: controller.signal, size: 1 }), {
    code: PDF_PARSE_TASK_CANCELLED,
  });
  await assert.rejects(runPdfParseTask(bytes, RANGE_OPTIONS, { size: 0 }), TypeError);
});

test("stopping the pool fails what it still holds and the next task starts a new one", async () => {
  const bytes = buildProsePdf();
  const running = assert.rejects(runPdfParseTask(bytes, RANGE_OPTIONS, { size: 1, testHook: "hang" }), {
    code: PDF_PARSE_POOL_STOPPED,
    status: 503,
  });
  const queued = assert.rejects(runPdfParseTask(bytes, RANGE_OPTIONS, { size: 1 }), { code: PDF_PARSE_POOL_STOPPED });

  assert.equal(getPdfParsePoolSnapshot().busy, 1);
  assert.equal(getPdfParsePoolSnapshot().queued, 1);
  await stopPdfParsePool();
  await running;
  await queued;
  assert.deepStrictEqual(
    { busy: getPdfParsePoolSnapshot().busy, idle: getPdfParsePoolSnapshot().idle, size: getPdfParsePoolSnapshot().size },
    { busy: 0, idle: 0, size: 0 }
  );

  assert.equal((await runPdfParseTask(bytes, RANGE_OPTIONS, { size: 1 })).pages.length, 7);
  assert.equal(getPdfParsePoolSnapshot().size, 1);
});

test("a range that fails fails the document's parse", async () => {
  setEnv({ PDF_PARSE_PAGES_PER_TASK: 1 });

  const parse = parsePdfBytesWithPdfjs(buildProsePdf(), { workers: 2 });
  const outcome = assert.rejects(parse, { code: PDF_PARSE_POOL_STOPPED });

  // Once the first range has answered, the next two are running (one per
  // worker) and the other four are not in the pool yet.
  while (getPdfParsePoolSnapshot().completedTasks < 1 || getPdfParsePoolSnapshot().busy === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(getPdfParsePoolSnapshot().queued, 0);
  await stopPdfParsePool();
  await outcome;
});

test("a document that arrives while a long one parses waits for one of its ranges, not for all of them", async () => {
  setEnv({ PDF_PARSE_PAGES_PER_TASK: 1 });

  const long = buildPdf({
    pages: Array.from({ length: 40 }, (_value, index) => textLines([`Page ${index + 1} of the long manual.`])),
  });
  const short = buildPdf({ pages: [textLines(["A one-page upload."])] });
  const expectedLong = await parsePdfBytesWithPdfjs(long, { workers: 0 });
  const expectedShort = await parsePdfBytesWithPdfjs(short, { workers: 0 });
  let longDone = false;
  const longParse = parsePdfBytesWithPdfjs(long, { workers: 1 }).finally(() => {
    longDone = true;
  });

  // The first range has answered and the long document's other 39 ranges
  // are under way. It holds one task (one per worker): before this change
  // the 39 were all queued here, and the short document waited for every one.
  while (getPdfParsePoolSnapshot().completedTasks < 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const { busy, queued } = getPdfParsePoolSnapshot();

  assert.ok(busy + queued <= 1, JSON.stringify({ busy, queued }));

  const completedOnArrival = getPdfParsePoolSnapshot().completedTasks;
  const shortResult = await parsePdfBytesWithPdfjs(short, { workers: 1 });
  // The long range already in the pool, then the short document's own task.
  const completedWhileWaiting = getPdfParsePoolSnapshot().completedTasks - completedOnArrival;

  assert.ok(completedWhileWaiting <= 2, `the short document waited for ${completedWhileWaiting - 1} long ranges`);
  assert.equal(longDone, false, "the short document finished first");
  assert.deepStrictEqual(shortResult, expectedShort);
  assert.deepStrictEqual(await longParse, expectedLong);
  assert.equal(getPdfParsePoolSnapshot().completedTasks, 41);
});

test("a new pool size replaces the pool and ends the old one's idle workers", async () => {
  setEnv({ PDF_PARSE_PAGES_PER_TASK: 2 });

  const bytes = buildProsePdf();
  const expected = await parsePdfBytesWithPdfjs(bytes, { workers: 0 });

  assert.deepStrictEqual(await parsePdfBytesWithPdfjs(bytes, { workers: 1 }), expected);
  assert.deepStrictEqual(getPdfParsePoolSnapshot().size, 1);
  assert.deepStrictEqual(await parsePdfBytesWithPdfjs(bytes, { workers: 3 }), expected);

  const snapshot = getPdfParsePoolSnapshot();

  assert.equal(snapshot.size, 3);
  assert.ok(snapshot.idle >= 1 && snapshot.idle <= 3, JSON.stringify(snapshot));
  assert.equal(snapshot.busy, 0);

  // PDF_PARSE_WORKERS is the default size.
  setEnv({ PDF_PARSE_WORKERS: 2 });
  assert.deepStrictEqual(await parsePdfBytesWithPdfjs(bytes), expected);
  assert.equal(getPdfParsePoolSnapshot().size, 2);
});

test("the worker's task handler answers with the page range or the error's name, message and code", async () => {
  const bytes = buildProsePdf();
  const answer = await runPdfParseWorkerTask({ data: bytes, id: 7, options: { firstPage: 2, lastPage: 3 } });

  assert.equal(answer.id, 7);
  assert.deepStrictEqual(
    answer.result.pages.map(({ pageNumber }) => pageNumber),
    [2, 3]
  );
  assert.deepStrictEqual(await runPdfParseWorkerTask({ data: bytes, id: 8, options: { maxPages: -1 } }), {
    error: { message: "maxPages must be a non-negative integer.", name: "TypeError" },
    id: 8,
  });

  const malformed = await runPdfParseWorkerTask({ data: Buffer.from("%PDF-1.4\n%%EOF\n"), id: 9, options: {} });

  assert.equal(malformed.error.name, "InvalidPDFException");
  assert.deepStrictEqual(Object.keys(malformed.error).sort(), ["message", "name"]);
});

test("an idle pool does not keep its process alive", async () => {
  // --input-type stays in the parent's execArgv, which a worker would refuse
  // to inherit; the pool starts its workers without the parent's options.
  const script = [
    'import { parsePdfBytesWithPdfjs } from "./rag/pdfjs-document.js";',
    'import { getPdfParsePoolSnapshot } from "./rag/pdf-parse-pool.js";',
    'import { buildProsePdf } from "./test/pdf-fixture-builder.mjs";',
    "const parsed = await parsePdfBytesWithPdfjs(buildProsePdf());",
    "const { idle, size } = getPdfParsePoolSnapshot();",
    "console.log(JSON.stringify({ idle, pages: parsed.pages.length, size }));",
  ].join("\n");
  const startedAt = Date.now();
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: SERVER_DIRECTORY,
    env: { ...process.env, PDF_PARSE_PAGES_PER_TASK: "2", PDF_PARSE_WORKERS: "2" },
    // A pool that held the process open would run into this and fail.
    timeout: 30_000,
  });
  const result = JSON.parse(stdout.trim());

  assert.equal(result.pages, 7);
  assert.equal(result.size, 2);
  assert.ok(result.idle >= 1, "the workers were still there, idle, when the script ended");
  assert.ok(Date.now() - startedAt < 30_000);
});

test("the pool's snapshot feeds its metrics", async () => {
  setEnv({ PDF_PARSE_PAGES_PER_TASK: 2 });

  const bytes = buildProsePdf();

  await parsePdfBytesWithPdfjs(bytes, { workers: 2 });
  await assert.rejects(runPdfParseTask(bytes, RANGE_OPTIONS, { size: 2, testHook: "exit" }), {
    code: PDF_PARSE_WORKER_FAILED,
  });
  collectPdfParsePool();

  const families = parseExposition(getMetricsRegistry().render());

  assert.equal(sampleValue(families, "archive_rag_pdf_parse_pool_size"), 2);
  assert.equal(sampleValue(families, "archive_rag_pdf_parse_workers", { state: "busy" }), 0);
  assert.equal(
    sampleValue(families, "archive_rag_pdf_parse_workers", { state: "idle" }),
    getPdfParsePoolSnapshot().idle
  );
  assert.equal(sampleValue(families, "archive_rag_pdf_parse_queued_tasks"), 0);
  assert.equal(sampleValue(families, "archive_rag_pdf_parse_tasks_total", { outcome: "ok" }), 4);
  assert.equal(sampleValue(families, "archive_rag_pdf_parse_tasks_total", { outcome: "failed" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_parse_worker_restarts_total"), 1);
});
