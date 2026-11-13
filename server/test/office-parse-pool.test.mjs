// The Office parse pool (rag/office-parse-pool.js, RAG_OFFICE_PARSE_WORKERS):
// a document parsed on a worker gives what the calling thread gives, pages,
// metadata and refusals alike; a worker that runs out of memory refuses its
// document with 413 and is replaced; crashes, timeouts, a stopped pool and a
// cancelled task fail with their codes; the worker reads the live settings
// and never loads pdf.js; an idle pool lets its process exit.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DOCUMENT_FORMAT_ERROR_CODES, DocumentFormatError } from "../rag/document-format-errors.js";
import { loadDocumentPages } from "../rag/document-loader.js";
import { getMetricsRegistry } from "../rag/metrics.js";
import { collectOfficeParsePool } from "../rag/metrics-office-pool.js";
import {
  OFFICE_PARSE_POOL_STOPPED,
  OFFICE_PARSE_TASK_CANCELLED,
  OFFICE_PARSE_TIMEOUT,
  OFFICE_PARSE_WORKER_FAILED,
  getOfficeParsePoolSnapshot,
  resetOfficeParsePool,
  runOfficeParseTask,
  stopOfficeParsePool,
} from "../rag/office-parse-pool.js";
import { runOfficeParseWorkerTask } from "../rag/office-parse-worker.js";
import { parseDocumentBytes } from "../rag/office/office-document-pages.js";
import { writeWorkingFile } from "../rag/working-files.js";
import { parseExposition, sampleValue } from "./metrics-exposition.mjs";
import { MAX_OFFICE_XML_NESTING } from "../rag/office/xml-nesting.js";
import { findProcessHeapLimitFlag } from "../rag/worker-task-pool.js";
import {
  VARIANT_CONTENT_TYPES,
  addDoctype,
  bombEntry,
  buildDocx,
  buildOle2Bytes,
  buildPptx,
  buildXlsx,
  buildZip,
  docxEntries,
  replacePart,
} from "./office-fixture-builder.mjs";
import { buildProsePdf } from "./pdf-fixture-builder.mjs";

const SERVER_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL_FIXTURES = path.join(SERVER_DIRECTORY, "test", "fixtures", "office-real");
const CODES = DOCUMENT_FORMAT_ERROR_CODES;
const ALL_FORMATS = ["pdf", "docx", "pptx", "xlsx"];
const ENV = [
  "RAG_OFFICE_MAX_TEXT_CHARS",
  "RAG_OFFICE_MAX_UNCOMPRESSED_BYTES",
  "RAG_OFFICE_PARSE_TIMEOUT_MS",
  "RAG_OFFICE_PARSE_WORKERS",
  "RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB",
  "RAG_XLSX_MAX_CELLS",
];
const savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

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
  await resetOfficeParsePool();
  setEnv(savedEnv);
});

const DOCX = buildDocx({
  blocks: [
    { text: "Preface" },
    { heading: 1, text: "Scope" },
    { text: "The scope paragraph." },
    { table: [["Owner", "Due"], ["Ana", "May"]] },
    { heading: 1, text: "Terms" },
    { text: "The terms paragraph." },
  ],
});
const XLSX = buildXlsx({
  sheets: [
    { name: "Visible", rows: [["Name", "Value"], ["alpha", 1], ["beta", 2.5]] },
    { name: "Hidden", rows: [["secret", "x"]], state: "hidden" },
    { name: "Second", rows: [["Region", "Owner"], ["North", "Kim"]] },
  ],
});
const PPTX = buildPptx({
  slides: [
    { notes: "Remember the numbers", shapes: [{ paragraphs: [{ bullet: true, text: "First point" }], x: 1, y: 2 }], title: "Kickoff" },
    { hidden: true, title: "Backup slide" },
    { shapes: [{ table: [["Owner", "Due"], ["Ana", "May"]], x: 1, y: 2 }], title: "Plan" },
  ],
});

const withFiles = async (files, callback) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "office-parse-pool-"));

  try {
    const paths = {};

    for (const [name, bytes] of Object.entries(files)) {
      paths[name] = path.join(directory, name);
      await writeWorkingFile(paths[name], bytes);
    }

    return await callback(paths);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

// What a load gave: its result, or its error as the fields a caller reads.
const settle = (promise) =>
  promise.then(
    (result) => ({ result }),
    (error) => ({
      error: {
        cause: error.cause ? { message: error.cause.message, name: error.cause.name } : undefined,
        code: error.code,
        constructor: error.constructor,
        documentFormatError: error instanceof DocumentFormatError,
        expose: error.expose,
        message: error.message,
        name: error.name,
        status: error.status,
      },
    })
  );

// The same load in the calling thread (0) and on workers (1, then 2).
const loadEachWay = async (filePath, options = {}) => {
  const outcomes = [];

  for (const workers of [0, 1, 2]) {
    setEnv({ RAG_OFFICE_PARSE_WORKERS: workers });
    outcomes.push(await settle(loadDocumentPages(filePath, options)));
  }

  return outcomes;
};

const realFixtureFiles = async () =>
  (await readdir(REAL_FIXTURES)).filter((name) => /\.(?:docx|pptx|xlsx)$/i.test(name)).sort();

test("every Office document gives the calling thread's pages and metadata on a worker", async () => {
  const files = { "built.docx": DOCX, "built.pptx": PPTX, "built.xlsx": XLSX };

  for (const name of await realFixtureFiles()) {
    files[`real-${name}`] = await readFile(path.join(REAL_FIXTURES, name));
  }

  assert.ok(Object.keys(files).length >= 8, "the Office-written fixtures are there");

  await withFiles(files, async (paths) => {
    for (const [name, filePath] of Object.entries(paths)) {
      const before = getOfficeParsePoolSnapshot().completedTasks;
      const [inProcess, oneWorker, twoWorkers] = await loadEachWay(filePath);

      assert.ok(inProcess.result, `${name} loads`);
      assert.ok(inProcess.result.pages.length > 0, `${name} has pages`);
      assert.deepStrictEqual(oneWorker, inProcess, name);
      assert.deepStrictEqual(twoWorkers, inProcess, name);
      assert.equal(getOfficeParsePoolSnapshot().completedTasks - before, 2, `${name} went to the workers twice`);
    }
  });
});

test("a refusal on a worker is the DocumentFormatError the calling thread throws", async () => {
  const brokenDocument = buildDocx({
    blocks: [{ text: "Body" }],
    transform: (entries) => replacePart(entries, "word/document.xml", "<w:document><w:body>"),
  });
  const cases = [
    {
      bytes: buildDocx({ blocks: [{ text: "Body" }], transform: (entries) => [...entries, bombEntry({ bytes: 4 * 1024 * 1024 })] }),
      code: CODES.archiveTooLarge,
      name: "a zip bomb",
      status: 413,
    },
    {
      bytes: buildDocx({ blocks: [{ text: "Body" }], transform: (entries) => addDoctype(entries, "word/document.xml") }),
      code: CODES.archiveInvalid,
      name: "a DTD",
      status: 400,
    },
    { bytes: brokenDocument, code: CODES.archiveInvalid, name: "a part mammoth cannot read", status: 400 },
    {
      bytes: buildDocx({ blocks: [{ text: "Body" }], mainContentType: VARIANT_CONTENT_TYPES.docm }),
      code: CODES.officeVariant,
      name: "a macro-enabled document",
      status: 415,
    },
    { bytes: XLSX, code: CODES.disabled, formats: ["pdf", "docx", "pptx"], name: "a disabled format", status: 415 },
    { bytes: XLSX, code: CODES.spreadsheetTooLarge, env: { RAG_XLSX_MAX_CELLS: 1 }, name: "too many cells", status: 413 },
    { bytes: PPTX, code: CODES.archiveTooLarge, env: { RAG_OFFICE_MAX_TEXT_CHARS: 5 }, name: "too much text", status: 413 },
    { bytes: buildOle2Bytes(), code: CODES.legacyOffice, name: "an OLE2 file (never sent to a worker)", status: 415 },
  ];

  for (const { bytes, code, env = {}, formats = ALL_FORMATS, name, status } of cases) {
    setEnv(env);

    await withFiles({ file: bytes }, async ({ file }) => {
      const [inProcess, oneWorker, twoWorkers] = await loadEachWay(file, { formats });

      assert.ok(inProcess.error, `${name} is refused`);
      assert.equal(inProcess.error.documentFormatError, true, name);
      assert.equal(inProcess.error.code, code, name);
      assert.equal(inProcess.error.status, status, name);
      assert.deepStrictEqual(oneWorker, inProcess, name);
      assert.deepStrictEqual(twoWorkers, inProcess, name);
    });

    setEnv(Object.fromEntries(Object.keys(env).map((key) => [key, savedEnv[key]])));
  }

  // The library's own error stays a cause, by name and message.
  await withFiles({ file: brokenDocument }, async ({ file }) => {
    const [, onWorker] = await loadEachWay(file);

    assert.ok(onWorker.error.cause, "the refusal keeps mammoth's error as its cause");
  });
});

// A Word document whose one paragraph sits inside `depth` nested smart tags
// (w:body and w:document add two levels around them).
const nestedDocx = (depth) =>
  buildZip(
    replacePart(
      docxEntries({ blocks: [{ text: "placeholder" }] }),
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${"<w:smartTag>".repeat(depth)}<w:p><w:r><w:t>deep text</w:t></w:r></w:p>${"</w:smartTag>".repeat(depth)}</w:body></w:document>`
    )
  );

test("how deep a Word document may nest is the same on every thread", async () => {
  // 3,000 levels overflowed the main thread's stack while a worker read them
  // (the worker's stack is larger); the cap refuses both the same way.
  for (const depth of [MAX_OFFICE_XML_NESTING - 10, MAX_OFFICE_XML_NESTING + 10, 3000]) {
    await withFiles({ file: nestedDocx(depth) }, async ({ file }) => {
      const [inProcess, oneWorker, twoWorkers] = await loadEachWay(file);

      assert.deepStrictEqual(oneWorker, inProcess, `depth ${depth}`);
      assert.deepStrictEqual(twoWorkers, inProcess, `depth ${depth}`);

      if (depth < MAX_OFFICE_XML_NESTING) {
        assert.deepEqual(
          inProcess.result.pages.map((page) => page.text),
          ["deep text"],
          `depth ${depth} is read`
        );
      } else {
        assert.equal(inProcess.error.code, CODES.archiveInvalid, `depth ${depth}`);
        assert.equal(inProcess.error.status, 400);
        assert.match(inProcess.error.message, /nests its elements more than 256 levels deep/);
        assert.equal(inProcess.error.cause, undefined, "refused before mammoth ran");
      }
    });
  }
});

test("a process heap flag that replaces the worker memory limit is found and warned about once", async () => {
  assert.equal(findProcessHeapLimitFlag({ execArgv: [], nodeOptions: undefined }), null);
  assert.equal(findProcessHeapLimitFlag({ execArgv: ["--max-old-space-size=512"] }), "--max-old-space-size=512");
  assert.equal(findProcessHeapLimitFlag({ execArgv: [], nodeOptions: " --max_old_space_size=256 --trace-warnings" }), "--max_old_space_size=256");
  assert.equal(findProcessHeapLimitFlag({ execArgv: ["--max-semi-space-size=16"], nodeOptions: "--stack-size=900" }), null);

  const script = [
    'import { runOfficeParseTask } from "./rag/office-parse-pool.js";',
    'import { buildDocx } from "./test/office-fixture-builder.mjs";',
    'const bytes = buildDocx({ blocks: [{ text: "Body" }] });',
    'const formats = ["pdf", "docx", "pptx", "xlsx"];',
    "await runOfficeParseTask(bytes, { formats }, { size: 1 });",
    "await runOfficeParseTask(bytes, { formats }, { size: 2 });",
    'console.log("parsed");',
  ].join("\n");
  const runScript = (execArgs, env) =>
    promisify(execFile)(process.execPath, [...execArgs, "--input-type=module", "--eval", script], {
      cwd: SERVER_DIRECTORY,
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
  const warning = /RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB=64 has no effect: this process runs with --max-old-space-size=256/;

  const flagged = await runScript(["--max-old-space-size=256"], { RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB: "64" });

  assert.equal(flagged.stdout.trim(), "parsed");
  assert.equal(flagged.stderr.split("\n").filter((line) => warning.test(line)).length, 1, "warned once for two pools");

  const unflagged = await runScript([], { RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB: "64" });

  assert.equal(unflagged.stdout.trim(), "parsed");
  assert.doesNotMatch(unflagged.stderr, /has no effect/);
});

test("an invalid setting read on the worker fails as it does in the calling thread", async () => {
  setEnv({ RAG_OFFICE_MAX_TEXT_CHARS: "lots" });

  await withFiles({ "built.docx": DOCX }, async ({ "built.docx": filePath }) => {
    const [inProcess, oneWorker] = await loadEachWay(filePath);

    assert.equal(inProcess.error.code, "RAG_OFFICE_LIMIT_INVALID");
    assert.deepStrictEqual(oneWorker, inProcess);
  });
});

test("a worker reads a setting changed after it started (the process's environment is shared)", async () => {
  setEnv({ RAG_OFFICE_PARSE_WORKERS: 1 });

  await withFiles({ "built.xlsx": XLSX }, async ({ "built.xlsx": filePath }) => {
    assert.equal((await loadDocumentPages(filePath)).pages.length, 2);
    assert.equal(getOfficeParsePoolSnapshot().idle, 1, "the worker is up");

    setEnv({ RAG_XLSX_MAX_CELLS: 1 });
    await assert.rejects(loadDocumentPages(filePath), { code: CODES.spreadsheetTooLarge, status: 413 });
    setEnv({ RAG_XLSX_MAX_CELLS: undefined });
    assert.equal((await loadDocumentPages(filePath)).pages.length, 2);
    assert.equal(getOfficeParsePoolSnapshot().restartedWorkers, 0, "the same worker answered all three");
  });
});

test("a worker that runs out of memory refuses its document with 413 and is replaced", async () => {
  setEnv({ RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB: 64 });

  await assert.rejects(runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 1, testHook: "out_of_memory" }), (error) => {
    assert.ok(error instanceof DocumentFormatError);
    assert.equal(error.code, CODES.archiveTooLarge);
    assert.equal(error.status, 413);
    assert.equal(error.expose, true);
    assert.match(error.message, /RAG_OFFICE_PARSE_WORKER_MAX_OLD_GENERATION_MB/);
    return true;
  });

  // Under the same limit an ordinary document still parses, on a new worker.
  assert.deepStrictEqual(
    await runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 1 }),
    await parseDocumentBytes(DOCX, { formats: ALL_FORMATS })
  );
  assert.equal(getOfficeParsePoolSnapshot().restartedWorkers, 1);
});

test("a worker that exits or throws mid-task fails that task and is replaced", async () => {
  const expected = await parseDocumentBytes(XLSX, { formats: ALL_FORMATS });

  for (const testHook of ["exit", "uncaught"]) {
    await assert.rejects(runOfficeParseTask(XLSX, { formats: ALL_FORMATS }, { size: 1, testHook }), (error) => {
      assert.equal(error.code, OFFICE_PARSE_WORKER_FAILED);
      assert.equal(error.status, 500);
      assert.equal(error instanceof DocumentFormatError, false);
      return true;
    });

    assert.deepStrictEqual(await runOfficeParseTask(XLSX, { formats: ALL_FORMATS }, { size: 1 }), expected);
  }

  const snapshot = getOfficeParsePoolSnapshot();

  assert.equal(snapshot.restartedWorkers, 2);
  assert.equal(snapshot.failedTasks, 2);
  assert.equal(snapshot.completedTasks, 2);
  assert.equal(snapshot.busy + snapshot.idle, 1);
});

test("a task over RAG_OFFICE_PARSE_TIMEOUT_MS terminates its worker and fails with OFFICE_PARSE_TIMEOUT", async () => {
  setEnv({ RAG_OFFICE_PARSE_TIMEOUT_MS: 300 });

  await assert.rejects(runOfficeParseTask(PPTX, { formats: ALL_FORMATS }, { size: 1, testHook: "hang" }), {
    code: OFFICE_PARSE_TIMEOUT,
    status: 504,
  });
  assert.equal(getOfficeParsePoolSnapshot().restartedWorkers, 1);
  assert.equal(getOfficeParsePoolSnapshot().busy + getOfficeParsePoolSnapshot().idle, 0);

  setEnv({ RAG_OFFICE_PARSE_TIMEOUT_MS: 60_000 });
  assert.deepStrictEqual(
    await runOfficeParseTask(PPTX, { formats: ALL_FORMATS }, { size: 1 }),
    await parseDocumentBytes(PPTX, { formats: ALL_FORMATS })
  );
});

test("a task still queued can be cancelled; a running one finishes", async () => {
  const controller = new AbortController();
  const running = runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 1 });
  const queued = runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { signal: controller.signal, size: 1 });

  assert.equal(getOfficeParsePoolSnapshot().queued, 1);
  controller.abort();
  await assert.rejects(queued, { code: OFFICE_PARSE_TASK_CANCELLED, status: 499 });
  assert.equal((await running).format, "docx");
  await assert.rejects(runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { signal: controller.signal, size: 1 }), {
    code: OFFICE_PARSE_TASK_CANCELLED,
  });
  await assert.rejects(runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 0 }), TypeError);
});

test("stopping the pool fails what it still holds and the next task starts a new one", async () => {
  const running = assert.rejects(runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 1, testHook: "hang" }), {
    code: OFFICE_PARSE_POOL_STOPPED,
    status: 503,
  });
  const queued = assert.rejects(runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 1 }), {
    code: OFFICE_PARSE_POOL_STOPPED,
    status: 503,
  });

  assert.equal(getOfficeParsePoolSnapshot().busy, 1);
  assert.equal(getOfficeParsePoolSnapshot().queued, 1);
  await stopOfficeParsePool();
  await running;
  await queued;
  assert.deepStrictEqual(
    {
      busy: getOfficeParsePoolSnapshot().busy,
      idle: getOfficeParsePoolSnapshot().idle,
      size: getOfficeParsePoolSnapshot().size,
    },
    { busy: 0, idle: 0, size: 0 }
  );
  assert.equal((await runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 1 })).format, "docx");
  assert.equal(getOfficeParsePoolSnapshot().size, 1);
});

test("the caller's bytes are neither detached nor changed by the worker", async () => {
  const bytes = Buffer.from(XLSX);

  await runOfficeParseTask(bytes, { formats: ALL_FORMATS }, { size: 1 });
  assert.equal(bytes.length, XLSX.length);
  assert.ok(bytes.equals(XLSX));
});

test("the calling thread parses with RAG_OFFICE_PARSE_WORKERS=0, with a stand-in PPTX reader, and for a PDF", async () => {
  await withFiles({ "built.docx": DOCX, "built.pptx": PPTX, "document.pdf": buildProsePdf() }, async (paths) => {
    setEnv({ RAG_OFFICE_PARSE_WORKERS: 0 });
    assert.equal((await loadDocumentPages(paths["built.docx"])).format, "docx");

    setEnv({ RAG_OFFICE_PARSE_WORKERS: 1 });
    const standIn = await loadDocumentPages(paths["built.pptx"], {
      importPptxReader: async () => ({
        PPTX_EXTRACTOR_VERSION: 9,
        extractPptxPages: () => [{ pageNumber: 1, text: "stand-in" }],
      }),
    });

    assert.equal(standIn.parse.extractorVersion, 9);
    assert.equal((await loadDocumentPages(paths["document.pdf"])).format, "pdf");
    assert.equal(getOfficeParsePoolSnapshot().completedTasks, 0, "none of the three went to a worker");
  });
});

test("the worker's task handler answers with the document or the refusal's fields", async () => {
  const answer = await runOfficeParseWorkerTask({ data: new Uint8Array(DOCX), formats: ALL_FORMATS, id: 7 });

  assert.equal(answer.id, 7);
  assert.deepStrictEqual(answer.result, await parseDocumentBytes(DOCX, { formats: ALL_FORMATS }));

  const refused = await runOfficeParseWorkerTask({ data: new Uint8Array(XLSX), formats: ["pdf", "docx"], id: 8 });

  assert.deepStrictEqual(refused, {
    error: {
      code: CODES.disabled,
      documentFormatError: true,
      message: "Excel (.xlsx) documents are not accepted by this server (RAG_DOCUMENT_FORMATS).",
      name: "DocumentFormatError",
      status: 415,
    },
    id: 8,
  });
});

// The modules a worker evaluates, from office-parse-worker.js through every
// relative import (static or dynamic) under server/rag: none of them is
// pdf.js or loads it.
const collectImportGraph = async (entry) => {
  const seen = new Set();
  const bare = new Set();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop();

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);

    const source = await readFile(file, "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ].map((match) => match[1]);

    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        pending.push(path.resolve(path.dirname(file), specifier));
      } else {
        bare.add(specifier);
      }
    }
  }

  return { bare, files: [...seen].map((file) => path.relative(SERVER_DIRECTORY, file)) };
};

test("the worker never loads pdf.js", async () => {
  const { bare, files } = await collectImportGraph(path.join(SERVER_DIRECTORY, "rag", "office-parse-worker.js"));

  assert.ok(files.includes(path.join("rag", "office", "docx-loader.js")), "the walk reaches the readers");
  assert.deepEqual(
    files.filter((file) => /pdf/i.test(path.basename(file))),
    [],
    "no pdf module in the worker's graph"
  );
  assert.equal([...bare].some((specifier) => /pdfjs/i.test(specifier)), false);
});

test("an idle pool does not keep its process alive", async () => {
  const script = [
    'import { loadDocumentPages } from "./rag/document-loader.js";',
    'import { getOfficeParsePoolSnapshot } from "./rag/office-parse-pool.js";',
    'import { writeWorkingFile } from "./rag/working-files.js";',
    'import { buildDocx } from "./test/office-fixture-builder.mjs";',
    'import { mkdtemp } from "node:fs/promises";',
    'import os from "node:os";',
    'import path from "node:path";',
    'const filePath = path.join(await mkdtemp(path.join(os.tmpdir(), "office-idle-")), "a.docx");',
    'await writeWorkingFile(filePath, buildDocx({ blocks: [{ text: "Body" }] }));',
    "const loaded = await loadDocumentPages(filePath);",
    "const { idle, size } = getOfficeParsePoolSnapshot();",
    "console.log(JSON.stringify({ format: loaded.format, idle, size }));",
  ].join("\n");
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: SERVER_DIRECTORY,
    env: { ...process.env, RAG_OFFICE_PARSE_WORKERS: "" },
    // A pool that held the process open would run into this and fail.
    timeout: 30_000,
  });

  assert.deepStrictEqual(JSON.parse(stdout.trim()), { format: "docx", idle: 1, size: 1 });
});

test("the pool's snapshot feeds its metrics", async () => {
  await runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 2 });
  await runOfficeParseTask(XLSX, { formats: ALL_FORMATS }, { size: 2 });
  await assert.rejects(runOfficeParseTask(DOCX, { formats: ALL_FORMATS }, { size: 2, testHook: "exit" }), {
    code: OFFICE_PARSE_WORKER_FAILED,
  });
  collectOfficeParsePool();

  const families = parseExposition(getMetricsRegistry().render());

  assert.equal(sampleValue(families, "archive_rag_office_parse_pool_size"), 2);
  assert.equal(sampleValue(families, "archive_rag_office_parse_workers", { state: "busy" }), 0);
  assert.equal(
    sampleValue(families, "archive_rag_office_parse_workers", { state: "idle" }),
    getOfficeParsePoolSnapshot().idle
  );
  assert.equal(sampleValue(families, "archive_rag_office_parse_queued_tasks"), 0);
  assert.equal(sampleValue(families, "archive_rag_office_parse_tasks_total", { outcome: "ok" }), 2);
  assert.equal(sampleValue(families, "archive_rag_office_parse_tasks_total", { outcome: "failed" }), 1);
  assert.equal(sampleValue(families, "archive_rag_office_parse_worker_restarts_total"), 1);
});
