import test from "node:test";
import assert from "node:assert/strict";

import {
  createMetricsRegistry,
  escapeLabelValue,
  FORBIDDEN_LABEL_NAMES,
  formatSampleValue,
  getMetricsRegistry,
  isMetricsEnabled,
  MAX_LABEL_VALUE_LENGTH,
  METRICS_CONTENT_TYPE,
  OVERFLOW_LABEL_VALUE,
  pickLabel,
  setMetricsEnabled,
  toIdentifierLabel,
} from "../rag/metrics.js";
import { checkHistogram, parseExposition, sampleValue } from "./metrics-exposition.mjs";

// The registry and the text exposition format (rag/metrics.js): what it
// renders must parse back exactly, histograms must be internally consistent,
// label sets are capped, and labels that could identify a tenant, a document
// or a request's content are refused when a family is declared.

test("the exposition parses back with HELP, TYPE, escaping and every value", async () => {
  const registry = createMetricsRegistry();
  const counter = registry.counter({
    help: 'Counts things; a backslash \\ and a\nnewline in the help, and a "quote".',
    labelNames: ["kind"],
    name: "demo_things_total",
  });
  const gauge = registry.gauge({ help: "A gauge.", labelNames: ["state"], name: "demo_level" });
  const tricky = 'back\\slash "quoted"\nnext line, ünïcode';

  counter.inc({ kind: tricky });
  counter.inc({ kind: tricky }, 2.5);
  counter.inc({ kind: "plain" });
  gauge.set({ state: "up" }, -3);
  gauge.set({ state: "inf" }, Infinity);
  gauge.set({ state: "neg_inf" }, -Infinity);

  const text = await registry.expose();
  const families = parseExposition(text);
  const things = families.get("demo_things_total");

  assert.equal(METRICS_CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
  assert.equal(things.type, "counter");
  assert.equal(things.help, 'Counts things; a backslash \\ and a\nnewline in the help, and a "quote".');
  assert.match(text, /^# HELP demo_things_total Counts things; a backslash \\\\ and a\\nnewline in the help, and a "quote"\.$/mu);
  assert.ok(
    text.includes(`demo_things_total{kind="back\\\\slash \\"quoted\\"\\nnext line, ünïcode"} 3.5`),
    "label values escape backslash, quote and newline"
  );
  assert.equal(sampleValue(families, "demo_things_total", { kind: tricky }), 3.5);
  assert.equal(sampleValue(families, "demo_things_total", { kind: "plain" }), 1);
  assert.equal(families.get("demo_level").type, "gauge");
  assert.equal(sampleValue(families, "demo_level", { state: "up" }), -3);
  assert.equal(sampleValue(families, "demo_level", { state: "inf" }), Infinity);
  assert.equal(sampleValue(families, "demo_level", { state: "neg_inf" }), -Infinity);
  assert.equal(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  assert.equal(formatSampleValue(Number.NaN), "NaN");
  assert.equal(formatSampleValue(Infinity), "+Inf");

  // The two built-in families are always there.
  assert.equal(families.get("archive_rag_metrics_series_overflow_total").type, "counter");
  assert.equal(families.get("archive_rag_metrics_collector_errors_total").type, "counter");
});

test("histograms render cumulative buckets with +Inf equal to _count and the exact _sum", async () => {
  const registry = createMetricsRegistry();
  const histogram = registry.histogram({
    buckets: [0.1, 1, 5],
    help: "Latency.",
    labelNames: ["route"],
    name: "demo_latency_seconds",
  });

  for (const value of [0.05, 0.1, 0.5, 1, 4, 9, 100]) {
    histogram.observe({ route: "/a" }, value);
  }

  histogram.observe({ route: "/b" }, 0.2);
  // Not finite: dropped, never a NaN sum.
  histogram.observe({ route: "/a" }, Number.NaN);
  histogram.observe({ route: "/a" }, Infinity);

  const families = parseExposition(await registry.expose());
  const series = checkHistogram(families.get("demo_latency_seconds"));
  const routeA = [...series.values()].find((entry) => entry.labels.route === "/a");
  const routeB = [...series.values()].find((entry) => entry.labels.route === "/b");

  assert.deepEqual(routeA.buckets, [
    [0.1, 2],
    [1, 4],
    [5, 5],
    [Infinity, 7],
  ]);
  assert.equal(routeA.count, 7);
  assert.equal(routeA.sum, 0.05 + 0.1 + 0.5 + 1 + 4 + 9 + 100);
  assert.deepEqual(routeB.buckets, [
    [0.1, 0],
    [1, 1],
    [5, 1],
    [Infinity, 1],
  ]);
  assert.throws(
    () => registry.histogram({ buckets: [1, 1], help: "", name: "demo_bad_seconds" }),
    /strictly increasing/u
  );
  assert.throws(
    () => registry.histogram({ buckets: [1, Infinity], help: "", name: "demo_bad_seconds" }),
    /finite/u
  );
});

test("a family past its label-set cap folds new label sets into one overflow series", async () => {
  const registry = createMetricsRegistry({ maxSeriesPerMetric: 3 });
  const counter = registry.counter({ help: "Capped.", labelNames: ["model", "status"], name: "demo_capped_total" });
  const histogram = registry.histogram({ buckets: [1], help: "Capped.", labelNames: ["model"], name: "demo_capped_seconds" });

  for (let index = 0; index < 10; index += 1) {
    counter.inc({ model: `m${index}`, status: "ok" });
    histogram.observe({ model: `m${index}` }, 0.5);
  }

  // Label sets seen before the cap keep their own series.
  counter.inc({ model: "m0", status: "ok" });

  const families = parseExposition(await registry.expose());
  const capped = families.get("demo_capped_total").samples;

  assert.equal(capped.length, 4, "three label sets and one overflow series");
  assert.equal(sampleValue(families, "demo_capped_total", { model: "m0" }), 2);
  assert.equal(
    sampleValue(families, "demo_capped_total", { model: OVERFLOW_LABEL_VALUE, status: OVERFLOW_LABEL_VALUE }),
    7
  );
  assert.equal(sampleValue(families, "demo_capped_seconds_count", { model: OVERFLOW_LABEL_VALUE }), 7);
  checkHistogram(families.get("demo_capped_seconds"));
  assert.equal(
    sampleValue(families, "archive_rag_metrics_series_overflow_total", { metric: "demo_capped_total" }),
    7
  );
  assert.equal(
    sampleValue(families, "archive_rag_metrics_series_overflow_total", { metric: "demo_capped_seconds" }),
    7
  );
  assert.equal(registry.maxSeriesPerMetric, 3);
});

test("label names that could carry a tenant, a document, content or a target's identity are refused", () => {
  const registry = createMetricsRegistry();

  for (const labelName of [
    "tenant",
    "user_id",
    "workspace_id",
    "doc_id",
    "question",
    "prompt",
    "url",
    "path",
    "role",
    "instance",
    "job",
  ]) {
    assert.ok(FORBIDDEN_LABEL_NAMES.has(labelName));
    assert.throws(
      () => registry.counter({ help: "", labelNames: [labelName], name: `demo_${labelName}_total` }),
      /could carry/u,
      labelName
    );
  }

  assert.throws(() => registry.counter({ help: "", labelNames: ["UserId"], name: "demo_case_total" }), /could carry/u);
  assert.throws(() => registry.counter({ help: "", labelNames: ["le"], name: "demo_le_total" }), /reserved/u);
  assert.throws(() => registry.counter({ help: "", labelNames: ["__x"], name: "demo_dunder_total" }), /invalid label/u);
  assert.throws(() => registry.counter({ help: "", labelNames: ["a-b"], name: "demo_dash_total" }), /invalid label/u);
  assert.throws(() => registry.counter({ help: "", labelNames: ["a", "a"], name: "demo_twice_total" }), /twice/u);
  assert.throws(() => registry.counter({ help: "", name: "demo-bad" }), /Invalid metric name/u);
  assert.throws(() => registry.counter({ help: "", name: "demo_count" }), /_total/u);

  const first = registry.gauge({ help: "x", labelNames: ["a"], name: "demo_same" });

  assert.equal(registry.gauge({ help: "x", labelNames: ["a"], name: "demo_same" }), first);
  assert.throws(() => registry.gauge({ help: "x", labelNames: ["b"], name: "demo_same" }), /already registered/u);
  assert.throws(() => registry.counter({ help: "x", name: "demo_same_total" }) && registry.gauge({ help: "x", name: "demo_same_total" }), /already registered/u);
});

test("recording never throws: missing, extra and long label values, bad numbers", async () => {
  const registry = createMetricsRegistry();
  const counter = registry.counter({ help: "", labelNames: ["a", "b"], name: "demo_lenient_total" });
  const gauge = registry.gauge({ help: "", name: "demo_lenient_gauge" });

  counter.inc({ a: "x" });
  counter.inc({ a: "x", b: null, c: "ignored" }, 2);
  counter.inc({ a: "y".repeat(500), b: 7 });
  counter.inc({ a: "x" }, -1);
  counter.inc({ a: "x" }, Number.NaN);
  counter.inc(undefined);
  gauge.set(Number.NaN);
  gauge.inc(5);
  gauge.dec(2);

  const families = parseExposition(await registry.expose());

  assert.equal(sampleValue(families, "demo_lenient_total", { a: "x", b: "" }), 3);
  assert.equal(sampleValue(families, "demo_lenient_total", { a: "y".repeat(MAX_LABEL_VALUE_LENGTH), b: "7" }), 1);
  assert.equal(sampleValue(families, "demo_lenient_total", { a: "", b: "" }), 1);
  assert.equal(sampleValue(families, "demo_lenient_gauge"), 3);
});

test("a family without labels exposes 0 before its first event", async () => {
  const registry = createMetricsRegistry();

  registry.counter({ help: "", name: "demo_quiet_total" });
  registry.histogram({ buckets: [1], help: "", name: "demo_quiet_seconds" });

  const families = parseExposition(await registry.expose());

  assert.deepEqual(families.get("demo_quiet_total").samples, [{ labels: {}, name: "demo_quiet_total", value: 0 }]);
  assert.equal(sampleValue(families, "demo_quiet_seconds_count"), 0);
  checkHistogram(families.get("demo_quiet_seconds"));

  registry.resetValues();
  assert.equal(sampleValue(parseExposition(registry.render()), "demo_quiet_total"), 0);
});

test("a failing or hanging collector keeps its previous values and is counted, never failing the scrape", async () => {
  const registry = createMetricsRegistry({ collectorTimeoutMs: 30 });
  const gauge = registry.gauge({ help: "", name: "demo_collected" });
  let mode = "ok";

  registry.addCollector("demo", async () => {
    if (mode === "throw") {
      throw new Error("database down");
    }

    if (mode === "hang") {
      await new Promise(() => {});
    }

    gauge.set(42);
  });

  assert.equal(sampleValue(parseExposition(await registry.expose()), "demo_collected"), 42);

  mode = "throw";
  let families = parseExposition(await registry.expose());

  assert.equal(sampleValue(families, "demo_collected"), 42);
  assert.equal(sampleValue(families, "archive_rag_metrics_collector_errors_total", { collector: "demo" }), 1);

  mode = "hang";
  families = parseExposition(await registry.expose());
  assert.equal(sampleValue(families, "archive_rag_metrics_collector_errors_total", { collector: "demo" }), 2);

  assert.throws(() => registry.addCollector("bad", "not a function"), /must be a function/u);
  assert.equal(registry.removeCollector("demo"), true);
});

test("recording is off unless METRICS_ENABLED=true or forced, and the default registry is one per process", () => {
  setMetricsEnabled(false);
  assert.equal(isMetricsEnabled(), false);
  setMetricsEnabled(true);
  assert.equal(isMetricsEnabled(), true);
  setMetricsEnabled(null);
  assert.equal(isMetricsEnabled(), String(process.env.METRICS_ENABLED ?? "").trim().toLowerCase() === "true");
  assert.equal(getMetricsRegistry(), getMetricsRegistry());

  assert.equal(pickLabel("b", new Set(["a", "b"])), "b");
  assert.equal(pickLabel("c", new Set(["a"])), "other");
  assert.equal(toIdentifierLabel("capability_approval_required"), "capability_approval_required");
  assert.equal(toIdentifierLabel("What is in doc 7?"), "other");
  assert.equal(toIdentifierLabel(`a${"b".repeat(80)}`), "other");
});

test("the default registry's catalogue renders as a valid exposition", async () => {
  await import("../rag/metrics-server.js");

  const families = parseExposition(await getMetricsRegistry().expose());
  const names = [...families.keys()];

  for (const name of names) {
    assert.ok(name.startsWith("archive_rag_") || name.startsWith("process_") || name.startsWith("nodejs_"), name);
    assert.ok(families.get(name).help, `${name} has help text`);
  }

  for (const family of families.values()) {
    if (family.type === "histogram") {
      checkHistogram(family);
    }
  }

  // No family declares a label that names a tenant, a document or a target.
  for (const description of getMetricsRegistry().describe()) {
    for (const labelName of description.labelNames) {
      assert.equal(FORBIDDEN_LABEL_NAMES.has(labelName.toLowerCase()), false, `${description.name}{${labelName}}`);
    }
  }
});
