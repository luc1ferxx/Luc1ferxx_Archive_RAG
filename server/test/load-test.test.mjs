import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INGEST_EMBEDDING_LATENCY_MS,
  DEFAULT_INGEST_LATEST_NAME,
  DEFAULT_LOAD_TEST_OPTIONS,
  EVENT_LOOP_SAMPLING_MS,
  INGEST_METHOD_NOTES,
  LOAD_TEST_METHOD_NOTES,
  MULTI_INSTANCE_METHOD_NOTES,
  buildAppEnvironment,
  buildFakeChatAnswer,
  buildMethodNotes,
  buildMultipartFileBody,
  buildSyntheticCorpus,
  combineServerStats,
  countByInstance,
  eventLoopExcessDelayMs,
  formatLoadTestMarkdown,
  hashEmbedding,
  observedPeakInFlight,
  parseLoadTestArgs,
  percentile,
  readChatOutcome,
  roundRobinIndex,
  runClosedLoop,
  runClosedLoopUntil,
  startFakeModelServer,
  summarizeIngestLevel,
  summarizeLatencies,
  summarizeLevel,
  visibilityCheckInstance,
} from "../evaluation/run-api-load-bench.mjs";

test("percentile uses the nearest-rank method", () => {
  const values = [15, 20, 35, 40, 50];

  assert.equal(percentile(values, 0), 15);
  assert.equal(percentile(values, 30), 20); // ceil(1.5) = rank 2
  assert.equal(percentile(values, 40), 20); // rank 2 exactly
  assert.equal(percentile(values, 50), 35);
  assert.equal(percentile(values, 100), 50);
  assert.equal(percentile([], 50), null);
  // Order of the input does not matter and non-finite samples are ignored.
  assert.equal(percentile([50, Number.NaN, 15, 40, 20, 35], 50), 35);
  assert.throws(() => percentile(values, 101), RangeError);
});

test("p99 of fewer than 100 samples is the maximum", () => {
  const values = Array.from({ length: 64 }, (_, index) => index + 1);

  assert.equal(percentile(values, 99), 64);
  assert.equal(percentile(Array.from({ length: 200 }, (_, index) => index + 1), 99), 198);
});

test("event-loop delay drops the sampling interval that monitorEventLoopDelay records", () => {
  assert.equal(EVENT_LOOP_SAMPLING_MS, 10);
  // An idle loop sampled every 10 ms records about 10 ms per interval.
  assert.equal(eventLoopExcessDelayMs(10.3e6), 0.3);
  assert.equal(eventLoopExcessDelayMs(9.05e6), 0);
  assert.equal(eventLoopExcessDelayMs(84.7e6), 74.7);
  assert.equal(eventLoopExcessDelayMs(3.5e6, 1), 2.5);
  assert.equal(eventLoopExcessDelayMs(Number.NaN), null);
});

test("latency summary rounds to 0.1 ms and handles no samples", () => {
  assert.deepEqual(summarizeLatencies([1, 2, 3, 4, 100]), {
    count: 5,
    max: 100,
    mean: 22,
    min: 1,
    p50: 3,
    p95: 100,
    p99: 100,
  });
  assert.equal(summarizeLatencies([]).p50, null);
});

test("level summary separates errors from latency and computes throughput", () => {
  const summary = summarizeLevel({
    results: [
      { latencyMs: 10, status: 200, agentMode: "document", grounded: true },
      { latencyMs: 20, status: 200, agentMode: "document", grounded: false },
      { latencyMs: 5, status: 429 },
      { error: "timeout", latencyMs: 900, status: 0 },
    ],
    wallMs: 2000,
  });

  assert.equal(summary.requests, 4);
  assert.equal(summary.ok, 2);
  assert.equal(summary.errors, 2);
  assert.equal(summary.errorRate, 0.5);
  assert.equal(summary.throughputRps, 2);
  assert.equal(summary.goodputRps, 1);
  // Only 2xx responses feed the percentiles.
  assert.equal(summary.latencyMs.count, 2);
  assert.equal(summary.latencyMs.max, 20);
  assert.deepEqual(summary.statusCounts, { 200: 2, 429: 1, no_response: 1 });
  assert.deepEqual(summary.errorCounts, { http_429: 1, timeout: 1 });
  assert.deepEqual(summary.agentModes, { document: 2 });
  assert.equal(summary.groundedAnswers, 1);
});

test("closed loop never exceeds its concurrency and sends exactly the requested count", async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  const { results, wallMs } = await runClosedLoop({
    concurrency: 3,
    requests: 10,
    send: async ({ index }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      seen.push(index);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (index === 4) throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
      return { status: 200 };
    },
  });

  assert.equal(peak, 3);
  assert.equal(results.length, 10);
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(results[4].error, "ECONNRESET");
  assert.equal(results[4].status, 0);
  assert.ok(results.every((result) => Number.isFinite(result.latencyMs)));
  assert.ok(wallMs >= 0);
});

test("argument parsing fills defaults and validates storage against the database URL", () => {
  const defaults = parseLoadTestArgs([]);
  assert.deepEqual(defaults.concurrency, [1, 4, 16, 32]);
  assert.deepEqual(defaults.modelLatencyMs, [0, 800]);
  assert.deepEqual(defaults.storage, ["local"]);
  assert.equal(defaults.auth, false);
  assert.equal(defaults.rateLimit, false);
  assert.equal(defaults.llmMaxConcurrency, DEFAULT_LOAD_TEST_OPTIONS.llmMaxConcurrency);

  const withDatabase = parseLoadTestArgs([
    "--database-url",
    "postgresql://u:p@127.0.0.1:6000/db",
    "--concurrency=2,8",
    "--requests",
    "10",
    "--auth",
    "--no-embedding-cache",
  ]);
  assert.deepEqual(withDatabase.storage, ["pgvector", "local"]);
  assert.deepEqual(withDatabase.concurrency, [2, 8]);
  assert.equal(withDatabase.requests, 10);
  assert.equal(withDatabase.auth, true);
  assert.equal(withDatabase.embeddingCache, false);

  assert.throws(() => parseLoadTestArgs(["--storage", "pgvector"]), /database-url/);
  assert.throws(() => parseLoadTestArgs(["--concurrency", "0,4"]), /at least 1/);
  assert.throws(() => parseLoadTestArgs(["--bogus", "1"]), /Unknown flag/);
  assert.throws(() => parseLoadTestArgs(["--planner", "magic"]), /planner/);
});

test("the app environment pins every store and model setting and drops inherited ones", () => {
  const options = parseLoadTestArgs([]);
  const base = {
    HOME: "/home/test",
    OPENAI_API_KEY: "sk-real",
    PATH: "/usr/bin",
    POSTGRES_DATABASE_URL: "postgresql://real:5432/prod",
    REDIS_URL: "redis://real",
  };
  const local = buildAppEnvironment({
    baseEnvironment: base,
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options,
    storage: "local",
    tempRoot: "/tmp/load",
  });

  assert.equal(local.PATH, "/usr/bin");
  assert.equal(local.OPENAI_API_KEY, "load-test");
  assert.equal(local.OPENAI_BASE_URL, "http://127.0.0.1:1/v1");
  assert.equal(local.POSTGRES_DATABASE_URL, undefined);
  assert.equal(local.REDIS_URL, undefined);
  assert.equal(local.DOCCOMPARE_STANDALONE, "1");
  assert.equal(local.API_AUTH_ENABLED, "false");
  assert.equal(local.RATE_LIMIT_ENABLED, "false");
  assert.equal(local.RAG_LLM_MAX_CONCURRENCY, "8");
  assert.equal(local.AGENT_PLANNER_ROLLOUT, "deterministic");

  const pg = buildAppEnvironment({
    authToken: "token",
    baseEnvironment: base,
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:6000/loadtest",
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options: { ...options, auth: true, planner: "llm" },
    storage: "pgvector",
    tempRoot: "/tmp/load",
  });

  assert.equal(pg.VECTOR_STORE_PROVIDER, "pgvector");
  assert.equal(pg.POSTGRES_DATABASE_URL, "postgresql://postgres:postgres@127.0.0.1:6000/loadtest");
  assert.equal(pg.LONG_MEMORY_DATABASE_URL, pg.POSTGRES_DATABASE_URL);
  assert.equal(pg.DOCCOMPARE_STANDALONE, undefined);
  assert.equal(pg.API_AUTH_ENABLED, "true");
  assert.equal(pg.API_AUTH_TOKEN, "token");
  assert.equal(pg.AGENT_PLANNER_ROLLOUT, "llm");
});

test("synthetic corpus is deterministic with one answerable question per page", () => {
  const corpus = buildSyntheticCorpus({ docIdPrefix: "t", documents: 3, pages: 4 });

  assert.equal(corpus.documents.length, 3);
  assert.equal(corpus.questions.length, 12);
  assert.deepEqual(corpus, buildSyntheticCorpus({ docIdPrefix: "t", documents: 3, pages: 4 }));
  assert.equal(corpus.documents[0].docId, "t-001");
  assert.match(corpus.documents[0].pages[0].text, /retention period for Project Aster records is \d+ days/);
  assert.equal(corpus.questions[0].docId, "t-001");
  assert.match(corpus.questions[0].question, /retention period for Project Aster/);
});

test("hashed embeddings are unit length, deterministic and closer for shared words", () => {
  const cosine = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
  const query = hashEmbedding("retention period for Project Birch records", 256);
  const related = hashEmbedding("The retention period for Project Birch records is 37 days.", 256);
  const unrelated = hashEmbedding("Capacity plans are revisited each fiscal quarter.", 256);

  assert.equal(query.length, 256);
  assert.ok(Math.abs(cosine(query, query) - 1) < 1e-9);
  assert.deepEqual(query, hashEmbedding("retention period for Project Birch records", 256));
  assert.ok(cosine(query, related) > cosine(query, unrelated));
  assert.equal(hashEmbedding("", 8).length, 8);
});

test("fake chat answer cites the first evidence sentence of Source 1", () => {
  const prompt = [
    "Question: What is the retention period?",
    "",
    "Source 1",
    "File: project-aster-handbook.pdf",
    "Page: 1",
    "Evidence:",
    "Project Aster handbook, section 1. The retention period for Project Aster records is 30 days. Other text.",
    "",
    "Source 2",
    "File: other.pdf",
    "Evidence:",
    "Unrelated.",
  ].join("\n");

  assert.equal(
    buildFakeChatAnswer({ messages: [{ content: prompt, role: "user" }] }),
    "The retention period for Project Aster records is 30 days. [Source 1]"
  );
  assert.equal(
    buildFakeChatAnswer({ messages: [{ content: "plan this", role: "user" }], response_format: { type: "json_schema" } }),
    "{}"
  );
  assert.match(buildFakeChatAnswer({ messages: [{ content: "hello", role: "user" }] }), /do not contain/);
});

test("chat outcome reads the agent mode and whether the answer is grounded", () => {
  assert.deepEqual(
    readChatOutcome({ agentAnswer: "The period is 30 days. [Source 1]", agentMode: "document", ragSources: [] }),
    { agentMode: "document", grounded: true }
  );
  assert.deepEqual(readChatOutcome({ agentAnswer: "No answer.", ragSources: [{ rank: 1 }] }), {
    agentMode: null,
    grounded: true,
  });
  assert.deepEqual(readChatOutcome({}), { agentMode: null, grounded: false });
});

test("fake model server answers both routes, delays chat and tracks peak in flight", async (t) => {
  const server = await startFakeModelServer({ chatLatencyMs: 30, dimensions: 16 });
  t.after(() => server.close());
  const post = (route, body) =>
    fetch(`${server.baseUrl}${route}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).then((response) => response.json());

  const embeddings = await post("/embeddings", { input: ["a b", "c"], model: "m" });
  assert.equal(embeddings.data.length, 2);
  assert.equal(embeddings.data[0].embedding.length, 16);

  const startedAt = Date.now();
  const answers = await Promise.all(
    [1, 2, 3].map(() => post("/chat/completions", { messages: [{ content: "hi", role: "user" }], model: "m" }))
  );
  assert.ok(Date.now() - startedAt >= 25);
  assert.equal(answers[0].choices[0].message.role, "assistant");

  const snapshot = server.snapshot();
  assert.equal(snapshot.chat.requests, 3);
  assert.equal(snapshot.chat.peakInFlight, 3);
  assert.equal(snapshot.embeddings.requests, 1);
  assert.equal(snapshot.embeddings.inputs, 2);

  server.resetStats();
  server.setLatency({ chatMs: 0 });
  assert.equal(server.snapshot().chat.requests, 0);

  // At 0 ms the fake answers in the same tick it reads each request, so even
  // truly concurrent requests never overlap there: the peak is not observable.
  await Promise.all(
    [1, 2, 3, 4].map(() => post("/chat/completions", { messages: [{ content: "hi", role: "user" }], model: "m" }))
  );
  assert.equal(server.snapshot().chat.peakInFlight, 1);
  assert.equal(observedPeakInFlight({ latencyMs: 0, peak: 1 }), null);
  assert.equal(observedPeakInFlight({ latencyMs: 30, peak: 3 }), 3);
});

test("markdown report has the config and one table per scenario", () => {
  const level = {
    concurrency: 4,
    errorCounts: { http_429: 1 },
    errorRate: 0.1,
    errors: 1,
    latencyMs: { max: 30, p50: 10, p95: 20, p99: 30 },
    model: { chatCompletionsPerRequest: 1, embeddingRequestsPerRequest: 0.5, peakChatInFlight: 4 },
    agentModes: { document: 9 },
    groundedAnswers: 9,
    requests: 10,
    server: { cpuMsPerRequest: 12.5, eventLoopDelayP99Ms: 20 },
    throughputRps: 50,
  };
  const markdown = formatLoadTestMarkdown({
    config: {
      auth: false,
      cheapPath: "/documents",
      cheapRequests: 100,
      concurrency: [4],
      cpuCount: 8,
      cpuModel: "cpu",
      documents: 2,
      embeddingCache: true,
      embeddingDimensions: 16,
      embeddingLatencyMs: 0,
      gitDirty: true,
      gitSha: "abc123",
      llmMaxConcurrency: 8,
      modelLatencyMs: [0, 800],
      nodeVersion: "v24.0.0",
      pages: 2,
      planner: "deterministic",
      platform: "darwin",
      questions: 4,
      rateLimit: false,
      requests: 10,
      storage: ["local"],
      totalMemoryGb: 16,
      warmup: 8,
    },
    generatedAt: "2026-09-26T00:00:00.000Z",
    method: { notes: ["note"], percentile: "nearest-rank" },
    runs: [
      {
        ingest: {
          chunkCount: 4,
          databaseChunkRows: 4,
          documentCount: 2,
          ingestMs: 12,
          vectorStore: {
            denseBackend: "pgvector",
            hybridFusion: "rrf",
            sparseBackend: "postgres_fts",
            vectorStoreProvider: "pgvector",
          },
        },
        scenarios: [
          { endpoint: "GET /documents", kind: "cheap", levels: [{ ...level, agentModes: undefined }] },
          { endpoint: "POST /chat", kind: "chat", levels: [level], modelLatencyMs: 800 },
        ],
        storage: "local",
      },
    ],
  });

  assert.match(markdown, /Git SHA \| abc123 \(dirty worktree\)/);
  assert.match(markdown, /RAG_LLM_MAX_CONCURRENCY \| 8/);
  assert.match(markdown, /### GET \/documents/);
  assert.match(markdown, /### POST \/chat, model latency 800 ms/);
  assert.match(markdown, /\| 4 \| 10 \| 1 \| 0.1 \| 50 \| 10 \| 20 \| 30 \| 30 \| 1 \| 0.5 \| 4 \| 12.5 \| 20 \| document 9, cited 9 \|/);
  assert.match(markdown, /c=4: http_429 x1/);
  assert.match(markdown, /pgvector \(dense pgvector, sparse postgres_fts, rrf fusion\); 4 chunk rows counted in PostgreSQL/);
});

test("round robin spreads request indexes evenly and picks the next instance for visibility checks", () => {
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) => roundRobinIndex(index, 3)),
    [0, 1, 2, 0, 1, 2, 0]
  );
  assert.equal(roundRobinIndex(5, 1), 0);
  assert.throws(() => roundRobinIndex(0, 0), RangeError);
  assert.throws(() => roundRobinIndex(-1, 2), RangeError);

  // Another instance than the one that took the upload, when there is one.
  assert.equal(visibilityCheckInstance(0, 3), 1);
  assert.equal(visibilityCheckInstance(2, 3), 0);
  assert.equal(visibilityCheckInstance(0, 1), 0);
});

test("per-instance counts split requests and errors by the instance that served them", () => {
  const counts = countByInstance(
    [
      { instance: 0, status: 200 },
      { instance: 1, status: 200 },
      { instance: 0, status: 500 },
      { instance: 1, status: 0, error: "timeout" },
      { status: 200 },
      null,
    ],
    3
  );

  assert.deepEqual(counts, [
    { errors: 1, requests: 2 },
    { errors: 1, requests: 2 },
    { errors: 0, requests: 0 },
  ]);
});

test("server stats of several processes sum CPU and memory and keep the worst event-loop delay", () => {
  const combined = combineServerStats(
    [
      { cpuSystemMs: 10, cpuUserMs: 90, eventLoopDelayMaxMs: 30, eventLoopDelayP99Ms: 4, rssMb: 100 },
      { cpuSystemMs: 5, cpuUserMs: 45, eventLoopDelayMaxMs: 12, eventLoopDelayP99Ms: 9.5, rssMb: 120.5 },
    ],
    30
  );

  assert.deepEqual(combined, {
    cpuMsPerUnit: 5,
    cpuSystemMs: 15,
    cpuUserMs: 135,
    eventLoopDelayMaxMs: 30,
    eventLoopDelayP99Ms: 9.5,
    rssMb: 220.5,
  });
  // One process: the fields are that process's own.
  assert.equal(combineServerStats([{ cpuSystemMs: 1, cpuUserMs: 3, eventLoopDelayP99Ms: 2, rssMb: 50 }], 2).cpuMsPerUnit, 2);
  assert.equal(combineServerStats([], 0).cpuMsPerUnit, null);
  assert.equal(combineServerStats([{}], 1).eventLoopDelayP99Ms, null);
});

test("the open-ended closed loop keeps its concurrency until told to stop and keeps in-flight results", async () => {
  let inFlight = 0;
  let peak = 0;
  let sent = 0;
  const { results } = await runClosedLoopUntil({
    concurrency: 2,
    send: async ({ index }) => {
      sent += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (index === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return { status: 200 };
    },
    shouldStop: () => sent >= 5,
  });

  assert.equal(peak, 2);
  // The stop check runs before each request, so both workers may start one
  // more after the fifth was sent; every started request is kept.
  assert.equal(results.length, sent);
  assert.ok(results.every(Boolean));
  assert.equal(results[1].error, "ECONNRESET");
  assert.equal(results[1].status, 0);

  const idle = await runClosedLoopUntil({ concurrency: 0, send: async () => ({ status: 200 }), shouldStop: () => false });
  assert.equal(idle.results.length, 0);
});

test("ingest level summary counts searchable documents, errors and cross-instance listings", () => {
  const summary = summarizeIngestLevel({
    results: [
      { acceptedMs: 5, ingestedMs: 400, instance: 0, listedOnOtherInstance: true, searchableMs: 450, status: 202 },
      { acceptedMs: 7, ingestedMs: 600, instance: 1, listedOnOtherInstance: true, searchableMs: 650, status: 202 },
      { acceptedMs: 6, error: "job_failed", instance: 0, jobError: "No extractable text.", status: 202 },
      { acceptedMs: 6, error: "not_listed_on_other_instance", instance: 1, listedOnOtherInstance: false, status: 202 },
      { acceptedMs: 3, instance: 0, status: 413 },
    ],
    wallMs: 1000,
  });

  assert.equal(summary.uploads, 5);
  assert.equal(summary.accepted, 4);
  assert.equal(summary.searchable, 2);
  assert.equal(summary.errors, 3);
  assert.equal(summary.errorRate, 0.6);
  assert.equal(summary.throughputDocsPerSecond, 2);
  assert.equal(summary.crossInstanceChecks, 3);
  assert.equal(summary.listedOnOtherInstance, 2);
  // Upload latency covers every accepted upload; searchable time only the
  // documents that became searchable.
  assert.equal(summary.uploadLatencyMs.count, 4);
  assert.equal(summary.uploadLatencyMs.max, 7);
  assert.deepEqual([summary.searchableMs.count, summary.searchableMs.max], [2, 650]);
  assert.equal(summary.ingestedMs.p50, 400);
  assert.deepEqual(summary.statusCounts, { 202: 4, 413: 1 });
  assert.deepEqual(summary.errorCounts, { http_413: 1, job_failed: 1, not_listed_on_other_instance: 1 });

  // Sync mode on one instance: the 201 is searchable time, no listing look.
  const sync = summarizeIngestLevel({
    results: [{ acceptedMs: 60, ingestedMs: 60, instance: 0, searchableMs: 60, status: 201 }],
    wallMs: 100,
  });
  assert.equal(sync.crossInstanceChecks, undefined);
  assert.equal(sync.searchableMs.p50, 60);
  assert.equal(summarizeIngestLevel().throughputDocsPerSecond, null);
});

test("the multipart upload body is one file part a multer single-file route accepts", () => {
  const body = buildMultipartFileBody({ boundary: "XyZ", content: Buffer.from("%PDF-1.4 x"), fileName: "a b.pdf" });

  assert.equal(
    body.toString("utf8"),
    '--XyZ\r\nContent-Disposition: form-data; name="file"; filename="a b.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 x\r\n--XyZ--\r\n'
  );
});

test("argument parsing: instances, shared state and the ingest scenario", () => {
  const database = ["--database-url", "postgresql://u:p@127.0.0.1:6000/db"];
  const cluster = parseLoadTestArgs([...database, "--instances", "3"]);
  assert.equal(cluster.instances, 3);
  // Several processes need the shared store, so pgvector alone is the default.
  assert.deepEqual(cluster.storage, ["pgvector"]);
  assert.equal(cluster.sharedState, "memory");
  assert.throws(() => parseLoadTestArgs(["--instances", "2"]), /database-url/);
  assert.throws(() => parseLoadTestArgs([...database, "--instances", "2", "--storage", "local"]), /pgvector/);
  assert.throws(() => parseLoadTestArgs(["--instances", "0"]), /positive integer/);

  const redis = parseLoadTestArgs(["--redis-url", "redis://127.0.0.1:7000"]);
  assert.equal(redis.sharedState, "redis");
  assert.throws(() => parseLoadTestArgs(["--shared-state", "redis"]), /redis-url/);
  assert.throws(() => parseLoadTestArgs(["--shared-state", "memory", "--redis-url", "redis://x"]), /only applies/);
  assert.throws(() => parseLoadTestArgs(["--shared-state", "etcd"]), /memory or redis/);

  const ingest = parseLoadTestArgs(["--scenario", "ingest"]);
  assert.equal(ingest.scenario, "ingest");
  assert.equal(ingest.ingestMode, "sync");
  assert.equal(ingest.embeddingLatencyMs, DEFAULT_INGEST_EMBEDDING_LATENCY_MS);
  assert.equal(ingest.latestName, DEFAULT_INGEST_LATEST_NAME);
  assert.deepEqual(ingest.uploadConcurrency, [4]);
  assert.deepEqual(ingest.storage, ["local"]);

  const async = parseLoadTestArgs([
    ...database,
    "--scenario=ingest",
    "--ingest-mode",
    "async",
    "--ingest-workers",
    "2",
    "--embedding-latency-ms",
    "0",
    "--upload-concurrency",
    "1,8",
    "--latest-name",
    "custom",
  ]);
  assert.equal(async.ingestWorkers, 2);
  assert.equal(async.embeddingLatencyMs, 0);
  assert.deepEqual(async.uploadConcurrency, [1, 8]);
  assert.equal(async.latestName, "custom");
  assert.deepEqual(async.storage, ["pgvector"]);

  assert.throws(() => parseLoadTestArgs(["--uploads", "4"]), /only apply to --scenario ingest/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--ingest-workers", "1"]), /ingest-mode async/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--ingest-mode", "later"]), /sync or async/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--upload-concurrency", "0"]), /at least 1/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "replay"]), /chat or ingest/);
  // The chat scenario keeps its defaults.
  assert.equal(parseLoadTestArgs([]).embeddingLatencyMs, 0);
  assert.equal(parseLoadTestArgs([]).latestName, "latest-load-test");
});

test("the app environment carries the ingest mode, worker role and a per-run Redis prefix", () => {
  const base = { DOTENV_CONFIG_PATH: "/real/.env", PATH: "/usr/bin", RAG_INGEST_WORKER_ENABLED: "true", REDIS_URL: "redis://real:6379" };
  const options = parseLoadTestArgs([
    "--database-url",
    "postgresql://u:p@127.0.0.1:6000/db",
    "--scenario",
    "ingest",
    "--ingest-mode",
    "async",
    "--ingest-workers",
    "1",
    "--ingest-worker-concurrency",
    "3",
    "--redis-url",
    "redis://127.0.0.1:7001",
  ]);
  const shared = {
    baseEnvironment: base,
    databaseUrl: options.databaseUrl,
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options,
    runId: "abc",
    storage: "pgvector",
    tempRoot: "/tmp/load",
  };
  const api = buildAppEnvironment(shared);
  const worker = buildAppEnvironment({ ...shared, role: "worker" });

  assert.equal(api.RAG_INGEST_MODE, "async");
  // Dedicated workers take the jobs, so the API processes run no loop.
  assert.equal(api.RAG_INGEST_WORKER_ENABLED, "false");
  assert.equal(worker.RAG_INGEST_WORKER_ENABLED, "true");
  assert.equal(worker.LOAD_TEST_ROLE, "worker");
  assert.equal(api.RAG_INGEST_WORKER_CONCURRENCY, "3");
  assert.equal(api.RAG_SHARED_STATE, "redis");
  assert.equal(api.REDIS_URL, "redis://127.0.0.1:7001");
  assert.equal(api.RAG_SHARED_STATE_PREFIX, "archive_rag_load_test:abc:");
  assert.equal(api.DOTENV_CONFIG_PATH, "/tmp/load/empty.env");
  assert.equal(api.PDF_PARSER, "pdfjs");

  // Chat defaults: sync ingest, per-process guard state, the app's own worker default.
  const chat = buildAppEnvironment({ ...shared, options: parseLoadTestArgs([]), storage: "local" });
  assert.equal(chat.RAG_INGEST_MODE, "sync");
  assert.equal(chat.RAG_SHARED_STATE, "memory");
  assert.equal(chat.REDIS_URL, undefined);
  assert.equal(chat.RAG_INGEST_WORKER_ENABLED, undefined);
});

test("method notes add the multi-instance and ingest notes only where they apply", () => {
  assert.deepEqual(buildMethodNotes({ instances: 1, scenario: "chat" }), [...LOAD_TEST_METHOD_NOTES]);
  assert.deepEqual(buildMethodNotes({ instances: 2, scenario: "chat" }), [
    ...LOAD_TEST_METHOD_NOTES,
    ...MULTI_INSTANCE_METHOD_NOTES,
  ]);
  assert.deepEqual(buildMethodNotes({ ingestWorkers: 1, instances: 1, scenario: "ingest" }), [
    ...LOAD_TEST_METHOD_NOTES,
    ...MULTI_INSTANCE_METHOD_NOTES,
    ...INGEST_METHOD_NOTES,
  ]);
});

const reportConfig = (overrides = {}) => ({
  auth: false,
  cheapPath: "/documents",
  cheapRequests: 100,
  concurrency: [4],
  cpuCount: 8,
  cpuModel: "cpu",
  documents: 2,
  embeddingCache: true,
  embeddingDimensions: 16,
  embeddingLatencyMs: 0,
  gitDirty: false,
  gitSha: "abc123",
  llmMaxConcurrency: 8,
  modelLatencyMs: [800],
  nodeVersion: "v24.0.0",
  pages: 2,
  planner: "deterministic",
  platform: "darwin",
  questions: 4,
  rateLimit: false,
  requests: 10,
  storage: ["pgvector"],
  totalMemoryGb: 16,
  warmup: 8,
  ...overrides,
});

const reportIngest = {
  chunkCount: 4,
  databaseChunkRows: 4,
  documentCount: 2,
  ingestMs: 12,
  vectorStore: { denseBackend: "pgvector", sparseBackend: "postgres_fts", vectorStoreProvider: "pgvector" },
};

test("markdown report of a multi-instance chat run adds per-instance columns", () => {
  const level = {
    concurrency: 4,
    errorCounts: {},
    errorRate: 0,
    errors: 0,
    instances: [
      { cpuSystemMs: 10, cpuUserMs: 100, index: 0, requests: 5 },
      { cpuSystemMs: 20, cpuUserMs: 80, index: 1, requests: 5 },
    ],
    latencyMs: { max: 30, p50: 10, p95: 20, p99: 30 },
    model: { chatCompletionsPerRequest: 1, embeddingRequestsPerRequest: 0, peakChatInFlight: 8 },
    requests: 10,
    server: { cpuMsPerRequest: 21, eventLoopDelayP99Ms: 3 },
    throughputRps: 50,
  };
  const markdown = formatLoadTestMarkdown({
    config: reportConfig({ instances: 2, scenario: "chat", sharedState: "redis" }),
    generatedAt: "2026-09-26T00:00:00.000Z",
    method: { notes: ["note"], percentile: "nearest-rank" },
    runs: [
      {
        ingest: reportIngest,
        ingestWorkers: 0,
        instances: [
          { index: 0, port: 4001 },
          { index: 1, port: 4002 },
        ],
        scenarios: [{ endpoint: "POST /chat", kind: "chat", levels: [level], modelLatencyMs: 800 }],
        sharedState: "redis",
        storage: "pgvector",
      },
    ],
  });

  assert.match(markdown, /\| App instances \| 2 \(client-side round robin, one database\) \|/);
  assert.match(markdown, /Shared state \(model call guard\) \| redis \(RAG_LLM_MAX_CONCURRENCY is one cap for all instances\)/);
  assert.match(markdown, /Processes: 2 API instance\(s\) on ports 4001, 4002\./);
  assert.match(markdown, /\| Requests per instance \| Server CPU ms per instance \|/);
  assert.match(markdown, /^\| 4 \| 10 \| 0 \| 0 \| 50 \| 10 \| 20 \| 30 \| 30 \| 1 \| 0 \| 8 \| 21 \| 3 \| - \| 5 \/ 5 \| 110 \/ 100 \|$/m);
});

test("markdown report of an ingest run has the ingest, background chat and per-instance sections", () => {
  const level = {
    chat: {
      baseline: { errors: 0, latencyMs: { p50: 40, p95: 45, p99: 50 }, requests: 30 },
      concurrency: 2,
      duringIngest: { errors: 1, latencyMs: { p50: 60, p95: 90, p99: 120 }, requests: 25 },
    },
    crossInstanceChecks: 6,
    errorCounts: { job_failed: 1 },
    errors: 1,
    failures: [{ error: "job_failed", jobError: "No extractable text." }],
    instances: [
      { cpuSystemMs: 5, cpuUserMs: 95, index: 0, requests: 12, uploads: 3 },
      { cpuSystemMs: 5, cpuUserMs: 45, index: 1, requests: 13, uploads: 3 },
    ],
    listedOnOtherInstance: 5,
    model: { embeddings: { inputs: 40, requests: 12 }, peakChatInFlight: 2, peakEmbeddingsInFlight: 3 },
    searchable: 5,
    searchableMs: { max: 700, p50: 450, p95: 650 },
    server: { cpuMsPerDocument: 30, eventLoopDelayP99Ms: 4 },
    throughputDocsPerSecond: 4.2,
    uploadConcurrency: 3,
    uploadLatencyMs: { p50: 4, p95: 9 },
    uploads: 6,
    workers: { cpuMsPerDocument: 12 },
  };
  const markdown = formatLoadTestMarkdown({
    config: reportConfig({
      chatConcurrency: 2,
      ingestMode: "async",
      ingestPages: 4,
      ingestWorkerConcurrency: null,
      ingestWorkers: 1,
      instances: 2,
      pollIntervalMs: 250,
      scenario: "ingest",
      searchableTimeoutMs: 120000,
      sharedState: "memory",
      uploadConcurrency: [3],
      uploads: 6,
    }),
    generatedAt: "2026-09-26T00:00:00.000Z",
    method: { notes: ["note"], percentile: "nearest-rank" },
    runs: [
      {
        ingest: reportIngest,
        ingestWorkers: 1,
        instances: [
          { index: 0, port: 4001 },
          { index: 1, port: 4002 },
        ],
        scenarios: [
          {
            chatConcurrency: 2,
            embeddingLatencyMs: 200,
            endpoint: "POST /upload",
            ingestMode: "async",
            ingestWorkers: 1,
            kind: "ingest",
            levels: [level],
            modelLatencyMs: 800,
          },
        ],
        sharedState: "memory",
        storage: "pgvector",
      },
    ],
  });

  assert.match(markdown, /\| Ingest mode \| async, 1 dedicated worker process\(es\), API instances without a worker loop \|/);
  assert.match(markdown, /\| Uploads \| 6 PDFs of 4 pages per level; upload concurrency 3 \|/);
  assert.match(markdown, /### POST \/upload \(async ingest\), chat model latency 800 ms, embedding latency 200 ms/);
  assert.match(markdown, /\| 3 \| 6 \| 5 \| 1 \| 4 \| 9 \| 450 \| 650 \| 700 \| 4.2 \| 5\/6 \| 12 \(40\) \| 3 \| 30 \| 12 \|/);
  assert.match(markdown, /\| 3 \| 25 \/ 30 \| 1 \/ 0 \| 60 \/ 40 \| 90 \/ 45 \| 120 \/ 50 \| 2 \| 4 \|/);
  assert.match(markdown, /- c=3: #0 3 \/ 12 \/ 100; #1 3 \/ 13 \/ 50/);
  assert.match(markdown, /- c=3: job_failed x1 \(first messages: No extractable text\.\)/);
  assert.match(markdown, /Seed corpus ingest: 2 documents/);
  assert.doesNotMatch(markdown, /Requests per level/);
});
