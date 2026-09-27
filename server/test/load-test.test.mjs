import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOAD_TEST_OPTIONS,
  EVENT_LOOP_SAMPLING_MS,
  buildAppEnvironment,
  buildFakeChatAnswer,
  buildSyntheticCorpus,
  eventLoopExcessDelayMs,
  formatLoadTestMarkdown,
  hashEmbedding,
  observedPeakInFlight,
  parseLoadTestArgs,
  percentile,
  readChatOutcome,
  runClosedLoop,
  startFakeModelServer,
  summarizeLatencies,
  summarizeLevel,
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
