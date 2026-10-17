import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The LangGraph migration (docs/adr/0001-langgraph-runtime.md) depends on one
// copy of @langchain/core: LangGraph checks `instanceof` against core classes
// (Runnable, BaseCheckpointSaver via langgraph-checkpoint) and keeps its run
// config in a process-wide AsyncLocalStorage singleton that core owns. A
// second core copy nested under one package would make those checks fail at
// run time, not at install time, so pin it here against the lock file.

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (fileName) =>
  JSON.parse(await readFile(path.join(serverDirectory, fileName), "utf8"));

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const isLangChainPackage = (name) => name === "langchain" || name.startsWith("@langchain/");

const lockEntriesFor = (lock, name) =>
  Object.entries(lock.packages).filter(
    ([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)
  );

const parseVersion = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

  assert.ok(match, `expected a plain x.y.z version, got ${version}`);
  return match.slice(1).map(Number);
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
};

// Only the range forms these packages use today. Anything else fails loudly,
// so a future range syntax is checked by a person instead of passing silently.
const satisfiesRange = (version, range) =>
  range.split("||").some((alternative) => {
    const caret = /^\^(\d+\.\d+\.\d+)$/.exec(alternative.trim());

    assert.ok(caret, `unsupported peer range "${range}"; extend satisfiesRange`);

    const installed = parseVersion(version);
    const floor = parseVersion(caret[1]);

    return installed[0] === floor[0] && compareVersions(installed, floor) >= 0;
  });

test("LangChain packages are pinned to exact versions in package.json and the lock", async () => {
  const manifest = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  const pinned = Object.entries(manifest.dependencies).filter(([name]) =>
    isLangChainPackage(name)
  );

  assert.deepEqual(
    pinned.map(([name]) => name).sort(),
    [
      "@langchain/core",
      "@langchain/langgraph",
      "@langchain/langgraph-checkpoint",
      "@langchain/openai",
      "langchain",
    ]
  );

  for (const [name, version] of pinned) {
    assert.match(version, EXACT_VERSION, `${name} must be an exact version`);
    assert.equal(
      lock.packages[""].dependencies[name],
      version,
      `${name} in package-lock.json root must match package.json`
    );
    assert.equal(
      lock.packages[`node_modules/${name}`]?.version,
      version,
      `${name} must be installed at the pinned version`
    );
  }
});

test("every LangChain package shares a single @langchain/core and checkpoint copy", async () => {
  const manifest = await readJson("package.json");
  const lock = await readJson("package-lock.json");

  for (const shared of ["@langchain/core", "@langchain/langgraph-checkpoint"]) {
    const entries = lockEntriesFor(lock, shared);

    assert.deepEqual(
      entries.map(([key]) => key),
      [`node_modules/${shared}`],
      `${shared} must not be nested under another package`
    );
    assert.equal(entries[0][1].version, manifest.dependencies[shared]);
  }
});

test("installed @langchain/core and zod meet every LangChain peer range", async () => {
  const lock = await readJson("package-lock.json");
  const installed = {
    "@langchain/core": lock.packages["node_modules/@langchain/core"].version,
    zod: lock.packages["node_modules/zod"].version,
  };
  const checked = [];

  for (const [key, entry] of Object.entries(lock.packages)) {
    const name = key.replace(/^.*node_modules\//, "");

    if (!isLangChainPackage(name)) {
      continue;
    }

    for (const [peer, range] of Object.entries(entry.peerDependencies ?? {})) {
      if (!Object.hasOwn(installed, peer)) {
        continue;
      }

      checked.push(`${name} -> ${peer}`);
      assert.ok(
        satisfiesRange(installed[peer], range),
        `${name} needs ${peer} ${range}, installed ${installed[peer]}`
      );
    }
  }

  // Guard against the check above silently matching nothing.
  assert.ok(checked.includes("@langchain/langgraph -> @langchain/core"));
  assert.ok(checked.includes("@langchain/langgraph -> zod"));
});
