// Golden fixtures for the graph-runtime suites
// (docs/adr/0001-langgraph-runtime.md). Until phase 6 the parity suites
// compared the native scheduler with LangGraph on the same scenario; before
// phase 6 deleted the native scheduler, the native side's masked outcome of
// the graph scenarios was frozen here (from HEAD e1385c1c with
// AGENT_RUNTIME=native for the langgraph-routes and
// langgraph-execution-plan-graph fixtures, added after review), and the
// LangGraph side is now held to it. The ADR's phase-6 section lists the two
// comparisons that are not the pre-deletion ones (the unified-graph replay
// sweep is now masked and digested; the planner goldens normalize a port and
// a V8 message suffix) and the native runs that have no golden (the
// PostgreSQL integration suites').
//
//   assertMatchesGraphGolden(suiteName, caseName, maskedValue)
//     compares the canonical form of an already-masked value with
//     test/fixtures/graph-goldens/<suiteName>/<caseName>.json;
//   assertMatchesGraphGoldenDigest(suiteName, caseName, maskedValue)
//     compares the sha256 of its canonical serialization with the entry
//     <caseName> of test/fixtures/graph-goldens/<suiteName>/digests.json
//     (for sweeps too large to store in full).
//
// The canonical form keeps everything assert.deepStrictEqual compares on
// plain data: object keys are sorted (key order never matters), arrays keep
// their order, and what JSON cannot hold is tagged instead of dropped
// (undefined, -0, NaN, +-Infinity, bigint, functions by name, Map and Set
// entries, Dates), so a property that is present-but-undefined still differs
// from a missing one.
//
// Writing. A golden is the record of what the deleted native scheduler did,
// so rewriting one is a decision, never a side effect of a run:
//   - Without UPDATE_GRAPH_GOLDENS a missing or different fixture fails the
//     test, and nothing is written.
//   - UPDATE_GRAPH_GOLDENS=1 writes from the runtime under test (LangGraph,
//     the only one left), and only from a call that may write (`write`
//     defaults to true; a side that must never be a golden's source, such as
//     a replay held to the scheduler's golden, passes { write: false }). A
//     fixture it creates or changes is written and the test still fails,
//     naming it, so an update run passes only when nothing changed: review
//     the diff, explain the intended behaviour change in a comment in the
//     same change, then run again without the variable.
//   - Any other value (`native`, `true`, `yes`, ...) is refused: the native
//     scheduler that wrote the first goldens no longer exists, and only the
//     runtime under test may write.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GOLDENS_ROOT = new URL("../fixtures/graph-goldens/", import.meta.url);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAG = "$graphGolden";

// The runtime the goldens are written from since phase 6.
export const GRAPH_GOLDENS_RUNTIME_UNDER_TEST = "langgraph";

export const isUpdatingGraphGoldens = () => {
  const value = process.env.UPDATE_GRAPH_GOLDENS;

  if (value === undefined || value === "") {
    return false;
  }

  if (value === "1") {
    return true;
  }

  throw new Error(
    `UPDATE_GRAPH_GOLDENS=${JSON.stringify(value)} is refused: graph goldens are written ` +
      `only from the runtime under test (${GRAPH_GOLDENS_RUNTIME_UNDER_TEST}) with ` +
      "UPDATE_GRAPH_GOLDENS=1, and the native scheduler that froze them was removed " +
      "(ADR 0001 phase 6). Unset it to compare, or set it to 1 and explain the intended " +
      "behaviour change in a comment in the same change."
  );
};

const failRewrittenGolden = (location) =>
  assert.fail(
    `UPDATE_GRAPH_GOLDENS=1 rewrote ${location} from the runtime under test ` +
      `(${GRAPH_GOLDENS_RUNTIME_UNDER_TEST}). Review the diff, explain the intended behaviour ` +
      "change in a comment in the same change, and run again without UPDATE_GRAPH_GOLDENS."
  );

const assertName = (kind, name) => {
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.includes("..")) {
    throw new TypeError(`Invalid golden ${kind} ${JSON.stringify(name)}.`);
  }
};

const suiteDirectory = (suiteName) => {
  assertName("suite name", suiteName);
  return new URL(`${suiteName}/`, GOLDENS_ROOT);
};

const sortedEntries = (object) =>
  Object.keys(object)
    .sort()
    .map((key) => [key, object[key]]);

/** The canonical, JSON-safe form of a value (see the header). */
export const canonicalizeGraphGolden = (value, seen = new Set()) => {
  if (value === undefined) {
    return { [TAG]: "undefined" };
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return { [TAG]: "NaN" };
    }
    if (value === Infinity || value === -Infinity) {
      return { [TAG]: value > 0 ? "Infinity" : "-Infinity" };
    }
    if (Object.is(value, -0)) {
      return { [TAG]: "-0" };
    }
    return value;
  }

  if (typeof value === "bigint") {
    return { [TAG]: "bigint", value: value.toString() };
  }

  if (typeof value === "function") {
    return { [TAG]: "function", name: value.name };
  }

  if (typeof value === "symbol") {
    return { [TAG]: "symbol", description: value.description ?? null };
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    throw new TypeError("A graph golden cannot hold a cycle.");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item) => canonicalizeGraphGolden(item, seen));
    }

    if (value instanceof Date) {
      return { [TAG]: "Date", value: Number.isNaN(value.getTime()) ? null : value.toISOString() };
    }

    if (value instanceof Map) {
      return {
        [TAG]: "Map",
        entries: [...value].map(([key, item]) => [
          canonicalizeGraphGolden(key, seen),
          canonicalizeGraphGolden(item, seen),
        ]),
      };
    }

    if (value instanceof Set) {
      return { [TAG]: "Set", values: [...value].map((item) => canonicalizeGraphGolden(item, seen)) };
    }

    if (Object.hasOwn(value, TAG)) {
      throw new TypeError(`A graph golden cannot hold a ${TAG} key of its own.`);
    }

    return Object.fromEntries(
      sortedEntries(value).map(([key, item]) => [key, canonicalizeGraphGolden(item, seen)])
    );
  } finally {
    seen.delete(value);
  }
};

const serialize = (canonical) => `${JSON.stringify(canonical, null, 2)}\n`;

/** The sha256 of a value's canonical serialization. */
export const digestGraphGolden = (value) =>
  createHash("sha256").update(JSON.stringify(canonicalizeGraphGolden(value))).digest("hex");

export const assertMatchesGraphGolden = (suiteName, caseName, maskedValue, { write = true } = {}) => {
  assertName("case name", caseName);
  const directory = suiteDirectory(suiteName);
  const file = new URL(`${caseName}.json`, directory);
  const canonical = canonicalizeGraphGolden(maskedValue);
  const location = `${suiteName}/${caseName}.json`;
  // Read on every call, so a refused value fails a compare-only side too.
  const updating = isUpdatingGraphGoldens();

  if (write && updating) {
    const serialized = serialize(canonical);
    const path = fileURLToPath(file);

    if (!existsSync(path) || readFileSync(path, "utf8") !== serialized) {
      mkdirSync(fileURLToPath(directory), { recursive: true });
      writeFileSync(path, serialized);
      failRewrittenGolden(location);
    }
  }

  if (!existsSync(fileURLToPath(file))) {
    assert.fail(
      `Missing graph golden ${location} (UPDATE_GRAPH_GOLDENS=1 writes it from the side that may write).`
    );
  }

  assert.deepStrictEqual(
    canonical,
    JSON.parse(readFileSync(fileURLToPath(file), "utf8")),
    `${suiteName}/${caseName} differs from its golden`
  );
};

// One digests file per suite, read once and, while updating, written back at
// exit (sorted), so a sweep of hundreds of cases rewrites it once.
const digestFiles = new Map();
let flushRegistered = false;

const flushDigestFiles = () => {
  for (const entry of digestFiles.values()) {
    if (entry.dirty) {
      mkdirSync(fileURLToPath(entry.directory), { recursive: true });
      writeFileSync(fileURLToPath(entry.file), serialize(Object.fromEntries(sortedEntries(entry.digests))));
      entry.dirty = false;
    }
  }
};

const loadDigestFile = (suiteName) => {
  if (!digestFiles.has(suiteName)) {
    const directory = suiteDirectory(suiteName);
    const file = new URL("digests.json", directory);
    const digests = existsSync(fileURLToPath(file))
      ? JSON.parse(readFileSync(fileURLToPath(file), "utf8"))
      : {};

    digestFiles.set(suiteName, { digests, directory, dirty: false, file });
  }

  return digestFiles.get(suiteName);
};

export const assertMatchesGraphGoldenDigest = (suiteName, caseName, maskedValue, { write = true } = {}) => {
  if (typeof caseName !== "string" || caseName.length === 0) {
    throw new TypeError(`Invalid golden case name ${JSON.stringify(caseName)}.`);
  }
  const updating = isUpdatingGraphGoldens();
  const entry = loadDigestFile(suiteName);
  const digest = digestGraphGolden(maskedValue);

  if (write && updating && entry.digests[caseName] !== digest) {
    entry.digests[caseName] = digest;
    entry.dirty = true;
    if (!flushRegistered) {
      flushRegistered = true;
      process.on("exit", flushDigestFiles);
    }
    failRewrittenGolden(`${suiteName}/digests.json#${caseName}`);
  }

  if (!Object.hasOwn(entry.digests, caseName)) {
    assert.fail(
      `Missing graph golden digest ${suiteName}/digests.json#${caseName} (UPDATE_GRAPH_GOLDENS=1 writes it from the side that may write).`
    );
  }

  assert.equal(digest, entry.digests[caseName], `${suiteName}/digests.json#${caseName} differs from its golden`);
};
