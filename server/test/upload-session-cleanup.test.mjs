import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanupExpiredUploadSessions,
  configureUploadSessionDirectory,
  ensureUploadStorage,
} from "../upload-session-store.js";

const createTempRoot = async (label) =>
  await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), `agentai-${label}-`))
  );

const seedSession = async (sessionsDir, name, files, mtimeMs) => {
  const sessionDir = path.join(sessionsDir, name);
  await mkdir(sessionDir, { recursive: true });
  for (const fileName of files) {
    const filePath = path.join(sessionDir, fileName);
    await writeFile(filePath, `content-${fileName}`);
  }
  const mtime = new Date(mtimeMs);
  for (const fileName of files) {
    await utimes(path.join(sessionDir, fileName), mtime, mtime);
  }
  await utimes(sessionDir, mtime, mtime);
};

test("cleanupExpiredUploadSessions removes old sessions and keeps fresh ones", async () => {
  const tempRoot = await createTempRoot("cleanup-mixed");
  const sessionsDir = path.join(tempRoot, "upload-sessions");
  await mkdir(sessionsDir, { recursive: true });

  const now = Date.now();
  const ttlMs = 24 * 60 * 60 * 1000;
  const oldTime = now - ttlMs - 1000;
  const freshTime = now - ttlMs + 60_000;

  await seedSession(sessionsDir, "old-session", ["manifest.json", "chunk-0"], oldTime);
  await seedSession(sessionsDir, "fresh-session", ["manifest.json", "chunk-0", "chunk-1"], freshTime);

  const originalDir = process.env.UPLOAD_SESSION_DIRECTORY;
  try {
    configureUploadSessionDirectory(sessionsDir);
    const result = await cleanupExpiredUploadSessions({ ttlMs, now });
    assert.equal(result.removedSessions, 1);

    const remaining = await readdir(sessionsDir);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0], "fresh-session");
  } finally {
    if (originalDir) {
      configureUploadSessionDirectory(originalDir);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cleanupExpiredUploadSessions returns 0 when directory does not exist (ENOENT)", async () => {
  const tempRoot = await createTempRoot("cleanup-enoent");
  const nonExistentDir = path.join(tempRoot, "does-not-exist");

  const originalDir = process.env.UPLOAD_SESSION_DIRECTORY;
  try {
    configureUploadSessionDirectory(nonExistentDir);
    const result = await cleanupExpiredUploadSessions();
    assert.deepStrictEqual(result, { removedSessions: 0 });
  } finally {
    if (originalDir) {
      configureUploadSessionDirectory(originalDir);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cleanupExpiredUploadSessions uses newest file mtime as last activity", async () => {
  const tempRoot = await createTempRoot("cleanup-newest");
  const sessionsDir = path.join(tempRoot, "upload-sessions");
  await mkdir(sessionsDir, { recursive: true });

  const now = Date.now();
  const ttlMs = 24 * 60 * 60 * 1000;

  const sessionDir = path.join(sessionsDir, "mixed-times");
  await mkdir(sessionDir, { recursive: true });

  const oldTime = new Date(now - ttlMs - 10_000);
  const freshTime = new Date(now - ttlMs + 60_000);

  await writeFile(path.join(sessionDir, "manifest.json"), "{}");
  await utimes(path.join(sessionDir, "manifest.json"), oldTime, oldTime);

  await writeFile(path.join(sessionDir, "chunk-0"), "data");
  await utimes(path.join(sessionDir, "chunk-0"), freshTime, freshTime);

  const originalDir = process.env.UPLOAD_SESSION_DIRECTORY;
  try {
    configureUploadSessionDirectory(sessionsDir);
    const result = await cleanupExpiredUploadSessions({ ttlMs, now });
    assert.equal(result.removedSessions, 0);

    const remaining = await readdir(sessionsDir);
    assert.equal(remaining.length, 1);
  } finally {
    if (originalDir) {
      configureUploadSessionDirectory(originalDir);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cleanupExpiredUploadSessions handles empty session dir using dir mtime", async () => {
  const tempRoot = await createTempRoot("cleanup-empty");
  const sessionsDir = path.join(tempRoot, "upload-sessions");
  await mkdir(sessionsDir, { recursive: true });

  const now = Date.now();
  const ttlMs = 24 * 60 * 60 * 1000;

  const sessionDir = path.join(sessionsDir, "empty-session");
  await mkdir(sessionDir, { recursive: true });

  const oldTime = new Date(now - ttlMs - 5000);
  await utimes(sessionDir, oldTime, oldTime);

  const originalDir = process.env.UPLOAD_SESSION_DIRECTORY;
  try {
    configureUploadSessionDirectory(sessionsDir);
    const result = await cleanupExpiredUploadSessions({ ttlMs, now });
    assert.equal(result.removedSessions, 1);

    const remaining = await readdir(sessionsDir);
    assert.equal(remaining.length, 0);
  } finally {
    if (originalDir) {
      configureUploadSessionDirectory(originalDir);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cleanupExpiredUploadSessions skips non-directory entries", async () => {
  const tempRoot = await createTempRoot("cleanup-nondir");
  const sessionsDir = path.join(tempRoot, "upload-sessions");
  await mkdir(sessionsDir, { recursive: true });

  const now = Date.now();
  const ttlMs = 24 * 60 * 60 * 1000;

  await writeFile(path.join(sessionsDir, "stray-file.txt"), "data");
  const oldTime = new Date(now - ttlMs - 5000);
  await utimes(path.join(sessionsDir, "stray-file.txt"), oldTime, oldTime);

  const originalDir = process.env.UPLOAD_SESSION_DIRECTORY;
  try {
    configureUploadSessionDirectory(sessionsDir);
    const result = await cleanupExpiredUploadSessions({ ttlMs, now });
    assert.equal(result.removedSessions, 0);

    const remaining = await readdir(sessionsDir);
    assert.equal(remaining.length, 1);
  } finally {
    if (originalDir) {
      configureUploadSessionDirectory(originalDir);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cleanupExpiredUploadSessions respects UPLOAD_SESSION_TTL_MS env var", async () => {
  const tempRoot = await createTempRoot("cleanup-env");
  const sessionsDir = path.join(tempRoot, "upload-sessions");
  await mkdir(sessionsDir, { recursive: true });

  const now = Date.now();
  const shortTtl = 5000;

  await seedSession(sessionsDir, "session-a", ["manifest.json"], now - shortTtl - 1000);

  const originalDir = process.env.UPLOAD_SESSION_DIRECTORY;
  const originalTtl = process.env.UPLOAD_SESSION_TTL_MS;
  try {
    configureUploadSessionDirectory(sessionsDir);
    process.env.UPLOAD_SESSION_TTL_MS = String(shortTtl);
    const result = await cleanupExpiredUploadSessions({ now });
    assert.equal(result.removedSessions, 1);
  } finally {
    if (originalDir) {
      configureUploadSessionDirectory(originalDir);
    }
    if (originalTtl !== undefined) {
      process.env.UPLOAD_SESSION_TTL_MS = originalTtl;
    } else {
      delete process.env.UPLOAD_SESSION_TTL_MS;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cleanupExpiredUploadSessions ignores invalid UPLOAD_SESSION_TTL_MS", async () => {
  const tempRoot = await createTempRoot("cleanup-badenv");
  const sessionsDir = path.join(tempRoot, "upload-sessions");
  await mkdir(sessionsDir, { recursive: true });

  const now = Date.now();
  const ttlMs = 24 * 60 * 60 * 1000;

  await seedSession(sessionsDir, "session-a", ["manifest.json"], now - ttlMs + 60_000);

  const originalDir = process.env.UPLOAD_SESSION_DIRECTORY;
  const originalTtl = process.env.UPLOAD_SESSION_TTL_MS;
  try {
    configureUploadSessionDirectory(sessionsDir);
    process.env.UPLOAD_SESSION_TTL_MS = "not-a-number";
    const result = await cleanupExpiredUploadSessions({ ttlMs, now });
    assert.equal(result.removedSessions, 0);
  } finally {
    if (originalDir) {
      configureUploadSessionDirectory(originalDir);
    }
    if (originalTtl !== undefined) {
      process.env.UPLOAD_SESSION_TTL_MS = originalTtl;
    } else {
      delete process.env.UPLOAD_SESSION_TTL_MS;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cleanupExpiredUploadSessions continues past a bad session", async () => {
  const tempRoot = await createTempRoot("cleanup-bad-session");
  const sessionsDir = path.join(tempRoot, "upload-sessions");
  await mkdir(sessionsDir, { recursive: true });

  const now = Date.now();
  const ttlMs = 24 * 60 * 60 * 1000;
  const oldTime = now - ttlMs - 5000;

  await seedSession(sessionsDir, "good-old", ["manifest.json"], oldTime);
  await seedSession(sessionsDir, "also-old", ["manifest.json"], oldTime);

  const originalDir = process.env.UPLOAD_SESSION_DIRECTORY;
  try {
    configureUploadSessionDirectory(sessionsDir);
    const result = await cleanupExpiredUploadSessions({ ttlMs, now });
    assert.equal(result.removedSessions, 2);
  } finally {
    if (originalDir) {
      configureUploadSessionDirectory(originalDir);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
