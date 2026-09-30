import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOAD_TEST_OPTIONS,
  GATEWAY_CALLER_PREFIX,
  LOAD_TEST_REPORT_VERSION,
  MONOLITH_TIER,
  REPEAT_NOTE,
  SPLIT_TIERS,
  TIER_REPORT_ORDER,
  buildAppEnvironment,
  buildMethodNotes,
  buildMultiInstanceNotes,
  buildTierEnvironment,
  buildTopologyNotes,
  countDirectModelCalls,
  createRunServiceKeys,
  describeTopologyConfig,
  formatLifetimeCpu,
  formatLoadTestMarkdown,
  formatTopologyConfig,
  levelLabel,
  parseLoadTestArgs,
  pickBusiestTier,
  rangeOf,
  splitWarmUpPassLimit,
  summarizeLevelRepeats,
  summarizeProcessTotals,
  summarizeTierStats,
  tierCallerTag,
} from "../evaluation/run-api-load-bench.mjs";
import { parseServiceKeys } from "../rag/service-identity.js";
import { validateServiceTopology } from "../rag/service-topology.js";

// The load harness's split topology (--topology split): argument parsing, the
// environment each tier process gets, the per-tier accounting of a level, the
// ranges over --repeat and the report. No database and no processes: the
// topology itself runs under scripts/run-load-test-pgvector.sh.

const database = ["--database-url", "postgresql://u:p@127.0.0.1:6000/db"];

test("--topology split parses per-tier replica counts, runs on pgvector only and replaces --instances", () => {
  const defaults = parseLoadTestArgs([...database, "--topology", "split"]);

  assert.equal(defaults.topology, "split");
  assert.deepEqual(defaults.tierReplicas, { agent: 1, api: 1, "model-gateway": 1, retrieval: 1 });
  assert.equal(defaults.instances, 1, "the balancer counts the api replicas");
  assert.deepEqual(defaults.storage, ["pgvector"], "never the local store, whatever --database-url would default to");

  const scaled = parseLoadTestArgs([
    ...database,
    "--topology=split",
    "--api",
    "2",
    "--agent",
    "4",
    "--retrieval=3",
    "--gateway",
    "2",
    "--tenant",
  ]);
  assert.deepEqual(scaled.tierReplicas, { agent: 4, api: 2, "model-gateway": 2, retrieval: 3 });
  assert.equal(scaled.instances, 2);
  assert.equal(scaled.tenant, true);

  const monolith = parseLoadTestArgs([...database, "--instances", "4"]);
  assert.equal(monolith.topology, "monolith", "the default is today's run");
  assert.equal(monolith.instances, 4);
  assert.equal(DEFAULT_LOAD_TEST_OPTIONS.topology, "monolith");

  assert.throws(() => parseLoadTestArgs([...database, "--topology", "mesh"]), /--topology must be monolith or split/);
  assert.throws(() => parseLoadTestArgs([...database, "--agent", "2"]), /--agent only apply to --topology split/);
  assert.throws(() => parseLoadTestArgs([...database, "--api", "2", "--gateway", "2"]), /--api, --gateway only apply/);
  assert.throws(() => parseLoadTestArgs(["--topology", "split"]), /--topology split needs --database-url/);
  assert.throws(
    () => parseLoadTestArgs([...database, "--topology", "split", "--storage", "local"]),
    /--topology split needs --storage pgvector/
  );
  assert.throws(
    () => parseLoadTestArgs([...database, "--topology", "split", "--storage", "pgvector,local"]),
    /--topology split needs --storage pgvector/
  );
  assert.throws(() => parseLoadTestArgs([...database, "--topology", "split", "--instances", "2"]), /from --api, not --instances/);
  assert.throws(() => parseLoadTestArgs([...database, "--topology", "split", "--agent", "0"]), /--agent expects a positive integer/);
  assert.throws(
    () => parseLoadTestArgs([...database, "--topology", "split", "--scenario", "ingest"]),
    /runs the chat scenario only/
  );
  assert.throws(
    () => parseLoadTestArgs([...database, "--topology", "split", "--scenario", "index-switch"]),
    /runs the chat scenario only/
  );
});

test("--repeat applies to the chat scenario in either topology", () => {
  assert.equal(parseLoadTestArgs([...database, "--topology", "split", "--repeat", "3"]).repeat, 3);
  assert.equal(parseLoadTestArgs(["--repeat", "2"]).repeat, 2);
  assert.equal(parseLoadTestArgs([]).repeat, 1);
  assert.throws(() => parseLoadTestArgs(["--repeat", "0"]), /--repeat expects a positive integer/);
});

test("each tier process gets its role, the run's key, its replica lists and no shell wiring; the gateway gets the fake model and no database", () => {
  const serviceKeys = createRunServiceKeys({ runId: "abc123", secret: "s".repeat(64) });
  const options = parseLoadTestArgs([...database, "--topology", "split", "--agent", "2", "--tenant"]);
  const urls = {
    agent: ["http://127.0.0.1:7001", "http://127.0.0.1:7002"],
    "model-gateway": ["http://127.0.0.1:7010"],
    retrieval: ["http://127.0.0.1:7020"],
  };
  const shell = {
    AGENT_SERVICE_URL: "http://elsewhere:1",
    ARCHIVE_RAG_ROLE: "retrieval",
    INTERNAL_SERVICE_KEYS: "shell:shell-secret-shell-secret-shell-secret",
    MODEL_GATEWAY_URL: "http://elsewhere:2",
    PATH: "/usr/bin",
    PORT: "5001",
    RETRIEVAL_SERVICE_URL: "http://elsewhere:3",
    SERVICE_SHUTDOWN_GRACE_MS: "99999",
  };
  const environmentFor = (tier, index = 0) =>
    buildTierEnvironment({
      baseEnvironment: shell,
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:6000/loadtest",
      index,
      modelBaseUrl: "http://127.0.0.1:6999/v1",
      options,
      runId: "abc123",
      serviceKeys,
      storage: "pgvector",
      tempRoot: "/tmp/load",
      tier,
      urls,
    });

  const api = environmentFor("api");
  assert.equal(api.ARCHIVE_RAG_ROLE, "api");
  assert.equal(api.AGENT_SERVICE_URL, "http://127.0.0.1:7001,http://127.0.0.1:7002");
  assert.equal(api.MODEL_GATEWAY_URL, "http://127.0.0.1:7010");
  assert.equal(api.RETRIEVAL_SERVICE_URL, undefined, "the edge never retrieves");
  assert.equal(api.INTERNAL_SERVICE_KEYS, serviceKeys);
  assert.equal(api.POSTGRES_DATABASE_URL, "postgresql://postgres:postgres@127.0.0.1:6000/loadtest");
  assert.equal(api.LOAD_TEST_TENANT_USER_ID, "load-test-user");
  assert.equal(api.PORT, undefined, "the child listens on an ephemeral port");

  const agent = environmentFor("agent", 1);
  assert.equal(agent.ARCHIVE_RAG_ROLE, "agent");
  assert.equal(agent.RETRIEVAL_SERVICE_URL, "http://127.0.0.1:7020");
  assert.equal(agent.MODEL_GATEWAY_URL, "http://127.0.0.1:7010");
  assert.equal(agent.AGENT_SERVICE_URL, undefined, "a tier never calls itself");
  assert.equal(agent.OPENAI_API_KEY, "load-test-agent-1", "a direct model call would be counted under the agent");

  const retrieval = environmentFor("retrieval");
  assert.equal(retrieval.MODEL_GATEWAY_URL, "http://127.0.0.1:7010");
  assert.equal(retrieval.AGENT_SERVICE_URL, undefined);
  assert.equal(retrieval.RETRIEVAL_SERVICE_URL, undefined);
  assert.equal(retrieval.VECTOR_STORE_PROVIDER, "pgvector");

  const gateway = environmentFor("model-gateway");
  assert.equal(gateway.ARCHIVE_RAG_ROLE, "model-gateway");
  assert.equal(gateway.MODEL_GATEWAY_CHAT_UPSTREAMS, "http://127.0.0.1:6999/v1");
  assert.equal(gateway.MODEL_GATEWAY_EMBEDDING_UPSTREAMS, "http://127.0.0.1:6999/v1");
  assert.equal(gateway.MODEL_GATEWAY_URL, undefined);
  assert.equal(gateway.POSTGRES_DATABASE_URL, undefined, "the gateway keeps no database");
  assert.equal(gateway.LONG_MEMORY_DATABASE_URL, undefined);
  assert.equal(gateway.OPENAI_API_KEY, `${GATEWAY_CALLER_PREFIX}0`);
  assert.equal(gateway.RAG_LLM_MAX_CONCURRENCY, "8", "the cap lives in the gateway");

  for (const tier of SPLIT_TIERS) {
    const environment = environmentFor(tier);
    assert.equal(environment.SERVICE_SHUTDOWN_GRACE_MS, "1000");
    // What the role start-up validates before it listens.
    assert.deepEqual(validateServiceTopology(environment).errors, [], `${tier} starts`);
  }

  assert.throws(() => environmentFor("worker"), /Unknown tier/);
  assert.throws(
    () => buildTierEnvironment({ modelBaseUrl: "x", options, storage: "pgvector", tempRoot: "/tmp", tier: "api" }),
    /internal service keys/
  );
});

test("a monolith child clears a shell's split wiring, so it stays a monolith", () => {
  const environment = buildAppEnvironment({
    baseEnvironment: {
      AGENT_SERVICE_URL: "http://elsewhere:1",
      ARCHIVE_RAG_ROLE: "api",
      INTERNAL_SERVICE_KEYS: "shell:shell-secret-shell-secret-shell-secret",
      MODEL_GATEWAY_TIMEOUT_MS: "5",
      MODEL_GATEWAY_URL: "http://elsewhere:2",
      PATH: "/usr/bin",
      PORT: "5001",
      RETRIEVAL_SERVICE_URL: "http://elsewhere:3",
    },
    modelBaseUrl: "http://127.0.0.1:1/v1",
    options: DEFAULT_LOAD_TEST_OPTIONS,
    storage: "local",
    tempRoot: "/tmp/load",
  });

  for (const name of [
    "AGENT_SERVICE_URL",
    "ARCHIVE_RAG_ROLE",
    "INTERNAL_SERVICE_KEYS",
    "MODEL_GATEWAY_TIMEOUT_MS",
    "MODEL_GATEWAY_URL",
    "PORT",
    "RETRIEVAL_SERVICE_URL",
  ]) {
    assert.equal(environment[name], undefined, name);
  }
  assert.equal(environment.PATH, "/usr/bin");
  assert.deepEqual(validateServiceTopology(environment), { errors: [], warnings: [] });
});

test("the run's internal key is one valid signing key whose id names the run", () => {
  const keys = createRunServiceKeys({ runId: "mg4k2x0a1b2c" });
  const parsed = parseServiceKeys(keys);

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.keys.length, 1);
  assert.equal(parsed.keys[0].keyId, "load-test-mg4k2x0a1b2c");
  assert.ok(parsed.keys[0].secret.length >= 32);
  assert.notEqual(createRunServiceKeys({ runId: "r" }), createRunServiceKeys({ runId: "r" }), "a fresh secret per run");
  assert.equal(tierCallerTag("model-gateway", 1), "gateway-1");
  assert.equal(tierCallerTag("agent", 0), "agent-0");
});

test("the config records the topology, the processes per tier and in total", () => {
  assert.deepEqual(describeTopologyConfig(parseLoadTestArgs([])), {
    tierReplicas: { [MONOLITH_TIER]: 1 },
    topology: "monolith",
    totalProcesses: 1,
  });
  assert.deepEqual(describeTopologyConfig(parseLoadTestArgs([...database, "--instances", "4"])).tierReplicas, { all: 4 });
  assert.deepEqual(
    describeTopologyConfig(parseLoadTestArgs([...database, "--scenario", "ingest", "--ingest-mode", "async", "--ingest-workers", "2"])),
    { tierReplicas: { all: 1, "ingest-worker": 2 }, topology: "monolith", totalProcesses: 3 }
  );

  const split = describeTopologyConfig(parseLoadTestArgs([...database, "--topology", "split", "--agent", "4"]));
  assert.equal(split.topology, "split");
  assert.deepEqual(Object.keys(split.tierReplicas), [...TIER_REPORT_ORDER], "listed in the order a request crosses them");
  assert.deepEqual(split.tierReplicas, { agent: 4, api: 1, "model-gateway": 1, retrieval: 1 });
  assert.equal(split.totalProcesses, 7);
});

const stats = (cpuMs, { dbQueries = 0, loop = 0, rssMb = 100, windowMs = 1000 } = {}) => ({
  cpuSystemMs: cpuMs / 4,
  cpuUserMs: (cpuMs * 3) / 4,
  dbQueries,
  eventLoopDelayMaxMs: loop,
  eventLoopDelayP99Ms: loop,
  rssMb,
  windowMs,
});

test("per tier: summed CPU per request, the busiest replica's cores and the tier's share; the busiest tier is named", () => {
  const processTiers = ["api", "api", "agent", "agent", "retrieval", "model-gateway"];
  const serverStats = [
    stats(100, { dbQueries: 10 }),
    stats(120),
    stats(900, { dbQueries: 40, loop: 12 }),
    stats(500, { dbQueries: 30, loop: 3 }),
    stats(200, { dbQueries: 50 }),
    null, // a process that reported nothing
  ];
  const idle = serverStats.map(() => ({ cpuMsPerSecond: 10, dbQueriesPerSecond: 0 }));
  const tiers = summarizeTierStats({ idle, processTiers, stats: serverStats, units: 100 });

  assert.deepEqual(Object.keys(tiers), ["api", "agent", "retrieval", "model-gateway"]);
  assert.equal(tiers.api.processes, 2);
  assert.equal(tiers.api.cpuMs, 220);
  assert.equal(tiers.api.cpuMsPerRequest, 2.2);
  assert.equal(tiers.api.cpuMsPerRequestNetOfIdle, 2, "two processes idling 10 ms/s over 1 s");
  assert.equal(tiers.api.coresBusy, 0.22);
  assert.equal(tiers.api.maxProcessCoresBusy, 0.12);
  assert.equal(tiers.api.dbQueriesPerRequest, 0.1);
  assert.equal(tiers.agent.cpuMsPerRequest, 14);
  assert.equal(tiers.agent.maxProcessCoresBusy, 0.9);
  assert.equal(tiers.agent.eventLoopDelayP99Ms, 12, "the worst replica's");
  assert.equal(tiers.agent.shareOfCpu, round3(1400 / 1820));
  assert.equal(tiers["model-gateway"].processes, 1);
  assert.equal(tiers["model-gateway"].reporting, 0);
  assert.equal(tiers["model-gateway"].maxProcessCoresBusy, null);
  assert.equal(tiers["model-gateway"].cpuMsPerRequestNetOfIdle, null, "no net figure without the process's numbers");

  assert.deepEqual(pickBusiestTier(tiers), { eventLoopDelayP99Ms: 12, maxProcessCoresBusy: 0.9, tier: "agent" });
  assert.equal(pickBusiestTier({}), null);
  assert.equal(
    pickBusiestTier({
      agent: { eventLoopDelayP99Ms: 1, maxProcessCoresBusy: 0.5 },
      retrieval: { eventLoopDelayP99Ms: 9, maxProcessCoresBusy: 0.5 },
    }).tier,
    "retrieval",
    "a tie goes to the worse event-loop delay"
  );

  // A monolith level is one tier, the same numbers as the level's own.
  const monolith = summarizeTierStats({ processTiers: ["all"], stats: [stats(300)], units: 30 });
  assert.equal(monolith.all.cpuMsPerRequest, 10);
  assert.equal(monolith.all.shareOfCpu, 1);
});

const round3 = (value) => Number(value.toFixed(3));

test("model calls that did not come through a gateway are counted from the fake's callers", () => {
  assert.equal(
    countDirectModelCalls({
      "load-test-gateway-0": { chat: 5, embeddings: 2 },
      "load-test-gateway-1": { chat: 4, embeddings: 0 },
    }),
    0
  );
  assert.equal(
    countDirectModelCalls({
      "load-test-agent-0": { chat: 1, embeddings: 0 },
      "load-test-gateway-0": { chat: 5, embeddings: 2 },
      "load-test-retrieval-0": { chat: 0, embeddings: 3 },
    }),
    4
  );
  assert.equal(countDirectModelCalls(undefined), 0);
});

test("repeats of a level give the range of its numbers, per tier too, and how often each tier was the busiest", () => {
  const level = (repeat, throughputRps, mean, agentCpu, busiest) => ({
    busiestTier: { tier: busiest },
    concurrency: 8,
    errors: repeat === 2 ? 1 : 0,
    latencyMs: { mean, p50: mean - 1, p95: mean + 5, p99: mean + 9 },
    repeat,
    server: { cpuMsPerRequest: agentCpu + 3 },
    throughputRps,
    tiers: { agent: { cpuMsPerRequest: agentCpu, maxProcessCoresBusy: 0.9 }, api: { cpuMsPerRequest: 1, maxProcessCoresBusy: 0.2 } },
  });
  const [row] = summarizeLevelRepeats([level(1, 100, 80, 12, "agent"), level(2, 110, 72, 11, "agent"), level(3, 95, 84, 13, "api")]);

  assert.equal(row.concurrency, 8);
  assert.equal(row.runs, 3);
  assert.equal(row.errors, 1);
  assert.deepEqual(row.throughputRps, { max: 110, mean: 101.67, min: 95, n: 3 });
  assert.deepEqual(row.latencyMeanMs, { max: 84, mean: 78.67, min: 72, n: 3 });
  assert.deepEqual(row.latencyP99Ms, { max: 93, mean: 87.67, min: 81, n: 3 });
  assert.deepEqual(row.cpuMsPerRequest, { max: 16, mean: 15, min: 14, n: 3 });
  assert.deepEqual(row.tiers.agent.cpuMsPerRequest, { max: 13, mean: 12, min: 11, n: 3 });
  assert.deepEqual(row.busiestTiers, { agent: 2, api: 1 });

  assert.equal(summarizeLevelRepeats([level(1, 1, 1, 1, "agent"), { ...level(1, 1, 1, 1, "agent"), concurrency: 32 }]).length, 2);
  assert.equal(rangeOf([null, undefined]), null);
  assert.deepEqual(rangeOf([3, Number.NaN, 5]), { max: 5, mean: 4, min: 3, n: 2 });
  assert.equal(levelLabel({ concurrency: 16 }), "16");
  assert.equal(levelLabel({ concurrency: 16, repeat: 2 }), "16 #2");
});

test("whole-run CPU per process and per tier, with a process that was gone left without numbers", () => {
  const summary = summarizeProcessTotals({
    processes: [
      { index: 0, pid: 11, port: 7000, tier: "api" },
      { index: 0, pid: 12, port: 7001, tier: "agent" },
      { index: 1, pid: 13, port: 7002, tier: "agent" },
      { index: 0, pid: 14, port: 7003, tier: "model-gateway" },
    ],
    totals: [
      { cpuSystemMs: 50, cpuUserMs: 150, dbQueries: 9, maxRssMb: 200, pid: 11, uptimeMs: 60000 },
      { cpuSystemMs: 100, cpuUserMs: 500, dbQueries: 30, maxRssMb: 250, pid: 12, uptimeMs: 60000 },
      null,
      { cpuSystemMs: 20, cpuUserMs: 180, maxRssMb: 150, pid: 14, uptimeMs: 60000 },
    ],
  });

  assert.equal(summary.totalCpuMs, 1000);
  assert.deepEqual(summary.byTier.api, { cpuMs: 200, cpuSystemMs: 50, cpuUserMs: 150, processes: 1, reporting: 1, shareOfCpu: 0.2 });
  assert.deepEqual(summary.byTier.agent, { cpuMs: 600, cpuSystemMs: 100, cpuUserMs: 500, processes: 2, reporting: 1, shareOfCpu: 0.6 });
  assert.equal(summary.processes[2].cpuMs, null);
  assert.equal(summary.processes[2].pid, 13);
  assert.equal(summary.processes[3].dbQueries, null);
  assert.match(formatLifetimeCpu({ lifetime: summary }), /agent 600 ms over 2 process\(es\) \(1 reported\), 60%/);
  assert.equal(formatLifetimeCpu(undefined), null);
});

test("the split warm-up may repeat the pool a few passes per retrieval replica", () => {
  assert.equal(splitWarmUpPassLimit(1), 6);
  assert.equal(splitWarmUpPassLimit(2), 10);
  assert.equal(splitWarmUpPassLimit(0), 6);
});

test("split runs get the topology notes instead of the multi-instance ones; chat repeats get the range note", () => {
  const split = buildMethodNotes(parseLoadTestArgs([...database, "--topology", "split", "--api", "2", "--repeat", "3"]));
  const topologyNotes = buildTopologyNotes({ balance: "least-outstanding", sharedState: "memory" });

  for (const note of topologyNotes) assert.ok(split.includes(note));
  assert.ok(split.includes(REPEAT_NOTE));
  assert.ok(!split.includes(buildMultiInstanceNotes({})[0]), "no N-monolith note in a split run");
  assert.match(topologyNotes.join(" "), /per gateway process/);
  assert.match(buildTopologyNotes({ sharedState: "redis" }).join(" "), /one cap for all gateway processes/);
  assert.match(topologyNotes.join(" "), /not written to the report/);

  const monolith = buildMethodNotes(parseLoadTestArgs([...database, "--instances", "2"]));
  assert.ok(monolith.includes(buildMultiInstanceNotes({})[0]));
  assert.ok(!monolith.includes(topologyNotes[0]));
  assert.ok(!monolith.includes(REPEAT_NOTE));
});

const tierBlock = (cpuMsPerRequest, maxProcessCoresBusy, extra = {}) => ({
  coresBusy: maxProcessCoresBusy,
  cpuMsPerRequest,
  cpuMsPerRequestNetOfIdle: cpuMsPerRequest,
  dbQueriesPerRequest: 1,
  eventLoopDelayP99Ms: 2,
  maxProcessCoresBusy,
  processes: 1,
  reporting: 1,
  rssMb: 200,
  shareOfCpu: 0.25,
  ...extra,
});

const splitLevel = (repeat, throughputRps) => ({
  busiestTier: { eventLoopDelayP99Ms: 9, maxProcessCoresBusy: 0.97, tier: "agent" },
  concurrency: 32,
  errors: 0,
  groundedAnswers: 256,
  latencyMs: { count: 256, max: 400, mean: 300, min: 100, p50: 290, p95: 380, p99: 399 },
  model: { chatCompletionsPerRequest: 1, directCalls: 0, embeddingRequestsPerRequest: 0, peakChatInFlight: 8 },
  repeat,
  requests: 256,
  server: { coresBusy: 1.9, cpuMsPerRequest: 18 },
  throughputRps,
  tiers: {
    api: tierBlock(1.1, 0.1),
    agent: tierBlock(13.5, 0.97, { processes: 2, reporting: 2 }),
    retrieval: tierBlock(1.6, 0.2),
    "model-gateway": tierBlock(1.2, 0.1),
  },
});

test("the split report shows the topology, processes, whole-run CPU per tier, per-tier rows, the busiest tier and the repeat ranges", () => {
  const levels = [splitLevel(1, 100), splitLevel(2, 108)];
  const report = {
    config: {
      accessScope: { tenant: true, userId: "load-test-user", workspaceId: "load-test-workspace" },
      balance: "least-outstanding",
      concurrency: [32],
      documents: 20,
      embeddingDimensions: 1536,
      embeddingLatencyMs: 0,
      idleMs: 3000,
      instances: 1,
      llmMaxConcurrency: 8,
      modelLatencyMs: [200],
      pages: 4,
      planner: "deterministic",
      questions: 80,
      repeat: 2,
      requests: 128,
      scenario: "chat",
      sharedState: "memory",
      storage: ["pgvector"],
      tierReplicas: { api: 1, agent: 2, retrieval: 1, "model-gateway": 1 },
      topology: "split",
      totalProcesses: 5,
      warmup: 8,
    },
    generatedAt: "2026-09-30T00:00:00.000Z",
    method: { notes: [], percentile: "nearest-rank" },
    reportVersion: LOAD_TEST_REPORT_VERSION,
    runs: [
      {
        idle: [1, 2, 3, 4, 5].map(() => ({ cpuMsPerSecond: 3, dbQueriesPerSecond: 0 })),
        idleMs: 3000,
        ingest: { chunkCount: 80, documentCount: 20, ingestMs: 900 },
        instances: [{ index: 0, port: 7000 }],
        scenarios: [
          {
            endpoint: "POST /chat",
            kind: "chat",
            levels,
            modelLatencyMs: 200,
            repeats: summarizeLevelRepeats(levels),
          },
        ],
        storage: "pgvector",
        topology: {
          lifetime: summarizeProcessTotals({
            processes: [{ index: 0, tier: "api" }],
            totals: [{ cpuSystemMs: 10, cpuUserMs: 90 }],
          }),
          processes: [
            { index: 0, port: 7000, tier: "api" },
            { index: 0, port: 7001, tier: "agent" },
            { index: 1, port: 7002, tier: "agent" },
            { index: 0, port: 7003, tier: "retrieval" },
            { index: 0, port: 7004, tier: "model-gateway" },
          ],
          tierReplicas: { api: 1, agent: 2, retrieval: 1, "model-gateway": 1 },
          topology: "split",
          totalProcesses: 5,
          warmUp: { failures: 0, lastPassEmbeddingRequests: 0, maxPasses: 6, passes: 2 },
        },
      },
    ],
  };
  const markdown = formatLoadTestMarkdown(report);

  assert.match(markdown, /\| Topology \| split, 5 processes: api x1, agent x2, retrieval x1, model-gateway x1 /);
  assert.match(markdown, /\| App instances \| 1 api replica\(s\);/);
  assert.match(markdown, /RAG_LLM_MAX_CONCURRENCY applies per gateway process/);
  assert.match(markdown, /\| Runs per level \| 2, in a row on the same processes \|/);
  assert.match(markdown, /Processes: api on port 7000; agent on ports 7001, 7002; retrieval on port 7003; model-gateway on port 7004\./);
  assert.match(markdown, /Query cache warm-up: 2 pass\(es\) over the question pool \(at most 6\); the last sent 0 embeddings request\(s\)\./);
  assert.match(markdown, /Idle for 3000 ms .*api #0 3 CPU ms\/s.*agent #1 3 CPU ms\/s.*model-gateway #0/);
  assert.match(markdown, /Whole-run CPU per tier .*: api 100 ms over 1 process\(es\), 100%\./);
  assert.match(markdown, /\| 32 #1 \| 256 \| 0 \| 100 \|/, "each run of a level is its own row");
  assert.match(markdown, /\| 32 #2 \| agent \| 2 \| 13\.5 \| 13\.5 \| 0\.97 \| 0\.97 \| 0\.25 \| 1 \| 2 \| 200 \|/);
  assert.match(markdown, /Busiest tier per level: c=32 #1 agent \(0\.97 cores\); c=32 #2 agent \(0\.97 cores\)\./);
  assert.match(markdown, /Model calls from any process but a gateway: 0 at every level/);
  assert.match(markdown, /\| Concurrency \| Runs \| Errors \| Req\/s \| Mean ms \| p50 ms \| p95 ms \| p99 ms \| CPU ms\/req \| api CPU ms\/req \| agent CPU ms\/req \|/);
  assert.match(markdown, /\| 32 \| 2 \| 0 \| 100 - 108 \| 300 \| 290 \| 380 \| 399 \| 18 \| 1\.1 \| 13\.5 \| 1\.6 \| 1\.2 \| agent 2 \|/);

  // A direct model call is named, not hidden.
  const bypassed = formatLoadTestMarkdown({
    ...report,
    runs: [
      {
        ...report.runs[0],
        scenarios: [{ ...report.runs[0].scenarios[0], levels: [{ ...splitLevel(1, 100), model: { directCalls: 3 } }], repeats: undefined }],
      },
    ],
  });
  assert.match(bypassed, /Model calls from a process other than a gateway: c=32 #1 3/);
});

test("a monolith report names its topology and keeps the per-tier table out; one without the field is a monolith", () => {
  assert.equal(formatTopologyConfig({ instances: 4, tierReplicas: { all: 4 }, topology: "monolith", totalProcesses: 4 }), "monolith: 4 process(es) of role all");
  assert.equal(formatTopologyConfig({ instances: 2 }), "monolith: 2 process(es) of role all", "reports written before --topology");
  assert.equal(
    formatTopologyConfig({ tierReplicas: { all: 1, "ingest-worker": 2 }, topology: "monolith" }),
    "monolith: 1 process(es) of role all and 2 dedicated ingest worker(s)"
  );

  const level = { ...splitLevel(undefined, 90), model: { chatCompletionsPerRequest: 1 }, repeat: undefined, tiers: { all: tierBlock(12, 1.1) } };
  const markdown = formatLoadTestMarkdown({
    config: {
      concurrency: [32],
      instances: 1,
      llmMaxConcurrency: 8,
      modelLatencyMs: [0],
      scenario: "chat",
      storage: ["pgvector"],
      tierReplicas: { all: 1 },
      topology: "monolith",
      totalProcesses: 1,
    },
    generatedAt: "2026-09-30T00:00:00.000Z",
    method: { notes: [], percentile: "nearest-rank" },
    runs: [
      {
        ingest: { chunkCount: 1, documentCount: 1, ingestMs: 1 },
        instances: [{ index: 0, port: 7000 }],
        scenarios: [{ endpoint: "POST /chat", kind: "chat", levels: [level], modelLatencyMs: 0 }],
        storage: "pgvector",
        topology: { lifetime: summarizeProcessTotals({ processes: [{ index: 0, tier: "all" }], totals: [{ cpuSystemMs: 1, cpuUserMs: 9 }] }) },
      },
    ],
  });

  assert.match(markdown, /\| Topology \| monolith: 1 process\(es\) of role all \|/);
  assert.match(markdown, /\| 32 \| 256 \| 0 \| 90 \|/);
  assert.match(markdown, /Whole-run CPU per tier .*: all 10 ms over 1 process\(es\), 100%\./);
  assert.doesNotMatch(markdown, /Per tier \(/);
  assert.doesNotMatch(markdown, /Runs per level/);
  assert.doesNotMatch(markdown, /Range over the repeats/);
});
