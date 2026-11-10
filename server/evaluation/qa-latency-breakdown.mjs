// qa-latency-breakdown.mjs
//
// Where the time and the tokens of the QA route go, read from the
// observability events (RAG_OBSERVABILITY_ENABLED) of a run that asked one
// question at a time, such as eval:qasper-answers on the rag surface. Each
// `qa` trace closes one question, and the model calls logged since the
// previous trace are that question's: its query embedding(s) and, when it was
// answered, its completion. What is left of the question's latency after
// those calls is the route's own work (search, fusion, gate, context, checks).
// Document embeddings are the ingest. Only timings, token counts and flags are
// read, never a question or an answer.
//
// With prices (USD per million tokens) it also estimates cost through the
// model contract's own formula (estimateLlmOpsCost); without them it reports
// tokens only. Embedding tokens are the events' own figures, which are
// estimates from characters unless the endpoint reported usage.
//
// Usage:
//   node evaluation/qa-latency-breakdown.mjs --events <events.jsonl>
//     [--skip 0] [--chat-price <input>,<output>] [--embedding-price <input>] [--json]

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { estimateLlmOpsCost } from "../rag/llmops-usage.js";
import { getArgValue } from "./eval-cli.js";

const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => (values.length > 0 ? sum(values) / values.length : null);

/** Nearest-rank percentile (p in 0..100), null for no samples; as in run-api-load-bench.mjs. */
export const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);

  if (sorted.length === 0) {
    return null;
  }

  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
};

const emptyCalls = () => ({ calls: 0, failedCalls: 0, inputTokens: 0, ms: 0, outputTokens: 0 });

const addCall = (bucket, event) => {
  bucket.calls += 1;
  bucket.failedCalls += event.errorName || (event.status && event.status !== "ok") ? 1 : 0;
  bucket.ms += Number.isFinite(event.latencyMs) ? event.latencyMs : 0;
  bucket.inputTokens += Number.isFinite(event.inputTokens) ? event.inputTokens : 0;
  bucket.outputTokens += Number.isFinite(event.outputTokens) ? event.outputTokens : 0;
};

/**
 * The questions of a sequential run, each with its own model calls, and the
 * ingest. Throws on agent traces: an agent run writes several traces and
 * planner calls per question, which this grouping cannot attribute.
 */
export const groupQaEvents = (events) => {
  const questions = [];
  const ingest = { chunks: 0, documents: 0, ...emptyCalls() };
  let pending = { completion: emptyCalls(), embedding: emptyCalls(), other: 0 };
  let otherTraces = 0;

  for (const event of events) {
    if (event?.traceType === "agent") {
      throw new Error("These events hold agent traces; the breakdown reads rag-surface runs, one qa trace per question.");
    }

    if (event?.traceType === "llmops") {
      if (event.stage === "embed_documents") {
        addCall(ingest, event);
        ingest.documents += 1;
        ingest.chunks += Number.isFinite(event.itemCount) ? event.itemCount : 0;
      } else if (event.stage === "embed_query") {
        addCall(pending.embedding, event);
      } else if (event.stage === "complete_text") {
        addCall(pending.completion, event);
      } else {
        pending.other += 1;
      }

      continue;
    }

    if (typeof event?.routeMode !== "string") {
      continue;
    }

    if (event.routeMode === "qa" && Number.isFinite(event.latencyMs)) {
      const modelMs = pending.embedding.ms + pending.completion.ms;

      questions.push({
        abstained: Boolean(event.abstained),
        completion: pending.completion,
        embedding: pending.embedding,
        latencyMs: event.latencyMs,
        otherModelCalls: pending.other,
        // Clamped: the calls are timed inside the question, but each on its own clock.
        routeMs: Math.max(0, event.latencyMs - modelMs),
      });
    } else {
      otherTraces += 1;
    }

    pending = { completion: emptyCalls(), embedding: emptyCalls(), other: 0 };
  }

  return { ingest, otherTraces, questions };
};

const describeMs = (values) => ({
  max: round(percentile(values, 100)),
  p50: round(percentile(values, 50)),
  p90: round(percentile(values, 90)),
  p95: round(percentile(values, 95)),
});

const describeTokens = (values) => ({
  max: percentile(values, 100),
  mean: round(mean(values)),
  p50: percentile(values, 50),
  p95: percentile(values, 95),
});

const describeGroup = (questions) => {
  const total = sum(questions.map((question) => question.latencyMs));
  const part = (read) => (total > 0 ? round(sum(questions.map(read)) / total, 4) : null);

  return {
    completionMs: describeMs(questions.map((question) => question.completion.ms)),
    embeddingCalls: round(mean(questions.map((question) => question.embedding.calls)), 2),
    embeddingMs: describeMs(questions.map((question) => question.embedding.ms)),
    embeddingTokens: describeTokens(questions.map((question) => question.embedding.inputTokens)),
    failedCalls: sum(questions.map((question) => question.embedding.failedCalls + question.completion.failedCalls)),
    inputTokens: describeTokens(questions.map((question) => question.completion.inputTokens)),
    latencyMs: describeMs(questions.map((question) => question.latencyMs)),
    outputTokens: describeTokens(questions.map((question) => question.completion.outputTokens)),
    questions: questions.length,
    routeMs: describeMs(questions.map((question) => question.routeMs)),
    timeShare: {
      completion: part((question) => question.completion.ms),
      embedding: part((question) => question.embedding.ms),
      route: part((question) => question.routeMs),
    },
  };
};

const costOf = (pricing, usage) => estimateLlmOpsCost({ pricing, usage }).estimatedCostUsd;

/**
 * Latency percentiles, time shares and token figures of the answered and the
 * refused questions (a question the route refused calls no answer model),
 * after dropping the first `skip` questions as warm-up. With prices, the cost
 * of 1,000 questions and of the ingest.
 */
export const summarizeQaLatency = ({ ingest, otherTraces = 0, questions }, { chatPrice = null, embeddingPrice = null, skip = 0 } = {}) => {
  const measured = questions.slice(skip);
  const answered = measured.filter((question) => !question.abstained);
  const refused = measured.filter((question) => question.abstained);
  const summary = {
    answered: describeGroup(answered),
    ingest: {
      chunks: ingest.chunks,
      documents: ingest.documents,
      failedCalls: ingest.failedCalls,
      seconds: round(ingest.ms / 1000),
      tokens: ingest.inputTokens,
    },
    otherTraces,
    questions: measured.length,
    refused: describeGroup(refused),
    skipped: questions.length - measured.length,
  };

  if (chatPrice && embeddingPrice) {
    const embeddingPricing = { inputPerMillionTokens: embeddingPrice.input, outputPerMillionTokens: 0 };
    const chatPricing = { inputPerMillionTokens: chatPrice.input, outputPerMillionTokens: chatPrice.output };
    // Priced on the group's token totals, so the contract's rounding of one
    // call's cost does not add up over a thousand questions.
    const groupCost = (group) =>
      costOf(embeddingPricing, { inputTokens: sum(group.map((question) => question.embedding.inputTokens)), outputTokens: 0 }) +
      costOf(chatPricing, {
        inputTokens: sum(group.map((question) => question.completion.inputTokens)),
        outputTokens: sum(group.map((question) => question.completion.outputTokens)),
      });
    const per1000 = (group) => (group.length > 0 ? round((groupCost(group) / group.length) * 1000, 4) : null);

    summary.cost = {
      chatPrice,
      embeddingPrice,
      ingestUsdPer1000Documents:
        ingest.documents > 0
          ? round((costOf(embeddingPricing, { inputTokens: ingest.inputTokens, outputTokens: 0 }) / ingest.documents) * 1000, 4)
          : null,
      usdPer1000Answered: per1000(answered),
      usdPer1000Questions: per1000(measured),
      usdPer1000Refused: per1000(refused),
    };
  }

  return summary;
};

const formatMsRow = (label, group, stats) =>
  `| ${label} | ${group.questions} | ${stats.p50 ?? "n/a"} | ${stats.p90 ?? "n/a"} | ${stats.p95 ?? "n/a"} | ${stats.max ?? "n/a"} |`;

const formatShare = (value) => (value === null ? "n/a" : `${round(value * 100)}%`);

/** The summary as Markdown lines. */
export const formatLatencyMarkdown = (summary) => {
  const { answered, refused } = summary;

  return [
    `QA latency over ${summary.questions} questions asked one at a time (${answered.questions} answered, ${refused.questions} refused${summary.skipped > 0 ? `; the first ${summary.skipped} dropped as warm-up` : ""}), in ms:`,
    "",
    "| | Questions | p50 | p90 | p95 | max |",
    "|---|---|---|---|---|---|",
    formatMsRow("Answered: whole question", answered, answered.latencyMs),
    formatMsRow("Answered: answer model", answered, answered.completionMs),
    formatMsRow("Answered: query embedding", answered, answered.embeddingMs),
    formatMsRow("Answered: the route's own work", answered, answered.routeMs),
    formatMsRow("Refused: whole question", refused, refused.latencyMs),
    formatMsRow("Refused: query embedding", refused, refused.embeddingMs),
    formatMsRow("Refused: the route's own work", refused, refused.routeMs),
    "",
    `Share of the answered questions' time: answer model ${formatShare(answered.timeShare.completion)}, query embedding ${formatShare(answered.timeShare.embedding)}, the route ${formatShare(answered.timeShare.route)}.`,
    `Tokens per answered question: input p50 ${answered.inputTokens.p50 ?? "n/a"} / p95 ${answered.inputTokens.p95 ?? "n/a"} / max ${answered.inputTokens.max ?? "n/a"}, output p50 ${answered.outputTokens.p50 ?? "n/a"} / p95 ${answered.outputTokens.p95 ?? "n/a"} / max ${answered.outputTokens.max ?? "n/a"}; query embedding ${answered.embeddingTokens.mean ?? "n/a"} tokens over ${answered.embeddingCalls ?? "n/a"} call(s) on average (refused: ${refused.embeddingTokens.mean ?? "n/a"} tokens over ${refused.embeddingCalls ?? "n/a"}).`,
    `Ingest: ${summary.ingest.documents} documents, ${summary.ingest.chunks} chunks, ${summary.ingest.tokens} embedding tokens, ${summary.ingest.seconds} s of embedding calls.`,
    ...(answered.failedCalls + refused.failedCalls + summary.ingest.failedCalls > 0
      ? [`Failed model calls: ${answered.failedCalls + refused.failedCalls} in questions, ${summary.ingest.failedCalls} in the ingest; their time is counted.`]
      : []),
    ...(summary.otherTraces > 0 ? [`${summary.otherTraces} trace(s) of another route were left out.`] : []),
    ...(summary.cost
      ? [
          `Cost at $${summary.cost.chatPrice.input} / $${summary.cost.chatPrice.output} per million chat input / output tokens and $${summary.cost.embeddingPrice.input} per million embedding tokens: $${summary.cost.usdPer1000Answered} per 1,000 answered questions, $${summary.cost.usdPer1000Refused} per 1,000 refused, $${summary.cost.usdPer1000Questions} per 1,000 questions at this run's answer rate; ingest $${summary.cost.ingestUsdPer1000Documents} per 1,000 documents.`,
        ]
      : []),
    "",
  ];
};

/** Events of a JSONL file, skipping lines that are not JSON. */
export const readEvents = async (file) =>
  (await readFile(path.resolve(process.cwd(), file), "utf8"))
    .split("\n")
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });

const parsePrices = (name, value, count) => {
  if (value === null || value === undefined) {
    return null;
  }

  const numbers = String(value).split(",").map(Number);

  if (numbers.length !== count || numbers.some((number) => !Number.isFinite(number) || number < 0)) {
    throw new Error(`${name} takes ${count === 2 ? "<input>,<output>" : "<input>"} in USD per million tokens; got ${JSON.stringify(value)}.`);
  }

  return count === 2 ? { input: numbers[0], output: numbers[1] } : { input: numbers[0] };
};

const main = async () => {
  const eventsPath = getArgValue("--events");

  if (!eventsPath) {
    throw new Error("Usage: qa-latency-breakdown.mjs --events <events.jsonl> [--skip 0] [--chat-price <input>,<output>] [--embedding-price <input>] [--json]");
  }

  const skip = Number(getArgValue("--skip") ?? 0);

  if (!Number.isInteger(skip) || skip < 0) {
    throw new Error(`--skip must be a non-negative integer; got ${JSON.stringify(getArgValue("--skip"))}.`);
  }

  const chatPrice = parsePrices("--chat-price", getArgValue("--chat-price"), 2);
  const embeddingPrice = parsePrices("--embedding-price", getArgValue("--embedding-price"), 1);

  if (Boolean(chatPrice) !== Boolean(embeddingPrice)) {
    throw new Error("Give both --chat-price and --embedding-price, or neither.");
  }

  const grouped = groupQaEvents(await readEvents(eventsPath));

  if (grouped.questions.length === 0) {
    throw new Error(`${eventsPath} holds no qa trace; run with RAG_OBSERVABILITY_ENABLED=true and RAG_OBSERVABILITY_EVENTS_PATH set.`);
  }

  const summary = summarizeQaLatency(grouped, { chatPrice, embeddingPrice, skip });

  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(summary, null, 2)}\n` : formatLatencyMarkdown(summary).join("\n"));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
