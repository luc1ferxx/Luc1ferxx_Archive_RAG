import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatSampleValue, getMetricsRegistry } from "../rag/metrics.js";
import { collectModelCallGuards } from "../rag/metrics-model.js";
import { guardModelCall, resetModelCallGuards } from "../rag/model-call-guard.js";
import { parseExposition, sampleValue } from "./metrics-exposition.mjs";
import { HTTP_DURATION_BUCKETS } from "../rag/metrics-http.js";
import "../rag/metrics-server.js";

// The Prometheus rules in deploy/prometheus/ must stay true to the code: every
// metric an expression reads is one this server exposes (or a rule records),
// every label it matches on is one that family declares, every `le` bound is a
// real bucket, every alert carries summary, description, runbook and
// severity, and every `npm run` a runbook names exists. There is no YAML
// dependency (see deployment-contract.test.mjs), so the files keep to a
// small subset that parseYamlSubset below reads: block mappings, block
// sequences, literal `|` blocks, plain and double-quoted scalars, comments.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(__dirname, "..", "..");
const rulesDirectory = path.join(repositoryRoot, "deploy", "prometheus");
const packageJsonPath = path.join(repositoryRoot, "server", "package.json");

const indentOf = (line) => line.length - line.trimStart().length;
const isIgnorable = (line) => line.trim() === "" || line.trimStart().startsWith("#");

const parseScalar = (raw) => {
  const text = raw.trim();

  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw new Error(`unterminated string: ${text}`);
    }

    return JSON.parse(text);
  }

  if (text.startsWith("'") || text.startsWith("{") || text.startsWith("[") || text.startsWith("&") || text.startsWith("*")) {
    throw new Error(`outside the YAML subset: ${text}`);
  }

  if (/^-?\d+(\.\d+)?$/u.test(text)) {
    return Number(text);
  }

  return text.replace(/\s+#.*$/u, "");
};

const splitKey = (text, lineNumber) => {
  const match = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/u.exec(text);

  if (!match) {
    throw new Error(`line ${lineNumber}: expected "key:" in ${JSON.stringify(text)}`);
  }

  return [match[1], match[2] ?? ""];
};

/** Parses the YAML subset described above into plain objects and arrays. */
export const parseYamlSubset = (source) => {
  const lines = source.split("\n");
  let index = 0;

  const skip = () => {
    while (index < lines.length && isIgnorable(lines[index])) {
      index += 1;
    }
  };

  const readBlockScalar = (parentIndent) => {
    const block = [];
    let blockIndent = null;

    while (index < lines.length) {
      const line = lines[index];

      if (line.trim() === "") {
        block.push("");
        index += 1;
        continue;
      }

      const indent = indentOf(line);

      if (indent <= parentIndent) {
        break;
      }

      blockIndent ??= indent;

      if (indent < blockIndent) {
        throw new Error(`line ${index + 1}: block scalar dedents`);
      }

      block.push(line.slice(blockIndent));
      index += 1;
    }

    while (block.length > 0 && block.at(-1) === "") {
      block.pop();
    }

    return `${block.join("\n")}\n`;
  };

  // The value after "key:" on a line at `indent`: inline scalar, `|` block,
  // or a nested block on the following lines.
  const readValue = (rest, indent) => {
    if (rest === "|") {
      return readBlockScalar(indent);
    }

    if (rest !== "") {
      return parseScalar(rest);
    }

    skip();

    if (index >= lines.length || indentOf(lines[index]) <= indent) {
      return null;
    }

    return readNode(indentOf(lines[index]));
  };

  const readMapping = (indent, initial = {}) => {
    const mapping = initial;

    for (;;) {
      skip();

      if (index >= lines.length) {
        return mapping;
      }

      const line = lines[index];
      const lineIndent = indentOf(line);

      if (lineIndent < indent) {
        return mapping;
      }

      if (lineIndent > indent) {
        throw new Error(`line ${index + 1}: unexpected indentation`);
      }

      if (line.trimStart().startsWith("- ")) {
        return mapping;
      }

      const [key, rest] = splitKey(line.trim(), index + 1);

      if (Object.hasOwn(mapping, key)) {
        throw new Error(`line ${index + 1}: duplicate key ${key}`);
      }

      index += 1;
      mapping[key] = readValue(rest, lineIndent);
    }
  };

  const readSequence = (indent) => {
    const items = [];

    for (;;) {
      skip();

      if (index >= lines.length) {
        return items;
      }

      const line = lines[index];

      if (indentOf(line) !== indent || !line.trimStart().startsWith("- ")) {
        return items;
      }

      const content = line.trimStart().slice(2);
      const itemIndent = indent + 2;

      if (/^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/u.test(content)) {
        // "- key: value" opens a mapping whose further keys sit at itemIndent.
        const [key, rest] = splitKey(content, index + 1);

        index += 1;
        items.push(readMapping(itemIndent, { [key]: readValue(rest, itemIndent) }));
      } else {
        index += 1;
        items.push(parseScalar(content));
      }
    }
  };

  const readNode = (indent) =>
    lines[index].trimStart().startsWith("- ") ? readSequence(indent) : readMapping(indent);

  skip();

  const document = readNode(0);

  skip();

  if (index < lines.length) {
    throw new Error(`line ${index + 1}: not parsed`);
  }

  return document;
};

const PROMQL_WORDS = new Set([
  "and",
  "avg",
  "bool",
  "by",
  "count",
  "group_left",
  "group_right",
  "histogram_quantile",
  "ignoring",
  "increase",
  "max",
  "min",
  "offset",
  "on",
  "or",
  "rate",
  "sum",
  "unless",
  "vector",
  "without",
]);

/** Metric names and their label matchers in a PromQL expression. */
const readSelectors = (expr) => {
  const selectors = [];
  // Drop the label lists of by/on/without/ignoring/group_* clauses and the
  // range durations first.
  const stripped = expr
    .replace(/\b(by|on|without|ignoring|group_left|group_right)\s*\([^)]*\)/gu, " ")
    .replace(/\[[^\]]*\]/gu, " ");
  const pattern = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(\{[^}]*\})?/gu;

  for (const match of stripped.matchAll(pattern)) {
    const [, name, braces] = match;
    const preceding = stripped[match.index - 1];

    if (PROMQL_WORDS.has(name) || /^\d/u.test(name) || preceding === "." || /[0-9.]/u.test(preceding ?? "")) {
      continue;
    }

    const matchers = [];

    for (const matcher of (braces ?? "").slice(1, -1).matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)"/gu)) {
      matchers.push({ label: matcher[1], operator: matcher[2], value: matcher[3] });
    }

    selectors.push({ matchers, name });
  }

  return selectors;
};

const TARGET_LABELS = new Set(["instance", "job", "role"]);

// Whether a PromQL label matcher (as readSelectors returns it, string escapes
// still in) selects `labelValue`. Regex matchers are fully anchored.
const matcherSelects = ({ operator, value }, labelValue) => {
  const text = JSON.parse(`"${value}"`);

  if (operator === "=" || operator === "!=") {
    return (labelValue === text) === (operator === "=");
  }

  return new RegExp(`^(?:${text})$`, "u").test(labelValue) === (operator === "=~");
};

// A classic histogram's `le` as stored: Prometheus 2 kept the text format's
// spelling ("20", what rag/metrics.js writes); Prometheus 3 normalizes it to
// its float form on ingestion ("20.0", Go's formatOpenMetricsFloat), so an
// `le="20"` matcher selects nothing there.
const leSpellings = (bound) => {
  const exposed = formatSampleValue(bound);

  return [exposed, /[.e]/u.test(exposed) ? exposed : `${exposed}.0`];
};

const loadRules = async () => {
  const [recording, alerting, scrape] = await Promise.all(
    ["recording-rules.yml", "alert-rules.yml", "prometheus.example.yml"].map(async (name) =>
      parseYamlSubset(await readFile(path.join(rulesDirectory, name), "utf8"))
    )
  );

  return { alerting, recording, scrape };
};

const catalogue = () => {
  const bySample = new Map();

  for (const family of getMetricsRegistry().describe()) {
    for (const sampleName of family.sampleNames) {
      bySample.set(sampleName, family);
    }
  }

  return bySample;
};

test("the YAML subset parser reads mappings, sequences, block scalars and quoted strings", () => {
  const parsed = parseYamlSubset(
    [
      "# comment",
      "groups:",
      "  - name: g",
      "    rules:",
      "      - alert: A",
      "        expr: |",
      "          up == 0",
      "          and on (job) x",
      "        for: 5m",
      "        annotations:",
      '          summary: "quoted: {{ $labels.instance }} \\"x\\""',
      "          plain: text # trailing comment",
      "  - name: h",
      "    interval: 30",
      "list:",
      "  - one",
      "  - two",
      "",
    ].join("\n")
  );

  assert.deepEqual(parsed, {
    groups: [
      {
        name: "g",
        rules: [
          {
            alert: "A",
            annotations: { plain: "text", summary: 'quoted: {{ $labels.instance }} "x"' },
            expr: "up == 0\nand on (job) x\n",
            for: "5m",
          },
        ],
      },
      { interval: 30, name: "h" },
    ],
    list: ["one", "two"],
  });
  assert.throws(() => parseYamlSubset("a: 'single'\n"), /subset/u);
  assert.throws(() => parseYamlSubset("a: 1\na: 2\n"), /duplicate/u);
});

test("the selector reader finds metric names and matchers, not functions, clauses or numbers", () => {
  const selectors = readSelectors(
    'max by (job, role, instance, replica) (archive_rag_postgres_replica_lag_seconds{job="archive-rag"})\n' +
      "  > on (job, role, instance) group_left() (archive_rag_postgres_replica_max_lag_seconds > 0)\n" +
      'and sum(rate(archive_rag_http_request_duration_seconds_bucket{route="/chat",le="20",status_class!~"429|aborted"}[5m])) > (14.4 * 0.005)\n' +
      "or (1 - archive_rag:chat_latency_sli:ratio_rate1h) > 6e-2 unless up == 0"
  );

  assert.deepEqual(
    selectors.map((selector) => selector.name),
    [
      "archive_rag_postgres_replica_lag_seconds",
      "archive_rag_postgres_replica_max_lag_seconds",
      "archive_rag_http_request_duration_seconds_bucket",
      "archive_rag:chat_latency_sli:ratio_rate1h",
      "up",
    ]
  );
  assert.deepEqual(selectors[2].matchers, [
    { label: "route", operator: "=", value: "/chat" },
    { label: "le", operator: "=", value: "20" },
    { label: "status_class", operator: "!~", value: "429|aborted" },
  ]);
});

test("every metric a rule reads exists, with the labels it matches on and real histogram bounds", async () => {
  const { alerting, recording } = await loadRules();
  const families = catalogue();
  const recorded = new Set(
    recording.groups.flatMap((group) => group.rules.map((rule) => rule.record)).filter(Boolean)
  );
  const rules = [...recording.groups, ...alerting.groups].flatMap((group) => group.rules);
  const seen = new Set();

  assert.ok(recorded.size >= 8, "availability and latency SLIs over four windows");

  for (const rule of rules) {
    assert.equal(typeof rule.expr, "string", `${rule.record ?? rule.alert} has an expr`);

    for (const { matchers, name } of readSelectors(rule.expr)) {
      seen.add(name);

      if (name === "up" || recorded.has(name)) {
        continue;
      }

      const family = families.get(name);

      assert.ok(family, `${rule.record ?? rule.alert}: ${name} is not exposed by any rag/metrics-*.js module`);

      for (const { label, operator, value } of matchers) {
        if (TARGET_LABELS.has(label)) {
          continue;
        }

        if (label === "le") {
          assert.equal(family.type, "histogram", `${name}{le} on a non-histogram`);
          assert.ok(name.endsWith("_bucket"), `${name}: le only on _bucket`);

          const matcher = { operator, value };
          const selected = getMetricsRegistry()
            .getFamily(family.name)
            .buckets.filter((bound) => leSpellings(bound).some((spelling) => matcherSelects(matcher, spelling)));

          assert.equal(selected.length, 1, `${name}{le${operator}"${value}"} selects exactly one bucket bound`);

          for (const spelling of leSpellings(selected[0])) {
            assert.ok(
              matcherSelects(matcher, spelling),
              `${rule.record ?? rule.alert}: le${operator}"${value}" misses le="${spelling}", the bound ${selected[0]} as ${spelling.includes(".") ? "Prometheus 3 stores it" : "the exposition writes it"}`
            );
          }

          continue;
        }

        assert.ok(family.labelNames.includes(label), `${rule.record ?? rule.alert}: ${name} has no label ${label} (${operator}"${value}")`);
      }
    }
  }

  // The SLIs read the /chat route the edge records, and the alerts read the
  // recorded SLIs over the windows the burn-rate pairs need.
  for (const name of [
    "archive_rag:chat_availability_sli:ratio_rate5m",
    "archive_rag:chat_availability_sli:ratio_rate30m",
    "archive_rag:chat_availability_sli:ratio_rate1h",
    "archive_rag:chat_availability_sli:ratio_rate6h",
    "archive_rag:chat_latency_sli:ratio_rate5m",
    "archive_rag:chat_latency_sli:ratio_rate30m",
    "archive_rag:chat_latency_sli:ratio_rate1h",
    "archive_rag:chat_latency_sli:ratio_rate6h",
    "archive_rag_http_requests_total",
    "archive_rag_http_request_duration_seconds_bucket",
    "archive_rag_http_request_duration_seconds_count",
    "archive_rag_ingest_dead_letter_jobs",
    "archive_rag_model_circuits",
    "archive_rag_postgres_replica_lag_seconds",
    "archive_rag_postgres_replica_max_lag_seconds",
    "archive_rag_model_gateway_quota_rejections_total",
    "up",
  ]) {
    assert.ok(seen.has(name), `${name} is read by a rule`);
  }

  for (const rule of recording.groups.flatMap((group) => group.rules)) {
    assert.match(rule.record, /^archive_rag:[a-z_]+:[a-z0-9_]+$/u, "recording rule names follow level:metric:operation");
    assert.match(rule.expr, /route="\/chat"/u);
    assert.match(rule.expr, /role=~"all\|api"/u, "only the public edge counts");
    // A good-event series exists only once something succeeded: after a deploy
    // whose every /chat fails, sum() over no series is an empty vector, the
    // ratio would be absent and no burn alert could fire. An empty numerator
    // must read as 0 good events.
    assert.match(
      rule.expr.replace(/\s+/gu, " ").trim(),
      /^\(sum\(rate\(\S+\[\w+\]\)\) or vector\(0\)\) \/ /u,
      `${rule.record}: no good events reads as 0, not as no ratio`
    );

    if (!rule.record.includes("latency")) {
      assert.match(rule.expr, /status_class!~"(5xx\|)?429\|aborted"/u, "429 and aborted requests are not valid events");
      continue;
    }

    // The 20 s objective of alert-rules.yml, as either Prometheus stores it.
    const selectors = readSelectors(rule.expr);
    const [le] = selectors.flatMap((selector) => selector.matchers.filter((matcher) => matcher.label === "le"));

    assert.ok(HTTP_DURATION_BUCKETS.includes(20));
    assert.ok(le && leSpellings(20).every((spelling) => matcherSelects(le, spelling)), `${rule.record} selects le 20`);

    // A request abandoned after the 20 s bound (the client gave up, or a
    // proxy's read timeout closed it) is a slow request, not a non-event: a
    // /chat that hangs until every caller leaves must burn the latency budget
    // instead of leaving the SLI with no valid events. Only an abandon within
    // the bound has no verdict and is taken back out.
    const statusOf = (selector) => selector.matchers.find((matcher) => matcher.label === "status_class");
    const total = selectors.find((selector) => selector.name.endsWith("_count"));
    const good = selectors.find((selector) => selector.name.endsWith("_bucket") && matcherSelects(statusOf(selector), "2xx"));
    const abandonedInTime = selectors.find(
      (selector) => selector.name.endsWith("_bucket") && matcherSelects(statusOf(selector), "aborted")
    );

    assert.ok(matcherSelects(statusOf(total), "aborted"), `${rule.record}: abandoned requests are valid events`);
    assert.equal(matcherSelects(statusOf(total), "429"), false, `${rule.record}: 429 is not a valid event`);
    assert.equal(matcherSelects(statusOf(good), "aborted"), false, `${rule.record}: an abandoned request is never good`);
    assert.equal(matcherSelects(statusOf(good), "429"), false);
    assert.ok(
      abandonedInTime && !matcherSelects(statusOf(abandonedInTime), "2xx"),
      `${rule.record}: abandons within the bound are taken out of the denominator`
    );
    assert.match(
      rule.expr.replace(/\s+/gu, " "),
      /- \(sum\(rate\(archive_rag_http_request_duration_seconds_bucket\{[^}]*status_class="aborted"[^}]*\}\[\w+\]\)\) or vector\(0\)\)/u,
      `${rule.record}: a window without abandons subtracts 0, not an empty vector`
    );
  }
});

test("the circuit alert holds while a half-open probe hangs and stays quiet for a circuit nobody calls", async () => {
  // What the guard reports through an outage of a model that hangs: open for
  // RAG_LLM_CIRCUIT_COOLDOWN_MS (30 s by default), then half_open while the
  // one probe waits out RAG_LLM_REQUEST_TIMEOUT_MS (120 s by default), then
  // open again. An alert on state="open" alone is reset by every probe and
  // never reaches its `for`.
  const settings = { RAG_LLM_CIRCUIT_COOLDOWN_MS: "1", RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1", RAG_SHARED_STATE: "memory" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const key = "http://upstream.internal:8000/v1|hanging-model";
  const reported = [];
  let releaseProbe;

  Object.assign(process.env, settings);
  resetModelCallGuards();

  try {
    const readStates = () => {
      collectModelCallGuards();

      const families = parseExposition(getMetricsRegistry().render());

      return ["closed", "half_open", "open"].filter(
        (state) => sampleValue(families, "archive_rag_model_circuits", { model: "hanging-model", state }) > 0
      );
    };

    await assert.rejects(guardModelCall(key, () => Promise.reject(Object.assign(new Error("HTTP 503"), { status: 503 }))));
    reported.push(...readStates());
    await new Promise((resolve) => setTimeout(resolve, 5));

    const probe = guardModelCall(key, () => new Promise((resolve) => (releaseProbe = resolve)));

    while (!releaseProbe) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    reported.push(...readStates());
    assert.deepEqual(reported, ["open", "half_open"], "open, then half_open while the probe hangs");
    releaseProbe("late");
    await probe;
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    resetModelCallGuards();
  }

  const { alerting } = await loadRules();
  const rule = alerting.groups.flatMap((group) => group.rules).find((entry) => entry.alert === "ArchiveRagModelCircuitOpen");
  const selectors = readSelectors(rule.expr);
  const circuit = selectors.find((selector) => selector.name === "archive_rag_model_circuits");
  const stateMatcher = circuit?.matchers.find((matcher) => matcher.label === "state");

  assert.ok(stateMatcher, "the alert selects circuit states");

  for (const state of reported) {
    assert.ok(matcherSelects(stateMatcher, state), `the alert keeps firing through a ${state} sample`);
  }

  assert.equal(matcherSelects(stateMatcher, "closed"), false);

  // A guard keeps its last state until its next call, so a circuit nobody
  // calls any more (the fallback model after the incident) would report open
  // for as long as the process runs. The alert needs failing model calls on
  // the same process.
  const errors = selectors.find(
    (selector) =>
      selector.name === "archive_rag_model_calls_total" &&
      selector.matchers.some((matcher) => matcher.label === "status" && matcherSelects(matcher, "error"))
  );

  assert.ok(errors, "the alert is gated on failing model calls");
  assert.match(rule.expr.replace(/\s+/gu, " "), /\) > 0 and on \(job, role, instance\) sum by \(job, role, instance\) \(rate\(archive_rag_model_calls_total\{[^}]*\}\[5m\]\)\) > 0/u);
});

test("burn-rate alerts pair a long and a short window at 14.4x and 6x of each objective", async () => {
  const { alerting } = await loadRules();
  const alerts = new Map(alerting.groups.flatMap((group) => group.rules).map((rule) => [rule.alert, rule]));
  const expectBurn = (name, { budget, factor, longWindow, shortWindow, sli }) => {
    const rule = alerts.get(name);

    assert.ok(rule, name);

    const compact = rule.expr.replace(/\s+/gu, " ");

    assert.ok(compact.includes(`(1 - archive_rag:${sli}:ratio_rate${longWindow}) > (${factor} * ${budget})`), `${name} long window`);
    assert.ok(compact.includes(`(1 - archive_rag:${sli}:ratio_rate${shortWindow}) > (${factor} * ${budget})`), `${name} short window`);
    assert.match(compact, / and /u);
  };

  expectBurn("ArchiveRagChatAvailabilityFastBurn", { budget: 0.005, factor: 14.4, longWindow: "1h", shortWindow: "5m", sli: "chat_availability_sli" });
  expectBurn("ArchiveRagChatAvailabilitySlowBurn", { budget: 0.005, factor: 6, longWindow: "6h", shortWindow: "30m", sli: "chat_availability_sli" });
  expectBurn("ArchiveRagChatLatencyFastBurn", { budget: 0.05, factor: 14.4, longWindow: "1h", shortWindow: "5m", sli: "chat_latency_sli" });
  expectBurn("ArchiveRagChatLatencySlowBurn", { budget: 0.05, factor: 6, longWindow: "6h", shortWindow: "30m", sli: "chat_latency_sli" });
  assert.equal(alerts.get("ArchiveRagChatAvailabilityFastBurn").labels.severity, "critical");
  assert.equal(alerts.get("ArchiveRagChatAvailabilitySlowBurn").labels.severity, "warning");

  for (const name of [
    "ArchiveRagIngestDeadLetters",
    "ArchiveRagModelCircuitOpen",
    "ArchiveRagPostgresReplicaLagHigh",
    "ArchiveRagMetricsTargetDown",
    "ArchiveRagGatewayQuotaRejectionsSpike",
  ]) {
    assert.ok(alerts.has(name), name);
  }

  assert.equal(alerts.get("ArchiveRagModelCircuitOpen").for, "5m");
  assert.match(alerts.get("ArchiveRagIngestDeadLetters").expr, /> 0/u);
});

test("every alert has a severity, summary, description and a runbook with three checks and real commands", async () => {
  const { alerting } = await loadRules();
  const { scripts } = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const alerts = alerting.groups.flatMap((group) => group.rules);
  const families = catalogue();
  const familyNames = new Set(getMetricsRegistry().describe().map((family) => family.name));

  assert.ok(alerts.length >= 9);

  for (const alert of alerts) {
    assert.match(alert.alert, /^ArchiveRag[A-Za-z]+$/u);
    assert.ok(["critical", "warning"].includes(alert.labels?.severity), `${alert.alert} severity`);
    assert.match(String(alert.for ?? ""), /^\d+[smh]$/u, `${alert.alert} has a for duration`);

    for (const key of ["summary", "description", "runbook"]) {
      assert.equal(typeof alert.annotations?.[key], "string", `${alert.alert} annotation ${key}`);
      assert.ok(alert.annotations[key].trim().length > 20, `${alert.alert} ${key} says something`);
    }

    const runbook = alert.annotations.runbook;

    assert.match(runbook, /^What it means: /mu, `${alert.alert} runbook explains the alert`);
    assert.match(runbook, /^First three checks:$/mu, alert.alert);

    for (const step of ["1. ", "2. ", "3. "]) {
      assert.ok(runbook.includes(`\n${step}`), `${alert.alert} runbook check ${step}`);
    }

    assert.match(runbook, /^Commands: /mu, `${alert.alert} runbook names commands`);

    for (const [, script] of runbook.matchAll(/npm run ([a-z0-9:-]+)/gu)) {
      assert.ok(Object.hasOwn(scripts, script), `${alert.alert}: npm run ${script} is not a server script`);
    }

    // The queries a runbook suggests read metrics that exist.
    for (const [name] of runbook.matchAll(/\b(?:archive_rag|nodejs|process)_[a-z0-9_]+\b/gu)) {
      assert.ok(
        families.has(name) || familyNames.has(name),
        `${alert.alert}: runbook names ${name}, which no module exposes`
      );
    }

    // Templates only read labels the alert keeps.
    for (const [, label] of `${alert.annotations.summary} ${alert.annotations.description}`.matchAll(/\$labels\.([a-z_]+)/gu)) {
      assert.ok(alert.expr.includes(label) || TARGET_LABELS.has(label), `${alert.alert}: $labels.${label}`);
    }
  }
});

test("the example scrape configuration labels every target with its role and loads both rule files", async () => {
  const { scrape } = await loadRules();
  const job = scrape.scrape_configs.find((entry) => entry.job_name === "archive-rag");

  assert.ok(job, "job archive-rag, which every rule selects");
  assert.equal(job.metrics_path, "/metrics");
  assert.deepEqual(scrape.rule_files, ["recording-rules.yml", "alert-rules.yml"]);
  assert.equal(job.authorization.type, "Bearer");

  const roles = new Set();

  for (const config of job.static_configs) {
    assert.ok(Array.isArray(config.targets) && config.targets.length > 0);
    assert.ok(["all", "api", "agent", "retrieval", "model-gateway"].includes(config.labels?.role), config.labels?.role);
    assert.ok(config.targets.every((target) => target.endsWith(":9464")), "the default METRICS_PORT");
    roles.add(config.labels.role);
  }

  assert.deepEqual([...roles].sort(), ["agent", "all", "api", "model-gateway", "retrieval"]);
});
