import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createSyntheticQualityEvaluationRunner,
} from "../evaluation/quality-synthetic-runner.js";

const createChild = () => {
  const child = new EventEmitter();

  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };

  return child;
};

const createTimerHarness = () => {
  const timers = [];

  return {
    clearTimer(timer) {
      timer.cleared = true;
    },
    runNextTimer() {
      const timer = timers.find((entry) => !entry.cleared && !entry.ran);

      assert.ok(timer, "expected a pending timer");
      timer.ran = true;
      timer.callback();
    },
    setTimer(callback, delayMs) {
      const timer = {
        callback,
        cleared: false,
        delayMs,
        ran: false,
      };
      timers.push(timer);
      return timer;
    },
    timers,
  };
};

test("quality runner maps a registered corpus ID to fixed deterministic arguments", async () => {
  const child = createChild();
  const spawnCalls = [];
  const expectedReport = {
    status: "pass",
  };
  const runner = createSyntheticQualityEvaluationRunner({
    readLatestReport: async () => expectedReport,
    runtimePath: "/fixed/node",
    serverDirectory: "/fixed/server",
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
  });

  const pending = runner({
    corpusId: "near-duplicate",
  });

  child.emit("close", 0);

  assert.equal(await pending, expectedReport);
  assert.deepEqual(spawnCalls, [
    [
      "/fixed/node",
      [
        "--max-old-space-size=512",
        "evaluation/run-synthetic-eval.mjs",
        "evaluation/synthetic-corpus-near-duplicate.json",
        "--openai-provider",
        "deterministic",
      ],
      {
        cwd: "/fixed/server",
        env: process.env,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    ],
  ]);
});

test("quality runner rejects paths and unknown corpus IDs before spawning", async () => {
  let spawnCount = 0;
  const runner = createSyntheticQualityEvaluationRunner({
    readLatestReport: async () => ({}),
    spawnProcess: () => {
      spawnCount += 1;
      const child = createChild();

      queueMicrotask(() => child.emit("close", 1));
      return child;
    },
  });

  await assert.rejects(
    () =>
      runner({
        corpusPath: "../../package.json",
      }),
    {
      code: "QUALITY_CORPUS_PATH_FORBIDDEN",
      expose: true,
      status: 400,
    }
  );
  for (const corpusId of [
    "../../package.json",
    "constructor",
    "__proto__",
    "toString",
  ]) {
    await assert.rejects(
      () =>
        runner({
          corpusId,
        }),
      {
        code: "QUALITY_CORPUS_UNKNOWN",
        expose: true,
        status: 400,
      }
    );
  }
  assert.equal(spawnCount, 0);
});

test("quality runner permits only one child process at a time", async () => {
  const children = [];
  const runner = createSyntheticQualityEvaluationRunner({
    readLatestReport: async () => ({
      status: "pass",
    }),
    spawnProcess: () => {
      const child = createChild();
      children.push(child);
      return child;
    },
  });

  const firstRun = runner({
    corpusId: "near-duplicate",
  });

  await assert.rejects(
    () =>
      runner({
        corpusId: "compare-hard",
      }),
    {
      code: "QUALITY_EVALUATION_IN_PROGRESS",
      expose: true,
      status: 409,
    }
  );
  assert.equal(children.length, 1);

  children[0].emit("close", 0);
  await firstRun;

  const secondRun = runner({
    corpusId: "compare-hard",
  });

  assert.equal(children.length, 2);
  children[1].emit("close", 0);
  await secondRun;
});

test("quality runner holds its slot while reading the completed report", async () => {
  const children = [];
  let finishReportRead;
  const reportPending = new Promise((resolve) => {
    finishReportRead = resolve;
  });
  const runner = createSyntheticQualityEvaluationRunner({
    readLatestReport: () => reportPending,
    spawnProcess: () => {
      const child = createChild();
      children.push(child);
      return child;
    },
  });
  const firstRun = runner({
    corpusId: "near-duplicate",
  });

  children[0].emit("close", 0);

  await assert.rejects(
    () =>
      runner({
        corpusId: "compare-hard",
      }),
    {
      code: "QUALITY_EVALUATION_IN_PROGRESS",
      status: 409,
    }
  );
  assert.equal(children.length, 1);

  finishReportRead({
    status: "pass",
  });
  await firstRun;
});

test("report-read timeout releases only its own completed-process slot", async () => {
  const children = [];
  const timerHarness = createTimerHarness();
  let finishOldReportRead;
  let readCount = 0;
  const oldReportPending = new Promise((resolve) => {
    finishOldReportRead = resolve;
  });
  const runner = createSyntheticQualityEvaluationRunner({
    clearTimer: timerHarness.clearTimer,
    readLatestReport: () => {
      readCount += 1;
      return readCount === 1
        ? oldReportPending
        : Promise.resolve({
            status: "pass",
          });
    },
    setTimer: timerHarness.setTimer,
    spawnProcess: () => {
      const child = createChild();
      children.push(child);
      return child;
    },
    timeoutMs: 50,
  });
  const oldRun = runner({
    corpusId: "near-duplicate",
  });

  children[0].emit("close", 0);
  timerHarness.runNextTimer();
  await assert.rejects(oldRun, {
    code: "QUALITY_EVALUATION_TIMEOUT",
    status: 504,
  });
  assert.deepEqual(children[0].killCalls, []);

  const newRun = runner({
    corpusId: "compare-hard",
  });

  assert.equal(children.length, 2);
  finishOldReportRead({
    status: "stale",
  });
  await Promise.resolve();

  await assert.rejects(
    () =>
      runner({
        corpusId: "default",
      }),
    {
      code: "QUALITY_EVALUATION_IN_PROGRESS",
      status: 409,
    }
  );

  children[1].emit("close", 0);
  await newRun;
});

test("late close from a failed spawn cannot release a newer run", async () => {
  const children = [];
  const runner = createSyntheticQualityEvaluationRunner({
    readLatestReport: async () => ({
      status: "pass",
    }),
    spawnProcess: () => {
      const child = createChild();
      children.push(child);
      return child;
    },
  });
  const failedRun = runner({
    corpusId: "near-duplicate",
  });

  children[0].emit("error", new Error("spawn failed"));
  await assert.rejects(failedRun, {
    code: "QUALITY_EVALUATION_PROCESS_ERROR",
    status: 500,
  });
  assert.doesNotThrow(() => {
    children[0].emit("error", new Error("late duplicate error"));
  });

  const activeRun = runner({
    corpusId: "compare-hard",
  });

  children[0].emit("close", 1);

  await assert.rejects(
    () =>
      runner({
        corpusId: "default",
      }),
    {
      code: "QUALITY_EVALUATION_IN_PROGRESS",
      status: 409,
    }
  );
  assert.equal(children.length, 2);

  children[1].emit("close", 0);
  await activeRun;
});

test("process errors retain the slot until a spawned child closes", async () => {
  const children = [];
  const runner = createSyntheticQualityEvaluationRunner({
    readLatestReport: async () => ({
      status: "pass",
    }),
    spawnProcess: () => {
      const child = createChild();

      child.pid = 1234;
      children.push(child);
      return child;
    },
  });
  const failedRun = runner({
    corpusId: "near-duplicate",
  });

  children[0].emit("error", new Error("process channel failed"));
  await assert.rejects(failedRun, {
    code: "QUALITY_EVALUATION_PROCESS_ERROR",
    status: 500,
  });
  await assert.rejects(
    () =>
      runner({
        corpusId: "compare-hard",
      }),
    {
      code: "QUALITY_EVALUATION_IN_PROGRESS",
      status: 409,
    }
  );

  children[0].emit("close", 1);

  const nextRun = runner({
    corpusId: "compare-hard",
  });

  children[1].emit("close", 0);
  await nextRun;
});

test("synchronous spawn failures release the slot for a later run", async () => {
  const child = createChild();
  let spawnCount = 0;
  const runner = createSyntheticQualityEvaluationRunner({
    readLatestReport: async () => ({
      status: "pass",
    }),
    spawnProcess: () => {
      spawnCount += 1;

      if (spawnCount === 1) {
        throw new Error("spawn unavailable");
      }

      return child;
    },
  });

  await assert.rejects(
    () =>
      runner({
        corpusId: "near-duplicate",
      }),
    {
      code: "QUALITY_EVALUATION_SPAWN_FAILED",
      status: 500,
    }
  );

  const nextRun = runner({
    corpusId: "near-duplicate",
  });

  child.emit("close", 0);
  await nextRun;
  assert.equal(spawnCount, 2);
});

test("report read failures release the slot for a later run", async () => {
  const children = [];
  let readCount = 0;
  const runner = createSyntheticQualityEvaluationRunner({
    readLatestReport: async () => {
      readCount += 1;

      if (readCount === 1) {
        throw new Error("latest report unreadable");
      }

      return {
        status: "pass",
      };
    },
    spawnProcess: () => {
      const child = createChild();

      children.push(child);
      return child;
    },
  });
  const failedRun = runner({
    corpusId: "near-duplicate",
  });

  children[0].emit("close", 0);
  await assert.rejects(failedRun, /latest report unreadable/);

  const nextRun = runner({
    corpusId: "near-duplicate",
  });

  children[1].emit("close", 0);
  await nextRun;
});

test("quality runner times out, escalates termination, and holds its slot until close", async () => {
  const child = createChild();
  const timerHarness = createTimerHarness();
  let spawnCount = 0;
  const runner = createSyntheticQualityEvaluationRunner({
    clearTimer: timerHarness.clearTimer,
    forceKillAfterMs: 25,
    readLatestReport: async () => ({}),
    setTimer: timerHarness.setTimer,
    spawnProcess: () => {
      spawnCount += 1;
      return child;
    },
    timeoutMs: 50,
  });

  const timedOutRun = runner({
    corpusId: "near-duplicate",
  });

  assert.equal(timerHarness.timers[0].delayMs, 50);
  timerHarness.runNextTimer();
  await assert.rejects(timedOutRun, {
    code: "QUALITY_EVALUATION_TIMEOUT",
    expose: true,
    status: 504,
  });
  assert.deepEqual(child.killCalls, ["SIGTERM"]);

  await assert.rejects(
    () =>
      runner({
        corpusId: "near-duplicate",
      }),
    {
      code: "QUALITY_EVALUATION_IN_PROGRESS",
      status: 409,
    }
  );
  assert.equal(spawnCount, 1);

  assert.equal(timerHarness.timers[1].delayMs, 25);
  timerHarness.runNextTimer();
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);

  child.emit("close", null, "SIGKILL");

  const nextRun = runner({
    corpusId: "near-duplicate",
  });

  assert.equal(spawnCount, 2);
  child.emit("close", 0);
  await nextRun;
});

test("quality runner bounds captured stderr", async () => {
  const child = createChild();
  const runner = createSyntheticQualityEvaluationRunner({
    maxStderrBytes: 32,
    readLatestReport: async () => ({}),
    spawnProcess: () => child,
  });
  const pending = runner({
    corpusId: "near-duplicate",
  });

  child.stderr.emit("data", `secret-prefix-${"x".repeat(100)}`);
  child.stderr.emit("data", "visible-tail");
  child.emit("close", 1);

  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 500);
    assert.doesNotMatch(error.message, /secret-prefix/);
    assert.doesNotMatch(error.message, /\0/);
    assert.match(error.message, /visible-tail/);
    assert.ok(error.message.length < 160);
    return true;
  });
});

test("quality runner does not pad short stderr tails", async () => {
  const child = createChild();
  const runner = createSyntheticQualityEvaluationRunner({
    maxStderrBytes: 32,
    readLatestReport: async () => ({}),
    spawnProcess: () => child,
  });
  const pending = runner({
    corpusId: "near-duplicate",
  });

  child.stderr.emit("data", "short-tail");
  child.emit("close", 1);

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /short-tail$/);
    assert.doesNotMatch(error.message, /\0/);
    return true;
  });
});
