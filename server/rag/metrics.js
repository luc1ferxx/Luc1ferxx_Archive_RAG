// Prometheus metrics without a client library: a registry of counters, gauges
// and fixed-bucket histograms, rendered in the text exposition format 0.0.4.
//
// Off by default. With METRICS_ENABLED=true every process serves GET /metrics
// on a listener of its own (rag/metrics-server.js), never on the public app
// port. Until then every recording hook returns at its first line
// (isMetricsEnabled), so a process without metrics pays one boolean check per
// hook.
//
// Labels are low cardinality by construction:
//   - a family declares its label names once, and names that would identify a
//     tenant, a person, a document, a request's content or a URL are refused
//     at registration (FORBIDDEN_LABEL_NAMES), as are `role`, `instance` and
//     `job`, which come from the scrape target's labels, never from a series;
//   - every family has a hard cap on its label sets. Past the cap a new label
//     set is counted in one overflow series whose every label is `_overflow`,
//     and archive_rag_metrics_series_overflow_total{metric} counts the
//     redirected observations, so an unbounded value degrades a family instead
//     of the process's memory.
// Recording never throws: missing labels record as "", extra keys are
// ignored, values are clamped to 128 characters, and a non-finite or negative
// counter increment is dropped.
//
// Collectors (addCollector) fill values that are read rather than recorded --
// pool sizes, queue depths, guard state -- right before each exposition. Each
// runs under a timeout; one that fails or hangs keeps its previous values and
// counts in archive_rag_metrics_collector_errors_total{collector}.

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const DEFAULT_MAX_SERIES_PER_METRIC = 1000;
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 2000;
export const OVERFLOW_LABEL_VALUE = "_overflow";
export const MAX_LABEL_VALUE_LENGTH = 128;

export const METRIC_TYPES = Object.freeze({
  counter: "counter",
  gauge: "gauge",
  histogram: "histogram",
});

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const SERIES_KEY_SEPARATOR = "\u0001";

// `le` belongs to histogram buckets and `quantile` to summaries.
const RESERVED_LABEL_NAMES = new Set(["le", "quantile"]);

// A series label may never identify who asked, what they asked about, or
// where a request went. `role`, `instance` and `job` are the scrape target's.
export const FORBIDDEN_LABEL_NAMES = Object.freeze(
  new Set([
    "doc",
    "doc_id",
    "docid",
    "document",
    "document_id",
    "email",
    "host",
    "instance",
    "ip",
    "job",
    "job_id",
    "path",
    "prompt",
    "query",
    "question",
    "raw_path",
    "role",
    "run_id",
    "session",
    "session_id",
    "tenant",
    "tenant_id",
    "token",
    "url",
    "user",
    "user_id",
    "userid",
    "workspace",
    "workspace_id",
  ])
);

const parseEnabled = (value) => String(value ?? "").trim().toLowerCase() === "true";

let enabledOverride = null;
let enabledFromEnvironment = null;

/**
 * Whether recording hooks do anything. Read once from METRICS_ENABLED; tests
 * and the metrics server override it with setMetricsEnabled.
 */
export const isMetricsEnabled = () => {
  if (enabledOverride !== null) {
    return enabledOverride;
  }

  enabledFromEnvironment ??= parseEnabled(process.env.METRICS_ENABLED);
  return enabledFromEnvironment;
};

/** true/false forces recording on or off; null goes back to METRICS_ENABLED. */
export const setMetricsEnabled = (value) => {
  enabledOverride = value === null || value === undefined ? null : Boolean(value);
};

const clampLabelValue = (value) => {
  const text = value === null || value === undefined ? "" : String(value);

  return text.length > MAX_LABEL_VALUE_LENGTH ? text.slice(0, MAX_LABEL_VALUE_LENGTH) : text;
};

// Text exposition 0.0.4: HELP escapes backslash and newline; a label value
// also escapes the double quote.
export const escapeHelpText = (text) =>
  String(text).replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n");

export const escapeLabelValue = (value) =>
  String(value).replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');

export const formatSampleValue = (value) => {
  if (Number.isNaN(value)) {
    return "NaN";
  }

  if (value === Infinity) {
    return "+Inf";
  }

  if (value === -Infinity) {
    return "-Inf";
  }

  return String(value);
};

const formatLabels = (pairs) =>
  pairs.length === 0
    ? ""
    : `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(",")}}`;

const assertMetricName = (name) => {
  if (typeof name !== "string" || !METRIC_NAME_PATTERN.test(name)) {
    throw new TypeError(`Invalid metric name "${name}".`);
  }
};

const assertLabelNames = (name, labelNames) => {
  if (!Array.isArray(labelNames)) {
    throw new TypeError(`Metric ${name}: labelNames must be an array.`);
  }

  const seen = new Set();

  for (const labelName of labelNames) {
    if (typeof labelName !== "string" || !LABEL_NAME_PATTERN.test(labelName) || labelName.startsWith("__")) {
      throw new TypeError(`Metric ${name}: invalid label name "${labelName}".`);
    }

    if (RESERVED_LABEL_NAMES.has(labelName)) {
      throw new TypeError(`Metric ${name}: label name "${labelName}" is reserved.`);
    }

    if (FORBIDDEN_LABEL_NAMES.has(labelName.toLowerCase())) {
      throw new TypeError(
        `Metric ${name}: label "${labelName}" could carry a tenant, a document, a request's content or a target's identity; use a bounded label instead.`
      );
    }

    if (seen.has(labelName)) {
      throw new TypeError(`Metric ${name}: label "${labelName}" is declared twice.`);
    }

    seen.add(labelName);
  }
};

const normalizeBuckets = (name, buckets) => {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new TypeError(`Histogram ${name} needs at least one bucket.`);
  }

  const sorted = [...buckets].map(Number);

  for (let index = 0; index < sorted.length; index += 1) {
    if (!Number.isFinite(sorted[index])) {
      throw new TypeError(`Histogram ${name}: buckets must be finite (+Inf is implicit).`);
    }

    if (index > 0 && sorted[index] <= sorted[index - 1]) {
      throw new TypeError(`Histogram ${name}: buckets must be strictly increasing.`);
    }
  }

  return Object.freeze(sorted);
};

const sameLabelNames = (left, right) =>
  left.length === right.length && left.every((name, index) => name === right[index]);

const sameBuckets = (left = [], right = []) =>
  left.length === right.length && left.every((bound, index) => bound === right[index]);

/**
 * A registry. `maxSeriesPerMetric` caps every family's label sets.
 *
 *   counter/gauge/histogram({ name, help, labelNames, buckets })
 *       register a family, or return the one already registered under that
 *       name with the same type, labels and buckets (a mismatch throws).
 *   addCollector(name, collect, { timeoutMs })   read-on-scrape values.
 *   collect()   runs the collectors; render() the text; expose() both.
 *   describe()  [{ name, type, help, labelNames, sampleNames }].
 *   resetValues()  drops every series (tests).
 */
export const createMetricsRegistry = ({
  collectorTimeoutMs = DEFAULT_COLLECTOR_TIMEOUT_MS,
  maxSeriesPerMetric = DEFAULT_MAX_SERIES_PER_METRIC,
} = {}) => {
  const cap = Number.isInteger(maxSeriesPerMetric) && maxSeriesPerMetric > 0
    ? maxSeriesPerMetric
    : DEFAULT_MAX_SERIES_PER_METRIC;
  const families = new Map();
  const collectors = new Map();
  let overflowCounter = null;
  let collectorErrors = null;

  const noteOverflow = (familyName) => {
    if (overflowCounter && familyName !== overflowCounter.name) {
      overflowCounter.inc({ metric: familyName });
    }
  };

  const createFamily = ({ buckets, help, labelNames, name, type }) => {
    const series = new Map();
    const overflowKey = labelNames.map(() => OVERFLOW_LABEL_VALUE).join(SERIES_KEY_SEPARATOR);
    const createSeries = (labelValues) =>
      type === METRIC_TYPES.histogram
        ? { bucketCounts: new Array(buckets.length).fill(0), count: 0, labelValues, sum: 0 }
        : { labelValues, value: 0 };

    // The series for a label object, created on first use; past the cap the
    // overflow series. Labels are read in declaration order.
    const resolve = (labels) => {
      if (labelNames.length === 0) {
        let only = series.get("");

        if (!only) {
          only = createSeries([]);
          series.set("", only);
        }

        return only;
      }

      const labelValues = labelNames.map((labelName) => clampLabelValue(labels?.[labelName]));
      const key = labelValues.join(SERIES_KEY_SEPARATOR);
      const existing = series.get(key);

      if (existing) {
        return existing;
      }

      if (series.size >= cap && key !== overflowKey) {
        noteOverflow(name);

        let overflow = series.get(overflowKey);

        if (!overflow) {
          overflow = createSeries(labelNames.map(() => OVERFLOW_LABEL_VALUE));
          series.set(overflowKey, overflow);
        }

        return overflow;
      }

      const created = createSeries(labelValues);
      series.set(key, created);
      return created;
    };

    // `inc()`, `inc(2)`, `inc({ a: "x" })` and `inc({ a: "x" }, 2)` all work.
    const splitArguments = (labels, value, fallback) =>
      typeof labels === "number" ? [undefined, labels] : [labels, value ?? fallback];

    const family = {
      buckets,
      help,
      labelNames,
      name,
      series,
      type,
      /**
       * Drops every series (a collector that rebuilds its family). A family
       * without labels keeps its one series, at 0.
       */
      clear() {
        series.clear();

        if (labelNames.length === 0) {
          resolve();
        }
      },
    };

    if (type === METRIC_TYPES.counter) {
      family.inc = (labels, value) => {
        const [labelObject, amount] = splitArguments(labels, value, 1);

        if (!Number.isFinite(amount) || amount < 0) {
          return;
        }

        resolve(labelObject).value += amount;
      };
      // For collectors that read a running total kept elsewhere: the value is
      // the total itself, so it must only ever grow (a reset reads as a
      // counter reset, which rate() handles).
      family.setTotal = (labels, value) => {
        const [labelObject, total] = splitArguments(labels, value, 0);

        if (Number.isFinite(total) && total >= 0) {
          resolve(labelObject).value = total;
        }
      };
    } else if (type === METRIC_TYPES.gauge) {
      family.set = (labels, value) => {
        const [labelObject, next] = splitArguments(labels, value, 0);

        if (typeof next === "number" && !Number.isNaN(next)) {
          resolve(labelObject).value = next;
        }
      };
      family.inc = (labels, value) => {
        const [labelObject, amount] = splitArguments(labels, value, 1);

        if (Number.isFinite(amount)) {
          resolve(labelObject).value += amount;
        }
      };
      family.dec = (labels, value) => {
        const [labelObject, amount] = splitArguments(labels, value, 1);

        if (Number.isFinite(amount)) {
          resolve(labelObject).value -= amount;
        }
      };
    } else {
      family.observe = (labels, value) => {
        const [labelObject, observed] = splitArguments(labels, value, Number.NaN);

        if (!Number.isFinite(observed)) {
          return;
        }

        const entry = resolve(labelObject);

        // Non-cumulative here; render() accumulates.
        for (let index = 0; index < buckets.length; index += 1) {
          if (observed <= buckets[index]) {
            entry.bucketCounts[index] += 1;
            break;
          }
        }

        entry.count += 1;
        entry.sum += observed;
      };
    }

    // A family without labels exposes its 0 from the start, so rate() and
    // alerts have a series before the first event.
    if (labelNames.length === 0) {
      resolve();
    }

    return family;
  };

  const register = (type, { buckets, help, labelNames = [], name }) => {
    assertMetricName(name);
    assertLabelNames(name, labelNames);

    if (type === METRIC_TYPES.counter && !name.endsWith("_total")) {
      throw new TypeError(`Counter ${name} must end in _total.`);
    }

    const normalizedBuckets = type === METRIC_TYPES.histogram ? normalizeBuckets(name, buckets) : null;
    const existing = families.get(name);

    if (existing) {
      if (
        existing.type !== type ||
        !sameLabelNames(existing.labelNames, labelNames) ||
        (type === METRIC_TYPES.histogram && !sameBuckets(existing.buckets, normalizedBuckets))
      ) {
        throw new TypeError(`Metric ${name} is already registered with another type, labels or buckets.`);
      }

      return existing;
    }

    const family = createFamily({
      buckets: normalizedBuckets,
      help: String(help ?? ""),
      labelNames: Object.freeze([...labelNames]),
      name,
      type,
    });

    families.set(name, family);
    return family;
  };

  const counter = (definition) => register(METRIC_TYPES.counter, definition);
  const gauge = (definition) => register(METRIC_TYPES.gauge, definition);
  const histogram = (definition) => register(METRIC_TYPES.histogram, definition);

  overflowCounter = counter({
    help: "Observations recorded in a family's overflow series because it reached its label-set cap.",
    labelNames: ["metric"],
    name: "archive_rag_metrics_series_overflow_total",
  });
  collectorErrors = counter({
    help: "Scrape-time collectors that failed or timed out; their families kept their previous values.",
    labelNames: ["collector"],
    name: "archive_rag_metrics_collector_errors_total",
  });

  const addCollector = (name, collect, { timeoutMs = collectorTimeoutMs } = {}) => {
    if (typeof collect !== "function") {
      throw new TypeError(`Collector ${name} must be a function.`);
    }

    collectors.set(String(name), { collect, timeoutMs });
  };

  const removeCollector = (name) => collectors.delete(String(name));

  const runCollector = async (name, { collect, timeoutMs }) => {
    let timer = null;

    try {
      await Promise.race([
        Promise.resolve().then(() => collect()),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("collector timed out")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      collectorErrors.inc({ collector: name });
    } finally {
      clearTimeout(timer);
    }
  };

  const collect = async () => {
    await Promise.all([...collectors.entries()].map(([name, entry]) => runCollector(name, entry)));
  };

  const renderFamily = (family) => {
    const lines = [
      `# HELP ${family.name} ${escapeHelpText(family.help)}`,
      `# TYPE ${family.name} ${family.type}`,
    ];

    for (const entry of family.series.values()) {
      const pairs = family.labelNames.map((labelName, index) => [labelName, entry.labelValues[index]]);

      if (family.type !== METRIC_TYPES.histogram) {
        lines.push(`${family.name}${formatLabels(pairs)} ${formatSampleValue(entry.value)}`);
        continue;
      }

      let cumulative = 0;

      for (let index = 0; index < family.buckets.length; index += 1) {
        cumulative += entry.bucketCounts[index];
        lines.push(
          `${family.name}_bucket${formatLabels([...pairs, ["le", formatSampleValue(family.buckets[index])]])} ${cumulative}`
        );
      }

      lines.push(`${family.name}_bucket${formatLabels([...pairs, ["le", "+Inf"]])} ${entry.count}`);
      lines.push(`${family.name}_sum${formatLabels(pairs)} ${formatSampleValue(entry.sum)}`);
      lines.push(`${family.name}_count${formatLabels(pairs)} ${entry.count}`);
    }

    return lines.join("\n");
  };

  const render = () =>
    `${[...families.values()].map(renderFamily).join("\n")}\n`;

  const expose = async () => {
    await collect();
    return render();
  };

  const describe = () =>
    [...families.values()].map((family) => ({
      help: family.help,
      labelNames: [...family.labelNames],
      name: family.name,
      sampleNames:
        family.type === METRIC_TYPES.histogram
          ? [`${family.name}_bucket`, `${family.name}_sum`, `${family.name}_count`]
          : [family.name],
      type: family.type,
    }));

  const resetValues = () => {
    for (const family of families.values()) {
      family.clear();
    }
  };

  return {
    addCollector,
    collect,
    counter,
    describe,
    expose,
    gauge,
    getFamily: (name) => families.get(name) ?? null,
    histogram,
    maxSeriesPerMetric: cap,
    removeCollector,
    render,
    resetValues,
  };
};

let defaultRegistry = null;

/** The process-wide registry every instrumentation module records into. */
export const getMetricsRegistry = () => {
  defaultRegistry ??= createMetricsRegistry();
  return defaultRegistry;
};

/** Seconds since `startedAt`, a performance.now() reading. */
export const secondsSince = (startedAt) => Math.max(0, (performance.now() - startedAt) / 1000);

/**
 * A label value from a fixed vocabulary: `value` when it is one of `allowed`
 * (a Set), otherwise `fallback`.
 */
export const pickLabel = (value, allowed, fallback = "other") => {
  const text = String(value ?? "");

  return allowed.has(text) ? text : fallback;
};

const SNAKE_CASE_LABEL = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * A code-defined identifier (a step type, a reason) as a label: kept when it
 * is snake_case and at most 64 characters, `other` otherwise. The family's
 * series cap bounds what is left.
 */
export const toIdentifierLabel = (value, fallback = "other") => {
  const text = String(value ?? "").trim().toLowerCase();

  return SNAKE_CASE_LABEL.test(text) ? text : fallback;
};
