import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  BALANCE_MODES,
  DEFAULT_INGEST_EMBEDDING_LATENCY_MS,
  DEFAULT_INGEST_LATEST_NAME,
  DEFAULT_LOAD_TEST_OPTIONS,
  EVENT_LOOP_SAMPLING_MS,
  LOAD_TEST_EMBEDDING_CACHE_TTL_MS,
  HOST_CPU_NOTE,
  LOAD_TEST_METHOD_NOTES,
  LOAD_TEST_TENANT,
  UPLOAD_IMBALANCE_THRESHOLD,
  buildAccessScopeNote,
  buildAppEnvironment,
  buildRequestHeaders,
  chatInterference,
  createHostSampler,
  describeSharedLimiter,
  diffProcessCpu,
  epochMsOf,
  estimateProbeCpu,
  formatAccessScope,
  meanWithInterval,
  parsePsCpuTime,
  readHarnessSha256,
  readPostgresProcessCpuFromPs,
  readPostmasterPid,
  readWorktreeState,
  summarizeHostWindow,
  summarizeIngestRepeats,
  summarizeUploadSplit,
  buildDocumentsEndpointNote,
  buildFakeChatAnswer,
  buildIngestNotes,
  buildMethodNotes,
  DATABASE_STATISTICS_NOTE,
  buildMultiInstanceNotes,
  buildMultipartFileBody,
  buildSyntheticCorpus,
  combineServerStats,
  containsPhrase,
  countIngestWorkerLoops,
  createChatSender,
  createInstanceBalancer,
  createPollingCounters,
  createQuestionPicker,
  describeIngestParallelism,
  describeInstances,
  embeddingCacheEntriesFor,
  QUERY_EMBEDDINGS_PER_QUESTION,
  eventLoopExcessDelayMs,
  formatCpuTopology,
  formatLoadTestMarkdown,
  hashEmbedding,
  hashWorktreeState,
  idleRatesFromStats,
  jobTimingsMs,
  littleLawMeanMs,
  measuredRequestsForLevel,
  minSamplesBelowMaximum,
  observedPeakInFlight,
  parseGitStatusPaths,
  parseLoadTestArgs,
  percentile,
  readChatOutcome,
  readIngestJob,
  readSearchableAnswer,
  runClosedLoop,
  runClosedLoopUntil,
  runIngestLevel,
  startFakeModelServer,
  subtractIdle,
  summarizeByInstance,
  summarizeIngestLevel,
  summarizeLatencies,
  summarizeLevel,
  summarizePolling,
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

test("p95 is the maximum below 20 samples and p99 below 100", () => {
  const upTo = (count) => Array.from({ length: count }, (_, index) => index + 1);

  assert.equal(minSamplesBelowMaximum(95), 20);
  assert.equal(minSamplesBelowMaximum(99), 100);
  assert.equal(minSamplesBelowMaximum(50), 2);
  assert.equal(percentile(upTo(19), 95), 19);
  assert.equal(percentile(upTo(20), 95), 19);
  assert.equal(percentile(upTo(64), 99), 64);
  assert.equal(percentile(upTo(200), 99), 198);
  assert.throws(() => minSamplesBelowMaximum(100), RangeError);
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
  assert.equal(summarizeLatencies([]).count, 0);
});

test("Little's law mean and the measured request count of a level", () => {
  // 32 virtual users at 197 req/s: 162.4 ms mean latency.
  assert.equal(littleLawMeanMs(32, 197), 162.4);
  assert.equal(littleLawMeanMs(4, 0), null);
  assert.equal(littleLawMeanMs(0, 10), null);

  assert.equal(measuredRequestsForLevel({ concurrency: 4, minRequestsPerClient: 8, requests: 128 }), 128);
  assert.equal(measuredRequestsForLevel({ concurrency: 64, minRequestsPerClient: 8, requests: 128 }), 512);
  assert.equal(measuredRequestsForLevel({ concurrency: 64, minRequestsPerClient: 0, requests: 128 }), 128);
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
  const { cooldownRequests, results, wallMs } = await runClosedLoop({
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
  assert.equal(cooldownRequests, 0);
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(results[4].error, "ECONNRESET");
  assert.equal(results[4].status, 0);
  assert.ok(results.every((result) => Number.isFinite(result.latencyMs)));
  assert.ok(wallMs >= 0);
});

test("a steady-state level measures only requests that ran with the full concurrency in flight", async () => {
  const concurrency = 3;
  let inFlight = 0;
  const atMeasuredStart = [];
  const atMeasuredEnd = [];
  const phases = { cooldown: 0, measured: 0, warmup: 0 };
  const marks = [];
  let step = 0;

  let windowOpen = false;
  let settledInWindow = 0;
  const { cooldownRequests, results, warmupRequests, wallMs, windowCompletions, windowCompletionsByInstance } = await runClosedLoop({
    concurrency,
    onMeasureEnd: () => {
      marks.push("end");
      windowOpen = false;
    },
    onMeasureStart: () => {
      marks.push("start");
      windowOpen = true;
    },
    requests: 7,
    send: async ({ phase }) => {
      phases[phase] += 1;
      inFlight += 1;
      if (phase === "measured") atMeasuredStart.push(inFlight);
      // Uneven service times, so requests finish out of order.
      const hops = 1 + (step++ % 3);
      for (let hop = 0; hop < hops; hop += 1) await new Promise((resolve) => setImmediate(resolve));
      if (phase === "measured") atMeasuredEnd.push(inFlight);
      inFlight -= 1;
      if (windowOpen) settledInWindow += 1;
      return { instance: step % 2, status: 200 };
    },
    steadyState: true,
    warmup: 4,
  });

  assert.equal(results.length, 7);
  assert.ok(results.every((result) => result?.status === 200));
  assert.equal(phases.warmup, 4);
  assert.equal(warmupRequests, 4);
  assert.equal(phases.measured, 7);
  assert.equal(phases.cooldown, cooldownRequests);
  assert.ok(cooldownRequests > 0, "the loop keeps its load until the last measured request returned");
  assert.deepEqual(marks, ["start", "end"]);
  // The window runs from the first measured send to the first cool-down send:
  // exactly the measured count returns inside it, whatever the phases.
  assert.equal(windowCompletions, 7);
  assert.equal(settledInWindow, 7);
  assert.equal(windowCompletionsByInstance.reduce((sum, count) => sum + count, 0), 7);
  // Every measured request started and finished with all users busy.
  assert.deepEqual(atMeasuredStart, new Array(7).fill(concurrency));
  assert.deepEqual(atMeasuredEnd, new Array(7).fill(concurrency));
  assert.ok(wallMs >= 0);

  const empty = await runClosedLoop({ concurrency: 2, requests: 0, send: async () => ({ status: 200 }) });
  assert.deepEqual(empty.results, []);
  assert.equal(empty.wallMs, 0);
});

for (const [label, callAt] of [
  ["before the first await", 0],
  ["in the middle", 1],
  ["at the end", 2],
]) {
  test(`counters read over the window see one call per measured request (call ${label}, lockstep)`, async () => {
    let calls = 0;
    let windowCalls = null;
    const hop = () => new Promise((resolve) => setImmediate(resolve));
    const { results } = await runClosedLoop({
      concurrency: 3,
      onMeasureEnd: () => {
        windowCalls = calls - windowCalls;
      },
      onMeasureStart: () => {
        windowCalls = calls;
      },
      requests: 9,
      send: async () => {
        for (let step = 0; step < 3; step += 1) {
          if (step === callAt) calls += 1;
          if (step < 2) await hop();
        }
        return { status: 200 };
      },
      steadyState: true,
      warmup: 3,
    });

    assert.equal(results.length, 9);
    assert.equal(windowCalls, 9);
  });
}

test("argument parsing fills defaults and validates storage against the database URL", () => {
  const defaults = parseLoadTestArgs([]);
  assert.deepEqual(defaults.concurrency, [1, 4, 16, 32]);
  assert.deepEqual(defaults.modelLatencyMs, [0, 800]);
  assert.deepEqual(defaults.storage, ["local"]);
  assert.equal(defaults.auth, false);
  assert.equal(defaults.rateLimit, false);
  assert.equal(defaults.balance, "least-outstanding");
  assert.equal(defaults.minRequestsPerClient, 8);
  assert.equal(defaults.idleMs, 3000);
  assert.equal(defaults.llmMaxConcurrency, DEFAULT_LOAD_TEST_OPTIONS.llmMaxConcurrency);
  assert.deepEqual(BALANCE_MODES, ["least-outstanding", "round-robin"]);

  const withDatabase = parseLoadTestArgs([
    "--database-url",
    "postgresql://u:p@127.0.0.1:6000/db",
    "--concurrency=2,8",
    "--requests",
    "10",
    "--auth",
    "--no-embedding-cache",
    "--balance",
    "round-robin",
    "--min-requests-per-client",
    "0",
    "--idle-ms",
    "0",
  ]);
  assert.deepEqual(withDatabase.storage, ["pgvector", "local"]);
  assert.deepEqual(withDatabase.concurrency, [2, 8]);
  assert.equal(withDatabase.requests, 10);
  assert.equal(withDatabase.auth, true);
  assert.equal(withDatabase.embeddingCache, false);
  assert.equal(withDatabase.balance, "round-robin");
  assert.equal(withDatabase.minRequestsPerClient, 0);
  assert.equal(withDatabase.idleMs, 0);

  assert.throws(() => parseLoadTestArgs(["--storage", "pgvector"]), /database-url/);
  assert.throws(() => parseLoadTestArgs(["--concurrency", "0,4"]), /at least 1/);
  assert.throws(() => parseLoadTestArgs(["--bogus", "1"]), /Unknown flag/);
  assert.throws(() => parseLoadTestArgs(["--planner", "magic"]), /planner/);
  assert.throws(() => parseLoadTestArgs(["--balance", "random"]), /least-outstanding or round-robin/);
});

test("the app environment pins every store and model setting and drops inherited ones", () => {
  const options = parseLoadTestArgs([]);
  const base = {
    HOME: "/home/test",
    OPENAI_API_KEY: "sk-real",
    PATH: "/usr/bin",
    POSTGRES_DATABASE_URL: "postgresql://real:5432/prod",
    RAG_EMBEDDING_CACHE_TTL_MS: "5",
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
  // The warmed query cache must outlast the run and hold the whole pool.
  assert.equal(local.RAG_EMBEDDING_CACHE_TTL_MS, String(LOAD_TEST_EMBEDDING_CACHE_TTL_MS));
  assert.equal(local.RAG_EMBEDDING_CACHE_MAX, String(embeddingCacheEntriesFor(options)));

  const pg = buildAppEnvironment({
    authToken: "token",
    baseEnvironment: base,
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:6000/loadtest",
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options: { ...options, auth: true, documents: 100, pages: 4, planner: "llm" },
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
  assert.equal(pg.RAG_EMBEDDING_CACHE_MAX, String(400 * 8 + 64));
});

test("the query cache size covers every retrieval query of the seed pool and the ingest probes", () => {
  assert.equal(QUERY_EMBEDDINGS_PER_QUESTION, 8);
  assert.equal(embeddingCacheEntriesFor({ documents: 5, pages: 4, scenario: "chat" }), 256, "never below the app default");
  assert.equal(embeddingCacheEntriesFor({ documents: 20, pages: 4, scenario: "chat" }), 80 * 8 + 64);
  assert.equal(embeddingCacheEntriesFor({ documents: 100, pages: 4, scenario: "chat" }), 400 * 8 + 64);
  assert.equal(
    embeddingCacheEntriesFor({
      documents: 20,
      modelLatencyMs: [0, 800],
      pages: 4,
      scenario: "ingest",
      uploadConcurrency: [4, 16],
      uploads: 128,
    }),
    (80 + 128 * 2 * 2) * 8 + 64
  );
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

test("fake chat answer cites the evidence sentence that matches the question", () => {
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

  // The page with the fact was retrieved second: the answer cites Source 2
  // and skips the heading that names the same program.
  const uploaded = [
    "User Question:",
    "Which department runs Program Bluebell-l1-2?",
    "",
    "Retrieved Evidence:",
    "Source 1",
    "File: program-bluebell-l1-2-manual.pdf",
    "Page: 1",
    "Evidence:",
    "Program Bluebell-l1-2 operating manual, part 1.\nThe approval threshold for Program Bluebell-l1-2 is 1175 dollars.",
    "",
    "Source 2",
    "File: program-bluebell-l1-2-manual.pdf",
    "Page: 2",
    "Evidence:",
    // The structured chunker separates a page's lines with blank lines.
    "Program Bluebell-l1-2 operating manual, part 2.\n\nProgram Bluebell-l1-2 is run by the support department.\n\nFiller.",
    "",
    "Grounded Answer:",
  ].join("\n");
  assert.equal(
    buildFakeChatAnswer({ messages: [{ content: uploaded, role: "user" }] }),
    "Program Bluebell-l1-2 is run by the support department. [Source 2]"
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

test("a document is searchable only with its fact in the answer and a citation of it", () => {
  const body = {
    agentAnswer: "Program Cobalt-l1-3 publishes its audit report in month 1 of every year. [Source 1]",
    ragSources: [{ docId: "doc-3", pageNumber: 4 }],
  };

  assert.deepEqual(readSearchableAnswer(body, { docId: "doc-3", expected: "month 1" }), {
    cited: true,
    hasFact: true,
    searchable: true,
  });
  // "month 1" is not "month 11": whole words only.
  assert.equal(readSearchableAnswer({ ...body, agentAnswer: "in month 11." }, { docId: "doc-3", expected: "month 1" }).searchable, false);
  // The fact without a citation of the document, or a citation without the fact.
  assert.deepEqual(readSearchableAnswer({ ...body, ragSources: [{ docId: "other" }] }, { docId: "doc-3", expected: "month 1" }), {
    // A failed check keeps the start of the answer for the report.
    answerExcerpt: "Program Cobalt-l1-3 publishes its audit report in month 1 of every year. [Source 1]",
    cited: false,
    hasFact: true,
    searchable: false,
  });
  assert.equal(readSearchableAnswer({ ...body, agentAnswer: "No answer." }, { docId: "doc-3", expected: "month 1" }).cited, true);
  assert.equal(readSearchableAnswer({}, { docId: "doc-3", expected: "month 1" }).searchable, false);

  assert.equal(containsPhrase("Costs 1175 Dollars.", "1175 dollars"), true);
  assert.equal(containsPhrase("costs 11175 dollars", "1175 dollars"), false);
  assert.equal(containsPhrase("is located  in\nLisbon", "located in Lisbon"), true);
  assert.equal(containsPhrase("anything", ""), false);
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

test("a stats reset while requests are in flight does not inflate the next window's peak", async (t) => {
  const server = await startFakeModelServer({ chatLatencyMs: 40, dimensions: 8 });
  t.after(() => server.close());
  const ask = () =>
    fetch(`${server.baseUrl}/chat/completions`, {
      body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "m" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).then((response) => response.json());

  const first = [ask(), ask(), ask()];
  // Reset once all three are in flight at the fake.
  const deadline = Date.now() + 2000;
  while (server.snapshot().chat.requests < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  server.resetStats();
  // Requests in flight when a window opens count toward its peak.
  assert.equal(server.snapshot().chat.peakInFlight, 3);
  await Promise.all(first);

  server.resetStats();
  await ask();
  // The three answered before this window leave the count: one in flight.
  assert.equal(server.snapshot().chat.peakInFlight, 1);
  assert.equal(server.snapshot().chat.requests, 1);
});

test("round-robin balancing takes instances in turn; least-outstanding picks the least loaded", () => {
  const roundRobin = createInstanceBalancer({ count: 3, mode: "round-robin" });
  const picked = Array.from({ length: 7 }, () => roundRobin.acquire());
  assert.deepEqual(picked, [0, 1, 2, 0, 1, 2, 0]);
  // Round robin ignores what is in flight.
  assert.deepEqual(roundRobin.outstanding(), [3, 2, 2]);

  const least = createInstanceBalancer({ count: 3 });
  assert.equal(least.mode, "least-outstanding");
  // Ties go in rotation.
  assert.deepEqual([least.acquire(), least.acquire(), least.acquire()], [0, 1, 2]);
  least.release(1);
  // Instance 1 has the fewest in flight, whatever the rotation says.
  assert.equal(least.acquire(), 1);
  least.release(0);
  assert.equal(least.acquire(), 0);
  // A pinned request counts where it went.
  assert.equal(least.acquire(2), 2);
  assert.deepEqual(least.outstanding(), [1, 1, 2]);
  // Tied instances 0 and 1: the rotation continues after the last pick (0).
  assert.equal(least.acquire(), 1);

  assert.throws(() => createInstanceBalancer({ count: 0 }), RangeError);
  assert.throws(() => createInstanceBalancer({ count: 2, mode: "random" }), RangeError);
  assert.throws(() => least.acquire(5), RangeError);
});

test("the question picker gives every instance the whole pool, whatever the request index", () => {
  const { questions } = buildSyntheticCorpus({ docIdPrefix: "q", documents: 20, pages: 4 });

  for (const instanceCount of [2, 4]) {
    const picker = createQuestionPicker({ instanceCount, questions });
    const seen = Array.from({ length: instanceCount }, () => new Set());
    // Round robin over two passes of the pool: request i to instance i mod N,
    // which with a picker keyed on i locked each instance to one page type.
    for (let index = 0; index < questions.length * instanceCount; index += 1) {
      const instance = index % instanceCount;
      seen[instance].add(picker(instance).question);
    }
    assert.ok(seen.every((set) => set.size === questions.length), `N=${instanceCount}: every instance asks every question`);
  }
});

const PAGE_TYPES = Object.freeze([
  ["retention", /retention period/],
  ["budget", /budget owner/],
  ["region", /region stores/],
  ["launch", /launch review/],
]);

const pageTypeOf = (question) => PAGE_TYPES.find(([, pattern]) => pattern.test(question))?.[0] ?? "unknown";

const startStubInstances = async (t, count, { delayMs = () => 0 } = {}) => {
  const received = Array.from({ length: count }, () => []);
  const servers = await Promise.all(
    Array.from({ length: count }, (_, instance) => {
      const server = http.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          received[instance].push(JSON.parse(body));
          setTimeout(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ agentAnswer: "Fact. [Source 1]", agentMode: "document", ragSources: [] }));
          }, delayMs(instance));
        });
      });
      return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
    })
  );
  t.after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

  return { baseUrls: servers.map((server) => `http://127.0.0.1:${server.address().port}`), received };
};

for (const instanceCount of [2, 4]) {
  for (const mode of BALANCE_MODES) {
    test(`with ${instanceCount} instances and ${mode} balancing every instance answers every page type`, async (t) => {
      const { questions } = buildSyntheticCorpus({ docIdPrefix: "s", documents: 20, pages: 4 });
      const { baseUrls, received } = await startStubInstances(t, instanceCount);
      const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
      t.after(() => agent.destroy());
      const balancer = createInstanceBalancer({ count: instanceCount, mode });

      const { results } = await runClosedLoop({
        concurrency: 4,
        requests: questions.length,
        send: createChatSender({
          agent,
          balancer,
          baseUrls,
          options: { requestTimeoutMs: 5000 },
          picker: createQuestionPicker({ instanceCount, questions }),
          sessionTag: "stub",
        }),
        steadyState: true,
        warmup: 4,
      });

      assert.ok(results.every((result) => result.status === 200));
      for (const [instance, bodies] of received.entries()) {
        const types = new Set(bodies.map((body) => pageTypeOf(body.question)));
        assert.deepEqual([...types].sort(), ["budget", "launch", "region", "retention"], `instance ${instance}`);
        // docIds follow the question, so every request is answerable.
        for (const body of bodies) {
          assert.equal(body.docIds[0], questions.find((question) => question.question === body.question).docId);
        }
      }
      // Tagged with the instance that served them, and nothing left in flight.
      assert.ok(results.every((result) => Number.isInteger(result.instance)));
      assert.deepEqual(balancer.outstanding(), new Array(instanceCount).fill(0));
    });
  }
}

test("least-outstanding sends fewer requests to a slow instance; round robin splits evenly", async (t) => {
  const { questions } = buildSyntheticCorpus({ docIdPrefix: "b", documents: 5, pages: 4 });
  const { baseUrls } = await startStubInstances(t, 2, { delayMs: (instance) => (instance === 0 ? 25 : 0) });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  t.after(() => agent.destroy());
  const run = async (mode) => {
    const { results } = await runClosedLoop({
      concurrency: 4,
      requests: 60,
      send: createChatSender({
        agent,
        balancer: createInstanceBalancer({ count: 2, mode }),
        baseUrls,
        options: { requestTimeoutMs: 5000 },
        picker: createQuestionPicker({ instanceCount: 2, questions }),
        sessionTag: mode,
      }),
    });
    return summarizeByInstance(results, 2).map((entry) => entry.requests);
  };

  const [slow, fast] = await run("least-outstanding");
  assert.ok(fast > slow, `least-outstanding: fast ${fast} vs slow ${slow}`);
  assert.deepEqual(await run("round-robin"), [30, 30]);
});

test("the next instance checks searchability", () => {
  assert.equal(visibilityCheckInstance(0, 3), 1);
  assert.equal(visibilityCheckInstance(2, 3), 0);
  assert.equal(visibilityCheckInstance(0, 1), 0);
});

test("per-instance summaries split requests, errors and 2xx latency by the instance that served them", () => {
  const perInstance = summarizeByInstance(
    [
      { instance: 0, latencyMs: 10, status: 200 },
      { instance: 1, latencyMs: 40, status: 200 },
      { instance: 0, latencyMs: 30, status: 200 },
      { instance: 0, latencyMs: 5, status: 500 },
      { error: "timeout", instance: 1, latencyMs: 900, status: 0 },
      { latencyMs: 1, status: 200 },
      null,
    ],
    3
  );

  assert.deepEqual(
    perInstance.map(({ errors, requests }) => ({ errors, requests })),
    [
      { errors: 1, requests: 3 },
      { errors: 1, requests: 2 },
      { errors: 0, requests: 0 },
    ]
  );
  assert.deepEqual([perInstance[0].latencyMs.count, perInstance[0].latencyMs.mean, perInstance[0].latencyMs.max], [2, 20, 30]);
  assert.equal(perInstance[1].latencyMs.p50, 40);
  assert.equal(perInstance[2].latencyMs.count, 0);
});

test("idle rates and net-of-idle totals", () => {
  assert.deepEqual(idleRatesFromStats({ cpuSystemMs: 2, cpuUserMs: 10, dbQueries: 6, windowMs: 3000 }), {
    cpuMsPerSecond: 4,
    dbQueriesPerSecond: 2,
    windowMs: 3000,
  });
  assert.deepEqual(idleRatesFromStats({}), { cpuMsPerSecond: null, dbQueriesPerSecond: null, windowMs: null });
  assert.equal(subtractIdle({ ratePerSecond: 4, total: 100, windowMs: 5000 }), 80);
  // Never below 0, and nothing to subtract without a rate.
  assert.equal(subtractIdle({ ratePerSecond: 50, total: 100, windowMs: 5000 }), 0);
  assert.equal(subtractIdle({ ratePerSecond: null, total: 100, windowMs: 5000 }), null);
});

test("server stats of several processes sum CPU, queries and memory and keep the worst event-loop delay", () => {
  const stats = [
    { cpuSystemMs: 10, cpuUserMs: 90, dbQueries: 40, eventLoopDelayMaxMs: 30, eventLoopDelayP99Ms: 4, rssMb: 100, windowMs: 1000 },
    { cpuSystemMs: 5, cpuUserMs: 45, dbQueries: 20, eventLoopDelayMaxMs: 12, eventLoopDelayP99Ms: 9.5, rssMb: 120.5, windowMs: 1000 },
  ];
  const combined = combineServerStats(stats, 30, {
    idle: [
      { cpuMsPerSecond: 10, dbQueriesPerSecond: 10 },
      { cpuMsPerSecond: 20, dbQueriesPerSecond: 0 },
    ],
  });

  assert.deepEqual(combined, {
    coresBusy: 0.15,
    cpuMsPerUnit: 5,
    cpuMsPerUnitNetOfIdle: 4,
    cpuSystemMs: 15,
    cpuUserMs: 135,
    dbQueries: 60,
    dbQueriesPerUnit: 2,
    dbQueriesPerUnitNetOfIdle: 1.67,
    eventLoopDelayMaxMs: 30,
    eventLoopDelayP99Ms: 9.5,
    rssMb: 220.5,
    sharedSlotAcquireCalls: null,
    sharedSlotsAcquired: null,
  });
  // The shared cap's acquire scripts sum over the processes that report them.
  const withAcquires = combineServerStats(
    [
      { cpuSystemMs: 0, cpuUserMs: 1, sharedSlotAcquireCalls: 300, sharedSlotsAcquired: 10 },
      { cpuSystemMs: 0, cpuUserMs: 1, sharedSlotAcquireCalls: 100, sharedSlotsAcquired: 5 },
    ],
    15
  );
  assert.equal(withAcquires.sharedSlotAcquireCalls, 400);
  assert.equal(withAcquires.sharedSlotsAcquired, 15);
  // One process: the fields are that process's own; no idle, no net.
  const single = combineServerStats([{ cpuSystemMs: 1, cpuUserMs: 3, eventLoopDelayP99Ms: 2, rssMb: 50 }], 2);
  assert.equal(single.cpuMsPerUnit, 2);
  assert.equal(single.cpuMsPerUnitNetOfIdle, null);
  assert.equal(single.dbQueries, null);
  assert.equal(single.coresBusy, null);
  assert.equal(combineServerStats([], 0).cpuMsPerUnit, null);
  assert.equal(combineServerStats([{}], 1).eventLoopDelayP99Ms, null);
});

test("per-instance description adds latency, cores busy and CPU per request net of idle", () => {
  const [first, second] = describeInstances({
    idle: [{ cpuMsPerSecond: 10 }, { cpuMsPerSecond: 10 }],
    instances: [{ port: 4001 }, { port: 4002 }],
    perInstance: summarizeByInstance(
      [
        { instance: 0, latencyMs: 10, status: 200 },
        { instance: 0, latencyMs: 20, status: 200 },
      ],
      2
    ),
    stats: [
      { cpuSystemMs: 10, cpuUserMs: 90, dbQueries: 4, type: "stats", windowMs: 2000 },
      { cpuSystemMs: 0, cpuUserMs: 5, dbQueries: 0, type: "stats", windowMs: 2000 },
    ],
  });

  assert.equal(first.port, 4001);
  assert.equal(first.requests, 2);
  assert.equal(first.latencyMs.mean, 15);
  assert.equal(first.cpuMsPerRequest, 50);
  assert.equal(first.cpuMsPerRequestNetOfIdle, 40);
  assert.equal(first.coresBusy, 0.05);
  assert.equal(first.dbQueries, 4);
  assert.equal(first.type, undefined);
  assert.equal(second.requests, 0);
  assert.equal(second.cpuMsPerRequest, null);
  assert.equal(second.latencyMs.count, 0);

  // With the requests that completed there during the stats window, CPU per
  // request divides by those.
  const [withCompletions] = describeInstances({
    completions: [4, 0],
    instances: [{ port: 4001 }, { port: 4002 }],
    perInstance: summarizeByInstance([{ instance: 0, latencyMs: 10, status: 200 }], 2),
    stats: [{ cpuSystemMs: 0, cpuUserMs: 100, windowMs: 1000 }, {}],
  });
  assert.equal(withCompletions.requests, 1);
  assert.equal(withCompletions.cpuMsPerRequest, 25);
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

test("job timings come from the job's own timestamps", () => {
  assert.deepEqual(
    jobTimingsMs({
      createdAt: "2026-09-26T10:00:00.000Z",
      finishedAt: "2026-09-26T10:00:02.750Z",
      startedAt: "2026-09-26T10:00:01.250Z",
    }),
    { processingMs: 1500, queueWaitMs: 1250 }
  );
  assert.deepEqual(jobTimingsMs({ createdAt: "2026-09-26T10:00:00.000Z", startedAt: null }), {
    processingMs: null,
    queueWaitMs: null,
  });
  assert.deepEqual(jobTimingsMs(), { processingMs: null, queueWaitMs: null });

  assert.deepEqual(
    readIngestJob({
      attemptCount: 1,
      createdAt: "a",
      error: null,
      finishedAt: "c",
      startedAt: "b",
      status: "succeeded",
    }),
    { attemptCount: 1, createdAt: "a", finishedAt: "c", jobError: null, jobStatus: "succeeded", startedAt: "b" }
  );
});

test("ingest level summary counts searchable documents, errors and job timings", () => {
  const summary = summarizeIngestLevel({
    results: [
      { acceptedMs: 5, checkInstance: 1, instance: 0, processingMs: 300, queueWaitMs: 20, searchableAtMs: 450, searchableMs: 450, status: 202 },
      { acceptedMs: 7, checkInstance: 0, instance: 1, processingMs: 500, queueWaitMs: 40, searchableAtMs: 1000, searchableMs: 650, status: 202 },
      { acceptedMs: 6, error: "job_failed", instance: 0, jobError: "No extractable text.", queueWaitMs: 10, status: 202 },
      { acceptedMs: 6, checkInstance: 0, error: "searchable_timeout", instance: 1, status: 202 },
      { acceptedMs: 3, instance: 0, status: 413 },
    ],
    wallMs: 1500,
  });

  assert.equal(summary.uploads, 5);
  assert.equal(summary.accepted, 4);
  assert.equal(summary.searchable, 2);
  assert.equal(summary.searchableOnOtherInstance, 2);
  assert.equal(summary.errors, 3);
  assert.equal(summary.errorRate, 0.6);
  // 2 documents searchable by 1000 ms into the window.
  assert.equal(summary.throughputDocsPerSecond, 2);
  assert.equal(summary.lastSearchableAtMs, 1000);
  assert.equal(summary.wallMs, 1500);
  // Upload latency covers every accepted upload; searchable time only the
  // documents that became searchable; job timings every job that has them.
  assert.equal(summary.uploadLatencyMs.count, 4);
  assert.equal(summary.uploadLatencyMs.max, 7);
  assert.deepEqual([summary.searchableMs.count, summary.searchableMs.max], [2, 650]);
  assert.deepEqual([summary.queueWaitMs.count, summary.queueWaitMs.max], [3, 40]);
  assert.deepEqual([summary.processingMs.count, summary.processingMs.p50], [2, 300]);
  assert.deepEqual(summary.statusCounts, { 202: 4, 413: 1 });
  assert.deepEqual(summary.errorCounts, { http_413: 1, job_failed: 1, searchable_timeout: 1 });

  // Sync mode on one instance: checked on the instance that took it, no job.
  const sync = summarizeIngestLevel({
    results: [{ acceptedMs: 60, checkInstance: 0, instance: 0, searchableAtMs: 62, searchableMs: 61, status: 201 }],
    wallMs: 100,
  });
  assert.equal(sync.searchableOnOtherInstance, 0);
  assert.equal(sync.searchableMs.p50, 61);
  assert.equal(sync.queueWaitMs.count, 0);
  assert.equal(summarizeIngestLevel().throughputDocsPerSecond, null);
});

test("harness polling is summarized as its own load", () => {
  const polling = createPollingCounters();
  polling.jobPolls = 30;
  polling.searchChecks = 10;
  polling.searchCheckStatuses = { 200: 8, 404: 2 };

  assert.deepEqual(summarizePolling(polling, 4000), {
    jobPollStatuses: {},
    jobPolls: 30,
    requests: 40,
    requestsPerSecond: 10,
    searchCheckStatuses: { 200: 8, 404: 2 },
    searchChecks: 10,
  });
  assert.equal(summarizePolling(createPollingCounters(), 0).requestsPerSecond, null);
});

test("ingest parallelism: sync uploads in flight, async worker loops", () => {
  assert.deepEqual(describeIngestParallelism({ ingestMode: "sync", uploadConcurrency: 8, workerLoops: 0 }), {
    documentsAtOnce: 8,
    source: "in-flight uploads",
  });
  assert.deepEqual(describeIngestParallelism({ ingestMode: "async", uploadConcurrency: 8, workerLoops: 4 }), {
    documentsAtOnce: 4,
    source: "worker loops",
  });
  assert.equal(
    countIngestWorkerLoops([
      { ingestWorker: { concurrency: 4, idlePollMs: 1000 } },
      { ingestWorker: null },
      { ingestWorker: { concurrency: 4, idlePollMs: null } },
      {},
    ]),
    8
  );
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
  // Polls like the frontend's first interval; idle chat baselines of 10 s.
  assert.equal(ingest.pollIntervalMs, 1000);
  assert.equal(ingest.baselineMs, 10000);

  const async = parseLoadTestArgs([
    ...database,
    "--scenario=ingest",
    "--ingest-mode",
    "async",
    "--ingest-workers",
    "2",
    "--ingest-worker-concurrency",
    "4",
    "--ingest-worker-poll-ms",
    "250",
    "--ingest-max-pending-jobs",
    "128",
    "--baseline-ms",
    "0",
    "--embedding-latency-ms",
    "0",
    "--upload-concurrency",
    "1,8",
    "--latest-name",
    "custom",
  ]);
  assert.equal(async.ingestWorkers, 2);
  assert.equal(async.ingestWorkerConcurrency, 4);
  assert.equal(async.ingestWorkerPollMs, 250);
  assert.equal(async.ingestMaxPendingJobs, 128);
  assert.equal(ingest.ingestMaxPendingJobs, null, "the app's default cap unless asked");
  assert.equal(async.baselineMs, 0);
  assert.equal(async.embeddingLatencyMs, 0);
  assert.deepEqual(async.uploadConcurrency, [1, 8]);
  assert.equal(async.latestName, "custom");
  assert.deepEqual(async.storage, ["pgvector"]);

  assert.throws(() => parseLoadTestArgs(["--uploads", "4"]), /only apply to --scenario ingest/);
  assert.throws(() => parseLoadTestArgs(["--baseline-ms", "4"]), /only apply to --scenario ingest/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--ingest-workers", "1"]), /ingest-mode async/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--ingest-worker-concurrency", "4"]), /upload concurrency/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--ingest-worker-poll-ms", "100"]), /ingest-mode async/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--ingest-max-pending-jobs", "100"]), /ingest-mode async/);
  assert.throws(() => parseLoadTestArgs(["--ingest-max-pending-jobs", "100"]), /only apply to --scenario ingest/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--ingest-mode", "later"]), /sync or async/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "ingest", "--upload-concurrency", "0"]), /at least 1/);
  assert.throws(() => parseLoadTestArgs(["--scenario", "replay"]), /chat, ingest or index-switch/);
  // The chat scenario keeps its defaults.
  assert.equal(parseLoadTestArgs([]).embeddingLatencyMs, 0);
  assert.equal(parseLoadTestArgs([]).latestName, "latest-load-test");
});

test("the app environment carries the ingest mode, worker settings and a per-run Redis prefix", () => {
  const base = {
    DOTENV_CONFIG_PATH: "/real/.env",
    PATH: "/usr/bin",
    RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT: "3",
    RAG_INGEST_WORKER_ENABLED: "true",
    RAG_INGEST_WORKER_POLL_MS: "5",
    REDIS_URL: "redis://real:6379",
  };
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
    "--ingest-worker-poll-ms",
    "400",
    "--ingest-max-pending-jobs",
    "0",
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
  assert.equal(worker.RAG_INGEST_WORKER_POLL_MS, "400");
  assert.equal(api.RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT, "0", "0 turns the per-tenant cap off");
  assert.equal(api.RAG_SHARED_STATE, "redis");
  assert.equal(api.REDIS_URL, "redis://127.0.0.1:7001");
  assert.equal(api.RAG_SHARED_STATE_PREFIX, "archive_rag_load_test:abc:");
  assert.equal(api.DOTENV_CONFIG_PATH, "/tmp/load/empty.env");
  assert.equal(api.PDF_PARSER, "pdfjs");

  // Chat defaults: sync ingest, per-process guard state, the app's own worker
  // default, and no inherited poll interval.
  const chat = buildAppEnvironment({ ...shared, options: parseLoadTestArgs([]), storage: "local" });
  assert.equal(chat.RAG_INGEST_MODE, "sync");
  assert.equal(chat.RAG_SHARED_STATE, "memory");
  assert.equal(chat.REDIS_URL, undefined);
  assert.equal(chat.RAG_INGEST_WORKER_ENABLED, undefined);
  assert.equal(chat.RAG_INGEST_WORKER_POLL_MS, undefined);
  assert.equal(chat.RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT, undefined, "the developer's cap is not inherited");
});

test("method notes follow the storage, balancing and ingest mode of the run", () => {
  const chatLocal = buildMethodNotes({ instances: 1, scenario: "chat", storage: ["local"] });
  const unscoped = buildAccessScopeNote({});
  assert.deepEqual(chatLocal, [...LOAD_TEST_METHOD_NOTES, unscoped, HOST_CPU_NOTE, buildDocumentsEndpointNote(["local"])]);
  // Without --tenant the numbers are the owner path's; with it, the tenant's.
  assert.match(unscoped, /row-level security does not apply/);
  assert.match(unscoped, /unscoped owner path/);
  const tenantNote = buildAccessScopeNote({ tenant: true });
  assert.match(tenantNote, /under row-level security/);
  assert.match(tenantNote, /load-test-user \/ load-test-workspace/);
  assert.equal(buildMethodNotes({ scenario: "chat", storage: ["pgvector"], tenant: true })[LOAD_TEST_METHOD_NOTES.length], tenantNote);
  assert.ok(!chatLocal.includes(DATABASE_STATISTICS_NOTE), "no PostgreSQL, no ANALYZE");
  assert.match(chatLocal.at(-1), /in-process registry and sends no database query/);
  assert.doesNotMatch(chatLocal.at(-1), /pgvector/);

  const chatPg = buildDocumentsEndpointNote(["pgvector"]);
  assert.match(chatPg, /registry is PostgreSQL/);
  assert.match(chatPg, /in either ingest mode GET \/documents and POST \/chat first re-read/);
  assert.match(chatPg, /not an in-memory read on pgvector/);
  assert.match(chatPg, /DB queries\/req column is the observation/);
  assert.doesNotMatch(chatPg, /sends no database query/);

  const leastOutstanding = buildMultiInstanceNotes({ balance: "least-outstanding", sharedState: "redis" });
  assert.match(leastOutstanding[1], /least_conn/);
  assert.match(leastOutstanding[2], /one RAG_LLM_MAX_CONCURRENCY cap/);
  assert.match(leastOutstanding[2], /per second of waiting/);
  assert.match(leastOutstanding[2], /request counts and mean latency/);
  const roundRobin = buildMultiInstanceNotes({ balance: "round-robin" });
  assert.match(roundRobin[1], /specific to round robin/);
  assert.match(roundRobin[2], /caps each instance/);
  assert.deepEqual(buildMethodNotes({ balance: "round-robin", instances: 2, scenario: "chat", storage: ["pgvector"] }), [
    ...LOAD_TEST_METHOD_NOTES,
    unscoped,
    HOST_CPU_NOTE,
    chatPg,
    DATABASE_STATISTICS_NOTE,
    ...roundRobin,
  ]);
  assert.match(DATABASE_STATISTICS_NOTE, /ANALYZE once after the warm-up/);
  assert.match(DATABASE_STATISTICS_NOTE, /--no-analyze/);
  assert.match(DATABASE_STATISTICS_NOTE, /many tenants spreads its runs/);

  const asyncNotes = buildIngestNotes({ ingestMode: "async", pollIntervalMs: 1000 });
  assert.ok(asyncNotes.some((note) => /Queue wait \(startedAt - createdAt\)/.test(note)));
  assert.ok(asyncNotes.some((note) => /matched parallelism/.test(note)));
  assert.ok(!asyncNotes.some((note) => /^Sync mode/.test(note)));
  const syncNotes = buildIngestNotes({ ingestMode: "sync", pollIntervalMs: 1000 });
  assert.ok(syncNotes.some((note) => /^Sync mode/.test(note)));
  assert.ok(!syncNotes.some((note) => /Queue wait \(startedAt/.test(note)));
  // The same searchable definition in both modes, and polling as its own load.
  for (const notes of [asyncNotes, syncNotes]) {
    assert.ok(notes.some((note) => /^Searchable, the same in both ingest modes/.test(note)));
    assert.ok(notes.some((note) => /fixed 1000 ms/.test(note) && /balancer of their own/.test(note)));
    assert.ok(notes.some((note) => /before and right after the window/.test(note) && /below saturation/.test(note)));
    // Times run from the offer in both modes; comparable rows only.
    assert.ok(notes.some((note) => /^Offered load/.test(note) && /Only rows where every upload was accepted/.test(note)));
  }
  assert.ok(asyncNotes.some((note) => /time to indexed is not, it is the job's finishedAt/.test(note)));
  // The ingest scenario sends no GET /documents, so it gets no note about it.
  assert.deepEqual(
    buildMethodNotes({ ingestMode: "async", ingestWorkers: 1, instances: 1, pollIntervalMs: 1000, scenario: "ingest", storage: ["pgvector"] }),
    [...LOAD_TEST_METHOD_NOTES, unscoped, HOST_CPU_NOTE, DATABASE_STATISTICS_NOTE, ...buildMultiInstanceNotes({}), ...asyncNotes]
  );
  assert.ok(LOAD_TEST_METHOD_NOTES.some((note) => /p95 equals the maximum below 20 samples and p99 below 100/.test(note)));
  assert.ok(LOAD_TEST_METHOD_NOTES.some((note) => /time, not work/.test(note)));
});

test("the worktree hash covers tracked changes and untracked files", () => {
  const base = hashWorktreeState({ diff: "diff --git a/x b/x\n+1\n", untracked: [] });

  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(hashWorktreeState({ diff: "diff --git a/x b/x\n+1\n", untracked: [] }), base);
  assert.notEqual(hashWorktreeState({ diff: "diff --git a/x b/x\n+2\n", untracked: [] }), base);
  const withUntracked = hashWorktreeState({ diff: "diff --git a/x b/x\n+1\n", untracked: [{ contentSha256: "aa", path: "new.js" }] });
  assert.notEqual(withUntracked, base);
  assert.notEqual(
    hashWorktreeState({ diff: "diff --git a/x b/x\n+1\n", untracked: [{ contentSha256: "bb", path: "new.js" }] }),
    withUntracked
  );
  // Listing order does not matter.
  assert.equal(
    hashWorktreeState({ diff: "", untracked: [{ contentSha256: "1", path: "b" }, { contentSha256: "2", path: "a" }] }),
    hashWorktreeState({ diff: "", untracked: [{ contentSha256: "2", path: "a" }, { contentSha256: "1", path: "b" }] })
  );

  assert.deepEqual(parseGitStatusPaths(" M server/rag/config.js\n?? server/new.mjs\nR  old.js -> new.js\n\n"), [
    "server/rag/config.js",
    "server/new.mjs",
    "new.js",
  ]);
});

test("CPU core tiers are shown fastest first", () => {
  assert.equal(
    formatCpuTopology([
      { logicalCpus: 5, name: "Super" },
      { logicalCpus: 10, name: "Performance" },
    ]),
    "5 Super + 10 Performance"
  );
  assert.equal(formatCpuTopology(null), null);
  assert.equal(formatCpuTopology([]), null);
});

const reportConfig = (overrides = {}) => ({
  auth: false,
  balance: "least-outstanding",
  cheapPath: "/documents",
  cheapRequests: 100,
  concurrency: [4],
  cpuCount: 15,
  cpuModel: "cpu",
  cpuTopology: [
    { logicalCpus: 5, name: "Super" },
    { logicalCpus: 10, name: "Performance" },
  ],
  documents: 2,
  embeddingCache: true,
  embeddingCacheMaxEntries: 256,
  embeddingCacheTtlMs: LOAD_TEST_EMBEDDING_CACHE_TTL_MS,
  embeddingDimensions: 16,
  embeddingLatencyMs: 0,
  gitChangedFiles: [],
  gitDiffSha256: null,
  gitDirty: false,
  gitSha: "abc123",
  idleMs: 3000,
  llmMaxConcurrency: 8,
  minRequestsPerClient: 8,
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
  vectorStore: { denseBackend: "pgvector", hybridFusion: "rrf", sparseBackend: "postgres_fts", vectorStoreProvider: "pgvector" },
};

const chatLevel = (overrides = {}) => ({
  agentModes: { document: 9 },
  concurrency: 4,
  errorCounts: { http_429: 1 },
  errorRate: 0.1,
  errors: 1,
  groundedAnswers: 9,
  latencyMs: { count: 9, max: 30, mean: 12.5, p50: 10, p95: 20, p99: 30 },
  model: { chatCompletionsPerRequest: 1, embeddingRequestsPerRequest: 0, peakChatInFlight: 4 },
  requests: 10,
  server: {
    coresBusy: 1.25,
    cpuMsPerRequest: 12.5,
    cpuMsPerRequestNetOfIdle: 11,
    dbQueriesPerRequest: 6,
    eventLoopDelayP99Ms: 20,
  },
  throughputRps: 50,
  ...overrides,
});

test("markdown report has the config, the host's core tiers and one table per scenario", () => {
  const markdown = formatLoadTestMarkdown({
    config: reportConfig({
      gitChangedFiles: ["server/evaluation/run-api-load-bench.mjs", "server/rag/config.js"],
      gitChangedFileCount: 2,
      gitDiffSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      gitDirty: true,
      modelLatencyMs: [0, 800],
      storage: ["local"],
    }),
    generatedAt: "2026-09-26T00:00:00.000Z",
    method: { notes: ["note"], percentile: "nearest-rank" },
    runs: [
      {
        idle: [{ cpuMsPerSecond: 3.5, dbQueriesPerSecond: 0 }],
        idleMs: 3000,
        ingest: reportIngest,
        ingestWorkers: 0,
        instances: [{ index: 0, ingestWorker: null, port: 4001 }],
        scenarios: [
          {
            endpoint: "GET /documents",
            kind: "cheap",
            levels: [chatLevel({ agentModes: undefined, groundedAnswers: undefined })],
          },
          { endpoint: "POST /chat", kind: "chat", levels: [chatLevel()], modelLatencyMs: 800 },
        ],
        storage: "local",
      },
    ],
  });

  assert.match(markdown, /Git SHA \| abc123 \(dirty worktree, worktree sha256 0123456789abcdef, 2 changed file\(s\)\) \|/);
  assert.match(markdown, /\| Changed files \| server\/evaluation\/run-api-load-bench.mjs, server\/rag\/config.js \|/);
  assert.match(markdown, /15 CPUs \(cpu; core tiers 5 Super \+ 10 Performance\)/);
  assert.match(markdown, /RAG_LLM_MAX_CONCURRENCY \| 8/);
  assert.match(markdown, /Measured requests per level \| \/chat max\(10, 8 x concurrency\)/);
  assert.match(markdown, /on, warmed on every instance before the first measured level \(256 entries, TTL 86400000 ms\)/);
  assert.match(markdown, /Idle for 3000 ms before the first measured level \(nothing sent\): API #0 3.5 CPU ms\/s, 0 DB queries\/s\./);
  assert.doesNotMatch(markdown, /Planner statistics/, "local storage runs no ANALYZE");
  assert.match(markdown, /### GET \/documents/);
  assert.match(markdown, /### POST \/chat, model latency 800 ms/);
  assert.match(
    markdown,
    /^\| Concurrency \| Requests \| Errors \| Req\/s \| n \| Mean ms \| p50 ms \| p95 ms \| p99 ms \| Max ms \| Chat calls\/req \|/m
  );
  // n and the mean sit next to the percentiles.
  assert.match(markdown, /^\| 4 \| 10 \| 1 \| 50 \| 9 \| 12.5 \| 10 \| 20 \| 30 \| 30 \| 1 \| 0 \| 4 \| 12.5 \| 11 \| 1.25 \| 6 \| 20 \| document 9, cited 9 \|$/m);
  assert.match(markdown, /^\| 4 \| 10 \| 1 \| 50 \| 9 \| 12.5 \| 10 \| 20 \| 30 \| 30 \| 12.5 \| 11 \| 1.25 \| 6 \| 20 \|$/m);
  assert.match(markdown, /c=4: http_429 x1/);
  assert.match(markdown, /pgvector \(dense pgvector, sparse postgres_fts, rrf fusion\); 4 chunk rows counted in PostgreSQL/);
  assert.doesNotMatch(markdown, /Per instance/);
});

test("markdown report of a multi-instance chat run adds a per-instance table with latency and the mean", () => {
  const level = chatLevel({
    errorCounts: {},
    errors: 0,
    instances: [
      { coresBusy: 0.9, cpuMsPerRequest: 22, cpuMsPerRequestNetOfIdle: 20, dbQueries: 30, errors: 0, index: 0, latencyMs: { count: 5, max: 12, mean: 9, p50: 9, p95: 12, p99: 12 }, requests: 5 },
      { coresBusy: 0.4, cpuMsPerRequest: 20, cpuMsPerRequestNetOfIdle: 18, dbQueries: 30, errors: 0, index: 1, latencyMs: { count: 5, max: 30, mean: 16, p50: 15, p95: 30, p99: 30 }, requests: 5 },
    ],
  });
  const markdown = formatLoadTestMarkdown({
    config: reportConfig({ instances: 2, scenario: "chat", sharedState: "redis" }),
    generatedAt: "2026-09-26T00:00:00.000Z",
    method: { notes: ["note"], percentile: "nearest-rank" },
    runs: [
      {
        idle: null,
        ingest: reportIngest,
        ingestWorkers: 0,
        instances: [
          { index: 0, ingestWorker: null, port: 4001 },
          { index: 1, ingestWorker: null, port: 4002 },
        ],
        scenarios: [{ endpoint: "POST /chat", kind: "chat", levels: [level], modelLatencyMs: 800 }],
        sharedState: "redis",
        storage: "pgvector",
      },
    ],
  });

  assert.match(markdown, /\| App instances \| 2 \(client-side least-outstanding balancing, one database\) \|/);
  assert.match(markdown, /Shared state \(model call guard\) \| redis \(RAG_LLM_MAX_CONCURRENCY is one cap for all instances\)/);
  assert.match(markdown, /Processes: 2 API instance\(s\) on ports 4001, 4002\./);
  assert.match(markdown, /Per instance \(least-outstanding balancing;/);
  assert.match(markdown, /^\| 4 \| 0 \| 5 \| 0 \| 5 \| 9 \| 9 \| 12 \| 12 \| 12 \| 22 \| 20 \| 0.9 \| 30 \|$/m);
  assert.match(markdown, /^\| 4 \| 1 \| 5 \| 0 \| 5 \| 16 \| 15 \| 30 \| 30 \| 30 \| 20 \| 18 \| 0.4 \| 30 \|$/m);
});

test("markdown report of an async ingest run has the ingest, job timing, cost, polling, background chat and per-instance tables", () => {
  const latency = (count, mean, p50, p95, p99, max) => ({ count, max, mean, p50, p95, p99 });
  const level = {
    accepted: 6,
    chat: {
      baselineAfter: { errors: 0, latencyMs: latency(31, 42, 41, 46, 52, 52), requests: 31, server: { cpuMsPerRequest: 14 }, wallMs: 1000 },
      baselineBefore: { errors: 0, latencyMs: latency(30, 40, 40, 45, 50, 50), requests: 30, server: { cpuMsPerRequest: 12 }, wallMs: 1000 },
      concurrency: 2,
      duringIngest: { errors: 1, latencyMs: latency(24, 70, 60, 90, 120, 120), requests: 25, wallMs: 1500 },
    },
    comparable: false,
    host: {
      harnessCoresBusy: 0.8,
      hostCoresBusy: 4.2,
      postgresCoresBusy: 1.1,
      postgresCpuMsPerUnit: 50,
      postgresProcesses: 12,
      postgresProcessesExited: 1,
      windowMs: 1500,
    },
    indexedDocsPerSecond: 3.85,
    lastIndexedAtMs: 1300,
    offeredToIndexedMs: latency(5, 850, 800, 1200, 1200, 1300),
    offeredToSearchableMs: latency(5, 1150, 1100, 1500, 1500, 1500),
    repeat: 1,
    uploadSplit: { imbalanced: false, maxOverMean: 1, perInstance: [3, 3] },
    errorCounts: { job_failed: 1 },
    errors: 1,
    failures: [{ error: "job_failed", jobError: "No extractable text." }],
    ingestParallelism: { documentsAtOnce: 4, source: "worker loops" },
    instances: [
      { coresBusy: 0.3, cpuSystemMs: 5, cpuUserMs: 95, dbQueries: 40, errors: 0, index: 0, latencyMs: latency(12, 65, 60, 80, 80, 80), requests: 12, uploads: 3 },
      { coresBusy: 0.2, cpuSystemMs: 5, cpuUserMs: 45, dbQueries: 35, errors: 1, index: 1, latencyMs: latency(12, 75, 70, 90, 90, 90), requests: 13, uploads: 3 },
    ],
    model: { embeddings: { inputs: 40, requests: 12 }, peakChatInFlight: 2, peakEmbeddingsInFlight: 3 },
    polling: {
      estimatedProbeApiCpu: { cpuMs: 78, shareOfApiCpu: 0.52 },
      jobPolls: 9,
      requestsPerSecond: 10,
      searchCheckStatuses: { 200: 5, 404: 1 },
      searchChecks: 6,
    },
    processingMs: latency(5, 300, 290, 400, 400, 410),
    queueWaitMs: latency(6, 20, 15, 900, 900, 950),
    searchable: 5,
    searchableMs: latency(5, 500, 450, 650, 700, 700),
    server: { coresBusy: 0.5, cpuMsPerDocument: 30, cpuMsPerDocumentNetOfIdle: 25, dbQueriesPerDocument: 15 },
    throughputDocsPerSecond: 4.2,
    uploadConcurrency: 3,
    uploadLatencyMs: latency(6, 5, 4, 9, 9, 9),
    uploads: 6,
    wallMs: 1500,
    workers: { coresBusy: 0.2, cpuMsPerDocument: 12, cpuMsPerDocumentNetOfIdle: 8 },
  };
  const markdown = formatLoadTestMarkdown({
    config: reportConfig({
      baselineMs: 1000,
      chatConcurrency: 2,
      ingestMaxPendingJobs: 100,
      ingestMode: "async",
      ingestPages: 4,
      ingestWorkerConcurrency: 4,
      ingestWorkerPollMs: 1000,
      ingestWorkers: 1,
      instances: 2,
      pollIntervalMs: 1000,
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
        databaseAnalyzeMs: 42.5,
        idle: [
          { cpuMsPerSecond: 2, dbQueriesPerSecond: 1 },
          { cpuMsPerSecond: 2, dbQueriesPerSecond: 1 },
          { cpuMsPerSecond: 1, dbQueriesPerSecond: 4 },
        ],
        idleMs: 3000,
        ingest: reportIngest,
        ingestWorkerLoops: 4,
        ingestWorkers: 1,
        instances: [
          { index: 0, ingestWorker: null, port: 4001 },
          { index: 1, ingestWorker: null, port: 4002 },
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
        workerProcesses: [{ ingestWorker: { concurrency: 4, idlePollMs: 1000 }, pid: 1 }],
      },
    ],
  });

  assert.match(
    markdown,
    /\| Ingest mode \| async, 1 dedicated worker process\(es\), API instances without a worker loop, RAG_INGEST_WORKER_CONCURRENCY=4, RAG_INGEST_WORKER_POLL_MS=1000, RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT=100 \|/
  );
  assert.match(markdown, /\| Uploads \| 6 PDFs of 4 pages per level; upload concurrency 3 \|/);
  assert.match(markdown, /idle baseline of 1000 ms before and after each window/);
  assert.match(markdown, /Ingest worker loops: worker #0 4 loop\(s\), idle poll 1000 ms \(4 in total\)\./);
  assert.match(
    markdown,
    /Planner statistics: ANALYZE ran on the database after the warm-up, before the idle measurement \(42\.5 ms\)\./
  );
  assert.match(markdown, /API #0 2 CPU ms\/s, 1 DB queries\/s; API #1 2 CPU ms\/s, 1 DB queries\/s; worker #0 1 CPU ms\/s, 4 DB queries\/s\./);
  assert.match(markdown, /### POST \/upload \(async ingest\), chat model latency 800 ms, embedding latency 200 ms/);
  assert.match(markdown, /Searchable: POST \/chat on another instance than the one that took the upload answers/);
  // From the offer (window start), with the comparable flag, before the
  // per-request times kept for older reports.
  assert.match(markdown, /^\| 3 r1 \| 4 \(worker loops\) \| 6 \/ 6 \| 5 \| no \| 5 \| 800 \| 1200 \| 1300 \| 1100 \| 1500 \| 3.85 \|$/m);
  assert.ok(markdown.indexOf("From the offer") < markdown.indexOf("Per request, from when the closed-loop uploader sent it"));
  assert.match(markdown, /^\| 3 r1 \| 6 \| 4 \| 9 \| 5 \| 450 \| 650 \| 700 \| 4.2 \|$/m);
  assert.match(markdown, /^\| 3 r1 \| 6 \| 15 \| 900 \| 950 \| 5 \| 290 \| 400 \| 410 \|$/m);
  assert.match(markdown, /^\| 3 r1 \| 12 \(40\) \| 3 \| 30 \| 25 \| 0.5 \| 15 \| 12 \| 8 \| 0.2 \|$/m);
  assert.match(markdown, /^\| 3 r1 \| 1500 \| 4.2 \| 0.8 \| 1.1 \| 50 \| 12 \(1\) \|$/m);
  assert.match(markdown, /^\| 3 r1 \| 1500 \| 9 \| 6 \| 10 \| 78 \(0.52\) \| 200 x5, 404 x1 \|$/m);
  assert.match(markdown, /^\| 3 r1 \| idle before \| 1000 \| 30 \| 0 \| 30 \| 40 \| 40 \| 45 \| 50 \| 50 \| 12 \|$/m);
  assert.match(markdown, /^\| 3 r1 \| during ingest \| 1500 \| 25 \| 1 \| 24 \| 70 \| 60 \| 90 \| 120 \| 120 \| - \|$/m);
  assert.match(markdown, /^\| 3 r1 \| idle after \| 1000 \| 31 \| 0 \| 31 \| 42 \| 41 \| 46 \| 52 \| 52 \| 14 \|$/m);
  assert.match(markdown, /^\| 3 r1 \| 0 \| 3 \| 12 \| 0 \| 12 \| 65 \| 60 \| 80 \| 80 \| 80 \| 100 \| 0.3 \| 40 \|$/m);
  assert.match(markdown, /- c=3 r1: job_failed x1 \(first details: No extractable text\.\)/);
  assert.doesNotMatch(markdown, /^Repeats \(mean/m, "one run per level has no interval");
  assert.match(markdown, /\| ANALYZE after the warm-up \| yes \|/);
  assert.match(markdown, /\| Access scope \| none: unscoped owner path/);
  assert.match(markdown, /Seed corpus ingest: 2 documents/);
  assert.doesNotMatch(markdown, /Measured requests per level/);
});

test("markdown report of a sync ingest run has no job timing table", () => {
  const latency = { count: 1, max: 60, mean: 60, p50: 60, p95: 60, p99: 60 };
  const markdown = formatLoadTestMarkdown({
    config: reportConfig({
      baselineMs: 1000,
      chatConcurrency: 0,
      ingestMode: "sync",
      ingestPages: 1,
      ingestWorkers: 0,
      instances: 1,
      pollIntervalMs: 1000,
      scenario: "ingest",
      searchableTimeoutMs: 1000,
      storage: ["local"],
      uploadConcurrency: [1],
      uploads: 1,
    }),
    generatedAt: "2026-09-26T00:00:00.000Z",
    method: { notes: ["note"], percentile: "nearest-rank" },
    runs: [
      {
        ingest: reportIngest,
        ingestWorkerLoops: 0,
        ingestWorkers: 0,
        instances: [{ index: 0, ingestWorker: null, port: 4001 }],
        scenarios: [
          {
            chatConcurrency: 0,
            embeddingLatencyMs: 200,
            endpoint: "POST /upload",
            ingestMode: "sync",
            kind: "ingest",
            levels: [
              {
                accepted: 1,
                chat: { baselineAfter: null, baselineBefore: null, concurrency: 0, duringIngest: null },
                comparable: true,
                errorCounts: {},
                errors: 0,
                ingestParallelism: { documentsAtOnce: 1, source: "in-flight uploads" },
                model: { embeddings: { inputs: 2, requests: 2 } },
                polling: { jobPolls: 0, requestsPerSecond: 1, searchCheckStatuses: { 200: 1 }, searchChecks: 1 },
                processingMs: { count: 0 },
                queueWaitMs: { count: 0 },
                searchable: 1,
                searchableMs: latency,
                server: {},
                throughputDocsPerSecond: 16,
                uploadConcurrency: 1,
                uploadLatencyMs: latency,
                uploads: 1,
                wallMs: 62,
                workers: null,
              },
            ],
            modelLatencyMs: 0,
          },
        ],
        storage: "local",
      },
    ],
  });

  assert.match(markdown, /\| Ingest mode \| sync \(each upload is ingested inside its own request\) \|/);
  assert.match(markdown, /Searchable: POST \/chat on the instance answers/);
  assert.match(markdown, /^\| 1 \| 1 \(in-flight uploads\) \| 1 \/ 1 \| 1 \| yes \|/m);
  assert.doesNotMatch(markdown, /ANALYZE after the warm-up/, "local storage has no PostgreSQL rows");
  assert.doesNotMatch(markdown, /Server-side job timings/);
  assert.doesNotMatch(markdown, /Background POST \/chat/);
});

// --- measurement corrections -------------------------------------------------

test("the worktree hash reads untracked files from the repository root, whatever directory the run starts in", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { chmod, mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "load-test-worktree-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });

  // The fixture repository must not inherit a caller's repository location: a
  // git hook's or a coverage run's GIT_INDEX_FILE would otherwise receive this
  // throwaway repository's `git add`, and readWorktreeState would read it.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
    if (Object.hasOwn(process.env, name)) {
      const saved = process.env[name];
      delete process.env[name];
      t.after(() => {
        process.env[name] = saved;
      });
    }
  }

  git("init", "-q");
  await mkdir(path.join(root, "server", "rag"), { recursive: true });
  await writeFile(path.join(root, "server", "tracked.js"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  // Untracked files under server/ and outside it, the run starting in server/.
  await writeFile(path.join(root, "server", "rag", "listener.js"), "export const version = 1;\n");
  await writeFile(path.join(root, "outside.txt"), "one\n");
  const server = path.join(root, "server");
  const first = await readWorktreeState({ cwd: server });

  assert.equal(first.gitDirty, true);
  assert.deepEqual([...first.gitChangedFiles].sort(), ["outside.txt", "server/rag/listener.js"]);
  assert.equal((await readWorktreeState({ cwd: root })).gitDiffSha256, first.gitDiffSha256, "the same tree from the root");

  await writeFile(path.join(root, "server", "rag", "listener.js"), "export const version = 2;\n");
  const edited = await readWorktreeState({ cwd: server });
  assert.notEqual(edited.gitDiffSha256, first.gitDiffSha256, "an untracked file's content is in the hash");

  await writeFile(path.join(root, "outside.txt"), "two\n");
  assert.notEqual((await readWorktreeState({ cwd: server })).gitDiffSha256, edited.gitDiffSha256, "also outside server/");

  // A file it cannot read fails the run instead of being hashed by name.
  if (process.getuid?.() !== 0) {
    await chmod(path.join(root, "outside.txt"), 0o000);
    t.after(() => chmod(path.join(root, "outside.txt"), 0o644).catch(() => {}));
    await assert.rejects(() => readWorktreeState({ cwd: server }), /Cannot read the untracked file outside\.txt/);
  }

  assert.match(await readHarnessSha256(), /^[0-9a-f]{64}$/);
});

test("ps CPU times, PostgreSQL process sums and a window's host block", async () => {
  assert.equal(parsePsCpuTime("170:48.13"), 10248130, "macOS minutes:seconds.hundredths");
  assert.equal(parsePsCpuTime("01:02:03"), 3723000, "Linux hh:mm:ss");
  assert.equal(parsePsCpuTime("1-00:00:01"), 86401000);
  assert.equal(parsePsCpuTime("n/a"), null);

  const listing = (lines) => lines.map(([pid, ppid, time]) => `  ${pid}  ${ppid}  ${time}`).join("\n");
  const start = readPostgresProcessCpuFromPs(
    listing([
      [100, 1, "0:01.00"],
      [101, 100, "0:02.00"],
      [102, 100, "0:00.50"],
      [200, 1, "9:00.00"],
    ]),
    100
  );
  const end = readPostgresProcessCpuFromPs(
    listing([
      [100, 1, "0:01.10"],
      [101, 100, "0:02.40"],
      [103, 100, "0:00.30"],
      [200, 1, "9:30.00"],
    ]),
    100
  );

  assert.deepEqual([...start.keys()], [100, 101, 102], "the postmaster and its children only");
  assert.equal(readPostgresProcessCpuFromPs(listing([[5, 1, "0:01.00"]]), 100), null, "no postmaster, no sample");
  // 100 ms + 400 ms + a new backend's 300 ms; the exited one is counted as such.
  assert.deepEqual(diffProcessCpu(start, end), { cpuMs: 800, exited: 1, processes: 3, started: 1 });
  assert.equal(diffProcessCpu(null, end), null);

  const host = summarizeHostWindow(
    { atMs: 1000, harness: { system: 0, user: 0 }, host: { busyMs: 10000 }, postgres: start },
    { atMs: 3000, harness: { system: 100000, user: 300000 }, host: { busyMs: 18000 }, postgres: end },
    { units: 40 }
  );
  assert.deepEqual(host, {
    harnessCoresBusy: 0.2,
    harnessCpuMs: 400,
    hostCoresBusy: 4,
    postgresCoresBusy: 0.4,
    postgresCpuMs: 800,
    postgresCpuMsPerUnit: 20,
    postgresProcesses: 3,
    postgresProcessesExited: 1,
    windowMs: 2000,
  });

  // The sampler reads ps only with a postmaster pid.
  const calls = [];
  const sampler = createHostSampler({
    listProcesses: async () => {
      calls.push("ps");
      return listing([[100, 1, "0:01.00"]]);
    },
    postmasterPid: 100,
  });
  const a = await sampler.mark();
  const b = await sampler.mark();
  assert.equal(calls.length, 2);
  assert.equal(sampler.diff(a, b).postgresProcesses, 1);
  const withoutPostgres = createHostSampler({ listProcesses: async () => assert.fail("no ps without a pid") });
  const window = withoutPostgres.diff(await withoutPostgres.mark(), { ...(await withoutPostgres.mark()), atMs: performance.now() + 5 });
  assert.equal(window.postgresCpuMs, null);
  assert.ok(Number.isFinite(window.hostCoresBusy));
});

test("the postmaster pid comes from the first line of its pid file", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "load-test-pid-"));
  t.after(() => rm(directory, { force: true, recursive: true }));

  await writeFile(path.join(directory, "postmaster.pid"), "4242\n/data\n1700000000\n");
  assert.equal(await readPostmasterPid(path.join(directory, "postmaster.pid")), 4242);
  assert.equal(await readPostmasterPid(path.join(directory, "missing.pid")), null);
  assert.equal(await readPostmasterPid(""), null);
});

test("ingest times run from the offer in both modes, and a level with refused uploads is not comparable", () => {
  const results = [
    // Sync: indexed when the 201 arrived, which for a later document includes its wait for a free uploader.
    { acceptedMs: 300, indexedAtMs: 300, instance: 0, searchableAtMs: 320, searchableMs: 320, status: 201 },
    { acceptedMs: 290, indexedAtMs: 590, instance: 1, searchableAtMs: 610, searchableMs: 310, status: 201 },
    { acceptedMs: 310, indexedAtMs: 900, instance: 0, searchableAtMs: 1150, searchableMs: 560, status: 201 },
  ];
  const summary = summarizeIngestLevel({ results, wallMs: 1200 });

  assert.equal(summary.comparable, true);
  assert.deepEqual(summary.offeredToIndexedMs, summarizeLatencies([300, 590, 900]));
  assert.deepEqual(summary.offeredToSearchableMs, summarizeLatencies([320, 610, 1150]));
  assert.equal(summary.lastIndexedAtMs, 900);
  assert.equal(summary.indexedDocsPerSecond, 3.33, "3 documents by the last indexed time, not the last probe");
  assert.equal(summary.throughputDocsPerSecond, 2.61, "the probe-timed figure is kept");
  // The per-request figure leaves out the backlog the offered figure keeps.
  assert.ok(summary.searchableMs.max < summary.offeredToSearchableMs.max);

  const capped = summarizeIngestLevel({
    results: [...results, { acceptedMs: 5, instance: 1, status: 429 }],
    wallMs: 1200,
  });
  assert.equal(capped.comparable, false);
  assert.equal(capped.accepted, 3);
});

test("the upload split per instance is flagged above the imbalance threshold", () => {
  const upload = (instance, status = 201) => ({ instance, status });
  const even = summarizeUploadSplit([upload(0), upload(1), upload(0), upload(1), upload(1, 429)], 2);
  assert.deepEqual(even, { imbalanced: false, maxOverMean: 1, perInstance: [2, 2] });

  // The sync run the review flagged: 15 against 49.
  const skewed = summarizeUploadSplit(
    [...Array.from({ length: 15 }, () => upload(0)), ...Array.from({ length: 49 }, () => upload(1))],
    2
  );
  assert.equal(skewed.maxOverMean, 1.53);
  assert.equal(skewed.imbalanced, true);
  assert.ok(UPLOAD_IMBALANCE_THRESHOLD < 1.53);
  assert.equal(summarizeUploadSplit([upload(0)], 1).imbalanced, false, "one instance is never imbalanced");
});

test("repeats get a mean and a 95% t-interval; interference is the during row minus the idle baselines", () => {
  assert.deepEqual(meanWithInterval([10, 12, 14]), { ci95: [7.03, 16.97], mean: 12, n: 3, sd: 2 });
  assert.deepEqual(meanWithInterval([7]), { ci95: null, mean: 7, n: 1, sd: null });
  assert.deepEqual(meanWithInterval([null, undefined]), { ci95: null, mean: null, n: 0, sd: null });

  const chat = (before, during, after) => ({
    baselineAfter: { latencyMs: { mean: after, p95: after + 10 } },
    baselineBefore: { latencyMs: { mean: before, p95: before + 10 } },
    duringIngest: { latencyMs: { mean: during, p95: during + 20 } },
  });
  assert.deepEqual(chatInterference(chat(20, 30, 22)), { meanDeltaMs: 9, p95DeltaMs: 19 });
  assert.equal(chatInterference({ duringIngest: null }), null);

  const level = (uploadConcurrency, overrides) => ({
    chat: chat(20, 30, 20),
    comparable: true,
    indexedDocsPerSecond: 20,
    offeredToIndexedMs: { p50: 500 },
    offeredToSearchableMs: { p50: 700 },
    uploadConcurrency,
    ...overrides,
  });
  const [eight] = summarizeIngestRepeats([
    level(8, { indexedDocsPerSecond: 20 }),
    level(8, { indexedDocsPerSecond: 22 }),
    level(8, { indexedDocsPerSecond: 24 }),
    level(8, { comparable: false, indexedDocsPerSecond: 99 }),
  ]);
  assert.equal(eight.repeats, 4);
  assert.equal(eight.comparableRepeats, 3);
  assert.deepEqual(eight.indexedDocsPerSecond, { ci95: [17.03, 26.97], mean: 22, n: 3, sd: 2 }, "the refused repeat is left out");
  assert.equal(eight.chatP95DeltaMs.mean, 20);
  assert.equal(eight.offeredToIndexedP50Ms.mean, 500);
});

test("probe CPU is estimated from the idle windows' CPU per chat request", () => {
  assert.deepEqual(estimateProbeCpu({ baselineCpuMsPerChat: 13, searchChecks: 50, windowCpuMs: 4800 }), {
    cpuMs: 650,
    shareOfApiCpu: 0.135,
  });
  assert.equal(estimateProbeCpu({ baselineCpuMsPerChat: null, searchChecks: 50, windowCpuMs: 4800 }), null);
});

test("the shared cap's polling is reported per second and per slot, not per request", () => {
  assert.deepEqual(describeSharedLimiter({ acquireCalls: 4000, acquired: 100, wallMs: 10000 }), {
    acquireCalls: 4000,
    acquireCallsPerSecond: 400,
    acquireCallsPerSlot: 40,
    slotsAcquired: 100,
  });
  assert.equal(describeSharedLimiter({ acquireCalls: 0, acquired: 0, wallMs: 1000 }), null, "memory mode runs none");
  assert.equal(describeSharedLimiter({ acquireCalls: null, acquired: null, wallMs: 1000 }), null);
});

test("--tenant scopes every request and the seed corpus; the report says which path it measured", () => {
  const options = parseLoadTestArgs(["--tenant", "--database-url", "postgresql://x@127.0.0.1:1/db", "--no-analyze"]);
  assert.equal(options.tenant, true);
  assert.equal(options.analyze, false);
  assert.deepEqual(buildRequestHeaders({ options }), {
    "x-user-id": LOAD_TEST_TENANT.userId,
    "x-workspace-id": LOAD_TEST_TENANT.workspaceId,
  });
  assert.deepEqual(buildRequestHeaders({ authToken: "k", options: { auth: true } }), { "x-api-key": "k" });
  assert.deepEqual(buildRequestHeaders({ options: {} }), {});

  const environment = buildAppEnvironment({
    baseEnvironment: {},
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options: { ...DEFAULT_LOAD_TEST_OPTIONS, tenant: true },
    storage: "pgvector",
    tempRoot: "/tmp/x",
  });
  assert.equal(environment.LOAD_TEST_TENANT_USER_ID, LOAD_TEST_TENANT.userId);
  assert.equal(environment.LOAD_TEST_TENANT_WORKSPACE_ID, LOAD_TEST_TENANT.workspaceId);
  assert.equal(environment.POSTGRES_ROW_LEVEL_SECURITY, undefined, "the app default (enforce) applies");
  assert.equal(
    buildAppEnvironment({
      baseEnvironment: {},
      modelBaseUrl: "http://127.0.0.1:1/v1",
      options: DEFAULT_LOAD_TEST_OPTIONS,
      storage: "pgvector",
      tempRoot: "/tmp/x",
    }).LOAD_TEST_TENANT_USER_ID,
    undefined
  );

  assert.match(formatAccessScope({ tenant: true, ...LOAD_TEST_TENANT }), /row-level security/);
  assert.match(formatAccessScope({ tenant: false }), /unscoped owner path/);
  assert.match(formatAccessScope(undefined), /unscoped owner path/, "reports written before --tenant existed");
  assert.throws(() => parseLoadTestArgs(["--repeat", "3"]), /only apply to --scenario ingest/);
  assert.equal(parseLoadTestArgs(["--scenario", "ingest", "--repeat", "3"]).repeat, 3);
  assert.equal(parseLoadTestArgs(["--postgres-pid-file", "/d/postmaster.pid"]).postgresPidFile, "/d/postmaster.pid");
});

test("epoch time of a performance.now() reading", () => {
  const before = Date.now();
  const epoch = epochMsOf(performance.now());
  assert.ok(Math.abs(epoch - before) < 50);
});

// Two instances answering /upload with 201 and /chat: the probe (docIds of an
// upload) after `probeDelayMs`, everything else at once.
const startIngestStubs = async (t, { probeDelayMs = 30 } = {}) => {
  const servers = [];
  const received = [];

  for (let instance = 0; instance < 2; instance += 1) {
    let uploads = 0;
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const reply = (status, body) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (request.url === "/upload") {
          uploads += 1;
          received.push({ instance, kind: "upload" });
          reply(201, { docId: `doc-${instance}-${uploads}` });
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (String(body.docIds?.[0] ?? "").startsWith("doc-")) {
          received.push({ instance, kind: "probe" });
          setTimeout(
            () => reply(200, { agentAnswer: "The fact is here. [Source 1]", ragSources: [{ docId: body.docIds[0] }] }),
            probeDelayMs
          );
          return;
        }
        received.push({ instance, kind: "chat" });
        reply(200, { agentAnswer: "ok [Source 1]", agentMode: "document", ragSources: [{ docId: "seed" }] });
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
  }

  t.after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));
  return { baseUrls: servers.map((server) => `http://127.0.0.1:${server.address().port}`), received };
};

test("an ingest level keeps the searchable checks out of the workload balancer and times documents from the offer", async (t) => {
  const { baseUrls, received } = await startIngestStubs(t);
  const recordingBalancer = () => {
    const balancer = createInstanceBalancer({ count: 2 });
    const pinned = [];
    return {
      ...balancer,
      acquire: (instance = null) => {
        if (instance !== null && instance !== undefined) pinned.push(instance);
        return balancer.acquire(instance);
      },
      pinned,
    };
  };
  const workload = recordingBalancer();
  const measurement = recordingBalancer();
  const documents = Array.from({ length: 12 }, (_, index) => ({
    fileName: `d${index}.pdf`,
    pdf: Buffer.from("%PDF-1.4"),
    probe: { expected: "The fact is here", question: `probe ${index}` },
  }));

  const { results, wallMs } = await runIngestLevel({
    balancer: workload,
    baseUrls,
    documents,
    headers: {},
    hooks: { onWindowEnd: () => {}, onWindowStart: () => {} },
    measurementBalancer: measurement,
    options: {
      chatConcurrency: 2,
      ingestMode: "sync",
      pollIntervalMs: 5,
      requestTimeoutMs: 5000,
      searchableTimeoutMs: 5000,
    },
    picker: createQuestionPicker({ instanceCount: 2, questions: [{ docId: "seed", question: "seed question" }] }),
    sessionTag: "t",
    uploadConcurrency: 4,
  });

  assert.deepEqual(workload.pinned, [], "no probe was counted as workload");
  assert.equal(measurement.pinned.length, 12, "every probe went through the measurement balancer");
  assert.equal(received.filter((entry) => entry.kind === "probe").length, 12);
  assert.deepEqual(workload.outstanding(), [0, 0]);
  assert.deepEqual(measurement.outstanding(), [0, 0]);
  // Slow probes pinned to the other instance no longer push uploads away from it.
  assert.equal(summarizeUploadSplit(results, 2).imbalanced, false, summarizeUploadSplit(results, 2).perInstance.join("/"));

  const summary = summarizeIngestLevel({ results, wallMs });
  assert.equal(summary.comparable, true);
  assert.equal(summary.offeredToIndexedMs.count, 12);
  for (const result of results) {
    assert.ok(result.indexedAtMs >= result.acceptedMs - 1, "indexed from the offer covers the upload itself");
    assert.ok(result.searchableAtMs >= result.indexedAtMs);
  }
});

test("markdown report adds host CPU, the shared cap's polling rate and the repeats table", () => {
  const host = {
    harnessCoresBusy: 1.1,
    hostCoresBusy: 5.2,
    postgresCoresBusy: 0.9,
    postgresCpuMsPerUnit: 3.8,
    postgresProcesses: 40,
    postgresProcessesExited: 0,
    windowMs: 10000,
  };
  const chat = formatLoadTestMarkdown({
    config: reportConfig({
      accessScope: { tenant: true, ...LOAD_TEST_TENANT },
      analyze: false,
      harnessSha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      instances: 4,
      postgresCpuSampled: true,
      sharedState: "redis",
    }),
    generatedAt: "2026-09-26T00:00:00.000Z",
    method: { notes: ["note"], percentile: "nearest-rank" },
    runs: [
      {
        idle: null,
        ingest: reportIngest,
        ingestWorkers: 0,
        instances: [0, 1, 2, 3].map((index) => ({ index, ingestWorker: null, port: 4001 + index })),
        scenarios: [
          {
            endpoint: "POST /chat",
            kind: "chat",
            levels: [
              chatLevel({
                concurrency: 64,
                host,
                server: {
                  ...chatLevel().server,
                  sharedLimiter: { acquireCalls: 4000, acquireCallsPerSecond: 400, acquireCallsPerSlot: 40, slotsAcquired: 100 },
                },
              }),
            ],
            modelLatencyMs: 800,
          },
        ],
        sharedState: "redis",
        storage: "pgvector",
      },
    ],
  });

  assert.match(chat, /\| Harness sha256 \| fedcba9876543210 \(evaluation\/run-api-load-bench.mjs as run\) \|/);
  assert.match(chat, /\| Access scope \| tenant load-test-user \/ load-test-workspace \(x-user-id \/ x-workspace-id; PostgreSQL statements run in tenant transactions under row-level security\) \|/);
  assert.match(chat, /\| ANALYZE after the warm-up \| no \(--no-analyze\): the fresh database has no planner statistics \|/);
  assert.match(chat, /\| PostgreSQL CPU sampled \| yes/);
  assert.match(chat, /^\| 64 \| 10000 \| 5.2 \| 1.1 \| 0.9 \| 3.8 \| 40 \(0\) \|$/m);
  assert.match(chat, /per second of waiting, not per request/);
  assert.match(chat, /^\| 64 \| 4000 \| 400 \| 100 \| 40 \|$/m);

  const latency = { count: 3, max: 90, mean: 60, p50: 60, p95: 90, p99: 90 };
  const ingestLevel = (repeat) => ({
    accepted: 4,
    chat: { baselineAfter: null, baselineBefore: null, concurrency: 0, duringIngest: null },
    comparable: true,
    errorCounts: {},
    errors: 0,
    ingestParallelism: { documentsAtOnce: 4, source: "in-flight uploads" },
    offeredToIndexedMs: latency,
    offeredToSearchableMs: latency,
    polling: { jobPolls: 0, searchChecks: 4 },
    repeat,
    searchable: 4,
    searchableMs: latency,
    server: {},
    uploadConcurrency: 4,
    uploadLatencyMs: latency,
    uploads: 4,
  });
  const ingest = formatLoadTestMarkdown({
    config: reportConfig({
      baselineMs: 0,
      chatConcurrency: 0,
      ingestMode: "sync",
      ingestPages: 1,
      pollIntervalMs: 1000,
      repeat: 2,
      scenario: "ingest",
      searchableTimeoutMs: 1000,
      uploadConcurrency: [4],
      uploads: 4,
    }),
    generatedAt: "2026-09-26T00:00:00.000Z",
    method: { notes: ["note"], percentile: "nearest-rank" },
    runs: [
      {
        ingest: reportIngest,
        ingestWorkerLoops: 0,
        ingestWorkers: 0,
        instances: [{ index: 0, ingestWorker: null, port: 4001 }],
        scenarios: [
          {
            chatConcurrency: 0,
            embeddingLatencyMs: 200,
            endpoint: "POST /upload",
            ingestMode: "sync",
            kind: "ingest",
            levels: [ingestLevel(1), ingestLevel(2)],
            modelLatencyMs: 0,
            repeats: summarizeIngestRepeats([
              { ...ingestLevel(1), indexedDocsPerSecond: 10 },
              { ...ingestLevel(2), indexedDocsPerSecond: 12 },
            ]),
          },
        ],
        storage: "pgvector",
      },
    ],
  });

  assert.match(ingest, /\| Repeats per level \| 2 \|/);
  assert.match(ingest, /^\| 4 r1 \| 4 \(in-flight uploads\) \| 4 \/ 4 \| 4 \| yes \|/m);
  assert.match(ingest, /^\| 4 r2 \| 4 \(in-flight uploads\) \| 4 \/ 4 \| 4 \| yes \|/m);
  assert.match(ingest, /do not rank modes on a number whose intervals overlap/);
  assert.match(ingest, /^\| 4 \| 2 \(2\) \| 60 \[60, 60\] \(n=2\) \| 60 \[60, 60\] \(n=2\) \| 11 \[-1\.71, 23\.71\] \(n=2\) \| - \| - \| - \|$/m);
});
