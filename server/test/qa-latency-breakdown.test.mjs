import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareQaLatency,
  formatLatencyComparisonMarkdown,
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
    // These traces carry no question text.
    key: null,
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

test("a failed question closes itself: its model calls are not the next question's", () => {
  // chat() names the route only after it returned, so the trace of a failed question has none.
  const events = [
    call("embed_query", { inputTokens: 10, latencyMs: 10 }),
    call("complete_text", { errorName: "Error", latencyMs: 700, status: "error" }),
    { error: "upstream failed", latencyMs: 720, routeMode: null, traceId: "failed" },
    call("embed_query", { inputTokens: 10, latencyMs: 10 }),
    call("complete_text", { inputTokens: 1000, latencyMs: 900, outputTokens: 40 }),
    trace({ latencyMs: 915 }),
  ];
  const grouped = groupQaEvents(events);

  assert.deepEqual([grouped.questions.length, grouped.failedTraces, grouped.otherTraces], [1, 1, 0]);
  assert.deepEqual(
    [grouped.questions[0].completion.calls, grouped.questions[0].completion.failedCalls, grouped.questions[0].embedding.calls, grouped.questions[0].routeMs],
    [1, 0, 1, 5]
  );

  const summary = summarizeQaLatency(grouped);

  assert.equal(summary.failedTraces, 1);
  assert.match(formatLatencyMarkdown(summary).join("\n"), /1 failed question\(s\) were left out, with their model calls\./);
});

test("other model calls inside a question are said, and a file holding a gateway's events twice is refused", () => {
  const withReranker = groupQaEvents([call("embed_query", { latencyMs: 10 }), call("cross_encoder_score", { latencyMs: 40 }), trace({ latencyMs: 60 })]);
  const summary = summarizeQaLatency(withReranker);

  assert.equal(summary.answered.otherModelCalls, 1);
  assert.match(formatLatencyMarkdown(summary).join("\n"), /1 other model call\(s\) \(a reranker, for example\) ran inside these questions; their time is under the route's own work\./);

  const mirror = call("complete_text", { annotations: [{ id: "model_gateway_mirror" }], latencyMs: 900 });
  const metered = call("complete_text", { annotations: [{ id: "model_gateway_metered" }], latencyMs: 900 });

  // The caller's mirror alone is the only record of the call and is read.
  assert.equal(groupQaEvents([mirror, trace({ latencyMs: 910 })]).questions[0].completion.calls, 1);
  assert.throws(() => groupQaEvents([mirror, metered, trace({ latencyMs: 910 })]), /both the model gateway's metered events and the callers' mirrors/);
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
  assert.match(plain, /Ingest: 2 document embedding call\(s\), 60 chunks, 6000 embedding tokens, 12 s of embedding calls\./);
  assert.doesNotMatch(plain, /other model call|failed question/);
  assert.match(plain, /Failed model calls: 1 in questions, 0 in the ingest; their time is counted\./);
  assert.doesNotMatch(plain, /Cost at/);

  const priced = formatLatencyMarkdown(
    summarizeQaLatency(grouped, { chatPrice: { input: 2, output: 10 }, embeddingPrice: { input: 0.1 } })
  ).join("\n");

  assert.match(priced, /Cost at \$2 \/ \$10 per million chat input \/ output tokens and \$0\.1 per million embedding tokens: \$5\.002 per 1,000 answered questions, \$0\.004 per 1,000 refused, \$3\.336 per 1,000 questions at this run's answer rate; ingest \$0\.3 per 1,000 document embedding calls\./);

  // A group without questions has no cost to print, not "$null".
  const refusedPriced = formatLatencyMarkdown(
    summarizeQaLatency(groupQaEvents(buildEvents().slice(5, 8)), { chatPrice: { input: 2, output: 10 }, embeddingPrice: { input: 0.1 } })
  ).join("\n");

  assert.match(refusedPriced, /: n\/a per 1,000 answered questions, \$0\.004 per 1,000 refused, \$0\.004 per 1,000 questions at this run's answer rate; ingest n\/a per 1,000 document embedding calls\./);
  assert.doesNotMatch(refusedPriced, /null/);

  // Nothing answered: the answered rows read n/a instead of failing.
  const refusedOnly = formatLatencyMarkdown(summarizeQaLatency(groupQaEvents(buildEvents().slice(5, 8)))).join("\n");

  assert.match(refusedOnly, /\| Answered: whole question \| 0 \| n\/a \| n\/a \| n\/a \| n\/a \|/);
  assert.match(refusedOnly, /answer model n\/a/);
});

// One run as its events: every question embeds its query once, an answered one
// then calls the answer model.
const buildRun = (questions) =>
  questions.flatMap(({ completion = null, latencyMs, query }) => [
    call("embed_query", { inputTokens: 10, latencyMs: 5 }),
    ...(completion ? [call("complete_text", completion)] : []),
    trace({ abstained: !completion, latencyMs, query }),
  ]);

// The same five questions under two settings: the first and the third answered
// by both, the second refused by both, the fourth answered only here, the
// fifth only there.
const buildHere = () =>
  buildRun([
    { completion: { inputTokens: 1800, latencyMs: 1900, outputTokens: 60 }, latencyMs: 2000, query: "What is alpha?" },
    { latencyMs: 20, query: "What is beta?" },
    { completion: { inputTokens: 2000, latencyMs: 2900, outputTokens: 100 }, latencyMs: 3000, query: "What is gamma?" },
    { completion: { inputTokens: 1700, latencyMs: 2400, outputTokens: 80 }, latencyMs: 2500, query: "What is delta?" },
    { latencyMs: 25, query: "What is epsilon?" },
  ]);
const buildThere = () =>
  buildRun([
    { completion: { inputTokens: 1300, latencyMs: 1400, outputTokens: 60 }, latencyMs: 1500, query: "What is alpha?" },
    { latencyMs: 18, query: "What is beta?" },
    { completion: { inputTokens: 1400, latencyMs: 2500, outputTokens: 120 }, latencyMs: 2600, query: "What is gamma?" },
    { latencyMs: 22, query: "What is delta?" },
    { completion: { inputTokens: 900, latencyMs: 950, outputTokens: 30 }, latencyMs: 1000, query: "What is epsilon?" },
  ]);

test("a question's text is kept only as a fingerprint", () => {
  const grouped = groupQaEvents(buildHere());

  assert.match(grouped.questions[0].key, /^[0-9a-f]{16}$/);
  assert.equal(new Set(grouped.questions.map((question) => question.key)).size, 5);
  assert.equal(grouped.questions[0].key, groupQaEvents(buildThere()).questions[0].key);
  assert.equal(/alpha|What is/.test(JSON.stringify(grouped)), false);
  assert.equal(/alpha|What is/.test(JSON.stringify(summarizeQaLatency(grouped))), false);
});

test("two runs over the same questions are paired by position: both answered, both refused, and the flips", () => {
  const comparison = compareQaLatency(groupQaEvents(buildHere()), groupQaEvents(buildThere()));

  assert.deepEqual([comparison.questions, comparison.answeredOnlyHere, comparison.answeredOnlyThere], [5, 1, 1]);
  assert.deepEqual([comparison.iterations, comparison.seed], [10000, 12345]);
  assert.equal(comparison.answeredBoth.questions, 2);
  // 2000 - 1500 and 3000 - 2600. With two differences every resampled mean is
  // 400, 450 or 500, so the interval is their range.
  assert.deepEqual(comparison.answeredBoth.latencyMs, {
    cases: 2,
    ci95: [400, 500],
    current: { mean: 2500, p50: 2000 },
    delta: 450,
    medianDelta: 400,
    other: { mean: 2050, p50: 1500 },
  });
  assert.deepEqual(
    [comparison.answeredBoth.completionMs.delta, comparison.answeredBoth.inputTokens.delta, comparison.answeredBoth.inputTokens.ci95],
    [450, 550, [500, 600]]
  );
  // 60 - 60 and 100 - 120: this run wrote less on one question.
  assert.deepEqual(
    [comparison.answeredBoth.outputTokens.delta, comparison.answeredBoth.outputTokens.medianDelta, comparison.answeredBoth.outputTokens.ci95],
    [-10, -20, [-20, 0]]
  );
  assert.deepEqual(comparison.refusedBoth, {
    latencyMs: { cases: 1, ci95: [2, 2], current: { mean: 20, p50: 20 }, delta: 2, medianDelta: 2, other: { mean: 18, p50: 18 } },
    questions: 1,
  });

  // The first question dropped from both runs as warm-up.
  const skipped = compareQaLatency(groupQaEvents(buildHere()), groupQaEvents(buildThere()), { iterations: 200, seed: 7, skip: 1 });

  assert.deepEqual([skipped.questions, skipped.answeredBoth.questions, skipped.answeredBoth.latencyMs.delta, skipped.iterations, skipped.seed], [4, 1, 400, 200, 7]);

  const markdown = formatLatencyComparisonMarkdown(comparison, "there.jsonl").join("\n");

  assert.match(
    markdown,
    /^Paired with `there\.jsonl` by question \(5 questions: 2 answered in both runs, 1 refused in both, 1 answered only in this run, 1 only in the other\); this run minus that one, 95% CI of the mean difference \(bootstrap over questions, 10000 iterations, seed 12345\):/
  );
  assert.match(markdown, /\| Answered in both: whole question, ms \| 2 \| 2000 \| 1500 \| \+450 \| \[400, 500\] \| \+400 \|/);
  assert.match(markdown, /\| Answered in both: input tokens \| 2 \| 1800 \| 1300 \| \+550 \| \[500, 600\] \| \+500 \|/);
  assert.match(markdown, /\| Answered in both: output tokens \| 2 \| 60 \| 60 \| -10 \| \[-20, 0\] \| -20 \|/);
  assert.match(markdown, /\| Refused in both: whole question, ms \| 1 \| 20 \| 18 \| \+2 \| \[2, 2\] \| \+2 \|/);
});

test("runs that did not ask the same questions in the same order are refused, not compared", () => {
  const here = groupQaEvents(buildHere());
  const shorter = groupQaEvents(buildThere().slice(0, -2));
  const reordered = groupQaEvents([...buildThere().slice(3), ...buildThere().slice(0, 3)]);
  const withoutText = groupQaEvents(buildThere().map((event) => ({ ...event, query: undefined })));

  assert.throws(() => compareQaLatency(here, shorter), /The runs hold 5 and 4 questions; a paired comparison needs the same questions in the same order/);
  assert.throws(() => compareQaLatency(here, reordered), /Question 1 is not the same in both runs/);
  assert.throws(() => compareQaLatency(here, withoutText), /Question 1 is not the same in both runs, or its trace holds no question text to check/);
  assert.throws(() => compareQaLatency(withoutText, withoutText), /Question 1 is not the same in both runs, or its trace holds no question text to check/);

  // Nothing answered by both: the rows read n/a instead of failing.
  const refusedOnly = compareQaLatency(
    groupQaEvents(buildRun([{ latencyMs: 20, query: "What is beta?" }])),
    groupQaEvents(buildRun([{ latencyMs: 18, query: "What is beta?" }]))
  );

  assert.deepEqual([refusedOnly.answeredBoth.questions, refusedOnly.refusedBoth.questions, refusedOnly.refusedBoth.latencyMs.delta], [0, 1, 2]);

  assert.deepEqual(refusedOnly.answeredBoth.latencyMs, { cases: 0, ci95: null, current: { mean: null, p50: null }, delta: null, medianDelta: null, other: { mean: null, p50: null } });
  assert.match(formatLatencyComparisonMarkdown(refusedOnly, "x").join("\n"), /\| Answered in both: whole question, ms \| 0 \| n\/a \| n\/a \| n\/a \| n\/a \| n\/a \|/);
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

    // Two runs over the same questions, compared.
    const herePath = path.join(tempRoot, "here.jsonl");
    const therePath = path.join(tempRoot, "there.jsonl");
    const toJsonl = (events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

    await writeFile(herePath, toJsonl(buildHere()));
    await writeFile(therePath, toJsonl(buildThere()));

    const compared = run(["--events", herePath, "--compare", therePath]);

    assert.equal(compared.status, 0, compared.stderr);
    assert.match(compared.stdout, /^QA latency over 5 questions asked one at a time \(3 answered, 2 refused\), in ms:/);
    assert.match(compared.stdout, /Paired with `there\.jsonl` by question \(5 questions: 2 answered in both runs, 1 refused in both, 1 answered only in this run, 1 only in the other\)/);
    assert.match(compared.stdout, /\| Answered in both: whole question, ms \| 2 \| 2000 \| 1500 \| \+450 \| \[400, 500\] \| \+400 \|/);
    assert.equal(/alpha|What is/.test(compared.stdout), false);

    const comparedJson = run(["--events", herePath, "--compare", therePath, "--iterations", "300", "--seed", "9", "--skip", "1", "--json"]);

    assert.equal(comparedJson.status, 0, comparedJson.stderr);
    assert.deepEqual(
      [
        JSON.parse(comparedJson.stdout).comparison.other,
        JSON.parse(comparedJson.stdout).comparison.questions,
        JSON.parse(comparedJson.stdout).comparison.iterations,
        JSON.parse(comparedJson.stdout).comparison.seed,
        JSON.parse(comparedJson.stdout).comparison.answeredBoth.latencyMs.delta,
      ],
      ["there.jsonl", 4, 300, 9, 400]
    );
    assert.equal(JSON.parse(json.stdout).comparison, undefined);

    for (const [args, message] of [
      [["--events", herePath, "--compare", therePath, "--iterations", "0"], /--iterations must be a positive integer/],
      [["--events", herePath, "--compare", therePath, "--seed", "x"], /--seed must be a positive integer/],
      // The first file's events carry no question text and hold three questions.
      [["--events", herePath, "--compare", eventsPath], /The runs hold 5 and 3 questions/],
      [["--events", herePath, "--compare", path.join(tempRoot, "missing.jsonl")], /missing\.jsonl/],
      [["--events", herePath, "--compare"], /--compare takes the other run's events file/],
      [["--events", herePath, "--compare", "--json"], /--compare takes the other run's events file/],
      [["--events", herePath, "--compare="], /--compare takes the other run's events file/],
      [["--events", herePath, "--skip", "5"], /--skip 5 leaves none of the 5 questions/],
      [["--events", herePath, "--chat-price", ",4", "--embedding-price", "0.02"], /--chat-price takes <input>,<output>/],
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
