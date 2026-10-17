import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  GRAPH_GOLDENS_RUNTIME_UNDER_TEST,
  assertMatchesGraphGolden,
  assertMatchesGraphGoldenDigest,
  isUpdatingGraphGoldens,
} from "./langgraph-support/graph-goldens.mjs";

// The write rules of the graph golden fixtures
// (test/langgraph-support/graph-goldens.mjs). The goldens froze what the
// native graph scheduler did before phase 6 of docs/adr/0001-langgraph-
// runtime.md deleted it, so rewriting one must be a decision: only
// UPDATE_GRAPH_GOLDENS=1 writes, it writes from the runtime under test, and an
// update run that changes a fixture still fails, naming it.

const SUITE = `graph-goldens-selftest-${process.pid}`;
const suiteDirectory = fileURLToPath(new URL(`./fixtures/graph-goldens/${SUITE}/`, import.meta.url));

const withUpdate = (value, work) => {
  const saved = Object.hasOwn(process.env, "UPDATE_GRAPH_GOLDENS")
    ? process.env.UPDATE_GRAPH_GOLDENS
    : undefined;

  if (value === undefined) {
    delete process.env.UPDATE_GRAPH_GOLDENS;
  } else {
    process.env.UPDATE_GRAPH_GOLDENS = value;
  }

  try {
    return work();
  } finally {
    if (saved === undefined) {
      delete process.env.UPDATE_GRAPH_GOLDENS;
    } else {
      process.env.UPDATE_GRAPH_GOLDENS = saved;
    }
  }
};

test.after(() => {
  rmSync(suiteDirectory, { force: true, recursive: true });
});

test("the goldens are written from LangGraph, the only runtime left", () => {
  assert.equal(GRAPH_GOLDENS_RUNTIME_UNDER_TEST, "langgraph");
});

test("only an unset, empty or exactly 1 UPDATE_GRAPH_GOLDENS is accepted", () => {
  assert.equal(withUpdate(undefined, isUpdatingGraphGoldens), false);
  assert.equal(withUpdate("", isUpdatingGraphGoldens), false);
  assert.equal(withUpdate("1", isUpdatingGraphGoldens), true);

  for (const value of ["native", "langgraph", "true", "yes", "0", " 1"]) {
    assert.throws(
      () => withUpdate(value, isUpdatingGraphGoldens),
      /UPDATE_GRAPH_GOLDENS=.* is refused: graph goldens are written only from the runtime under test \(langgraph\)/,
      value
    );
    // Also where nothing could be written: a compare-only side fails too.
    assert.throws(
      () => withUpdate(value, () => assertMatchesGraphGolden(SUITE, "refused", { a: 1 }, { write: false })),
      /is refused/,
      value
    );
    assert.throws(
      () => withUpdate(value, () => assertMatchesGraphGoldenDigest(SUITE, "refused", { a: 1 }, { write: false })),
      /is refused/,
      value
    );
  }

  assert.equal(existsSync(suiteDirectory), false, "a refused value wrote nothing");
});

test("without UPDATE_GRAPH_GOLDENS a missing golden fails and nothing is written", () => {
  assert.throws(
    () => withUpdate(undefined, () => assertMatchesGraphGolden(SUITE, "missing", { a: 1 })),
    /Missing graph golden/
  );
  assert.throws(
    () => withUpdate(undefined, () => assertMatchesGraphGoldenDigest(SUITE, "missing", { a: 1 })),
    /Missing graph golden digest/
  );
  assert.equal(existsSync(suiteDirectory), false);
});

test("an update run writes a new or changed golden and still fails; an unchanged one passes", () => {
  const file = `${suiteDirectory}case.json`;

  // A new golden is written, and the run that wrote it fails.
  assert.throws(
    () => withUpdate("1", () => assertMatchesGraphGolden(SUITE, "case", { a: 1 })),
    /UPDATE_GRAPH_GOLDENS=1 rewrote .*case\.json from the runtime under test \(langgraph\)/
  );
  const written = readFileSync(file, "utf8");

  // Compared without the variable, it now passes.
  withUpdate(undefined, () => assertMatchesGraphGolden(SUITE, "case", { a: 1 }));
  // An update run that changes nothing passes and writes nothing.
  withUpdate("1", () => assertMatchesGraphGolden(SUITE, "case", { a: 1 }));
  assert.equal(readFileSync(file, "utf8"), written);

  // A side that may not write never rewrites it, even while updating.
  assert.throws(
    () => withUpdate("1", () => assertMatchesGraphGolden(SUITE, "case", { a: 2 }, { write: false })),
    /differs from its golden/
  );
  assert.equal(readFileSync(file, "utf8"), written);

  // A changed value is written, and that run fails too.
  assert.throws(
    () => withUpdate("1", () => assertMatchesGraphGolden(SUITE, "case", { a: 2 })),
    /rewrote/
  );
  withUpdate(undefined, () => assertMatchesGraphGolden(SUITE, "case", { a: 2 }));
  assert.throws(
    () => withUpdate(undefined, () => assertMatchesGraphGolden(SUITE, "case", { a: 1 })),
    /differs from its golden/
  );
});

test("an update run of a digest that changes fails, and the same digest then passes", () => {
  assert.throws(
    () => withUpdate("1", () => assertMatchesGraphGoldenDigest(SUITE, "sweep/one", { a: 1 })),
    /rewrote .*digests\.json#sweep\/one/
  );
  // The digests file is flushed at exit, by a listener the helper registered
  // just now; this one runs after it and removes what it wrote. Within the
  // process the new digest is what is compared.
  process.on("exit", () => {
    rmSync(suiteDirectory, { force: true, recursive: true });
  });
  withUpdate(undefined, () => assertMatchesGraphGoldenDigest(SUITE, "sweep/one", { a: 1 }));
  withUpdate("1", () => assertMatchesGraphGoldenDigest(SUITE, "sweep/one", { a: 1 }));
  assert.throws(
    () => withUpdate(undefined, () => assertMatchesGraphGoldenDigest(SUITE, "sweep/one", { a: 2 })),
    /differs from its golden/
  );
});
