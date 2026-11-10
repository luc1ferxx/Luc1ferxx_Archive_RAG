import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatLatencyMarkdown,
  groupQaEvents,
  percentile,
  readEvents,
  summarizeQaLatency,
} from "../evaluation/qa-latency-breakdown.mjs";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const call = (stage, fields = {}) => ({
  inputTokens: 0,
  latencyMs: 0,
  outputTokens: 0,
  stage,
  status: "ok",
  traceType: "llmops",
  ...fields,
});
const trace = (fields = {}) => ({ abstained: false, latencyMs: 0, routeMode: "qa", traceId: "t", ...fields });

// Two documents ingested, then three questions asked one after another: the
// first answered, the second refused after two query embeddings, the third
// answered with a failed first completion.
const buildEvents = () => [
  call("embed_documents", { inputTokens: 4000, itemCount: 40, latencyMs: 9000 }),
  call("embed_documents", { inputTokens: 2000, itemCount: 20, latencyMs: 3000 }),
  call("embed_query", { inputTokens: 20, latencyMs: 20 }),
  call("complete_text", { inputTokens: 1500, latencyMs: 2000, outputTokens: 50 }),
  trace({ latencyMs: 2030 }),
  call("embed_query", { inputTokens: 10, latencyMs: 15 }),
  call("embed_query", { inputTokens: 30, latencyMs: 25 }),
  trace({ abstained: true, latencyMs: 45 }),
  call("embed_query", { inputTokens: 20, latencyMs: 30 }),
  call("complete_text", { errorName: "TimeoutError", latencyMs: 500, status: "error" }),
  call("complete_text", { inputTokens: 2500, latencyMs: 3000, outputTokens: 150 }),
  trace({ latencyMs: 3540 }),
];

test("each qa trace closes one question and takes the model calls logged since the last one", () => {
  const { ingest, otherTraces, questions } = groupQaEvents(buildEvents());

  assert.deepEqual(ingest, { calls: 2, chunks: 60, documents: 2, failedCalls: 0, inputTokens: 6000, ms: 12000, outputTokens: 0 });
  assert.equal(otherTraces, 0);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions[0], {
    abstained: false,
    completion: { calls: 1, failedCalls: 0, inputTokens: 1500, ms: 2000, outputTokens: 50 },
    embedding: { calls: 1, failedCalls: 0, inputTokens: 20, ms: 20, outputTokens: 0 },
    latencyMs: 2030,
    otherModelCalls: 0,
    routeMs: 10,
  });
  // A refused question called no answer model; both of its embeddings are its own.
  assert.equal(questions[1].abstained, true);
  assert.deepEqual([questions[1].embedding.calls, questions[1].embedding.ms, questions[1].completion.calls, questions[1].routeMs], [2, 40, 0, 5]);
  // A failed call's time is the question's too.
  assert.deepEqual([questions[2].completion.calls, questions[2].completion.failedCalls, questions[2].completion.ms, questions[2].routeMs], [2, 1, 3500, 10]);
});

test("traces of other routes are left out, calls of unknown stages are counted, and agent runs are refused", () => {
  const events = [
    call("embed_query", { latencyMs: 10 }),
    call("rerank", { latencyMs: 40 }),
    trace({ latencyMs: 60 }),
    call("embed_query", { latencyMs: 10 }),
    trace({ latencyMs: 30, routeMode: "comparison" }),
    // A trace without a finite latency cannot be placed.
    trace({ latencyMs: null }),
    { note: "not an event of this kind" },
    call("embed_query", { latencyMs: 5 }),
    trace({ latencyMs: 4 }),
  ];
  const grouped = groupQaEvents(events);

  assert.equal(grouped.questions.length, 2);
  assert.equal(grouped.otherTraces, 2);
  assert.equal(grouped.questions[0].otherModelCalls, 1);
  // Clamped at 0 when the calls' own clocks add up to more than the question's.
  assert.equal(grouped.questions[1].routeMs, 0);
  assert.throws(() => groupQaEvents([{ traceType: "agent" }]), /agent traces; the breakdown reads rag-surface runs/);
});

test("the summary splits answered from refused questions and reports percentiles, shares and tokens", () => {
  const summary = summarizeQaLatency(groupQaEvents(buildEvents()));

  assert.equal(summary.questions, 3);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.answered.questions, 2);
  assert.equal(summary.refused.questions, 1);
  assert.deepEqual(summary.answered.latencyMs, { max: 3540, p50: 2030, p90: 3540, p95: 3540 });
  assert.deepEqual(summary.answered.completionMs, { max: 3500, p50: 2000, p90: 3500, p95: 3500 });
  assert.deepEqual(summary.refused.latencyMs, { max: 45, p50: 45, p90: 45, p95: 45 });
  assert.deepEqual(summary.refused.completionMs, { max: 0, p50: 0, p90: 0, p95: 0 });
  // (2000 + 3500) / (2030 + 3540), (20 + 30) / 5570 and (10 + 10) / 5570.
  assert.deepEqual(summary.answered.timeShare, { completion: 0.9874, embedding: 0.009, route: 0.0036 });
  assert.deepEqual(summary.answered.inputTokens, { max: 2500, mean: 2000, p50: 1500, p95: 2500 });
  assert.deepEqual(summary.answered.outputTokens, { max: 150, mean: 100, p50: 50, p95: 150 });
  assert.equal(summary.answered.failedCalls, 1);
  assert.equal(summary.refused.embeddingCalls, 2);
  assert.deepEqual(summary.ingest, { chunks: 60, documents: 2, failedCalls: 0, seconds: 12, tokens: 6000 });
  assert.equal(summary.cost, undefined);
});

test("warm-up questions can be dropped, and prices turn the tokens into cost", () => {
  const grouped = groupQaEvents(buildEvents());
  const skipped = summarizeQaLatency(grouped, { skip: 1 });

  assert.deepEqual([skipped.questions, skipped.skipped, skipped.answered.questions, skipped.refused.questions], [2, 1, 1, 1]);

  const priced = summarizeQaLatency(grouped, { chatPrice: { input: 2, output: 10 }, embeddingPrice: { input: 0.1 } });

  // Answered: (4000 input * $2 + 200 output * $10 + 40 embedding * $0.1) / 1e6 over 2 questions, times 1,000.
  assert.equal(priced.cost.usdPer1000Answered, 5.002);
  // Refused: 40 embedding tokens of one question.
  assert.equal(priced.cost.usdPer1000Refused, 0.004);
  // All three: (8000 + 2000 + 8) / 1e6 / 3 * 1000.
  assert.equal(priced.cost.usdPer1000Questions, 3.336);
  // Ingest: 6000 tokens * $0.1 / 1e6 over 2 documents, times 1,000.
  assert.equal(priced.cost.ingestUsdPer1000Documents, 0.3);
});

test("the percentile is the nearest rank, and null without samples", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([5, 1, 3], 0), 1);
  assert.equal(percentile([5, 1, 3], 100), 5);
  assert.equal(percentile([1, 2, 3, 4, NaN], 75), 3);
});

test("the Markdown names every stage and, with prices, the cost", () => {
  const grouped = groupQaEvents(buildEvents());
  const plain = formatLatencyMarkdown(summarizeQaLatency(grouped, { skip: 1 })).join("\n");

  assert.match(plain, /^QA latency over 2 questions asked one at a time \(1 answered, 1 refused; the first 1 dropped as warm-up\), in ms:/);
  assert.match(plain, /\| Answered: whole question \| 1 \| 3540 \| 3540 \| 3540 \| 3540 \|/);
  assert.match(plain, /\| Refused: the route's own work \| 1 \| 5 \| 5 \| 5 \| 5 \|/);
  // 30 of 3540 ms is 0.85%, which one decimal may print either way.
  assert.match(plain, /Share of the answered questions' time: answer model 98\.9%, query embedding 0\.[89]%, the route 0\.3%\./);
  assert.match(plain, /Tokens per answered question: input p50 2500 \/ p95 2500 \/ max 2500, output p50 150 \/ p95 150 \/ max 150/);
  assert.match(plain, /Ingest: 2 documents, 60 chunks, 6000 embedding tokens, 12 s of embedding calls\./);
  assert.match(plain, /Failed model calls: 1 in questions, 0 in the ingest; their time is counted\./);
  assert.doesNotMatch(plain, /Cost at/);

  const priced = formatLatencyMarkdown(
    summarizeQaLatency(grouped, { chatPrice: { input: 2, output: 10 }, embeddingPrice: { input: 0.1 } })
  ).join("\n");

  assert.match(priced, /Cost at \$2 \/ \$10 per million chat input \/ output tokens and \$0\.1 per million embedding tokens: \$5\.002 per 1,000 answered questions, \$0\.004 per 1,000 refused, \$3\.336 per 1,000 questions at this run's answer rate; ingest \$0\.3 per 1,000 documents\./);

  // Nothing answered: the answered rows read n/a instead of failing.
  const refusedOnly = formatLatencyMarkdown(summarizeQaLatency(groupQaEvents(buildEvents().slice(5, 8)))).join("\n");

  assert.match(refusedOnly, /\| Answered: whole question \| 0 \| n\/a \| n\/a \| n\/a \| n\/a \|/);
  assert.match(refusedOnly, /answer model n\/a/);
});

test("the command reads a JSONL file, skips broken lines and names what it refuses", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-latency-"));

  try {
    const eventsPath = path.join(tempRoot, "events.jsonl");
    const tool = path.join(serverDirectory, "evaluation", "qa-latency-breakdown.mjs");
    const run = (args) => spawnSync(process.execPath, [tool, ...args], { cwd: serverDirectory, encoding: "utf8" });

    await writeFile(eventsPath, `${buildEvents().map((event) => JSON.stringify(event)).join("\n")}\n{broken\n\n`);
    assert.equal((await readEvents(eventsPath)).length, 12);

    const printed = run(["--events", eventsPath]);

    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /^QA latency over 3 questions asked one at a time \(2 answered, 1 refused\), in ms:/);

    const json = run(["--events", eventsPath, "--skip", "1", "--chat-price", "2,10", "--embedding-price", "0.1", "--json"]);

    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).skipped, 1);
    assert.deepEqual(JSON.parse(json.stdout).cost.chatPrice, { input: 2, output: 10 });

    for (const [args, message] of [
      [[], /Usage: qa-latency-breakdown\.mjs --events/],
      [["--events", eventsPath, "--skip", "-1"], /--skip must be a non-negative integer/],
      [["--events", eventsPath, "--chat-price", "2"], /--chat-price takes <input>,<output>/],
      [["--events", eventsPath, "--chat-price", "2,10"], /Give both --chat-price and --embedding-price, or neither/],
      [["--events", eventsPath, "--chat-price", "2,10", "--embedding-price", "x"], /--embedding-price takes <input>/],
    ]) {
      const refused = run(args);

      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, message);
    }

    await writeFile(eventsPath, `${JSON.stringify(call("embed_documents"))}\n`);
    const empty = run(["--events", eventsPath]);

    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /holds no qa trace; run with RAG_OBSERVABILITY_ENABLED=true/);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});
