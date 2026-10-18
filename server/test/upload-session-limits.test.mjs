// Chunked upload sessions hold their chunks on disk until they are completed
// or expire, so each (user, workspace) may keep only so many open at once
// (UPLOAD_SESSION_MAX_PER_TENANT, UPLOAD_SESSION_MAX_BYTES_PER_TENANT; a
// POST /upload/init over either cap is 429 UPLOAD_SESSION_LIMIT_EXCEEDED), and
// a running API process sweeps expired sessions every
// UPLOAD_SESSION_CLEANUP_INTERVAL_MS instead of only at start-up.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createApp } from "../app.js";
import {
  getUploadSessionCleanupIntervalMs,
  getUploadSessionMaxBytesPerTenant,
  getUploadSessionMaxPerTenant,
} from "../rag/config.js";
import {
  UPLOAD_SESSION_LIMIT_EXCEEDED,
  cleanupExpiredUploadSessions,
  clearUploadSession,
  configureUploadSessionDirectory,
  getUploadSessionStatus,
  initializeUploadSession,
  startUploadSessionSweeper,
} from "../upload-session-store.js";

const execFileAsync = promisify(execFile);
const storeModuleUrl = new URL("../upload-session-store.js", import.meta.url).href;

const ENV_KEYS = [
  "UPLOAD_SESSION_CLEANUP_INTERVAL_MS",
  "UPLOAD_SESSION_MAX_BYTES_PER_TENANT",
  "UPLOAD_SESSION_MAX_PER_TENANT",
  "UPLOAD_SESSION_TTL_MS",
];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const ALICE = { userId: "alice", workspaceId: "workspace-a" };
const ALICE_OTHER_WORKSPACE = { userId: "alice", workspaceId: "workspace-b" };
const BOB = { userId: "bob", workspaceId: "workspace-a" };

const metadata = (fileId, overrides = {}) => ({
  fileId,
  fileName: `${fileId}.pdf`,
  fileSize: 10,
  lastModified: 1,
  totalChunks: 2,
  chunkSize: 6,
  ...overrides,
});

const withUploadStore = async (label, operation) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `upload-limits-${label}-`));
  const sessionsDirectory = path.join(tempRoot, "sessions");
  configureUploadSessionDirectory(sessionsDirectory);

  try {
    return await operation({ sessionsDirectory, tempRoot });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const listDirectories = async (directory) => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const assertLimitError = (limit, maximum) => (error) => {
  assert.equal(error.status, 429);
  assert.equal(error.code, UPLOAD_SESSION_LIMIT_EXCEEDED);
  assert.equal(error.limit, limit);
  assert.match(error.message, new RegExp(String(maximum)));
  return true;
};

// Polls instead of sleeping a fixed time: a timer-driven loop only promises
// "eventually", and a slow machine must not fail the test.
const waitFor = async (predicate, { timeoutMs = 5000, label = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;

  while (!(await predicate())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("the caps default to 200 sessions and 10 GiB per tenant and a 15-minute sweep", () => {
  // Well above a bulk drop of a few dozen PDFs (the workbench opens one
  // session per file, all at once).
  assert.equal(getUploadSessionMaxPerTenant(), 200);
  assert.equal(getUploadSessionMaxBytesPerTenant(), 10 * 1024 * 1024 * 1024);
  assert.equal(getUploadSessionCleanupIntervalMs(), 15 * 60 * 1000);

  process.env.UPLOAD_SESSION_MAX_PER_TENANT = "0";
  process.env.UPLOAD_SESSION_MAX_BYTES_PER_TENANT = "0";
  process.env.UPLOAD_SESSION_CLEANUP_INTERVAL_MS = "0";
  assert.equal(getUploadSessionMaxPerTenant(), 0);
  assert.equal(getUploadSessionMaxBytesPerTenant(), 0);
  assert.equal(getUploadSessionCleanupIntervalMs(), 0);

  // A delay past what setInterval accepts would make Node fire at once and on
  // every millisecond after; it is held at the largest one it takes.
  process.env.UPLOAD_SESSION_CLEANUP_INTERVAL_MS = String(60 * 24 * 60 * 60 * 1000);
  assert.equal(getUploadSessionCleanupIntervalMs(), 2 ** 31 - 1);
});

test("a tenant past its session cap is refused with 429 while other tenants and resumes are not", async () => {
  process.env.UPLOAD_SESSION_MAX_PER_TENANT = "2";

  await withUploadStore("count", async ({ sessionsDirectory }) => {
    await initializeUploadSession({ accessScope: ALICE, ...metadata("one") });
    await initializeUploadSession({ accessScope: ALICE, ...metadata("two") });
    const directoriesAtCap = await listDirectories(sessionsDirectory);

    await assert.rejects(
      initializeUploadSession({ accessScope: ALICE, ...metadata("three") }),
      assertLimitError("sessions", 2)
    );
    // Refused before the session directory is created.
    assert.deepEqual(await listDirectories(sessionsDirectory), directoriesAtCap);
    assert.equal(await getUploadSessionStatus({ accessScope: ALICE, fileId: "three" }), null);

    // Resuming one of the open sessions is never refused, and a metadata
    // conflict on it is still the resume path's 409, not the cap's 429.
    const resumed = await initializeUploadSession({ accessScope: ALICE, ...metadata("one") });
    assert.equal(resumed.fileId, "one");
    await assert.rejects(
      initializeUploadSession({ accessScope: ALICE, ...metadata("one", { chunkSize: 5 }) }),
      (error) => error.status === 409
    );

    // The cap is per (user, workspace): the same user in another workspace and
    // another user in the same workspace each have their own.
    await initializeUploadSession({ accessScope: ALICE_OTHER_WORKSPACE, ...metadata("three") });
    await initializeUploadSession({ accessScope: BOB, ...metadata("three") });

    // Clearing an open session frees its place.
    await clearUploadSession({ accessScope: ALICE, fileId: "two" });
    await initializeUploadSession({ accessScope: ALICE, ...metadata("three") });
    await assert.rejects(
      initializeUploadSession({ accessScope: ALICE, ...metadata("four") }),
      assertLimitError("sessions", 2)
    );
  });
});

test("a tenant whose open sessions would pass the byte cap is refused with 429", async () => {
  process.env.UPLOAD_SESSION_MAX_BYTES_PER_TENANT = "15";

  await withUploadStore("bytes", async () => {
    await initializeUploadSession({ accessScope: ALICE, ...metadata("ten") });

    await assert.rejects(
      initializeUploadSession({
        accessScope: ALICE,
        ...metadata("six", { fileSize: 6, totalChunks: 1, chunkSize: 6 }),
      }),
      assertLimitError("bytes", 15)
    );

    // Exactly at the cap is allowed.
    await initializeUploadSession({
      accessScope: ALICE,
      ...metadata("five", { fileSize: 5, totalChunks: 1, chunkSize: 5 }),
    });
    await initializeUploadSession({ accessScope: BOB, ...metadata("ten") });
  });
});

test("0 disables both caps", async () => {
  process.env.UPLOAD_SESSION_MAX_PER_TENANT = "0";
  process.env.UPLOAD_SESSION_MAX_BYTES_PER_TENANT = "0";

  await withUploadStore("disabled", async ({ sessionsDirectory }) => {
    for (let index = 0; index < 25; index += 1) {
      await initializeUploadSession({ accessScope: ALICE, ...metadata(`file-${index}`) });
    }

    assert.equal((await listDirectories(sessionsDirectory)).length, 25);
  });
});

test("concurrent inits of one tenant cannot all pass the cap", async () => {
  process.env.UPLOAD_SESSION_MAX_PER_TENANT = "1";

  await withUploadStore("concurrent", async ({ sessionsDirectory }) => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        initializeUploadSession({ accessScope: ALICE, ...metadata(`racer-${index}`) })
      )
    );

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      assertLimitError("sessions", 1)(result.reason);
    }
    assert.equal((await listDirectories(sessionsDirectory)).length, 1);

    // The same file initialized concurrently is one session, not a refusal.
    const sameFile = await Promise.allSettled(
      Array.from({ length: 4 }, () => initializeUploadSession({ accessScope: BOB, ...metadata("same") }))
    );
    assert.deepEqual(
      sameFile.map((result) => result.status),
      ["fulfilled", "fulfilled", "fulfilled", "fulfilled"]
    );
    assert.equal(new Set(sameFile.map((result) => result.value.sessionId)).size, 1);
  });
});

test("unreadable, foreign-version and other tenants' manifests do not count", async () => {
  process.env.UPLOAD_SESSION_MAX_PER_TENANT = "1";

  await withUploadStore("foreign", async ({ sessionsDirectory }) => {
    const malformed = path.join(sessionsDirectory, "malformed");
    const legacy = path.join(sessionsDirectory, "legacy");
    const empty = path.join(sessionsDirectory, "empty");

    await mkdir(malformed, { recursive: true });
    await writeFile(path.join(malformed, "manifest.json"), "{");
    await mkdir(legacy, { recursive: true });
    // A pre-v2 manifest names an owner but no manifestVersion: no v2 caller
    // can resume it, so it is nobody's open session.
    await writeFile(
      path.join(legacy, "manifest.json"),
      JSON.stringify({ ...metadata("legacy"), ownerUserId: "alice", workspaceId: "workspace-a" })
    );
    await mkdir(empty, { recursive: true });
    await writeFile(path.join(sessionsDirectory, "stray-file"), "not a session");
    await initializeUploadSession({ accessScope: BOB, ...metadata("bob-file") });

    await initializeUploadSession({ accessScope: ALICE, ...metadata("first") });
    await assert.rejects(
      initializeUploadSession({ accessScope: ALICE, ...metadata("second") }),
      assertLimitError("sessions", 1)
    );
  });
});

test("an expired session keeps its place until a sweep removes it", async () => {
  process.env.UPLOAD_SESSION_MAX_PER_TENANT = "1";

  await withUploadStore("expired", async () => {
    await initializeUploadSession({ accessScope: ALICE, ...metadata("abandoned") });
    await assert.rejects(
      initializeUploadSession({ accessScope: ALICE, ...metadata("next") }),
      assertLimitError("sessions", 1)
    );

    assert.deepEqual(
      await cleanupExpiredUploadSessions({ ttlMs: 1, now: Date.now() + 10_000 }),
      { removedSessions: 1 }
    );
    await initializeUploadSession({ accessScope: ALICE, ...metadata("next") });
  });
});

test("the sweeper runs the cleanup every interval, never two at once, and stops", async () => {
  let started = 0;
  let releaseFirst;
  const firstRunning = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const sweeper = startUploadSessionSweeper({
    cleanup: async () => {
      started += 1;

      if (started === 1) {
        await firstRunning;
      }

      return { removedSessions: 0 };
    },
    intervalMs: 5,
  });

  try {
    assert.equal(sweeper.running, true);
    await waitFor(() => started === 1, { label: "the first sweep" });
    // Ticks that come while the first sweep is still running are skipped.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(started, 1);

    releaseFirst();
    await waitFor(() => started >= 3, { label: "later sweeps" });
  } finally {
    sweeper.stop();
  }

  const stoppedAt = started;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(started <= stoppedAt + 1, "at most a sweep already started finishes after stop()");
  const afterStop = started;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(started, afterStop);
});

test("a failing sweep is logged and the next tick still runs", async () => {
  const logged = [];
  let calls = 0;
  const sweeper = startUploadSessionSweeper({
    cleanup: async () => {
      calls += 1;
      throw new Error(`sweep ${calls} failed`);
    },
    intervalMs: 5,
    logger: { error: (...args) => logged.push(args) },
  });

  try {
    await waitFor(() => calls >= 2, { label: "a sweep after a failure" });
  } finally {
    sweeper.stop();
  }

  assert.ok(logged.length >= 1);
  assert.match(String(logged[0][0]), /periodic cleanup of expired upload sessions failed/);
  assert.match(logged[0][1].message, /sweep 1 failed/);
});

test("an interval of 0 starts no sweeper", () => {
  for (const intervalMs of [0, -1, Number.NaN, undefined]) {
    const sweeper = startUploadSessionSweeper({
      cleanup: async () => assert.fail("must not run"),
      intervalMs,
    });

    assert.equal(sweeper.running, false);
    sweeper.stop();
  }
});

test("the sweeper's timer does not keep a process alive", async () => {
  // The child starts a sweeper with a one-minute interval and does nothing
  // else; with a referenced timer it would hang until the test timeout.
  const script = `
    const { startUploadSessionSweeper } = await import(${JSON.stringify(storeModuleUrl)});
    startUploadSessionSweeper({ cleanup: async () => {}, intervalMs: 60_000 });
  `;
  const { stderr } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: path.dirname(fileURLToPath(import.meta.url)), timeout: 20_000 }
  );

  assert.equal(stderr, "");
});

const okHealthService = {
  buildHealthReport: async () => ({ status: "ok", checks: {} }),
  runStartupHealthChecks: async () => ({ status: "ok", checks: {} }),
};

const stubRagService = {
  initializeDocumentRegistry: async () => [],
  initializeSessionMemory: async () => true,
  ingestDocument: async () => ({ docId: "unexpected" }),
};

test("createApp sweeps expired sessions periodically and app.locals.stop stops it", async () => {
  process.env.UPLOAD_SESSION_CLEANUP_INTERVAL_MS = "10";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "upload-limits-app-sweep-"));
  let sweeps = 0;

  try {
    const app = await createApp({
      healthService: okHealthService,
      ragService: stubRagService,
      uploadStore: {
        cleanupExpiredUploadSessions: async () => {
          sweeps += 1;
          return { removedSessions: 0 };
        },
        ensureUploadStorage: async () => {},
      },
      uploadsDirectory: path.join(tempRoot, "uploads"),
    });

    // One sweep at start-up, then more from the timer.
    await waitFor(() => sweeps >= 3, { label: "periodic sweeps" });
    assert.equal(typeof app.locals.stop, "function");
    await app.locals.stop();

    const afterStop = sweeps;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(sweeps <= afterStop + 1);
    const settled = sweeps;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(sweeps, settled);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createApp with the interval at 0 sweeps only at start-up", async () => {
  process.env.UPLOAD_SESSION_CLEANUP_INTERVAL_MS = "0";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "upload-limits-app-once-"));
  let sweeps = 0;

  try {
    const app = await createApp({
      healthService: okHealthService,
      ragService: stubRagService,
      uploadStore: {
        cleanupExpiredUploadSessions: async () => {
          sweeps += 1;
          return { removedSessions: 0 };
        },
        ensureUploadStorage: async () => {},
      },
      uploadsDirectory: path.join(tempRoot, "uploads"),
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(sweeps, 1);
    await app.locals.stop();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("POST /upload/init over the cap answers 429 with the stable code; other errors carry none", async () => {
  process.env.UPLOAD_SESSION_MAX_PER_TENANT = "1";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "upload-limits-route-"));
  const app = await createApp({
    healthService: okHealthService,
    ragService: stubRagService,
    uploadSessionDirectory: path.join(tempRoot, "sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const init = (body, userId = "alice") =>
    fetch(`${baseUrl}/upload/init`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "x-user-id": userId },
      method: "POST",
    });

  try {
    assert.equal((await init(metadata("first"))).status, 201);

    const refused = await init(metadata("second"));
    assert.equal(refused.status, 429);
    const body = await refused.json();
    assert.equal(body.code, UPLOAD_SESSION_LIMIT_EXCEEDED);
    assert.equal(body.limit, "sessions");
    assert.match(body.error, /at most 1 may be open/);

    // With auth off the client-chosen user is the tenant, so another user is
    // not refused; the cap bounds growth, it is no tenant boundary there.
    assert.equal((await init(metadata("second"), "bob")).status, 201);

    // Resuming the open session still works at the cap.
    assert.equal((await init(metadata("first"))).status, 201);

    const invalid = await init(metadata("third", { fileSize: -1 }), "carol");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
