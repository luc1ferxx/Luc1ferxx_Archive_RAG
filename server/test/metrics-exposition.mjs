// A strict reader of the Prometheus text exposition format 0.0.4, for the
// metrics tests: it parses what rag/metrics.js renders back into families and
// samples, and throws on anything a Prometheus server would reject (a sample
// before its TYPE, a malformed label, a bad escape, a family split in two).

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/u;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*/u;
const TYPES = new Set(["counter", "gauge", "histogram", "summary", "untyped"]);

const unescapeHelp = (text) =>
  text.replace(/\\(\\|n)/gu, (match, char) => (char === "n" ? "\n" : "\\"));

const parseValue = (token, lineNumber) => {
  if (token === "NaN") {
    return Number.NaN;
  }

  if (token === "+Inf") {
    return Infinity;
  }

  if (token === "-Inf") {
    return -Infinity;
  }

  const value = Number(token);

  if (token === "" || Number.isNaN(value)) {
    throw new Error(`line ${lineNumber}: bad sample value "${token}"`);
  }

  return value;
};

// `{a="x",b="y"}` starting at text[index] === "{"; returns [labels, next index].
const parseLabels = (text, start, lineNumber) => {
  const labels = {};
  let index = start + 1;

  for (;;) {
    if (text[index] === "}") {
      return [labels, index + 1];
    }

    const nameMatch = LABEL_NAME.exec(text.slice(index));

    if (!nameMatch) {
      throw new Error(`line ${lineNumber}: bad label name at column ${index}`);
    }

    const name = nameMatch[0];

    index += name.length;

    if (text[index] !== "=" || text[index + 1] !== '"') {
      throw new Error(`line ${lineNumber}: expected ="..." after label ${name}`);
    }

    index += 2;

    let value = "";

    for (;;) {
      const char = text[index];

      if (char === undefined) {
        throw new Error(`line ${lineNumber}: unterminated label value`);
      }

      if (char === "\\") {
        const next = text[index + 1];

        if (next === "\\") {
          value += "\\";
        } else if (next === '"') {
          value += '"';
        } else if (next === "n") {
          value += "\n";
        } else {
          throw new Error(`line ${lineNumber}: bad escape \\${next} in label ${name}`);
        }

        index += 2;
        continue;
      }

      if (char === "\n") {
        throw new Error(`line ${lineNumber}: raw newline in label ${name}`);
      }

      if (char === '"') {
        index += 1;
        break;
      }

      value += char;
      index += 1;
    }

    if (Object.hasOwn(labels, name)) {
      throw new Error(`line ${lineNumber}: label ${name} repeated`);
    }

    labels[name] = value;

    if (text[index] === ",") {
      index += 1;
    } else if (text[index] !== "}") {
      throw new Error(`line ${lineNumber}: expected , or } after label ${name}`);
    }
  }
};

const familyOfSample = (sampleName, families) => {
  if (families.has(sampleName)) {
    return families.get(sampleName);
  }

  for (const suffix of ["_bucket", "_sum", "_count"]) {
    if (sampleName.endsWith(suffix)) {
      const family = families.get(sampleName.slice(0, -suffix.length));

      if (family?.type === "histogram" || family?.type === "summary") {
        return family;
      }
    }
  }

  return null;
};

/**
 * Parses an exposition into Map(name -> { name, help, type, samples:
 * [{ name, labels, value }] }). Throws on malformed input.
 */
export const parseExposition = (text) => {
  if (!text.endsWith("\n")) {
    throw new Error("exposition must end with a newline");
  }

  const families = new Map();
  const closed = new Set();
  let current = null;

  const open = (name, lineNumber) => {
    if (closed.has(name)) {
      throw new Error(`line ${lineNumber}: family ${name} appears in two places`);
    }

    if (current && current.name !== name) {
      closed.add(current.name);
    }

    if (!families.has(name)) {
      families.set(name, { help: null, name, samples: [], type: null });
    }

    current = families.get(name);
    return current;
  };

  text.slice(0, -1).split("\n").forEach((line, offset) => {
    const lineNumber = offset + 1;

    if (line === "") {
      return;
    }

    if (line.startsWith("# HELP ")) {
      const rest = line.slice(7);
      const name = METRIC_NAME.exec(rest)?.[0];

      if (!name || (rest.length > name.length && rest[name.length] !== " ")) {
        throw new Error(`line ${lineNumber}: bad HELP line`);
      }

      const family = open(name, lineNumber);

      if (family.help !== null) {
        throw new Error(`line ${lineNumber}: second HELP for ${name}`);
      }

      family.help = unescapeHelp(rest.slice(name.length + 1));
      return;
    }

    if (line.startsWith("# TYPE ")) {
      const [name, type, extra] = line.slice(7).split(" ");

      if (!name || !METRIC_NAME.test(name) || !TYPES.has(type) || extra !== undefined) {
        throw new Error(`line ${lineNumber}: bad TYPE line`);
      }

      const family = open(name, lineNumber);

      if (family.type !== null || family.samples.length > 0) {
        throw new Error(`line ${lineNumber}: TYPE for ${name} after its samples or twice`);
      }

      family.type = type;
      return;
    }

    if (line.startsWith("#")) {
      return;
    }

    const name = METRIC_NAME.exec(line)?.[0];

    if (!name) {
      throw new Error(`line ${lineNumber}: bad sample name`);
    }

    let index = name.length;
    let labels = {};

    if (line[index] === "{") {
      [labels, index] = parseLabels(line, index, lineNumber);
    }

    if (line[index] !== " ") {
      throw new Error(`line ${lineNumber}: expected a space before the value`);
    }

    const [valueToken, timestamp, extra] = line.slice(index + 1).split(" ");

    if (extra !== undefined || (timestamp !== undefined && !/^-?\d+$/u.test(timestamp))) {
      throw new Error(`line ${lineNumber}: bad value or timestamp`);
    }

    const family = familyOfSample(name, families);

    if (!family || family.type === null) {
      throw new Error(`line ${lineNumber}: sample ${name} has no TYPE before it`);
    }

    if (family !== current) {
      throw new Error(`line ${lineNumber}: sample ${name} outside its family's block`);
    }

    family.samples.push({ labels, name, value: parseValue(valueToken, lineNumber) });
  });

  return families;
};

const withoutLabel = (labels, dropped) =>
  Object.fromEntries(Object.entries(labels).filter(([name]) => name !== dropped));

const labelKey = (labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Checks every series of a histogram family: buckets ascending by `le` with
 * non-decreasing counts, a +Inf bucket equal to _count, and a _sum. Returns
 * Map(labelKey -> { labels, buckets: [[le, count]], count, sum }).
 */
export const checkHistogram = (family) => {
  if (family?.type !== "histogram") {
    throw new Error(`${family?.name} is not a histogram`);
  }

  const series = new Map();
  const entryFor = (labels) => {
    const key = labelKey(labels);

    if (!series.has(key)) {
      series.set(key, { buckets: [], count: null, labels, sum: null });
    }

    return series.get(key);
  };

  for (const sample of family.samples) {
    if (sample.name === `${family.name}_bucket`) {
      if (!Object.hasOwn(sample.labels, "le")) {
        throw new Error(`${family.name}: bucket without le`);
      }

      entryFor(withoutLabel(sample.labels, "le")).buckets.push([parseValue(sample.labels.le, 0), sample.value]);
    } else if (sample.name === `${family.name}_sum`) {
      entryFor(sample.labels).sum = sample.value;
    } else if (sample.name === `${family.name}_count`) {
      entryFor(sample.labels).count = sample.value;
    } else {
      throw new Error(`${family.name}: unexpected sample ${sample.name}`);
    }
  }

  for (const entry of series.values()) {
    const bounds = entry.buckets.map(([le]) => le);

    for (let index = 1; index < entry.buckets.length; index += 1) {
      if (!(bounds[index] > bounds[index - 1])) {
        throw new Error(`${family.name}: buckets not ascending`);
      }

      if (entry.buckets[index][1] < entry.buckets[index - 1][1]) {
        throw new Error(`${family.name}: bucket counts decrease`);
      }
    }

    if (bounds.at(-1) !== Infinity) {
      throw new Error(`${family.name}: no +Inf bucket`);
    }

    if (entry.count === null || entry.sum === null) {
      throw new Error(`${family.name}: missing _count or _sum`);
    }

    if (entry.buckets.at(-1)[1] !== entry.count) {
      throw new Error(`${family.name}: +Inf bucket ${entry.buckets.at(-1)[1]} != _count ${entry.count}`);
    }
  }

  return series;
};

/** The value of the sample named `name` whose labels include `labels` (summed when several match). */
export const sampleValue = (families, name, labels = {}) => {
  let total = 0;
  let found = false;

  for (const family of families.values()) {
    for (const sample of family.samples) {
      if (
        sample.name === name &&
        Object.entries(labels).every(([label, value]) => sample.labels[label] === value)
      ) {
        total += sample.value;
        found = true;
      }
    }
  }

  return found ? total : 0;
};
