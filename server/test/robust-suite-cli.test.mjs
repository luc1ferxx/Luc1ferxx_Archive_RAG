import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.resolve(__dirname, "..");

const runRobustGateCli = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["evaluation/check-robust-suite.mjs", ...args],
      {
        cwd: serverDirectory,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stderr,
        stdout,
      });
    });
  });

test("robust gate CLI fails closed when every scoped report is missing", async () => {
  const inputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "robust-gate-missing-")
  );

  try {
    const result = await runRobustGateCli([
      "--input-directory",
      inputDirectory,
      "--json",
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision.authoritativeForCurrentCommit, false);
    assert.equal(payload.decision.currentCommitVerified, false);
    assert.equal(
      payload.decision.evidenceScope,
      "latest_reports_unverified"
    );
    assert.equal(payload.decision.scope, "robust_suite_only");
    assert.equal(payload.decision.status, "fail");
    assert.equal(payload.gate.status, "fail");
    assert.equal(payload.gate.skipped, false);
    assert.equal(payload.gate.reports.length, 3);
    assert.deepEqual(
      payload.gate.reports.map((report) => report.missing),
      [true, true, true]
    );
  } finally {
    await rm(inputDirectory, { recursive: true, force: true });
  }
});

test("robust gate CLI rejects malformed JSON instead of treating it as missing", async () => {
  const inputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "robust-gate-malformed-")
  );

  try {
    await writeFile(path.join(inputDirectory, "latest.json"), "{", "utf8");

    const result = await runRobustGateCli([
      `--input-directory=${inputDirectory}`,
      "--json",
    ]);

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /JSON|Unexpected end/i);
  } finally {
    await rm(inputDirectory, { recursive: true, force: true });
  }
});

test("robust gate CLI rejects unknown and incomplete options", async () => {
  const unknown = await runRobustGateCli(["--require-robust-suite"]);
  const incomplete = await runRobustGateCli(["--input-directory"]);

  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.stderr, /Unknown option: --require-robust-suite/);
  assert.equal(incomplete.exitCode, 2);
  assert.match(incomplete.stderr, /--input-directory requires a value/);
});

test("robust gate CLI documents its intentionally narrow evidence scope", async () => {
  const result = await runRobustGateCli(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Reads only the three latest robust-suite reports/);
  assert.match(result.stdout, /--fail-on-warn/);
  assert.doesNotMatch(result.stdout, /--require-robust-suite/);
});

test("robust gate text output never presents latest reports as current evidence", async () => {
  const inputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "robust-gate-unverified-")
  );

  try {
    const result = await runRobustGateCli([
      "--input-directory",
      inputDirectory,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /Evidence scope: latest_reports_unverified/);
    assert.match(result.stdout, /use release:gate/);
  } finally {
    await rm(inputDirectory, { recursive: true, force: true });
  }
});
