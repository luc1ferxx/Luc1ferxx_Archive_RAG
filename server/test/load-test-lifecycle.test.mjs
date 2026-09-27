import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_INDEX_SWITCH_LATEST_NAME,
  INDEX_SWITCH_NOTES,
  MAX_SEARCH_TRANSITIONS,
  analyzeCrashedJobs,
  buildAppEnvironment,
  buildCrashNotes,
  buildMethodNotes,
  buildSeedPdf,
  buildSyntheticCorpus,
  computeSwitchPropagation,
  createSearchTableTracker,
  describeWorkerEmbeddings,
  documentNamesInTexts,
  fakeEmbeddingWidth,
  fakeModelCaller,
  formatCrashReport,
  formatLoadTestMarkdown,
  parseLoadTestArgs,
  projectName,
  readSearchedChunkTable,
  startFakeModelServer,
  summarizePropagation,
  summarizeSwitchPhases,
  switchEmbeddingModel,
} from "../evaluation/run-api-load-bench.mjs";

// The load harness's index-lifecycle and pipeline measurements: the index
// switch scenario (pointer visibility, per-instance propagation from the
// chunk table each search read, per-phase latency), the per-process model
// accounting, and the crash injection's per-job analysis. No database: the
// scenario itself runs under scripts/run-load-test-pgvector.sh.

const database = ["--database-url", "postgresql://u:p@127.0.0.1:6000/db"];

test("the index-switch scenario parses its own flags, runs on pgvector only and needs another width", () => {
  const options = parseLoadTestArgs([...database, "--scenario", "index-switch", "--instances", "2", "--tenant"]);

  assert.equal(options.scenario, "index-switch");
  assert.deepEqual(options.storage, ["pgvector"]);
  assert.equal(options.switchConcurrency, 8);
  assert.equal(options.switchDimensions, 768);
  assert.equal(options.switchPhaseMs, 15000);
  assert.equal(options.indexPointerTtlMs, null, "the app's default TTL unless asked");
  assert.equal(options.latestName, DEFAULT_INDEX_SWITCH_LATEST_NAME);

  const custom = parseLoadTestArgs([
    ...database,
    "--scenario=index-switch",
    "--switch-concurrency",
    "4",
    "--switch-dimensions",
    "384",
    "--switch-phase-ms",
    "0",
    "--switch-build-batch-size",
    "8",
    "--index-pointer-ttl-ms",
    "500",
  ]);
  assert.equal(custom.switchConcurrency, 4);
  assert.equal(custom.switchDimensions, 384);
  assert.equal(custom.switchPhaseMs, 0);
  assert.equal(custom.switchBuildBatchSize, 8);
  assert.equal(custom.indexPointerTtlMs, 500);

  assert.throws(() => parseLoadTestArgs(["--scenario", "index-switch"]), /database-url/);
  assert.throws(
    () => parseLoadTestArgs([...database, "--scenario", "index-switch", "--storage", "local"]),
    /pgvector only/
  );
  assert.throws(
    () => parseLoadTestArgs([...database, "--scenario", "index-switch", "--switch-dimensions", "1536"]),
    /must differ/
  );
  assert.throws(() => parseLoadTestArgs(["--switch-phase-ms", "10"]), /only apply to --scenario index-switch/);
  assert.throws(() => parseLoadTestArgs([...database, "--scenario", "index-switch", "--uploads", "4"]), /only apply to --scenario ingest/);
});

test("pipeline flags: batching on/off, linger, lease and the crash injection need async workers", () => {
  const base = [...database, "--scenario", "ingest", "--ingest-mode", "async", "--ingest-workers", "2"];
  const off = parseLoadTestArgs([...base, "--embed-batching", "off", "--embed-batch-linger-ms", "0", "--ingest-job-lease-ms", "8000"]);

  assert.equal(off.embedBatching, "off");
  assert.equal(off.embedBatchLingerMs, 0);
  assert.equal(off.ingestJobLeaseMs, 8000);
  assert.equal(off.crashWorkerMidEmbed, false);
  assert.equal(parseLoadTestArgs(base).embedBatching, null, "the app's default unless asked");

  const crash = parseLoadTestArgs([...base, "--crash-worker-mid-embed", "--upload-concurrency", "64"]);
  assert.equal(crash.crashWorkerMidEmbed, true);

  assert.throws(() => parseLoadTestArgs([...base, "--embed-batching", "maybe"]), /on or off/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--embed-batching", "on"]), /ingest-mode async/);
  assert.throws(
    () => parseLoadTestArgs([...database, "--scenario", "ingest", "--ingest-mode", "async", "--ingest-workers", "1", "--crash-worker-mid-embed"]),
    /--ingest-workers 2 or more/
  );
  assert.throws(() => parseLoadTestArgs([...base, "--crash-worker-mid-embed", "--upload-concurrency", "4,8"]), /one level once/);
  assert.throws(() => parseLoadTestArgs(["--embed-batching", "on"]), /only apply to --scenario ingest/);
  assert.equal(parseLoadTestArgs(["--embedding-latency-per-input-ms", "3"]).embeddingLatencyPerInputMs, 3);
});

test("every process gets its own API key, and pipeline and pointer settings reach the app only when named", () => {
  const options = parseLoadTestArgs([
    ...database,
    "--scenario",
    "ingest",
    "--ingest-mode",
    "async",
    "--ingest-workers",
    "2",
    "--embed-batching",
    "off",
    "--embed-batch-linger-ms",
    "5",
    "--ingest-job-lease-ms",
    "9000",
  ]);
  const shell = { RAG_INGEST_EMBED_BATCHING: "true", RAG_INGEST_JOB_LEASE_MS: "1" };
  const worker = buildAppEnvironment({
    baseEnvironment: shell,
    callerTag: "worker-1",
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options,
    role: "worker",
    storage: "pgvector",
    tempRoot: "/tmp/x",
  });

  assert.equal(worker.OPENAI_API_KEY, "load-test-worker-1");
  assert.equal(worker.RAG_INGEST_EMBED_BATCHING, "false");
  assert.equal(worker.RAG_INGEST_EMBED_BATCH_LINGER_MS, "5");
  assert.equal(worker.RAG_INGEST_JOB_LEASE_MS, "9000");
  assert.equal(worker.RAG_INDEX_VERSION_POINTER_TTL_MS, undefined);

  const plain = buildAppEnvironment({
    baseEnvironment: shell,
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options: parseLoadTestArgs([]),
    storage: "local",
    tempRoot: "/tmp/x",
  });
  assert.equal(plain.OPENAI_API_KEY, "load-test");
  assert.equal(plain.RAG_INGEST_EMBED_BATCHING, undefined, "the shell's setting is cleared, the app default applies");
  assert.equal(plain.RAG_INGEST_JOB_LEASE_MS, undefined);

  const switching = buildAppEnvironment({
    callerTag: "api-0",
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options: parseLoadTestArgs([...database, "--scenario", "index-switch", "--index-pointer-ttl-ms", "750"]),
    storage: "pgvector",
    tempRoot: "/tmp/x",
  });
  assert.equal(switching.RAG_INDEX_VERSION_POINTER_TTL_MS, "750");
  assert.equal(switching.OPENAI_API_KEY, "load-test-api-0");
});

test("the fake model answers a switch model at its width, counts per caller and model, and holds on request", async (t) => {
  assert.equal(switchEmbeddingModel(768), "load-test-embedding-768");
  assert.equal(fakeEmbeddingWidth("load-test-embedding-768", 16), 768);
  assert.equal(fakeEmbeddingWidth("text-embedding-3-small", 16), 16);
  assert.equal(fakeEmbeddingWidth("load-test-embedding-x", 16), 16);
  assert.equal(fakeModelCaller("Bearer load-test-api-1"), "load-test-api-1");
  assert.equal(fakeModelCaller(undefined), "unknown");
  assert.deepEqual(
    documentNamesInTexts(["Program Albatross-p0c4l1r1-1 operating manual, part 1.", "Program Albatross-p0c4l1r1-1 annex 2", "none"]),
    ["Albatross-p0c4l1r1-1"]
  );

  const server = await startFakeModelServer({ dimensions: 16, embeddingLatencyMs: 0, embeddingLatencyPerInputMs: 15 });
  t.after(() => server.close());
  const embed = (key, model, input) =>
    fetch(`${server.baseUrl}/embeddings`, {
      body: JSON.stringify({ input, model }),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      method: "POST",
    }).then((response) => response.json());

  const startedAt = Date.now();
  const configured = await embed("load-test-worker-0", "text-embedding-3-small", ["a", "b", "c"]);
  assert.ok(Date.now() - startedAt >= 40, "15 ms per input");
  assert.equal(configured.data[0].embedding.length, 16);
  const pinned = await embed("load-test-api-0", "load-test-embedding-24", ["q"]);
  assert.equal(pinned.data[0].embedding.length, 24);

  const snapshot = server.snapshot();
  assert.deepEqual(snapshot.byCaller["load-test-worker-0"], { chat: 0, embeddingInputs: 3, embeddings: 1 });
  assert.deepEqual(snapshot.embeddingsByModel["load-test-embedding-24"], { inputs: 1, requests: 1 });
  assert.ok(Number.isFinite(server.firstEmbeddingAt()["load-test-api-0|load-test-embedding-24"]));

  // A held request is counted, reported and never answered.
  const held = server.holdNextEmbedding({ caller: "load-test-worker-1" });
  const controller = new AbortController();
  const hanging = fetch(`${server.baseUrl}/embeddings`, {
    body: JSON.stringify({ input: ["Program Cobalt-x1-3 operating manual, part 2."], model: "text-embedding-3-small" }),
    headers: { authorization: "Bearer load-test-worker-1", "content-type": "application/json" },
    method: "POST",
    signal: controller.signal,
  }).catch((error) => error);
  const request = await held;
  assert.equal(request.caller, "load-test-worker-1");
  assert.equal(request.inputs, 1);
  assert.deepEqual(request.documents, ["Cobalt-x1-3"]);
  // Other callers are served meanwhile.
  assert.equal((await embed("load-test-worker-0", "text-embedding-3-small", ["d"])).data.length, 1);
  controller.abort();
  assert.equal((await hanging).name, "AbortError");
});

test("the search tracker names the chunk table each retrieval statement read and when the dense route changed tables", () => {
  assert.deepEqual(readSearchedChunkTable("SELECT 1 - (embedding <=> $1::vector) AS s FROM rag_document_chunks_v2 WHERE doc_id = ANY($2)"), {
    route: "dense",
    table: "rag_document_chunks_v2",
  });
  assert.deepEqual(
    readSearchedChunkTable("SELECT c.chunk_id FROM rag_document_chunks_v2_sparse_rank(to_tsquery($1::regconfig, $2), ARRAY[]::text[], 5) AS r"),
    { route: "sparse", table: "rag_document_chunks_v2" }
  );
  assert.deepEqual(readSearchedChunkTable("SELECT ts_rank_cd(search_vector, q) FROM rag_document_chunks WHERE true"), {
    route: "sparse",
    table: "rag_document_chunks",
  });
  assert.equal(readSearchedChunkTable("SELECT * FROM rag_documents"), null);
  assert.equal(readSearchedChunkTable(undefined), null);

  let clock = 1000;
  const tracker = createSearchTableTracker({ now: () => clock });
  const dense = (table) => `SELECT chunk_id FROM ${table} ORDER BY embedding <=> $1::vector ASC`;

  tracker.observe(dense("rag_document_chunks"));
  clock = 1010;
  tracker.observe(dense("rag_document_chunks"));
  tracker.observe("BEGIN");
  clock = 1500;
  tracker.observe(dense("rag_document_chunks_v2"));
  clock = 1505;
  tracker.observe(dense("rag_document_chunks"));
  clock = 1600;
  tracker.observe(dense("rag_document_chunks_v2"));

  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.tables["dense:rag_document_chunks"], {
    count: 3,
    firstAt: 1000,
    lastAt: 1505,
    route: "dense",
    table: "rag_document_chunks",
  });
  assert.deepEqual(
    snapshot.transitions.map((entry) => [entry.at, entry.to]),
    [
      [1000, "rag_document_chunks"],
      [1500, "rag_document_chunks_v2"],
      [1505, "rag_document_chunks"],
      [1600, "rag_document_chunks_v2"],
    ]
  );
  assert.equal(snapshot.transitionsTruncated, false);
  assert.ok(MAX_SEARCH_TRANSITIONS >= 100);
});

test("propagation is the first search on the new table after the last unchanged pointer read, per instance", () => {
  const snapshots = [
    {
      tables: { "dense:old": { lastAt: 10_700 } },
      transitions: [
        { at: 1_000, to: "old" },
        { at: 10_650, to: "new" },
        { at: 10_700, to: "old" },
        { at: 10_720, to: "new" },
      ],
    },
    { tables: { "dense:old": { lastAt: 9_000 } }, transitions: [{ at: 1_000, to: "old" }, { at: 12_000, to: "new" }] },
  ];
  const perInstance = computeSwitchPropagation({ afterEpochMs: 9_995, fromTable: "old", snapshots, toTable: "new", visibleAt: 10_000 });

  assert.deepEqual(perInstance[0], { firstSearchOnNewMs: 650, instance: 0, lastSearchOnOldMs: 700, tableChangesAfterSwitch: 3 });
  // Its last search on the old table predates the switch: nothing to report.
  assert.deepEqual(perInstance[1], { firstSearchOnNewMs: 2000, instance: 1, lastSearchOnOldMs: null, tableChangesAfterSwitch: 1 });
  assert.equal(summarizePropagation(perInstance).allInstancesMs, 2000);
  assert.equal(summarizePropagation([{ firstSearchOnNewMs: null }]).allInstancesMs, null, "an instance that never followed");

  // A rollback goes back to a table searched before: only transitions after the switch count.
  const back = computeSwitchPropagation({
    afterEpochMs: 20_000,
    fromTable: "new",
    snapshots: [{ tables: { "dense:new": { lastAt: 20_300 } }, transitions: [{ at: 1_000, to: "old" }, { at: 20_400, to: "old" }] }],
    toTable: "old",
    visibleAt: 20_010,
  });
  assert.equal(back[0].firstSearchOnNewMs, 390);
  assert.equal(back[0].lastSearchOnOldMs, 290);
});

test("phases split the continuous load by send time, with the model calls of each phase", () => {
  const model = (requests, byModel) => ({
    byCaller: {},
    chat: { requests: 0 },
    embeddings: { requests },
    embeddingsByModel: byModel,
  });
  const phases = [
    { endedAt: 100, model: model(0, {}), name: "before", startedAt: 0 },
    { endedAt: 200, model: model(2, { "load-test-embedding-768": { inputs: 2, requests: 2 } }), name: "new version active", startedAt: 100 },
  ];
  const results = [
    { grounded: true, instance: 0, latencyMs: 10, sentAt: 5, status: 200 },
    { grounded: true, instance: 1, latencyMs: 30, sentAt: 99, status: 200 },
    { grounded: true, instance: 0, latencyMs: 50, sentAt: 100, status: 200 },
    { error: "timeout", instance: 1, latencyMs: 90, sentAt: 150, status: 0 },
  ];
  const [before, active, window] = summarizeSwitchPhases({
    instanceCount: 2,
    phases,
    results,
    windows: [{ endedAt: 120, kind: "window", name: "switchover", startedAt: 100 }],
  });

  assert.equal(before.requests, 2);
  assert.equal(before.errors, 0);
  assert.equal(before.latencyMs.max, 30);
  assert.equal(before.throughputRps, 20);
  assert.equal(active.requests, 2);
  assert.equal(active.errors, 1);
  assert.equal(active.model.embeddingRequestsPerChat, 1);
  assert.deepEqual(active.perInstance.map((entry) => entry.requests), [1, 1]);
  assert.equal(window.kind, "window");
  assert.equal(window.requests, 1);
  assert.equal(window.model, undefined);
});

test("the crash analysis says per job where the next attempt started and whether an earlier stage ran again", () => {
  const state = (at, fields) => ({
    attemptCount: 1,
    claimedBy: "victim",
    fileName: "a.pdf",
    holdsUpload: false,
    outputs: {},
    stage: "parse",
    stageAttempts: 1,
    status: "running",
    ...fields,
    at,
  });
  const pages = { document_file: 101, pages: 101 };
  const chunks = { ...pages, chunks: 102 };
  const histories = {
    // Died in embed, resumed there by another worker.
    resumed: [
      state(100, { holdsUpload: true }),
      state(101, { outputs: pages, stage: "chunk" }),
      state(102, { outputs: chunks, stage: "embed" }),
      state(9000, { attemptCount: 2, claimedBy: "survivor", outputs: chunks, stage: "embed", stageAttempts: 2 }),
      state(9300, { attemptCount: 2, claimedBy: "survivor", outputs: { ...chunks, embeddings: 9290 }, stage: "index" }),
      state(9400, { attemptCount: 2, claimedBy: "survivor", outputs: {}, stage: "index", status: "succeeded" }),
    ],
    // A broken resume that parsed again.
    reparsed: [
      state(100, { fileName: "b.pdf", outputs: chunks, stage: "embed" }),
      state(9000, { attemptCount: 2, claimedBy: "survivor", fileName: "b.pdf", holdsUpload: true, outputs: chunks, stage: "parse" }),
      state(9100, { attemptCount: 2, claimedBy: "survivor", fileName: "b.pdf", outputs: { ...chunks, pages: 9100 }, stage: "chunk" }),
    ],
    finished: [state(100, { fileName: "c.pdf", stage: "index", status: "succeeded" })],
    untouched: [state(100, { claimedBy: "survivor", fileName: "d.pdf" })],
  };
  const report = analyzeCrashedJobs({ histories, killedAt: 500, victimWorkerId: "victim" });
  const byFile = Object.fromEntries(report.jobs.map((job) => [job.fileName, job]));

  assert.equal(report.strandedAtKill, 2);
  assert.equal(report.resumed, 2);
  assert.equal(report.resumedAtStageOfCrash, 1);
  assert.equal(report.resumedWithoutEarlierStage, 1);
  assert.equal(report.lastResumedFinishedAfterKillMs, 8900, "the broken resume never finished");
  assert.deepEqual(byFile["a.pdf"], {
    earlierStagesRerun: [],
    fileName: "a.pdf",
    finalStatus: "succeeded",
    finishedAfterKillMs: 8900,
    jobId: "resumed",
    leaseWaitMs: 8500,
    outcome: "resumed",
    outputsAtKill: ["chunks", "document_file", "pages"],
    outputsRewrittenAfterResume: [],
    resumedAttempt: 2,
    resumedAtStage: "embed",
    resumedBy: "survivor",
    stageAtKill: "embed",
    uploadBytesOnRowAtResume: false,
  });
  assert.deepEqual(byFile["b.pdf"].earlierStagesRerun, ["parse", "chunk"]);
  assert.deepEqual(byFile["b.pdf"].outputsRewrittenAfterResume, ["pages"]);
  assert.equal(byFile["c.pdf"].outcome, "finished_before_kill");
  assert.equal(byFile["d.pdf"], undefined, "a job the victim never held is not part of the crash");
});

test("document embeddings come from the dedicated workers' own requests, per searchable document", () => {
  const byCaller = {
    "load-test-api-0": { chat: 40, embeddingInputs: 12, embeddings: 12 },
    "load-test-worker-0": { chat: 0, embeddingInputs: 96, embeddings: 3 },
    "load-test-worker-1": { chat: 0, embeddingInputs: 160, embeddings: 5 },
  };

  assert.deepEqual(describeWorkerEmbeddings({ byCaller, documents: 64 }), {
    inputs: 256,
    inputsPerRequest: 32,
    perWorker: {
      "load-test-worker-0": { inputs: 96, requests: 3 },
      "load-test-worker-1": { inputs: 160, requests: 5 },
    },
    requests: 8,
    requestsPerDocument: 0.125,
  });
  assert.equal(describeWorkerEmbeddings({ byCaller: { "load-test-api-0": byCaller["load-test-api-0"] }, documents: 4 }), null);
});

test("the seed corpus can be uploaded as PDFs that parse back to its sentences", async (t) => {
  const { loadPdfPages } = await import("../rag/pdf-loader.js");
  const [doc] = buildSyntheticCorpus({ documents: 1, pages: 2 }).documents;
  const directory = await mkdtemp(path.join(os.tmpdir(), "seed-pdf-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "seed.pdf");

  await writeFile(filePath, buildSeedPdf(doc));
  const pages = await loadPdfPages(filePath);

  assert.equal(pages.length, 2);
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  assert.equal(normalize(pages[1].text), normalize(doc.pages[1].text));
});

test("the index switch and crash reports render with their notes", () => {
  const options = parseLoadTestArgs([...database, "--scenario", "index-switch", "--instances", "2"]);
  assert.ok(buildMethodNotes(options).includes(INDEX_SWITCH_NOTES[0]));
  const crashOptions = parseLoadTestArgs([
    ...database,
    "--scenario",
    "ingest",
    "--ingest-mode",
    "async",
    "--ingest-workers",
    "2",
    "--crash-worker-mid-embed",
    "--embed-batching",
    "on",
  ]);
  const crashNotes = buildMethodNotes(crashOptions);
  assert.ok(crashNotes.includes(buildCrashNotes()[0]));
  assert.ok(crashNotes.some((note) => note.startsWith("Embedding batching on")));

  const latency = { count: 1, max: 5, mean: 5, min: 5, p50: 5, p95: 5, p99: 5 };
  const phase = (name, extra = {}) => ({
    durationMs: 100,
    errorCounts: {},
    errors: 0,
    groundedAnswers: 1,
    kind: "phase",
    latencyMs: latency,
    name,
    perInstance: [{ errors: 0, latencyMs: latency, requests: 1 }],
    requests: 1,
    statusCounts: { 200: 1 },
    throughputRps: 10,
    ...extra,
  });
  const propagation = { allInstancesMs: 1900, perInstance: [{ firstSearchOnNewMs: 1900, instance: 0, lastSearchOnOldMs: 1905, tableChangesAfterSwitch: 2 }] };
  const markdown = formatLoadTestMarkdown({
    config: {
      ...options,
      cpuCount: 8,
      embeddingLatencyPerInputMs: 0,
      modelLatencyMs: [0],
      questions: 80,
      storage: ["pgvector"],
    },
    generatedAt: "2026-09-27T00:00:00.000Z",
    method: { notes: [], percentile: "nearest-rank" },
    runs: [
      {
        ingest: { chunkCount: 80, documentCount: 20, ingestMs: 1, vectorStore: null },
        instances: [{ index: 0, port: 1 }, { index: 1, port: 2 }],
        scenarios: [
          {
            activation: {
              commandWallMs: 400,
              exitCode: 0,
              firstNewSpaceQueryEmbeddingMs: [1850],
              fromVersionId: 1,
              generation: "2",
              pointerPollResolutionMs: 6,
              propagation,
              toVersionId: 2,
              validation: { ok: true, reasons: [], totals: { activeChunks: 80, documents: 20, targetChunks: 80 } },
              visibleAfterCommandStartMs: 350,
            },
            build: { chunkCount: 80, cliWallMs: 900, dimensions: 768, docsPerSecond: 40, docsPerSecondIncludingCli: 22, embeddingInputs: 80, embeddingRequests: 20, failed: 0, indexed: 20, model: "load-test-embedding-768", registryBuildMs: 500, versionId: 2 },
            embeddingLatencyMs: 0,
            endpoint: "POST /chat during build, activate and rollback",
            errors: [],
            kind: "index-switch",
            modelLatencyMs: 0,
            phases: [
              phase("before", { model: { embeddingRequests: 0, embeddingRequestsPerChat: 0, embeddingsByModel: {} } }),
              phase("activation switchover (first 3000 ms)", { kind: "window" }),
            ],
            pointerAtEnd: { activeVersionId: 1 },
            pointerTtlMs: 2000,
            requests: 2,
            rollback: { commandWallMs: 300, exitCode: 0, fromVersionId: 2, generation: "3", pointerPollResolutionMs: 5, propagation, toVersionId: 1, validation: null, visibleAfterCommandStartMs: 250 },
            totalErrors: 0,
            versions: [
              { chunkCount: 80, chunkTable: "rag_document_chunks", embeddingDimensions: 1536, embeddingModel: "", inDualWriteWindow: false, status: "active", versionId: 1 },
              { chunkCount: 80, chunkTable: "rag_document_chunks_v2", embeddingDimensions: 768, embeddingModel: "load-test-embedding-768", inDualWriteWindow: true, status: "ready", versionId: 2 },
            ],
          },
        ],
        storage: "pgvector",
      },
    ],
  });

  assert.match(markdown, /\| Scenario \| index-switch \|/);
  assert.match(markdown, /Build of version 2 \(load-test-embedding-768, 768 dimensions\) under \/chat load: 20 documents indexed/);
  assert.match(markdown, /Every instance searched version 2 1900 ms after the switch was seen/);
  assert.match(markdown, /\| _activation switchover \(first 3000 ms\)_ \|/);
  assert.match(markdown, /2 ready \(rag_document_chunks_v2, load-test-embedding-768\/768, 80 chunks, still dual-written\)/);
});

test("the crash table lists every job the killed worker held, with where it resumed", () => {
  const lines = [];
  const level = {
    crash: {
      heldRequest: { documents: ["Ember-x-5", "Lantern-x-12"], inputs: 8 },
      jobs: [
        {
          earlierStagesRerun: [],
          fileName: "program-ember-x-5-manual.pdf",
          finalStatus: "succeeded",
          leaseWaitMs: 8749,
          outcome: "resumed",
          outputsAtKill: ["chunks", "document_file", "pages"],
          outputsRewrittenAfterResume: [],
          resumedAtStage: "embed",
          resumedAttempt: 2,
          stageAtKill: "embed",
          uploadBytesOnRowAtResume: false,
        },
        { fileName: "program-done-manual.pdf", finalStatus: "succeeded", outcome: "finished_before_kill" },
      ],
      killTookMs: 5,
      killed: true,
      resumed: 1,
      resumedAtStageOfCrash: 1,
      resumedWithoutEarlierStage: 1,
      strandedAtKill: 1,
      victimWorkerId: "host:1:abc",
    },
  };

  formatCrashReport(lines, level, "64");
  const text = lines.join("\n");

  assert.match(text, /Crash injection \(upload concurrency 64\)/);
  assert.match(text, /embeddings request of 8 text\(s\) from 2 document\(s\) \(Ember-x-5, Lantern-x-12\)/);
  assert.match(
    text,
    /\| program-ember-x-5-manual\.pdf \| embed \| chunks, document_file, pages \| embed \| 2 \| no \| none \| none \| 8749 \| - \| succeeded \|/
  );
  assert.doesNotMatch(text, /program-done-manual/);

  const quiet = [];
  formatCrashReport(quiet, { crash: { killed: false } }, "4");
  assert.match(quiet.join("\n"), /nothing was killed/);
});

test("seed names beyond the 20 base names compound them without a digit and never repeat", () => {
  const names = Array.from({ length: 1000 }, (_, index) => projectName(index));

  assert.equal(names[0], "Aster");
  assert.equal(names[19], "Tamarack");
  assert.equal(names[20], "Asterbirch");
  assert.equal(names[400], "Asterasterbirch");
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => /^[A-Z][a-z]+$/.test(name)), "letters only: a digit makes the file name a document label");
});
